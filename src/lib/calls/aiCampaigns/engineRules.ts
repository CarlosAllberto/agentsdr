/**
 * The decisions of the AI calling campaign engine (engine.ts), kept pure so
 * they can be tested without a database, a worker or a call: what a lead's
 * next action is, what a finished call or message makes of them, how many
 * calls a number may place today, and the Cal.com pieces (booking link,
 * webhook signature and payload).
 *
 * Planning never checks hours: a decision only makes the next step
 * *eligible* from ai_next_at; the engine checks the number's calling hours,
 * gap and daily limit when it acts.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { WeeklyHours } from "@/lib/channels/rules";
import { isWithinWorkingHours, mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
import type { AgentOutcome, CallStatus } from "../contract";
import {
  AI_OPEN_STATUSES,
  type AiCallResult,
  type AiCampaignGoal,
  type AiCampaignStep,
  type AiContactStatus,
  type AiStepRunKind,
} from "./contract";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A next step is never due sooner than this after the last one settled. */
export const MIN_STEP_GAP_MS = 10 * MINUTE_MS;
/** A worker error: try the same step again after this. */
export const ERROR_RETRY_MS = 30 * MINUTE_MS;
/** Errors at one step after which the lead is failed for a person to look at. */
export const MAX_STEP_FAILURES = 3;
/** An unanswered call-back is tried again after this. */
export const CALLBACK_RETRY_MS = 24 * HOUR_MS;
/** A call-back they asked for with no time given. */
export const CALLBACK_DEFAULT_MS = 24 * HOUR_MS;
/** A call-back is never sooner than this. */
export const CALLBACK_MIN_MS = 15 * MINUTE_MS;
/** A recorded call without the agent's outcome yet: the outcome POST may still be on its way. */
export const OUTCOME_GRACE_MS = 90_000;
/** After the last chase message, how long they get to book before a person takes over. */
export const CHASE_GRACE_MS = 24 * HOUR_MS;
/**
 * A lead who said yes reaches Action required this long after the booking
 * link went out (or after they cancel) unless they book, whether or not the
 * chase is still running: a person can nudge while it is warm.
 */
export const BOOKING_REVIEW_MS = 24 * HOUR_MS;
/** A booked meeting reaches Action required this long before it starts, to prepare. */
export const MEETING_PREP_MS = 24 * HOUR_MS;
/** Warm-up: calls a day in a number's first week, then this much more each week. */
export const WARMUP_CALLS_PER_WEEK = 10;

export function isOpenAiStatus(status: AiContactStatus | null | undefined): boolean {
  return status != null && (AI_OPEN_STATUSES as readonly string[]).includes(status);
}

// --- what the engine knows -----------------------------------------------------

export type AiEngineCampaign = {
  goal: AiCampaignGoal;
  bookingUrl: string | null;
  maxCallbacks: number;
  steps: readonly AiCampaignStep[];
  chaseSteps: readonly AiCampaignStep[];
};

export type AiEngineContact = {
  status: AiContactStatus;
  /** The next step of the sequence its status runs; in `callback`, the reach step to go back to. */
  step: number;
  callbacks: number;
  failures: number;
  /** The booking link went out (a step run `booking-link` exists): they said yes once. */
  bookingLinkSent: boolean;
  /** While chasing: when it reaches Action required unless they book (BOOKING_REVIEW_MS). */
  reviewAt: Date | null;
};

/** What happens to a lead; the engine writes it onto call_campaign_contacts and runs the side effects. */
export type AiDecision = {
  status: AiContactStatus;
  step: number;
  /** When the next step becomes eligible; null for no next step (or one the engine starts itself). */
  nextAt: Date | null;
  callbacks: number;
  failures: number;
  /** Shown on the list. Undefined: leave the note as it is. */
  note?: string | null;
  /** A person takes it from here: follow-up on the CRM record, due then. */
  handoff?: { followUpAt: Date };
  /** Chasing: when a person sees it in Action required if they still have not booked. The chase goes on meanwhile. */
  reviewAt?: Date | null;
  /** They asked not to be contacted: set Do Not Contact on the Person. */
  doNotContact?: boolean;
  /** Send the booking link now (step key `booking-link`). */
  sendBookingLink?: boolean;
};

// --- step keys -----------------------------------------------------------------

