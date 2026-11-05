import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { AgentOutcome, AgentOutcomeKind } from "../contract";
import { composeAgentBrief } from "./brief";
import type { AiCampaignStep } from "./contract";
import {
  afterCall,
  afterMessage,
  bookingLinkFor,
  calcomSignatureValid,
  newBookingCode,
  callResultFor,
  CALLBACK_RETRY_MS,
  CHASE_GRACE_MS,
  dailyCallLimit,
  ERROR_RETRY_MS,
  MIN_STEP_GAP_MS,
  parseCalcomEvent,
  plannedAction,
  statusWhenStarted,
  withinCallingHours,
  type AiEngineCampaign,
  type AiEngineContact,
} from "./engineRules";

const NOW = new Date("2026-10-27T08:00:00.000Z");
const HOUR = 3_600_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);

const reach: AiCampaignStep[] = [
  { id: "call-1", kind: "call", delayHours: 0, instructions: "First call" },
  { id: "call-2", kind: "call", delayHours: 24, instructions: "Second try" },
  { id: "message-1", kind: "message", delayHours: 0, body: "Hi {{firstName}}" },
];
const chase: AiCampaignStep[] = [
  { id: "chase-message-1", kind: "message", delayHours: 24, body: "Link: {{bookingLink}}" },
  { id: "chase-call-1", kind: "call", delayHours: 48, instructions: "Did the link work?" },
];

const campaign = (overrides: Partial<AiEngineCampaign> = {}): AiEngineCampaign => ({
  goal: "book_meeting",
  bookingUrl: "https://cal.com/acme/30min",
  maxCallbacks: 2,
  steps: reach,
  chaseSteps: chase,
  ...overrides,
});
const contact = (overrides: Partial<AiEngineContact> = {}): AiEngineContact => ({
  status: "reaching",
  step: 0,
  callbacks: 0,
  failures: 0,
  bookingLinkSent: false,
  ...overrides,
});
const outcome = (kind: AgentOutcomeKind, extra: Partial<AgentOutcome> = {}): AgentOutcome => ({
  outcome: kind,
  summary: null,
  when: null,
  recordedAt: NOW.toISOString(),
  ...extra,
});

describe("plannedAction", () => {
  test("a queued or reaching lead runs its reach step", () => {
    expect(plannedAction(contact({ status: "queued" }), campaign(), NOW)).toEqual({ kind: "call", stepKey: "reach:call-1", purpose: "reach", step: reach[0]! });
    expect(plannedAction(contact({ step: 2 }), campaign(), NOW)).toMatchObject({ kind: "message", stepKey: "reach:message-1" });
  });

  test("a chasing lead runs its chase step, a call-back its numbered call", () => {
    expect(plannedAction(contact({ status: "chasing", step: 1 }), campaign(), NOW)).toMatchObject({ kind: "call", stepKey: "chase:chase-call-1", purpose: "chase" });
    expect(plannedAction(contact({ status: "callback", callbacks: 2 }), campaign(), NOW)).toEqual({ kind: "call", stepKey: "callback:2", purpose: "callback", step: null });
  });

  test("a retry after errors gets its own key", () => {
    expect(plannedAction(contact({ failures: 2 }), campaign(), NOW)).toMatchObject({ stepKey: "retry:reach:call-1:2" });
    expect(plannedAction(contact({ status: "callback", callbacks: 1, failures: 1 }), campaign(), NOW)).toMatchObject({ stepKey: "retry:callback:1:1" });
  });

  test("a sequence shortened past the lead settles it", () => {
    expect(plannedAction(contact({ step: 5 }), campaign(), NOW)).toMatchObject({ kind: "none", decision: { status: "unreached" } });
    expect(plannedAction(contact({ status: "chasing", step: 9 }), campaign(), NOW)).toMatchObject({
      kind: "none",
      decision: { status: "handoff", handoff: { followUpAt: NOW } },
    });
  });
});

