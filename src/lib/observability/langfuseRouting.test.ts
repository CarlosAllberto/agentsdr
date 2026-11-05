import { describe, expect, test } from "bun:test";
import { ROOT_CONTEXT, context, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { ORGANIZATION_ATTRIBUTE, OrganizationSpanRouter, organizationFromContext, organizationOfSpan, withTraceOrganization } from "./langfuseRouting";

context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

type Credentials = { project: string };

class FakeProcessor implements SpanProcessor {
  started: string[] = [];
  ended: string[] = [];
  flushed = 0;
  shutDown = 0;
  constructor(readonly project: string) {}
  onStart(span: Span) {
    this.started.push(span.name);
  }
  onEnd(span: ReadableSpan) {
    this.ended.push(span.name);
  }
  async forceFlush() {
    this.flushed += 1;
  }
  async shutdown() {
    this.shutDown += 1;
  }
}

function fakeSpan(name: string) {
  const attributes: Record<string, unknown> = {};
  return {
    name,
    attributes,
    setAttribute(key: string, value: unknown) {
      attributes[key] = value;
      return this;
    },
  } as unknown as Span & ReadableSpan;
}

function router() {
  const built: FakeProcessor[] = [];
  const instance = new OrganizationSpanRouter<Credentials>(
    (credentials) => {
      const processor = new FakeProcessor(credentials.project);
      built.push(processor);
      return processor;
    },
    (credentials) => credentials.project,
  );
  return { instance, built };
}

/** Starts and ends a span the way the tracer does, in the context active inside `fn`'s scope. */
function runSpan(instance: OrganizationSpanRouter<Credentials>, name: string, parent: Context) {
  const span = fakeSpan(name);
  instance.onStart(span, parent);
  instance.onEnd(span);
  return span;
}

describe("the organization of a span", () => {
  test("comes from the context withTraceOrganization sets", () => {
    expect(organizationFromContext(ROOT_CONTEXT)).toBeNull();
    const inside = withTraceOrganization("org-a", () => context.active());
    expect(organizationFromContext(inside)).toBe("org-a");
    expect(organizationFromContext(context.active())).toBeNull();
  });

  test("is read back from the span's own attribute", () => {
    expect(organizationOfSpan({ attributes: { [ORGANIZATION_ATTRIBUTE]: "org-a" } })).toBe("org-a");
    expect(organizationOfSpan({ attributes: {} })).toBeNull();
    expect(organizationOfSpan({ attributes: { "user.id": "org:org-a" } })).toBeNull();
  });
});

describe("OrganizationSpanRouter", () => {
  test("sends each span to its organization's processor and drops the rest", () => {
    const { instance, built } = router();
    instance.connect("org-a", { project: "a" });
    instance.connect("org-b", { project: "b" });

    const spanA = runSpan(instance, "a-call", withTraceOrganization("org-a", () => context.active()));
    runSpan(instance, "b-call", withTraceOrganization("org-b", () => context.active()));
    const unconnected = runSpan(instance, "c-call", withTraceOrganization("org-c", () => context.active()));
    const unscoped = runSpan(instance, "no-org", ROOT_CONTEXT);

    expect(built.map((processor) => [processor.project, processor.started, processor.ended])).toEqual([
      ["a", ["a-call"], ["a-call"]],
      ["b", ["b-call"], ["b-call"]],
    ]);
    expect(spanA.attributes[ORGANIZATION_ATTRIBUTE]).toBe("org-a");
    expect(unconnected.attributes[ORGANIZATION_ATTRIBUTE]).toBeUndefined();
    expect(unscoped.attributes[ORGANIZATION_ATTRIBUTE]).toBeUndefined();
  });

  test("keeps a processor while the credentials stay the same, and replaces it when they change", () => {
    const { instance, built } = router();
    instance.connect("org-a", { project: "a" });
    instance.connect("org-a", { project: "a" });
    expect(built).toHaveLength(1);

    instance.connect("org-a", { project: "a2" });
    expect(built).toHaveLength(2);
    expect(built[0]!.shutDown).toBe(1);
    runSpan(instance, "after-change", withTraceOrganization("org-a", () => context.active()));
    expect(built[0]!.started).toEqual([]);
    expect(built[1]!.started).toEqual(["after-change"]);
  });

  test("a disconnected organization's processor is shut down and its spans dropped", () => {
    const { instance, built } = router();
    instance.connect("org-a", { project: "a" });
    instance.connect("org-a", null);
    expect(built[0]!.shutDown).toBe(1);
    runSpan(instance, "after-disconnect", withTraceOrganization("org-a", () => context.active()));
    expect(built[0]!.started).toEqual([]);
  });

  test("a span that started before a change ends on the organization's current processor", () => {
    const { instance, built } = router();
    instance.connect("org-a", { project: "a" });
    const span = fakeSpan("long-call");
    instance.onStart(span, withTraceOrganization("org-a", () => context.active()));
    instance.connect("org-a", { project: "a2" });
    instance.onEnd(span);
    expect(built[0]!.ended).toEqual([]);
    expect(built[1]!.ended).toEqual(["long-call"]);
  });

  test("flushes every organization's processor", async () => {
    const { instance, built } = router();
    instance.connect("org-a", { project: "a" });
    instance.connect("org-b", { project: "b" });
    await instance.forceFlush();
    expect(built.map((processor) => processor.flushed)).toEqual([1, 1]);
  });

  test("a processor that throws never reaches the caller", () => {
    const instance = new OrganizationSpanRouter<Credentials>(
      () =>
        ({
          onStart: () => {
            throw new Error("boom");
          },
          onEnd: () => {
            throw new Error("boom");
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        }) satisfies SpanProcessor,
      (credentials) => credentials.project,
    );
    instance.connect("org-a", { project: "a" });
    const original = console.error;
    console.error = () => {};
    try {
      expect(() => runSpan(instance, "x", withTraceOrganization("org-a", () => context.active()))).not.toThrow();
    } finally {
      console.error = original;
    }
  });
});
