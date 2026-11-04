import "server-only";

import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { channelRules } from "@/lib/channels/rules.server";
import { companies, people } from "@/lib/leads/schema";
import { withLeadTransaction } from "@/lib/leads/records";
import { personCompanyName } from "@/lib/leads/companyName";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { findOrCreateContactPerson, resolveImportRow, contactInOrg } from "@/lib/calls/campaigns";
import { crmKnowledgeDocuments } from "@/lib/crm/schema";
import {
  importMappingError,
  mapImportRow,
  normalizeCampaignPhone,
  parseImportSheet,
  suggestWhatsappMapping,
  type ImportMapping,
} from "@/lib/whatsapp/campaigns/importMapping";
import {
  WHATSAPP_CAMPAIGN_IMPORT_FIELDS,
  WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS,
  type WhatsappCampaignUploadPreview,
} from "@/lib/whatsapp/campaigns/contract";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { parseAgentName, parseAgentVoice } from "@/lib/calls/liveAgent";
import { AGENT_OUTCOMES, type AgentOutcomeKind, type CallCampaignStatus } from "@/lib/calls/contract";
import { CallApiError, expireStaleCalls, startCall } from "@/lib/calls/sessions";
import { agentBrief } from "./brief.server";
import { callCampaignContacts, callCampaignStations, callCampaignStepRuns, callCampaigns, callSessions, callingStations } from "@/lib/calls/schema";
import {
  AI_CONTACT_STATUSES,
  AI_OPEN_STATUSES,
  DEFAULT_BOOKING_MESSAGE,
  DEFAULT_CHASE_STEPS,
  DEFAULT_REACH_STEPS,
  drawerCallStepKey,
  type AiCampaignStep,
  type AiContactStatus,
} from "./contract";
import {
  AI_EMPTY_STATUS_COUNTS,
  aiCampaignState,
  aiLaunchBlocker,
  aiSequencesError,
  aiSettingsError,
  aiStepLabel,
  callsPerDayLimit,
  describeStepKey,
  httpsUrl,
  type AddAiCampaignPeopleResponse,
  type AiCampaignDetail,
  type AiCampaignLead,
  type AiCampaignNumber,
  type AiCampaignStats,
  type AiCampaignSummary,
  type AiLeadDetail,
  type AiLeadsImportResponse,
  type AiLeadsQuery,
  type AiStepStat,
  type CreateAiCampaignRequest,
  type ListAiLeadsResponse,
  type UpdateAiCampaignRequest,
  type UpdateAiLeadRequest,
  type CallAiLeadRequest,
  type CallAiLeadResponse,
  AI_CAMPAIGN_MAX_KNOWLEDGE,
  AI_LEAD_MAX_INSTRUCTIONS,
} from "./api";
import { loadLeadActivity } from "./leadActivity";

/**
 * AI calling campaigns: everything the pages and /api/calling/ai-campaigns
 * read and write. A campaign is a call_campaigns row with run_by = 'ai';
 * its leads are call_campaign_contacts (no organization column of their own:
 * `contactInOrg()` says whose they are). The engine acts on the same rows.
 *
 * A campaign that has never been launched is a draft: it is stored paused
 * with ai_launched_at null, and places nothing.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEAD_SOURCE = "ai-call-campaign-lead";
const MAX_ADD_PEOPLE = 5000;
const MAX_SKIPPED_REPORTED = 50;
const MAX_NUMBERS = 20;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;
const CALLS_BY_DAY = 14;
/** Outcomes that count a lead as interested. */
const INTERESTED_OUTCOMES: AgentOutcomeKind[] = ["meeting_booked", "interested", "human_callback"];

type CampaignRow = typeof callCampaigns.$inferSelect;
type StationRow = typeof callingStations.$inferSelect;
type ContactRow = typeof callCampaignContacts.$inferSelect;
type PersonRow = typeof people.$inferSelect;
type CompanyRow = typeof companies.$inferSelect;

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new CallApiError(404, `${label} not found`);
}

/** A live AI campaign of this organization, or 404 (a rep's campaign is not one). */
async function loadCampaignRow(campaignId: string): Promise<CampaignRow> {
  assertUuid(campaignId, "Campaign");
  const [row] = await db
    .select()
    .from(callCampaigns)
    .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), eq(callCampaigns.runBy, "ai"), sql`${callCampaigns.archivedAt} is null`))
    .limit(1);
  if (!row) throw new CallApiError(404, "Campaign not found");
  return row;
}

/** The start of today in the organization's time zone, as a timestamptz. */
async function todayStart(): Promise<SQL> {
  const { timeZone } = await channelRules("general");
  return sql`(date_trunc('day', now() at time zone ${timeZone}::text) at time zone ${timeZone}::text)`;
}

