import "server-only";

import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import { getPrompt } from "@/lib/observability/langfuse";
import type { PromptName } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { buildClassificationContext } from "../context";
import { classificationApplicationDecision } from "../stateMachine";
import type {
  ClassifyCrmReplyInput,
  ClassificationCompletion,
  ClassificationCompletionInput,
  ClassificationCompletionResult,
  ClassificationContextInput,
  ClassificationSubcategory,
  CrmClassificationResult,
  CrmClassifierOutput,
} from "./types";

const OUTPUT_KEYS = new Set([
  "categoryKey",
  "subcategoryKey",
  "confidence",
  "reasoning",
  "suggestedNextActionAt",
]);
const CATEGORY_KEYS = new Set(["customer", "interested", "not_interested", "other"]);

const DEFAULT_TIMEOUT_MS = 30_000;
// Reasoning models think inside this budget before the call; see structuredCompletion.
const DEFAULT_MAX_OUTPUT_TOKENS = 4_000;

/** The prompts a classification is built from (src/lib/prompts/crm.ts). */
export const CLASSIFICATION_PROMPTS = [
  "crm/classify-system",
  "crm/classify-channel-notes",
  "crm/classify-user",
] as const satisfies readonly PromptName[];
export type ClassificationTemplates = PromptTemplates<(typeof CLASSIFICATION_PROMPTS)[number]>;
const CODE_CLASSIFICATION_TEMPLATES = codeTemplates(CLASSIFICATION_PROMPTS);

/**
 * What the classifier is told about channels whose messages read differently
 * from email. Empty for email and LinkedIn, so their prompts are unchanged.
 */
export function classificationChannelNotes(
  input: Pick<ClassificationContextInput, "latestInboundMessage" | "recentConversation">,
  template: string = CODE_CLASSIFICATION_TEMPLATES["crm/classify-channel-notes"],
): string[] {
  const channels = new Set([input.latestInboundMessage, ...input.recentConversation].map((message) => message.channel));
  return fillPrompt(template, {
    whatsapp: channels.has("whatsapp"),
    // A call being classified itself (calls/leadStageRules.ts) carries its own framing.
    whatsapp_call_background: channels.has("whatsapp_call") && input.latestInboundMessage.channel !== "whatsapp_call",
  }).split(/\n{2,}/).map((note) => note.trim()).filter(Boolean);
}

/** The classifier's system and user messages. */
export function buildClassificationPrompt(
  input: Pick<ClassifyCrmReplyInput, "latestInboundMessage" | "recentConversation" | "instructions">,
  context: string,
  templates: ClassificationTemplates = CODE_CLASSIFICATION_TEMPLATES,
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: fillPrompt(templates["crm/classify-system"], { instructions: input.instructions?.trim() }),
    userPrompt: fillPrompt(templates["crm/classify-user"], {
      channel_notes: classificationChannelNotes(input, templates["crm/classify-channel-notes"]).join("\n\n"),
      context,
    }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseStrictJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("CRM classifier returned malformed JSON");
  }
}

function activeTaxonomy(input: Pick<ClassificationContextInput, "categories" | "subcategories">) {
  const categoryKeys = new Set(input.categories.map((category) => category.key));
  if (!categoryKeys.size) throw new Error("CRM classification requires at least one active category");
  if (categoryKeys.size !== input.categories.length) {
    throw new Error("CRM classification categories contain duplicate keys");
  }
  for (const categoryKey of categoryKeys) {
    if (!CATEGORY_KEYS.has(categoryKey)) {
      throw new Error(`CRM classification received unknown fixed category: ${categoryKey}`);
    }
  }

  const subcategoryByKey = new Map<string, ClassificationSubcategory>();
  for (const subcategory of input.subcategories) {
    const key = subcategory.key.trim();
    if (!key) throw new Error("CRM classification subcategories require a key");
    if (!categoryKeys.has(subcategory.categoryKey)) {
      throw new Error(`Subcategory ${key} belongs to an inactive category`);
    }
    if (subcategoryByKey.has(key)) {
      throw new Error(`CRM classification subcategory key is duplicated: ${key}`);
    }
    subcategoryByKey.set(key, { ...subcategory, key });
  }
  return { categoryKeys, subcategoryByKey };
}

