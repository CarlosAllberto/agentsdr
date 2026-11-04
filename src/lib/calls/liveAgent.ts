import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmKnowledgeDocuments, crmKnowledgeDocumentVersions } from "@/lib/crm/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { pcm16Wav } from "../../../extensions/whatsapp-recorder/src/wav";
import { renderAiInstructions } from "@/lib/crm/ai/instructions";
import { DEFAULT_CALLING_INSTRUCTIONS, fillCallingPlaceholders } from "./callingInstructions";
import { afterCallFacts, loadAgentContext, loadCampaignKnowledgeIds, type AgentPromptContext } from "./agentContext";
import {
  AGENT_OUTCOMES,
  AGENT_VOICES,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_VOICE,
  MAX_AGENT_BRIEF_CHARS,
  MAX_AGENT_NAME_CHARS,
  type AgentOutcome,
  type AgentTokenRequest,
  type AgentTokenResponse,
  type RecorderLead,
} from "./contract";
import type { callSessions } from "./schema";
import { CallApiError } from "./sessions";

type CallSessionRow = typeof callSessions.$inferSelect;

/**
 * The AI voice agent (trial): a WhatsApp call placed from AgentSDR where
 * Gemini Live, not the rep, talks to the lead. The extension streams the
 * lead's audio to the model and plays the model's voice into the call as the
 * microphone (see extensions/whatsapp-recorder/src/live-agent.ts).
 *
 * The browser never sees the API key: this mints a single-use ephemeral token
 * with the whole session — model, voice, instructions, tools — locked into
 * it, so the extension's own setup message cannot change any of it.
 *
 * TRIAL EXCEPTION to two standing rules, on the owner's instruction (11 Oct
 * 2026): the key is read from GEMINI_API_KEY rather than a per-organization
 * integration, and the model is called directly rather than through the
 * OpenRouter BYOK runtime (OpenRouter has no realtime audio API). Move the
 * key into an organization integration before this leaves the trial.
 */

const LIVE_MODEL = "gemini-3.8-live";
const API_BASE = "https://generativelanguage.googleapis.com";
/** Ephemeral tokens are v1alpha-only for the Live socket (constrained endpoint). */
const WEBSOCKET_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
/** The socket is opened when the call starts ringing, so a minute is plenty. */
const NEW_SESSION_WINDOW_MS = 2 * 60_000;
const TOKEN_LIFETIME_MS = 30 * 60_000;

export function parseAgentTokenRequest(value: unknown): AgentTokenRequest {
  if (!value || typeof value !== "object") throw new CallApiError(400, "Expected a JSON object");
  const body = value as Record<string, unknown>;
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (!brief) throw new CallApiError(400, "The agent needs a brief");
  if (brief.length > MAX_AGENT_BRIEF_CHARS) throw new CallApiError(400, `The brief is over ${MAX_AGENT_BRIEF_CHARS} characters`);
  return { brief, lead: parseLead(body.lead), name: parseAgentName(body.name), voice: parseAgentVoice(body.voice) };
}

/** The agent's name, or null for the default. */
export function parseAgentName(value: unknown): string | null {
  const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!name) return null;
  if (name.length > MAX_AGENT_NAME_CHARS) throw new CallApiError(400, `The agent's name is over ${MAX_AGENT_NAME_CHARS} characters`);
  return name;
}

/** One of AGENT_VOICES, or null for the default. */
export function parseAgentVoice(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !AGENT_VOICES.some((voice) => voice.id === value)) {
    throw new CallApiError(400, "Unknown voice for the agent");
  }
  return value;
}

/** The body of POST …/outcome: what the agent's record_outcome tool was called with. */
export function parseAgentOutcome(value: unknown): AgentOutcome {
  if (!value || typeof value !== "object") throw new CallApiError(400, "Expected a JSON object");
  const body = value as Record<string, unknown>;
  const outcome = AGENT_OUTCOMES.find((kind) => kind === body.outcome);
  if (!outcome) throw new CallApiError(400, "Unknown outcome");
  const text = (key: string, max: number) => {
    const raw = typeof body[key] === "string" ? (body[key] as string).trim() : "";
    return raw ? raw.slice(0, max) : null;
  };
  return { outcome, summary: text("summary", 500), when: text("when", 120), whenAt: parseWhenAt(body.whenAt), recordedAt: new Date().toISOString() };
}

