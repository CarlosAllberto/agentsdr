import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, people } from "@/lib/leads/schema";
import { personCompanyName } from "@/lib/leads/companyName";
import { isPersonDoNotContact } from "@/lib/crm/policies";
import { runInOrganization, inOrg } from "@/lib/tenancy/scope";
import { matchPersonByPhone } from "@/lib/whatsapp/messages";
import { agentBrief } from "./aiCampaigns/brief.server";
import { AI_OPEN_STATUSES, inboundStepKey } from "./aiCampaigns/contract";
import { normalizePhone } from "./phone";
import { organizationPhoneCountry } from "./phone.server";
import { callCampaignContacts, callCampaignStepRuns, callCampaigns, callSessions, callingStations } from "./schema";
import { CallApiError, recorderLeadFor } from "./sessions";
import { isUuid } from "@/lib/whatsapp/stationParse";
import { createRecorderToken } from "./token";
import {
  INCOMING_CALL_MAX_AGE_MS,
  type CloudCallPhase,
  type WorkerIncomingCallRequest,
  type WorkerIncomingCallResponse,
} from "./stationContract";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A lead called a calling station back: whether the AI agent answers, and if
 * so the call it answers with. POST /api/call-worker/stations/:id/incoming.
 *
 * It answers a known lead (a Person with this number) who is not Do Not
 * Contact, on an active number this worker holds and that is not on another
 * call — at any hour (calling hours limit when we call, not when they do).
 * Anyone else rings out. The call_sessions row is created already claimed by
 * the worker (direction 'inbound'), which also marks the number busy for the
 * claim, the engine and messaging. A lead in an AI campaign gets that
 * campaign's agent, knowledge and instructions, and a step run
 * (`inbound:<call id>`) so the engine settles what the agent recorded like a
 * placed call's; a lead who rang while the number was busy is called back
 * first instead.
 *
 * Unscoped station lookup (the worker has no organization); everything after
 * runs in the station's organization.
 */
export async function decideIncomingCall(stationId: string, body: WorkerIncomingCallRequest): Promise<WorkerIncomingCallResponse> {
  if (!isUuid(stationId)) throw new CallApiError(404, "Calling number not found");
  const [station] = await db.select().from(callingStations).where(eq(callingStations.id, stationId)).limit(1);
  if (!station) throw new CallApiError(404, "Calling number not found");
  return runInOrganization(station.organizationId, () => decide(station, body));
}

type StationRow = typeof callingStations.$inferSelect;

