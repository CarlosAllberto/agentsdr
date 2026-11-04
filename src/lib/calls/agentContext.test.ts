import { describe, expect, test } from "bun:test";
import { formatHistory, formatNow, goalVariables } from "./agentContext";

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
  test("a conversation: outcome lines, cut messages, and that they spoke", () => {
    const history = formatHistory(
      [{ at, status: "recorded", outcome: { outcome: "call_back", summary: "Busy", when: "Friday", recordedAt: at.toISOString() } }],
      [{ at, direction: "inbound", body: "x".repeat(300) }],
      "UTC",
    );
    expect(history?.lines).toContain("Call back — Busy (Friday)");
    expect(history?.lines).toContain("they wrote:");
    expect(history?.lines).not.toContain("x".repeat(250));
    expect(history?.spokeBefore).toBe(true);
  });
  test("who called, the persona used, and the transcript summary when no outcome was recorded", () => {
    const history = formatHistory(
      [
        { at, status: "recorded", outcome: null, direction: "outbound", agentName: "Nisha", summary: "They run Meta ads; asked for a call on Wednesday." },
        { at, status: "recorded", outcome: null, direction: "inbound", agentName: null, summary: null },
      ],
      [],
      "UTC",
    );
    expect(history?.lines).toContain("we called them (you, as Nisha); they picked up — They run Meta ads; asked for a call on Wednesday.");
    expect(history?.lines).toContain("they called us; answered");
  });
  test("unanswered calls did not speak", () => {
    const history = formatHistory([{ at, status: "no_recording", outcome: null }], [], "UTC");
    expect(history?.lines).toContain("no answer");
    expect(history?.spokeBefore).toBe(false);
  });
});

describe("goalVariables", () => {
  test("what the agent may offer follows the goal and the booking link", () => {
    expect(goalVariables(null)).toMatchObject({ has_goal: false, offer_meeting: false, offer_team_call: false });
    expect(goalVariables({ goal: "book_meeting", bookingUrl: "https://cal.com/x" })).toMatchObject({ offer_meeting: true, offer_team_call: false, booking_link: true });
    expect(goalVariables({ goal: "human_callback", bookingUrl: null })).toMatchObject({ offer_meeting: false, offer_team_call: true });
    expect(goalVariables({ goal: "either", bookingUrl: " " })).toMatchObject({ offer_meeting: true, offer_team_call: true, goal_either: true, booking_link: false });
  });
});
