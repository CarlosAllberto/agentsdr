import "server-only";

import { and, asc, desc, eq, gt, ilike, inArray, isNull, like, notLike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmPipelines, crmRecords } from "@/lib/crm/schema";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import type { CrmExecutor } from "@/lib/crm/repository";
import { companies, people } from "@/lib/leads/schema";
import { personCompanyName } from "@/lib/leads/companyName";
import { pickRepresentativeRecord } from "@/lib/calls/leadStageRules";
import { getWhatsappProvider, type ProviderChatRecord } from "./providers";
import type {
  BackfillWhatsappAccountResponse,
  ListWhatsappChatsResponse,
  PersonWhatsappThreadResponse,
  WhatsappAttachment,
  WhatsappChatSummary,
  WhatsappDirection,
  WhatsappMessage,
  WhatsappMessageOrigin,
  WhatsappPersonRef,
  WhatsappThreadResponse,
} from "./contract";
import {
  ensureStationWhatsappAccount,
  findWhatsappAccountByUnipileId,
  getWhatsappAccountRow,
  hasConnectedWhatsappAccount,
  syncWhatsappAccounts,
  type WhatsappAccountRow,
} from "./accounts";
import { forwardWhatsappInboundToCrm, recordWhatsappOutboundInCrm } from "./crmBridge";
import { WhatsappApiError } from "./errors";
import {
  decideIngest,
  ECHO_MATCH_WINDOW_MS,
  messagePreview,
  parseWhatsappWebhook,
  pickPendingSend,
  type ParsedWhatsappMessageEvent,
} from "./parse";
import { whatsappAccounts, whatsappChats, whatsappMessages } from "./schema";
import { callingStations, stationMessageJobs } from "@/lib/calls/schema";
import type { StationInboundMessage, WorkerInboundResponse } from "@/lib/calls/stationContract";
import { isUuid, pickStationEcho, stationAttachments, stationChatKey, stationMessageKey } from "./stationParse";

/**
 * WhatsApp chats and messages: what Unipile's webhook delivers, what the
 * backfill imports, and what the Messages tab / calling panel / CRM record
 * read. Sending is in send.ts, which stores through the helpers here.
 *
 * A message is stored once, keyed by its Unipile id. Its origin says who
 * wrote it: the lead ("lead", inbound), AgentSDR ("agentsdr", sent through
 * Unipile) or the rep's own phone / WhatsApp Web ("phone" — an echo AgentSDR
 * did not send). An AgentSDR send is stored before Unipile answers, without
 * an id; its echo, which can arrive before that answer, attaches the id.
 */

export type WhatsappChatRow = typeof whatsappChats.$inferSelect;
export type WhatsappMessageRow = typeof whatsappMessages.$inferSelect;

/**
 * A chat AgentSDR is starting has no Unipile id until Unipile answers, but
 * the column is NOT NULL: it holds "pending:<uuid>" until then. Hidden from
 * every list; the webhook adopts it when the new chat's first echo arrives.
 */
export const PENDING_CHAT_PREFIX = "pending:";
const PENDING_CHAT_ADOPT_MS = 10 * 60 * 1000;

/**
 * whatsapp_chats and whatsapp_messages have no organization column of their
 * own: they belong to the organization of their account. These are the
 * filters that say so.
 */
export function chatInOrg(): SQL {
  return inArray(whatsappChats.accountId, db.select({ id: whatsappAccounts.id }).from(whatsappAccounts).where(inOrg(whatsappAccounts)));
}

export function messageInOrg(): SQL {
  return inArray(whatsappMessages.chatId, db.select({ id: whatsappChats.id }).from(whatsappChats).where(chatInOrg()));
}

export function isPendingChatId(unipileChatId: string): boolean {
  return unipileChatId.startsWith(PENDING_CHAT_PREFIX);
}

export function isUniqueViolation(error: unknown): boolean {
  const value = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return value?.code === "23505" || value?.cause?.code === "23505";
}

// --- people --------------------------------------------------------------------------

/** The person with this number (people.phone is E.164); the oldest when several share it. */
export async function matchPersonByPhone(phone: string | null, executor: CrmExecutor = db): Promise<string | null> {
  if (!phone) return null;
  const [row] = await executor
    .select({ id: people.id })
    .from(people)
    .where(and(inOrg(people), eq(people.phone, phone)))
    .orderBy(asc(people.createdAt), asc(people.id))
    .limit(1);
  return row?.id ?? null;
}

