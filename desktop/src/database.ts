import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

/**
 * The embedded PostgreSQL server: its data lives in the user's app-data
 * folder and it listens on 127.0.0.1 only. On the very first start the
 * cluster is created, then the `agentsdr` database, then db/schema.sql and
 * db/seed.sql are applied in one transaction (what scripts/db/setup.ts does
 * for the Docker image, with `pg` instead of Bun's client).
 */

const USER = "agentsdr";
const DATABASE = "agentsdr";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * A Postgres left running on this data folder by an app that was killed
 * (not quit) holds the folder's lock and its port. Ask it to stop (fast
 * shutdown) before starting ours; Windows has no SIGINT, so there it is
 * terminated and the next start recovers from the write-ahead log.
 */
export async function stopLeftoverDatabase(dataDir: string, log: (line: string) => void): Promise<void> {
  const pidFile = join(dataDir, "postmaster.pid");
  if (!existsSync(pidFile)) return;
  const pid = Number.parseInt(readFileSync(pidFile, "utf8").split("\n")[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid)) return;
  log(`stopping a database left running by an earlier session (pid ${pid})`);
  try {
    process.kill(pid, process.platform === "win32" ? undefined : "SIGINT");
  } catch {
    return;
  }
  for (let waited = 0; waited < 15_000 && alive(pid); waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  if (alive(pid)) process.kill(pid, "SIGKILL");
}

export type RunningDatabase = { url: string; stop: () => Promise<void> };

export async function startDatabase(opts: { dataDir: string; port: number; password: string; dbDir: string; log: (line: string) => void }): Promise<RunningDatabase> {
  const firstRun = !existsSync(join(opts.dataDir, "PG_VERSION"));
  const server = new EmbeddedPostgres({
    databaseDir: opts.dataDir,
    port: opts.port,
    user: USER,
    password: opts.password,
    authMethod: "scram-sha-256",
    persistent: true,
    createPostgresUser: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: ["-c", "listen_addresses=127.0.0.1"],
    onLog: (message) => opts.log(`[postgres] ${String(message).trimEnd()}`),
    onError: (error) => opts.log(`[postgres] ${error instanceof Error ? error.message : String(error).trimEnd()}`),
  });

  if (firstRun) await server.initialise();
  await server.start();

  const url = `postgres://${USER}:${encodeURIComponent(opts.password)}@127.0.0.1:${opts.port}/${DATABASE}`;
  try {
    if (firstRun) await server.createDatabase(DATABASE);
    await applySchemaIfEmpty(url, opts.dbDir, opts.log);
  } catch (error) {
    await server.stop().catch(() => {});
    throw error;
  }
  return { url, stop: () => server.stop() };
}

async function applySchemaIfEmpty(url: string, dbDir: string, log: (line: string) => void): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query(
      "select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') limit 1",
    );
    if (rows.length) return;
    log("[setup] empty database: creating the AgentSDR schema");
    const schema = await readFile(join(dbDir, "schema.sql"), "utf8");
    const seed = await readFile(join(dbDir, "seed.sql"), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(schema);
      // schema.sql empties search_path (pg_dump does); the seed expects public.
      await client.query("SET search_path TO public");
      await client.query(seed);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
    log("[setup] schema created");
  } finally {
    await client.end();
  }
}
