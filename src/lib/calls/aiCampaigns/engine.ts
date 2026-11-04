import "server-only";

/**
 * The AI calling campaign engine. Each tick, per organization with a live AI
 * campaign (run_by 'ai', active, launched, not archived) or a step still
 * open, in that organization's scope:
 *
 *   1. close calls that never reported back (expireStaleCalls);
 *   2. settle open step runs — a call once its call_session is over, a
 *      message once its station_message_jobs row is sent or failed — and
 *      apply the pure decision (engineRules.ts) to the lead;
 *   3. act: every calling number assigned to a live campaign that is
 *      active, held open by a call worker (lease), idle, inside its calling
 *      hours, past its gap and under today's limit takes ONE action — the
 *      most urgent due lead's next step (a call through startCall, or a
 *      WhatsApp through queueStationMessage).
 *
 * Safety: a step is claimed by inserting its call_campaign_step_runs row
 * (unique per lead and step key) before anything happens, and the number is
 * reserved by moving its next_call_at in the same transaction, so a crash or
 * a second instance during a deploy never repeats a step or doubles up a
 * number. Spec: aiCampaigns/contract.ts; the decisions: engineRules.ts.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { pickInRange } from "@/lib/channels/rules";
import { isPersonDoNotContact, setPersonDoNotContactInTransaction } from "@/lib/crm/policies";
import { withCrmTransaction } from "@/lib/crm/repository";
import { companies, people } from "@/lib/leads/schema";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { latestDailySlot } from "@/lib/scheduler/slots";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { campaignLeadVariables, renderCampaignStep } from "@/lib/whatsapp/campaigns/render";
import { queueStationMessage } from "@/lib/whatsapp/stationMessaging";
import { DEFAULT_AGENT_NAME } from "../contract";
import { syncCallFollowUpSafely } from "../crmFollowUp";
import { callCampaignContacts, callCampaigns, callCampaignStations, callCampaignStepRuns, callSessions, callingStations, stationMessageJobs } from "../schema";
import { CallApiError, expireStaleCalls, startCall } from "../sessions";
import { agentBrief } from "./brief.server";
import { AI_OPEN_STATUSES, DEFAULT_BOOKING_MESSAGE, isOffSequenceCallKey, type AiCallResult } from "./contract";
import {
  afterCall,
  afterMessage,
  BOOKING_LINK_KEY,
  bookingLinkFor,
  callResultFor,
  dailyCallLimit,
  isOpenAiStatus,
  plannedAction,
  statusWhenStarted,
  withinCallingHours,
  type AiDecision,
  type AiEngineCampaign,
  type AiEngineContact,
} from "./engineRules";

export type AiCallingTickResult = {
  organizations: number;
  settled: number;
  calls: number;
  messages: number;
  failed: number;
};

type CampaignRow = typeof callCampaigns.$inferSelect;
type ContactRow = typeof callCampaignContacts.$inferSelect;
type StationRow = typeof callingStations.$inferSelect;
type RunRow = typeof callCampaignStepRuns.$inferSelect;

/** A step started this long ago with no call or message recorded on it crashed mid-start. */
const STARTING_STALE_MS = 5 * 60_000;
/** A message whose queue entry cannot be found after this long is given up. */
const MESSAGE_JOB_MISSING_MS = 24 * 60 * 60_000;
/** After a message, the number waits this long before its next action. */
const MESSAGE_GAP_MS = 60_000;
/** Open step runs settled per organization per tick. */
const MAX_SETTLES = 200;
/** Leads examined for one number in one tick before giving up on it. */
const MAX_PICKS_PER_STATION = 20;

// --- the tick -----------------------------------------------------------------------

export async function runAiCallingTick(options: { now?: Date } = {}): Promise<AiCallingTickResult> {
  const result: AiCallingTickResult = { organizations: 0, settled: 0, calls: 0, messages: 0, failed: 0 };
  // Paused: nothing is placed, sent or settled (settling can send a booking link); it all catches up after.
  if (isMigrationControlPaused("aiCalling")) return result;
  const now = options.now ?? new Date();
  for (const organizationId of await aiCallingOrganizationIds()) {
    try {
      await runInOrganization(organizationId, () => tickOrganization(result, now));
      result.organizations += 1;
    } catch (error) {
      console.error(`[calls/aiCampaigns] organization ${organizationId} tick failed:`, error);
      result.failed += 1;
    }
  }
  return result;
}

