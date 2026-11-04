import { describe, expect, test } from "bun:test";
import { PROMPTS } from "./registry";
import { fillPrompt, promptVariableNames } from "./template";

describe("fillPrompt", () => {
  test("variables, sections and inverted sections", () => {
    expect(fillPrompt("Hi {{name}}{{#vip}}, welcome back{{/vip}}{{^vip}}, nice to meet you{{/vip}}.", { name: "Asha", vip: true })).toBe("Hi Asha, welcome back.");
    expect(fillPrompt("Hi {{name}}{{#vip}}, welcome back{{/vip}}{{^vip}}, nice to meet you{{/vip}}.", { name: "Asha", vip: false })).toBe("Hi Asha, nice to meet you.");
  });
  test("a blank string and a missing value are falsy and empty", () => {
    expect(fillPrompt("[{{#x}}yes{{/x}}{{^x}}no{{/x}}][{{x}}][{{y}}]", { x: "  " })).toBe("[no][  ][]");
  });
  test("nested sections of different names", () => {
    expect(fillPrompt("{{#a}}A{{#b}}B{{/b}}{{^b}}-{{/b}}{{/a}}", { a: 1, b: 0 })).toBe("A-");
  });
  test("values are inserted as written, never parsed as template", () => {
    expect(fillPrompt("{{x}}", { x: "{{#y}}not a section{{/y}} {{z}}", y: true, z: "no" })).toBe("{{#y}}not a section{{/y}} {{z}}");
  });
  test("collapses blank lines in the template, never inside a value", () => {
    expect(fillPrompt("a\n{{#x}}b{{/x}}\n\n\nc", {})).toBe("a\n\nc");
    expect(fillPrompt("{{v}}", { v: "one\n\n\n\ntwo" })).toBe("one\n\n\n\ntwo");
  });
  test("\\{{ writes a literal token", () => {
    expect(fillPrompt("Use \\{{name}} for {{name}}", { name: "Asha" })).toBe("Use {{name}} for Asha");
    expect(promptVariableNames("\\{{token}} {{real}}")).toEqual(["real"]);
  });
  test("lists variable and section names", () => {
    expect(promptVariableNames("{{a}} {{#b}}{{c}}{{/b}} {{^d}}{{/d}}")).toEqual(["a", "b", "c", "d"]);
  });
});

describe("every prompt in the registry", () => {
  test("has a description and balanced sections", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      expect(prompt.description.trim().length, name).toBeGreaterThan(0);
      const opens = [...prompt.template.matchAll(/\{\{[#^]\s*([\w.-]+)\s*\}\}/g)].length;
      const closes = [...prompt.template.matchAll(/\{\{\/\s*([\w.-]+)\s*\}\}/g)].length;
      expect(closes, name).toBe(opens);
    }
  });
  test("fills with every variable set to a value, leaving no braces", () => {
    for (const [name, prompt] of Object.entries(PROMPTS)) {
      const values = Object.fromEntries(promptVariableNames(prompt.template).map((variable) => [variable, "x"]));
      // Only escaped tokens (\\{{like_this}}) may come out as braces.
      const literal = prompt.template.split("\\{{").length - 1;
      expect(fillPrompt(prompt.template, values).split("{{").length - 1, name).toBe(literal);
    }
  });
});
