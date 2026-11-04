/**
 * AI calling campaigns: a calling campaign whose calls the AI agent places
 * by itself, from cloud calling stations, following a sequence — the shapes
 * the API, the pages and the engine share. Client-safe and import-free.
 *
 * A campaign is a call_campaigns row with run_by = 'ai'. Its leads are the
 * usual call_campaign_contacts, with the ai_* columns holding where each
 * stands. Two sequences:
 *
 *   steps        reach them: AI calls and WhatsApp messages, each after a
 *                delay, run only while the lead has not had a real
 *                conversation. Picking up and saying nothing does not count.
 *   chaseSteps   they said yes to a meeting but have not booked: after the
 *                call a WhatsApp with the booking link goes out, then these
 *                run until Cal.com reports a booking, they reply, or the
 *                steps run out (then a person takes over).
 *
 * After a real conversation the agent's outcome (record_outcome) decides
 * what happens; see AI_OUTCOME_ROUTES and engineRules.ts.
 */

export const AI_CAMPAIGN_GOALS = ["book_meeting", "human_callback", "either"] as const;
export type AiCampaignGoal = (typeof AI_CAMPAIGN_GOALS)[number];
export const AI_CAMPAIGN_GOAL_LABELS: Record<AiCampaignGoal, { label: string; help: string }> = {
  book_meeting: {
    label: "Book a meeting",
    help: "If they are interested, the agent agrees to send a booking link on WhatsApp; follow-ups chase until they book.",
  },
  human_callback: {
    label: "Hand over to the team",
    help: "If they are interested, the agent confirms it and agrees when a person from your team will call; the lead lands in Action required.",
  },
  either: {
    label: "Either, their choice",
    help: "The agent offers the booking link, or a call from the team if they prefer.",
  },
};

export type AiCampaignCallStep = {
  /** Stable id: claims and stats follow a step across edits and reordering. */
  id: string;
  kind: "call";
  /** Hours after the previous step (ignored for the first step). */
  delayHours: number;
  /** What this call is for, on top of the campaign's instructions ("second try: mention you called yesterday"). */
  instructions: string;
};

export type AiCampaignMessageStep = {
  id: string;
  kind: "message";
  delayHours: number;
  /** WhatsApp text; merge fields {{firstName}}, {{company}}, {{agentName}}, {{bookingLink}}, and the lead's custom fields. */
  body: string;
};

export type AiCampaignStep = AiCampaignCallStep | AiCampaignMessageStep;

export const AI_CAMPAIGN_MAX_STEPS = 8;
export const AI_CAMPAIGN_MAX_DELAY_HOURS = 24 * 30;
export const AI_CAMPAIGN_MAX_INSTRUCTIONS_CHARS = 2_000;
export const AI_CAMPAIGN_MAX_MESSAGE_CHARS = 1_000;
export const AI_CAMPAIGN_MAX_CALLBACKS = 3;

/**
 * Where a lead stands in an AI campaign (call_campaign_contacts.ai_status).
 * The engine only acts on AI_OPEN_STATUSES.
 */
export const AI_CONTACT_STATUSES = [
  "queued", //          enrolled, nothing done yet
  "reaching", //        in the reach sequence (steps)
  "callback", //        they asked to be called back at ai_next_at
  "chasing", //         said yes, booking link sent, chase sequence running
  "booked", //          Cal.com reported a booking
  "handoff", //         a person takes it from here (Action required)
  "not_interested",
  "unreached", //       the reach sequence ran out without a conversation
  "replied", //         they wrote back on some channel: a person takes it from here
  "stopped", //         Do Not Contact, wrong person, or stopped by a person
  "failed", //          not on WhatsApp, or errors a person should look at
] as const;
export type AiContactStatus = (typeof AI_CONTACT_STATUSES)[number];
/**
 * The step run an incoming call from an AI lead gets (src/lib/calls/incoming.ts):
 * one per call, so the engine settles its outcome like a placed call's.
 */
export function inboundStepKey(callId: string): string {
  return `inbound:${callId}`;
}
export function isInboundStepKey(stepKey: string): boolean {
  return stepKey.startsWith("inbound:");
}
/**
 * The step run an AI call placed from the lead drawer gets ("AI call", not
 * Call now): without one its outcome reached nothing — a call-back the lead
 * asked for was never made and a booking link never sent (4 Nov 2026).
 */
export function drawerCallStepKey(callId: string): string {
  return `now:${callId}`;
}
/** A call outside the sequence (they rang back, or someone pressed AI call): only a conversation moves the lead. */
export function isOffSequenceCallKey(stepKey: string): boolean {
  return stepKey.startsWith("inbound:") || stepKey.startsWith("now:");
}

export const AI_OPEN_STATUSES = ["queued", "reaching", "callback", "chasing"] as const satisfies readonly AiContactStatus[];
export const AI_CONTACT_STATUS_LABELS: Record<AiContactStatus, string> = {
  queued: "Queued",
  reaching: "Reaching",
  callback: "Call back scheduled",
  chasing: "Waiting for booking",
  booked: "Meeting booked",
  handoff: "For the team",
  not_interested: "Not interested",
  unreached: "Unreached",
  replied: "Replied",
  stopped: "Stopped",
  failed: "Failed",
};