export function classifierJsonSchema(
  input: Pick<ClassificationContextInput, "categories" | "subcategories">,
): Record<string, unknown> {
  const { categoryKeys, subcategoryByKey } = activeTaxonomy(input);
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "categoryKey",
      "subcategoryKey",
      "confidence",
      "reasoning",
      "suggestedNextActionAt",
    ],
    properties: {
      categoryKey: { type: "string", enum: [...categoryKeys] },
      subcategoryKey: subcategoryByKey.size
        ? {
            anyOf: [
              { type: "string", enum: [...subcategoryByKey.keys()] },
              { type: "null" },
            ],
          }
        : { type: "null" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reasoning: { type: "string", minLength: 1, maxLength: 4_000 },
      suggestedNextActionAt: {
        anyOf: [
          { type: "string", format: "date-time" },
          { type: "null" },
        ],
      },
    },
  };
}

export function validateClassifierOutput(
  raw: unknown,
  input: Pick<ClassificationContextInput, "categories" | "subcategories">,
): CrmClassifierOutput & {
  subcategoryId: string | null;
  subcategoryReviewRequired: boolean;
  subcategoryStageRank: number | null;
} {
  const value = typeof raw === "string" ? parseStrictJson(raw) : raw;
  if (!isPlainObject(value)) throw new Error("CRM classifier output must be a JSON object");

  const keys = Object.keys(value);
  const unknown = keys.filter((key) => !OUTPUT_KEYS.has(key));
  if (unknown.length) {
    throw new Error(`CRM classifier returned unknown field(s): ${unknown.join(", ")}`);
  }
  const missing = [...OUTPUT_KEYS].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) {
    throw new Error(`CRM classifier omitted required field(s): ${missing.join(", ")}`);
  }

  const { categoryKeys, subcategoryByKey } = activeTaxonomy(input);
  if (typeof value.categoryKey !== "string" || !categoryKeys.has(value.categoryKey as never)) {
    throw new Error(`CRM classifier returned unknown category key: ${String(value.categoryKey)}`);
  }
  const categoryKey = value.categoryKey as CrmClassifierOutput["categoryKey"];

  if (value.subcategoryKey !== null && typeof value.subcategoryKey !== "string") {
    throw new Error("CRM classifier subcategoryKey must be a string or null");
  }
  const subcategory = value.subcategoryKey === null
    ? null
    : subcategoryByKey.get(value.subcategoryKey);
  if (value.subcategoryKey !== null && !subcategory) {
    throw new Error(`CRM classifier returned unknown subcategory key: ${value.subcategoryKey}`);
  }
  if (subcategory && subcategory.categoryKey !== categoryKey) {
    throw new Error(
      `CRM classifier subcategory ${subcategory.key} does not belong to category ${categoryKey}`,
    );
  }

  if (typeof value.confidence !== "number" || !Number.isFinite(value.confidence)) {
    throw new Error("CRM classifier confidence must be a finite number");
  }
  if (value.confidence < 0 || value.confidence > 1) {
    throw new Error("CRM classifier confidence must be between 0 and 1");
  }
  if (typeof value.reasoning !== "string" || !value.reasoning.trim()) {
    throw new Error("CRM classifier reasoning is required");
  }
  if (value.reasoning.length > 4_000) {
    throw new Error("CRM classifier reasoning is too long");
  }

  if (value.suggestedNextActionAt !== null) {
    if (
      typeof value.suggestedNextActionAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.suggestedNextActionAt)
      || Number.isNaN(Date.parse(value.suggestedNextActionAt))
    ) {
      throw new Error("CRM classifier suggestedNextActionAt must be an ISO 8601 timestamp or null");
    }
  }

  return {
    categoryKey,
    subcategoryKey: subcategory?.key ?? null,
    subcategoryId: subcategory?.id ?? null,
    subcategoryReviewRequired: subcategory?.reviewRequired ?? false,
    subcategoryStageRank: subcategory?.stageRank ?? null,
    confidence: value.confidence,
    reasoning: value.reasoning.trim(),
    suggestedNextActionAt: value.suggestedNextActionAt,
  };
}

