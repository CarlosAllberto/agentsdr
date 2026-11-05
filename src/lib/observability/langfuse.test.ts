import { describe, expect, test } from "bun:test";
import { PROMPTS } from "@/lib/prompts/registry";
import { runInOrganization } from "@/lib/tenancy/scope";
import { getPromptTemplate, langfuseAvailable, langfuseTracingEnabled, recordPastTrace, traceGeneration } from "./langfuse";

describe("where Langfuse may be reached", () => {
  test("never from tests or the public demo", () => {
    expect(langfuseAvailable({ NODE_ENV: "production" })).toBe(true);
    expect(langfuseAvailable({ NODE_ENV: "test" })).toBe(false);
    expect(langfuseAvailable({ NODE_ENV: "production", DEMO_MODE: "true" })).toBe(false);
  });

  test("LANGFUSE_TRACING=off stops traces for the whole deployment, whatever is connected", () => {
    expect(langfuseTracingEnabled({ NODE_ENV: "production" })).toBe(true);
    expect(langfuseTracingEnabled({ NODE_ENV: "production", LANGFUSE_TRACING: "off" })).toBe(false);
    expect(langfuseTracingEnabled({ NODE_ENV: "production", LANGFUSE_TRACING: " OFF " })).toBe(false);
    expect(langfuseTracingEnabled({ NODE_ENV: "test" })).toBe(false);
  });
});

describe("without Langfuse", () => {
  test("a prompt is the copy in code, inside an organization or not", async () => {
    const outside = await getPromptTemplate("crm/draft-system");
    const inside = await runInOrganization("00000000-0000-4000-8000-000000000001", () => getPromptTemplate("crm/draft-system"));
    for (const prompt of [outside, inside]) {
      expect(prompt).toEqual({ name: "crm/draft-system", text: PROMPTS["crm/draft-system"].template, client: null, version: null });
    }
  });

  test("a traced call just runs, and its errors are its own", async () => {
    const result = await runInOrganization("00000000-0000-4000-8000-000000000001", () =>
      traceGeneration({ name: "test", input: "hi" }, async (record) => {
        record({ output: "hello" });
        return 42;
      }),
    );
    expect(result).toBe(42);
    await expect(traceGeneration({ name: "test", input: "hi" }, async () => Promise.reject(new Error("model down")))).rejects.toThrow("model down");
  });

  test("recording a past trace returns at once and never throws", () => {
    expect(() =>
      recordPastTrace({ name: "call-conversation", startTime: new Date(), endTime: new Date(), observations: [{ name: "turn", type: "event", startTime: new Date() }] }),
    ).not.toThrow();
  });
});
