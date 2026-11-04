import type { PromptDefinition } from "./types";

/**
 * Wording every structured model call shares (src/lib/ai/server/structuredCompletion.ts):
 * the answer is one function call, never prose.
 */
export const SHARED_PROMPTS = {
  "shared/structured-output": {
    description: "Appended to every structured call's system prompt: answer only by calling the one offered function.",
    template: "You must answer by calling the {{schema_name}} function exactly once with every required argument. Never answer in prose.",
  },
  "shared/tool-description": {
    description: "The offered function's description when the caller gives none.",
    template: "Submit the structured result. Call it exactly once; it is the only way to answer.",
  },
} satisfies Record<string, PromptDefinition>;