export const BOOKING_LINK_KEY = "booking-link";
export const reachKey = (step: AiCampaignStep) => `reach:${step.id}`;
export const chaseKey = (step: AiCampaignStep) => `chase:${step.id}`;
export const callbackKey = (n: number) => `callback:${n}`;
export const retryKey = (key: string, attempt: number) => `retry:${key}:${attempt}`;

export type AiStepPurpose = "reach" | "chase" | "callback";

export type AiPlannedAction =
  | {
      kind: AiStepRunKind;
      stepKey: string;
      purpose: AiStepPurpose;
      /** The campaign step it runs; null for a call-back. */
      step: AiCampaignStep | null;
    }
  /** Nothing left to run (the sequence was shortened since): settle the lead as this. */
  | { kind: "none"; decision: AiDecision };

/** The action an open lead's next step takes, with its claim key. */
export function plannedAction(contact: AiEngineContact, campaign: AiEngineCampaign, now: Date): AiPlannedAction {
  const withRetry = (key: string) => (contact.failures > 0 ? retryKey(key, contact.failures) : key);
  switch (contact.status) {
    case "callback":
      return { kind: "call", stepKey: withRetry(callbackKey(Math.max(1, contact.callbacks))), purpose: "callback", step: null };
    case "chasing": {
      const step = campaign.chaseSteps[contact.step];
      if (!step) return { kind: "none", decision: handoff(contact, now, "The follow-ups ran out before they booked") };
      return { kind: step.kind, stepKey: withRetry(chaseKey(step)), purpose: "chase", step };
    }
    default: {
      const step = campaign.steps[contact.step];
      if (!step) return { kind: "none", decision: settled(contact, "unreached", "The sequence ran out without a conversation") };
      return { kind: step.kind, stepKey: withRetry(reachKey(step)), purpose: "reach", step };
    }
  }
}

// --- decisions -----------------------------------------------------------------

function settled(contact: AiEngineContact, status: AiContactStatus, note?: string | null): AiDecision {
  return { status, step: contact.step, nextAt: null, callbacks: contact.callbacks, failures: 0, ...(note !== undefined ? { note } : {}) };
}

function handoff(contact: AiEngineContact, followUpAt: Date, note?: string | null): AiDecision {
  return { ...settled(contact, "handoff", note), handoff: { followUpAt } };
}

function dueAfter(step: AiCampaignStep, from: Date): Date {
  return new Date(from.getTime() + Math.max(MIN_STEP_GAP_MS, Math.max(0, step.delayHours) * HOUR_MS));
}

/** Step `index` of a sequence, due its delay after `from`; null when there is none. */
function stepAt(contact: AiEngineContact, status: "reaching" | "chasing", steps: readonly AiCampaignStep[], index: number, from: Date): AiDecision | null {
  const step = steps[index];
  if (!step) return null;
  return {
    status,
    step: index,
    nextAt: dueAfter(step, from),
    callbacks: contact.callbacks,
    failures: 0,
    note: null,
    ...(status === "chasing" ? { reviewAt: contact.reviewAt ?? new Date(from.getTime() + BOOKING_REVIEW_MS) } : {}),
  };
}

/** Where an unanswered step (or a sent message) leaves them: the next step of their sequence. */
function advance(contact: AiEngineContact, campaign: AiEngineCampaign, now: Date, ranMessage: boolean): AiDecision {
  if (contact.status === "chasing") {
    return (
      stepAt(contact, "chasing", campaign.chaseSteps, contact.step + 1, now) ??
      // After a last message they get a day to book from it; after an unanswered call a person takes over now.
      handoff(contact, ranMessage ? new Date(now.getTime() + CHASE_GRACE_MS) : now, "Said yes, but has not booked")
    );
  }
  return stepAt(contact, "reaching", campaign.steps, contact.step + 1, now) ?? settled(contact, "unreached", "The sequence ran out without a conversation");
}

/** A worker error: the same step again in a while, or failed after MAX_STEP_FAILURES. */
function afterError(contact: AiEngineContact, now: Date, error: string | null): AiDecision {
  const failures = contact.failures + 1;
  const message = error?.trim() || "The step could not be run";
  if (failures >= MAX_STEP_FAILURES) {
    return { ...settled(contact, "failed", `Failed ${failures} times: ${message}`), failures };
  }
  return {
    status: contact.status === "queued" ? "reaching" : contact.status,
    step: contact.step,
    nextAt: new Date(now.getTime() + ERROR_RETRY_MS),
    callbacks: contact.callbacks,
    failures,
    note: message,
    ...(contact.status === "chasing" ? { reviewAt: contact.reviewAt } : {}),
  };
}