const WHEN_AT_PAST_MS = 60 * 60_000;
const WHEN_AT_FUTURE_MS = 60 * 24 * 60 * 60_000;

/** The agreed instant, kept only if it is an ISO 8601 time between an hour ago and 60 days ahead; a model's arithmetic slips. */
export function parseWhenAt(value: unknown, now = Date.now()): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const at = Date.parse(text);
  if (Number.isNaN(at) || at < now - WHEN_AT_PAST_MS || at > now + WHEN_AT_FUTURE_MS) return null;
  return text;
}

function parseLead(value: unknown): RecorderLead | null {
  if (!value || typeof value !== "object") return null;
  const lead = value as Record<string, unknown>;
  const text = (key: string) => (typeof lead[key] === "string" ? (lead[key] as string).slice(0, 200) : null);
  return { name: text("name"), detail: text("detail"), firstName: text("firstName"), company: text("company") };
}

/** Runs in the call's organization (withRecorderScope): the knowledge is that organization's. */
export async function mintAgentToken(row: CallSessionRow, request: AgentTokenRequest): Promise<AgentTokenResponse> {
  // A rep talks on this one (contract.ts, "a rep talking through a calling station"): there is no agent to start.
  if (row.remoteRep) throw new CallApiError(409, "A rep talks on this call, not the AI agent");
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new CallApiError(409, "The AI voice agent is not set up on this server (GEMINI_API_KEY is missing)");
  if (row.status !== "pending" && row.status !== "in_progress") {
    throw new CallApiError(409, "This call is already over");
  }
  const [knowledge, context] = await Promise.all([
    loadCampaignKnowledgeIds(row.campaignContactId).then((ids) => agentKnowledge(ids)),
    loadAgentContext(row),
  ]);
  return { ...(await mintLiveToken(liveSetup(request, knowledge, context))), saveHeardAudio: saveHeardAudio() };
}

/**
 * A token for a voice rehearsal in the rep's own browser (AgentVoiceRehearsal):
 * the same setup a campaign call would get, with no call and nothing saved.
 */
export async function mintRehearsalToken(request: AgentTokenRequest, knowledge: KnowledgeDocument[], context: AgentPromptContext): Promise<AgentTokenResponse> {
  return mintLiveToken(liveSetup(request, knowledge, context));
}

/** A single-use ephemeral token with `setup` locked in; the API key stays here. */
async function mintLiveToken(setup: ReturnType<typeof liveSetup>): Promise<AgentTokenResponse> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new CallApiError(409, "The AI voice agent is not set up on this server (GEMINI_API_KEY is missing)");
  const now = Date.now();
  const response = await fetch(`${API_BASE}/v1alpha/auth_tokens`, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      uses: 1,
      expireTime: new Date(now + TOKEN_LIFETIME_MS).toISOString(),
      newSessionExpireTime: new Date(now + NEW_SESSION_WINDOW_MS).toISOString(),
      bidiGenerateContentSetup: setup,
    }),
  });
  const body = (await response.json().catch(() => null)) as { name?: string; error?: { message?: string } } | null;
  if (!response.ok || !body?.name) {
    // Not 502: Cloudflare, in front of app.agentsdr.ai, replaces a 502's body
    // with its own "Bad gateway" page, so the extension saw only the status
    // and never Gemini's reason (23 Oct 2026).
    throw new CallApiError(424, `Gemini refused the agent session: ${body?.error?.message ?? `HTTP ${response.status}`}`);
  }
  return { token: body.name, model: `models/${LIVE_MODEL}`, websocketUrl: WEBSOCKET_URL };
}

