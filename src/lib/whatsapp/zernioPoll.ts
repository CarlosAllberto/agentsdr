import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { listOrganizationsWithPlatform } from "@/lib/platform/credentials";
import { serializeError } from "@/lib/linkedin/serializeError";
import { inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { zernioWhatsappProvider } from "./providers/zernio";
import type { ProviderChatRecord, ProviderMessageRecord } from "./providers";
import { chatInOrg, ingestPolledWhatsappMessage } from "./messages";
import type { ParsedWhatsappMessageEvent } from "./parse";
import { whatsappAccounts, whatsappChats } from "./schema";

/**
 * Reads new WhatsApp messages from Zernio's inbox API, once a minute (the
 * `whatsapp-zernio-poll` platform job). A desktop install has no public URL,
 * so Zernio's webhooks cannot reach it; polling replaces them.
 *
 * Per connected Zernio number: the newest page of conversations; a
 * conversation whose `updatedTime` is newer than the stored chat's last
 * message has its latest messages read and ingested through the webhook path
 * (ingestPolledWhatsappMessage), which dedupes on the message id. So a run
 * that overlaps or repeats stores nothing twice.
 */

const MESSAGES_PER_CHAT = 20;

export type ZernioPollSummary = { organizations: number; accounts: number; chats: number; stored: number; failed: number };

/** Exported for tests: the conversations with something we have not read yet. */
export function chatsToRead(chats: ProviderChatRecord[], stored: Map<string, Date | null>): ProviderChatRecord[] {
  return chats.filter((chat) => {
    if (chat.isGroup || !chat.phone) return false;
    const last = stored.get(chat.unipileChatId);
    if (last === undefined || last === null) return true;
    return !chat.lastMessageAt || chat.lastMessageAt.getTime() > last.getTime();
  });
}

/** Exported for tests: a polled message as the webhook path's event. */
export function polledMessageEvent(accountId: string, chat: ProviderChatRecord, message: ProviderMessageRecord): ParsedWhatsappMessageEvent {
  return {
    kind: "message",
    unipileAccountId: accountId,
    unipileChatId: chat.unipileChatId,
    unipileMessageId: message.unipileMessageId,
    isSender: message.isSender,
    counterpartyProviderId: chat.providerId ?? `${(chat.phone ?? "").replace(/\D/g, "")}@s.whatsapp.net`,
    counterpartyPhone: chat.phone,
    counterpartyName: chat.name,
    body: message.body,
    attachments: message.attachments,
    sentAt: message.sentAt,
  };
}

export async function pollZernioWhatsapp(): Promise<ZernioPollSummary> {
  const summary: ZernioPollSummary = { organizations: 0, accounts: 0, chats: 0, stored: 0, failed: 0 };
  for (const organizationId of await listOrganizationsWithPlatform("zernio")) {
    summary.organizations += 1;
    try {
      await runInOrganization(organizationId, () => pollOrganization(summary));
    } catch (error) {
      summary.failed += 1;
      console.error(`[whatsapp/zernio-poll] organization ${organizationId}: ${serializeError(error)}`);
    }
  }
  return summary;
}

async function pollOrganization(summary: ZernioPollSummary): Promise<void> {
  const accounts = await db
    .select()
    .from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.provider, "zernio"), eq(whatsappAccounts.status, "connected")));

  for (const account of accounts) {
    summary.accounts += 1;
    const page = await zernioWhatsappProvider.listChats(account.unipileAccountId);
    const ids = page.items.map((chat) => chat.unipileChatId);
    const storedRows = ids.length
      ? await db
        .select({ unipileChatId: whatsappChats.unipileChatId, lastMessageAt: whatsappChats.lastMessageAt })
        .from(whatsappChats)
        .where(and(chatInOrg(), eq(whatsappChats.accountId, account.id), inArray(whatsappChats.unipileChatId, ids)))
      : [];
    const stored = new Map(storedRows.map((row) => [row.unipileChatId, row.lastMessageAt]));

    for (const chat of chatsToRead(page.items, stored)) {
      summary.chats += 1;
      try {
        const messages = await zernioWhatsappProvider.listMessages(account.unipileAccountId, chat.unipileChatId, undefined, MESSAGES_PER_CHAT);
        // Oldest first, so the chat's last message and the CRM see them in order.
        for (const message of [...messages.items].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())) {
          const { outcome } = await ingestPolledWhatsappMessage(
            polledMessageEvent(account.unipileAccountId, chat, message),
            { source: "zernio-poll", conversationId: chat.unipileChatId, messageId: message.unipileMessageId },
          );
          if (outcome === "ok") summary.stored += 1;
        }
      } catch (error) {
        summary.failed += 1;
        console.error(`[whatsapp/zernio-poll] chat ${chat.unipileChatId}: ${serializeError(error)}`);
      }
    }
  }
}
