import "server-only";

/**
 * Cal.com for AI calling campaigns: the booking link the agent's WhatsApp
 * carries, and the webhook that tells a campaign its lead booked.
 *
 * Cal.com is a platform integration (key `calcom`, Settings → WhatsApp →
 * Integrations): the organization's webhook secret, and an optional API key.
 * The webhook URL carries `?org=<organization id>` (calcomWebhookUrl, shown
 * on that page); a delivery is checked against that organization's secret
 * (x-cal-signature-256) before anything is read from it.
 *
 * A booking finds its lead by the booking code the link put in the booking's
 * metadata (or, for a link sent before codes, the contact id), else by the
 * attendee's email or phone among the organization's open AI leads.
 * Created / rescheduled → `booked` (ai_meeting_at), in Action required a day
 * before the meeting (meetingPrepAt); cancelled → back to `chasing` where it
 * was, in Action required a day later unless they book again.
 */
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { publicAppUrl } from "@/lib/http/publicAppUrl";
import { people } from "@/lib/leads/schema";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { normalizePhone } from "../phone";
import { organizationPhoneCountry } from "../phone.server";
import { callCampaignContacts, callCampaigns, callCampaignStepRuns } from "../schema";
import { AI_OPEN_STATUSES, type AiContactStatus } from "./contract";
import { BOOKING_LINK_KEY, BOOKING_REVIEW_MS, calcomSignatureValid, meetingPrepAt, parseCalcomEvent, type CalcomBookingEvent } from "./engineRules";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** After a cancellation, the chase resumes after this. */
const RESUME_AFTER_CANCEL_MS = 60 * 60 * 1000;

export const CALCOM_WEBHOOK_PATH = "/api/webhooks/calcom";

/** The URL to paste into Cal.com's webhook; null without a public URL for this deployment. */
export function calcomWebhookUrl(organizationId: string): string | null {
  const origin = publicAppUrl();
  return origin ? `${origin}${CALCOM_WEBHOOK_PATH}?org=${encodeURIComponent(organizationId)}` : null;
}

/** call_campaign_contacts belongs to its campaign's organization. */
function contactInScope() {
  return inArray(callCampaignContacts.campaignId, db.select({ id: callCampaigns.id }).from(callCampaigns).where(inOrg(callCampaigns)));
}

/** POST /api/webhooks/calcom?org=… */
export async function handleCalcomWebhook(request: Request): Promise<Response> {
  const organizationId = new URL(request.url).searchParams.get("org") ?? "";
  if (!UUID_PATTERN.test(organizationId)) return Response.json({ error: "Missing or invalid org" }, { status: 400 });
  const rawBody = await request.text();
  const signature = request.headers.get("x-cal-signature-256");

  return runInOrganization(organizationId, async () => {
    const credentials = await getPlatformCredentials("calcom");
    if (!credentials || !calcomSignatureValid(rawBody, signature, credentials.webhookSecret)) {
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return Response.json({ ok: true, ignored: "not JSON" });
    }
    const event = parseCalcomEvent(body);
    if (!event) return Response.json({ ok: true, ignored: "event" });
    const contactIds = event.kind === "booked" ? await markBooked(event) : await markCancelled(event);
    return Response.json({ ok: true, contacts: contactIds.length });
  });
}

type MatchedContact = { id: string; personId: string; aiStep: number; meetingAt: Date | null; chaseSteps: (typeof callCampaigns.$inferSelect)["aiChaseSteps"] };

/** The leads a booking names: by its metadata booking code or contact id, else by the attendee's email or phone among `statuses`. */
async function matchContacts(
  event: CalcomBookingEvent,
  statuses: readonly AiContactStatus[],
  byIdStatuses: readonly AiContactStatus[],
): Promise<MatchedContact[]> {
  const columns = {
    id: callCampaignContacts.id,
    personId: callCampaignContacts.personId,
    aiStep: callCampaignContacts.aiStep,
    meetingAt: callCampaignContacts.aiMeetingAt,
    chaseSteps: callCampaigns.aiChaseSteps,
  };
  const aiCampaign = and(inOrg(callCampaigns), eq(callCampaigns.runBy, "ai"));
  const named = event.bookingCode
    ? eq(callCampaignContacts.aiBookingCode, event.bookingCode)
    : event.contactId
      ? eq(callCampaignContacts.id, event.contactId)
      : null;
  if (named) {
    const byId = await db
      .select(columns)
      .from(callCampaignContacts)
      .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
      .where(and(aiCampaign, named, inArray(callCampaignContacts.aiStatus, [...byIdStatuses])));
    if (byId.length) return byId;
  }
  const country = await organizationPhoneCountry();
  const phones = [...new Set(event.phones.map((phone) => normalizePhone(phone, country)).filter((phone): phone is string => !!phone))];
  if (!event.emails.length && !phones.length) return [];
  const personMatch = or(
    event.emails.length ? inArray(sql`lower(${people.email})`, event.emails) : undefined,
    phones.length ? inArray(people.phone, phones) : undefined,
  );
  return db
    .select(columns)
    .from(callCampaignContacts)
    .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
    .innerJoin(people, eq(people.id, callCampaignContacts.personId))
    .where(and(aiCampaign, inOrg(people), personMatch, inArray(callCampaignContacts.aiStatus, [...statuses])));
}

