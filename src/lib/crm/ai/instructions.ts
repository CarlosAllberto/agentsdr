/**
 * Workspace-written instructions for the CRM's AI (crm_settings.draft_instructions
 * and .classification_instructions, edited on CRM Settings).
 *
 * Each is a list of titled blocks ("Tone", "Who we are", "Pricing rules"),
 * stored as jsonb and rendered into one Markdown section per block.
 *
 * They go into the system prompt, after the fixed rules, because they come from
 * the people running the CRM — unlike profile, message and Knowledge text, which
 * the prompts treat as untrusted data. The fixed rules still win: instructions
 * shape tone and judgement, they cannot make the model send, invent facts,
 * leave the taxonomy or break the output format. The wording around them is
 * part of the crm/draft-system and crm/classify-system prompts
 * (src/lib/prompts/crm.ts), where the rendered text is the `instructions` variable.
 *
 * Kept free of runtime imports so the settings UI can share the types and caps.
 */
export type AiInstructionBlock = {
  id: string;
  title: string;
  content: string;
};

export const MAX_AI_INSTRUCTION_BLOCKS = 50;
export const MAX_AI_INSTRUCTION_TITLE_LENGTH = 200;
export const MAX_AI_INSTRUCTION_CONTENT_LENGTH = 8_000;
/** Across every block of one list, as rendered into the prompt. */
export const MAX_AI_INSTRUCTIONS_TOTAL_LENGTH = 20_000;

/**
 * Stored blocks → the full text they render to, or null when no block has
 * content. Tolerates anything jsonb can hold; malformed entries are skipped.
 */
export function renderAiInstructions(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const sections: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const { title, content } = block as Partial<AiInstructionBlock>;
    const body = typeof content === "string" ? content.trim() : "";
    if (!body) continue;
    const heading = typeof title === "string" ? title.trim() : "";
    sections.push(heading ? `## ${heading}\n${body}` : body);
  }
  return sections.length ? sections.join("\n\n") : null;
}

/** What the prompt receives: the rendered blocks, capped as a last resort (the API already enforces the cap). */
export function formatAiInstructions(blocks: unknown): string | null {
  const text = renderAiInstructions(blocks);
  if (!text) return null;
  return text.length > MAX_AI_INSTRUCTIONS_TOTAL_LENGTH ? text.slice(0, MAX_AI_INSTRUCTIONS_TOTAL_LENGTH) : text;
}
