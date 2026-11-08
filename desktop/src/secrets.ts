import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

/**
 * The secrets the server needs before it can read its database, made once
 * on first start and kept in the user's app-data folder, encrypted with the
 * OS keychain (Electron safeStorage) where one is available.
 *
 * INTEGRATION_CREDENTIALS_KEY decrypts every saved integration credential:
 * losing this file means re-entering them, so it is never regenerated once it
 * exists.
 */
export type DesktopSecrets = {
  BETTER_AUTH_SECRET: string;
  INTEGRATION_CREDENTIALS_KEY: string;
  UNSUBSCRIBE_SECRET: string;
  CRON_SECRET: string;
  OUTREACH_TICK_SECRET: string;
  CALL_WORKER_SECRET: string;
  POSTGRES_PASSWORD: string;
};

const NAMES: (keyof DesktopSecrets)[] = [
  "BETTER_AUTH_SECRET",
  "INTEGRATION_CREDENTIALS_KEY",
  "UNSUBSCRIBE_SECRET",
  "CRON_SECRET",
  "OUTREACH_TICK_SECRET",
  "CALL_WORKER_SECRET",
  "POSTGRES_PASSWORD",
];

const fresh = () => randomBytes(32).toString("hex");

function read(file: string): Partial<DesktopSecrets> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file);
  const text = raw.subarray(0, 4).toString() === "enc:" ? safeStorage.decryptString(raw.subarray(4)) : raw.toString("utf8");
  return JSON.parse(text) as Partial<DesktopSecrets>;
}

function write(file: string, secrets: DesktopSecrets): void {
  const text = JSON.stringify(secrets);
  const body = safeStorage.isEncryptionAvailable()
    ? Buffer.concat([Buffer.from("enc:"), safeStorage.encryptString(text)])
    : Buffer.from(text, "utf8");
  writeFileSync(file, body, { mode: 0o600 });
}

export function loadSecrets(userData: string): DesktopSecrets {
  const file = join(userData, "secrets.bin");
  const existing = read(file);
  const missing = NAMES.filter((name) => !existing[name]);
  const secrets = Object.fromEntries(NAMES.map((name) => [name, existing[name] ?? fresh()])) as DesktopSecrets;
  if (missing.length) write(file, secrets);
  return secrets;
}