async function loadPersonRefs(personIds: string[]): Promise<Map<string, WhatsappPersonRef>> {
  const ids = [...new Set(personIds)];
  const refs = new Map<string, WhatsappPersonRef>();
  if (!ids.length) return refs;
  const [rows, records] = await Promise.all([
    db
      .select({
        id: people.id,
        fullName: people.fullName,
        firstName: people.firstName,
        lastName: people.lastName,
        title: people.title,
        profilePictureUrl: people.profilePictureUrl,
        raw: people.raw,
        companyName: companies.name,
      })
      .from(people)
      .leftJoin(companies, eq(companies.id, people.companyId))
      .where(and(inOrg(people), inArray(people.id, ids))),
    db
      .select({
        id: crmRecords.id,
        personId: crmRecords.personId,
        updatedAt: crmRecords.updatedAt,
        isDefaultPipeline: crmPipelines.isDefault,
      })
      .from(crmRecords)
      .innerJoin(crmPipelines, eq(crmPipelines.id, crmRecords.pipelineId))
      .where(and(inOrg(crmRecords), inArray(crmRecords.personId, ids))),
  ]);
  const recordsByPerson = new Map<string, (typeof records)[number][]>();
  for (const record of records) recordsByPerson.set(record.personId, [...(recordsByPerson.get(record.personId) ?? []), record]);
  for (const row of rows) {
    const fullName = row.fullName?.trim() || [row.firstName, row.lastName].filter(Boolean).join(" ").trim() || null;
    refs.set(row.id, {
      id: row.id,
      fullName,
      title: row.title,
      companyName: personCompanyName(row.raw, row.companyName),
      profilePictureUrl: row.profilePictureUrl,
      crmRecordId: pickRepresentativeRecord(recordsByPerson.get(row.id) ?? [])?.id ?? null,
    });
  }
  return refs;
}

// --- mapping --------------------------------------------------------------------------

export function toWhatsappMessage(row: WhatsappMessageRow): WhatsappMessage {
  return {
    id: row.id,
    chatId: row.chatId,
    direction: row.direction,
    origin: row.origin,
    body: row.body,
    attachments: row.attachments ?? [],
    sentAt: row.sentAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
  };
}

function toChatSummary(row: WhatsappChatRow, person: WhatsappPersonRef | null): WhatsappChatSummary {
  return {
    id: row.id,
    accountId: row.accountId,
    phone: row.phone,
    name: row.name,
    person,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: row.lastMessagePreview,
    lastDirection: row.lastDirection,
    unreadCount: row.unreadCount,
  };
}

export async function toWhatsappChatSummary(row: WhatsappChatRow): Promise<WhatsappChatSummary> {
  const refs = await loadPersonRefs(row.personId ? [row.personId] : []);
  return toChatSummary(row, row.personId ? refs.get(row.personId) ?? null : null);
}

// --- storage ---------------------------------------------------------------------------

export type ChatUpsert = {
  accountId: string;
  unipileChatId: string;
  providerId: string | null;
  phone: string | null;
  name: string | null;
  /** Applied only when the chat is created (the backfill's Unipile count). */
  initialUnreadCount?: number;
};

/**
 * The chat row for a Unipile chat — created, or refreshed with what is now
 * known (number, name). A chat AgentSDR is starting with that number
 * (PENDING_CHAT_PREFIX) is adopted rather than duplicated. Links the chat to
 * the person with its number when it has none yet.
 */
export async function upsertWhatsappChat(input: ChatUpsert, executor: CrmExecutor = db): Promise<WhatsappChatRow> {
  const [existing] = await executor
    .select()
    .from(whatsappChats)
    .where(and(chatInOrg(), eq(whatsappChats.accountId, input.accountId), eq(whatsappChats.unipileChatId, input.unipileChatId)))
    .limit(1);

  let row: WhatsappChatRow | undefined = existing;
  if (!row && input.phone) row = await adoptPendingChat(input, executor);

  const now = new Date();
  if (!row) {
    const [inserted] = await executor
      .insert(whatsappChats)
      .values({
        accountId: input.accountId,
        unipileChatId: input.unipileChatId,
        providerId: input.providerId,
        phone: input.phone,
        name: input.name,
        unreadCount: input.initialUnreadCount ?? 0,
      })
      .onConflictDoUpdate({
        target: [whatsappChats.accountId, whatsappChats.unipileChatId],
        set: { updatedAt: now },
      })
      .returning();
    row = inserted;
  }
  if (!row) throw new Error("whatsapp_chats upsert returned no row");

  const patch: Partial<typeof whatsappChats.$inferInsert> = {};
  if (input.providerId && row.providerId !== input.providerId) patch.providerId = input.providerId;
  if (input.phone && row.phone !== input.phone) patch.phone = input.phone;
  if (input.name && row.name !== input.name) patch.name = input.name;
  const phone = patch.phone ?? row.phone;
  if (!row.personId && phone) {
    const personId = await matchPersonByPhone(phone, executor);
    if (personId) patch.personId = personId;
  }
  if (Object.keys(patch).length === 0) return row;
  const [updated] = await executor
    .update(whatsappChats)
    .set({ ...patch, updatedAt: now })
    .where(and(chatInOrg(), eq(whatsappChats.id, row.id)))
    .returning();
  return updated ?? row;
}