describe("afterCall: nobody spoke", () => {
  test("no answer moves to the next reach step after its delay", () => {
    expect(afterCall(contact(), "no_answer", null, campaign(), NOW)).toMatchObject({ status: "reaching", step: 1, nextAt: at(24 * HOUR), failures: 0 });
  });

  test("the next step is never sooner than 10 minutes", () => {
    expect(afterCall(contact({ step: 1 }), "no_answer", null, campaign(), NOW)).toMatchObject({ step: 2, nextAt: at(MIN_STEP_GAP_MS) });
  });

  test("picking up and saying nothing is no answer", () => {
    expect(afterCall(contact(), "conversation", outcome("no_response"), campaign(), NOW)).toMatchObject({ status: "reaching", step: 1 });
  });

  test("the reach sequence running out leaves them unreached", () => {
    const decision = afterCall(contact({ step: 2 }), "no_answer", null, campaign(), NOW);
    expect(decision).toMatchObject({ status: "unreached", nextAt: null });
    expect(decision.handoff).toBeUndefined();
  });

  test("an unanswered chase call continues the chase, then hands off", () => {
    expect(afterCall(contact({ status: "chasing", step: 0 }), "no_answer", null, campaign(), NOW)).toMatchObject({ status: "chasing", step: 1, nextAt: at(48 * HOUR) });
    expect(afterCall(contact({ status: "chasing", step: 1 }), "no_answer", null, campaign(), NOW)).toMatchObject({ status: "handoff", handoff: { followUpAt: NOW } });
  });

  test("an unanswered call-back is retried in 24 h while call-backs remain", () => {
    expect(afterCall(contact({ status: "callback", step: 1, callbacks: 1 }), "no_answer", null, campaign(), NOW)).toMatchObject({
      status: "callback",
      step: 1,
      callbacks: 2,
      nextAt: at(CALLBACK_RETRY_MS),
    });
  });

  test("out of call-backs: back to the reach sequence where it left off", () => {
    expect(afterCall(contact({ status: "callback", step: 1, callbacks: 2 }), "no_answer", null, campaign(), NOW)).toMatchObject({
      status: "reaching",
      step: 1,
      nextAt: at(24 * HOUR),
    });
    expect(afterCall(contact({ status: "callback", step: 3, callbacks: 2 }), "no_answer", null, campaign(), NOW)).toMatchObject({ status: "unreached" });
  });

  test("out of call-backs after saying yes once: a person takes over", () => {
    expect(afterCall(contact({ status: "callback", step: 1, callbacks: 2, bookingLinkSent: true }), "no_answer", null, campaign(), NOW)).toMatchObject({
      status: "handoff",
    });
  });
});

describe("afterCall: failures", () => {
  test("not on WhatsApp fails the lead", () => {
    expect(afterCall(contact(), "not_on_whatsapp", null, campaign(), NOW)).toMatchObject({ status: "failed", note: "Not on WhatsApp", nextAt: null });
  });

  test("an error retries the same step in 30 minutes, then fails on the third", () => {
    expect(afterCall(contact({ status: "queued" }), "error", null, campaign(), NOW, "Browser crashed")).toMatchObject({
      status: "reaching",
      step: 0,
      failures: 1,
      nextAt: at(ERROR_RETRY_MS),
      note: "Browser crashed",
    });
    expect(afterCall(contact({ failures: 2 }), "error", null, campaign(), NOW, "Browser crashed")).toMatchObject({ status: "failed", failures: 3, nextAt: null });
  });

  test("a call-back that errors stays a call-back", () => {
    expect(afterCall(contact({ status: "callback", callbacks: 1 }), "error", null, campaign(), NOW)).toMatchObject({ status: "callback", failures: 1, callbacks: 1 });
  });
});

