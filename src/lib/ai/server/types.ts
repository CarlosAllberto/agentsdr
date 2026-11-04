import "server-only";

import type { AiConfig } from "@/lib/grid/types";
import type { ResolvedPrompt } from "@/lib/observability/langfuse";
import { fillPrompt } from "@/lib/prompts/template";
import type { PromptTemplates } from "@/lib/prompts/templates";
import type { AiModelDefinition } from "../types";

/** What one row's AI call receives. */
export type AiRunInput = {
  config: AiConfig;
  model: AiModelDefinition;
  credentials: Record<string, string>;
  /** Prompt with {{column}} tokens already resolved against the row. */
  prompt: string;
  /**
   * The JSON shape the model must return, when the user chose "Fields" or
   * supplied a schema. Null asks for plain text.
   */
  schema: Record<string, unknown> | null;
  /** Worked examples, already resolved to plain text. */
  examples: Array<{ input: string; response: string }>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Added to the call's Langfuse trace: the cell's ids, and prompts the caller built the input from. */
  trace?: { metadata?: Record<string, unknown>; prompts?: ResolvedPrompt[] };
};

export type AiRunResult = {
  /** Parsed object when a schema was requested, otherwise the raw text. */
  value: unknown;
  /** Provider-reported token usage, for the run log. */
  usage?: { inputTokens?: number; outputTokens?: number };
  raw?: unknown;
  /** Sanitized provider request body, with credentials deliberately omitted. */
  request?: unknown;
};

export type AiRunner = (input: AiRunInput) => Promise<AiRunResult>;

/** The prompts a row's system message is built from (src/lib/prompts/grid.ts). */
export const FILL_ROW_PROMPTS = ["grid/fill-row-system", "grid/fill-row-example"] as const;
export type FillRowTemplates = PromptTemplates<(typeof FILL_ROW_PROMPTS)[number]>;

/** The system message for one row: structured answers come back through a function, plain ones as bare text. */
export function fillRowSystemPrompt(
  templates: FillRowTemplates,
  structured: boolean,
  examples: AiRunInput["examples"],
): string {
  return fillPrompt(templates["grid/fill-row-system"], {
    structured,
    examples: examples.map((example) => fillPrompt(templates["grid/fill-row-example"], example)).join("\n\n"),
  });
}

/**
 * The instruction appended when the user picked "Fields".
 *
 * Kept in one place so every provider asks for the same thing — a bare JSON
 * object — even where the provider also enforces a schema natively.
 */
export function jsonInstruction(schema: Record<string, unknown>): string {
  return [
    "Respond with a single JSON object and nothing else — no prose, no code fences.",
    "It must match this JSON Schema exactly:",
    JSON.stringify(schema),
  ].join("\n");
}

/**
 * Pulls the JSON object out of a model response.
 *
 * Models still occasionally wrap JSON in a code fence or a sentence even when
 * told not to, so a bare JSON.parse would throw on output that is otherwise
 * perfectly good. Falls back to the outermost braces before giving up.
 */
export function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new Error("The model did not return valid JSON");
  }
}