/** The Live session, in the API's own JSON shape (BidiGenerateContentSetup). */
export function liveSetup(request: AgentTokenRequest, knowledge: KnowledgeDocument[], context: AgentPromptContext = {}) {
  return {
    model: `models/${LIVE_MODEL}`,
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice ?? DEFAULT_AGENT_VOICE } } },
    },
    // Background noise on the lead's line counted as them talking: the agent
    // held its greeting for 8.5 s after the pick-up, until the noise paused
    // (23 Oct 2026). Low start-of-speech sensitivity needs clearer speech
    // before it yields; everything else stays at Gemini's defaults.
    realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: "START_SENSITIVITY_LOW" } },
    systemInstruction: { parts: [{ text: agentInstructions(request, knowledge, context) }] },
    tools: [
      {
        functionDeclarations: [
          {
            name: "record_outcome",
            description:
              "Record how the call went, once, before your goodbye. Call it again only if the outcome changes (they agree to a meeting after all).",
            parameters: {
              type: "OBJECT",
              properties: {
                outcome: {
                  type: "STRING",
                  enum: [...AGENT_OUTCOMES],
                  description:
                    "meeting_booked: they agreed to book a meeting with the team or to receive the booking link. interested: they want to hear more, nothing agreed. human_callback: they want a person from the team to call them. call_back: a bad moment, call them again later. not_interested. wrong_person: not who you were calling. do_not_contact: they asked never to be contacted again. no_response: they never really answered. other.",
                },
                summary: { type: "STRING", description: "One sentence on what happened and anything they asked for." },
                when: {
                  type: "STRING",
                  description: "For meeting_booked, human_callback or call_back: the day and time as agreed, in their words (\"Thursday around 4 pm\").",
                },
                whenAt: {
                  type: "STRING",
                  description:
                    "The exact instant of an agreed meeting or call-back time, ISO 8601 with UTC offset (2026-10-29T16:00:00+05:30), worked out from the current date and time in your instructions. Omit if no time was agreed.",
                },
              },
              required: ["outcome", "summary"],
            },
          },
          {
            name: "wait_for_them",
            description:
              "They asked you to wait or hold on (\"one second\", \"ek minute\"). Say a short okay, call this, then stay quiet until they speak again.",
            parameters: { type: "OBJECT", properties: {} },
          },
          {
            name: "end_call",
            description:
              "Hang up the call. Only after you have said goodbye, and only when the person said goodbye or asked to end the call, the call reached its goal, they clearly said no, or a call note tells you to. Never because of a question, a complaint or a request — answer those instead.",
            parameters: {
              type: "OBJECT",
              properties: { reason: { type: "STRING", description: "Why the call is ending, in a few words." } },
            },
          },
        ],
      },
    ],
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
}

/**
 * The agent's instructions: a short fixed part about being on a phone call,
 * then everything the organization writes. Only what the calling system
 * depends on is fixed here: that it is a live cold phone call (one voice, one
 * point at a time, wait for answers), who the agent is, honesty that it is an
 * AI, what will actually happen after the call (so it promises nothing the
 * system does not do), and its tools. How it opens, pitches, handles
 * objections, proposes the next step and ends belongs to the calling
 * instructions (Settings → Instructions → Calling; the defaults in
 * callingInstructions.ts). Rules like "never quote a number unless asked"
 * used to sit here, out of sight, and overrode what organizations wrote
 * (persona test, 4 Nov 2026).
 */
