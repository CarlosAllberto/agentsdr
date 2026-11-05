import "server-only";

import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { LangfuseClient, type TextPromptClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, setLangfuseTracerProvider, startObservation } from "@langfuse/tracing";
import { isDemoMode } from "@/lib/demo/mode";
import type { PlatformCredentials } from "@/lib/platform/catalog";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { maybeCurrentOrganizationId } from "@/lib/tenancy/scope";
import { fillPrompt, type PromptVariables } from "@/lib/prompts/template";
import { PROMPTS, type PromptName } from "@/lib/prompts/registry";
import { OrganizationSpanRouter, withTraceOrganization } from "./langfuseRouting";

/**
 * Langfuse: where the prompts written for AgentSDR live (versioned, edited in
 * Langfuse) and where every AI call is traced. A platform integration, per
 * organization (Settings → AI provider): each organization that connects its
 * own Langfuse project gets its prompts from there and its traces sent there.
 * Without it — or outside an organization scope — prompts are the copies in
 * code and nothing is traced. There are no env keys.
 *
 * LANGFUSE_TRACING=off stops traces for the whole deployment (they hold lead
 * names and transcripts) and keeps the prompts. Tests and the public demo
 * never reach Langfuse.
 *
 * The SDK is pinned to v5 (v6 needs a v4 server, and AgentSDR's own is v3).
 * Tracing uses an isolated OpenTelemetry provider whose processor routes each
 * span to its organization's project (langfuseRouting.ts): production runs
 * under Bun, and nothing else in the app uses OpenTelemetry.
 *
 * Nothing here may break an AI call: a prompt that cannot be fetched falls
 * back to the copy in src/lib/prompts/registry.ts, and tracing failures are
 * swallowed.
 */

const PROMPT_CACHE_SECONDS = 60;
const PROMPT_FETCH_TIMEOUT_MS = 3_000;

type LangfuseCredentials = PlatformCredentials["langfuse"];

/** Whether this deployment may reach Langfuse at all: tests read the copies in code, the demo calls nothing. */
export function langfuseAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "test" && !isDemoMode(env);
}

/** Whether traces are sent (for organizations that connected Langfuse). LANGFUSE_TRACING=off is the kill switch. */
export function langfuseTracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return langfuseAvailable(env) && env.LANGFUSE_TRACING?.trim().toLowerCase() !== "off";
}

/** Same project, same keys: the client or processor built for them still serves. */
function connectionIdentity(credentials: LangfuseCredentials): string {
  return `${credentials.baseUrl}\n${credentials.publicKey}\n${credentials.secretKey}`;
}

type LangfuseState = {
  /** One prompt client per organization, rebuilt when its credentials change. */
  clients: Map<string, { identity: string; client: LangfuseClient }>;
  /** Null when tracing is off. */
  router: OrganizationSpanRouter<LangfuseCredentials> | null;
};
const globalForLangfuse = globalThis as typeof globalThis & { __agentsdrLangfuse?: LangfuseState | null };

/** Starts the tracer once per process (dev hot reload included). Null when Langfuse is unavailable here. */
function initLangfuse(): LangfuseState | null {
  if (globalForLangfuse.__agentsdrLangfuse !== undefined) return globalForLangfuse.__agentsdrLangfuse;
  if (!langfuseAvailable()) return (globalForLangfuse.__agentsdrLangfuse = null);
  let router: OrganizationSpanRouter<LangfuseCredentials> | null = null;
  if (langfuseTracingEnabled()) {
    try {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      router = new OrganizationSpanRouter<LangfuseCredentials>(
        (credentials) =>
          new LangfuseSpanProcessor({
            baseUrl: credentials.baseUrl,
            publicKey: credentials.publicKey,
            secretKey: credentials.secretKey,
            environment: environment(),
            exportMode: "batched",
          }),
        connectionIdentity,
      );
      setLangfuseTracerProvider(new BasicTracerProvider({ spanProcessors: [router] }));
    } catch (error) {
      console.error("[langfuse] tracing could not start:", error);
      router = null;
    }
  }
  return (globalForLangfuse.__agentsdrLangfuse = { clients: new Map(), router });
}

