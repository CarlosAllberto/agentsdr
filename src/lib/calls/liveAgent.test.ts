import { describe, expect, test } from "bun:test";
import { agentInstructions, liveSetup, orderKnowledge, parseAgentName, parseAgentOutcome, parseAgentVoice, parseWhenAt } from "./liveAgent";
import { CallApiError } from "./sessions";
import { MAX_AGENT_NAME_CHARS } from "./contract";

describe("parseAgentOutcome", () => {
  test("accepts a valid outcome and trims text", () => {
    const parsed = parseAgentOutcome({ outcome: "meeting_booked", summary: "  Wants a demo  ", when: " Thursday around 4 " });
    expect(parsed.outcome).toBe("meeting_booked");
    expect(parsed.summary).toBe("Wants a demo");
    expect(parsed.when).toBe("Thursday around 4");
    expect(Number.isNaN(Date.parse(parsed.recordedAt))).toBe(false);
  });

  test("missing text becomes null", () => {
    const parsed = parseAgentOutcome({ outcome: "no_response", summary: "   " });
    expect(parsed.summary).toBeNull();
    expect(parsed.when).toBeNull();
  });

  test("limits long text", () => {
    const parsed = parseAgentOutcome({ outcome: "other", summary: "x".repeat(900), when: "y".repeat(400) });
    expect(parsed.summary?.length).toBe(500);
    expect(parsed.when?.length).toBe(120);
  });

  test("an unknown outcome throws a 400", () => {
    expect(() => parseAgentOutcome({ outcome: "won_the_lottery" })).toThrow(CallApiError);
    expect(() => parseAgentOutcome(null)).toThrow(CallApiError);
  });
});

describe("parseAgentVoice", () => {
  test("null, undefined and empty mean the default", () => {
    expect(parseAgentVoice(null)).toBeNull();
    expect(parseAgentVoice(undefined)).toBeNull();
    expect(parseAgentVoice("")).toBeNull();
  });
  test("a known voice passes, an unknown one throws", () => {
    expect(parseAgentVoice("Puck")).toBe("Puck");
    expect(() => parseAgentVoice("Nope")).toThrow(CallApiError);
  });
});

describe("parseAgentName", () => {
  test("blank is null, text is trimmed and squeezed", () => {
    expect(parseAgentName("  ")).toBeNull();
    expect(parseAgentName(null)).toBeNull();
    expect(parseAgentName("  Anita   Rao ")).toBe("Anita Rao");
  });
  test("too long throws", () => {
    expect(() => parseAgentName("a".repeat(MAX_AGENT_NAME_CHARS + 1))).toThrow(CallApiError);
  });
});

describe("orderKnowledge", () => {
  test("orders product before case_study", () => {
    const docs = orderKnowledge([
      { title: "Win", kind: "case_study", content: "case" },
      { title: "Prod", kind: "product", content: "product" },
    ]);
    expect(docs.map((doc) => doc.title)).toEqual(["Prod", "Win"]);
  });

  test("keeps every document whole", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({ title: `Doc ${index}`, kind: "product", content: "z".repeat(12_000) }));
    const docs = orderKnowledge(rows);
    expect(docs).toHaveLength(6);
    expect(docs.every((doc) => doc.content.length === 12_000)).toBe(true);
  });
});

describe("agentInstructions", () => {
  const base = { brief: "Book a demo", lead: null };

  test("uses the given name", () => {
    expect(agentInstructions({ ...base, name: "Anita", voice: "Kore" }, [])).toContain("You are Anita");
  });

  test("falls back to Riya", () => {
    expect(agentInstructions({ ...base, name: null, voice: null }, [])).toContain("You are Riya");
  });

  test("a male voice gets masculine Hindi", () => {
    const text = agentInstructions({ ...base, name: null, voice: "Puck" }, []);
    expect(text).toContain("You are a man");
    expect(text).not.toContain("You are a woman");
  });

  test("no knowledge section when empty, one when given", () => {
    expect(agentInstructions({ ...base, name: null, voice: null }, [])).not.toContain("<knowledge>");
    expect(agentInstructions({ ...base, name: null, voice: null }, [{ title: "T", content: "C" }])).toContain("<knowledge>");
  });
});

