/**
 * AI calling campaigns: the start of a lead's booked meeting, from Cal.com
 * (call_campaign_contacts.ai_meeting_at). Before this the meeting time was
 * kept in follow_up_at, which now holds when the lead reaches Action required
 * (a day before the meeting), so this copies it across for leads already
 * booked. Matches src/lib/calls/schema.ts.
 *
 * Run with:  bun run scripts/add-ai-meeting-at.ts
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
    await client.query(`ALTER TABLE call_campaign_contacts ADD COLUMN IF NOT EXISTS ai_meeting_at timestamptz`);
    const copied = await client.query(
      `UPDATE call_campaign_contacts SET ai_meeting_at = follow_up_at WHERE ai_status = 'booked' AND ai_meeting_at IS NULL AND follow_up_at IS NOT NULL`,
    );
    console.log(`call_campaign_contacts.ai_meeting_at ready (${copied.rowCount} booked lead(s) copied)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