/**
 * Organizations with a live AI campaign, or a step still open in any AI
 * campaign (a paused one's calls still settle). A platform-level
 * enumeration; each organization then runs in its own scope.
 */
export async function aiCallingOrganizationIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ organizationId: callCampaigns.organizationId })
    .from(callCampaigns)
    .where(and(
      eq(callCampaigns.runBy, "ai"),
      or(
        and(isNotNull(callCampaigns.aiLaunchedAt), eq(callCampaigns.status, "active"), isNull(callCampaigns.archivedAt)),
        // Launched or not: a lead's call-back opens a step run too (src/lib/calls/incoming.ts).
        sql`exists (select 1 from ${callCampaignContacts} c join ${callCampaignStepRuns} r on r.contact_id = c.id
                     where c.campaign_id = ${callCampaigns.id} and r.status = 'started')`,
      ),
    ));
  return rows.map((row) => row.organizationId);
}

async function tickOrganization(result: AiCallingTickResult, now: Date): Promise<void> {
  await expireStaleCalls();
  await settleOpenRuns(result, new Date());
  await act(result, now);
}

// --- shared helpers -------------------------------------------------------------------

/** call_campaign_contacts belongs to its campaign's organization. */
function contactInScope() {
  return inArray(callCampaignContacts.campaignId, db.select({ id: callCampaigns.id }).from(callCampaigns).where(inOrg(callCampaigns)));
}

function liveAiCampaign() {
  return and(
    inOrg(callCampaigns),
    eq(callCampaigns.runBy, "ai"),
    eq(callCampaigns.status, "active"),
    isNotNull(callCampaigns.aiLaunchedAt),
    isNull(callCampaigns.archivedAt),
  );
}

function engineCampaign(campaign: CampaignRow): AiEngineCampaign {
  return {
    goal: campaign.aiGoal,
    bookingUrl: campaign.aiBookingUrl?.trim() || null,
    maxCallbacks: campaign.aiMaxCallbacks,
    steps: campaign.aiSteps ?? [],
    chaseSteps: campaign.aiChaseSteps ?? [],
  };
}

async function bookingLinkSent(contactId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: callCampaignStepRuns.id })
    .from(callCampaignStepRuns)
    .where(and(eq(callCampaignStepRuns.contactId, contactId), eq(callCampaignStepRuns.stepKey, BOOKING_LINK_KEY)))
    .limit(1);
  return !!row;
}

function engineContact(contact: ContactRow, linkSent: boolean): AiEngineContact {
  return {
    status: contact.aiStatus ?? "queued",
    step: contact.aiStep,
    callbacks: contact.aiCallbacks,
    failures: contact.aiFailures,
    bookingLinkSent: linkSent,
  };
}

/**
 * Writes a decision onto the lead, only while it is still open (a reply, a
 * booking or a person's stop that landed meanwhile wins). The calling
 * campaign's own stage and follow-up follow it: a hand-off is a follow-up
 * for a person (the CRM's Action required, once synced), an open lead is
 * still to call, anything else is done.
 */
async function writeDecision(executor: Pick<typeof db, "update">, contactId: string, decision: AiDecision, now: Date): Promise<boolean> {
  const open = isOpenAiStatus(decision.status);
  const rows = await executor
    .update(callCampaignContacts)
    .set({
      aiStatus: decision.status,
      aiStep: decision.step,
      aiNextAt: decision.nextAt,
      aiCallbacks: decision.callbacks,
      aiFailures: decision.failures,
      ...(decision.note !== undefined ? { aiNote: decision.note } : {}),
      stage: decision.handoff ? "follow_up" : open ? "to_call" : "done",
      followUpAt: decision.handoff?.followUpAt ?? null,
      updatedAt: now,
    })
    .where(and(contactInScope(), eq(callCampaignContacts.id, contactId), inArray(callCampaignContacts.aiStatus, [...AI_OPEN_STATUSES])))
    .returning({ id: callCampaignContacts.id });
  return rows.length > 0;
}

async function setDoNotContact(personId: string): Promise<void> {
  try {
    await withCrmTransaction((tx) =>
      setPersonDoNotContactInTransaction(tx, {
        personId,
        reason: "Asked on an AI campaign call not to be contacted",
        source: "inbound_request",
        actorType: "ai",
        actorRef: "ai-calling-campaign",
      }),
    );
  } catch (error) {
    console.error("[calls/aiCampaigns] setting Do Not Contact failed", personId, error);
  }
}

// --- 2. settle -------------------------------------------------------------------------

