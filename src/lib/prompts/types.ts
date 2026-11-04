/** One prompt kept in Langfuse: the copy in code is what is seeded there and the fallback when it cannot be reached. */
export type PromptDefinition = {
  /** {{variables}} and {{#sections}} as in template.ts. */
  template: string;
  /** What it is for, shown as the Langfuse prompt's commit message when it is seeded. */
  description: string;
};