/** A chat AgentSDR started with this number moments ago, still waiting for its Unipile id. */
async function adoptPendingChat(input: ChatUpsert, executor: CrmExecutor): Promise<WhatsappChatRow | undefined> {
  const [pending] = await executor
    .select()
    .from(whatsappChats)
    .where(and(
      chatInOrg(),
      eq(whatsappChats.accountId, input.accountId),
      like(whatsappChats.unipileChatId, `${PENDING_CHAT_PREFIX}%`),
      eq(whatsappChats.phone, input.phone!),
      gt(whatsappChats.createdAt, new Date(Date.now() - PENDING_CHAT_ADOPT_MS)),
    ))
    .orderBy(desc(whatsappChats.createdAt))
    .limit(1);
  if (!pending) return undefined;
  try {
    const [adopted] = await executor
      .update(whatsappChats)
      .set({ unipileChatId: input.unipileChatId, updatedAt: new Date() })
      .where(and(chatInOrg(), eq(whatsappChats.id, pending.id), like(whatsappChats.unipileChatId, `${PENDING_CHAT_PREFIX}%`)))
      .returning();
    return adopted;
  } catch (error) {
    // The real chat row appeared meanwhile; the send merges into it.
    if (isUniqueViolation(error)) return undefined;
    throw error;
  }
}

export type MessageInsert = {
  chatId: string;
  unipileMessageId: string | null;
  direction: WhatsappDirection;
  origin: WhatsappMessageOrigin;
  body: string;
  attachments: WhatsappAttachment[];
  sentAt: Date;
  deliveredAt?: Date | null;
  readAt?: Date | null;
  callSessionId?: string | null;
  raw?: Record<string, unknown> | null;
};

