import { describe, expect, test } from "bun:test";
import { CRM_PROMPTS } from "./crm";
import { fillPrompt, promptVariableNames } from "./template";

const fill = (name: keyof typeof CRM_PROMPTS, variables: Parameters<typeof fillPrompt>[1]) => fillPrompt(CRM_PROMPTS[name].template, variables);

describe("CRM prompts", () => {
  test("each uses only the variables the code passes", () => {
    const passed: Record<keyof typeof CRM_PROMPTS, string[]> = {
      "crm/draft-system": ["instructions"],
      "crm/draft-channel-rules": ["email", "linkedin", "whatsapp"],
      "crm/draft-user": ["context_json", "revision"],
      "crm/draft-tool": [],
      "crm/classify-system": ["instructions"],
      "crm/classify-channel-notes": ["whatsapp", "whatsapp_call_background"],
      "crm/classify-user": ["channel_notes", "context"],
      "crm/classify-tool": [],
      "crm/classify-call-transcript": ["summary", "transcript"],
    };
    for (const [name, definition] of Object.entries(CRM_PROMPTS)) {
      expect(promptVariableNames(definition.template)).toEqual(passed[name as keyof typeof CRM_PROMPTS].sort());
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  test("the draft system prompt wraps operator instructions only when there are some", () => {
    const plain = fill("crm/draft-system", { instructions: null });
    const instructed = fill("crm/draft-system", { instructions: "Sign off as Priya." });
    expect(plain).toContain("This is a human-send-only workflow");
    expect(plain).not.toContain("operator_instructions");
    expect(instructed.startsWith(plain)).toBe(true);
    expect(instructed).toContain("Follow them for tone, style, length");
    expect(instructed.endsWith("<operator_instructions>\nSign off as Priya.\n</operator_instructions>")).toBe(true);
    expect(instructed).not.toContain("{{");
  });

  test("the channel rules hold only the chosen channel's lines", () => {
    const whatsapp = fill("crm/draft-channel-rules", { whatsapp: true });
    expect(whatsapp.split("\n")).toHaveLength(5);
    expect(whatsapp).toContain("This is a WhatsApp chat message");
    expect(whatsapp).not.toContain("LinkedIn");
    expect(fill("crm/draft-channel-rules", { email: true }).split("\n")[0]).toBe("Return a non-empty subject and plain-text body.");
    expect(fill("crm/draft-channel-rules", { linkedin: true }).split("\n")[0]).toBe("Return subject as null. LinkedIn drafts never have a subject.");
  });

  test("the draft user message leads in for a first draft or a rewrite", () => {
    const first = fill("crm/draft-user", { revision: false, context_json: '{"a":1}' });
    const rewrite = fill("crm/draft-user", { revision: true, context_json: '{"a":1}' });
    expect(first).toBe('Prepare the current CRM sequence-step draft from this server-assembled context:\n\n{"a":1}');
    expect(rewrite).toContain("A human reviewer rejected the previous draft");
    expect(rewrite).toContain("do not return the previous draft again.\n\n{\"a\":1}");
  });

  test("the classifier's prompts", () => {
    const system = fill("crm/classify-system", { instructions: "Referral counts as Interested." });
    expect(system).toContain("Use only the supplied active taxonomy.");
    expect(system).toContain("use only the supplied taxonomy keys");
    expect(system.endsWith("<operator_instructions>\nReferral counts as Interested.\n</operator_instructions>")).toBe(true);

    expect(fill("crm/classify-channel-notes", {})).toBe("");
    const notes = fill("crm/classify-channel-notes", { whatsapp: true, whatsapp_call_background: true }).split("\n\n");
    expect(notes).toHaveLength(2);
    expect(notes[1]).toContain("they are background, not the reply being classified");

    expect(fill("crm/classify-user", { channel_notes: "", context: "CTX" }))
      .toBe("Classify the latest inbound message using this CRM context:\n\nCTX");
    expect(fill("crm/classify-user", { channel_notes: "NOTE", context: "CTX" })).toMatch(/^NOTE\n\nClassify/);
  });

  test("a call transcript as the message classified", () => {
    const text = fill("crm/classify-call-transcript", { summary: "Wants a demo.", transcript: "Rep: Hi\nLead: Hello" });
    expect(text).toContain("not a written reply");
    expect(text).toContain("Summary: Wants a demo.\n\nTranscript:\nRep: Hi\nLead: Hello");
  });

  test("tool descriptions", () => {
    expect(fill("crm/draft-tool", {})).toContain("Submit the drafted message.");
    expect(fill("crm/classify-tool", {})).toContain("Submit the classification of the latest inbound reply.");
  });
});