async function syncFollowUps(personIds: string[]): Promise<void> {
  const { syncCallFollowUpSafely } = await import("../crmFollowUp");
  for (const personId of new Set(personIds)) await syncCallFollowUpSafely(personId);
}

/** A booking (or a new time): booked, in Action required a day before the meeting. Any lead the link named except one stopped. */
async function markBooked(event: CalcomBookingEvent): Promise<string[]> {
  const byIdStatuses: AiContactStatus[] = ["queued", "reaching", "callback", "chasing", "booked", "handoff", "not_interested", "unreached", "replied", "failed"];
  const matched = await matchContacts(event, [...AI_OPEN_STATUSES, "booked"], byIdStatuses);
  if (!matched.length) return [];
  const now = new Date();
  const updated = await db
    .update(callCampaignContacts)
    .set({
      aiStatus: "booked",
      aiBookedAt: now,
      aiNextAt: null,
      aiFailures: 0,
      aiNote: "Meeting booked",
      stage: "follow_up",
      aiMeetingAt: event.startTime,
      followUpAt: meetingPrepAt(event.startTime, now),
      updatedAt: now,
    })
    .where(and(contactInScope(), inArray(callCampaignContacts.id, matched.map((c) => c.id)), ne(callCampaignContacts.aiStatus, "stopped")))
    .returning({ id: callCampaignContacts.id, personId: callCampaignContacts.personId });
  await syncFollowUps(updated.map((row) => row.personId));
  return updated.map((row) => row.id);
}

/**
 * A cancelled booking: back to chasing at the step it was at, if the chase
 * was working it (the booking link went out from a call); a lead that booked
 * some other way — after replying, or from a forwarded or plain link — goes
 * to a person instead. Only the booking we hold — a cancelled booking at
 * another time (the old slot of a reschedule) leaves the lead booked.
 */
async function markCancelled(event: CalcomBookingEvent): Promise<string[]> {
  const matched = (await matchContacts(event, ["booked"], ["booked"])).filter(
    (contact) => !event.startTime || !contact.meetingAt || contact.meetingAt.getTime() === event.startTime.getTime(),
  );
  const changed: { id: string; personId: string }[] = [];
  const now = new Date();
  const chased = matched.length
    ? new Set(
        (
          await db
            .select({ contactId: callCampaignStepRuns.contactId })
            .from(callCampaignStepRuns)
            .where(and(inArray(callCampaignStepRuns.contactId, matched.map((contact) => contact.id)), eq(callCampaignStepRuns.stepKey, BOOKING_LINK_KEY)))
        ).map((row) => row.contactId),
      )
    : new Set<string>();
  for (const contact of matched) {
    const resume = chased.has(contact.id) ? contact.chaseSteps[contact.aiStep] : undefined;
    const [row] = await db
      .update(callCampaignContacts)
      .set(
        resume
          ? {
              aiStatus: "chasing",
              aiNextAt: new Date(now.getTime() + RESUME_AFTER_CANCEL_MS),
              aiNote: "Cancelled the meeting",
              aiMeetingAt: null,
              stage: "follow_up",
              followUpAt: new Date(now.getTime() + BOOKING_REVIEW_MS),
              updatedAt: now,
            }
          : { aiStatus: "handoff", aiNextAt: null, aiNote: "Cancelled the meeting", aiMeetingAt: null, stage: "follow_up", followUpAt: now, updatedAt: now },
      )
      .where(and(contactInScope(), eq(callCampaignContacts.id, contact.id), eq(callCampaignContacts.aiStatus, "booked")))
      .returning({ id: callCampaignContacts.id, personId: callCampaignContacts.personId });
    if (row) changed.push(row);
  }
  await syncFollowUps(changed.map((row) => row.personId));
  return changed.map((row) => row.id);
}
