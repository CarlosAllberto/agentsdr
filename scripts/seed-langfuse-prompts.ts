/**
 * Puts AgentSDR's prompts (src/lib/prompts/registry.ts) into an
 * organization's Langfuse project — the one connected in Settings → AI
 * provider — labelled "production", the version the app reads.
 *
 *   bun run --conditions=react-server scripts/seed-langfuse-prompts.ts --org <id>            # create the ones the project lacks
 *   bun run --conditions=react-server scripts/seed-langfuse-prompts.ts --org <id> --update   # also push the code's copy as a new
 *                                                                                           # version where production differs
 *   bun run --conditions=react-server scripts/seed-langfuse-prompts.ts --org <id> --check    # list differences, change nothing
 *
 * Saving the integration already creates the missing ones; this is for
 * --update and --check. Without --update a prompt already in Langfuse is
 * left alone: someone may have edited it there, and the code's copy is only
 * the fallback. With it, the code's text becomes the new production version
 * (the old ones stay in Langfuse's history). Run --update after changing a
 * prompt in code on purpose — then the code and Langfuse agree again.
 *
 * Without --org it runs as ORGANIZATION_ID, or the initial organization.
 * Bun loads .env.local itself (DATABASE_URL, INTEGRATION_CREDENTIALS_KEY);
 * only the organization's stored credentials are read from the database.
 */
import { runScriptInOrganization } from "./lib/organization";
import { getPlatformCredentials } from "@/lib/platform/credentials";
import { syncLangfusePrompts, type PromptSyncMode } from "@/lib/observability/langfusePrompts";

const update = process.argv.includes("--update");
const check = process.argv.includes("--check");
const mode: PromptSyncMode = check ? "check" : update ? "update" : "create";

const orgFlag = process.argv.indexOf("--org");
if (orgFlag !== -1) {
  const organizationId = process.argv[orgFlag + 1];
  if (!organizationId || organizationId.startsWith("--")) {
    console.error("--org needs an organization id");
    process.exit(1);
  }
  process.env.ORGANIZATION_ID = organizationId;
}

async function main(): Promise<void> {
  const credentials = await getPlatformCredentials("langfuse");
  if (!credentials) throw new Error("This organization has not connected Langfuse (Settings → AI provider).");
  console.log(`Langfuse project at ${credentials.baseUrl} (${credentials.publicKey})\n`);

  const counts = { created: 0, updated: 0, same: 0, differs: 0, missing: 0 };
  await syncLangfusePrompts(credentials, mode, (result) => {
    counts[result.outcome] += 1;
    if (result.outcome === "same") return;
    const lacks = result.missingVariables?.length ? ` (Langfuse's version lacks: ${result.missingVariables.join(", ")})` : "";
    console.log(`${result.outcome.padEnd(8)} ${result.name}${lacks}`);
  });

  console.log(
    check
      ? `\n${counts.missing} missing, ${counts.differs} differ, ${counts.same} the same. Nothing changed.`
      : `\n${counts.created} created, ${counts.updated} updated, ${counts.same} already the same, ${counts.differs} differ in Langfuse (left alone${update ? "" : "; --update pushes the code's copy"}).`,
  );
}

runScriptInOrganization(main)
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
