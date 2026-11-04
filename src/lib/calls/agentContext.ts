import "server-only";

import type { AiInstructionBlock } from "@/lib/crm/ai/instructions";
import { loadCallingInstructions } from "@/lib/crm/aiSettings";
import { and, desc, eq, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "@/lib/whatsapp/schema";
import { AGENT_OUTCOME_LABELS, type AgentOutcome } from "./contract";
import type { AiCampaignGoal } from "./aiCampaigns/contract";
import { callCampaignContacts, callCampaigns, callSessions, type CallDirection } from "./schema";

/**
 * What the AI agent knows about this moment beyond its brief: the date and
 * time, who it has talked to before, and what the campaign it calls for is
 * trying to achieve. Built per call by loadAgentContext and rendered into the
 * instructions by liveAgent.ts (agentInstructions).
 */
export type AgentPromptContext = {
  /** "Tuesday, 27 October 2026, 14:35 (GMT+05:30) in Asia/Kolkata" */
  now?: string | null;
  /** The ready-made <history> section, or null for a stranger. */
  history?: string | null;
  /** Set for a call placed by an AI campaign; replaces the generic "Booking a next step". */
  goal?: { goal: AiCampaignGoal; bookingUrl: string | null } | null;
  /** The organization's calling instructions (Settings → Instructions → Calling); null = the defaults. */
  callingInstructions?: AiInstructionBlock[] | null;
  /** They called the station and the agent answered (src/lib/calls/incoming.ts). */
  inbound?: boolean;
};

const MAX_PREVIOUS_CALLS = 6;
const MAX_PREVIOUS_MESSAGES = 6;
const MESSAGE_CHARS = 200;
/** A past call's transcript summary, cut to keep the history short. */
const CALL_SUMMARY_CHARS = 400;

/** "Tuesday, 27 October 2026, 14:35 (GMT+05:30) in Asia/Kolkata", so the agent can turn "Thursday at 4" into an exact instant. */
export function formatNow(at: Date, timeZone: string): string {
  const zone = safeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  const offset =
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "longOffset" }).formatToParts(at).find((entry) => entry.type === "timeZoneName")?.value ?? "";
  return `${part("weekday")}, ${part("day")} ${part("month")} ${part("year")}, ${part("hour")}:${part("minute")}${offset ? ` (${offset})` : ""} in ${zone}`;
}

function safeZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

export type PreviousCall = {
  at: Date;
  status: string;
  outcome: AgentOutcome | null;
  /** Who rang whom (absent: we called them). */
  direction?: CallDirection;
  /** The name the agent used on it; null: a rep, or the default persona. */
  agentName?: string | null;
  /** The transcript's summary, for a call where the agent recorded no outcome summary. */
  summary?: string | null;
};
export type PreviousMessage = { at: Date; direction: "inbound" | "outbound"; body: string };