type OpenRun = {
  run: RunRow;
  contact: ContactRow;
  campaign: CampaignRow;
  call: {
    id: string;
    status: (typeof callSessions.$inferSelect)["status"];
    error: string | null;
    agentOutcome: (typeof callSessions.$inferSelect)["agentOutcome"];
    endedAt: Date | null;
    updatedAt: Date;
    claimedAt: Date | null;
    phone: string;
  } | null;
  job: { status: (typeof stationMessageJobs.$inferSelect)["status"]; error: string | null; sentAt: Date | null } | null;
};

/** The organization's started step runs, with their lead, campaign, call and message job. */
export function loadOpenRuns(): Promise<OpenRun[]> {
  return db
    .select({
      run: callCampaignStepRuns,
      contact: callCampaignContacts,
      campaign: callCampaigns,
      call: {
        id: callSessions.id,
        status: callSessions.status,
        error: callSessions.error,
        agentOutcome: callSessions.agentOutcome,
        endedAt: callSessions.endedAt,
        updatedAt: callSessions.updatedAt,
        claimedAt: callSessions.claimedAt,
        phone: callSessions.phone,
      },
      job: { status: stationMessageJobs.status, error: stationMessageJobs.error, sentAt: stationMessageJobs.sentAt },
    })
    .from(callCampaignStepRuns)
    .innerJoin(callCampaignContacts, eq(callCampaignContacts.id, callCampaignStepRuns.contactId))
    .innerJoin(callCampaigns, and(eq(callCampaigns.id, callCampaignContacts.campaignId), inOrg(callCampaigns)))
    .leftJoin(callSessions, and(eq(callSessions.id, callCampaignStepRuns.callSessionId), inOrg(callSessions)))
    .leftJoin(stationMessageJobs, and(eq(stationMessageJobs.whatsappMessageId, callCampaignStepRuns.whatsappMessageId), inOrg(stationMessageJobs)))
    .where(eq(callCampaignStepRuns.status, "started"))
    .orderBy(asc(callCampaignStepRuns.createdAt))
    .limit(MAX_SETTLES);
}

async function settleOpenRuns(result: AiCallingTickResult, now: Date): Promise<void> {
  for (const row of await loadOpenRuns()) {
    try {
      const settled = row.run.kind === "call" ? await settleCall(row, now) : await settleMessage(row, now);
      if (settled) result.settled += 1;
    } catch (error) {
      console.error(`[calls/aiCampaigns] settling step ${row.run.id} failed:`, error);
      result.failed += 1;
    }
  }
}

/**
 * Finishes the run and applies the decision to the lead in one transaction,
 * so a lead never stays behind a finished step. Returns null when another
 * instance settled the run first, else whether the lead was still open.
 */
async function finishRun(
  row: OpenRun,
  finish: { status: "done" | "failed"; result: AiCallResult | null; error: string | null },
  /** Null: the run finishes and the lead stays as it is. */
  decide: (contact: AiEngineContact) => AiDecision | null,
  now: Date,
): Promise<{ decision: AiDecision | null } | null> {
  const linkSent = await bookingLinkSent(row.contact.id);
  return db.transaction(async (tx) => {
    const [contact] = await tx
      .select()
      .from(callCampaignContacts)
      .where(and(contactInScope(), eq(callCampaignContacts.id, row.contact.id)))
      .for("update");
    const [finished] = await tx
      .update(callCampaignStepRuns)
      .set({ status: finish.status, result: finish.result, error: finish.error?.slice(0, 1000) ?? null, finishedAt: now })
      .where(and(eq(callCampaignStepRuns.id, row.run.id), eq(callCampaignStepRuns.status, "started")))
      .returning({ id: callCampaignStepRuns.id });
    if (!finished) return null;
    if (!contact || !isOpenAiStatus(contact.aiStatus)) return { decision: null };
    const decision = decide(engineContact(contact, linkSent));
    if (!decision) return { decision: null };
    const applied = await writeDecision(tx, contact.id, decision, now);
    return { decision: applied ? decision : null };
  });
}

