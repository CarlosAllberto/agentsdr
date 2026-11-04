import type OpenAI from "openai";
import { OPENROUTER_BASE_URL } from "@/lib/ai/server/openrouter";
import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import { getPrompt } from "@/lib/observability/langfuse";
import type { QualificationDebugTrace } from "./types";

export async function resolveParentDomain(domain: string): Promise<string | null> {
  return (await resolveParentDomainWithDebug(domain)).parentDomain;
}

export async function resolveParentDomainWithDebug(domain: string): Promise<{ parentDomain: string | null; debug: NonNullable<QualificationDebugTrace["parentLookup"]> }> {
  const startedAt = new Date().toISOString();
  const systemPrompt = await getPrompt("qualification/parent-domain-system");
  let request = { provider: "openrouter" as const, endpoint: OPENROUTER_BASE_URL, model: "not-configured", instructions: systemPrompt.text, input: domain, maxOutputTokens: 2000, tool: "report_parent_domain", tools: [{ type: "web_search" as const }] };
  try {
    const runtime = await getOpenRouterRuntime();
    request = { ...request, model: runtime.selection.modelId };
    // OpenRouter's official `web` plugin grounds any compatible Chat Completions model.
    const result = await completeStructuredWithOpenRouter({
      timeoutMs: 60_000,
      systemPrompt: systemPrompt.text,
      userPrompt: domain,
      maxOutputTokens: 2000,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["parentDomain"],
        properties: {
          parentDomain: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      schemaName: "report_parent_domain",
      plugins: [{ id: "web", max_results: 5 }],
      trace: { name: "qualification-parent-domain", prompts: [systemPrompt], metadata: { domain } },
    });
    const raw = result.text;
    const parsed = JSON.parse(raw) as { parentDomain?: string | null };
    const parentDomain = parsed.parentDomain && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(parsed.parentDomain) ? parsed.parentDomain.toLowerCase() : null;
    const response = result.response as OpenAI.Chat.Completions.ChatCompletion;
    return { parentDomain, debug: { request, response: { id: response.id, outputText: raw, output: response, usage: result.usage, parsedParentDomain: parentDomain, webSearchUsed: Boolean(response.choices[0]?.message.annotations?.length) }, startedAt, finishedAt: new Date().toISOString() } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[parentLookup] OpenRouter request failed:", message);
    throw new Error(`OpenRouter parent lookup failed: ${message}`, { cause: error });
  }
}