async function orgTimeZone(): Promise<string> {
  return (await channelRules("general")).timeZone;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// --- numbers ------------------------------------------------------------------

async function loadNumbers(campaignIds: string[]): Promise<Map<string, AiCampaignNumber[]>> {
  const result = new Map<string, AiCampaignNumber[]>(campaignIds.map((id) => [id, []]));
  if (!campaignIds.length) return result;
  const rows = await db
    .select({ campaignId: callCampaignStations.campaignId, station: callingStations })
    .from(callCampaignStations)
    .innerJoin(callingStations, eq(callCampaignStations.stationId, callingStations.id))
    .where(and(inOrg(callingStations), inArray(callCampaignStations.campaignId, campaignIds)))
    .orderBy(asc(callingStations.name));
  if (!rows.length) return result;
  const stationIds = [...new Set(rows.map((row) => row.station.id))];
  const start = await todayStart();
  const today = await db
    .select({ stationId: callSessions.stationId, n: count() })
    .from(callSessions)
    .where(
      and(
        inOrg(callSessions),
        inArray(callSessions.stationId, stationIds),
        eq(callSessions.mode, "agent_cloud"),
        sql`${callSessions.campaignContactId} is not null`,
        ne(callSessions.status, "pending"),
        sql`${callSessions.createdAt} >= ${start}`,
      ),
    )
    .groupBy(callSessions.stationId);
  const todayByStation = new Map(today.map((row) => [row.stationId as string, row.n]));
  for (const { campaignId, station } of rows) {
    result.get(campaignId)?.push(toNumber(station, todayByStation.get(station.id) ?? 0));
  }
  return result;
}

function toNumber(station: StationRow, callsToday: number): AiCampaignNumber {
  return {
    id: station.id,
    name: station.name,
    phone: station.phone,
    status: station.status,
    openOn: station.leaseHolder && station.leaseUntil && station.leaseUntil.getTime() > Date.now() ? station.leaseHolder : null,
    callsPerDay: station.callsPerDay,
    callsToday,
  };
}

// --- summaries ----------------------------------------------------------------

async function loadSummaries(rows: CampaignRow[]): Promise<AiCampaignSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const start = await todayStart();
  const [numbers, leadCounts, callCounts] = await Promise.all([
    loadNumbers(ids),
    db
      .select({
        campaignId: callCampaignContacts.campaignId,
        leads: count(),
        booked: sql<number>`count(*) filter (where ${callCampaignContacts.aiStatus} = 'booked')`.mapWith(Number),
      })
      .from(callCampaignContacts)
      .where(and(contactInOrg(), inArray(callCampaignContacts.campaignId, ids)))
      .groupBy(callCampaignContacts.campaignId),
    db
      .select({ campaignId: callCampaignContacts.campaignId, n: count() })
      .from(callSessions)
      .innerJoin(callCampaignContacts, eq(callSessions.campaignContactId, callCampaignContacts.id))
      .where(
        and(
          inOrg(callSessions),
          contactInOrg(),
          inArray(callCampaignContacts.campaignId, ids),
          ne(callSessions.status, "pending"),
          sql`${callSessions.createdAt} >= ${start}`,
        ),
      )
      .groupBy(callCampaignContacts.campaignId),
  ]);
  const leadsBy = new Map(leadCounts.map((row) => [row.campaignId, row]));
  const callsBy = new Map(callCounts.map((row) => [row.campaignId, row.n]));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    state: aiCampaignState({ launchedAt: row.aiLaunchedAt, status: row.status }),
    launchedAt: iso(row.aiLaunchedAt),
    goal: row.aiGoal,
    createdAt: row.createdAt.toISOString(),
    numbers: numbers.get(row.id) ?? [],
    leads: Number(leadsBy.get(row.id)?.leads ?? 0),
    callsToday: callsBy.get(row.id) ?? 0,
    booked: leadsBy.get(row.id)?.booked ?? 0,
    stepCount: row.aiSteps.length,
  }));
}

export async function listAiCampaigns(): Promise<AiCampaignSummary[]> {
  const rows = await db
    .select()
    .from(callCampaigns)
    .where(and(inOrg(callCampaigns), eq(callCampaigns.runBy, "ai"), sql`${callCampaigns.archivedAt} is null`))
    .orderBy(desc(callCampaigns.createdAt));
  return loadSummaries(rows);
}

export async function getAiCampaign(campaignId: string): Promise<AiCampaignDetail> {
  return toDetail(await loadCampaignRow(campaignId));
}

async function toDetail(row: CampaignRow): Promise<AiCampaignDetail> {
  const [summary] = await loadSummaries([row]);
  if (!summary) throw new CallApiError(404, "Campaign not found");
  const rules = await channelRules("whatsapp");
  const blocker =
    summary.state === "draft"
      ? aiLaunchBlocker({
          numbers: summary.numbers.length,
          steps: row.aiSteps,
          instructions: row.aiInstructions,
          goal: row.aiGoal,
          bookingUrl: row.aiBookingUrl,
          leads: summary.leads,
        })
      : null;
  return {
    ...summary,
    goal: row.aiGoal,
    instructions: row.aiInstructions,
    agentName: row.aiAgentName,
    agentVoice: row.aiAgentVoice,
    bookingUrl: row.aiBookingUrl,
    bookingMessage: row.aiBookingMessage ?? DEFAULT_BOOKING_MESSAGE,
    maxCallbacks: row.aiMaxCallbacks,
    steps: row.aiSteps,
    chaseSteps: row.aiChaseSteps,
    knowledgeIds: row.aiKnowledgeIds ?? null,
    blocker,
    callsPerDayLimit: callsPerDayLimit(summary.numbers, rules.callsPerDay),
  };
}

// --- create / update ----------------------------------------------------------

function parseName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) throw new CallApiError(400, "Give the campaign a name");
  if (name.length > 120) throw new CallApiError(400, "The name is over 120 characters");
  return name;
}

function parseDescription(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new CallApiError(400, "description must be a string");
  const clean = value.trim();
  if (clean.length > 2000) throw new CallApiError(400, "The description is over 2000 characters");
  return clean || null;
}

export function parseCreateAiCampaignRequest(value: unknown): CreateAiCampaignRequest {
  const body = asObject(value, ["name", "description"]);
  return { name: parseName(body.name), description: parseDescription(body.description) };
}

const UPDATE_KEYS = [
  "name",
  "description",
  "status",
  "goal",
  "instructions",
  "agentName",
  "agentVoice",
  "bookingUrl",
  "bookingMessage",
  "maxCallbacks",
  "steps",
  "chaseSteps",
  "knowledgeIds",
];

function asObject(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CallApiError(400, "Expected a JSON object");
  const body = value as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !allowed.includes(key));
  if (unknown) throw new CallApiError(400, `Unknown field: ${unknown}`);
  return body;
}

