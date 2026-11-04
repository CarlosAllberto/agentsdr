import { describe, expect, test } from "bun:test";
import { QUALIFICATION_PROMPTS } from "./qualification";
import { SHARED_PROMPTS } from "./shared";
import { fillPrompt, promptVariableNames } from "./template";

describe("shared and qualification prompts", () => {
  test("structured output names the function", () => {
    const template = SHARED_PROMPTS["shared/structured-output"].template;
    expect(promptVariableNames(template)).toEqual(["schema_name"]);
    expect(fillPrompt(template, { schema_name: "fill_row" }))
      .toBe("You must answer by calling the fill_row function exactly once with every required argument. Never answer in prose.");
  });

  test("the default tool description and the parent-domain lookup take no variables", () => {
    for (const definition of [SHARED_PROMPTS["shared/tool-description"], QUALIFICATION_PROMPTS["qualification/parent-domain-system"]]) {
      expect(promptVariableNames(definition.template)).toEqual([]);
      expect(fillPrompt(definition.template, {})).toBe(definition.template);
    }
    expect(QUALIFICATION_PROMPTS["qualification/parent-domain-system"].template).toContain("If it is independently owned or uncertain, return null.");
  });
});