export function agentInstructions(
  { brief, lead, name, voice }: AgentTokenRequest,
  knowledge: KnowledgeDocument[],
  context: AgentPromptContext = {},
): string {
  const agentName = name ?? DEFAULT_AGENT_NAME;
  const female = (AGENT_VOICES.find((option) => option.id === voice)?.gender ?? "female") === "female";
  const firstName = lead?.firstName?.trim() || null;
  const who = [lead?.name, lead?.company ?? null, lead?.detail].filter(Boolean).join(", ");
  return [
    `You are ${agentName}, on a live phone call over WhatsApp with a real person. Your name is ${agentName}; never use any other name.`,
    context.inbound
      ? who
        ? `${who} called this number back, and you answered.`
        : "Someone called this number and you answered. You do not know their name: ask it naturally."
      : who
        ? `You are calling ${who}. It is a cold call: they did not expect it.`
        : "You do not know the person's name: ask it naturally if it matters.",
    ...(context.now ? [`It is now ${context.now}.`] : []),
    "",
    "This is a phone call, not a text chat. Everything you say is spoken aloud and heard through a phone line; they cannot see anything.",
    "- Talk the way people talk on the phone: short sentences, one point at a time, then stop and let them answer.",
    "- When you ask a question, wait for their answer. Never answer it for them or assume a yes.",
    "- Say numbers the way you would say them aloud. Never read out a link, an email address or a long number.",
    "- Keep one voice for the whole call: the same accent, pace and tone, in whichever language you speak.",
    female
      ? "- You are a woman. In Hindi always use feminine forms for yourself: \"मैं कर रही हूँ\", \"मैं समझ सकती हूँ\", never \"रहा\" or \"सकता\"."
      : "- You are a man. In Hindi always use masculine forms for yourself: \"मैं कर रहा हूँ\", \"मैं समझ सकता हूँ\".",
    "- If they sincerely ask whether you are an AI, a bot or a recording, say yes in one short sentence, then offer to carry on or to have a person from the team call them. Never claim to be human.",
    "",
    ...afterCallFacts(context.goal ?? null),
    "",
    "How the call system works:",
    "- Once you know how the call went, call record_outcome. It is silent: keep talking after it.",
    "- If they ask you to wait or hold on, call wait_for_them and stay quiet until they speak again.",
    "- When the call is over, say goodbye out loud, then call end_call.",
    "- Text in square brackets that starts with \"[Call note:\" comes from the calling system, not from the person. Follow it and never mention it.",
    "",
    "What this call is for, from the team that set it up:",
    "<brief>",
    brief,
    "</brief>",
    ...(knowledge.length
      ? [
          "",
          `What you know about the company you are calling for. People it names (a founder, a contact) are your team; you are still ${agentName}.`,
          "<knowledge>",
          ...knowledge.map((document) => `## ${document.title}\n${document.content}`),
          "</knowledge>",
        ]
      : []),
    ...(context.history ? ["", context.history] : []),
    "",
    "How to run the call — your team's calling instructions:",
    renderAiInstructions(context.callingInstructions?.length ? context.callingInstructions : DEFAULT_CALLING_INSTRUCTIONS)
      ?.split("\n")
      .map((line) => fillCallingPlaceholders(line, { agentName, firstName }))
      .join("\n") ?? "",
  ].join("\n");
}

export type KnowledgeDocument = { title: string; content: string };

/** Most useful first: company and product before case studies. */
const KNOWLEDGE_ORDER = ["company", "product", "pricing", "faq", "objection", "scheduling", "custom", "case_study"];

/**
 * The CRM Knowledge an agent call is grounded in: the documents an AI
 * campaign selected (`ids`; empty = none), or else the organization's
 * documents marked "always include" — the same set that grounds the
 * call-transcript classification (leadStage.ts). Archived ones never count.
 */
export async function agentKnowledge(ids: string[] | null = null): Promise<KnowledgeDocument[]> {
  if (ids && !ids.length) return [];
  const rows = await db
    .select({ title: crmKnowledgeDocuments.title, kind: crmKnowledgeDocuments.kind, content: crmKnowledgeDocumentVersions.content })
    .from(crmKnowledgeDocuments)
    .innerJoin(
      crmKnowledgeDocumentVersions,
      and(
        eq(crmKnowledgeDocumentVersions.documentId, crmKnowledgeDocuments.id),
        eq(crmKnowledgeDocumentVersions.version, crmKnowledgeDocuments.latestVersion),
      ),
    )
    .where(
      and(
        inOrg(crmKnowledgeDocuments),
        eq(crmKnowledgeDocuments.active, true),
        ids ? inArray(crmKnowledgeDocuments.id, ids) : eq(crmKnowledgeDocuments.alwaysInclude, true),
      ),
    )
    .orderBy(asc(crmKnowledgeDocuments.title));
  return orderKnowledge(rows);
}

/**
 * Every selected document, whole. A cap of 5,000 characters a document and
 * 12,000 in all gave the agent 41% of one organization's knowledge (4 Nov
 * 2026): their pricing section never reached a call, so it told two leads it
 * could not discuss price. CRM drafts dropped their budget for the same reason.
 */
export function orderKnowledge(rows: { title: string; kind: string; content: string }[]): KnowledgeDocument[] {
  const rank = (kind: string) => {
    const index = KNOWLEDGE_ORDER.indexOf(kind);
    return index === -1 ? KNOWLEDGE_ORDER.length : index;
  };
  return [...rows]
    .sort((a, b) => rank(a.kind) - rank(b.kind))
    .map((row) => ({ title: row.title, content: row.content.trim() }))
    .filter((document) => document.content);
}

