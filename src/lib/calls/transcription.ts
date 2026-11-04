import "server-only";

import { and, eq, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { getByokSettings } from "@/lib/ai/byok";
import { getOpenRouterRuntime } from "@/lib/ai/server/runtime";
import { getPromptTemplate, traceGeneration } from "@/lib/observability/langfuse";
import { PROMPTS } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import type { CallTranscript } from "./contract";
import { callSessions } from "./schema";
import { getRecordingBytes } from "./storage";
import { inOrg } from "@/lib/tenancy/scope";

/**
 * Turns a finished call's recording into a CallTranscript, through the app's
 * mandatory BYOK-only OpenRouter entry point (src/lib/ai/server/runtime.ts —
 * see src/lib/ai/README.md). Never call OpenRouter any other way from here.
 *
 * Two callers, two ways in:
 *  - sessions.ts's finishCall() sets transcript_status='pending' itself, in
 *    the same UPDATE that flips status to "recorded", then fires
 *    `void transcribeCall(id)` without a claim — that UPDATE already
 *    serializes against a second finish (finishCall is idempotent once
 *    terminal), so at most one fire-and-forget run is ever started per call.
 *  - POST /api/calls/:id/transcribe (a manual retry) calls
 *    `transcribeCall(id, { claim: true })`. That path needs its own guard: a
 *    rep could click "Retranscribe" while the original fire-and-forget run
 *    (or a previous retry) is still in flight. `claim: true` runs one atomic
 *    UPDATE that only succeeds when the row isn't already being worked on —
 *    transcript_status isn't 'pending', or it has been 'pending' for more
 *    than 10 minutes (a crashed run's row would otherwise wedge forever).
 *    A failed claim is treated as "someone else has this", not an error: the
 *    caller re-reads the row and shows whatever is there.
 */

const TRANSCRIPTION_TIMEOUT_MS = 5 * 60 * 1000;
const STALE_CLAIM_INTERVAL = sql`now() - interval '10 minutes'`;

type CallSessionRow = typeof callSessions.$inferSelect;

// --- pure parsing (unit-tested, no DB or network) ---------------------------

export type ParsedTranscript = Pick<CallTranscript, "language" | "summary" | "utterances">;
type Utterance = CallTranscript["utterances"][number];

/** format for OpenRouter's input_audio part, from the recording's stored content type. */
export function audioFormatFor(contentType: string | null | undefined): "ogg" | "webm" {
  if (contentType?.startsWith("audio/ogg")) return "ogg";
  // audio/webm, and anything else the extension might have recorded — Gemini
  // accepts audio/webm even though OpenRouter's docs list wav/mp3/aiff/aac/
  // ogg/flac/m4a and not webm; a provider that actually rejects it surfaces
  // as a normal transcription failure (transcript_error), not a crash here.
  return "webm";
}

/**
 * Validates and normalizes the model's raw JSON. Malformed utterances are
 * dropped rather than failing the whole transcript; startSeconds is clamped
 * to >= 0; consecutive fragments from the same speaker are merged (the model
 * sometimes splits one thought into several same-speaker utterances); the
 * result is sorted by startSeconds. Returns null when nothing usable
 * survives — the caller treats that as a transcription failure.
 */
export function parseTranscriptResponse(value: unknown): ParsedTranscript | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { language?: unknown; summary?: unknown; utterances?: unknown };

  const language = typeof raw.language === "string" && raw.language.trim() ? raw.language.trim() : null;
  const summary = typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "";
  const rawUtterances = Array.isArray(raw.utterances) ? raw.utterances : [];

  const cleaned = rawUtterances
    .map((item): Utterance | null => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Record<string, unknown>;
      const speaker = candidate.speaker;
      const text = typeof candidate.text === "string" ? candidate.text.trim() : "";
      const startSecondsRaw = candidate.startSeconds;
      if (speaker !== "rep" && speaker !== "lead") return null;
      if (!text) return null;
      if (typeof startSecondsRaw !== "number" || !Number.isFinite(startSecondsRaw)) return null;
      return { startSeconds: Math.max(0, startSecondsRaw), speaker, text };
    })
    .filter((item): item is Utterance => item !== null)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const merged: Utterance[] = [];
  for (const utterance of cleaned) {
    const last = merged.at(-1);
    if (last && last.speaker === utterance.speaker) {
      merged[merged.length - 1] = { ...last, text: `${last.text} ${utterance.text}`.trim() };
    } else {
      merged.push(utterance);
    }
  }

  if (!merged.length) return null;
  return { language, summary: summary || "No summary was returned.", utterances: merged };
}