/** Shapes a PATCH body; the values themselves are checked against the stored campaign in updateAiCampaign. */
export function parseUpdateAiCampaignRequest(value: unknown): UpdateAiCampaignRequest {
  const body = asObject(value, UPDATE_KEYS);
  const request: UpdateAiCampaignRequest = {};
  if (body.name !== undefined) request.name = parseName(body.name);
  if (body.description !== undefined) request.description = parseDescription(body.description);
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "paused") throw new CallApiError(400, "status must be active or paused");
    request.status = body.status as CallCampaignStatus;
  }
  if (body.goal !== undefined) request.goal = body.goal as UpdateAiCampaignRequest["goal"];
  if (body.instructions !== undefined) {
    if (typeof body.instructions !== "string") throw new CallApiError(400, "instructions must be text");
    request.instructions = body.instructions.trim();
  }
  if (body.agentName !== undefined) request.agentName = parseAgentName(body.agentName);
  if (body.agentVoice !== undefined) request.agentVoice = parseAgentVoice(body.agentVoice);
  if (body.bookingUrl !== undefined) {
    if (body.bookingUrl === null || body.bookingUrl === "") request.bookingUrl = null;
    else {
      if (typeof body.bookingUrl !== "string") throw new CallApiError(400, "bookingUrl must be text");
      const url = httpsUrl(body.bookingUrl);
      if (!url) throw new CallApiError(400, "The booking link must be an https:// address");
      request.bookingUrl = url;
    }
  }
  if (body.bookingMessage !== undefined) {
    if (typeof body.bookingMessage !== "string") throw new CallApiError(400, "bookingMessage must be text");
    request.bookingMessage = body.bookingMessage.trim();
  }
  if (body.maxCallbacks !== undefined) {
    if (typeof body.maxCallbacks !== "number") throw new CallApiError(400, "maxCallbacks must be a number");
    request.maxCallbacks = body.maxCallbacks;
  }
  if (body.steps !== undefined) request.steps = body.steps as AiCampaignStep[];
  if (body.chaseSteps !== undefined) request.chaseSteps = body.chaseSteps as AiCampaignStep[];
  if (body.knowledgeIds !== undefined) {
    if (body.knowledgeIds === null) request.knowledgeIds = null;
    else {
      if (!Array.isArray(body.knowledgeIds) || body.knowledgeIds.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
        throw new CallApiError(400, "knowledgeIds must be a list of Knowledge document ids");
      }
      const ids = [...new Set(body.knowledgeIds as string[])];
      if (ids.length > AI_CAMPAIGN_MAX_KNOWLEDGE) throw new CallApiError(400, `At most ${AI_CAMPAIGN_MAX_KNOWLEDGE} Knowledge documents`);
      request.knowledgeIds = ids;
    }
  }
  return request;
}

export async function createAiCampaign(input: CreateAiCampaignRequest): Promise<AiCampaignDetail> {
  const [row] = await db
    .insert(callCampaigns)
    .values({
      organizationId: currentOrganizationId(),
      name: input.name,
      description: input.description ?? null,
      runBy: "ai",
      // A draft: paused and never launched, so nothing acts on it.
      status: "paused",
      aiGoal: "book_meeting",
      aiSteps: DEFAULT_REACH_STEPS.map((step) => ({ ...step })),
      aiChaseSteps: DEFAULT_CHASE_STEPS.map((step) => ({ ...step })),
      aiBookingMessage: DEFAULT_BOOKING_MESSAGE,
      // Starts from what a call placed by hand knows; the campaign then picks its own.
      aiKnowledgeIds: (
        await db
          .select({ id: crmKnowledgeDocuments.id })
          .from(crmKnowledgeDocuments)
          .where(and(inOrg(crmKnowledgeDocuments), eq(crmKnowledgeDocuments.active, true), eq(crmKnowledgeDocuments.alwaysInclude, true)))
      ).map((document) => document.id),
    })
    .returning();
  if (!row) throw new Error("call_campaigns insert did not return a row");
  return toDetail(row);
}

export async function updateAiCampaign(campaignId: string, input: UpdateAiCampaignRequest): Promise<AiCampaignDetail> {
  const row = await loadCampaignRow(campaignId);
  const updates: Partial<typeof callCampaigns.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;

  const settingsTouched =
    input.goal !== undefined ||
    input.instructions !== undefined ||
    input.bookingUrl !== undefined ||
    input.bookingMessage !== undefined ||
    input.maxCallbacks !== undefined;
  if (settingsTouched) {
    const merged = {
      goal: input.goal ?? row.aiGoal,
      instructions: input.instructions ?? row.aiInstructions,
      bookingUrl: input.bookingUrl !== undefined ? input.bookingUrl : row.aiBookingUrl,
      bookingMessage: input.bookingMessage ?? row.aiBookingMessage ?? DEFAULT_BOOKING_MESSAGE,
      maxCallbacks: input.maxCallbacks ?? row.aiMaxCallbacks,
    };
    const problem = aiSettingsError(merged);
    if (problem) throw new CallApiError(400, problem);
    updates.aiGoal = merged.goal;
    updates.aiInstructions = merged.instructions;
    updates.aiBookingUrl = merged.bookingUrl;
    updates.aiBookingMessage = merged.bookingMessage;
    updates.aiMaxCallbacks = merged.maxCallbacks;
  }
  if (input.knowledgeIds !== undefined) {
    if (input.knowledgeIds?.length) {
      const found = await db
        .select({ id: crmKnowledgeDocuments.id })
        .from(crmKnowledgeDocuments)
        .where(and(inOrg(crmKnowledgeDocuments), inArray(crmKnowledgeDocuments.id, input.knowledgeIds)));
      if (found.length !== input.knowledgeIds.length) throw new CallApiError(400, "Some of those Knowledge documents do not exist");
    }
    updates.aiKnowledgeIds = input.knowledgeIds;
  }
  if (input.agentName !== undefined) updates.aiAgentName = input.agentName;
  if (input.agentVoice !== undefined) updates.aiAgentVoice = input.agentVoice;

  if (input.steps !== undefined || input.chaseSteps !== undefined) {
    const steps = input.steps ?? row.aiSteps;
    const chaseSteps = input.chaseSteps ?? row.aiChaseSteps;
    const problem = aiSequencesError(steps, chaseSteps);
    if (problem) throw new CallApiError(400, problem);
    if (input.steps !== undefined) updates.aiSteps = normalizeSteps(input.steps);
    if (input.chaseSteps !== undefined) updates.aiChaseSteps = normalizeSteps(input.chaseSteps);
  }

  if (input.status !== undefined) {
    if (input.status === "active" && !row.aiLaunchedAt) throw new CallApiError(409, "Launch the campaign first");
    updates.status = input.status;
  }

  const [updated] = await db
    .update(callCampaigns)
    .set(updates)
    .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), eq(callCampaigns.runBy, "ai")))
    .returning();
  if (!updated) throw new CallApiError(404, "Campaign not found");
  return toDetail(updated);
}