describe("afterCall: a conversation", () => {
  test("a yes sends the booking link and starts the chase", () => {
    for (const kind of ["meeting_booked", "interested"] as const) {
      expect(afterCall(contact(), "conversation", outcome(kind), campaign(), NOW)).toMatchObject({
        status: "chasing",
        step: 0,
        nextAt: null,
        sendBookingLink: true,
        failures: 0,
      });
    }
    expect(afterCall(contact(), "conversation", outcome("meeting_booked"), campaign({ goal: "either" }), NOW)).toMatchObject({ sendBookingLink: true });
  });

  test("a yes with the team as the goal, or no booking link, hands off", () => {
    const whenAt = at(30 * HOUR).toISOString();
    expect(afterCall(contact(), "conversation", outcome("interested", { whenAt }), campaign({ goal: "human_callback" }), NOW)).toMatchObject({
      status: "handoff",
      handoff: { followUpAt: new Date(whenAt) },
    });
    const noLink = afterCall(contact(), "conversation", outcome("meeting_booked"), campaign({ bookingUrl: null }), NOW);
    expect(noLink).toMatchObject({ status: "handoff", handoff: { followUpAt: NOW } });
    expect(noLink.sendBookingLink).toBeUndefined();
  });

  test("a yes during the chase continues it rather than resending the link", () => {
    const decision = afterCall(contact({ status: "chasing", step: 0, bookingLinkSent: true }), "conversation", outcome("interested"), campaign(), NOW);
    expect(decision).toMatchObject({ status: "chasing", step: 1 });
    expect(decision.sendBookingLink).toBeUndefined();
    expect(afterCall(contact({ status: "callback", step: 1, callbacks: 1, bookingLinkSent: true }), "conversation", outcome("meeting_booked"), campaign(), NOW)).toMatchObject({
      status: "chasing",
      step: 1,
    });
  });

  test("wants the team: hand-off at the time they gave, else now", () => {
    expect(afterCall(contact(), "conversation", outcome("human_callback"), campaign(), NOW)).toMatchObject({ status: "handoff", handoff: { followUpAt: NOW } });
    const whenAt = "2026-10-28T10:30:00+05:30";
    expect(afterCall(contact(), "conversation", outcome("human_callback", { whenAt }), campaign(), NOW).handoff?.followUpAt).toEqual(new Date(whenAt));
  });

  test("call me back: a call-back at their time, returning to the next reach step", () => {
    const whenAt = at(6 * HOUR).toISOString();
    expect(afterCall(contact({ step: 0 }), "conversation", outcome("call_back", { whenAt, when: "this afternoon" }), campaign(), NOW)).toMatchObject({
      status: "callback",
      step: 1,
      callbacks: 1,
      nextAt: new Date(whenAt),
      note: "Call back: this afternoon",
    });
  });

  test("call me back with no time is tomorrow; a time too soon is clamped", () => {
    expect(afterCall(contact(), "conversation", outcome("call_back"), campaign(), NOW).nextAt).toEqual(at(24 * HOUR));
    expect(afterCall(contact(), "conversation", outcome("call_back", { whenAt: at(-HOUR).toISOString() }), campaign(), NOW).nextAt).toEqual(at(15 * 60_000));
    expect(afterCall(contact(), "conversation", outcome("call_back", { whenAt: "not a date" }), campaign(), NOW).nextAt).toEqual(at(24 * HOUR));
  });

  test("a call-back that asks for another keeps its return step; past the limit, hand-off", () => {
    expect(afterCall(contact({ status: "callback", step: 2, callbacks: 1 }), "conversation", outcome("call_back"), campaign(), NOW)).toMatchObject({
      status: "callback",
      step: 2,
      callbacks: 2,
    });
    expect(afterCall(contact({ status: "callback", step: 2, callbacks: 2 }), "conversation", outcome("call_back"), campaign(), NOW)).toMatchObject({ status: "handoff" });
    expect(afterCall(contact(), "conversation", outcome("call_back"), campaign({ maxCallbacks: 0 }), NOW)).toMatchObject({ status: "handoff" });
  });

  test("no, wrong person, do not contact", () => {
    expect(afterCall(contact(), "conversation", outcome("not_interested", { summary: "Has a vendor" }), campaign(), NOW)).toMatchObject({
      status: "not_interested",
      note: "Has a vendor",
      nextAt: null,
    });
    expect(afterCall(contact(), "conversation", outcome("wrong_person"), campaign(), NOW)).toMatchObject({ status: "stopped", note: "Wrong person" });
    const dnc = afterCall(contact(), "conversation", outcome("do_not_contact"), campaign(), NOW);
    expect(dnc).toMatchObject({ status: "stopped", doNotContact: true });
  });

  test("other, or no outcome at all, goes to a person", () => {
    expect(afterCall(contact(), "conversation", outcome("other", { summary: "Asked about pricing" }), campaign(), NOW)).toMatchObject({
      status: "handoff",
      note: "Asked about pricing",
      handoff: { followUpAt: NOW },
    });
    expect(afterCall(contact(), "conversation", null, campaign(), NOW)).toMatchObject({ status: "handoff" });
  });
});