async function decide(station: StationRow, { workerId, call }: WorkerIncomingCallRequest): Promise<WorkerIncomingCallResponse> {
  const now = new Date();
  const no = (reason: string): WorkerIncomingCallResponse => ({ answer: false, reason });

  if (station.status !== "active") return no("the number is not active");
  if (station.leaseHolder !== workerId || !station.leaseUntil || station.leaseUntil < now) return no("this worker does not hold the number");
  if (call.isGroup) return no("a group call");
  if (call.isVideo) return no("a video call");
  if (now.getTime() - call.at > INCOMING_CALL_MAX_AGE_MS) return no("it has been ringing too long");

  const phone = call.phone ? normalizePhone(call.phone, await organizationPhoneCountry()) : null;
  if (!phone) return no("the caller's number is hidden");
  const personId = await matchPersonByPhone(phone);
  if (!personId) return no("not a lead");
  if (await isPersonDoNotContact(db, personId)) return no("the lead is Do Not Contact");

  // Who they are calling back: our last AI call to them — its campaign and the
  // agent's name and voice they heard. Without it the agent answered as the
  // default persona, with none of that campaign's instructions (3–4 Nov 2026).
  const lastCall = await lastAgentCallTo(personId);
  const contact = await aiContactFor(personId, lastCall?.campaignContactId ?? null);
  const persona = lastCall?.agentName
    ? { name: lastCall.agentName, voice: lastCall.agentVoice }
    : { name: contact?.campaign.aiAgentName ?? null, voice: contact?.campaign.aiAgentVoice ?? null };
  // Only a launched campaign's engine settles a step run (a draft's lead still gets its instructions).
  const countsAsStep = !!contact?.campaign.aiLaunchedAt;
  const [found] = await db
    .select({ person: people, companyName: companies.name })
    .from(people)
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), eq(people.id, personId)))
    .limit(1);
  const lead = found ? recorderLeadFor(found.person, personCompanyName(found.person.raw, found.companyName)) : null;
  const firstCall = contact?.campaign.aiSteps.find((step) => step.kind === "call");
  const brief = await agentBrief({
    campaignInstructions: contact?.campaign.aiInstructions ?? "",
    purpose: "inbound",
    stepInstructions: firstCall?.kind === "call" ? firstCall.instructions : null,
    leadInstructions: contact?.contact.aiInstructions ?? null,
  });

  const { token, hash } = createRecorderToken();
  const ringing: CloudCallPhase = { kind: "ringing" };
  const created = await db.transaction(async (tx) => {
    // The station's row lock orders this against the claim of an outbound call on it.
    await tx.select({ id: callingStations.id }).from(callingStations).where(eq(callingStations.id, station.id)).for("update");
    const [busy] = await tx
      .select({ id: callSessions.id })
      .from(callSessions)
      .where(and(
        inOrg(callSessions),
        eq(callSessions.stationId, station.id),
        eq(callSessions.mode, "agent_cloud"),
        sql`${callSessions.claimedAt} IS NOT NULL`,
        inArray(callSessions.status, ["pending", "in_progress"]),
      ))
      .limit(1);
    if (busy) return null;
    const [row] = await tx
      .insert(callSessions)
      .values({
        organizationId: station.organizationId,
        personId,
        campaignContactId: contact?.contact.id ?? null,
        phone,
        status: "pending",
        uploadTokenHash: hash,
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
        mode: "agent_cloud",
        direction: "inbound",
        stationId: station.id,
        agentBrief: brief,
        agentName: persona.name,
        agentVoice: persona.voice,
        livePhase: ringing,
        claimedAt: now,
        claimedBy: workerId,
      })
      .returning();
    if (!row) throw new Error("The incoming call's row could not be written");
    await tx.update(callingStations).set({ workerId, lastCallAt: now, updatedAt: now }).where(eq(callingStations.id, station.id));
    if (contact && countsAsStep) {
      await tx.insert(callCampaignStepRuns).values({
        contactId: contact.contact.id,
        stepKey: inboundStepKey(row.id),
        kind: "call",
        status: "started",
        stationId: station.id,
        callSessionId: row.id,
      });
    }
    return row;
  });

  if (!created) {
    // On another call: they show up as a missed call, so call them back first.
    if (contact && countsAsStep && isOpen(contact.contact.aiStatus)) {
      await db
        .update(callCampaignContacts)
        .set({ aiNextAt: now, updatedAt: now })
        .where(and(eq(callCampaignContacts.id, contact.contact.id), sql`${callCampaignContacts.aiStatus} IN ${AI_OPEN_STATUSES}`));
    }
    return no("the number is on another call");
  }

  return {
    answer: true,
    call: {
      id: created.id,
      phone,
      recorderToken: token,
      lead,
      brief,
      agentName: created.agentName ?? null,
      agentVoice: created.agentVoice ?? null,
      // The agent answers a call-back; a rep is never on it.
      remoteRep: false,
    },
  };
}

function isOpen(status: string | null): boolean {
  return (AI_OPEN_STATUSES as readonly string[]).includes(status ?? "");
}

/** Our most recent AI-agent call to this person (not one a rep talked on): its campaign lead and persona. */
async function lastAgentCallTo(personId: string) {
  const [row] = await db
    .select({ campaignContactId: callSessions.campaignContactId, agentName: callSessions.agentName, agentVoice: callSessions.agentVoice })
    .from(callSessions)
    .where(and(
      inOrg(callSessions),
      eq(callSessions.personId, personId),
      eq(callSessions.direction, "outbound"),
      eq(callSessions.mode, "agent_cloud"),
      isNull(callSessions.remoteRep),
    ))
    .orderBy(desc(callSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The person's lead in an AI campaign, if any — the one whose agent answers:
 * the lead our last call to them came from (launched or not: it is what they
 * heard about), else an active launched campaign before a paused one, an open
 * lead before a settled one, then the most recently touched.
 */
async function aiContactFor(personId: string, lastCampaignContactId: string | null) {
  const base = and(
    inOrg(callCampaigns),
    eq(callCampaignContacts.personId, personId),
    eq(callCampaigns.runBy, "ai"),
    sql`${callCampaigns.archivedAt} IS NULL`,
  );
  if (lastCampaignContactId) {
    const [last] = await db
      .select({ contact: callCampaignContacts, campaign: callCampaigns })
      .from(callCampaignContacts)
      .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
      .where(and(base, eq(callCampaignContacts.id, lastCampaignContactId)))
      .limit(1);
    if (last) return last;
  }
  const [row] = await db
    .select({ contact: callCampaignContacts, campaign: callCampaigns })
    .from(callCampaignContacts)
    .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
    .where(and(base, sql`${callCampaigns.aiLaunchedAt} IS NOT NULL`))
    .orderBy(
      sql`(${callCampaigns.status} = 'active') DESC`,
      sql`(${callCampaignContacts.aiStatus} IN ${AI_OPEN_STATUSES}) DESC`,
      desc(callCampaignContacts.updatedAt),
    )
    .limit(1);
  return row ?? null;
}

