/**
 * WhatsApp numbers linked through Zernio (Meta's official WhatsApp Business
 * API): whatsapp_accounts.provider gains 'zernio' beside 'unipile' and
 * 'station'. A Zernio number keeps its Zernio account id in
 * unipile_account_id, as a Unipile number does (the column predates the
 * second provider). Safe to re-run.
 *
 *   bun run scripts/add-zernio-whatsapp-provider.ts
 */
import { Client } from "pg";

const STATEMENTS = [
  `ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_accounts_provider_chk`,
  `ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_provider_chk
     CHECK (provider IN ('unipile', 'zernio', 'station') AND ((provider = 'station') = (station_id IS NOT NULL)))`,
];

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query("BEGIN");
    for (const statement of STATEMENTS) await client.query(statement);
    await client.query("COMMIT");
    console.log(`Zernio WhatsApp provider: ${STATEMENTS.length} statements applied`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