/** An exact time out of the agent's outcome, or null. */
export function outcomeTime(outcome: AgentOutcome | null): Date | null {
  if (!outcome?.whenAt) return null;
  const time = Date.parse(outcome.whenAt);
  return Number.isFinite(time) ? new Date(time) : null;
}

/** The step to go back to after call-backs: where the reach sequence left off. */
function returnStep(contact: AiEngineContact): number {
  return contact.status === "callback" ? contact.step : contact.step + 1;
}

/**
 * Where a lead stands once a call settles. `result` is what the call
 * amounted to (callResultFor); `outcome` is the agent's record_outcome.
 */
export function afterCall(
  contact: AiEngineContact,
  result: AiCallResult,
  outcome: AgentOutcome | null,
  campaign: AiEngineCampaign,
  now: Date,
  error: string | null = null,
): AiDecision {
  if (result === "error") return afterError(contact, now, error);
  if (result === "not_on_whatsapp") return settled(contact, "failed", "Not on WhatsApp");

  const kind = result === "conversation" ? outcome?.outcome ?? null : "no_response";
  if (kind === "no_response") {
    if (contact.status === "callback") {
      if (contact.callbacks < campaign.maxCallbacks) {
        return {
          status: "callback",
          step: contact.step,
          nextAt: new Date(now.getTime() + CALLBACK_RETRY_MS),
          callbacks: contact.callbacks + 1,
          failures: 0,
          note: "Did not pick up the call-back; trying again tomorrow",
        };
      }
      if (contact.bookingLinkSent) return handoff(contact, now, "Did not pick up the call-backs");
      return (
        stepAt(contact, "reaching", campaign.steps, contact.step, now) ??
        settled(contact, "unreached", "Did not pick up the call-backs")
      );
    }
    return advance(contact, campaign, now, false);
  }

  const when = outcomeTime(outcome);
  switch (kind) {
    case "meeting_booked":
    case "interested": {
      // They had the link already: keep chasing (a call-back during the chase returns to its step).
      if (contact.status === "chasing") return advance(contact, campaign, now, false);
      if (contact.bookingLinkSent) {
        return stepAt(contact, "chasing", campaign.chaseSteps, contact.step, now) ?? handoff(contact, now, "Said yes, but has not booked");
      }
      if (campaign.goal === "human_callback") return handoff(contact, when ?? now, "Interested: wants to talk to the team");
      if (!campaign.bookingUrl) return handoff(contact, when ?? now, "Agreed to a meeting; the campaign has no booking link to send");
      return {
        status: "chasing",
        step: 0,
        nextAt: null,
        callbacks: contact.callbacks,
        failures: 0,
        note: "Agreed to a meeting; sending the booking link",
        reviewAt: new Date(now.getTime() + BOOKING_REVIEW_MS),
        sendBookingLink: true,
      };
    }
    case "human_callback":
      return handoff(contact, when ?? now, "Wants a call from the team");
    case "call_back": {
      if (contact.callbacks >= campaign.maxCallbacks) return handoff(contact, when ?? now, "Asked to be called back again");
      const asked = when ?? new Date(now.getTime() + CALLBACK_DEFAULT_MS);
      const nextAt = new Date(Math.max(asked.getTime(), now.getTime() + CALLBACK_MIN_MS));
      return {
        status: "callback",
        step: returnStep(contact),
        nextAt,
        callbacks: contact.callbacks + 1,
        failures: 0,
        note: outcome?.when ? `Call back: ${outcome.when}` : "Asked to be called back",
      };
    }
    case "not_interested":
      return settled(contact, "not_interested", outcome?.summary ?? null);
    case "wrong_person":
      return settled(contact, "stopped", "Wrong person");
    case "do_not_contact":
      return { ...settled(contact, "stopped", "Asked not to be contacted"), doNotContact: true };
    default:
      // "other", or the agent recorded nothing: a person should hear how it went.
      return handoff(contact, now, outcome?.summary ?? "The call needs a person to review it");
  }
}