/** Test option: the extension uploads the exact audio the model heard (see AgentTokenResponse). */
export function saveHeardAudio(): boolean {
  return process.env.AGENT_SAVE_HEARD_AUDIO?.trim() === "true";
}

// --- Rehearsal ----------------------------------------------------------------

export type RehearsalTurn = { role: "lead" | "agent"; text: string };
export type RehearsalResult = { reply: string; tools: { name: string; args: Record<string, unknown> }[] };

const REHEARSAL_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const REHEARSAL_TIMEOUT_MS = 25_000;
/** The same notes live-agent.ts (the extension) sends on a real call. */
const GREETING_NOTE = "[Call note: the call has just connected and the person is on the line. Open the call now.]";
const CARRY_ON_NOTE = "[Call note: noted. Carry on the call from where it was.]";

/**
 * One agent turn of a rehearsal: the real session setup (liveSetup, so the
 * prompt is exactly a call's) over a server-side Gemini Live socket, the typed
 * conversation sent as text, the agent's speech read back as its transcript.
 * Runs in the organization scope; the caller supplies the context.
 */
export async function rehearseAgent(
  request: AgentTokenRequest,
  knowledge: KnowledgeDocument[],
  context: AgentPromptContext,
  turns: RehearsalTurn[],
): Promise<RehearsalResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new CallApiError(409, "The AI voice agent is not set up on this server (GEMINI_API_KEY is missing)");
  const history = [
    { role: "user", parts: [{ text: GREETING_NOTE }] },
    ...turns.map((turn) => ({ role: turn.role === "lead" ? "user" : "model", parts: [{ text: turn.text }] })),
  ];

  return await new Promise<RehearsalResult>((resolve, reject) => {
    const socket = new WebSocket(`${REHEARSAL_URL}?key=${encodeURIComponent(apiKey)}`);
    socket.binaryType = "arraybuffer";
    let reply = "";
    const tools: RehearsalResult["tools"] = [];
    let nudged = false;
    let settled = false;
    const finish = (error: CallApiError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve({ reply: reply.trim(), tools });
    };
    const timer = setTimeout(() => finish(new CallApiError(504, "The agent did not answer in time")), REHEARSAL_TIMEOUT_MS);

    socket.addEventListener("open", () => socket.send(JSON.stringify({ setup: liveSetup(request, knowledge, context) })));
    socket.addEventListener("error", () => finish(new CallApiError(424, "Could not reach Gemini Live")));
    socket.addEventListener("close", (event) => finish(new CallApiError(424, `Gemini closed the session${event.reason ? `: ${event.reason}` : ""}`)));
    socket.addEventListener("message", (event) => {
      let message: {
        setupComplete?: unknown;
        serverContent?: { outputTranscription?: { text?: string }; turnComplete?: boolean };
        toolCall?: { functionCalls?: { id?: string; name: string; args?: Record<string, unknown> }[] };
      };
      try {
        const raw = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.setupComplete) {
        socket.send(JSON.stringify({ clientContent: { turns: history, turnComplete: true } }));
        return;
      }
      if (message.toolCall?.functionCalls?.length) {
        const calls = message.toolCall.functionCalls;
        for (const call of calls) tools.push({ name: call.name, args: call.args ?? {} });
        socket.send(JSON.stringify({ toolResponse: { functionResponses: calls.map((call) => ({ id: call.id, name: call.name, response: { ok: true } })) } }));
      }
      const content = message.serverContent;
      if (content?.outputTranscription?.text) reply += content.outputTranscription.text;
      if (content?.turnComplete) {
        // The live model goes silent after a tool call: ask it, once, to carry on.
        if (!reply.trim() && tools.length && !nudged) {
          nudged = true;
          socket.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: CARRY_ON_NOTE }] }], turnComplete: true } }));
          return;
        }
        finish(null);
      }
    });
  });
}

// --- voice sample -------------------------------------------------------------------

/** Samples kept in memory, by voice and name: one Live session per voice is enough. */
const voiceSamples = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
const MAX_VOICE_SAMPLES = 64;

/**
 * A few seconds of `voice` saying a typical opening, as a WAV — spoken by the
 * same native-audio Live model the calls use, not a separate TTS voice, so
 * it sounds like a call will. For the ▶ next to the voice picker.
 */
