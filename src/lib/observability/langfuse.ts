import "server-only";

import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseClient, type TextPromptClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { isDemoMode } from "@/lib/demo/mode";
import { maybeCurrentOrganizationId } from "@/lib/tenancy/scope";
import { fillPrompt, type PromptVariables } from "@/lib/prompts/template";
import { PROMPTS, type PromptName } from "@/lib/prompts/registry";

/**
 * Langfuse: where the prompts written for AgentSDR live (versioned, edited in
 * Langfuse) and where every AI call is traced. Platform infrastructure, like
 * Resend: one Langfuse project for the deployment, keyed in env
 * (LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL), every
 * trace tagged with its organization. LANGFUSE_TRACING=off keeps prompts but
 * sends no traces (a self-hosted copy that should not ship transcripts out).
 *
 * The server is self-hosted Langfuse v3, so the SDK is pinned to v5 (v6 needs
 * a v4 server). Tracing uses an isolated OpenTelemetry provider: production
 * runs under Bun, and nothing else in the app uses OpenTelemetry.
 *
 * Nothing here may break an AI call: a prompt that cannot be fetched falls
 * back to the copy in src/lib/prompts/registry.ts, and tracing failures are
 * swallowed.
 */

const PROMPT_CACHE_SECONDS = 60;
const PROMPT_FETCH_TIMEOUT_MS = 3_000;

export function langfuseConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  // Tests never reach the network: they read the copies in code.
  if (env.NODE_ENV === "test") return false;
  return Boolean(env.LANGFUSE_PUBLIC_KEY?.trim() && env.LANGFUSE_SECRET_KEY?.trim()) && !isDemoMode(env);
}

export function langfuseTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return langfuseConfigured(env) && env.LANGFUSE_TRACING?.trim().toLowerCase() !== "off";
}

type LangfuseState = { client: LangfuseClient; processor: LangfuseSpanProcessor | null };
const globalForLangfuse = globalThis as typeof globalThis & { __agentsdrLangfuse?: LangfuseState | null };

/** Starts the client and the tracer once per process (dev hot reload included). Null when not configured. */
export function initLangfuse(): LangfuseState | null {
  if (globalForLangfuse.__agentsdrLangfuse !== undefined) return globalForLangfuse.__agentsdrLangfuse;
  if (!langfuseConfigured()) return (globalForLangfuse.__agentsdrLangfuse = null);
  let processor: LangfuseSpanProcessor | null = null;
  if (langfuseTracingEnabled()) {
    try {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      processor = new LangfuseSpanProcessor({ exportMode: "batched" });
      setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [processor] }));
    } catch (error) {
      console.error("[langfuse] tracing could not start:", error);
      processor = null;
    }
  }
  return (globalForLangfuse.__agentsdrLangfuse = { client: new LangfuseClient(), processor });
}

/** Sends queued traces now: scripts before they exit, and anything that must not wait for the batch. */
export async function flushLangfuse(): Promise<void> {
  try {
    await globalForLangfuse.__agentsdrLangfuse?.processor?.forceFlush();
  } catch (error) {
    console.error("[langfuse] flush failed:", error);
  }
}

export type ResolvedPrompt = {
  name: PromptName;
  /** The filled text (getPrompt), or the raw template (getPromptTemplate). */
  text: string;
  /** For linking a generation to the version used; null when the code's copy was used. */
  client: TextPromptClient | null;
  version: number | null;
};

/**
 * The template `name`: the Langfuse version labelled production (cached a
 * minute, refreshed in the background), or the copy in code when Langfuse is
 * not configured or cannot be reached. For builders that fill it themselves.
 */
export async function getPromptTemplate(name: PromptName): Promise<ResolvedPrompt> {
  const fallback = PROMPTS[name].template;
  const state = initLangfuse();
  if (state) {
    try {
      const client = await state.client.prompt.get(name, {
        type: "text",
        cacheTtlSeconds: PROMPT_CACHE_SECONDS,
        fetchTimeoutMs: PROMPT_FETCH_TIMEOUT_MS,
        fallback,
      });
      if (!client.isFallback) return { name, text: client.prompt, client, version: client.version };
    } catch (error) {
      console.error(`[langfuse] prompt ${name} unavailable, using the copy in code:`, error);
    }
  }
  return { name, text: fallback, client: null, version: null };
}

/** The prompt `name` filled with `variables` (see getPromptTemplate). */
export async function getPrompt(name: PromptName, variables: PromptVariables = {}): Promise<ResolvedPrompt> {
  const template = await getPromptTemplate(name);
  return { ...template, text: fillPrompt(template.text, variables) };
}

/** Several templates at once, by name. */
export async function getPromptTemplates<const N extends PromptName>(names: readonly N[]): Promise<Record<N, ResolvedPrompt>> {
  const resolved = await Promise.all(names.map((name) => getPromptTemplate(name)));
  return Object.fromEntries(names.map((name, index) => [name, resolved[index]!])) as Record<N, ResolvedPrompt>;
}

// --- tracing ------------------------------------------------------------------------

export type GenerationUsage = { input?: number | null; output?: number | null; costUsd?: number | null };
export type GenerationRecord = { output?: unknown; model?: string | null; usage?: GenerationUsage | null; metadata?: Record<string, unknown> };

export type GenerationTrace = {
  /** The trace's name in Langfuse, e.g. "crm-draft". */
  name: string;
  model?: string | null;
  input: unknown;
  /** The prompt(s) the call used; the first that came from Langfuse is linked to the generation. */
  prompts?: (ResolvedPrompt | null | undefined)[];
  modelParameters?: Record<string, string | number>;
  metadata?: Record<string, unknown>;
  tags?: string[];
  /** Groups traces (a call's setup, transcription and conversation share the call's id). */
  sessionId?: string | null;
};

