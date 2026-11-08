import "server-only";

import { and, asc, eq, notInArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { WHATSAPP_PROVIDERS, type WhatsappProvider } from "./providers";
import type { WhatsappAccountSummary } from "./contract";
import { WhatsappApiError } from "./errors";
import { warmUpEndsAt } from "./guardrails";
import { channelRules } from "@/lib/channels/rules.server";
import { whatsappAccounts } from "./schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import type { callingStations } from "@/lib/calls/schema";
import { stationAccountRef } from "./stationParse";

/**
 * The WhatsApp numbers linked in Unipile, as whatsapp_accounts. Unipile is
 * the source of truth for those (provider "unipile"): sync re-reads it, and
 * nothing here creates a Unipile account Unipile does not list. LinkedIn
 * accounts sync separately (src/functions/syncAllAccounts.ts, type LINKEDIN
 * only).
 *
 * A calling station's number is an account too (provider "station",
 * unipile_account_id "station:<station id>"): AgentSDR's own messaging through
 * the station's WhatsApp Web (stationMessaging.ts). Its row follows the
 * station (ensureStationWhatsappAccount), never Unipile's list, and it is
 * never made the default on its own.
 */

export type WhatsappAccountRow = typeof whatsappAccounts.$inferSelect;

/** One default per organization, so the advisory lock is per organization too. */
function defaultLockKey(): string {
  return `whatsapp-accounts:default:${currentOrganizationId()}`;
}

/** `warmUpHours` is the organization's rule (Settings → WhatsApp → Sending rules). */
export function toWhatsappAccountSummary(row: WhatsappAccountRow, warmUpHours: number, now = new Date()): WhatsappAccountSummary {
  const ends = warmUpEndsAt(row.connectedAt, now, warmUpHours);
  return {
    id: row.id,
    unipileAccountId: row.unipileAccountId,
    name: row.name,
    phone: row.phone,
    status: row.status,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    warmUpEndsAt: ends?.toISOString() ?? null,
    isDefault: row.isDefault,
    newChatsPerDay: row.newChatsPerDay,
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
  };
}

export async function listWhatsappAccounts(): Promise<WhatsappAccountSummary[]> {
  const rows = await db.select().from(whatsappAccounts).where(inOrg(whatsappAccounts)).orderBy(asc(whatsappAccounts.createdAt), asc(whatsappAccounts.id));
  const now = new Date();
  const { warmupHours } = await channelRules("whatsapp");
  return rows.map((row) => toWhatsappAccountSummary(row, warmupHours, now));
}

/**
 * Re-reads the linked numbers from every messaging provider (providers/):
 * upserts each by its provider id, stamps connected_at the first time one is
 * seen connected (that starts its new-chat warm-up), marks numbers a provider
 * no longer lists as disconnected, and makes one account the default when
 * none is.
 */
export async function syncWhatsappAccounts(): Promise<WhatsappAccountSummary[]> {
  for (const provider of WHATSAPP_PROVIDERS) await syncProviderAccounts(provider);
  await ensureDefaultAccount();
  return listWhatsappAccounts();
}

async function syncProviderAccounts(provider: WhatsappProvider): Promise<void> {
  const listed = await provider.listAccounts();
  const now = new Date();

  for (const account of listed) {
    const connected = account.status === "connected";
    await db
      .insert(whatsappAccounts)
      .values({
        organizationId: currentOrganizationId(),
        unipileAccountId: account.providerAccountId,
        provider: provider.key,
        name: account.name,
        phone: account.phone,
        status: account.status,
        connectedAt: connected ? now : null,
        lastSyncedAt: now,
      })
      .onConflictDoUpdate({
        target: whatsappAccounts.unipileAccountId,
        // A provider account belongs to one organization; never touch another's row.
        setWhere: inOrg(whatsappAccounts),
        set: {
          name: account.name,
          phone: sql`coalesce(${account.phone}::text, ${whatsappAccounts.phone})`,
          status: account.status,
          connectedAt: connected
            ? sql`coalesce(${whatsappAccounts.connectedAt}, ${now.toISOString()}::timestamptz)`
            : sql`${whatsappAccounts.connectedAt}`,
          lastSyncedAt: now,
          updatedAt: now,
        },
      });
  }

  // Only this provider's own numbers: a calling station's is never in its list.
  const listedIds = listed.map((account) => account.providerAccountId);
  const providerOnly = eq(whatsappAccounts.provider, provider.key);
  await db
    .update(whatsappAccounts)
    .set({ status: "disconnected", lastSyncedAt: now, updatedAt: now })
    .where(listedIds.length
      ? and(inOrg(whatsappAccounts), providerOnly, notInArray(whatsappAccounts.unipileAccountId, listedIds), sql`${whatsappAccounts.status} <> 'disconnected'`)
      : and(inOrg(whatsappAccounts), providerOnly, sql`${whatsappAccounts.status} <> 'disconnected'`));
}

/**
 * When no account is the default, the oldest connected Unipile number (else
 * the oldest Unipile number) becomes it. A calling station's number is the
 * default only when someone chooses it: it belongs to AI calling first.
 */
async function ensureDefaultAccount(): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${defaultLockKey()}, 0))`);
    const [current] = await tx
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.isDefault, true)))
      .limit(1);
    if (current) return;
    const [candidate] = await tx
      .select({ id: whatsappAccounts.id })
      .from(whatsappAccounts)
      .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.provider, "unipile")))
      .orderBy(sql`(${whatsappAccounts.status} = 'connected') desc`, asc(whatsappAccounts.createdAt), asc(whatsappAccounts.id))
      .limit(1);
    if (!candidate) return;
    await tx
      .update(whatsappAccounts)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, candidate.id)));
  });
}

/** Makes one account the default — and every other one not. */
export async function setDefaultWhatsappAccount(id: string): Promise<WhatsappAccountSummary> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${defaultLockKey()}, 0))`);
    const [target] = await tx.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, id))).limit(1);
    if (!target) throw new WhatsappApiError(404, "WhatsApp account not found");
    const now = new Date();
    await tx
      .update(whatsappAccounts)
      .set({ isDefault: sql`${whatsappAccounts.id} = ${id}::uuid`, updatedAt: now })
      .where(and(inOrg(whatsappAccounts), sql`(${whatsappAccounts.isDefault} or ${whatsappAccounts.id} = ${id}::uuid)`));
    return { ...target, isDefault: true, updatedAt: now };
  });
  return toWhatsappAccountSummary(row, (await channelRules("whatsapp")).warmupHours);
}