export function voiceSample(voice: string | null, name: string | null): Promise<Uint8Array<ArrayBuffer>> {
  const voiceId = parseAgentVoice(voice) ?? DEFAULT_AGENT_VOICE;
  const agentName = parseAgentName(name) ?? DEFAULT_AGENT_NAME;
  const key = `${voiceId}|${agentName}`;
  let sample = voiceSamples.get(key);
  if (!sample) {
    if (voiceSamples.size >= MAX_VOICE_SAMPLES) voiceSamples.delete(voiceSamples.keys().next().value!);
    sample = speakSample(voiceId, agentName);
    voiceSamples.set(key, sample);
    sample.catch(() => voiceSamples.delete(key));
  }
  return sample;
}

async function speakSample(voice: string, name: string): Promise<Uint8Array<ArrayBuffer>> {
  const female = (AGENT_VOICES.find((option) => option.id === voice)?.gender ?? "female") === "female";
  // One line per session: given two, the live model often spoke only one (27 Oct 2026).
  const lines = [
    `Hi, this is ${name} — did I catch you at an okay time?`,
    `Namaste, main ${name} bol ${female ? "rahi" : "raha"} hoon — kya abhi do minute baat ho sakti hai?`,
  ];
  const spoken = await Promise.all(lines.map((line) => speakLine(voice, line)));
  const rate = spoken[0]!.rate;
  const pause = new Int16Array(Math.round(rate * 0.5));
  const parts = spoken.flatMap((part, index) => (index ? [pause, part.pcm] : [part.pcm]));
  const pcm = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    pcm.set(part, at);
    at += part.length;
  }
  return pcm16Wav(pcm, rate);
}

/** One line in `voice`; about one session in four ends without a word, so it tries three times. */
async function speakLine(voice: string, line: string): Promise<{ pcm: Int16Array; rate: number }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const spoken = await speakOnce(voice, line);
      if (spoken.pcm.length > spoken.rate / 2) return spoken;
      lastError = new CallApiError(424, "Gemini returned no speech for the sample");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function speakOnce(voice: string, line: string): Promise<{ pcm: Int16Array; rate: number }> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new CallApiError(409, "The AI voice agent is not set up on this server (GEMINI_API_KEY is missing)");
  const chunks: Int16Array[] = [];
  let rate = 24_000;
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(`${REHEARSAL_URL}?key=${encodeURIComponent(apiKey)}`);
    socket.binaryType = "arraybuffer";
    let settled = false;
    const finish = (error: CallApiError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new CallApiError(504, "Gemini did not speak the sample in time")), REHEARSAL_TIMEOUT_MS);
    socket.addEventListener("open", () =>
      socket.send(JSON.stringify({
        setup: {
          model: `models/${LIVE_MODEL}`,
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
          systemInstruction: {
            parts: [{ text: "You are a voice actor recording a phone-call demo. Speak the line you are given exactly, warmly and naturally, as the caller would, and say nothing else." }],
          },
        },
      })),
    );
    socket.addEventListener("error", () => finish(new CallApiError(424, "Could not reach Gemini Live")));
    socket.addEventListener("close", (event) => finish(chunks.length ? null : new CallApiError(424, `Gemini closed the session${event.reason ? `: ${event.reason}` : ""}`)));
    socket.addEventListener("message", (event) => {
      let message: { setupComplete?: unknown; serverContent?: { modelTurn?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] }; turnComplete?: boolean } };
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
      } catch {
        return;
      }
      if (message.setupComplete) {
        socket.send(JSON.stringify({ clientContent: { turns: [{ role: "user", parts: [{ text: line }] }], turnComplete: true } }));
        return;
      }
      for (const part of message.serverContent?.modelTurn?.parts ?? []) {
        const audio = part.inlineData;
        if (!audio?.data || !audio.mimeType?.startsWith("audio/pcm")) continue;
        rate = Number(/rate=(\d+)/.exec(audio.mimeType)?.[1] ?? rate);
        const bytes = Buffer.from(audio.data, "base64");
        chunks.push(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      }
      if (message.serverContent?.turnComplete) finish(null);
    });
  });
  const pcm = new Int16Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    pcm.set(chunk, at);
    at += chunk.length;
  }
  return { pcm, rate };
}