/**
 * Where a lead stands once a message settles. `bookingLink`: it was the
 * booking link sent after they said yes (the lead is already `chasing` at 0).
 */
export function afterMessage(
  contact: AiEngineContact,
  sent: boolean,
  campaign: AiEngineCampaign,
  now: Date,
  options: { bookingLink?: boolean; error?: string | null } = {},
): AiDecision {
  if (options.bookingLink) {
    if (!sent) return handoff(contact, now, `The booking link could not be sent: ${options.error?.trim() || "unknown error"}`);
    const first = campaign.chaseSteps[0];
    if (!first) return handoff(contact, new Date(now.getTime() + CHASE_GRACE_MS), "Booking link sent; no follow-ups set");
    return {
      status: "chasing",
      step: 0,
      nextAt: dueAfter(first, now),
      callbacks: contact.callbacks,
      failures: 0,
      note: "Booking link sent",
      reviewAt: contact.reviewAt ?? new Date(now.getTime() + BOOKING_REVIEW_MS),
    };
  }
  if (!sent) return afterError(contact, now, options.error ?? null);
  return advance(contact, campaign, now, true);
}

/** Starting a step moves a queued lead into the reach sequence. */
export function statusWhenStarted(status: AiContactStatus): AiContactStatus {
  return status === "queued" ? "reaching" : status;
}

/** When a booked meeting reaches Action required: a day before it, or now if it is sooner. */
export function meetingPrepAt(startTime: Date | null, now: Date): Date {
  if (!startTime) return now;
  return new Date(Math.max(now.getTime(), startTime.getTime() - MEETING_PREP_MS));
}

// --- what a finished call amounted to ----------------------------------------------

export type SettledCall = {
  status: CallStatus;
  error: string | null;
  agentOutcome: AgentOutcome | null;
  endedAt: Date | null;
  updatedAt: Date;
};

/**
 * "wait" while the call is still open, or recorded but its outcome may still
 * be on its way. Mirrors contactCallStatusForCall: the extension reports
 * "isn't on WhatsApp" as a failed call, and an upload that failed after the
 * lead picked up still means they spoke.
 */
