import { requirePlatformCredentials } from "@/lib/platform/credentials";
import type { PlatformCredentials } from "@/lib/platform/catalog";
import type { WhatsappAccountStatus, WhatsappAttachment } from "@/lib/whatsapp/contract";
import type { UnipileChatRecord, UnipileMessageRecord } from "@/lib/whatsapp/parse";

/**
 * Zernio's WhatsApp side (https://zernio.com/api, Meta's official WhatsApp
 * Business API underneath): the linked numbers, inbox conversations and
 * sending. Shapes follow the `@zernio/node` SDK's generated types; only the
 * fields AgentSDR reads are typed here.
 *
 * Ids: an account is Zernio's `_id`; a chat is an inbox conversation id; a
 * lead is addressed by phone digits (E.164 without the +). Meta lets a
 * business open a chat only with an approved template (or, for eligible
 * accounts, a Direct Send utility message), and send free text only within
 * 24 h of the lead's last message.
 */

export const ZERNIO_API_BASE = "https://zernio.com/api";

export class ZernioApiError extends Error {
  constructor(
    readonly status: number,
    /** Zernio's machine-readable code, e.g. TEMPLATE_REQUIRED, recipient_must_message_first. */
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = "ZernioApiError";
  }
}

type Credentials = PlatformCredentials["zernio"];

async function zernioFetch<T>(path: string, init: { method?: string; query?: Record<string, string | number | undefined>; body?: unknown } = {}, credentials?: Credentials): Promise<T> {
  const { apiKey } = credentials ?? (await requirePlatformCredentials("zernio"));
  const url = new URL(`${ZERNIO_API_BASE}${path}`);
  for (const [key, value] of Object.entries(init.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : `Zernio answered ${response.status}`;
    const code = typeof payload.code === "string" ? payload.code : null;
    throw new ZernioApiError(response.status, code, message);
  }
  return payload as T;
}

// ── Pure mapping (exported for tests) ──────────────────────────────────────

const digitsOf = (value: string) => value.replace(/\D/g, "");

/** "+55 11 98765-4321" → "+5511987654321"; null when it is not a phone number. */
export function zernioPhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const digits = digitsOf(value);
  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

export type ZernioAccount = {
  _id?: string;
  platform?: string;
  username?: string;
  displayName?: string;
  isActive?: boolean;
  needsReconnection?: boolean;
  enabled?: boolean;
  metadata?: { displayPhoneNumber?: string; phoneNumber?: string } & Record<string, unknown>;
};

export function zernioAccountStatus(account: ZernioAccount): WhatsappAccountStatus {
  if (account.needsReconnection) return "credentials";
  if (account.isActive === false || account.enabled === false) return "disconnected";
  return "connected";
}

export function mapZernioAccount(account: ZernioAccount) {
  if (!account._id || account.platform !== "whatsapp") return null;
  const name = account.displayName?.trim() || account.username?.trim() || null;
  return {
    providerAccountId: account._id,
    name,
    phone: zernioPhone(account.metadata?.displayPhoneNumber) ?? zernioPhone(account.metadata?.phoneNumber) ?? zernioPhone(account.username),
    status: zernioAccountStatus(account),
  };
}

export type ZernioConversation = {
  id?: string;
  participantId?: string;
  participantName?: string;
  updatedTime?: string;
  unreadCount?: number | null;
  isGroup?: boolean;
};

/**
 * A conversation → AgentSDR's chat record. The provider id keeps the
 * "<digits>@s.whatsapp.net" form Unipile used, so leads and chats already
 * matched by it keep matching.
 */
export function mapZernioConversation(conversation: ZernioConversation): UnipileChatRecord | null {
  if (!conversation.id) return null;
  const isGroup = Boolean(conversation.isGroup);
  const phone = isGroup ? null : zernioPhone(conversation.participantId);
  const updated = conversation.updatedTime ? new Date(conversation.updatedTime) : null;
  const unread = Number(conversation.unreadCount);
  return {
    unipileChatId: conversation.id,
    providerId: phone ? `${digitsOf(phone)}@s.whatsapp.net` : null,
    phone,
    name: conversation.participantName?.trim() || null,
    isGroup,
    lastMessageAt: updated && !Number.isNaN(updated.getTime()) ? updated : null,
    unreadCount: Number.isInteger(unread) && unread > 0 ? unread : 0,
  };
}

export type ZernioMessage = {
  id?: string;
  message?: string;
  direction?: "incoming" | "outgoing";
  createdAt?: string;
  attachments?: Array<{ id?: string; type?: string; mimeType?: string; filename?: string; name?: string }>;
};

export function mapZernioMessage(message: ZernioMessage): UnipileMessageRecord | null {
  const sentAt = message.createdAt ? new Date(message.createdAt) : null;
  if (!message.id || !sentAt || Number.isNaN(sentAt.getTime())) return null;
  const attachments: WhatsappAttachment[] = (message.attachments ?? []).map((attachment) => ({
    id: attachment.id ?? null,
    type: attachment.type ?? null,
    name: attachment.filename ?? attachment.name ?? null,
    mimeType: attachment.mimeType ?? null,
  }));
  return {
    unipileMessageId: message.id,
    isSender: message.direction === "outgoing",
    body: message.message ?? "",
    attachments,
    sentAt,
    // Zernio reports delivery and read through webhooks, not on the message.
    deliveredAt: null,
    readAt: null,
  };
}

/** How many variables a template's body takes ({{1}}, {{name}}, …). */
export function templateBodyVariableCount(components: Array<Record<string, unknown>> | undefined): number {
  const body = components?.find((component) => String(component.type ?? "").toUpperCase() === "BODY");
  const text = typeof body?.text === "string" ? body.text : "";
  return new Set(text.match(/\{\{\s*[\w.]+\s*\}\}/g) ?? []).size;
}

// ── API calls ──────────────────────────────────────────────────────────────

/** Every WhatsApp number connected to this Zernio workspace. */
export async function listZernioWhatsappAccounts() {
  const accounts: NonNullable<ReturnType<typeof mapZernioAccount>>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await zernioFetch<{ accounts?: ZernioAccount[]; pagination?: { nextCursor?: string | null } }>("/v1/accounts", {
      query: { platform: "whatsapp", limit: 100, cursor },
    });
    for (const account of response.accounts ?? []) {
      const mapped = mapZernioAccount(account);
      if (mapped) accounts.push(mapped);
    }
    cursor = response.pagination?.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return accounts;
}

/** The existing conversation between a number and a phone (E.164), or null. */
export async function findZernioWhatsappChat(accountId: string, e164: string): Promise<string | null> {
  const digits = digitsOf(e164);
  const response = await zernioFetch<{ data?: Array<{ conversation?: ZernioConversation }> }>("/v1/inbox/conversations/search", {
    query: { accountId, platform: "whatsapp", query: digits, limit: 10 },
  });
  const match = (response.data ?? []).find(({ conversation }) => conversation?.participantId && digitsOf(conversation.participantId) === digits);
  return match?.conversation?.id ?? null;
}

/** Template lookups, per (API key, template, language): templates change rarely. */
const templateCache = new Map<string, { variables: number; at: number }>();
const TEMPLATE_CACHE_MS = 10 * 60_000;

async function templateVariables(credentials: Credentials, accountId: string): Promise<number> {
  const cacheKey = `${credentials.apiKey}:${accountId}:${credentials.firstContactTemplate}:${credentials.templateLanguage}`;
  const cached = templateCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TEMPLATE_CACHE_MS) return cached.variables;
  const response = await zernioFetch<{ templates?: Array<{ name?: string; language?: string; status?: string; components?: Array<Record<string, unknown>> }> }>(
    "/v1/whatsapp/templates",
    { query: { accountId, name: credentials.firstContactTemplate, language: credentials.templateLanguage } },
    credentials,
  );
  const template = (response.templates ?? []).find((item) => item.name === credentials.firstContactTemplate && item.status === "APPROVED");
  if (!template) {
    throw new ZernioApiError(400, "TEMPLATE_NOT_APPROVED", `The template "${credentials.firstContactTemplate}" (${credentials.templateLanguage}) is not approved on this number`);
  }
  const variables = templateBodyVariableCount(template.components);
  templateCache.set(cacheKey, { variables, at: Date.now() });
  return variables;
}