/** transcription/call, filled for one recording; `template` is the Langfuse version when the caller has it. */
export function buildTranscriptionPrompt(input: {
  leadName: string | null;
  companyName: string | null;
  /** Ringing before the pick-up at the start of the recording, ms. */
  recordingOffsetMs?: number | null;
  /** The lead called the rep's number (the AI agent answered for the rep). */
  inbound?: boolean;
}, template: string = PROMPTS["transcription/call"].template): string {
  return fillPrompt(template, {
    who: [input.leadName, input.companyName].filter(Boolean).join(", "),
    inbound: Boolean(input.inbound),
    ringing_seconds: input.recordingOffsetMs && input.recordingOffsetMs >= 1000 ? Math.round(input.recordingOffsetMs / 1000) : null,
  });
}

const TRANSCRIPT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    language: { type: ["string", "null"] },
    summary: { type: "string" },
    utterances: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          startSeconds: { type: "number" },
          speaker: { type: "string", enum: ["rep", "lead"] },
          text: { type: "string" },
        },
        required: ["startSeconds", "speaker", "text"],
      },
    },
  },
  required: ["language", "summary", "utterances"],
} as const;

// --- the actual model call ---------------------------------------------------

async function requestTranscript(row: CallSessionRow): Promise<CallTranscript> {
  if (!row.recordingKey) throw new Error("This call has no recording to transcribe");

  const [lead] = await db
    .select({ fullName: people.fullName, firstName: people.firstName, companyName: companies.name })
    .from(people)
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), eq(people.id, row.personId)))
    .limit(1);

  const bytes = await getRecordingBytes(row.recordingKey);
  return transcribeAudio({
    audio: bytes,
    contentType: row.recordingContentType,
    recordingOffsetMs: row.recordingOffsetMs,
    leadName: lead?.fullName ?? lead?.firstName ?? null,
    companyName: lead?.companyName ?? null,
    inbound: row.direction === "inbound",
    callId: row.id,
  });
}

/**
 * The model call itself, on audio already in hand — separate from
 * requestTranscript so it can be exercised on a local file without a call
 * row or R2.
 */
