/**
 * Puts AgentSDR's prompts (src/lib/prompts/registry.ts) into Langfuse, labelled
 * "production" — the version the app reads.
 *
 *   bun --env-file=.env.local run scripts/seed-langfuse-prompts.ts            # create the ones Langfuse lacks
 *   bun --env-file=.env.local run scripts/seed-langfuse-prompts.ts --update   # also push the code's copy as a new
 *                                                                            # version where production differs
 *   bun --env-file=.env.local run scripts/seed-langfuse-prompts.ts --check    # list differences, change nothing
 *
 * Without --update a prompt already in Langfuse is left alone: someone may
 * have edited it there, and the code's copy is only the fallback. With it,
 * the code's text becomes the new production version (the old ones stay in
 * Langfuse's history). Run --update after changing a prompt in code on
 * purpose — then the code and Langfuse agree again.
 */
import { LangfuseClient } from "@langfuse/client";
import { PROMPTS, type PromptName } from "../src/lib/prompts/registry";
import { promptVariableNames } from "../src/lib/prompts/template";

const update = process.argv.includes("--update");
const check = process.argv.includes("--check");

if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
  console.error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are not set (pass --env-file=.env.local).");
  process.exit(1);
}

const langfuse = new LangfuseClient();
const counts = { created: 0, updated: 0, same: 0, differs: 0 };

for (const name of Object.keys(PROMPTS).sort() as PromptName[]) {
  const { template, description } = PROMPTS[name];
  let current: string | null = null;
  try {
    current = (await langfuse.prompt.get(name, { type: "text", label: "production", cacheTtlSeconds: 0 })).prompt;
  } catch {
    current = null; // not in Langfuse yet
  }
  if (current === template) {
    counts.same += 1;
    continue;
  }
  if (current !== null && !update) {
    counts.differs += 1;
    const missing = promptVariableNames(template).filter((variable) => !promptVariableNames(current!).includes(variable));
    console.log(`differs  ${name}${missing.length ? ` (Langfuse's version lacks: ${missing.join(", ")})` : ""}`);
    continue;
  }
  if (check) {
    console.log(`${current === null ? "missing " : "differs "} ${name}`);
    continue;
  }
  await langfuse.prompt.create({
    name,
    type: "text",
    prompt: template,
    labels: ["production"],
    tags: [name.split("/")[0]!],
    commitMessage: current === null ? description : `From code: ${description}`,
  });
  if (current === null) counts.created += 1;
  else counts.updated += 1;
  console.log(`${current === null ? "created" : "updated"}  ${name}`);
}

console.log(
  `\n${counts.created} created, ${counts.updated} updated, ${counts.same} already the same, ${counts.differs} differ in Langfuse (left alone${update ? "" : "; --update pushes the code's copy"}).`,
);
process.exit(0);