/** Inserts a message; null when its Unipile id is already stored. */
export async function insertWhatsappMessage(input: MessageInsert, executor: CrmExecutor = db): Promise<WhatsappMessageRow | null> {
  const [row] = await executor
    .insert(whatsappMessages)
    .values({
      chatId: input.chatId,
      unipileMessageId: input.unipileMessageId,
      direction: input.direction,
      origin: input.origin,
      body: input.body,
      attachments: input.attachments,
      sentAt: input.sentAt,
      deliveredAt: input.deliveredAt ?? null,
      readAt: input.readAt ?? null,
      callSessionId: input.callSessionId ?? null,
      raw: input.raw ?? null,
    })
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/** Moves the chat's "last message" forward (never back), and counts an inbound message as unread. */
export async function applyMessageToChat(
  chatId: string,
  message: { sentAt: Date; body: string; attachments: WhatsappAttachment[]; direction: WhatsappDirection; countUnread: boolean },
  executor: CrmExecutor = db,
): Promise<void> {
  const newer = sql`(${whatsappChats.lastMessageAt} is null or ${whatsappChats.lastMessageAt} <= ${message.sentAt.toISOString()}::timestamptz)`;
  await executor
    .update(whatsappChats)
    .set({
      lastMessageAt: sql`case when ${newer} then ${message.sentAt.toISOString()}::timestamptz else ${whatsappChats.lastMessageAt} end`,
      lastMessagePreview: sql`case when ${newer} then ${messagePreview(message.body, message.attachments)}::text else ${whatsappChats.lastMessagePreview} end`,
      lastDirection: sql`case when ${newer} then ${message.direction}::text else ${whatsappChats.lastDirection} end`,
      unreadCount: message.countUnread ? sql`${whatsappChats.unreadCount} + 1` : sql`${whatsappChats.unreadCount}`,
      updatedAt: new Date(),
    })
    .where(and(chatInOrg(), eq(whatsappChats.id, chatId)));
}

async function findMessageByUnipileId(unipileMessageId: string): Promise<WhatsappMessageRow | null> {
  const [row] = await db
    .select()
    .from(whatsappMessages)
    .where(and(messageInOrg(), eq(whatsappMessages.unipileMessageId, unipileMessageId)))
    .limit(1);
  return row ?? null;
}

// --- webhook ------------------------------------------------------------------------------

export type WebhookLog = { level: "info" | "warn" | "error"; message: string; time: string }[];
export type WebhookOutcome = "ok" | "skipped";

function logger(entries: WebhookLog) {
  const add = (level: WebhookLog[number]["level"]) => (message: string) => {
    entries.push({ level, message, time: new Date().toISOString() });
  };
  return { info: add("info"), warn: add("warn"), error: add("error") };
}

/**
 * One delivery of /api/webhooks/whatsapp-message. Throws only on a database
 * failure (the caller marks the delivery errored); everything it cannot use
 * is a logged "skipped".
 */
export async function ingestWhatsappWebhook(payload: unknown, entries: WebhookLog): Promise<WebhookOutcome> {
  const log = logger(entries);
  const parsed = parseWhatsappWebhook(payload);

  if (parsed.kind === "ignore") {
    log.info(`Ignored: ${parsed.reason}`);
    return "skipped";
  }

  if (parsed.kind === "status") {
    const at = parsed.at;
    const updated = await db
      .update(whatsappMessages)
      .set(parsed.status === "read"
        ? { readAt: sql`coalesce(${whatsappMessages.readAt}, ${at.toISOString()}::timestamptz)`, deliveredAt: sql`coalesce(${whatsappMessages.deliveredAt}, ${at.toISOString()}::timestamptz)` }
        : { deliveredAt: sql`coalesce(${whatsappMessages.deliveredAt}, ${at.toISOString()}::timestamptz)` })
      .where(and(messageInOrg(), eq(whatsappMessages.unipileMessageId, parsed.unipileMessageId)))
      .returning({ id: whatsappMessages.id });
    log.info(updated.length ? `Marked ${parsed.status}: message ${parsed.unipileMessageId}` : `No stored message ${parsed.unipileMessageId} to mark ${parsed.status}`);
    return updated.length ? "ok" : "skipped";
  }

  return ingestMessageEvent(parsed, payload as Record<string, unknown>, log);
}

/**
 * A message read from a provider's API (Zernio polling) instead of pushed by a
 * webhook. Same path as a webhook delivery: dedupe on the provider id, echo
 * matching for AgentSDR's own sends, the CRM for a known lead.
 */
export async function ingestPolledWhatsappMessage(
  event: ParsedWhatsappMessageEvent,
  raw: Record<string, unknown>,
): Promise<{ outcome: WebhookOutcome; log: WebhookLog }> {
  const entries: WebhookLog = [];
  const outcome = await ingestMessageEvent(event, raw, logger(entries));
  return { outcome, log: entries };
}

async function ingestMessageEvent(
  event: ParsedWhatsappMessageEvent,
  raw: Record<string, unknown>,
  log: ReturnType<typeof logger>,
): Promise<WebhookOutcome> {
  let account = await findWhatsappAccountByUnipileId(event.unipileAccountId);
  if (!account) {
    log.info(`Unknown account ${event.unipileAccountId} — syncing WhatsApp accounts once`);
    await syncWhatsappAccounts();
    account = await findWhatsappAccountByUnipileId(event.unipileAccountId);
  }
  if (!account) {
    log.warn(`Account ${event.unipileAccountId} is not a linked WhatsApp number — skipped`);
    return "skipped";
  }

  const stored = await findMessageByUnipileId(event.unipileMessageId);
  if (stored) {
    log.info(`Message ${event.unipileMessageId} already stored (${stored.origin}) — ${event.isSender ? "echo of a stored send" : "retried delivery"}, no-op`);
    return "skipped";
  }

  const chat = await upsertWhatsappChat({
    accountId: account.id,
    unipileChatId: event.unipileChatId,
    providerId: event.counterpartyProviderId,
    phone: event.counterpartyPhone,
    // An echo's attendee name is the lead's; so is an inbound sender's.
    name: event.counterpartyName,
  });
  log.info(`Chat ${chat.id} (${chat.phone ?? event.counterpartyProviderId})${chat.personId ? ` → person ${chat.personId}` : " — no person with this number"}`);

  const pendingMatch = event.isSender ? pickPendingSend(await pendingSends(chat.id), event, new Date()) : null;
  const decision = decideIngest({ isSender: event.isSender, alreadyStored: false, pendingMatch });

  if (decision.action === "attach") {
    try {
      const [attached] = await db
        .update(whatsappMessages)
        .set({ unipileMessageId: event.unipileMessageId, raw })
        .where(and(messageInOrg(), eq(whatsappMessages.id, decision.pendingId), isNull(whatsappMessages.unipileMessageId)))
        .returning({ id: whatsappMessages.id });
      log.info(attached ? `Echo of AgentSDR send ${decision.pendingId} — id attached` : `Echo of AgentSDR send ${decision.pendingId} — already had its id`);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      log.info(`Echo ${event.unipileMessageId} already stored by the send itself — no-op`);
    }
    return "ok";
  }
  if (decision.action === "duplicate") return "skipped";

  const origin = decision.origin;
  const message = await insertWhatsappMessage({
    chatId: chat.id,
    unipileMessageId: event.unipileMessageId,
    direction: origin === "lead" ? "inbound" : "outbound",
    origin,
    body: event.body,
    attachments: event.attachments,
    sentAt: event.sentAt,
    raw,
  });
  if (!message) {
    log.info(`Message ${event.unipileMessageId} stored concurrently — no-op`);
    return "skipped";
  }
  await applyMessageToChat(chat.id, {
    sentAt: message.sentAt,
    body: message.body,
    attachments: message.attachments,
    direction: message.direction,
    countUnread: origin === "lead",
  });
  log.info(`Stored ${origin === "lead" ? "inbound message from the lead" : "message the rep sent from their phone"} (${message.id})`);

  if (!chat.personId) return "ok";
  const crmInput = {
    personId: chat.personId,
    unipileAccountId: account.unipileAccountId,
    unipileChatId: chat.unipileChatId,
    providerContactId: chat.providerId,
    unipileMessageId: event.unipileMessageId,
    body: message.body,
    sentAt: message.sentAt,
    raw,
  };
  const result = origin === "lead"
    ? await forwardWhatsappInboundToCrm(crmInput)
    : await recordWhatsappOutboundInCrm({ ...crmInput, origin: "phone" });
  if (result.crmConversationMessageId) {
    await db
      .update(whatsappMessages)
      .set({ crmConversationMessageId: result.crmConversationMessageId })
      .where(and(messageInOrg(), eq(whatsappMessages.id, message.id)));
    log.info(`Recorded on the CRM (${result.crmConversationMessageId})`);
  } else {
    log.info("Not recorded on the CRM (the bridge returned no message)");
  }
  return "ok";
}

/** AgentSDR sends in this chat still waiting for their Unipile id. */
async function pendingSends(chatId: string) {
  return db
    .select({ id: whatsappMessages.id, body: whatsappMessages.body, sentAt: whatsappMessages.sentAt })
    .from(whatsappMessages)
    .where(and(
      messageInOrg(),
      eq(whatsappMessages.chatId, chatId),
      eq(whatsappMessages.origin, "agentsdr"),
      isNull(whatsappMessages.unipileMessageId),
      gt(whatsappMessages.sentAt, new Date(Date.now() - ECHO_MATCH_WINDOW_MS)),
    ));
}

// --- calling stations (AgentSDR's own WhatsApp Web, no Unipile) ---------------------------

/**
 * What a calling station's WhatsApp Web showed arriving on its number, as the
 * call worker reports it (POST /api/call-worker/stations/:id/inbound) — the
 * Unipile webhook's flow without Unipile: stored once per WhatsApp message
 * (stationMessageKey), the chat matched to the Person by number, unread
 * counted, and forwarded to the CRM exactly like a Unipile message (accountRef
 * "station:<station id>"), which also stops the lead's sequences.
 *
 * An outbound message is the echo of AgentSDR's own send when a reserved send
 * in that chat with the same text is still waiting for its id (its job claimed
 * or sent); otherwise the rep typed it on the phone (origin "phone").
 *
 * Platform-wide lookup of the station (the worker serves every organization);
 * everything after runs in the station's organization.
 */
export async function ingestStationMessages(stationId: string, messages: StationInboundMessage[]): Promise<WorkerInboundResponse> {
  if (!isUuid(stationId)) throw new WhatsappApiError(404, "Calling number not found");
  const [station] = await db.select().from(callingStations).where(eq(callingStations.id, stationId)).limit(1);
  if (!station) throw new WhatsappApiError(404, "Calling number not found");
  return runInOrganization(station.organizationId, async () => {
    const account = await ensureStationWhatsappAccount(station);
    let stored = 0;
    let skipped = 0;
    for (const message of [...messages].sort((left, right) => left.sentAt - right.sentAt)) {
      try {
        if (await ingestStationMessage(account, stationId, message)) stored += 1;
        else skipped += 1;
      } catch (error) {
        // One bad message must not lose the rest of the batch.
        console.error(`[whatsapp/station] could not store message ${message.providerMessageId} from station ${stationId}`, error);
        skipped += 1;
      }
    }
    return { stored, skipped };
  });
}

async function ingestStationMessage(account: WhatsappAccountRow, stationId: string, event: StationInboundMessage): Promise<boolean> {
  const key = stationMessageKey(stationId, event.providerMessageId);
  if (!key) return false;
  if (await findMessageByUnipileId(key)) return false;

  const { unipileChatId, phone } = stationChatKey(event);
  const chat = await upsertWhatsappChat({ accountId: account.id, unipileChatId, providerId: unipileChatId, phone, name: event.chatName });
  const sentAt = new Date(event.sentAt);
  const raw: Record<string, unknown> = { source: "station", stationId, providerMessageId: event.providerMessageId, chatJid: event.chatJid, ...(event.kind ? { kind: event.kind } : {}) };

  if (event.direction === "outbound") {
    // Our own sends still waiting for WhatsApp's id — including one that failed
    // as uncertain (it may have gone out): its echo proves it did.
    const pending = await db
      .select({
        id: whatsappMessages.id,
        body: whatsappMessages.body,
        sentAt: whatsappMessages.sentAt,
        jobId: stationMessageJobs.id,
        jobStatus: stationMessageJobs.status,
      })
      .from(whatsappMessages)
      .innerJoin(stationMessageJobs, eq(stationMessageJobs.whatsappMessageId, whatsappMessages.id))
      .where(and(
        messageInOrg(),
        eq(whatsappMessages.chatId, chat.id),
        eq(whatsappMessages.origin, "agentsdr"),
        isNull(whatsappMessages.unipileMessageId),
        or(
          inArray(stationMessageJobs.status, ["claimed", "sent"]),
          and(eq(stationMessageJobs.status, "failed"), sql`${whatsappMessages.raw}->>'status' = 'uncertain'`),
        ),
      ));
    const echo = pickStationEcho(pending, event.text);
    if (echo) {
      try {
        const uncertain = echo.jobStatus === "failed";
        const [attached] = await db
          .update(whatsappMessages)
          .set({
            unipileMessageId: key,
            ...(uncertain ? { sentAt, raw: sql`coalesce(${whatsappMessages.raw}, '{}'::jsonb) || '{"status":"sent"}'::jsonb` } : {}),
          })
          .where(and(messageInOrg(), eq(whatsappMessages.id, echo.id), isNull(whatsappMessages.unipileMessageId)))
          .returning({ id: whatsappMessages.id });
        if (attached && uncertain) {
          await db
            .update(stationMessageJobs)
            .set({ status: "sent", sentAt, error: null })
            .where(and(inOrg(stationMessageJobs), eq(stationMessageJobs.id, echo.jobId), eq(stationMessageJobs.status, "failed")));
        }
        return Boolean(attached);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return false;
      }
    }
  }

  const origin: WhatsappMessageOrigin = event.direction === "inbound" ? "lead" : "phone";
  const message = await insertWhatsappMessage({
    chatId: chat.id,
    unipileMessageId: key,
    direction: event.direction,
    origin,
    body: event.text,
    attachments: stationAttachments(event.kind),
    sentAt,
    raw,
  });
  if (!message) return false;
  await applyMessageToChat(chat.id, {
    sentAt: message.sentAt,
    body: message.body,
    attachments: message.attachments,
    direction: message.direction,
    countUnread: origin === "lead",
  });

  if (!chat.personId) return true;
  const crmInput = {
    personId: chat.personId,
    unipileAccountId: account.unipileAccountId,
    unipileChatId: chat.unipileChatId,
    providerContactId: chat.providerId,
    unipileMessageId: key,
    body: message.body,
    sentAt: message.sentAt,
    raw,
  };
  const result = origin === "lead"
    ? await forwardWhatsappInboundToCrm(crmInput)
    : await recordWhatsappOutboundInCrm({ ...crmInput, origin: "phone" });
  if (result.crmConversationMessageId) {
    await db
      .update(whatsappMessages)
      .set({ crmConversationMessageId: result.crmConversationMessageId })
      .where(and(messageInOrg(), eq(whatsappMessages.id, message.id)));
  }
  return true;
}

// --- read side -----------------------------------------------------------------------------

const CHAT_PAGE_SIZE = 50;
const THREAD_MESSAGE_LIMIT = 500;

/**
 * Keyset cursor: the last chat's activity exactly as Postgres printed it (a
 * JS Date would drop the microseconds and skip or repeat rows) and its id.
 */
type ChatCursor = { at: string; id: string };
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function encodeCursor(cursor: ChatCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.id]), "utf8").toString("base64url");
}