describe("afterMessage", () => {
  test("a sent reach message moves on; the last one leaves them unreached", () => {
    expect(afterMessage(contact({ step: 1 }), true, campaign(), NOW)).toMatchObject({ status: "reaching", step: 2 });
    expect(afterMessage(contact({ step: 2 }), true, campaign(), NOW)).toMatchObject({ status: "unreached" });
  });

  test("the last chase message gives them a day to book before a hand-off", () => {
    const decision = afterMessage(contact({ status: "chasing", step: 1 }), true, campaign(), NOW);
    expect(decision).toMatchObject({ status: "handoff", handoff: { followUpAt: at(CHASE_GRACE_MS) } });
    expect(afterMessage(contact({ status: "chasing", step: 0 }), true, campaign(), NOW)).toMatchObject({ status: "chasing", step: 1, nextAt: at(48 * HOUR) });
  });

  test("the booking link sent starts the chase at its first step", () => {
    expect(afterMessage(contact({ status: "chasing", step: 0 }), true, campaign(), NOW, { bookingLink: true })).toMatchObject({
      status: "chasing",
      step: 0,
      nextAt: at(24 * HOUR),
    });
    expect(afterMessage(contact({ status: "chasing" }), true, campaign({ chaseSteps: [] }), NOW, { bookingLink: true })).toMatchObject({
      status: "handoff",
      handoff: { followUpAt: at(CHASE_GRACE_MS) },
    });
  });

  test("a booking link that failed goes to a person; another failed message retries", () => {
    expect(afterMessage(contact({ status: "chasing" }), false, campaign(), NOW, { bookingLink: true, error: "Logged out" })).toMatchObject({
      status: "handoff",
      note: "The booking link could not be sent: Logged out",
    });
    expect(afterMessage(contact({ step: 2 }), false, campaign(), NOW, { error: "Logged out" })).toMatchObject({ status: "reaching", step: 2, failures: 1, nextAt: at(ERROR_RETRY_MS) });
  });

  test("starting a step moves a queued lead into reaching", () => {
    expect(statusWhenStarted("queued")).toBe("reaching");
    expect(statusWhenStarted("callback")).toBe("callback");
  });
});

describe("callResultFor", () => {
  const call = (status: "pending" | "in_progress" | "recorded" | "no_recording" | "failed", extra: Partial<Parameters<typeof callResultFor>[0]> = {}) => ({
    status,
    error: null,
    agentOutcome: null,
    endedAt: null,
    updatedAt: NOW,
    ...extra,
  });

  test("open calls wait", () => {
    expect(callResultFor(call("pending"), NOW)).toBe("wait");
    expect(callResultFor(call("in_progress"), NOW)).toBe("wait");
  });

  test("a recorded call is a conversation unless the agent heard nobody", () => {
    expect(callResultFor(call("recorded", { agentOutcome: outcome("interested") }), NOW)).toBe("conversation");
    expect(callResultFor(call("recorded", { agentOutcome: outcome("no_response") }), NOW)).toBe("no_answer");
  });

  test("a recorded call without an outcome waits 90 s for it", () => {
    expect(callResultFor(call("recorded", { endedAt: at(-30_000) }), NOW)).toBe("wait");
    expect(callResultFor(call("recorded", { endedAt: at(-120_000) }), NOW)).toBe("conversation");
  });

  test("unanswered, not on WhatsApp, a failed upload, other failures", () => {
    expect(callResultFor(call("no_recording"), NOW)).toBe("no_answer");
    expect(callResultFor(call("failed", { error: "+91 98… isn't on WhatsApp" }), NOW)).toBe("not_on_whatsapp");
    expect(callResultFor(call("failed", { error: "Upload failed: 500" }), NOW)).toBe("conversation");
    expect(callResultFor(call("failed", { error: "The call worker stopped reporting on this call" }), NOW)).toBe("error");
  });
});