/**
 * The organization in scope and its Langfuse credentials (null: not
 * connected). Null overall when there is no organization, Langfuse is
 * unavailable here, or the lookup failed — then nothing changes.
 */
async function organizationConnection(): Promise<{ state: LangfuseState; organizationId: string; credentials: LangfuseCredentials | null } | null> {
  const organizationId = maybeCurrentOrganizationId();
  if (!organizationId) return null;
  const state = initLangfuse();
  if (!state) return null;
  try {
    return { state, organizationId, credentials: await getPlatformCredentials("langfuse") };
  } catch (error) {
    console.error("[langfuse] could not read the organization's connection:", error);
    return null;
  }
}

function promptClient(state: LangfuseState, organizationId: string, credentials: LangfuseCredentials | null): LangfuseClient | null {
  if (!credentials) {
    state.clients.delete(organizationId);
    return null;
  }
  const identity = connectionIdentity(credentials);
  const current = state.clients.get(organizationId);
  if (current?.identity === identity) return current.client;
  const client = new LangfuseClient({ baseUrl: credentials.baseUrl, publicKey: credentials.publicKey, secretKey: credentials.secretKey });
  state.clients.set(organizationId, { identity, client });
  return client;
}

/**
 * Whether spans started now are traced: the organization in scope has
 * Langfuse connected and tracing is on. Brings its route up to date first.
 */
async function tracingOrganization(): Promise<{ router: OrganizationSpanRouter<LangfuseCredentials>; organizationId: string } | null> {
  const connection = await organizationConnection();
  const router = connection?.state.router;
  if (!connection || !router) return null;
  router.connect(connection.organizationId, connection.credentials);
  return connection.credentials ? { router, organizationId: connection.organizationId } : null;
}

/** Sends queued traces now, for every organization: scripts before they exit, and anything that must not wait for the batch. */
export async function flushLangfuse(): Promise<void> {
  try {
    await globalForLangfuse.__agentsdrLangfuse?.router?.forceFlush();
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
 * The template `name`: the version labelled production in the Langfuse
 * project of the organization in scope (cached a minute, refreshed in the
 * background), or the copy in code when it has not connected Langfuse or it
 * cannot be reached. For builders that fill it themselves.
 */
export async function getPromptTemplate(name: PromptName): Promise<ResolvedPrompt> {
  const fallback = PROMPTS[name].template;
  const connection = await organizationConnection();
  const langfuse = connection ? promptClient(connection.state, connection.organizationId, connection.credentials) : null;
  if (langfuse) {
    try {
      const client = await langfuse.prompt.get(name, {
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
 * time, and the error if it throws. Sent to the Langfuse project of the
 * organization in scope; without one it just runs `run`.
 */
export async function traceGeneration<T>(trace: GenerationTrace, run: (record: (result: GenerationRecord) => void) => Promise<T>): Promise<T> {
  const tracing = await tracingOrganization().catch(() => null);
  if (!tracing) return run(() => {});
  let generation: ReturnType<typeof startGeneration> | null = null;
  try {
    generation = withTraceOrganization(tracing.organizationId, () => startGeneration(trace));
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

type PastTrace = {
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
};

/**
 * Records something that already happened (a phone call, after it ended) as
 * one Langfuse trace in the project of the organization in scope: a root
 * span over the whole time and the observations inside it, each with its
 * own times. Fire and forget — it never throws and returns at once.
 */
export function recordPastTrace(trace: PastTrace): void {
  void tracingOrganization()
    .then((tracing) => {
      if (tracing) withTraceOrganization(tracing.organizationId, () => startPastTrace(trace));
    })
    .catch((error) => console.error("[langfuse] could not record a past trace:", error));
}

function startPastTrace(trace: PastTrace): void {
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