function decodeCursor(value: string): ChatCursor {
  try {
    const [at, id] = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown[];
    if (typeof at === "string" && typeof id === "string" && PG_TIMESTAMP.test(at) && UUID.test(id)) {
      return { at, id };
    }
  } catch {
    // fall through
  }
  throw new WhatsappApiError(400, "cursor is not valid");
}

/** A chat's place in the list: its last message, else when it was created. */
const chatActivity = sql<string>`coalesce(${whatsappChats.lastMessageAt}, ${whatsappChats.createdAt})`;
/** Every chat but one AgentSDR is still starting (PENDING_CHAT_PREFIX). */
export const visibleChat = notLike(whatsappChats.unipileChatId, `${PENDING_CHAT_PREFIX}%`);

export type ListWhatsappChatsInput = {
  accountId?: string | null;
  search?: string | null;
  unread?: boolean;
  cursor?: string | null;
};

export async function listWhatsappChats(input: ListWhatsappChatsInput): Promise<ListWhatsappChatsResponse> {
  const conditions: SQL[] = [chatInOrg(), visibleChat];
  if (input.accountId) conditions.push(eq(whatsappChats.accountId, input.accountId));
  if (input.unread) conditions.push(gt(whatsappChats.unreadCount, 0));
  const search = input.search?.trim();
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const digits = search.replace(/\D/g, "");
    const matches: SQL[] = [ilike(whatsappChats.name, pattern), ilike(people.fullName, pattern), ilike(whatsappChats.phone, pattern)];
    if (digits.length >= 3) matches.push(like(whatsappChats.phone, `%${digits}%`));
    conditions.push(or(...matches)!);
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor);
    conditions.push(sql`(${chatActivity}, ${whatsappChats.id}) < (${cursor.at}::timestamptz, ${cursor.id}::uuid)`);
  }

  const rows = await db
    .select({ chat: whatsappChats, activity: chatActivity })
    .from(whatsappChats)
    .leftJoin(people, and(eq(people.id, whatsappChats.personId), inOrg(people)))
    .where(and(...conditions))
    .orderBy(desc(chatActivity), desc(whatsappChats.id))
    .limit(CHAT_PAGE_SIZE + 1);

  const page = rows.slice(0, CHAT_PAGE_SIZE);
  const refs = await loadPersonRefs(page.flatMap(({ chat }) => (chat.personId ? [chat.personId] : [])));
  const last = page.at(-1);
  return {
    chats: page.map(({ chat }) => toChatSummary(chat, chat.personId ? refs.get(chat.personId) ?? null : null)),
    nextCursor: rows.length > CHAT_PAGE_SIZE && last
      ? encodeCursor({ at: String(last.activity), id: last.chat.id })
      : null,
  };
}