describe("dailyCallLimit", () => {
  const DAY = 24 * HOUR;
  const base = { stationLimit: null, ruleLimit: 30, warmupDays: 14, now: NOW };

  test("a number not yet started gets the first week's 10", () => {
    expect(dailyCallLimit({ ...base, automationStartedAt: null })).toBe(10);
  });

  test("warm-up climbs 10 a week, then the full limit", () => {
    expect(dailyCallLimit({ ...base, automationStartedAt: at(-3 * DAY) })).toBe(10);
    expect(dailyCallLimit({ ...base, automationStartedAt: at(-8 * DAY) })).toBe(20);
    expect(dailyCallLimit({ ...base, automationStartedAt: at(-14 * DAY) })).toBe(30);
    expect(dailyCallLimit({ ...base, warmupDays: 30, automationStartedAt: at(-21 * DAY) })).toBe(30);
  });

  test("the number's own limit wins; warm-up off is the limit from day one", () => {
    expect(dailyCallLimit({ ...base, stationLimit: 5, automationStartedAt: null })).toBe(5);
    expect(dailyCallLimit({ ...base, stationLimit: 50, automationStartedAt: at(-60 * DAY) })).toBe(50);
    expect(dailyCallLimit({ ...base, warmupDays: 0, automationStartedAt: null })).toBe(30);
  });
});

describe("withinCallingHours", () => {
  const hours = { timezone: "Asia/Kolkata", days: [1, 2, 3, 4, 5, 6], start: "12:00", end: "19:00" };
  test("inside and outside the window, in its time zone", () => {
    expect(withinCallingHours(hours, new Date("2026-10-27T08:00:00Z"))).toBe(true); // Tue 13:30 IST
    expect(withinCallingHours(hours, new Date("2026-10-27T04:00:00Z"))).toBe(false); // Tue 09:30 IST
    expect(withinCallingHours(hours, new Date("2026-10-25T08:00:00Z"))).toBe(false); // Sunday
  });
});

