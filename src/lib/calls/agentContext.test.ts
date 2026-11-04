import { describe, expect, test } from "bun:test";
import { formatHistory, formatNow, goalGuidance } from "./agentContext";

describe("formatNow", () => {
  test("weekday, date, time, offset and zone", () => {
    const text = formatNow(new Date("2026-10-27T09:05:00Z"), "Asia/Kolkata");
    expect(text).toContain("Tuesday, 27 October 2026, 14:35");
    expect(text).toContain("+05:30");
    expect(text).toContain("Asia/Kolkata");
  });
  test("an unknown zone falls back to UTC", () => {
    expect(formatNow(new Date("2026-10-27T09:05:00Z"), "Nope/Zone")).toContain("in UTC");
  });
});

describe("formatHistory", () => {
  const at = new Date("2026-10-20T10:00:00Z");
  test("nothing for a stranger", () => {
    expect(formatHistory([], [], "UTC")).toBeNull();
  });
  test("a conversation says follow up, not introduce", () => {
    const text = formatHistory(
      [{ at, status: "recorded", outcome: { outcome: "call_back", summary: "Busy", when: "Friday", recordedAt: at.toISOString() } }],
      [{ at, direction: "inbound", body: "x".repeat(300) }],
      "UTC",
    );
    expect(text).toContain("Call back — Busy (Friday)");
    expect(text).toContain("do not introduce yourself from scratch");
    expect(text).toContain("they wrote:");
    expect(text).not.toContain("x".repeat(250));
  });
  test("who called, the persona used, and the transcript summary when no outcome was recorded", () => {
    const text = formatHistory(
      [
        { at, status: "recorded", outcome: null, direction: "outbound", agentName: "Nisha", summary: "They run Meta ads; asked for a call on Wednesday." },
        { at, status: "recorded", outcome: null, direction: "inbound", agentName: null, summary: null },
      ],
      [],
      "UTC",
      true,
    );
    expect(text).toContain("we called them (you, as Nisha); they picked up — They run Meta ads; asked for a call on Wednesday.");
    expect(text).toContain("they called us; answered");
    expect(text).toContain("refer to what was said");
  });
  test("unanswered calls allow one mention", () => {
    const text = formatHistory([{ at, status: "no_recording", outcome: null }], [], "UTC");
    expect(text).toContain("no answer");
    expect(text).toContain("mention once");
  });
});

describe("goalGuidance", () => {
  test("every goal keeps the never-confirmed rule", () => {
    for (const goal of ["book_meeting", "human_callback", "either"] as const) {
      expect(goalGuidance(goal).join("\n")).toContain("Never say a meeting is confirmed");
    }
  });
});
