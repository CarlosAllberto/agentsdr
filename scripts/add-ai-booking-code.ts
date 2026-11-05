/**
 * AI calling campaigns: the short code a lead's booking link carries
 * (call_campaign_contacts.ai_booking_code, `metadata[c]=k7p2`), unique across
 * organizations. Matches src/lib/calls/schema.ts.
 *
 * Run with:  bun run scripts/add-ai-booking-code.ts
 *
 * Additive and re-runnable.
 */
import { Client } from "pg";

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set — check .env.local");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("SET lock_timeout = '5s'");
    await client.query(`ALTER TABLE call_campaign_contacts ADD COLUMN IF NOT EXISTS ai_booking_code text`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS call_campaign_contacts_ai_booking_code_uq ON call_campaign_contacts (ai_booking_code) WHERE ai_booking_code IS NOT NULL`,
    );
    console.log("call_campaign_contacts.ai_booking_code ready");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
