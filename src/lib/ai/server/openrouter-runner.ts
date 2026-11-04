import "server-only";
import { PermanentRunError, RetryableRunError, aiProviderLabel } from "@/lib/grid/runners/types";
import { traceGeneration } from "@/lib/observability/langfuse";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { isTransientOpenRouterError } from "./openrouter-errors";
import { openRouterTokenLimit, strictImageProviderRouting } from "../openrouter-types";
import { generateOpenRouterImage } from "./openrouter";
import { getOpenRouterRuntime } from "./runtime";
import { completeStructuredWithOpenRouter } from "./structuredCompletion";
import { FILL_ROW_PROMPTS, fillRowSystemPrompt, type AiRunner } from "./types";

/**
 * OpenRouter answers an upstream failure with a generic message ("Provider
 * returned error") and puts the provider's own words in `metadata.raw`.
 * Surface those, from the error itself or from whatever it wraps.
 */
function auditError(error: unknown) {
  let api: { status?: unknown; code?: unknown; type?: unknown; error?: unknown } | undefined;
  for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
    if (typeof (current as { status?: unknown }).status === "number") { api = current as typeof api; break; }
  }
  const metadata = (api?.error as { metadata?: { raw?: unknown; provider_name?: unknown } } | undefined)?.metadata;
  const upstream = upstreamMessage(metadata?.raw);
  const providerName = typeof metadata?.provider_name === "string" ? metadata.provider_name : null;
  const message = error instanceof Error ? error.message : "OpenRouter request failed";
  return {
    error: upstream ? `${message} — ${providerName ? `${providerName}: ` : ""}${upstream}` : message,
    ...(typeof api?.status === "number" ? { status: api.status } : {}),
    ...(typeof api?.code === "string" ? { code: api.code } : {}),
    ...(typeof api?.type === "string" ? { type: api.type } : {}),
    ...(metadata ? { upstream: metadata } : {}),
  };
}

/** `raw` is usually the provider's JSON error body; pull its message out. */
function upstreamMessage(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
    const found = typeof body.error === "string" ? body.error : body.error?.message ?? body.message;
    if (typeof found === "string" && found.trim()) return found.trim();
  } catch {
    // not JSON; use it as it is
  }
  return raw.trim().slice(0, 500);
}

/**
 * OpenRouter's web plugin defaults to the provider's own search. On Gemini
 * that is Google Search grounding, a built-in tool the model may decline to
 * call (rows came back answered from memory, with no citations), and which
 * Google refuses outright beside function calling — the structured path —
 * with "enable tool_config.include_server_side_tool_invocations". Exa runs
 * the search on OpenRouter's side before the model sees the prompt: every
 * row is searched, citations come back, and structured output still works.
 */
function webPlugins(config: { useCase: string }, modelId: string) {
  if (config.useCase !== "web-research") return undefined;
  return [modelId.startsWith("google/") ? { id: "web", engine: "exa" } : { id: "web" }];
}

