/**
 * Fills a prompt template from Langfuse (or its fallback copy in code).
 *
 * Langfuse's own compile only replaces `{{name}}`. Our prompts also need a
 * part that shows only in some calls (an inbound call, a woman's voice, a
 * knowledge section), so the text keeps those choices in Langfuse instead of
 * in code, with Mustache's section syntax:
 *
 *   {{name}}                 the value (a missing value is "")
 *   {{#flag}}…{{/flag}}      the part when `flag` is truthy (a non-empty string, true, a non-zero number)
 *   {{^flag}}…{{/flag}}      the part when it is not
 *   \{{text}}               a literal "{{text}}" (e.g. a formula's column token)
 *
 * Sections may nest, but not reuse the same name inside themselves. Nothing
 * is escaped: the output is a prompt, not HTML. Pure and import-free.
 */
export type PromptVariables = Record<string, string | number | boolean | null | undefined>;

const SECTION = /\{\{([#^])\s*([\w.-]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;
/** Stands in for an escaped "\{{" while the template is filled; a private-use character no prompt contains. */
const ESCAPED_OPEN = "\uE000";

function truthy(value: PromptVariables[string]): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return Boolean(value);
}

export function fillPrompt(template: string, variables: PromptVariables): string {
  let text = template.replaceAll("\\{{", ESCAPED_OPEN);
  // Innermost sections first, until none are left.
  for (let pass = 0; pass < 10; pass += 1) {
    const next = text.replace(SECTION, (_, kind: string, name: string, body: string) =>
      (kind === "#") === truthy(variables[name]) ? body : "",
    );
    if (next === text) break;
    text = next;
  }
  // Blank lines left by an absent section collapse; text inside the values is left as written.
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(VARIABLE, (_, name: string) => {
      const value = variables[name];
      return value === null || value === undefined || value === false ? "" : String(value);
    })
    .replaceAll(ESCAPED_OPEN, "{{")
    .trim();
}

/** The names a template uses, for checking a Langfuse version against what the code passes. */
export function promptVariableNames(template: string): string[] {
  const names = new Set<string>();
  for (const match of template.matchAll(/(?<!\\)\{\{\s*[#^/]?\s*([\w.-]+)\s*\}\}/g)) names.add(match[1]!);
  return [...names].sort();
}
