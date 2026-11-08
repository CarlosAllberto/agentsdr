import "server-only";

import {
  findZernioWhatsappChat,
  listZernioWhatsappAccounts,
  listZernioWhatsappChats,
  listZernioWhatsappMessages,
  mapZernioConversation,
  mapZernioMessage,
  sendZernioWhatsappMessage,
  startZernioWhatsappChat,
  ZernioApiError,
} from "@/services/zernio.whatsapp";
import type { ProviderChatRecord, ProviderMessageRecord, WhatsappProvider } from "./types";

/**
 * Plain-language reasons for Zernio's codes that a rep can act on; the
 * rest pass Zernio's own message through.
 */
const ZERNIO_REASONS: Record<string, string> = {
  TEMPLATE_REQUIRED: "Meta needs an approved template to start this chat. Set one under Settings → WhatsApp → Integrations → Zernio",
  DIRECT_SEND_NOT_ELIGIBLE: "This WhatsApp Business account can't start chats without a template. Set an approved template under Settings → WhatsApp → Integrations → Zernio",
  recipient_must_message_first: "More than 24 hours passed since the lead last wrote, so Meta only allows a template message",
  recipient_opted_out: "The lead opted out of messages from this number",
  new_contact_limit: "This number reached Meta's daily limit of new contacts",
};

/** WhatsApp through Zernio (Meta's official WhatsApp Business API). */
export const zernioWhatsappProvider: WhatsappProvider = {
  key: "zernio",
  label: "Zernio",

  listAccounts: () => listZernioWhatsappAccounts(),
  findChat: (providerAccountId, e164) => findZernioWhatsappChat(providerAccountId, e164),
  startChat: (providerAccountId, e164, text) => startZernioWhatsappChat(providerAccountId, e164, text),
  sendMessage: (providerAccountId, chatId, text) => sendZernioWhatsappMessage(providerAccountId, chatId, text),

  async listChats(providerAccountId, cursor) {
    const page = await listZernioWhatsappChats(providerAccountId, cursor);
    return {
      items: page.items.map(mapZernioConversation).filter((chat): chat is ProviderChatRecord => Boolean(chat)),
      cursor: page.cursor,
    };
  },

  async listMessages(providerAccountId, chatId, cursor, limit) {
    const page = await listZernioWhatsappMessages(providerAccountId, chatId, cursor, limit);
    return {
      items: page.items.map(mapZernioMessage).filter((message): message is ProviderMessageRecord => Boolean(message)),
      cursor: page.cursor,
    };
  },

  errorStatus: (error) => (error instanceof ZernioApiError ? error.status : null),

  errorReason(error) {
    if (!(error instanceof ZernioApiError)) return null;
    return (error.code && ZERNIO_REASONS[error.code]) || error.message || null;
  },
};
