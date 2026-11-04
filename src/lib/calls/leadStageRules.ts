import type {
  ClassificationCategory,
  ClassificationCompanyProfile,
  ClassificationKnowledgeDocument,
  ClassificationPersonProfile,
  ClassificationPolicy,
  ClassificationSubcategory,
  ClassifyCrmReplyInput,
  CurrentClassification,
} from "@/lib/crm/ai/types";
import { PROMPTS } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import { LEAD_STAGE_CATEGORIES, type CallTranscript, type LeadStageCategory } from "./contract";

/**
 * The pure half of src/lib/calls/leadStage.ts — no database, no model — so
 * it can be unit-tested and read without either.
 */

/**
 * The seeded "Do Not Contact" subcategory, identified by its immutable key the
 * same way the CRM does (crm/handlers.ts classifiedIntoDoNotContactSubcategory,
 * crm/stateMachine.ts isBackwardStageMove) — never by its editable name.
 */
export const DO_NOT_CONTACT_SUBCATEGORY_KEY = "do_not_contact";

export function isLeadStageCategory(value: unknown): value is LeadStageCategory {
  return typeof value === "string" && (LEAD_STAGE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Why a stage target cannot be set on a record in `pipelineId`, or null when
 * it can. `subcategory` is the row `subcategoryId` resolved to (null when it
 * matched nothing). Mirrors the checks records.ts's validateSubcategory makes
 * inside the transaction, so a bad request is a 400 with a message a rep can
 * read rather than a conflict from deep in the CRM.
 */
export function leadStageTargetError(input: {
  categoryKey: LeadStageCategory;
  subcategoryId: string | null;
  subcategory: { pipelineId: string; categoryKey: string; active: boolean } | null;
  pipelineId: string;
}): string | null {
  if (!input.subcategoryId) return null;
  if (!input.subcategory || input.subcategory.pipelineId !== input.pipelineId) {
    return "That stage does not exist";
  }
  if (input.subcategory.categoryKey !== input.categoryKey) {
    return "That stage does not belong to the chosen category";
  }
  if (!input.subcategory.active) return "That stage has been archived";
  return null;
}

/**
 * A person can hold a record in more than one pipeline; Calling shows one.
 * The default pipeline's wins, then the most recently updated — the same
 * record getOrCreateCrmRecordForCall reaches for, so what a rep sets is what
 * they then see.
 */
export function pickRepresentativeRecord<T extends { isDefaultPipeline: boolean; updatedAt: Date }>(
  records: readonly T[],
): T | null {
  let best: T | null = null;
  for (const record of records) {
    if (
      !best
      || (record.isDefaultPipeline && !best.isDefaultPipeline)
      || (record.isDefaultPipeline === best.isDefaultPipeline && record.updatedAt > best.updatedAt)
    ) {
      best = record;
    }
  }
  return best;
}

/**
 * The transcript as plain text the reply classifier can read as "the lead's
 * message": crm/classify-call-transcript, filled with the summary and the
 * Rep/Lead lines.
 */
export function formatTranscriptForClassification(
  transcript: Pick<CallTranscript, "summary" | "utterances">,
  template: string = PROMPTS["crm/classify-call-transcript"].template,
): string {
  const lines = transcript.utterances.map(
    (utterance) => `${utterance.speaker === "rep" ? "Rep" : "Lead"}: ${utterance.text.trim()}`,
  );
  return fillPrompt(template, { summary: transcript.summary.trim(), transcript: lines.join("\n") });
}

/**
 * The reply classifier's input, with the call's transcript standing in for
 * the latest inbound message. The call is the whole conversation: an email or
 * LinkedIn thread is deliberately left out, as it is the call being judged.
 */
export function buildCallClassificationInput(input: {
  callId: string;
  occurredAt: Date;
  transcript: Pick<CallTranscript, "summary" | "utterances">;
  categories: readonly ClassificationCategory[];
  subcategories: readonly ClassificationSubcategory[];
  person: ClassificationPersonProfile;
  company: ClassificationCompanyProfile | null;
  currentClassification: CurrentClassification;
  campaign: { id: string; name: string; description: string | null } | null;
  knowledge: readonly ClassificationKnowledgeDocument[];
  policy: ClassificationPolicy;
  instructions?: string | null;
  /** crm/classify-call-transcript from Langfuse; the copy in code otherwise. */
  transcriptTemplate?: string;
}): ClassifyCrmReplyInput {
  const message = {
    id: input.callId,
    channel: "whatsapp_call" as const,
    direction: "inbound" as const,
    sentAt: input.occurredAt,
    subject: "WhatsApp call transcript",
    bodyText: formatTranscriptForClassification(input.transcript, input.transcriptTemplate),
  };
  return {
    categories: input.categories,
    subcategories: input.subcategories,
    person: input.person,
    company: input.company,
    currentClassification: input.currentClassification,
    latestInboundMessage: message,
    recentConversation: [message],
    campaignSummary: input.campaign
      ? {
          channel: null,
          campaignId: input.campaign.id,
          name: input.campaign.name,
          source: "WhatsApp cold-calling campaign",
          summary: input.campaign.description,
        }
      : null,
    knowledge: input.knowledge,
    policy: input.policy,
    instructions: input.instructions ?? null,
  };
}

/**
 * True when a person set the record's stage at or after the call began — the
 * rep's own judgement of this call (or a later one), which the transcript's
 * reading must not replace. A human stage set before the call is older than
 * the call's evidence and may be moved, subject to the usual policy
 * (classificationApplicationDecision never moves a ranked stage backwards).
 */
export function humanStageSetSinceCall(input: {
  categorySource: "ai" | "human" | "integration" | null;
  lastHumanStageAt: Date | null;
  callStartedAt: Date;
}): boolean {
  if (input.categorySource !== "human") return false;
  // A human source with no event to date it (a record set before events
  // existed) is treated as newer: never overwrite what we cannot date.
  if (!input.lastHumanStageAt) return true;
  return input.lastHumanStageAt >= input.callStartedAt;
}

/**
 * The follow-up date a classifier's suggestion gives a campaign contact: only
 * when the contact has none and the suggestion is a valid time in the future.
 */
export function followUpFromSuggestion(
  suggestedNextActionAt: string | null,
  currentFollowUpAt: Date | null,
  now: Date,
): Date | null {
  if (currentFollowUpAt || !suggestedNextActionAt) return null;
  const at = new Date(suggestedNextActionAt);
  if (Number.isNaN(at.getTime()) || at <= now) return null;
  return at;
}