export async function transcribeAudio(input: {
  audio: Uint8Array;
  contentType: string | null;
  recordingOffsetMs?: number | null;
  leadName: string | null;
  companyName: string | null;
  inbound?: boolean;
  /** Groups the trace with the call's other traces in Langfuse. */
  callId?: string;
}): Promise<CallTranscript> {
  const selected = (await getByokSettings()).transcriptionModel;
  if (!selected) {
    throw new Error("Transcription is off: choose a transcription model in Settings → AI provider");
  }
  const { provider, modelId: model } = selected;
  const base64 = Buffer.from(input.audio).toString("base64");
  const format = audioFormatFor(input.contentType);

  const runtime = await getOpenRouterRuntime({ provider, modelId: model }, TRANSCRIPTION_TIMEOUT_MS);
  const prompt = await getPromptTemplate("transcription/call");
  const text = buildTranscriptionPrompt({
    leadName: input.leadName,
    companyName: input.companyName,
    recordingOffsetMs: input.recordingOffsetMs,
    inbound: input.inbound,
  }, prompt.text);
  return traceGeneration({
    name: "call-transcription",
    model,
    // The recording stays out of the trace; its size and format say enough.
    input: [{ role: "user", content: [{ type: "text", text }, { type: "input_audio", input_audio: `[audio: ${input.audio.byteLength} bytes, ${format}]` }] }],
    prompts: [prompt],
    modelParameters: { temperature: 0 },
    metadata: { provider, inbound: Boolean(input.inbound), ...(input.callId ? { callId: input.callId } : {}) },
    sessionId: input.callId,
  }, async (record) => {
    const response = await runtime.client.chat.completions.create(
      {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text },
              { type: "input_audio", input_audio: { data: base64, format } },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: "call_transcript", strict: true, schema: TRANSCRIPT_JSON_SCHEMA } },
        provider: runtime.provider,
        temperature: 0,
      } as never,
      {},
    ) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
    };

    const content = response.choices?.[0]?.message?.content;
    const usage = { input: response.usage?.prompt_tokens, output: response.usage?.completion_tokens, costUsd: response.usage?.cost };
    record({ output: content ?? null, usage });
    if (!content) throw new Error("The model returned no transcript content");
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      throw new Error("The model's response was not valid JSON");
    }
    record({ output: json, usage });
    const parsed = parseTranscriptResponse(json);
    if (!parsed) throw new Error("The model's transcript had no valid utterances");
    return { ...parsed, model: `${provider}/${model}` };
  });
}

// --- orchestration ------------------------------------------------------

async function claimForRetry(callId: string): Promise<CallSessionRow | null> {
  const [row] = await db
    .update(callSessions)
    .set({ transcriptStatus: "pending", updatedAt: new Date() })
    .where(
      and(
        inOrg(callSessions),
        eq(callSessions.id, callId),
        eq(callSessions.status, "recorded"),
        or(ne(callSessions.transcriptStatus, "pending"), lt(callSessions.updatedAt, STALE_CLAIM_INTERVAL)),
      ),
    )
    .returning();
  return row ?? null;
}

async function finish(callId: string, outcome: { transcript: CallTranscript } | { error: string }): Promise<void> {
  const now = new Date();
  if ("transcript" in outcome) {
    await db
      .update(callSessions)
      .set({ transcriptStatus: "done", transcript: outcome.transcript, transcriptError: null, transcribedAt: now, updatedAt: now })
      .where(and(inOrg(callSessions), eq(callSessions.id, callId)));
  } else {
    await db
      .update(callSessions)
      .set({ transcriptStatus: "failed", transcriptError: outcome.error.slice(0, 1000), updatedAt: now })
      .where(and(inOrg(callSessions), eq(callSessions.id, callId)));
  }
}

/**
 * Runs (or re-runs) transcription for one call. Never throws except for a
 * genuine programming error — every expected failure (missing config, a
 * network error, an unusable model response) is caught and stored as
 * transcript_status='failed' + transcript_error, because this is normally
 * called fire-and-forget and there is nothing above it to catch a throw.
 */
export async function transcribeCall(callId: string, options: { claim?: boolean } = {}): Promise<void> {
  let row: CallSessionRow | null;
  if (options.claim) {
    row = await claimForRetry(callId);
    if (!row) return; // Another run already owns this call (or just finished) — nothing to do.
  } else {
    const [existing] = await db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, callId))).limit(1);
    row = existing && existing.status === "recorded" ? existing : null;
    if (!row) return;
  }

  try {
    const transcript = await requestTranscript(row);
    await finish(callId, { transcript });
  } catch (error) {
    await finish(callId, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // The lead's CRM stage from what was said (leadStage.ts). Fire-and-forget:
  // the transcript is saved, and nothing that happens here may undo that.
  // Imported lazily — leadStage.ts reaches sessions.ts, which imports this
  // module — and classifyCallTranscript logs its own failures; the catch is
  // for the import itself.
  void import("./leadStage")
    .then(({ classifyCallTranscript }) => classifyCallTranscript(callId))
    .catch((error) => console.error(`Call ${callId}: classifying the transcript failed`, error));
}
