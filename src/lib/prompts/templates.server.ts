import "server-only";

import { getPromptTemplates, type ResolvedPrompt } from "@/lib/observability/langfuse";
import type { PromptName } from "./registry";
import type { PromptTemplates } from "./templates";

/** The templates from Langfuse (or code), and the versions used, for the trace. */
export async function resolveTemplates<const N extends PromptName>(
  names: readonly N[],
): Promise<{ templates: PromptTemplates<N>; prompts: ResolvedPrompt[] }> {
  const resolved = await getPromptTemplates(names);
  const prompts = names.map((name) => resolved[name]);
  return { templates: Object.fromEntries(prompts.map((prompt) => [prompt.name, prompt.text])) as PromptTemplates<N>, prompts };
}
