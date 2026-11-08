import "server-only";

import type { WhatsappProvider, WhatsappProviderKey } from "./types";
import { unipileWhatsappProvider } from "./unipile";
import { zernioWhatsappProvider } from "./zernio";

export type * from "./types";

const PROVIDERS: Record<WhatsappProviderKey, WhatsappProvider> = {
  unipile: unipileWhatsappProvider,
  zernio: zernioWhatsappProvider,
};

/** Every provider an existing account may send through. */
export const WHATSAPP_PROVIDERS: readonly WhatsappProvider[] = Object.values(PROVIDERS);

/**
 * The providers whose numbers "Sync" re-reads. Only Zernio: WhatsApp moved off
 * Unipile (which stays for LinkedIn), so a Unipile WhatsApp number is not
 * linked any more; one synced before the move still sends through Unipile.
 */
export const SYNCED_WHATSAPP_PROVIDERS: readonly WhatsappProvider[] = [zernioWhatsappProvider];

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
