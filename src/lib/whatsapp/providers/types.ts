import type { WhatsappAccountStatus } from "../contract";
import type { UnipileChatRecord, UnipileMessageRecord } from "../parse";

/**
 * The messaging providers a WhatsApp number can be linked through. A calling
 * station ("station") is not one of them: its messages go through the
 * station's worker (stationMessaging.ts), never through a provider API.
 */
export type WhatsappProviderKey = "unipile" | "zernio";

/** A number as the provider lists it. */
export type ProviderWhatsappAccount = {
  /** The provider's own id for the number (whatsapp_accounts.unipile_account_id). */
  providerAccountId: string;
  name: string | null;
  /** E.164, when the provider reports one. */
  phone: string | null;
  status: WhatsappAccountStatus;
};

/** A chat as the provider lists it, already mapped. */
export type ProviderChatRecord = UnipileChatRecord;
/** A message as the provider lists it, already mapped. */
export type ProviderMessageRecord = UnipileMessageRecord;

export type ProviderPage<T> = { items: T[]; cursor: string | null };

/**
 * Everything AgentSDR asks of a WhatsApp messaging provider. Callers pick the
 * implementation from the account's `provider` column (getWhatsappProvider),
 * so a provider is swapped without touching send, delivery or backfill.
 *
 * Errors propagate as thrown; `errorStatus` reads the HTTP status off one, so
 * callers can tell a refusal (4xx) from a failure.
 */
export interface WhatsappProvider {
  readonly key: WhatsappProviderKey;
  /** Shown in error messages, e.g. "Unipile". */
  readonly label: string;

  /** Every number linked to the organization's provider workspace. */
  listAccounts(): Promise<ProviderWhatsappAccount[]>;
  /** The existing chat between a number and a phone (E.164), or null. */
  findChat(providerAccountId: string, e164: string): Promise<string | null>;
  /** Starts a chat with a phone and sends the first message. */
  startChat(providerAccountId: string, e164: string, text: string): Promise<{ chatId: string | null; messageId: string | null }>;
  /** Sends into an existing chat. */
  sendMessage(providerAccountId: string, chatId: string, text: string): Promise<{ messageId: string | null }>;
  /** A page of a number's chats, newest first. */
  listChats(providerAccountId: string, cursor?: string): Promise<ProviderPage<ProviderChatRecord>>;
  /** A page of a chat's messages, newest first. */
  listMessages(providerAccountId: string, chatId: string, cursor?: string, limit?: number): Promise<ProviderPage<ProviderMessageRecord>>;
  /** The HTTP status an error from this provider carries, when it does. */
  errorStatus(error: unknown): number | null;
  /** A human reason the provider gave for refusing, when it gave one. */
  errorReason(error: unknown): string | null;
}
