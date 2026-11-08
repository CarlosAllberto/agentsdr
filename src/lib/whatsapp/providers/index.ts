import "server-only";

import type { WhatsappProvider, WhatsappProviderKey } from "./types";
import { unipileWhatsappProvider } from "./unipile";

export type * from "./types";

const PROVIDERS: Record<WhatsappProviderKey, WhatsappProvider> = {
  unipile: unipileWhatsappProvider,
};

/** Every provider whose numbers "Sync" re-reads. */
export const WHATSAPP_PROVIDERS: readonly WhatsappProvider[] = Object.values(PROVIDERS);

/** True for a provider key; false for "station" (worker-sent) or anything unknown. */
export function isWhatsappProviderKey(value: string): value is WhatsappProviderKey {
  return Object.hasOwn(PROVIDERS, value);
}

/**
 * The provider an account sends through, from its `provider` column. Throws
 * for a calling station's number: those never reach a provider API.
 */
export function getWhatsappProvider(key: string): WhatsappProvider {
  if (!isWhatsappProviderKey(key)) throw new Error(`No WhatsApp messaging provider "${key}"`);
  return PROVIDERS[key];
}
