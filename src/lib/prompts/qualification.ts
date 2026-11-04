import type { PromptDefinition } from "./types";

/** Prospecting's domain qualification (src/lib/qualification/parentLookup.ts). The domain is the user message. */
export const QUALIFICATION_PROMPTS = {
  "qualification/parent-domain-system": {
    description: "Finds the parent company domain of an e-commerce store with web search; the store's domain is the user message.",
    template: "Identify the parent company domain for this e-commerce store. Use web search to research ownership, parent company, brand operator, and official company references before deciding. If it is independently owned or uncertain, return null. Submit the answer by calling the report_parent_domain function.",
  },
} satisfies Record<string, PromptDefinition>;
