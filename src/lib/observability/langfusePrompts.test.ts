import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PROMPTS, type PromptName } from "@/lib/prompts/registry";
import { syncLangfusePrompts, uploadMissingLangfusePrompts } from "./langfusePrompts";

const CREDENTIALS = { baseUrl: "https://langfuse.test", publicKey: "pk-lf-test", secretKey: "sk-lf-test" };
const NAMES = Object.keys(PROMPTS).sort() as PromptName[];

/** A Langfuse project in memory, answering the two prompt endpoints the sync uses. */
function fakeLangfuse(initial: Record<string, string>, options: { status?: number } = {}) {
  const prompts = new Map(Object.entries(initial));
  const created: { name: string; prompt: string; labels: string[] }[] = [];
  const authorizations = new Set<string>();
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    authorizations.add(new Headers(init?.headers).get("authorization") ?? "");
    if (options.status) return Response.json({ message: "nope" }, { status: options.status });
    const body = (name: string, prompt: string) => ({ name, version: 1, prompt, type: "text", config: {}, labels: ["production"], tags: [] });
    if ((init?.method ?? "GET") === "GET" && url.pathname.startsWith("/api/public/v2/prompts/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/public/v2/prompts/".length));
      const prompt = prompts.get(name);
      return prompt === undefined ? Response.json({ message: "Prompt not found" }, { status: 404 }) : Response.json(body(name, prompt));
    }
    if (init?.method === "POST" && url.pathname === "/api/public/v2/prompts") {
      const request = JSON.parse(String(init.body)) as { name: string; prompt: string; labels: string[] };
      prompts.set(request.name, request.prompt);
      created.push({ name: request.name, prompt: request.prompt, labels: request.labels });
      return Response.json(body(request.name, request.prompt), { status: 201 });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { fetchImpl, prompts, created, authorizations };
}

const originalFetch = globalThis.fetch;
let project: ReturnType<typeof fakeLangfuse>;

function install(fake: ReturnType<typeof fakeLangfuse>) {
  project = fake;
  globalThis.fetch = fake.fetchImpl as typeof fetch;
}

beforeEach(() => install(fakeLangfuse({})));
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("syncLangfusePrompts", () => {
  test("creates every missing prompt, labelled production, with the organization's keys", async () => {
    const [same, edited] = NAMES;
    install(fakeLangfuse({ [same!]: PROMPTS[same!].template, [edited!]: "edited in Langfuse" }));

    const results = await syncLangfusePrompts(CREDENTIALS, "create");

    expect(results.map((result) => result.name)).toEqual(NAMES);
    expect(results.find((result) => result.name === same)?.outcome).toBe("same");
    expect(results.find((result) => result.name === edited)?.outcome).toBe("differs");
    expect(project.prompts.get(edited!)).toBe("edited in Langfuse");
    expect(project.created.map((prompt) => prompt.name).sort()).toEqual(NAMES.slice(2));
    expect(project.created.every((prompt) => prompt.labels.includes("production") && prompt.prompt === PROMPTS[prompt.name as PromptName].template)).toBe(true);
    expect([...project.authorizations]).toEqual([`Basic ${Buffer.from("pk-lf-test:sk-lf-test").toString("base64")}`]);
  });

  test("check changes nothing", async () => {
    const results = await syncLangfusePrompts(CREDENTIALS, "check");
    expect(results.every((result) => result.outcome === "missing")).toBe(true);
    expect(project.created).toEqual([]);
  });

  test("update pushes the code's copy over an edited prompt", async () => {
    const [edited] = NAMES;
    install(fakeLangfuse({ [edited!]: "edited in Langfuse" }));
    const results = await syncLangfusePrompts(CREDENTIALS, "update");
    expect(results.find((result) => result.name === edited)?.outcome).toBe("updated");
    expect(project.prompts.get(edited!)).toBe(PROMPTS[edited!].template);
  });
});

describe("uploadMissingLangfusePrompts", () => {
  test("counts what it created and what was already there", async () => {
    const [same] = NAMES;
    install(fakeLangfuse({ [same!]: PROMPTS[same!].template }));
    const upload = await uploadMissingLangfusePrompts(CREDENTIALS);
    expect(upload).toMatchObject({ status: "uploaded", created: NAMES.length - 1, existing: 1 });
  });

  test("never throws: a refusal comes back as a failed upload", async () => {
    install(fakeLangfuse({}, { status: 401 }));
    const original = console.error;
    console.error = () => {};
    try {
      const upload = await uploadMissingLangfusePrompts(CREDENTIALS);
      expect(upload.status).toBe("failed");
      expect(upload.message).toContain("refused");
    } finally {
      console.error = original;
    }
  });
});