export const completeClassificationWithOpenRouter: ClassificationCompletion = async (
  input: ClassificationCompletionInput,
): Promise<ClassificationCompletionResult> => {
  const tool = await getPrompt("crm/classify-tool");
  return completeStructuredWithOpenRouter({
    requestedModel: input.requestedModel,
    timeoutMs: input.timeoutMs,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    maxOutputTokens: input.maxOutputTokens,
    jsonSchema: input.jsonSchema,
    schemaName: "crm_reply_classification",
    schemaDescription: tool.text,
    accept: input.accept,
    signal: input.signal,
    trace: {
      name: input.trace?.name ?? "crm-classify",
      ...input.trace,
      prompts: [...(input.trace?.prompts ?? []), tool],
    },
  });
};

export async function classifyCrmReply(
  input: ClassifyCrmReplyInput,
  dependencies: { complete?: ClassificationCompletion } = {},
): Promise<CrmClassificationResult> {
  if (input.currentClassification.categoryLocked && input.currentClassification.categoryKey !== "customer") {
    throw new Error("Only Customer classifications may be locked");
  }
  if (
    !Number.isFinite(input.policy.autoApplyConfidence)
    || input.policy.autoApplyConfidence < 0
    || input.policy.autoApplyConfidence > 1
  ) {
    throw new Error("CRM auto-apply confidence must be between 0 and 1");
  }

  const context = buildClassificationContext(input, {
    maxTokens: input.maxContextTokens,
  });
  const jsonSchema = classifierJsonSchema(input);
  const { templates, prompts } = await resolveTemplates(CLASSIFICATION_PROMPTS);
  const completion = await (dependencies.complete ?? completeClassificationWithOpenRouter)({
    ...buildClassificationPrompt(input, context.prompt, templates),
    jsonSchema,
    // Validated inside the completion so an off-schema call is retried
    // rather than failing the job; validated again below for the result.
    accept: (text) => { validateClassifierOutput(text, input); },
    requestedModel: input.requestedModel,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    signal: input.signal,
    trace: {
      name: input.trace?.name ?? "crm-classify",
      prompts: [...prompts, ...(input.trace?.prompts ?? [])],
      sessionId: input.trace?.sessionId,
      metadata: {
        ...input.trace?.metadata,
        latestInboundMessageId: input.latestInboundMessage.id,
        channel: input.latestInboundMessage.channel,
      },
    },
  });
  const validated = validateClassifierOutput(completion.text, input);
  const decision = classificationApplicationDecision({
    currentCategoryKey: input.currentClassification.categoryKey,
    currentCategoryLocked: input.currentClassification.categoryLocked,
    proposedCategoryKey: validated.categoryKey,
    confidence: validated.confidence,
    autoApplyConfidence: input.policy.autoApplyConfidence,
    reviewOther: input.policy.reviewOther,
    customerRequiresReview: input.policy.customerRequiresReview,
    subcategoryReviewRequired: validated.subcategoryReviewRequired,
    currentStageRank: input.currentClassification.stageRank ?? null,
    proposedStageRank: validated.subcategoryStageRank,
    proposedSubcategoryKey: validated.subcategoryKey,
  });

  return {
    ...validated,
    decision,
    requiresReview: decision !== "auto_apply",
    applicationTarget: decision === "auto_apply"
      ? { categoryKey: validated.categoryKey, subcategoryId: validated.subcategoryId }
      : null,
    provider: completion.provider,
    model: completion.model,
    request: completion.request,
    response: completion.response,
    usage: completion.usage,
    context,
  };
}