async function settleCall(row: OpenRun, now: Date): Promise<boolean> {
  const { run, contact, campaign, call } = row;
  if (!run.callSessionId || !call) {
    if (now.getTime() - run.createdAt.getTime() < STARTING_STALE_MS) return false;
    // Started, then crashed before the call id was stored: find the call it placed, if any.
    const [placed] = await db
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(inOrg(callSessions), eq(callSessions.campaignContactId, contact.id), gte(callSessions.createdAt, new Date(run.createdAt.getTime() - 1000))))
      .orderBy(asc(callSessions.createdAt))
      .limit(1);
    if (placed && placed.id !== run.callSessionId) {
      await db.update(callCampaignStepRuns).set({ callSessionId: placed.id }).where(eq(callCampaignStepRuns.id, run.id));
      return false;
    }
    const error = run.callSessionId ? "The call's record is gone" : "The call was never placed";
    const settled = await finishRun(row, { status: "failed", result: "error", error }, (state) => afterCall(state, "error", null, engineCampaign(campaign), now, error), now);
    return settled !== null;
  }

  const result = callResultFor(call, now);
  if (result === "wait") {
    // The lead stopped (a reply, a booking) while its call still waits for a worker: do not place it.
    if (!isOpenAiStatus(contact.aiStatus) && call.status === "pending" && !call.claimedAt) {
      await db
        .update(callSessions)
        .set({ status: "no_recording", error: `Cancelled before it was placed: the lead is ${contact.aiStatus ?? "no longer in the campaign"}`, endedAt: now, updatedAt: now })
        .where(and(inOrg(callSessions), eq(callSessions.id, call.id), eq(callSessions.status, "pending"), isNull(callSessions.claimedAt)));
    }
    return false;
  }

  const outcome = call.agentOutcome ?? null;
  // They called us back (src/lib/calls/incoming.ts), or someone pressed AI call on the lead:
  // only a conversation moves the lead — a ring that never connected is not one of the sequence's attempts.
  const inbound = isOffSequenceCallKey(run.stepKey);
  const settled = await finishRun(
    row,
    { status: result === "error" ? "failed" : "done", result, error: call.error },
    (state) => (inbound && result !== "conversation" ? null : afterCall(state, result, outcome, engineCampaign(campaign), now, call.error)),
    now,
  );
  if (!settled) return false;

  // A fact about the person whatever the lead's status now.
  if (result === "conversation" && outcome?.outcome === "do_not_contact") await setDoNotContact(contact.personId);
  // Always: the call's own finish (applyCallResultToContact) may have moved the follow-up.
  await syncCallFollowUpSafely(contact.personId);
  if (settled.decision?.sendBookingLink) {
    await sendBookingLink(contact, campaign, run.stationId, call.phone, now);
  }
  return true;
}

async function settleMessage(row: OpenRun, now: Date): Promise<boolean> {
  const { run, contact, campaign, job } = row;
  const bookingLink = run.stepKey === BOOKING_LINK_KEY;
  const age = now.getTime() - run.createdAt.getTime();

  let settled: Awaited<ReturnType<typeof finishRun>>;
  if (!run.whatsappMessageId) {
    if (age < STARTING_STALE_MS) return false;
    // Started, then crashed around queueing it: it may or may not be on its way, so never resend.
    const error = "Delivery of a WhatsApp message is uncertain — check Messages before resuming";
    settled = await finishRun(
      row,
      { status: "failed", result: null, error },
      (state) =>
        bookingLink
          ? afterMessage(state, false, engineCampaign(campaign), now, { bookingLink, error })
          : { ...decisionOf(state), status: "failed", failures: 0, note: error },
      now,
    );
  } else if (!job) {
    if (age < MESSAGE_JOB_MISSING_MS) return false;
    const error = "The message never reached the number's queue";
    settled = await finishRun(row, { status: "failed", result: null, error }, (state) => afterMessage(state, false, engineCampaign(campaign), now, { bookingLink, error }), now);
  } else if (job.status === "sent") {
    const sentAt = job.sentAt ?? now;
    settled = await finishRun(row, { status: "done", result: null, error: null }, (state) => afterMessage(state, true, engineCampaign(campaign), sentAt, { bookingLink }), now);
  } else if (job.status === "failed") {
    const error = job.error ?? "The message could not be sent";
    settled = await finishRun(row, { status: "failed", result: null, error }, (state) => afterMessage(state, false, engineCampaign(campaign), now, { bookingLink, error }), now);
  } else {
    return false;
  }
  if (!settled) return false;
  if (settled.decision) await syncCallFollowUpSafely(contact.personId);
  return true;
}

/**
 * Right after they said yes: the campaign's booking message with their
 * link, from the number that just called them. Claimed like any step
 * (`booking-link`, once per lead); settling it starts the chase.
 */