/** The <history> section, newest call first; null when there is nothing to say. */
export function formatHistory(calls: PreviousCall[], messages: PreviousMessage[], timeZone: string, inbound = false): string | null {
  if (!calls.length && !messages.length) return null;
  const zone = safeZone(timeZone);
  const day = (at: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", year: "numeric" }).format(at);
  const lines: string[] = [];
  if (calls.length) {
    lines.push("Earlier calls (newest first):");
    for (const call of calls.slice(0, MAX_PREVIOUS_CALLS)) {
      const pickedUp = call.status === "recorded";
      const who = call.direction === "inbound" ? "they called us" : "we called them";
      const as = call.agentName ? ` (you, as ${call.agentName})` : "";
      let line = `- ${day(call.at)}: ${who}${as}; ${pickedUp ? (call.direction === "inbound" ? "answered" : "they picked up") : "no answer"}`;
      if (call.outcome) {
        line += `; outcome: ${AGENT_OUTCOME_LABELS[call.outcome.outcome]}`;
        if (call.outcome.summary) line += ` — ${call.outcome.summary}`;
        if (call.outcome.when) line += ` (${call.outcome.when})`;
      }
      // What was said, when the agent left no summary of its own (e.g. it never recorded an outcome).
      if (pickedUp && !call.outcome?.summary && call.summary) line += ` — ${call.summary.replace(/\s+/g, " ").trim().slice(0, CALL_SUMMARY_CHARS)}`;
      lines.push(line);
    }
  }
  if (messages.length) {
    lines.push("Recent WhatsApp messages (oldest first):");
    for (const message of messages.slice(0, MAX_PREVIOUS_MESSAGES)) {
      const text = message.body.replace(/\s+/g, " ").trim();
      if (!text) continue;
      lines.push(`- ${day(message.at)}, ${message.direction === "inbound" ? "they wrote" : "we wrote"}: ${text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)} …` : text}`);
    }
  }
  const spoke = calls.some((call) => call.status === "recorded");
  return [
    "What happened with this person before:",
    "<history>",
    ...lines,
    "</history>",
    inbound
      ? spoke
        ? "They are calling you back after talking with you before: refer to what was said, and do not introduce yourself from scratch."
        : "They are calling you back, most likely after a missed call or a message from you: thank them, and carry on as a first conversation."
      : spoke
        ? "You have spoken with them before: do not introduce yourself from scratch. Say you are calling back or following up and refer to what was said."
        : "Earlier calls went unanswered: you may mention once that you tried before, briefly, and carry on as a first conversation.",
    "Use this to be natural, never to recite it.",
  ].join("\n");
}

/**
 * What the calling system will actually do after this call, by how it ends:
 * the only things the agent may offer. Facts, not style — how it proposes them
 * is the calling instructions'. It promised WhatsApp "details" nothing could
 * send, and a booking link a campaign without one never sent (4 Nov 2026).
 */
export function afterCallFacts(goal: AgentPromptContext["goal"]): string[] {
  const always = [
    "- A bad moment: the system calls them back at the time they give. Record call_back with whenAt; if they give no time, ask for a rough one.",
    "- They ask never to be contacted again: nobody contacts them again. Record do_not_contact.",
    "- You cannot see a calendar. A day or time they name is their preference: never say a meeting is confirmed or booked.",
    "- Nothing else is sent: no documents, decks, overviews or other messages. Never offer to send anything else.",
  ];
  if (!goal) {
    return [
      "What happens after this call (the only things you can offer):",
      "- They want to talk further: the team contacts them at the day and time you agree. Record meeting_booked or human_callback with whenAt.",
      ...always,
    ];
  }
  const link = goal.bookingUrl?.trim()
    ? "the system sends them a WhatsApp message right after the call with a link to pick a time. Record meeting_booked (with whenAt if they named a time)."
    : "the team contacts them to set it up (this campaign has no booking link to send). Record meeting_booked (with whenAt if they named a time).";
  const team = "a person from the team calls them at the day and time you agree. Record human_callback with whenAt.";
  return [
    "What happens after this call (the only things you can offer):",
    ...(goal.goal === "book_meeting"
      ? [`- They agree to a meeting with the team: ${link}`]
      : goal.goal === "human_callback"
        ? [`- They want to talk further: ${team}`]
        : [`- They agree to a meeting: ${link}`, `- They would rather have a call from the team: ${team}`]),
    ...always,
  ];
}

type SessionRow = { id: string; personId: string; campaignContactId: string | null; createdAt: Date; direction?: CallDirection };

/** The call's campaign goal, when its campaign contact belongs to an AI campaign. Runs in the organization's scope. */
export async function loadCampaignGoal(campaignContactId: string | null): Promise<AgentPromptContext["goal"]> {
  if (!campaignContactId) return null;
  const [campaign] = await db
    .select({ goal: callCampaigns.aiGoal, bookingUrl: callCampaigns.aiBookingUrl })
    .from(callCampaignContacts)
    .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
    .where(and(inOrg(callCampaigns), eq(callCampaignContacts.id, campaignContactId), eq(callCampaigns.runBy, "ai")))
    .limit(1);
  return campaign ? { goal: campaign.goal, bookingUrl: campaign.bookingUrl } : null;
}

/** The knowledge an AI campaign's call uses (null: the "always include" documents). Runs in the organization's scope. */
export async function loadCampaignKnowledgeIds(campaignContactId: string | null): Promise<string[] | null> {
  if (!campaignContactId) return null;
  const [campaign] = await db
    .select({ ids: callCampaigns.aiKnowledgeIds })
    .from(callCampaignContacts)
    .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
    .where(and(inOrg(callCampaigns), eq(callCampaignContacts.id, campaignContactId), eq(callCampaigns.runBy, "ai")))
    .limit(1);
  return campaign?.ids ?? null;
}

export async function organizationTimeZone(): Promise<string> {
  try {
    return (await channelRules("general")).timeZone ?? "UTC";
  } catch {
    return "UTC";
  }
}

/** Runs in the call's organization (withRecorderScope). */
export async function loadAgentContext(row: SessionRow): Promise<AgentPromptContext> {
  const timeZone = await organizationTimeZone();
  const [goal, callingInstructions, calls, messages] = await Promise.all([
    loadCampaignGoal(row.campaignContactId),
    loadCallingInstructions(),
    db
      .select({
        at: callSessions.createdAt,
        status: callSessions.status,
        outcome: callSessions.agentOutcome,
        direction: callSessions.direction,
        agentName: callSessions.agentName,
        summary: sql<string | null>`${callSessions.transcript}->>'summary'`,
      })
      .from(callSessions)
      .where(
        and(
          inOrg(callSessions),
          eq(callSessions.personId, row.personId),
          ne(callSessions.id, row.id),
          lt(callSessions.createdAt, row.createdAt),
          inArray(callSessions.status, ["recorded", "no_recording", "failed"]),
        ),
      )
      .orderBy(desc(callSessions.createdAt))
      .limit(MAX_PREVIOUS_CALLS),
    db
      .select({ at: whatsappMessages.sentAt, direction: whatsappMessages.direction, body: whatsappMessages.body })
      .from(whatsappMessages)
      .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
      .innerJoin(whatsappAccounts, eq(whatsappAccounts.id, whatsappChats.accountId))
      .where(and(inOrg(whatsappAccounts), eq(whatsappChats.personId, row.personId)))
      .orderBy(desc(whatsappMessages.sentAt))
      .limit(MAX_PREVIOUS_MESSAGES),
  ]);
  return {
    now: formatNow(new Date(), timeZone),
    history: formatHistory(calls, messages.reverse(), timeZone, row.direction === "inbound"),
    goal,
    callingInstructions,
    inbound: row.direction === "inbound",
  };
}

/** The context of a rehearsal: the date and the campaign's goal, no history (the lead is made up). */
export async function loadRehearsalContext(goal: AgentPromptContext["goal"]): Promise<AgentPromptContext> {
  const [timeZone, callingInstructions] = await Promise.all([organizationTimeZone(), loadCallingInstructions()]);
  return { now: formatNow(new Date(), timeZone), history: null, goal, callingInstructions };
}