/** The number's own new-chats-a-day limit; null follows the organization's rule. */
export async function setWhatsappNewChatsPerDay(id: string, newChatsPerDay: number | null): Promise<WhatsappAccountSummary> {
  const [row] = await db
    .update(whatsappAccounts)
    .set({ newChatsPerDay, updatedAt: new Date() })
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, id)))
    .returning();
  if (!row) throw new WhatsappApiError(404, "WhatsApp account not found");
  return toWhatsappAccountSummary(row, (await channelRules("whatsapp")).warmupHours);
}

export async function getWhatsappAccountRow(id: string): Promise<WhatsappAccountRow | null> {
  const [row] = await db.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.id, id))).limit(1);
  return row ?? null;
}

export async function findWhatsappAccountByUnipileId(unipileAccountId: string): Promise<WhatsappAccountRow | null> {
  const [row] = await db
    .select()
    .from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.unipileAccountId, unipileAccountId)))
    .limit(1);
  return row ?? null;
}

export async function getDefaultWhatsappAccountRow(): Promise<WhatsappAccountRow | null> {
  const [row] = await db.select().from(whatsappAccounts).where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.isDefault, true))).limit(1);
  return row ?? null;
}

export async function hasConnectedWhatsappAccount(): Promise<boolean> {
  const [row] = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.status, "connected")))
    .limit(1);
  return Boolean(row);
}

// --- calling stations' numbers -------------------------------------------------------

type StationForAccount = Pick<
  typeof callingStations.$inferSelect,
  "id" | "organizationId" | "name" | "phone" | "linkedPhone" | "status" | "createdAt"
>;

/** A station's number can message while it is active and logged in as itself. */
export function stationAccountStatus(station: Pick<StationForAccount, "status" | "phone" | "linkedPhone">): "connected" | "disconnected" {
  const ownAccount = !station.linkedPhone || station.linkedPhone === station.phone;
  return station.status === "active" && ownAccount ? "connected" : "disconnected";
}

/**
 * The station's whatsapp_accounts row, created or brought up to date (name,
 * number, connected while the station is active). Runs in the station's
 * organization. Its warm-up starts from the station's creation: the number
 * has been linked to automation since then.
 */
export async function ensureStationWhatsappAccount(station: StationForAccount): Promise<WhatsappAccountRow> {
  if (station.organizationId !== currentOrganizationId()) throw new Error("ensureStationWhatsappAccount outside the station's organization");
  const status = stationAccountStatus(station);
  const phone = station.linkedPhone ?? station.phone;
  const now = new Date();
  const [row] = await db
    .insert(whatsappAccounts)
    .values({
      organizationId: station.organizationId,
      unipileAccountId: stationAccountRef(station.id),
      provider: "station",
      stationId: station.id,
      name: station.name,
      phone,
      status,
      connectedAt: status === "connected" ? station.createdAt : null,
      lastSyncedAt: now,
    })
    .onConflictDoUpdate({
      target: whatsappAccounts.unipileAccountId,
      setWhere: and(inOrg(whatsappAccounts), eq(whatsappAccounts.stationId, station.id)),
      set: {
        name: station.name,
        phone,
        status,
        connectedAt: status === "connected"
          ? sql`coalesce(${whatsappAccounts.connectedAt}, ${station.createdAt.toISOString()}::timestamptz)`
          : sql`${whatsappAccounts.connectedAt}`,
        lastSyncedAt: now,
        updatedAt: now,
      },
    })
    .returning();
  if (row) return row;
  // Nothing to update (another organization's row by that id cannot exist: the id is the station's).
  const existing = await findWhatsappAccountByUnipileId(stationAccountRef(station.id));
  if (!existing) throw new Error(`whatsapp_accounts row for station ${station.id} could not be written`);
  return existing;
}

/** A station that is gone: its number stays (with its chats), disconnected. */
export async function disconnectStationWhatsappAccount(stationId: string): Promise<void> {
  await db
    .update(whatsappAccounts)
    .set({ status: "disconnected", updatedAt: new Date() })
    .where(and(inOrg(whatsappAccounts), eq(whatsappAccounts.stationId, stationId)));
}