async function sendBookingLink(contact: ContactRow, campaign: CampaignRow, stationId: string | null, phone: string, now: Date): Promise<void> {
  const fail = async (runId: string | null, error: string) => {
    if (runId) {
      await db
        .update(callCampaignStepRuns)
        .set({ status: "failed", error, finishedAt: new Date() })
        .where(and(eq(callCampaignStepRuns.id, runId), eq(callCampaignStepRuns.status, "started")));
    }
    const decision = afterMessage(engineContact(contact, true), false, engineCampaign(campaign), now, { bookingLink: true, error });
    if (await writeDecision(db, contact.id, decision, now)) await syncCallFollowUpSafely(contact.personId);
  };

  if (!stationId) return fail(null, "No calling number to send it from");
  const [person] = await db
    .select({ person: people, company: companies })
    .from(people)
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), eq(people.id, contact.personId)))
    .limit(1);
  if (!person) return fail(null, "The person is no longer in this organization");
  const link = bookingLinkFor(campaign.aiBookingUrl ?? "", {
    contactId: contact.id,
    name: person.person.fullName ?? ([person.person.firstName, person.person.lastName].filter(Boolean).join(" ") || null),
    email: person.person.email,
    phone,
  });
  if (!link) return fail(null, "The campaign's booking link is not a valid URL");
  const body = renderMessage(campaign.aiBookingMessage?.trim() || DEFAULT_BOOKING_MESSAGE, person, campaign, link);
  if (!body) return fail(null, "The booking message is empty");

  const [run] = await db
    .insert(callCampaignStepRuns)
    .values({ contactId: contact.id, stepKey: BOOKING_LINK_KEY, kind: "message", stationId })
    .onConflictDoNothing()
    .returning({ id: callCampaignStepRuns.id });
  if (!run) return; // Already sent once (its settle moves the lead on).
  try {
    const queued = await queueStationMessage({ stationId, personId: contact.personId, phone, body });
    await db.update(callCampaignStepRuns).set({ whatsappMessageId: queued.whatsappMessageId }).where(eq(callCampaignStepRuns.id, run.id));
  } catch (error) {
    await fail(run.id, error instanceof Error ? error.message : String(error));
  }
}

type PersonWithCompany = { person: typeof people.$inferSelect; company: typeof companies.$inferSelect | null };

/** A WhatsApp step's text: merge fields from the Person and company, plus {{agentName}} and {{bookingLink}}. */
function renderMessage(body: string, lead: PersonWithCompany, campaign: CampaignRow, bookingLink: string | null): string {
  const variables = campaignLeadVariables(lead.person, lead.company, {});
  variables.agentName = campaign.aiAgentName?.trim() || DEFAULT_AGENT_NAME;
  variables.bookingLink = bookingLink ?? "";
  return renderCampaignStep(body, variables);
}

// --- 3. act ------------------------------------------------------------------------------

type StationCandidate = { station: StationRow; busy: boolean; callsToday: number };

async function act(result: AiCallingTickResult, now: Date): Promise<void> {
  const campaigns = await db.select().from(callCampaigns).where(liveAiCampaign());
  if (!campaigns.length) return;
  const campaignIds = campaigns.map((campaign) => campaign.id);
  const byId = new Map(campaigns.map((campaign) => [campaign.id, campaign]));

  const rules = await channelRules("whatsapp");
  const general = await channelRules("general");
  const dayStart = latestDailySlot(general.timeZone, general.dayStartsAt, now);

  for (const candidate of await candidateStations(campaignIds, dayStart, now)) {
    const { station } = candidate;
    if (candidate.busy) continue;
    if (station.nextCallAt && station.nextCallAt.getTime() > now.getTime()) continue;
    if (!withinCallingHours(station.callingHours ?? rules.callingHours, now)) continue;
    const limit = dailyCallLimit({
      stationLimit: station.callsPerDay,
      ruleLimit: rules.callsPerDay,
      warmupDays: rules.callWarmupDays,
      automationStartedAt: station.automationStartedAt,
      now,
    });
    try {
      await actForStation(station, byId, candidate.callsToday < limit, rules.callGapMinutes, now, result);
    } catch (error) {
      console.error(`[calls/aiCampaigns] station ${station.id} failed:`, error);
      result.failed += 1;
    }
  }
}

/**
 * The organization's active, linked numbers on a live campaign that a call
 * worker holds open right now, with whether each is busy (a cloud call open
 * on it, a message queued, a step running) and its AI-countable calls today.
 */