/** Keeps only the fields a step has, and clears the first step's wait (it runs as soon as the lead is queued). */
export function normalizeSteps(steps: AiCampaignStep[]): AiCampaignStep[] {
  return steps.map((step, index): AiCampaignStep => {
    const delayHours = index === 0 ? 0 : Math.round(step.delayHours);
    return step.kind === "call"
      ? { id: step.id, kind: "call", delayHours, instructions: step.instructions.trim() }
      : { id: step.id, kind: "message", delayHours, body: step.body.trim() };
  });
}

/** Stops it and takes it out of the list. Calls already placed stay on each lead. */
export async function archiveAiCampaign(campaignId: string): Promise<void> {
  await loadCampaignRow(campaignId);
  await db
    .update(callCampaigns)
    .set({ archivedAt: new Date(), status: "paused", updatedAt: new Date() })
    .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), eq(callCampaigns.runBy, "ai")));
}

// --- numbers and launch -------------------------------------------------------

export function parseStationIds(value: unknown): string[] {
  const body = asObject(value, ["stationIds"]);
  const ids = body.stationIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    throw new CallApiError(400, "stationIds must be a list of calling number ids");
  }
  const unique = [...new Set(ids as string[])];
  if (unique.length > MAX_NUMBERS) throw new CallApiError(400, `At most ${MAX_NUMBERS} numbers`);
  return unique;
}

/** Replaces the campaign's numbers. A number must be this organization's and active or still being linked (one already assigned may stay). */
export async function setAiCampaignStations(campaignId: string, stationIds: string[]): Promise<AiCampaignDetail> {
  const row = await loadCampaignRow(campaignId);
  if (stationIds.length) {
    const found = await db
      .select({ id: callingStations.id, status: callingStations.status, name: callingStations.name })
      .from(callingStations)
      .where(and(inOrg(callingStations), inArray(callingStations.id, stationIds)));
    if (found.length !== stationIds.length) throw new CallApiError(404, "Calling number not found");
    const current = new Set(
      (await db.select({ id: callCampaignStations.stationId }).from(callCampaignStations).where(eq(callCampaignStations.campaignId, campaignId))).map((r) => r.id),
    );
    const refused = found.find((station) => !current.has(station.id) && station.status !== "active" && station.status !== "onboarding");
    if (refused) throw new CallApiError(409, `${refused.name} is ${refused.status.replace("_", " ")} and cannot be added`);
  }
  await db.transaction(async (tx) => {
    await tx.delete(callCampaignStations).where(eq(callCampaignStations.campaignId, campaignId));
    if (stationIds.length) await tx.insert(callCampaignStations).values(stationIds.map((stationId) => ({ campaignId, stationId })));
  });
  await db.update(callCampaigns).set({ updatedAt: new Date() }).where(and(inOrg(callCampaigns), eq(callCampaigns.id, row.id)));
  return getAiCampaign(campaignId);
}

/** Validates and starts the campaign: from now the engine places its calls. */
export async function launchAiCampaign(campaignId: string): Promise<AiCampaignDetail> {
  const row = await loadCampaignRow(campaignId);
  const detail = await toDetail(row);
  const blocker = aiLaunchBlocker({
    numbers: detail.numbers.length,
    steps: row.aiSteps,
    instructions: row.aiInstructions,
    goal: row.aiGoal,
    bookingUrl: row.aiBookingUrl,
    leads: detail.leads,
  });
  if (blocker) throw new CallApiError(409, blocker);
  const settings = aiSettingsError({
    goal: row.aiGoal,
    instructions: row.aiInstructions,
    bookingUrl: row.aiBookingUrl,
    bookingMessage: row.aiBookingMessage ?? DEFAULT_BOOKING_MESSAGE,
    maxCallbacks: row.aiMaxCallbacks,
  });
  if (settings) throw new CallApiError(409, settings);
  const sequences = aiSequencesError(row.aiSteps, row.aiChaseSteps);
  if (sequences) throw new CallApiError(409, sequences);
  const now = new Date();
  const [updated] = await db
    .update(callCampaigns)
    .set({ status: "active", aiLaunchedAt: row.aiLaunchedAt ?? now, updatedAt: now })
    .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), eq(callCampaigns.runBy, "ai")))
    .returning();
  if (!updated) throw new CallApiError(404, "Campaign not found");
  return toDetail(updated);
}

// --- leads --------------------------------------------------------------------

function personName(person: Pick<PersonRow, "fullName" | "firstName" | "lastName">): string | null {
  return person.fullName?.trim() || [person.firstName, person.lastName].filter(Boolean).join(" ").trim() || null;
}

function currentStepLabel(row: ContactRow, campaign: Pick<CampaignRow, "aiSteps" | "aiChaseSteps">): string | null {
  switch (row.aiStatus) {
    case "queued":
    case "reaching":
      return aiStepLabel(campaign.aiSteps, row.aiStep, false);
    case "chasing":
      return aiStepLabel(campaign.aiChaseSteps, row.aiStep, true);
    case "callback":
      return `Call back ${row.aiCallbacks + 1}`;
    default:
      return null;
  }
}

/** One lead as the list shows it. `latest` and `callCounts` are per contact id, loaded for the page. */
function toLead(
  row: { contact: ContactRow; person: PersonRow; company: CompanyRow | null },
  campaign: Pick<CampaignRow, "aiSteps" | "aiChaseSteps">,
  latest: Map<string, { outcome: AgentOutcomeKind; summary: string | null; at: string }>,
  callCounts: Map<string, number>,
  stationNames: Map<string, string>,
): AiCampaignLead {
  const { contact, person, company } = row;
  const status = contact.aiStatus ?? "queued";
  const open = (AI_OPEN_STATUSES as readonly string[]).includes(status);
  return {
    id: contact.id,
    personId: person.id,
    name: personName(person),
    title: person.title,
    companyName: personCompanyName(person.raw, company?.name),
    phone: person.phone ?? "",
    status,
    note: contact.aiNote,
    currentStep: currentStepLabel(contact, campaign),
    nextAt: open ? iso(contact.aiNextAt) : null,
    lastOutcome: latest.get(contact.id) ?? null,
    calls: callCounts.get(contact.id) ?? 0,
    numberName: contact.aiStationId ? (stationNames.get(contact.aiStationId) ?? null) : null,
    instructions: contact.aiInstructions,
  };
}