async function threadMessages(chatId: string): Promise<WhatsappMessage[]> {
  const rows = await db
    .select()
    .from(whatsappMessages)
    .where(and(messageInOrg(), eq(whatsappMessages.chatId, chatId)))
    .orderBy(desc(whatsappMessages.sentAt), desc(whatsappMessages.createdAt))
    .limit(THREAD_MESSAGE_LIMIT);
  return rows.reverse().map(toWhatsappMessage);
}

async function getVisibleChat(chatId: string): Promise<WhatsappChatRow> {
  const [row] = await db.select().from(whatsappChats).where(and(chatInOrg(), eq(whatsappChats.id, chatId), visibleChat)).limit(1);
  if (!row) throw new WhatsappApiError(404, "WhatsApp chat not found");
  return row;
}

/** A chat and its messages, oldest first (the latest THREAD_MESSAGE_LIMIT). */
export async function getWhatsappThread(chatId: string): Promise<WhatsappThreadResponse> {
  const chat = await getVisibleChat(chatId);
  const [summary, messages] = await Promise.all([toWhatsappChatSummary(chat), threadMessages(chat.id)]);
  return { chat: summary, messages };
}

/** Clears the chat's unread count in AgentSDR (WhatsApp itself is not told). */
export async function markWhatsappChatRead(chatId: string): Promise<{ ok: true }> {
  const [row] = await db
    .update(whatsappChats)
    .set({ unreadCount: 0, updatedAt: new Date() })
    .where(and(chatInOrg(), eq(whatsappChats.id, chatId), visibleChat))
    .returning({ id: whatsappChats.id });
  if (!row) throw new WhatsappApiError(404, "WhatsApp chat not found");
  return { ok: true };
}

