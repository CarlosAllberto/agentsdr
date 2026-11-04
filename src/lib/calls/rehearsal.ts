import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { companies, people } from "@/lib/leads/schema";
import { personCompanyName } from "@/lib/leads/companyName";
import { loadAgentContext, loadRehearsalContext, type AgentPromptContext } from "./agentContext";
import { agentBrief } from "./aiCampaigns/brief.server";
import { MAX_AGENT_BRIEF_CHARS, type AgentTokenRequest, type RecorderLead } from "./contract";
import { agentKnowledge, parseAgentName, parseAgentVoice, type KnowledgeDocument } from "./liveAgent";
import { callCampaignContacts, callCampaigns } from "./schema";
import { CallApiError, recorderLeadFor } from "./sessions";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A made-up lead, so a rehearsal needs no real person. */
export const REHEARSAL_LEAD: RecorderLead = { name: "Asha Verma", detail: "Marketing head · Acme", firstName: "Asha", company: "Acme" };

export type Rehearsal = { request: AgentTokenRequest; knowledge: KnowledgeDocument[]; context: AgentPromptContext };

/**
 * What a rehearsal plays: the session an AI campaign's call would get
 * (campaignId: its saved instructions, this call step, name, voice and goal)
 * or a free brief. Typed (POST …/rehearse) and spoken (POST …/rehearse/voice)
 * rehearsals both build it here, so they cannot drift apart. Runs in the
 * caller's organization scope.
 */
export async function resolveRehearsal(body: Record<string, unknown>): Promise<Rehearsal> {
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  let brief = text(body.brief);
  let name = parseAgentName(body.name);
  let voice = parseAgentVoice(body.voice);
  let goal: AgentPromptContext["goal"] = null;
  let knowledgeIds: string[] | null = null;
  let lead: RecorderLead = REHEARSAL_LEAD;
  let context: AgentPromptContext | null = null;
  if (body.campaignId !== undefined && body.campaignId !== null && body.campaignId !== "") {
    const campaignId = text(body.campaignId);
    if (!UUID_RE.test(campaignId)) throw new CallApiError(400, "campaignId must be a UUID");
    const [campaign] = await db
      .select()
      .from(callCampaigns)
      .where(and(inOrg(callCampaigns), eq(callCampaigns.id, campaignId), eq(callCampaigns.runBy, "ai")))
      .limit(1);
    if (!campaign) throw new CallApiError(404, "AI campaign not found");

    // Rehearsing as one of its leads: their name, company, history and own instructions.
    let contact: { id: string; personId: string; instructions: string | null } | null = null;
    if (body.contactId !== undefined && body.contactId !== null && body.contactId !== "") {
      const contactId = text(body.contactId);
      if (!UUID_RE.test(contactId)) throw new CallApiError(400, "contactId must be a UUID");
      const [found] = await db
        .select({ contact: callCampaignContacts, person: people, companyName: companies.name })
        .from(callCampaignContacts)
        .innerJoin(people, eq(people.id, callCampaignContacts.personId))
        .leftJoin(companies, eq(companies.id, people.companyId))
        .where(and(inOrg(people), eq(callCampaignContacts.id, contactId), eq(callCampaignContacts.campaignId, campaign.id)))
        .limit(1);
      if (!found) throw new CallApiError(404, "Lead not found");
      contact = { id: found.contact.id, personId: found.person.id, instructions: found.contact.aiInstructions };
      lead = recorderLeadFor(found.person, personCompanyName(found.person.raw, found.companyName));
    }

    const callSteps = [...campaign.aiSteps, ...campaign.aiChaseSteps].filter((step) => step.kind === "call");
    const step = callSteps.find((candidate) => candidate.id === body.stepId) ?? callSteps[0];
    brief = await agentBrief({
      campaignInstructions: campaign.aiInstructions,
      purpose: "reach",
      stepInstructions: step?.kind === "call" ? step.instructions : null,
      leadInstructions: contact?.instructions ?? null,
    });
    name = campaign.aiAgentName?.trim() || name;
    voice = campaign.aiAgentVoice ?? voice;
    goal = { goal: campaign.aiGoal, bookingUrl: campaign.aiBookingUrl };
    knowledgeIds = campaign.aiKnowledgeIds ?? null;
    if (contact) {
      // What a real call to them would know, history included (nothing earlier than now is excluded).
      context = await loadAgentContext({ id: crypto.randomUUID(), personId: contact.personId, campaignContactId: contact.id, createdAt: new Date() });
    }
  }
  if (!brief) throw new CallApiError(400, "The agent needs a brief");
  if (brief.length > MAX_AGENT_BRIEF_CHARS) throw new CallApiError(400, `The brief is over ${MAX_AGENT_BRIEF_CHARS} characters`);
  const [knowledge, resolvedContext] = await Promise.all([agentKnowledge(knowledgeIds), context ?? loadRehearsalContext(goal)]);
  return { request: { brief, lead, name, voice }, knowledge, context: resolvedContext };
}
