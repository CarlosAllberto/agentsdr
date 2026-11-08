import "server-only";

import {
  findUnipileWhatsappChat,
  listUnipileWhatsappAccounts,
  listUnipileWhatsappChats,
  listUnipileWhatsappMessages,
  sendUnipileWhatsappMessage,
  startUnipileWhatsappChat,
  unipileErrorStatus,
} from "@/services/unipile.whatsapp";
import { mapUnipileChat, mapUnipileMessage } from "../parse";
import type { ProviderChatRecord, ProviderMessageRecord, WhatsappProvider } from "./types";

/** WhatsApp through Unipile (the rep's own number, linked as WhatsApp Web). */
export const unipileWhatsappProvider: WhatsappProvider = {
  key: "unipile",
  label: "Unipile",

  async listAccounts() {
    const accounts = await listUnipileWhatsappAccounts();
    return accounts.map(({ unipileAccountId, ...rest }) => ({ providerAccountId: unipileAccountId, ...rest }));
  },

  findChat: (providerAccountId, e164) => findUnipileWhatsappChat(providerAccountId, e164),

  startChat: (providerAccountId, e164, text) => startUnipileWhatsappChat(providerAccountId, e164, text),

  // Unipile chat ids are global: the account is not needed to send.
  sendMessage: (_providerAccountId, chatId, text) => sendUnipileWhatsappMessage(chatId, text),

  async listChats(providerAccountId, cursor) {
    const page = await listUnipileWhatsappChats(providerAccountId, cursor);
    return {
      items: page.items.map(mapUnipileChat).filter((chat): chat is ProviderChatRecord => Boolean(chat)),
      cursor: page.cursor,
    };
  },

  async listMessages(_providerAccountId, chatId, cursor, limit) {
    const page = await listUnipileWhatsappMessages(chatId, cursor, limit);
    return {
      items: page.items.map(mapUnipileMessage).filter((message): message is ProviderMessageRecord => Boolean(message)),
      cursor: page.cursor,
    };
  },

  errorStatus: unipileErrorStatus,

  errorReason(error) {
    const body = (error as { body?: { detail?: unknown; title?: unknown } } | null)?.body;
    if (typeof body?.detail === "string") return body.detail;
    if (typeof body?.title === "string") return body.title;
    return null;
  },
};
