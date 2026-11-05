import "server-only";

import { LangfuseClient } from "@langfuse/client";
import type { LangfusePromptUpload, PlatformCredentials } from "@/lib/platform/catalog";
import { PROMPTS, type PromptName } from "@/lib/prompts/registry";
import { promptVariableNames } from "@/lib/prompts/template";

/**
 * Puts AgentSDR's prompts (src/lib/prompts/registry.ts) into an
 * organization's Langfuse project, labelled "production" — the version the
 * app reads. Runs when the Langfuse integration is saved (create only), and
 * from scripts/seed-langfuse-prompts.ts.
 *
 * A prompt already in the project is left alone unless the mode is "update":
 * someone may have edited it there, and the code's copy is only the
 * fallback. With "update" the code's text becomes the new production version
 * (the old ones stay in Langfuse's history).
 */

export type PromptSyncMode = "create" | "update" | "check";

export type PromptSyncOutcome =
  /** Not in the project: created ("create", "update") or only reported ("check"). */
  | "created"
  | "missing"
  /** In the project with other text: pushed as a new version ("update") or left alone. */
  | "updated"
  | "differs"
  | "same";

export type PromptSyncResult = {
  name: PromptName;
  outcome: PromptSyncOutcome;
  /** For "differs": variables the code's copy fills that the project's version does not use. */
  missingVariables?: string[];
};

const CONCURRENCY = 6;

export function langfuseClientFor(credentials: PlatformCredentials["langfuse"]): LangfuseClient {
  return new LangfuseClient({ baseUrl: credentials.baseUrl, publicKey: credentials.publicKey, secretKey: credentials.secretKey });
}

/** The production text of `name` in the project, or null when it has none. Other failures throw. */
async function productionText(client: LangfuseClient, name: PromptName): Promise<string | null> {
  try {
    const prompt = await client.api.prompts.get(name, { label: "production" });
    return typeof prompt.prompt === "string" ? prompt.prompt : JSON.stringify(prompt.prompt);
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}

async function syncOne(client: LangfuseClient, name: PromptName, mode: PromptSyncMode): Promise<PromptSyncResult> {
  const { template, description } = PROMPTS[name];
  const current = await productionText(client, name);
  if (current === template) return { name, outcome: "same" };
  if (current !== null && mode !== "update") {
    const used = promptVariableNames(current);
    const missingVariables = promptVariableNames(template).filter((variable) => !used.includes(variable));
    return { name, outcome: "differs", ...(missingVariables.length ? { missingVariables } : {}) };
  }
  if (mode === "check") return { name, outcome: "missing" };
  await client.prompt.create({
    name,
    type: "text",
    prompt: template,
    labels: ["production"],
    tags: [name.split("/")[0]!],
    commitMessage: current === null ? description : `From code: ${description}`,
  });
  return { name, outcome: current === null ? "created" : "updated" };
}

/** Every registry prompt against the project, a few at a time, in name order. Throws on the first failure. */
export async function syncLangfusePrompts(
  credentials: PlatformCredentials["langfuse"],
  mode: PromptSyncMode,
  onResult?: (result: PromptSyncResult) => void,
): Promise<PromptSyncResult[]> {
  const client = langfuseClientFor(credentials);
  const names = Object.keys(PROMPTS).sort() as PromptName[];
  const results: PromptSyncResult[] = new Array(names.length);
  let next = 0;
  async function worker() {
    while (next < names.length) {
      const index = next++;
      results[index] = await syncOne(client, names[index]!, mode);
      onResult?.(results[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
  return results;
}

/**
 * On save: create the prompts the project lacks. Never throws — a project
 * that cannot take the prompts still traces, and every prompt falls back to
 * the code's copy until it is there.
 */
export async function uploadMissingLangfusePrompts(credentials: PlatformCredentials["langfuse"]): Promise<LangfusePromptUpload> {
  const at = new Date().toISOString();
  const counts = { created: 0, existing: 0 };
  try {
    await syncLangfusePrompts(credentials, "create", (result) => {
      counts[result.outcome === "created" ? "created" : "existing"] += 1;
    });
    return { status: "uploaded", at, ...counts };
  } catch (error) {
    console.error("[langfuse] could not upload the prompts:", error);
    const status = (error as { statusCode?: number }).statusCode;
    return {
      status: "failed",
      at,
      ...counts,
      message:
        status === 401 || status === 403
          ? "Langfuse refused to store prompts with these keys."
          : `Langfuse did not take the prompts${status ? ` (HTTP ${status})` : ""}. The copies in AgentSDR are used until they are there.`,
    };
  }
}