export function callResultFor(call: SettledCall, now: Date): AiCallResult | "wait" {
  switch (call.status) {
    case "pending":
    case "in_progress":
      return "wait";
    case "recorded": {
      if (call.agentOutcome?.outcome === "no_response") return "no_answer";
      if (call.agentOutcome) return "conversation";
      const ended = (call.endedAt ?? call.updatedAt).getTime();
      return now.getTime() - ended < OUTCOME_GRACE_MS ? "wait" : "conversation";
    }
    case "no_recording":
      return "no_answer";
    case "failed":
      if (call.error && /isn't on WhatsApp/i.test(call.error)) return "not_on_whatsapp";
      if (call.error && /^Upload failed/i.test(call.error)) return call.agentOutcome?.outcome === "no_response" ? "no_answer" : "conversation";
      return "error";
  }
}

// --- the number's day ------------------------------------------------------------

/** True inside the calling hours. */
export function withinCallingHours(hours: WeeklyHours, now: Date): boolean {
  return isWithinWorkingHours(mailboxHoursFromWeekly(hours), now);
}

/**
 * Calls a number may place today: its own limit or the organization's, and
 * during warm-up (callWarmupDays after its first AI call, or before it)
 * WARMUP_CALLS_PER_WEEK × the week it is in.
 */
export function dailyCallLimit(input: {
  stationLimit: number | null;
  ruleLimit: number;
  warmupDays: number;
  automationStartedAt: Date | null;
  now: Date;
}): number {
  const limit = input.stationLimit ?? input.ruleLimit;
  if (input.warmupDays <= 0) return limit;
  const daysSince = input.automationStartedAt ? Math.max(0, Math.floor((input.now.getTime() - input.automationStartedAt.getTime()) / DAY_MS)) : 0;
  if (input.automationStartedAt && daysSince >= input.warmupDays) return limit;
  return Math.min(limit, WARMUP_CALLS_PER_WEEK * (Math.floor(daysSince / 7) + 1));
}

// --- Cal.com -----------------------------------------------------------------------

/**
 * The metadata key a booking link carries (`metadata[c]=k7p2`): the lead's
 * booking code (call_campaign_contacts.ai_booking_code), so the booking names
 * its lead. One letter and a short code keep the link short, and the link
 * carries nothing else about the person: it may be forwarded.
 */
export const CALCOM_BOOKING_METADATA = "c";
/** Links sent before the booking code carried the contact's UUID under this key; their bookings still match. */
export const LEGACY_CALCOM_CONTACT_METADATA = "agentsdrContact";

/** Booking codes: lowercase letters and digits without look-alikes (0/o, 1/l/i). */
export const BOOKING_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const BOOKING_CODE_LENGTH = 4;
const BOOKING_CODE_PATTERN = /^[a-z0-9]{3,12}$/;

/** A random booking code of `length` characters (`random` for the tests). */
export function newBookingCode(length = BOOKING_CODE_LENGTH, random: () => number = Math.random): string {
  let code = "";
  for (let i = 0; i < length; i += 1) code += BOOKING_CODE_ALPHABET[Math.floor(random() * BOOKING_CODE_ALPHABET.length)];
  return code;
}

/**
 * The campaign's booking page with the lead's booking code in the booking's
 * metadata (Cal.com: `metadata[key]=value`). Null if the URL is not http(s).
 */
export function bookingLinkFor(bookingUrl: string, bookingCode: string): string | null {
  let url: URL;
  try {
    url = new URL(bookingUrl.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  url.searchParams.set(`metadata[${CALCOM_BOOKING_METADATA}]`, bookingCode);
  // Cal.com reads the brackets either way; unescaped they read better in a WhatsApp message.
  return url.toString().replace(/metadata%5B([A-Za-z]+)%5D=/g, "metadata[$1]=");
}

/** x-cal-signature-256: the hex HMAC-SHA256 of the raw body with the webhook's secret. */
export function calcomSignatureValid(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !secret) return false;
  const given = signature.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

export type CalcomBookingEvent = {
  kind: "booked" | "cancelled";
  /** Cal.com's booking uid. */
  uid: string | null;
  startTime: Date | null;
  /** The lead's booking code from the link's metadata. */
  bookingCode: string | null;
  /** The lead's call_campaign_contacts id, from a link sent before booking codes. */
  contactId: string | null;
  emails: string[];
  phones: string[];
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  // Cal.com's `responses` hold { label, value } objects.
  const inner = record(value)?.value;
  return typeof inner === "string" && inner.trim() ? inner.trim() : null;
}

/**
 * The parts of a Cal.com webhook delivery the engine acts on; null for an
 * event it ignores (anything but booking created / rescheduled / cancelled).
 */
export function parseCalcomEvent(body: unknown): CalcomBookingEvent | null {
  const root = record(body);
  if (!root) return null;
  const trigger = typeof root.triggerEvent === "string" ? root.triggerEvent : "";
  const kind = trigger === "BOOKING_CREATED" || trigger === "BOOKING_RESCHEDULED" ? "booked" : trigger === "BOOKING_CANCELLED" ? "cancelled" : null;
  if (!kind) return null;
  const payload = record(root.payload) ?? {};
  const metadata = record(payload.metadata) ?? {};
  const responses = record(payload.responses) ?? {};
  const attendees = Array.isArray(payload.attendees) ? payload.attendees.map(record).filter((a): a is Record<string, unknown> => a !== null) : [];

  const code = text(metadata[CALCOM_BOOKING_METADATA])?.toLowerCase() ?? null;
  const contact = text(metadata[LEGACY_CALCOM_CONTACT_METADATA]);
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const value of [responses.email, ...attendees.map((a) => a.email)]) {
    const email = text(value);
    if (email && email.includes("@")) emails.add(email.toLowerCase());
  }
  for (const value of [responses.attendeePhoneNumber, payload.smsReminderNumber, ...attendees.map((a) => a.phoneNumber)]) {
    const phone = text(value);
    if (phone) phones.add(phone);
  }
  const start = text(payload.startTime);
  const startMs = start ? Date.parse(start) : NaN;
  return {
    kind,
    uid: text(payload.uid),
    startTime: Number.isFinite(startMs) ? new Date(startMs) : null,
    bookingCode: code && BOOKING_CODE_PATTERN.test(code) ? code : null,
    contactId: contact && UUID_PATTERN.test(contact) ? contact : null,
    emails: [...emails],
    phones: [...phones],
  };
}