function environment(): string {
  return process.env.LANGFUSE_TRACING_ENVIRONMENT?.trim() || (process.env.NODE_ENV === "production" ? "production" : "development");
}

function promptLink(prompts: GenerationTrace["prompts"]) {
  const linked = prompts?.find((prompt) => prompt?.client);
  return linked?.client ? { name: linked.client.name, version: linked.client.version, isFallback: false } : undefined;
}

function promptVersions(prompts: GenerationTrace["prompts"]): Record<string, string> {
  return Object.fromEntries((prompts ?? []).flatMap((prompt) => (prompt ? [[prompt.name, prompt.version === null ? "code" : `v${prompt.version}`]] : [])));
}

function usageDetails(usage: GenerationUsage | null | undefined) {
  if (!usage) return {};
  const details: Record<string, number> = {};
  if (typeof usage.input === "number") details.input = usage.input;
  if (typeof usage.output === "number") details.output = usage.output;
  return {
    ...(Object.keys(details).length ? { usageDetails: details } : {}),
    ...(typeof usage.costUsd === "number" ? { costDetails: { total: usage.costUsd } } : {}),
  };
}

/**
 * Runs one model call inside a Langfuse generation: its input, the prompt
 * version, the model, the output and usage it reports through `record`, its
 * time, and the error if it throws. Tagged with the organization in scope.
 * Without Langfuse it just runs `run`.
 */
export async function traceGeneration<T>(trace: GenerationTrace, run: (record: (result: GenerationRecord) => void) => Promise<T>): Promise<T> {
  const state = initLangfuse();
  if (!state?.processor) return run(() => {});
  let generation: ReturnType<typeof startGeneration> | null = null;
  try {
    generation = startGeneration(trace);
  } catch (error) {
    console.error("[langfuse] could not start a trace:", error);
  }
  try {
    const result = await run((recorded) => {
      try {
        generation?.update({
          output: recorded.output,
          ...(recorded.model ? { model: recorded.model } : {}),
          ...usageDetails(recorded.usage),
          ...(recorded.metadata ? { metadata: { ...trace.metadata, ...recorded.metadata } } : {}),
        });
      } catch {}
    });
    return result;
  } catch (error) {
    try {
      generation?.update({ level: "ERROR", statusMessage: error instanceof Error ? error.message : String(error) });
    } catch {}
    throw error;
  } finally {
    try {
      generation?.end();
    } catch {}
  }
}

function traceAttributes(trace: Pick<GenerationTrace, "name" | "tags" | "sessionId" | "prompts" | "metadata">) {
  const organizationId = maybeCurrentOrganizationId();
  return {
    traceName: trace.name,
    environment: environment(),
    tags: [trace.name, ...(trace.tags ?? [])],
    ...(organizationId ? { userId: `org:${organizationId}` } : {}),
    ...(trace.sessionId ? { sessionId: trace.sessionId } : {}),
    metadata: { ...(organizationId ? { organizationId } : {}), ...promptVersions(trace.prompts) },
  };
}

function startGeneration(trace: GenerationTrace) {
  return propagateAttributes(traceAttributes(trace), () =>
    startObservation(
      trace.name,
      {
        input: trace.input,
        ...(trace.model ? { model: trace.model } : {}),
        ...(trace.modelParameters ? { modelParameters: trace.modelParameters } : {}),
        metadata: { ...trace.metadata, organizationId: maybeCurrentOrganizationId() },
        prompt: promptLink(trace.prompts),
      },
      { asType: "generation" },
    ),
  );
}

/**
 * Records something that already happened (a phone call, after it ended) as
 * one Langfuse trace: a root span over the whole time and the observations
 * inside it, each with its own times.
 */
export function recordPastTrace(trace: {
  name: string;
  startTime: Date;
  endTime: Date;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  sessionId?: string | null;
  prompts?: (ResolvedPrompt | null | undefined)[];
  observations: {
    name: string;
    type: "generation" | "span" | "event";
    startTime: Date;
    endTime?: Date;
    input?: unknown;
    output?: unknown;
    model?: string | null;
    level?: "DEFAULT" | "WARNING" | "ERROR";
    metadata?: Record<string, unknown>;
    linkPrompt?: boolean;
  }[];
}): void {
  const state = initLangfuse();
  if (!state?.processor) return;
  try {
    propagateAttributes(traceAttributes(trace), () => {
      const root = startObservation(trace.name, { input: trace.input, output: trace.output, metadata: trace.metadata }, { startTime: trace.startTime });
      const parentSpanContext = root.otelSpan.spanContext();
      for (const item of trace.observations) {
        const attributes = {
          input: item.input,
          output: item.output,
          ...(item.level ? { level: item.level } : {}),
          metadata: item.metadata,
          ...(item.type === "generation" ? { ...(item.model ? { model: item.model } : {}), prompt: item.linkPrompt ? promptLink(trace.prompts) : undefined } : {}),
        };
        const child =
          item.type === "generation"
            ? startObservation(item.name, attributes, { asType: "generation", startTime: item.startTime, parentSpanContext })
            : item.type === "event"
              ? startObservation(item.name, attributes, { asType: "event", startTime: item.startTime, parentSpanContext })
              : startObservation(item.name, attributes, { startTime: item.startTime, parentSpanContext });
        if (item.type !== "event") child.end(item.endTime ?? item.startTime);
      }
      root.end(trace.endTime);
    });
  } catch (error) {
    console.error("[langfuse] could not record a past trace:", error);
  }
}
