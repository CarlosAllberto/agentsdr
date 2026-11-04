import type { PromptDefinition } from "./types";

/**
 * The tables' AI prompts: the formula generator (src/lib/grid/formula-generator.ts)
 * and the AI column filling one row (src/lib/ai/server/openrouter-runner.ts,
 * src/lib/grid/runners/ai.ts). The user's request, column prompt, examples
 * and field descriptions are variables; everything worded here is ours.
 */
export const GRID_PROMPTS = {
  "grid/formula-system": {
    description: "The formula generator's rules for the grid's formula language. Column tokens are written \\{{like_this}} so they stay literal.",
    template: `Generate one safe formula expression for a spreadsheet-like grid.
The formula language is a single JavaScript expression, NOT Excel syntax.
Join text with +  (or CONCATENATE / template literals). Never use & for text: in JavaScript it is bitwise AND and yields 0. Use !== for not-equal, never <>, and == / === for equality, never a lone =.
Current-row columns MUST be referenced as \\{{stableKey}} using only keys from the current table; a token is replaced by the cell value as a JavaScript literal (null when empty), so guard empty cells, e.g. (\\{{name}} || "").
Available globals: lodash as _, moment, and FormulaJS functions called by name, such as IF, AND, OR, CONCATENATE, SUM, ROUND, UPPER, LOWER, TEXT. Example: UPPER(\\{{name}}) + "-" + \\{{domain}}
For another table use LOOKUP("Table name", \\{{currentRowKey}}, "Lookup column name", "Return column name") exactly. It returns the first exact match or null. An optional fifth argument is the default value.
LOOKUP table and column arguments must be quoted literal names from the supplied schema.
Return an expression only in formula; do not include markdown, a leading equals sign, assignments, statements, network calls, or explanations inside it.`,
  },
  "grid/formula-user": {
    description: "The formula generator's user message: the workbook schema, the request, the formula being improved and, on a retry, why the last one was rejected (grid/formula-retry).",
    template: `Workbook schema:
{{schema_json}}

User request:
{{request}}{{#current_expression}}

Current formula to improve:
{{current_expression}}{{/current_expression}}{{#feedback}}

{{feedback}}{{/feedback}}`,
  },
  "grid/formula-retry": {
    description: "Told to the formula generator when its formula failed to compile or run on a sample row.",
    template: `Your previous formula was rejected.
Formula: {{formula}}
Problem: {{problem}}
Return a corrected formula.`,
  },
  "grid/fill-row-system": {
    description: "An AI column's system prompt for one row: plain-text answers are told to skip any preamble; the user's worked examples (grid/fill-row-example) follow.",
    template: `You are filling in one row of a spreadsheet.{{^structured}}

Respond with the answer only — no preamble.{{/structured}}{{#examples}}

{{examples}}{{/examples}}`,
  },
  "grid/fill-row-example": {
    description: "One of the user's worked examples for an AI column, as the system prompt shows it.",
    template: `Example input:
{{input}}
Expected response:
{{response}}`,
  },
  "grid/fill-row-field": {
    description: "The description of one output field of an AI column with Fields: the user's description, then that an unknown value is null.",
    template: "{{#description}}{{description}} — {{/description}}null when it is not known or cannot be found; never guess.",
  },
} satisfies Record<string, PromptDefinition>;