/**
 * Opens a conversation with a phone and sends the first message: the
 * configured template (its one body variable filled with `text`), or, with
 * no template configured, `text` as a Direct Send utility message.
 */
export async function startZernioWhatsappChat(accountId: string, e164: string, text: string): Promise<{ chatId: string | null; messageId: string | null }> {
  const credentials = await requirePlatformCredentials("zernio");
  const base = { accountId, participantId: digitsOf(e164) };
  let body: Record<string, unknown>;
  if (credentials.firstContactTemplate) {
    const variables = await templateVariables(credentials, accountId);
    if (variables > 1) {
      throw new ZernioApiError(400, "INVALID_TEMPLATE_PARAMS", `The template "${credentials.firstContactTemplate}" takes ${variables} variables; AgentSDR fills at most one`);
    }
    body = {
      ...base,
      templateName: credentials.firstContactTemplate,
      templateLanguage: credentials.templateLanguage,
      ...(variables === 1 ? { templateParams: [text] } : {}),
    };
  } else {
    body = { ...base, message: text, category: "utility" };
  }
  const response = await zernioFetch<{ data?: { conversationId?: string; messageId?: string } }>("/v1/inbox/conversations", { method: "POST", body }, credentials);
  return { chatId: response.data?.conversationId ?? null, messageId: response.data?.messageId ?? null };
}

/** Sends free text into an existing conversation (inside Meta's 24 h window). */
export async function sendZernioWhatsappMessage(accountId: string, chatId: string, text: string): Promise<{ messageId: string | null }> {
  const response = await zernioFetch<{ data?: { messageId?: string } }>(`/v1/inbox/conversations/${encodeURIComponent(chatId)}/messages`, {
    method: "POST",
    body: { accountId, message: text },
  });
  return { messageId: response.data?.messageId ?? null };
}

/** A page of a number's conversations, newest first. */
export async function listZernioWhatsappChats(accountId: string, cursor?: string) {
  const response = await zernioFetch<{ data?: ZernioConversation[]; pagination?: { nextCursor?: string | null } }>("/v1/inbox/conversations", {
    query: { accountId, platform: "whatsapp", limit: 50, sortOrder: "desc", cursor },
  });
  return { items: response.data ?? [], cursor: response.pagination?.nextCursor ?? null };
}

/** A page of a conversation's messages, newest first. */
export async function listZernioWhatsappMessages(accountId: string, chatId: string, cursor?: string, limit = 100) {
  const response = await zernioFetch<{ messages?: ZernioMessage[]; pagination?: { nextCursor?: string | null } }>(
    `/v1/inbox/conversations/${encodeURIComponent(chatId)}/messages`,
    { query: { accountId, limit, sortOrder: "desc", cursor } },
  );
  return { items: response.messages ?? [], cursor: response.pagination?.nextCursor ?? null };
}