export const runOpenRouter: AiRunner = async ({ config, model, prompt, schema, examples, timeoutMs, signal, trace }) => {
  let auditRequest: unknown;
  try {
    if (!config.upstreamProvider) throw new PermanentRunError("Re-save this AI column with an OpenRouter provider");
    const { templates, prompts } = await resolveTemplates(FILL_ROW_PROMPTS);
    const used = [...(examples.length ? prompts : prompts.filter((item) => item.name !== "grid/fill-row-example")), ...(trace?.prompts ?? [])];
    const metadata = { ...trace?.metadata, useCase: config.useCase, outputFormat: config.outputFormat };
    const system = fillRowSystemPrompt(templates, Boolean(schema), examples);
    if (schema) {
      const result = await completeStructuredWithOpenRouter({
        requestedModel: { provider: config.upstreamProvider, modelId: model.modelId },
        timeoutMs,
        systemPrompt: system,
        userPrompt: prompt,
        maxOutputTokens: config.maxTokens ?? model.maxOutputTokens ?? 16000,
        jsonSchema: schema,
        schemaName: "fill_row",
        plugins: webPlugins(config, model.modelId),
        onRequest: (request) => { auditRequest = request; },
        signal,
        trace: { name: "grid-ai-column", prompts: used, metadata },
      });
      auditRequest = result.request;
      return { value: JSON.parse(result.text), usage: result.usage, raw: result.response, request: result.request };
    }
    const { client, provider } = await getOpenRouterRuntime(
      { provider: config.upstreamProvider, modelId: model.modelId },
      timeoutMs,
    );
    const tokenLimit = openRouterTokenLimit(model.modelId, config.maxTokens ?? model.maxOutputTokens ?? 16000);
    const request = { model: model.modelId, messages: [{ role: "system", content: system }, { role: "user", content: prompt }], ...tokenLimit, provider, ...(webPlugins(config, model.modelId) ? { plugins: webPlugins(config, model.modelId) } : {}) };
    auditRequest = request;
    return await traceGeneration({
      name: "grid-ai-column",
      model: model.modelId,
      input: request.messages,
      prompts: used,
      modelParameters: { max_tokens: config.maxTokens ?? model.maxOutputTokens ?? 16000 },
      metadata: { ...metadata, provider: config.upstreamProvider },
    }, async (record) => {
      const response = await client.chat.completions.create(request as never, { signal });
      const text = response.choices[0]?.message.content?.trim() ?? "";
      const usage = response.usage as (typeof response.usage & { cost?: number }) | undefined;
      record({ output: text, usage: { input: usage?.prompt_tokens, output: usage?.completion_tokens, costUsd: usage?.cost } });
      return { value: text, usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens }, raw: response, request };
    });
  } catch (error) {
    if (error instanceof PermanentRunError && error.audit) throw error;
    const response = auditError(error);
    const audit = {
      provider: aiProviderLabel("openrouter", config.upstreamProvider, model.key),
      request: auditRequest,
      response,
    };
    // A rate limit, a 5xx or a timeout is the provider's moment, not the
    // user's config — let the queue back off and retry it.
    if (isTransientOpenRouterError(error)) throw new RetryableRunError(response.error, audit);
    throw new PermanentRunError(response.error, audit);
  }
};

export const runOpenRouterImage: AiRunner = async ({ config, model, prompt, timeoutMs, signal, trace }) => {
  let auditRequest: unknown;
  try {
    if (!config.upstreamProvider) throw new PermanentRunError("Re-save this AI column with an OpenRouter provider");
    const { apiKey } = await getOpenRouterRuntime(
      { provider: config.upstreamProvider, modelId: model.modelId },
      timeoutMs,
    );
    const provider = strictImageProviderRouting(config.upstreamProvider);
    const request = { model: model.modelId, prompt, n: 1, provider };
    auditRequest = request;
    return await traceGeneration({
      name: "grid-ai-image",
      model: model.modelId,
      input: prompt,
      prompts: trace?.prompts,
      metadata: { ...trace?.metadata, provider: config.upstreamProvider },
    }, async (record) => {
      const response = await generateOpenRouterImage({
        apiKey,
        model: model.modelId,
        prompt,
        provider,
        timeoutMs,
        signal,
      });
      const image = response.data?.[0];
      const usage = { input: response.usage?.prompt_tokens, output: response.usage?.completion_tokens, costUsd: response.usage?.cost };
      if (!image?.b64_json) {
        record({ output: null, usage });
        throw new PermanentRunError("The model returned no image");
      }
      const mediaType = image.media_type?.startsWith("image/") ? image.media_type : "image/png";
      // The image itself stays out of the trace; its size says enough.
      record({ output: `[image: ${mediaType}, ${Math.floor(image.b64_json.length * 3 / 4)} bytes]`, usage });
      return {
        value: `data:${mediaType};base64,${image.b64_json}`,
        usage: {
          inputTokens: response.usage?.prompt_tokens,
          outputTokens: response.usage?.completion_tokens,
        },
        raw: response,
        request,
      };
    });
  } catch (error) {
    if (error instanceof PermanentRunError && error.audit) throw error;
    const response = auditError(error);
    const audit = {
      provider: aiProviderLabel("openrouter", config.upstreamProvider, model.key),
      request: auditRequest,
      response,
    };
    // A rate limit, a 5xx or a timeout is the provider's moment, not the
    // user's config — let the queue back off and retry it.
    if (isTransientOpenRouterError(error)) throw new RetryableRunError(response.error, audit);
    throw new PermanentRunError(response.error, audit);
  }
};
