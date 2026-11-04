import { describe, expect, test } from "bun:test";
import { GRID_PROMPTS } from "./grid";
import { fillPrompt, promptVariableNames } from "./template";

const fill = (name: keyof typeof GRID_PROMPTS, variables: Parameters<typeof fillPrompt>[1]) => fillPrompt(GRID_PROMPTS[name].template, variables);

describe("grid prompts", () => {
  test("each uses only the variables the code passes", () => {
    const passed: Record<keyof typeof GRID_PROMPTS, string[]> = {
      // Its column-token examples are escaped (\\{{stableKey}}), so they are not variables.
      "grid/formula-system": [],
      "grid/formula-user": ["current_expression", "feedback", "request", "schema_json"],
      "grid/formula-retry": ["formula", "problem"],
      "grid/fill-row-system": ["examples", "structured"],
      "grid/fill-row-example": ["input", "response"],
      "grid/fill-row-field": ["description"],
    };
    for (const [name, definition] of Object.entries(GRID_PROMPTS)) {
      expect(promptVariableNames(definition.template)).toEqual(passed[name as keyof typeof GRID_PROMPTS].sort());
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  test("the formula rules keep their column-token examples", () => {
    const tokens = Object.fromEntries(["stableKey", "name", "domain", "currentRowKey"].map((key) => [key, `{{${key}}}`]));
    const rules = fill("grid/formula-system", tokens);
    expect(rules).toContain("referenced as {{stableKey}} using only keys");
    expect(rules).toContain('UPPER({{name}}) + "-" + {{domain}}');
    expect(rules).toContain('LOOKUP("Table name", {{currentRowKey}},');
  });

  test("the formula request, with the formula being improved and a rejection", () => {
    const feedback = fill("grid/formula-retry", { formula: "a & b", problem: "Excel operator" });
    expect(feedback).toBe("Your previous formula was rejected.\nFormula: a & b\nProblem: Excel operator\nReturn a corrected formula.");
    const user = fill("grid/formula-user", { schema_json: "[]", request: "Join names", current_expression: "x", feedback });
    expect(user).toBe(`Workbook schema:\n[]\n\nUser request:\nJoin names\n\nCurrent formula to improve:\nx\n\n${feedback}`);
    expect(fill("grid/formula-user", { schema_json: "[]", request: "Join names" })).toBe("Workbook schema:\n[]\n\nUser request:\nJoin names");
  });

  test("a row's system prompt, structured or plain, with examples", () => {
    const example = fill("grid/fill-row-example", { input: "acme.com", response: "Acme" });
    expect(example).toBe("Example input:\nacme.com\nExpected response:\nAcme");
    expect(fill("grid/fill-row-system", { structured: true, examples: "" })).toBe("You are filling in one row of a spreadsheet.");
    expect(fill("grid/fill-row-system", { structured: false, examples: example }))
      .toBe(`You are filling in one row of a spreadsheet.\n\nRespond with the answer only — no preamble.\n\n${example}`);
  });

  test("an output field's description", () => {
    expect(fill("grid/fill-row-field", { description: "The CEO's name" })).toBe("The CEO's name — null when it is not known or cannot be found; never guess.");
    expect(fill("grid/fill-row-field", {})).toBe("null when it is not known or cannot be found; never guess.");
  });
});