describe("Cal.com", () => {
  test("the booking link carries only the lead's booking code", () => {
    expect(bookingLinkFor("https://cal.com/acme/30min", "k7p2")).toBe("https://cal.com/acme/30min?metadata[c]=k7p2");
    expect(bookingLinkFor("https://cal.com/acme/30min?month=2026-11", "k7p2")).toBe("https://cal.com/acme/30min?month=2026-11&metadata[c]=k7p2");
    expect(bookingLinkFor("not a url", "k7p2")).toBeNull();
    expect(bookingLinkFor("javascript:alert(1)", "k7p2")).toBeNull();
  });

  test("booking codes are short and skip look-alike characters", () => {
    let i = 0;
    const steps = [0, 0.5, 0.99, 0.2];
    expect(newBookingCode(4, () => steps[i++ % steps.length]!)).toBe("as9g");
    for (let n = 0; n < 200; n += 1) expect(newBookingCode()).toMatch(/^[a-hj-km-np-z2-9]{4}$/);
    expect(newBookingCode(5)).toHaveLength(5);
  });

  test("the signature is the hex HMAC-SHA256 of the raw body", () => {
    const body = JSON.stringify({ triggerEvent: "BOOKING_CREATED" });
    const signature = createHmac("sha256", "s3cret-value").update(body).digest("hex");
    expect(calcomSignatureValid(body, signature, "s3cret-value")).toBe(true);
    expect(calcomSignatureValid(body, signature.toUpperCase(), "s3cret-value")).toBe(true);
    expect(calcomSignatureValid(`${body} `, signature, "s3cret-value")).toBe(false);
    expect(calcomSignatureValid(body, signature, "other-secret")).toBe(false);
    expect(calcomSignatureValid(body, null, "s3cret-value")).toBe(false);
    expect(calcomSignatureValid(body, "no-secret-provided", "s3cret-value")).toBe(false);
  });

  test("a booking names its lead by metadata, email and phone", () => {
    const contactId = "0b8f6a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
    const event = parseCalcomEvent({
      triggerEvent: "BOOKING_CREATED",
      payload: {
        uid: "bk_1",
        startTime: "2026-10-29T06:30:00Z",
        metadata: { agentsdrContact: contactId },
        responses: { email: { label: "Email", value: "Asha@Example.com" }, attendeePhoneNumber: { value: "+919876543210" } },
        attendees: [{ email: "asha@example.com", name: "Asha" }],
      },
    });
    expect(event).toEqual({
      kind: "booked",
      uid: "bk_1",
      startTime: new Date("2026-10-29T06:30:00Z"),
      bookingCode: null,
      contactId,
      emails: ["asha@example.com"],
      phones: ["+919876543210"],
    });
  });

  test("a booking names its lead by the link's booking code", () => {
    const event = parseCalcomEvent({ triggerEvent: "BOOKING_CREATED", payload: { metadata: { c: "K7P2" } } });
    expect(event).toMatchObject({ bookingCode: "k7p2", contactId: null });
    expect(parseCalcomEvent({ triggerEvent: "BOOKING_CREATED", payload: { metadata: { c: "no spaces!" } } })?.bookingCode).toBeNull();
  });

  test("rescheduled is a booking, cancelled a cancellation, the rest ignored", () => {
    expect(parseCalcomEvent({ triggerEvent: "BOOKING_RESCHEDULED", payload: {} })?.kind).toBe("booked");
    expect(parseCalcomEvent({ triggerEvent: "BOOKING_CANCELLED", payload: { metadata: { agentsdrContact: "not-a-uuid" } } })).toMatchObject({
      kind: "cancelled",
      contactId: null,
    });
    expect(parseCalcomEvent({ triggerEvent: "PING" })).toBeNull();
    expect(parseCalcomEvent({ triggerEvent: "MEETING_ENDED", payload: {} })).toBeNull();
    expect(parseCalcomEvent("nonsense")).toBeNull();
  });
});

describe("composeAgentBrief", () => {
  test("campaign instructions, then this call", () => {
    expect(composeAgentBrief({ campaignInstructions: "We sell ads tools.", purpose: "reach", stepInstructions: "First call" })).toBe(
      "We sell ads tools.\n\nThis call: First call",
    );
  });

  test("a call-back and a chase say why this call", () => {
    expect(composeAgentBrief({ campaignInstructions: "", purpose: "callback", stepInstructions: null, callbackWhen: "Thursday around 4" })).toBe(
      "This call: They asked you to call back at this time (Thursday around 4); remind them gently why you are calling.",
    );
    expect(composeAgentBrief({ campaignInstructions: "X", purpose: "chase", stepInstructions: "Did the link work?" })).toContain(
      "were sent a booking link on WhatsApp, but have not booked yet. Did the link work?",
    );
  });

  test("never empty, never over the limit", () => {
    expect(composeAgentBrief({ campaignInstructions: "", purpose: "reach", stepInstructions: "" })).toContain("This call: Introduce yourself");
    const long = composeAgentBrief({ campaignInstructions: "a".repeat(3_990), purpose: "reach", stepInstructions: "b".repeat(1_000) });
    expect(long.length).toBeLessThanOrEqual(4_000);
    expect(long.endsWith("b".repeat(1_000))).toBe(true);
  });
});
