import { context, createContextKey, type Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Langfuse tracing is per organization: each organization's spans go to its
 * own Langfuse project. OpenTelemetry has one tracer provider per process,
 * so its span processor is this router, which hands each span to the
 * processor of the organization it belongs to and drops the rest.
 *
 * The organization travels in our own context key, set around span creation
 * (withTraceOrganization), because a span has no attributes yet when it
 * starts. onStart copies it onto the span as ORGANIZATION_ATTRIBUTE, which
 * is what onEnd routes by — export happens later, outside any scope.
 */

const ORGANIZATION_CONTEXT_KEY = createContextKey("agentsdr_organization_id");
export const ORGANIZATION_ATTRIBUTE = "agentsdr.organization_id";

/** Runs `fn` (which starts spans) with `organizationId` as the organization its spans belong to. */
export function withTraceOrganization<T>(organizationId: string, fn: () => T): T {
  return context.with(context.active().setValue(ORGANIZATION_CONTEXT_KEY, organizationId), fn);
}

/** The organization a span started in `parentContext` belongs to, or null. */
export function organizationFromContext(parentContext: Context): string | null {
  const value = parentContext.getValue(ORGANIZATION_CONTEXT_KEY);
  return typeof value === "string" && value ? value : null;
}

/** The organization a started span was routed to, or null. */
export function organizationOfSpan(span: Pick<ReadableSpan, "attributes">): string | null {
  const value = span.attributes[ORGANIZATION_ATTRIBUTE];
  return typeof value === "string" && value ? value : null;
}

type Route = { identity: string; processor: SpanProcessor };

export class OrganizationSpanRouter<C> implements SpanProcessor {
  private readonly routes = new Map<string, Route>();

  /**
   * `build` makes an organization's processor from its credentials;
   * `identity` says when two credentials are the same connection.
   */
  constructor(
    private readonly build: (credentials: C) => SpanProcessor,
    private readonly identity: (credentials: C) => string,
  ) {}

  /**
   * Brings an organization's route up to date with its credentials (null:
   * not connected). Changed credentials replace its processor; the old one
   * sends what it holds and shuts down.
   */
  connect(organizationId: string, credentials: C | null): void {
    const current = this.routes.get(organizationId);
    const identity = credentials ? this.identity(credentials) : null;
    if (current && current.identity === identity) return;
    if (current) {
      this.routes.delete(organizationId);
      retire(current.processor);
    }
    if (credentials && identity) this.routes.set(organizationId, { identity, processor: this.build(credentials) });
  }

  onStart(span: Span, parentContext: Context): void {
    try {
      const organizationId = organizationFromContext(parentContext);
      const route = organizationId ? this.routes.get(organizationId) : undefined;
      if (!organizationId || !route) return;
      span.setAttribute(ORGANIZATION_ATTRIBUTE, organizationId);
      route.processor.onStart(span, parentContext);
    } catch (error) {
      console.error("[langfuse] could not start a span:", error);
    }
  }

  onEnd(span: ReadableSpan): void {
    try {
      const organizationId = organizationOfSpan(span);
      if (organizationId) this.routes.get(organizationId)?.processor.onEnd(span);
    } catch (error) {
      console.error("[langfuse] could not end a span:", error);
    }
  }

  async forceFlush(): Promise<void> {
    await Promise.all([...this.routes.values()].map(({ processor }) => processor.forceFlush().catch((error) => console.error("[langfuse] flush failed:", error))));
  }

  async shutdown(): Promise<void> {
    const processors = [...this.routes.values()].map(({ processor }) => processor);
    this.routes.clear();
    await Promise.all(processors.map((processor) => processor.shutdown().catch((error) => console.error("[langfuse] shutdown failed:", error))));
  }
}

function retire(processor: SpanProcessor): void {
  void processor.shutdown().catch((error) => console.error("[langfuse] could not shut down a replaced processor:", error));
}
