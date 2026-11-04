import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { completeStructuredWithOpenRouter, type StructuredCompletionRuntime } from "./structuredCompletion";

type Reply = { toolArgs?: string; content?: string; throws?: Error; error?: unknown };

/** A runtime whose client answers each call from the scripted list, in order. */
function scripted(replies: Reply[]) {
  const requests: unknown[] = [];
  const runtime: StructuredCompletionRuntime = async () => ({
    selection: { provider: "minimax", modelId: "minimax/minimax-m3" },
    provider: { only: ["minimax"] },
    client: { chat: { completions: { create: async (request: never) => {
      requests.push(request);
      const reply = replies.shift();
      if (!reply) throw new Error("scripted client ran out of replies");
      if (reply.throws) throw reply.throws;
      if (reply.error !== undefined) return { error: reply.error };
      return {
        choices: [{ message: {
          content: reply.content ?? null,
          tool_calls: reply.toolArgs === undefined
            ? []
            : [{ type: "function", function: { name: "submit", arguments: reply.toolArgs } }],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    } } } },
  });
  return { runtime, requests };
}

const input = {
  timeoutMs: 1_000,
  systemPrompt: "Classify.",
  userPrompt: "Hello",
  maxOutputTokens: 100,
  jsonSchema: { type: "object", required: ["category"], properties: { category: { type: "string" } } },
  schemaName: "submit",
};
const noSleep = async () => {};

describe("completeStructuredWithOpenRouter", () => {
  test("asks for the answer as a tool call, never as a response_format", async () => {
    const { runtime, requests } = scripted([{ toolArgs: '{"category":"a"}' }]);
    const result = await completeStructuredWithOpenRouter(input, { runtime, sleep: noSleep });
    const request = requests[0] as Record<string, unknown>;
    assert.equal(request.response_format, undefined);
    assert.equal(request.tool_choice, "auto");
    assert.equal((request.tools as Array<{ function: { name: string } }>)[0].function.name, "submit");
    assert.equal(result.text, '{"category":"a"}');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
  });

  test("tells the model the call is the answer, with the shared prompts from code when Langfuse is off", async () => {
    const { runtime, requests } = scripted([{ toolArgs: '{"category":"a"}' }]);
    await completeStructuredWithOpenRouter(input, { runtime, sleep: noSleep });
    const request = requests[0] as { messages: Array<{ content: string }>; tools: Array<{ function: { description: string } }> };
    assert.equal(request.messages[0]!.content, "Classify.\n\nYou must answer by calling the submit function exactly once with every required argument. Never answer in prose.");
    assert.equal(request.messages[1]!.content, "Hello");
    assert.equal(request.tools[0]!.function.description, "Submit the structured result. Call it exactly once; it is the only way to answer.");
  });

  test("retries when the model answers in prose instead of calling the tool", async () => {
    const { runtime } = scripted([{ content: "Sure! It is category a." }, { toolArgs: '{"category":"a"}' }]);
    const result = await completeStructuredWithOpenRouter(input, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);
  });

  test("retries arguments that are not a JSON object", async () => {
    const { runtime } = scripted([{ toolArgs: "category: a" }, { toolArgs: "[1]" }, { toolArgs: '{"category":"a"}' }]);
    const result = await completeStructuredWithOpenRouter(input, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 3);
  });

  test("retries a call the caller's accept rejects, and reports the last rejection", async () => {
    const { runtime } = scripted([{ toolArgs: '{"category":"z"}' }, { toolArgs: '{"category":"a"}' }]);
    const accept = (text: string) => {
      if (JSON.parse(text).category !== "a") throw new Error("category z is not in the taxonomy");
    };
    const result = await completeStructuredWithOpenRouter({ ...input, accept }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);

    const exhausted = scripted([{ toolArgs: '{"category":"z"}' }, { toolArgs: '{"category":"z"}' }]);
    await assert.rejects(
      completeStructuredWithOpenRouter({ ...input, accept, maxAttempts: 2 }, { runtime: exhausted.runtime, sleep: noSleep }),
      { message: "submit failed after 2 attempts: category z is not in the taxonomy" },
    );
  });

  test("retries a transient transport failure but not a routing failure", async () => {
    const transient = scripted([{ throws: Object.assign(new Error("overloaded"), { status: 503 }) }, { toolArgs: '{"category":"a"}' }]);
    assert.equal((await completeStructuredWithOpenRouter(input, { runtime: transient.runtime, sleep: noSleep })).attempts, 2);

    const routing = scripted([{ throws: Object.assign(new Error("404 No endpoints found"), { status: 404 }) }, { toolArgs: '{"category":"a"}' }]);
    await assert.rejects(
      completeStructuredWithOpenRouter(input, { runtime: routing.runtime, sleep: noSleep }),
      { message: "404 No endpoints found" },
    );
    assert.equal(routing.requests.length, 1);
  });

  test("surfaces an in-body provider error instead of crashing on missing choices", async () => {
    const { runtime, requests } = scripted([{ error: { code: 404, message: "Provider returned error" } }]);
    await assert.rejects(
      completeStructuredWithOpenRouter(input, { runtime, sleep: noSleep }),
      { message: "OpenRouter returned no submit call: 404 Provider returned error" },
    );
    assert.equal(requests.length, 1);
  });
});

describe("completeStructuredWithOpenRouter output budget", () => {
  test("doubles max_tokens after a length finish and reports the budget when exhausted", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let calls = 0;
    const runtime: StructuredCompletionRuntime = async () => ({
      selection: { provider: "minimax", modelId: "minimax/minimax-m3" },
      provider: {},
      client: { chat: { completions: { create: async (request: never) => {
        requests.push(request as Record<string, unknown>);
        calls += 1;
        if (calls < 3) return { choices: [{ finish_reason: "length", message: { content: "", tool_calls: [] } }] };
        return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "submit", arguments: '{"category":"a"}' } }] } }] };
      } } } },
    });
    const result = await completeStructuredWithOpenRouter({ ...input, maxOutputTokens: 800 }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 3);
    assert.deepEqual(requests.map((request) => request.max_tokens), [800, 1600, 3200]);

    calls = 0;
    await assert.rejects(
      completeStructuredWithOpenRouter({ ...input, maxOutputTokens: 800, maxAttempts: 2 }, { runtime, sleep: noSleep }),
      { message: "submit failed after 2 attempts: The model ran out of output tokens (1600) before calling submit" },
    );
  });
});
