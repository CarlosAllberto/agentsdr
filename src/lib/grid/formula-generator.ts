import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { inOrg } from "@/lib/tenancy/scope";
import { completeStructuredWithOpenRouter } from "@/lib/ai/server/structuredCompletion";
import type { ResolvedPrompt } from "@/lib/observability/langfuse";
import type { PromptName } from "@/lib/prompts/registry";
import { fillPrompt } from "@/lib/prompts/template";
import { codeTemplates, type PromptTemplates } from "@/lib/prompts/templates";
import { resolveTemplates } from "@/lib/prompts/templates.server";
import { gridColumns, gridRows, gridTables } from "./schema";
import { inOrgTables } from "./scope";
import { effectiveColumnType } from "./value-types";
import { buildFormulaLookupRegistry, resolveFormulaConfig } from "./formula-lookups";
import { assertFormulaSyntax, evaluateOnce, excelOnlyOperator } from "./runners";
import type { CellValues } from "./types";

export class FormulaGeneratorUnavailableError extends Error {}

export async function generateFormula(tableId: string, request: string, currentExpression?: string) {
  const [currentTable] = await db.select().from(gridTables).where(and(inOrg(gridTables), eq(gridTables.id, tableId))).limit(1);
  if (!currentTable) throw new Error("Table not found");
  const tables = await db.select().from(gridTables).where(and(inOrg(gridTables), eq(gridTables.workbookId, currentTable.workbookId)));
  const columns = await db.select().from(gridColumns).where(inArray(gridColumns.tableId, tables.map((table) => table.id)));
  const schema = tables.map((table) => ({
    table: table.name,
    id: table.id,
    current: table.id === tableId,
    columns: columns.filter((column) => column.tableId === table.id).map((column) => ({
      name: column.name,
      key: column.key,
      type: effectiveColumnType(column),
    })),
  }));

  const sample = await sampleRow(tableId, schema.find((table) => table.current)?.columns ?? []);
  const { templates, prompts } = await resolveTemplates(FORMULA_PROMPTS);

  let rejected: { formula: string; problem: string } | undefined;
  let lastProblem = "";
  // One retry: the first miss is usually a stray Excel habit the error message fixes.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { formula, explanation } = await askModel(
      buildFormulaPrompt({ schema, request, currentExpression, rejected }, templates),
      { prompts: rejected ? prompts : prompts.filter((prompt) => prompt.name !== "grid/formula-retry"), metadata: { tableId, attempt: attempt + 1 } },
    );
    const problem = await formulaProblem(tableId, formula, sample);
    if (!problem) return { formula, explanation: explanation || "Generated from your request." };
    lastProblem = problem;
    rejected = { formula, problem };
  }
  throw new Error(`The AI could not produce a working formula (${lastProblem}). Try rephrasing the request.`);
}

/** The prompts a formula is generated from (src/lib/prompts/grid.ts). */
export const FORMULA_PROMPTS = [
  "grid/formula-system",
  "grid/formula-user",
  "grid/formula-retry",
] as const satisfies readonly PromptName[];
export type FormulaTemplates = PromptTemplates<(typeof FORMULA_PROMPTS)[number]>;

/**
 * The rules quote column tokens such as {{name}} as examples; they are passed
 * through as themselves, since an unknown {{token}} would be filled with "".
 */
/** The generator's system and user messages; `rejected` is the previous attempt on a retry. */
export function buildFormulaPrompt(
  input: { schema: unknown; request: string; currentExpression?: string; rejected?: { formula: string; problem: string } },
  templates: FormulaTemplates = codeTemplates(FORMULA_PROMPTS),
): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: fillPrompt(templates["grid/formula-system"], {}),
    userPrompt: fillPrompt(templates["grid/formula-user"], {
      schema_json: JSON.stringify(input.schema),
      request: input.request,
      current_expression: input.currentExpression,
      feedback: input.rejected ? fillPrompt(templates["grid/formula-retry"], input.rejected) : null,
    }),
  };
}

async function askModel(
  prompt: { systemPrompt: string; userPrompt: string },
  trace: { prompts: ResolvedPrompt[]; metadata: Record<string, unknown> },
): Promise<{ formula: string; explanation: string }> {
  let result: Awaited<ReturnType<typeof completeStructuredWithOpenRouter>>;
  try {
    result = await completeStructuredWithOpenRouter({
      timeoutMs: 30_000,
      systemPrompt: prompt.systemPrompt,
      userPrompt: prompt.userPrompt,
      maxOutputTokens: 800,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["formula", "explanation"],
        properties: {
          formula: { type: "string" },
          explanation: { type: "string" },
        },
      },
      schemaName: "generate_formula",
      trace: { name: "grid-formula", ...trace },
    });
  } catch (error) {
    throw new FormulaGeneratorUnavailableError(error instanceof Error ? error.message : "OpenRouter AI is not configured");
  }
  const parsed = JSON.parse(result.text) as { formula?: string; explanation?: string };
  const formula = parsed.formula?.trim().replace(/^=/, "").trim() ?? "";
  if (!formula || formula.length > 10_000) throw new Error("AI returned an invalid formula");
  return { formula, explanation: parsed.explanation?.trim() ?? "" };
}

/** A real row when the table has one, otherwise a placeholder value per column type. */
async function sampleRow(tableId: string, columns: { key: string; type: string }[]): Promise<CellValues> {
  const [row] = await db
    .select({ cells: gridRows.cells })
    .from(gridRows)
    .where(and(inOrgTables(gridRows.tableId), eq(gridRows.tableId, tableId)))
    .orderBy(asc(gridRows.position))
    .limit(1);
  const placeholder: Record<string, unknown> = { number: 1, currency: 1, boolean: true, email: "ada@example.com", url: "example.com", date: "2024-01-05" };
  const out: CellValues = {};
  for (const column of columns) out[column.key] = row?.cells[column.key] ?? placeholder[column.type] ?? "Sample";
  return out;
}

/** Errors that mean the formula itself is wrong, as opposed to the sample row's data. */
const STRUCTURAL_ERROR = /SyntaxError|ReferenceError|is not a function|is not defined/;

/** Null when the formula compiles, avoids Excel-only operators, and evaluates on the sample row. */
async function formulaProblem(tableId: string, formula: string, sample: CellValues): Promise<string | null> {
  const operator = excelOnlyOperator(formula);
  if (operator) return operator;
  try {
    await assertFormulaSyntax(formula);
    const config = await resolveFormulaConfig(tableId, formula);
    const registry = await buildFormulaLookupRegistry(config.lookupRefs);
    const result = await evaluateOnce(formula, sample, registry);
    if (!result.ok && STRUCTURAL_ERROR.test(result.error)) return result.error;
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "invalid formula";
  }
}