export async function candidateStations(campaignIds: string[], dayStart: Date, now: Date): Promise<StationCandidate[]> {
  if (!campaignIds.length) return [];
  return db
    .select({
      station: callingStations,
      busy: sql<boolean>`(
        exists (select 1 from ${callSessions} busy_call
                 where busy_call.organization_id = ${callingStations.organizationId}
                   and busy_call.station_id = ${callingStations.id}
                   and busy_call.mode = 'agent_cloud' and busy_call.status in ('pending', 'in_progress'))
        or exists (select 1 from ${stationMessageJobs} busy_job
                    where busy_job.organization_id = ${callingStations.organizationId}
                      and busy_job.station_id = ${callingStations.id}
                      and busy_job.status in ('queued', 'claimed'))
        or exists (select 1 from ${callCampaignStepRuns} busy_run
                    where busy_run.station_id = ${callingStations.id} and busy_run.status = 'started'))`,
      callsToday: sql<number>`(select count(*)::int from ${callSessions} today
                                where today.organization_id = ${callingStations.organizationId}
                                  and today.station_id = ${callingStations.id}
                                  and today.mode = 'agent_cloud'
                                  and today.created_at >= ${dayStart.toISOString()}::timestamptz)`,
    })
    .from(callingStations)
    .where(and(
      inOrg(callingStations),
      eq(callingStations.status, "active"),
      or(isNull(callingStations.linkedPhone), eq(callingStations.linkedPhone, callingStations.phone)),
      sql`${callingStations.leaseUntil} > ${now.toISOString()}::timestamptz`,
      inArray(
        callingStations.id,
        db.select({ id: callCampaignStations.stationId }).from(callCampaignStations).where(inArray(callCampaignStations.campaignId, campaignIds)),
      ),
    ))
    .orderBy(sql`${callingStations.lastCallAt} asc nulls first`);
}

/**
 * The most urgent due lead this number may act for: call-backs, then the
 * chase, then the reach sequence, then new leads; oldest due first. A lead
 * keeps the number that first called it, unless that number was banned or
 * taken off the campaign.
 */
export async function pickDueContact(stationId: string, campaignIds: string[], now: Date, exclude: string[]): Promise<ContactRow | null> {
  const [row] = await db
    .select({ contact: callCampaignContacts })
    .from(callCampaignContacts)
    .where(and(
      inArray(callCampaignContacts.campaignId, campaignIds),
      contactInScope(),
      inArray(callCampaignContacts.aiStatus, [...AI_OPEN_STATUSES]),
      lte(callCampaignContacts.aiNextAt, now),
      exclude.length ? notInArray(callCampaignContacts.id, exclude) : undefined,
      sql`exists (select 1 from ${callCampaignStations} own
                   where own.campaign_id = ${callCampaignContacts.campaignId} and own.station_id = ${stationId})`,
      sql`(${callCampaignContacts.aiStationId} is null
           or ${callCampaignContacts.aiStationId} = ${stationId}
           or not exists (select 1 from ${callCampaignStations} kept
                           join ${callingStations} kept_station on kept_station.id = kept.station_id
                          where kept.campaign_id = ${callCampaignContacts.campaignId}
                            and kept.station_id = ${callCampaignContacts.aiStationId}
                            and kept_station.status <> 'banned'))`,
      sql`not exists (select 1 from ${callCampaignStepRuns} running
                       where running.contact_id = ${callCampaignContacts.id} and running.status = 'started')`,
      // A trial call placed by hand from the lead's side sheet is still open.
      sql`not exists (select 1 from ${callSessions} trial
                       where trial.campaign_contact_id = ${callCampaignContacts.id} and trial.status in ('pending', 'in_progress'))`,
    ))
    .orderBy(
      sql`case ${callCampaignContacts.aiStatus} when 'callback' then 0 when 'chasing' then 1 when 'reaching' then 2 else 3 end`,
      asc(callCampaignContacts.aiNextAt),
      asc(callCampaignContacts.createdAt),
    )
    .limit(1);
  return row?.contact ?? null;
}

type PickOutcome = "acted" | "continue" | "stop";