async function leadExtras(contactIds: string[], stationIds: string[]) {
  const latest = new Map<string, { outcome: AgentOutcomeKind; summary: string | null; at: string }>();
  const callCounts = new Map<string, number>();
  const stationNames = new Map<string, string>();
  if (contactIds.length) {
    const [latestRows, countRows] = await Promise.all([
      db
        .selectDistinctOn([callSessions.campaignContactId], { contactId: callSessions.campaignContactId, outcome: callSessions.agentOutcome, at: callSessions.createdAt })
        .from(callSessions)
        .where(and(inOrg(callSessions), inArray(callSessions.campaignContactId, contactIds), sql`${callSessions.agentOutcome} is not null`))
        .orderBy(callSessions.campaignContactId, desc(callSessions.createdAt)),
      db
        .select({ contactId: callSessions.campaignContactId, n: count() })
        .from(callSessions)
        .where(and(inOrg(callSessions), inArray(callSessions.campaignContactId, contactIds), ne(callSessions.status, "pending")))
        .groupBy(callSessions.campaignContactId),
    ]);
    for (const row of latestRows) {
      if (row.contactId && row.outcome) latest.set(row.contactId, { outcome: row.outcome.outcome, summary: row.outcome.summary, at: row.at.toISOString() });
    }
    for (const row of countRows) if (row.contactId) callCounts.set(row.contactId, row.n);
  }
  if (stationIds.length) {
    const rows = await db
      .select({ id: callingStations.id, name: callingStations.name })
      .from(callingStations)
      .where(and(inOrg(callingStations), inArray(callingStations.id, stationIds)));
    for (const row of rows) stationNames.set(row.id, row.name);
  }
  return { latest, callCounts, stationNames };
}

function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function parseAiLeadsQuery(url: URL): AiLeadsQuery {
  const status = url.searchParams.get("status");
  if (status && !(AI_CONTACT_STATUSES as readonly string[]).includes(status)) {
    throw new CallApiError(400, `status must be one of: ${AI_CONTACT_STATUSES.join(", ")}`);
  }
  const number = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === "") return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) throw new CallApiError(400, `${name} must be a positive whole number`);
    return parsed;
  };
  return { status: (status || undefined) as AiContactStatus | undefined, q: url.searchParams.get("q") ?? undefined, page: number("page"), pageSize: number("pageSize") };
}

