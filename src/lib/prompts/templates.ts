import { PROMPTS, type PromptName } from "./registry";

/**
 * Templates by name, unfilled. Builders that fill several prompts take one of
 * these, so a test can pass the copies in code and a model call the versions
 * from Langfuse (templates.server.ts). Pure, so client code may import it.
 */
export type PromptTemplates<N extends PromptName> = Record<N, string>;

/** The copies in code: what tests and an unconfigured Langfuse use. */
export function codeTemplates<const N extends PromptName>(names: readonly N[]): PromptTemplates<N> {
  return Object.fromEntries(names.map((name) => [name, PROMPTS[name].template])) as PromptTemplates<N>;
}
