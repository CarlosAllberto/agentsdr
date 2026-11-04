import { describe, expect, test } from "bun:test";
import { fillPrompt, promptVariableNames } from "./template";
import { TRANSCRIPTION_PROMPTS } from "./transcription";

const template = TRANSCRIPTION_PROMPTS["transcription/call"].template;

describe("transcription prompt", () => {
  test("uses only the variables the code passes", () => {
    expect(promptVariableNames(template)).toEqual(["inbound", "ringing_seconds", "who"]);
  });

  test("an outbound call, the lead known, with ringing to skip", () => {
    const text = fillPrompt(template, { who: "Priya Sharma, Acme Corp", inbound: false, ringing_seconds: 7 });
    expect(text).toContain("placed by a sales rep to a lead (Priya Sharma, Acme Corp). The rep is the caller");
    expect(text).toContain("Transcribe the call in whatever language was actually spoken");
    expect(text.endsWith("The recording starts about 7 seconds before the lead picks up: ignore the ringing before that, and any speech in it is the rep's.")).toBe(true);
    expect(text).not.toContain("{{");
  });

  test("a lead calling back, unnamed, no ringing", () => {
    const text = fillPrompt(template, { who: "", inbound: true, ringing_seconds: null });
    expect(text).toContain("placed by a lead to a sales rep's number, and answered on the rep's side.");
    expect(text).not.toContain("The rep is the caller");
    expect(text).not.toContain("picks up");
    expect(text.endsWith("your summary, and the utterances.")).toBe(true);
  });
});