export async function listAiLeads(campaignId: string, query: AiLeadsQuery): Promise<ListAiLeadsResponse> {
  const campaign = await loadCampaignRow(campaignId);
  const pageSize = Math.min(query.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const page = query.page ?? 1;
  const conditions: (SQL | undefined)[] = [inOrg(people), contactInOrg(), eq(callCampaignContacts.campaignId, campaignId)];
  if (query.status) conditions.push(eq(callCampaignContacts.aiStatus, query.status));
  const q = query.q?.trim();
  if (q) {
    const pattern = likePattern(q);
    const digits = q.replace(/[^\d]/g, "");
    conditions.push(
      or(
        ilike(people.fullName, pattern),
        ilike(people.firstName, pattern),
        ilike(people.lastName, pattern),
        ilike(companies.name, pattern),
        digits.length >= 3 ? sql`regexp_replace(${people.phone}, '[^0-9]', '', 'g') like ${`%${digits}%`}` : undefined,
      ),
    );
  }
  const where = and(...conditions);
  const base = () =>
    db
      .select({ contact: callCampaignContacts, person: people, company: companies })
      .from(callCampaignContacts)
      .innerJoin(people, eq(callCampaignContacts.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id));
  const [rows, [totalRow]] = await Promise.all([
    base()
      .where(where)
      .orderBy(desc(callCampaignContacts.updatedAt), asc(callCampaignContacts.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: count() })
      .from(callCampaignContacts)
      .innerJoin(people, eq(callCampaignContacts.personId, people.id))
      .leftJoin(companies, eq(people.companyId, companies.id))
      .where(where),
  ]);
  const extras = await leadExtras(
    rows.map((row) => row.contact.id),
    [...new Set(rows.flatMap((row) => (row.contact.aiStationId ? [row.contact.aiStationId] : [])))],
  );
  return {
    leads: rows.map((row) => toLead(row, campaign, extras.latest, extras.callCounts, extras.stationNames)),
    total: totalRow?.n ?? 0,
    page,
    pageSize,
  };
}

async function loadContact(campaignId: string, contactId: string) {
  assertUuid(contactId, "Lead");
  const [row] = await db
    .select({ contact: callCampaignContacts, person: people, company: companies })
    .from(callCampaignContacts)
    .innerJoin(people, eq(callCampaignContacts.personId, people.id))
    .leftJoin(companies, eq(people.companyId, companies.id))
    .where(and(inOrg(people), contactInOrg(), eq(callCampaignContacts.campaignId, campaignId), eq(callCampaignContacts.id, contactId)))
    .limit(1);
  if (!row) throw new CallApiError(404, "Lead not found");
  return row;
}

async function leadView(campaign: CampaignRow, row: Awaited<ReturnType<typeof loadContact>>): Promise<AiCampaignLead> {
  const extras = await leadExtras([row.contact.id], row.contact.aiStationId ? [row.contact.aiStationId] : []);
  return toLead(row, campaign, extras.latest, extras.callCounts, extras.stationNames);
}

export function parseUpdateAiLeadRequest(value: unknown): UpdateAiLeadRequest {
  const body = asObject(value, ["action", "instructions"]);
  if (body.instructions !== undefined) {
    if (body.action !== undefined) throw new CallApiError(400, "Send either an action or instructions");
    if (body.instructions === null) return { instructions: null };
    if (typeof body.instructions !== "string") throw new CallApiError(400, "instructions must be text");
    const instructions = body.instructions.trim();
    if (instructions.length > AI_LEAD_MAX_INSTRUCTIONS) throw new CallApiError(400, `The lead's instructions are over ${AI_LEAD_MAX_INSTRUCTIONS} characters`);
    return { instructions: instructions || null };
  }
  if (body.action !== "stop" && body.action !== "requeue") throw new CallApiError(400, "action must be stop or requeue");
  return { action: body.action };
}

/** Stops a lead (no more calls or messages), or puts a failed, unreached or hand-stopped one back in the queue. */
export async function updateAiLead(campaignId: string, contactId: string, input: UpdateAiLeadRequest, userName: string): Promise<AiCampaignLead> {
  const campaign = await loadCampaignRow(campaignId);
  const { contact } = await loadContact(campaignId, contactId);
  const status = contact.aiStatus ?? "queued";
  const now = new Date();
  if ("instructions" in input) {
    await db
      .update(callCampaignContacts)
      .set({ aiInstructions: input.instructions, updatedAt: now })
      .where(and(contactInOrg(), eq(callCampaignContacts.id, contactId), eq(callCampaignContacts.campaignId, campaignId)));
  } else if (input.action === "stop") {
    if (!(AI_OPEN_STATUSES as readonly string[]).includes(status)) throw new CallApiError(409, "Only leads still being worked can be stopped");
    await db
      .update(callCampaignContacts)
      .set({ aiStatus: "stopped", aiNextAt: null, aiNote: `Stopped by ${userName}`, updatedAt: now })
      .where(and(contactInOrg(), eq(callCampaignContacts.id, contactId), eq(callCampaignContacts.campaignId, campaignId)));
  } else {
    const handStopped = status === "stopped" && (contact.aiNote ?? "").startsWith("Stopped by ");
    if (status !== "failed" && status !== "unreached" && !handStopped) {
      throw new CallApiError(409, "Only failed, unreached or hand-stopped leads can be queued again");
    }
    await db.transaction(async (tx) => {
      // Each step key runs once per lead (the claim). Queued again, the lead
      // must be able to run them again: the earlier runs keep their history
      // under a retired key ("reach:call-1@1a2b3c4d"), which describeStepKey
      // reads as the same step.
      await tx
        .update(callCampaignStepRuns)
        .set({ stepKey: sql`${callCampaignStepRuns.stepKey} || '@' || left(${callCampaignStepRuns.id}::text, 8)` })
        .where(and(eq(callCampaignStepRuns.contactId, contactId), ne(callCampaignStepRuns.status, "started"), sql`position('@' in ${callCampaignStepRuns.stepKey}) = 0`));
      await tx
        .update(callCampaignContacts)
        .set({ aiStatus: "queued", aiStep: 0, aiFailures: 0, aiCallbacks: 0, aiNextAt: now, aiNote: null, updatedAt: now })
        .where(and(contactInOrg(), eq(callCampaignContacts.id, contactId), eq(callCampaignContacts.campaignId, campaignId)));
    });
  }
  return leadView(campaign, await loadContact(campaignId, contactId));
}

export async function getAiLeadDetail(campaignId: string, contactId: string): Promise<AiLeadDetail> {
  // A call that never reported back (e.g. a rep campaign's call whose WhatsApp
  // tab was closed) would otherwise stay "queued" here and disable both call buttons.
  await expireStaleCalls();
  const campaign = await loadCampaignRow(campaignId);
  const row = await loadContact(campaignId, contactId);
  const [lead, { activity, summary }] = await Promise.all([
    leadView(campaign, row),
    loadLeadActivity(campaign, { id: row.contact.id, personId: row.contact.personId }),
  ]);
  return { lead, activity, summary };
}

// --- adding leads -------------------------------------------------------------

export function parsePersonIds(value: unknown): string[] {
  const body = asObject(value, ["personIds"]);
  if (!Array.isArray(body.personIds) || body.personIds.some((id) => typeof id !== "string")) {
    throw new CallApiError(400, "personIds must be an array of ids");
  }
  return body.personIds as string[];
}

/** Adds People who have a phone number; each starts queued, to be called as soon as the campaign runs. */
export async function addPeopleToAiCampaign(campaignId: string, personIds: string[]): Promise<AddAiCampaignPeopleResponse> {
  await loadCampaignRow(campaignId);
  const unique = [...new Set(personIds)];
  if (unique.length > MAX_ADD_PEOPLE) throw new CallApiError(400, `Add at most ${MAX_ADD_PEOPLE} people at a time`);
  if (unique.some((id) => !UUID_PATTERN.test(id))) throw new CallApiError(404, "Person not found");
  const result: AddAiCampaignPeopleResponse = { requested: unique.length, added: 0, skippedDuplicate: 0, skippedMissingPhone: 0 };
  if (!unique.length) return result;

  const country = await organizationPhoneCountry();
  const found = await db.select({ id: people.id, phone: people.phone }).from(people).where(and(inOrg(people), inArray(people.id, unique)));
  if (found.length !== unique.length) throw new CallApiError(404, "Person not found");
  const existing = new Set(
    (
      await db
        .select({ personId: callCampaignContacts.personId })
        .from(callCampaignContacts)
        .where(and(contactInOrg(), eq(callCampaignContacts.campaignId, campaignId), inArray(callCampaignContacts.personId, unique)))
    ).map((row) => row.personId),
  );
  const now = new Date();
  const values: (typeof callCampaignContacts.$inferInsert)[] = [];
  for (const person of found) {
    const phone = person.phone ? normalizeCampaignPhone(person.phone, country) : null;
    if (!phone) result.skippedMissingPhone += 1;
    else if (existing.has(person.id)) result.skippedDuplicate += 1;
    else values.push({ campaignId, personId: person.id, aiStatus: "queued", aiNextAt: now });
  }
  if (values.length) {
    const inserted = await db
      .insert(callCampaignContacts)
      .values(values)
      .onConflictDoNothing({ target: [callCampaignContacts.campaignId, callCampaignContacts.personId] })
      .returning({ id: callCampaignContacts.id });
    result.added = inserted.length;
    result.skippedDuplicate += values.length - inserted.length;
  }
  return result;
}

function readSheet(buffer: ArrayBuffer) {
  try {
    return parseImportSheet(buffer);
  } catch (error) {
    throw new CallApiError(400, error instanceof Error ? error.message : "Unable to parse file");
  }
}

/** Headers, the first rows and a suggested column mapping, for the mapping dialog. */
export async function previewAiLeadsUpload(campaignId: string, buffer: ArrayBuffer): Promise<WhatsappCampaignUploadPreview> {
  await loadCampaignRow(campaignId);
  const sheet = readSheet(buffer);
  return { headers: sheet.headers, rows: sheet.rows.slice(0, 5), totalRows: sheet.rows.length, suggestedMapping: suggestWhatsappMapping(sheet.headers) };
}

/** Imports a CSV/XLSX with the phone column mapped; people already known by phone, email or LinkedIn are reused. */
export async function importAiLeads(campaignId: string, buffer: ArrayBuffer, rawMapping: unknown): Promise<AiLeadsImportResponse> {
  await loadCampaignRow(campaignId);
  const sheet = readSheet(buffer);
  const mappingError = importMappingError(rawMapping, sheet.headers);
  if (mappingError) throw new CallApiError(400, mappingError);
  const mapping: ImportMapping = {};
  for (const field of WHATSAPP_CAMPAIGN_IMPORT_FIELDS) {
    const header = (rawMapping as Record<string, unknown>)[field.key];
    if (typeof header === "string" && header) mapping[field.key] = header;
  }
  if (sheet.rows.length > WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS) throw new CallApiError(400, `Too many rows (max ${WHATSAPP_CAMPAIGN_MAX_IMPORT_ROWS})`);

  const country = await organizationPhoneCountry();
  const normalize = (input: string) => normalizeCampaignPhone(input, country);
  let added = 0;
  let alreadyInCampaign = 0;
  const skipped: string[] = [];
  const skip = (message: string) => {
    if (skipped.length < MAX_SKIPPED_REPORTED) skipped.push(message);
  };
  for (let index = 0; index < sheet.rows.length; index += 1) {
    const rowNumber = sheet.rowNumbers[index]!;
    const { person } = mapImportRow(sheet.rows[index]!, sheet.headers, mapping);
    const resolved = resolveImportRow(person, rowNumber, normalize);
    if (!resolved.ok) {
      skip(resolved.message);
      continue;
    }
    try {
      const inserted = await withLeadTransaction(async (tx) => {
        const found = await findOrCreateContactPerson(
          tx,
          {
            fullName: resolved.fullName,
            phone: resolved.phone,
            companyName: resolved.companyName,
            companyDomain: resolved.companyDomain,
            title: resolved.title,
            email: resolved.email,
            linkedinUrl: resolved.linkedinUrl,
          },
          LEAD_SOURCE,
        );
        const [row] = await tx
          .insert(callCampaignContacts)
          .values({ campaignId, personId: found.id, aiStatus: "queued", aiNextAt: new Date() })
          .onConflictDoNothing({ target: [callCampaignContacts.campaignId, callCampaignContacts.personId] })
          .returning({ id: callCampaignContacts.id });
        return Boolean(row);
      });
      if (inserted) added += 1;
      else alreadyInCampaign += 1;
    } catch (error) {
      skip(`row ${rowNumber}: ${error instanceof Error ? error.message : "could not be added"}`);
    }
  }
  return { added, alreadyInCampaign, skipped };
}

// --- stats --------------------------------------------------------------------

/** Folds step runs onto the campaign's steps (retries count toward their step); pure, unit-tested. */
export function foldStepRuns(
  runs: Array<{ stepKey: string; kind: "call" | "message"; status: "started" | "done" | "failed"; result: string | null; n: number }>,
  campaign: Pick<CampaignRow, "aiSteps" | "aiChaseSteps">,
): AiStepStat[] {
  const stats = new Map<string, AiStepStat>();
  const ensure = (key: string, init: () => AiStepStat) => {
    let stat = stats.get(key);
    if (!stat) {
      stat = init();
      stats.set(key, stat);
    }
    return stat;
  };
  // Configured steps first, in order, even before they have run.
  const place = (steps: AiCampaignStep[], phase: "reach" | "chase") => {
    steps.forEach((step, index) => {
      const key = `${phase}:${step.id}`;
      stats.set(key, {
        key,
        phase,
        stepId: step.id,
        kind: step.kind,
        label: `${phase === "chase" ? "Chase · " : ""}${aiStepLabel(steps, index, false) ?? step.id}`,
        attempted: 0,
        done: 0,
        failed: 0,
        conversations: 0,
      });
    });
  };
  place(campaign.aiSteps, "reach");
  place(campaign.aiChaseSteps, "chase");
  for (const run of runs) {
    const described = describeStepKey(run.stepKey);
    const key = described.stepId ? `${described.phase}:${described.stepId}` : `system:${described.label}`;
    const stat = ensure(key, () => ({
      key,
      phase: described.phase,
      stepId: described.stepId,
      kind: run.kind,
      label: described.stepId ? `${described.label} (removed step)` : described.label,
      attempted: 0,
      done: 0,
      failed: 0,
      conversations: 0,
    }));
    stat.attempted += run.n;
    if (run.status === "done") stat.done += run.n;
    if (run.status === "failed") stat.failed += run.n;
    if (run.result === "conversation") stat.conversations += run.n;
  }
  return [...stats.values()];
}

export async function getAiCampaignStats(campaignId: string): Promise<AiCampaignStats> {
  const campaign = await loadCampaignRow(campaignId);
  const [timeZone, start] = await Promise.all([orgTimeZone(), todayStart()]);
  const contactIds = db
    .select({ id: callCampaignContacts.id })
    .from(callCampaignContacts)
    .where(and(contactInOrg(), eq(callCampaignContacts.campaignId, campaignId)));
  const outcomeText = sql<string | null>`${callSessions.agentOutcome}->>'outcome'`;
  const day = sql<string>`to_char((${callSessions.createdAt} at time zone ${timeZone}::text)::date, 'YYYY-MM-DD')`;
  const sinceDay = sql`((now() at time zone ${timeZone}::text)::date - ${CALLS_BY_DAY - 1}::int)`;
  const sessionScope = and(inOrg(callSessions), inArray(callSessions.campaignContactId, contactIds), ne(callSessions.status, "pending"));

  const [statusRows, callTotals, outcomeRows, interestedRows, runRows, dayRows, numbers, rules] = await Promise.all([
    db
      .select({ status: callCampaignContacts.aiStatus, n: count() })
      .from(callCampaignContacts)
      .where(and(contactInOrg(), eq(callCampaignContacts.campaignId, campaignId)))
      .groupBy(callCampaignContacts.aiStatus),
    db
      .select({
        placed: count(),
        answered: sql<number>`count(*) filter (where ${callSessions.status} = 'recorded')`.mapWith(Number),
        today: sql<number>`count(*) filter (where ${callSessions.createdAt} >= ${start})`.mapWith(Number),
      })
      .from(callSessions)
      .where(sessionScope),
    db.select({ outcome: outcomeText, n: count() }).from(callSessions).where(and(sessionScope, sql`${callSessions.agentOutcome} is not null`)).groupBy(outcomeText),
    db
      .select({ n: sql<number>`count(distinct ${callSessions.campaignContactId})`.mapWith(Number) })
      .from(callSessions)
      .where(and(sessionScope, inArray(outcomeText, INTERESTED_OUTCOMES))),
    db
      .select({
        stepKey: callCampaignStepRuns.stepKey,
        kind: callCampaignStepRuns.kind,
        status: callCampaignStepRuns.status,
        result: callCampaignStepRuns.result,
        n: count(),
      })
      .from(callCampaignStepRuns)
      .where(inArray(callCampaignStepRuns.contactId, contactIds))
      .groupBy(callCampaignStepRuns.stepKey, callCampaignStepRuns.kind, callCampaignStepRuns.status, callCampaignStepRuns.result),
    db
      .select({
        day,
        placed: count(),
        answered: sql<number>`count(*) filter (where ${callSessions.status} = 'recorded')`.mapWith(Number),
      })
      .from(callSessions)
      .where(and(sessionScope, sql`(${callSessions.createdAt} at time zone ${timeZone}::text)::date >= ${sinceDay}`))
      // By position: the zone is a bound parameter, so the expression would not match itself in GROUP BY.
      .groupBy(sql`1`),
    loadNumbers([campaignId]),
    channelRules("whatsapp"),
  ]);

  const byStatus = { ...AI_EMPTY_STATUS_COUNTS };
  let total = 0;
  for (const row of statusRows) {
    total += row.n;
    if (row.status) byStatus[row.status] += row.n;
    else byStatus.queued += row.n;
  }
  const outcomes: AiCampaignStats["outcomes"] = {};
  for (const row of outcomeRows) {
    if (row.outcome && (AGENT_OUTCOMES as readonly string[]).includes(row.outcome)) outcomes[row.outcome as AgentOutcomeKind] = row.n;
  }
  const perStep = foldStepRuns(runRows, campaign);
  const conversations = perStep.reduce((sum, step) => sum + (step.kind === "call" ? step.conversations : 0), 0);
  const messagesSent = runRows.filter((run) => run.kind === "message" && run.status === "done").reduce((sum, run) => sum + run.n, 0);

  const perDay = new Map(dayRows.map((row) => [row.day, row]));
  const callsByDay: AiCampaignStats["callsByDay"] = [];
  const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m, d] = todayKey.split("-").map(Number) as [number, number, number];
  for (let back = CALLS_BY_DAY - 1; back >= 0; back -= 1) {
    const date = new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
    const found = perDay.get(date);
    callsByDay.push({ date, placed: found?.placed ?? 0, answered: found?.answered ?? 0 });
  }

  const totals = callTotals[0] ?? { placed: 0, answered: 0, today: 0 };
  return {
    total,
    byStatus,
    callsPlaced: totals.placed,
    callsAnswered: totals.answered,
    conversations,
    outcomes,
    interested: interestedRows[0]?.n ?? 0,
    messagesSent,
    booked: byStatus.booked,
    handoffs: byStatus.handoff,
    callsToday: totals.today,
    callsPerDayLimit: callsPerDayLimit(numbers.get(campaignId) ?? [], rules.callsPerDay),
    perStep,
    callsByDay,
  };
}