async function actForStation(
  station: StationRow,
  campaigns: Map<string, CampaignRow>,
  callsAllowed: boolean,
  gapMinutes: [number, number],
  now: Date,
  result: AiCallingTickResult,
): Promise<void> {
  const campaignIds = [...new Set((await db
    .select({ id: callCampaignStations.campaignId })
    .from(callCampaignStations)
    .where(and(eq(callCampaignStations.stationId, station.id), inArray(callCampaignStations.campaignId, [...campaigns.keys()]))))
    .map((row) => row.id))];
  const passed: string[] = [];
  for (let picks = 0; picks < MAX_PICKS_PER_STATION; picks += 1) {
    const contact = await pickDueContact(station.id, campaignIds, now, passed);
    if (!contact) return;
    passed.push(contact.id);
    const campaign = campaigns.get(contact.campaignId);
    if (!campaign) continue;
    const outcome = await actForContact(station, campaign, contact, callsAllowed, gapMinutes, now, result);
    if (outcome !== "continue") return;
  }
}

async function actForContact(
  station: StationRow,
  campaign: CampaignRow,
  contact: ContactRow,
  callsAllowed: boolean,
  gapMinutes: [number, number],
  now: Date,
  result: AiCallingTickResult,
): Promise<PickOutcome> {
  const settings = engineCampaign(campaign);
  const state = engineContact(contact, await bookingLinkSent(contact.id));

  if (await isPersonDoNotContact(db, contact.personId)) {
    if (await writeDecision(db, contact.id, { ...decisionOf(state), status: "stopped", nextAt: null, note: "Do Not Contact" }, now)) {
      await syncCallFollowUpSafely(contact.personId);
    }
    return "continue";
  }

  const plan = plannedAction(state, settings, now);
  if (plan.kind === "none") {
    if (await writeDecision(db, contact.id, plan.decision, now)) await syncCallFollowUpSafely(contact.personId);
    return "continue";
  }
  // Over today's call limit, a number still sends messages.
  if (plan.kind === "call" && !callsAllowed) return "continue";

  const [lead] = await db
    .select({ person: people, company: companies })
    .from(people)
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), eq(people.id, contact.personId)))
    .limit(1);
  const fail = async (note: string) => {
    if (await writeDecision(db, contact.id, { ...decisionOf(state), status: "failed", nextAt: null, note }, now)) {
      await syncCallFollowUpSafely(contact.personId);
    }
    result.failed += 1;
    return "continue" as const;
  };
  if (!lead) return fail("The person is no longer in this organization");
  if (!lead.person.phone) return fail("No phone number");

  let body = "";
  let brief = "";
  if (plan.kind === "message") {
    const step = plan.step?.kind === "message" ? plan.step : null;
    const link = settings.bookingUrl
      ? bookingLinkFor(settings.bookingUrl, {
          contactId: contact.id,
          name: lead.person.fullName ?? null,
          email: lead.person.email,
          phone: lead.person.phone,
        })
      : null;
    body = step ? renderMessage(step.body, lead, campaign, link) : "";
    if (!body) return fail("The message is empty for this lead");
  } else {
    brief = await agentBrief({
      campaignInstructions: campaign.aiInstructions,
      purpose: plan.purpose,
      stepInstructions: plan.step?.kind === "call" ? plan.step.instructions : null,
      callbackWhen: plan.purpose === "callback" ? await callbackWhen(contact.id) : null,
      leadInstructions: contact.aiInstructions,
    });
  }

  // Claim: reserve the number (its next_call_at), lock the lead, insert the step run.
  const gapMs = plan.kind === "call" ? pickInRange(gapMinutes) * 60_000 : MESSAGE_GAP_MS;
  const claim = await db.transaction(async (tx) => {
    const [reserved] = await tx
      .select({ id: callingStations.id })
      .from(callingStations)
      .where(and(
        inOrg(callingStations),
        eq(callingStations.id, station.id),
        or(isNull(callingStations.nextCallAt), lte(callingStations.nextCallAt, now)),
      ))
      .for("update", { skipLocked: true });
    if (!reserved) return { kind: "station_taken" as const };
    const [locked] = await tx
      .select({ id: callCampaignContacts.id })
      .from(callCampaignContacts)
      .where(and(
        contactInScope(),
        eq(callCampaignContacts.id, contact.id),
        eq(callCampaignContacts.aiStatus, state.status),
        eq(callCampaignContacts.aiStep, contact.aiStep),
        eq(callCampaignContacts.aiFailures, contact.aiFailures),
        eq(callCampaignContacts.aiCallbacks, contact.aiCallbacks),
        lte(callCampaignContacts.aiNextAt, now),
      ))
      .for("update", { skipLocked: true });
    if (!locked) return { kind: "lost" as const };
    const [run] = await tx
      .insert(callCampaignStepRuns)
      .values({ contactId: contact.id, stepKey: plan.stepKey, kind: plan.kind, stationId: station.id })
      .onConflictDoNothing()
      .returning();
    if (!run) {
      const [existing] = await tx
        .select()
        .from(callCampaignStepRuns)
        .where(and(eq(callCampaignStepRuns.contactId, contact.id), eq(callCampaignStepRuns.stepKey, plan.stepKey)))
        .limit(1);
      return { kind: "existing" as const, run: existing ?? null };
    }
    await tx
      .update(callingStations)
      .set({
        nextCallAt: new Date(now.getTime() + gapMs),
        ...(plan.kind === "call" && !station.automationStartedAt ? { automationStartedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(inOrg(callingStations), eq(callingStations.id, station.id)));
    await tx
      .update(callCampaignContacts)
      .set({ aiStatus: statusWhenStarted(state.status), aiStationId: station.id, updatedAt: now })
      .where(and(contactInScope(), eq(callCampaignContacts.id, contact.id)));
    return { kind: "claimed" as const, run };
  });

  if (claim.kind === "station_taken") return "stop";
  if (claim.kind === "lost") return "continue";
  if (claim.kind === "existing") {
    // The step already ran but the lead was not moved past it (edited back, or a crash): move it on, never repeat it.
    if (claim.run && claim.run.status !== "started") {
      const decision = claim.run.kind === "call"
        ? afterCall(state, "no_answer", null, settings, now)
        : afterMessage(state, true, settings, now);
      if (await writeDecision(db, contact.id, decision, now)) await syncCallFollowUpSafely(contact.personId);
    }
    return "continue";
  }

  const runId = claim.run.id;
  if (plan.kind === "message") {
    try {
      const queued = await queueStationMessage({ stationId: station.id, personId: contact.personId, phone: lead.person.phone, body });
      await db.update(callCampaignStepRuns).set({ whatsappMessageId: queued.whatsappMessageId }).where(eq(callCampaignStepRuns.id, runId));
      result.messages += 1;
    } catch (error) {
      await failStart(runId, contact, state, settings, error, now, "message");
      result.failed += 1;
    }
    return "acted";
  }

  try {
    const started = await startCall({
      personId: contact.personId,
      campaignContactId: contact.id,
      mode: "agent_cloud",
      stationId: station.id,
      agentBrief: brief,
      agentName: campaign.aiAgentName,
      agentVoice: campaign.aiAgentVoice,
    });
    await db.update(callCampaignStepRuns).set({ callSessionId: started.call.id }).where(eq(callCampaignStepRuns.id, runId));
    result.calls += 1;
  } catch (error) {
    await failStart(runId, contact, state, settings, error, now, "call");
    result.failed += 1;
  }
  return "acted";
}

function decisionOf(state: AiEngineContact): AiDecision {
  return { status: state.status, step: state.step, nextAt: null, callbacks: state.callbacks, failures: state.failures };
}

/** The step could not even start: the run fails, and the lead retries (or fails on a bad number). */
async function failStart(
  runId: string,
  contact: ContactRow,
  state: AiEngineContact,
  campaign: AiEngineCampaign,
  error: unknown,
  now: Date,
  kind: "call" | "message",
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(callCampaignStepRuns)
    .set({ status: "failed", result: kind === "call" ? "error" : null, error: message.slice(0, 1000), finishedAt: new Date() })
    .where(and(eq(callCampaignStepRuns.id, runId), eq(callCampaignStepRuns.status, "started")));
  const started = { ...state, status: statusWhenStarted(state.status) };
  // A number startCall cannot dial (400) will not get better on a retry.
  const decision = error instanceof CallApiError && error.status === 400
    ? { ...decisionOf(started), status: "failed" as const, note: message }
    : kind === "call"
      ? afterCall(started, "error", null, campaign, now, message)
      : afterMessage(started, false, campaign, now, { error: message });
  if (await writeDecision(db, contact.id, decision, now)) await syncCallFollowUpSafely(contact.personId);
}

/** The call-back time they gave, in their words, from the call that set it. */
async function callbackWhen(contactId: string): Promise<string | null> {
  const [row] = await db
    .select({ outcome: callSessions.agentOutcome })
    .from(callSessions)
    .where(and(inOrg(callSessions), eq(callSessions.campaignContactId, contactId), sql`${callSessions.agentOutcome}->>'outcome' = 'call_back'`))
    .orderBy(desc(callSessions.createdAt))
    .limit(1);
  return row?.outcome?.when ?? null;
}