/**
 * One action the engine took for a lead (call_campaign_step_runs). The key is
 * unique per lead, so a step can never run twice:
 *   reach:<stepId>   chase:<stepId>   callback:<n>   booking-link   retry:<stepKey>:<n>
 */
export type AiStepRunKind = "call" | "message";
export type AiStepRunStatus = "started" | "done" | "failed";
/** What a finished call amounted to, for the sequence. */
export type AiCallResult = "conversation" | "no_answer" | "not_on_whatsapp" | "error";

/** Campaign settings beyond the sequences (call_campaigns ai_* columns). */
export type AiCampaignSettings = {
  goal: AiCampaignGoal;
  /** Campaign-level instructions for every call: who we are calling, what we offer them, what to find out. */
  instructions: string;
  agentName: string | null;
  agentVoice: string | null;
  /** Cal.com booking page, e.g. https://cal.com/acme/30min. Required for book_meeting / either. */
  bookingUrl: string | null;
  /** The WhatsApp sent right after they agree to book; must contain {{bookingLink}}. */
  bookingMessage: string;
  maxCallbacks: number;
};

export const DEFAULT_BOOKING_MESSAGE =
  "Hi {{firstName}}, {{agentName}} here — thanks for the chat just now! Here's the link to pick a time that suits you: {{bookingLink}}";

export const DEFAULT_REACH_STEPS: AiCampaignStep[] = [
  { id: "call-1", kind: "call", delayHours: 0, instructions: "First call: introduce yourself and find out whether this is relevant to them." },
  { id: "call-2", kind: "call", delayHours: 24, instructions: "Second try: you called yesterday and could not reach them; mention it briefly." },
  {
    id: "message-1",
    kind: "message",
    delayHours: 2,
    body: "Hi {{firstName}}, this is {{agentName}} — I tried calling you about something that could help with your ads. Is there a good time to talk?",
  },
  { id: "call-3", kind: "call", delayHours: 48, instructions: "Last try: keep it short and respectful of their time." },
];

export const DEFAULT_CHASE_STEPS: AiCampaignStep[] = [
  {
    id: "chase-message-1",
    kind: "message",
    delayHours: 24,
    body: "Hi {{firstName}}, just a reminder — here's the link to pick a time: {{bookingLink}}",
  },
  {
    id: "chase-call-1",
    kind: "call",
    delayHours: 48,
    instructions: "They agreed to a meeting but have not booked it yet. Ask kindly whether the link worked, and offer to have the team call instead.",
  },
];

/** The rules the engine reads (Settings → WhatsApp → Sending rules); see src/lib/channels/rules.ts. */
export const CALLING_RULE_KEYS = ["callsPerDay", "callGapMinutes", "callingHours", "callWarmupDays"] as const;

/** Problems with a sequence, for the editor and the API (null = fine). */
export function aiCampaignStepsError(steps: unknown, options: { allowEmpty?: boolean } = {}): string | null {
  if (!Array.isArray(steps)) return "The sequence must be a list of steps";
  if (!steps.length) return options.allowEmpty ? null : "Add at least one step";
  if (steps.length > AI_CAMPAIGN_MAX_STEPS) return `At most ${AI_CAMPAIGN_MAX_STEPS} steps`;
  const ids = new Set<string>();
  for (const [index, raw] of steps.entries()) {
    const step = raw as { id?: unknown; kind?: unknown; delayHours?: unknown; instructions?: unknown; body?: unknown } | null;
    const where = `Step ${index + 1}`;
    if (!step || typeof step !== "object") return `${where} is not a step`;
    if (typeof step.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(step.id)) return `${where} has an invalid id`;
    if (ids.has(step.id)) return `${where} repeats an id`;
    ids.add(step.id);
    if (typeof step.delayHours !== "number" || !Number.isFinite(step.delayHours) || step.delayHours < 0 || step.delayHours > AI_CAMPAIGN_MAX_DELAY_HOURS) {
      return `${where}: the wait must be between 0 and ${AI_CAMPAIGN_MAX_DELAY_HOURS} hours`;
    }
    if (step.kind === "call") {
      if (typeof step.instructions !== "string" || step.instructions.length > AI_CAMPAIGN_MAX_INSTRUCTIONS_CHARS) {
        return `${where}: instructions must be at most ${AI_CAMPAIGN_MAX_INSTRUCTIONS_CHARS} characters`;
      }
    } else if (step.kind === "message") {
      if (typeof step.body !== "string" || !step.body.trim()) return `${where}: the message is empty`;
      if (step.body.length > AI_CAMPAIGN_MAX_MESSAGE_CHARS) return `${where}: the message is over ${AI_CAMPAIGN_MAX_MESSAGE_CHARS} characters`;
    } else {
      return `${where} must be a call or a message`;
    }
  }
  return null;
}