/**
 * A trial call to one lead now, from the campaign's number (the lead's own,
 * or the campaign's first active one), with what a campaign call carries —
 * its instructions, the first call step's, the lead's own, its knowledge,
 * goal and agent. Outside the sequence: no step is used up and the lead's
 * position is unchanged (the engine waits while it is open). Works on a draft
 * campaign too, so a campaign can be tried on yourself before launch.
 * With `remoteRep` it is the rep's own call from that number, talking from
 * their tab (contract.ts, "a rep talking through a calling station"): no
 * agent, brief or persona.
 */
export async function callAiLeadNow(campaignId: string, contactId: string, request: CallAiLeadRequest = {}): Promise<CallAiLeadResponse> {
  const campaign = await loadCampaignRow(campaignId);
  const { contact } = await loadContact(campaignId, contactId);
  const [open] = await db
    .select({ id: callSessions.id })
    .from(callSessions)
    .where(and(inOrg(callSessions), eq(callSessions.campaignContactId, contactId), inArray(callSessions.status, ["pending", "in_progress"])))
    .limit(1);
  if (open) throw new CallApiError(409, "A call to this lead is already under way");
  const stations = await db
    .select({ id: callingStations.id, name: callingStations.name })
    .from(callCampaignStations)
    .innerJoin(callingStations, eq(callingStations.id, callCampaignStations.stationId))
    .where(and(eq(callCampaignStations.campaignId, campaignId), inOrg(callingStations), eq(callingStations.status, "active")))
    .orderBy(asc(callingStations.name));
  const station = stations.find((candidate) => candidate.id === contact.aiStationId) ?? stations[0];
  if (!station) throw new CallApiError(409, "Choose an active calling number for this campaign first");
  if (request.remoteRep) {
    const started = await startCall({
      personId: contact.personId,
      campaignContactId: contact.id,
      mode: "agent_cloud",
      stationId: station.id,
      remoteRep: true,
    });
    return { callId: started.call.id, numberName: station.name };
  }
  const firstCall = campaign.aiSteps.find((step) => step.kind === "call");
  const started = await startCall({
    personId: contact.personId,
    campaignContactId: contact.id,
    mode: "agent_cloud",
    stationId: station.id,
    agentBrief: await agentBrief({
      campaignInstructions: campaign.aiInstructions,
      purpose: "reach",
      stepInstructions: firstCall?.kind === "call" ? firstCall.instructions : null,
      leadInstructions: contact.aiInstructions,
    }),
    agentName: campaign.aiAgentName,
    agentVoice: campaign.aiAgentVoice,
  });
  // The engine settles it like a placed step: a call-back, the booking link, the lead's status.
  await db
    .insert(callCampaignStepRuns)
    .values({ contactId: contact.id, stepKey: drawerCallStepKey(started.call.id), kind: "call", status: "started", stationId: station.id, callSessionId: started.call.id })
    .onConflictDoNothing();
  return { callId: started.call.id, numberName: station.name };
}