/**
 * The lead's most recent chat across accounts — linked to them, or with
 * their number and not yet linked to anyone.
 */
export async function getPersonWhatsappThread(personId: string): Promise<PersonWhatsappThreadResponse> {
  const [person] = await db.select({ id: people.id, phone: people.phone }).from(people).where(and(inOrg(people), eq(people.id, personId))).limit(1);
  if (!person) throw new WhatsappApiError(404, "Person not found");
  const owns = person.phone
    ? or(eq(whatsappChats.personId, personId), and(isNull(whatsappChats.personId), eq(whatsappChats.phone, person.phone)))!
    : eq(whatsappChats.personId, personId);
  const [[chat], canSend] = await Promise.all([
    db
      .select()
      .from(whatsappChats)
      .where(and(chatInOrg(), owns, visibleChat))
      .orderBy(desc(chatActivity), desc(whatsappChats.id))
      .limit(1),
    hasConnectedWhatsappAccount(),
  ]);
  if (!chat) return { chat: null, messages: [], canSend };
  const [summary, messages] = await Promise.all([toWhatsappChatSummary(chat), threadMessages(chat.id)]);
  return { chat: summary, messages, canSend };
}

// --- backfill ---------------------------------------------------------------------------------

const BACKFILL_CHAT_PAGES = 2;
const BACKFILL_MESSAGES_PER_CHAT = 30;
const BACKFILL_CONCURRENCY = 4;