describe("parseAgentOutcome whenAt", () => {
  const now = Date.parse("2026-10-27T10:00:00Z");
  test("keeps an ISO time inside the window", () => {
    expect(parseWhenAt("2026-10-29T16:00:00+05:30", now)).toBe("2026-10-29T16:00:00+05:30");
    expect(parseAgentOutcome({ outcome: "meeting_booked", whenAt: "2099-01-01T00:00:00Z" }).whenAt).toBeNull();
  });
  test("drops the past (over an hour), the far future, and non-ISO text", () => {
    expect(parseWhenAt("2026-10-27T08:00:00Z", now)).toBeNull();
    expect(parseWhenAt("2026-10-27T09:30:00Z", now)).not.toBeNull();
    expect(parseWhenAt("2027-02-01T10:00:00Z", now)).toBeNull();
    expect(parseWhenAt("Thursday 4pm", now)).toBeNull();
    expect(parseWhenAt("2026-10-29T16:00:00", now)).toBeNull();
    expect(parseWhenAt("2026-10-29T16:00:00+0530", now)).not.toBeNull();
    expect(parseWhenAt(null, now)).toBeNull();
  });
});

describe("agentInstructions context", () => {
  const base = { brief: "Sell it", lead: null, name: null, voice: null };
  test("states the current date and time", () => {
    expect(agentInstructions(base, [], { now: "Tuesday, 27 October 2026, 14:35 (GMT+05:30) in Asia/Kolkata" })).toContain("It is now Tuesday, 27 October 2026");
  });
  test("what happens after the call follows the campaign goal", () => {
    expect(agentInstructions(base, [], { goal: { goal: "book_meeting", bookingUrl: "https://cal.com/x" } })).toContain("a link to pick a time");
    expect(agentInstructions(base, [], { goal: { goal: "human_callback", bookingUrl: null } })).toContain("Record human_callback with whenAt");
    expect(agentInstructions(base, [], {})).toContain("the team contacts them at the day and time you agree");
  });
  test("no hidden rule about numbers, and the phone-call framing comes first", () => {
    const text = agentInstructions(base, [{ title: "T", content: "C" }], {});
    expect(text).not.toContain("never quote a number");
    expect(text.indexOf("This is a phone call, not a text chat")).toBeLessThan(text.indexOf("<brief>"));
  });
  test("history is included, with the guidance for who rang whom", () => {
    const text = agentInstructions(base, [], { history: { lines: "- 20 Oct 2026: we called them; they picked up", spokeBefore: true } });
    expect(text).toContain("<history>\n- 20 Oct 2026: we called them; they picked up\n</history>");
    expect(text).toContain("do not introduce yourself from scratch");
    expect(agentInstructions(base, [], { inbound: true, history: { lines: "- x", spokeBefore: false } })).toContain("most likely after a missed call");
    expect(agentInstructions(base, [], { history: { lines: "- x", spokeBefore: false } })).toContain("mention once that you tried before");
    expect(agentInstructions(base, [], {})).not.toContain("<history>");
  });
  test("every goal says nothing else is sent; the link only when the campaign has one", () => {
    for (const goal of ["book_meeting", "human_callback", "either"] as const) {
      const text = agentInstructions(base, [], { goal: { goal, bookingUrl: null } });
      expect(text).toContain("never say a meeting is confirmed");
      expect(text).toContain("Never offer to send anything else");
      expect(text).not.toContain("{{");
    }
    expect(agentInstructions(base, [], { goal: { goal: "book_meeting", bookingUrl: null } })).toContain("has no booking link");
    expect(agentInstructions(base, [], { goal: { goal: "either", bookingUrl: "https://cal.com/x" } })).toContain("They would rather have a call from the team");
  });
  test("liveSetup records every outcome and whenAt", () => {
    const tool = liveSetup(base, [], {}).tools[0].functionDeclarations[0];
    expect(tool.parameters.properties.outcome?.enum).toContain("do_not_contact");
    expect(tool.parameters.properties.whenAt).toBeDefined();
  });
});

describe("calling instructions (Settings → Instructions → Calling)", () => {
  const request = { brief: "Sell storefronts.", lead: { name: "Asha Verma", firstName: "Asha", company: "Acme", detail: null }, name: "Meera", voice: "Kore" };
  test("the defaults apply until the organization writes its own, with the placeholders filled", () => {
    const text = agentInstructions(request, []);
    expect(text).toContain("## How the call goes");
    expect(text).toContain('"Hi Asha, this is Meera from <your company>');
    expect(text).not.toContain("{{");
  });
  test("its own instructions replace the defaults; who it is, honesty and ending stay", () => {
    const text = agentInstructions(request, [], {
      callingInstructions: [{ id: "x", title: "Our way", content: "Open with: Namaste {{firstName}}, {{agentName}} here." }],
    });
    expect(text).toContain("## Our way\nOpen with: Namaste Asha, Meera here.");
    expect(text).not.toContain("## How the call goes");
    expect(text).toContain("Never claim to be human.");
    expect(text).toContain("call record_outcome");
    expect(text).toContain("[Call note:");
  });
  test("an unknown first name reads as \"there\"", () => {
    const text = agentInstructions({ ...request, lead: null }, []);
    expect(text).toContain('"Hi there, this is Meera');
  });
});