export type BackfillResult = BackfillWhatsappAccountResponse;

/**
 * Imports an account's recent chats and their latest messages from Unipile
 * — history, so nothing is forwarded to the CRM. Safe to re-run: messages
 * dedupe on their Unipile id. A sent message in history is taken as typed on
 * the phone; AgentSDR's own sends are already stored with their ids.
 */
export async function backfillWhatsappAccount(accountId: string): Promise<BackfillResult> {
  const account = await getWhatsappAccountRow(accountId);
  if (!account) throw new WhatsappApiError(404, "WhatsApp account not found");
  if (account.provider === "station") throw new WhatsappApiError(409, "A calling number's messages arrive from its WhatsApp Web as they come; there is no history to import");
  if (account.status !== "connected") throw new WhatsappApiError(409, "This WhatsApp number is not connected");

  const provider = getWhatsappProvider(account.provider);
  const chats: ProviderChatRecord[] = [];
  let cursor: string | undefined;
  let skippedGroups = 0;
  for (let page = 0; page < BACKFILL_CHAT_PAGES; page += 1) {
    const response = await provider.listChats(account.unipileAccountId, cursor);
    for (const chat of response.items) {
      if (chat.isGroup) skippedGroups += 1;
      else chats.push(chat);
    }
    if (!response.cursor) break;
    cursor = response.cursor;
  }

  let importedChats = 0;
  let importedMessages = 0;
  const queue = [...chats];
  const worker = async () => {
    for (let chat = queue.shift(); chat; chat = queue.shift()) {
      importedMessages += await backfillChat(account, chat);
      importedChats += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(BACKFILL_CONCURRENCY, queue.length) }, worker));
  return { importedChats, importedMessages, skippedGroups };
}

async function backfillChat(account: WhatsappAccountRow, chat: ProviderChatRecord): Promise<number> {
  const row = await upsertWhatsappChat({
    accountId: account.id,
    unipileChatId: chat.unipileChatId,
    providerId: chat.providerId,
    phone: chat.phone,
    name: chat.name,
    initialUnreadCount: chat.unreadCount,
  });
  const response = await getWhatsappProvider(account.provider).listMessages(account.unipileAccountId, chat.unipileChatId, undefined, BACKFILL_MESSAGES_PER_CHAT);
  const messages = [...response.items]
    .sort((left, right) => left.sentAt.getTime() - right.sentAt.getTime());

  let imported = 0;
  for (const message of messages) {
    const inserted = await insertWhatsappMessage({
      chatId: row.id,
      unipileMessageId: message.unipileMessageId,
      direction: message.isSender ? "outbound" : "inbound",
      origin: message.isSender ? "phone" : "lead",
      body: message.body,
      attachments: message.attachments,
      sentAt: message.sentAt,
      deliveredAt: message.deliveredAt,
      readAt: message.readAt,
    });
    if (inserted) imported += 1;
  }
  const newest = messages.at(-1);
  if (newest) {
    await applyMessageToChat(row.id, {
      sentAt: newest.sentAt,
      body: newest.body,
      attachments: newest.attachments,
      direction: newest.isSender ? "outbound" : "inbound",
      countUnread: false,
    });
  }
  return imported;
}
