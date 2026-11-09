import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, appendFileSync, constants, cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from "electron";
import { startDatabase, stopLeftoverDatabase, type RunningDatabase } from "./database.js";
import { loadSecrets } from "./secrets.js";

/**
 * AgentSDR on this computer: an embedded PostgreSQL, the Next.js standalone
 * server (run by Electron's own Node, ELECTRON_RUN_AS_NODE) with its
 * in-process scheduler, and a window on it. Closing the window keeps the app
 * in the tray so campaigns, follow-ups and the WhatsApp poll keep running;
 * Quit stops the server and the database.
 */

const here = dirname(fileURLToPath(import.meta.url));
/** The staged server and db/ folder: inside the installed app, or desktop/app in development. */
const resources = app.isPackaged ? join(process.resourcesPath, "bundle") : join(here, "..", "app");

let database: RunningDatabase | null = null;
let server: ChildProcess | null = null;
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let appUrl = "";
let quitting = false;

function logFile(): string {
  const dir = join(app.getPath("userData"), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, "agentsdr.log");
}

function log(line: string): void {
  const stamped = `${new Date().toISOString()} ${line.trimEnd()}\n`;
  process.stdout.write(stamped);
  try {
    appendFileSync(logFile(), stamped);
  } catch {
    // Logging must never stop the app.
  }
}

/** A free TCP port on 127.0.0.1, preferring `preferred` so the address stays the same between runs. */
function freePort(preferred: number): Promise<number> {
  const attempt = (port: number) =>
    new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", () => {
        const address = probe.address();
        probe.close(() => resolve(typeof address === "object" && address ? address.port : port));
      });
    });
  return attempt(preferred).catch(() => attempt(0));
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`The server stopped (exit ${server.exitCode})`);
    try {
      const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      if (response.status < 500) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`The server did not answer within ${Math.round(timeoutMs / 1000)} s`);
}

/**
 * Next.js writes its caches (optimized images, fetch cache) under
 * .next/cache beside the server. Where the installed app is read-only (an
 * AppImage, a system-wide install) or must stay unchanged (a macOS .app,
 * whose signature covers its files) the server runs from a copy in the
 * app-data folder, made once per app version; copies of older versions are
 * removed.
 */
function serverDir(): string {
  const installed = join(resources, "server");
  if (!existsSync(join(installed, "server.js"))) throw new Error(`The app server is missing (${installed}). Run "npm run build:app" in desktop/ first.`);
  if (!(app.isPackaged && process.platform === "darwin")) {
    try {
      accessSync(join(installed, ".next"), constants.W_OK);
      return installed;
    } catch {
      // Read-only: use a copy.
    }
  }
  const userData = app.getPath("userData");
  const name = `server-${app.getVersion()}`;
  const copy = join(userData, name);
  if (!existsSync(join(copy, "server.js"))) {
    log(`[desktop] copying the server to ${copy}`);
    const partial = `${copy}.partial`;
    rmSync(partial, { recursive: true, force: true });
    cpSync(installed, partial, { recursive: true, verbatimSymlinks: true });
    rmSync(copy, { recursive: true, force: true });
    renameSync(partial, copy);
  }
  for (const entry of readdirSync(userData)) {
    if (entry.startsWith("server-") && entry !== name) rmSync(join(userData, entry), { recursive: true, force: true });
  }
  return copy;
}

function startServer(port: number, env: Record<string, string>): ChildProcess {
  const dir = serverDir();
  const guard = pathToFileURL(join(here, "parent-guard.js")).href;
  const child = spawn(process.execPath, ["--import", guard, join(dir, "server.js")], {
    cwd: dir,
    env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", PORT: String(port), HOSTNAME: "127.0.0.1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => log(`[server] ${chunk.toString()}`));
  child.stderr?.on("data", (chunk: Buffer) => log(`[server] ${chunk.toString()}`));
  child.on("exit", (code, signal) => {
    log(`[server] exited (code ${code}, signal ${signal})`);
    if (!quitting) {
      dialog.showErrorBox("AgentSDR stopped", `The AgentSDR server stopped unexpectedly. Details are in ${logFile()}.`);
      app.quit();
    }
  });
  return child;
}

function openWindow(): void {
  if (window) {
    window.show();
    window.focus();
    return;
  }
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: "AgentSDR",
    icon: join(here, "..", "build", "icon.png"),
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.once("ready-to-show", () => window?.show());
  // Links that leave the app (docs, booking pages, Zernio's dashboard) open in the browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(appUrl)) void shell.openExternal(url);
    return { action: url.startsWith(appUrl) ? "allow" : "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  window.on("close", (event) => {
    // Keep running in the tray: the scheduled jobs live in this process.
    if (!quitting && tray) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on("closed", () => {
    window = null;
  });
  void window.loadURL(appUrl);
}

function createTray(): void {
  const icon = join(here, "..", "build", "tray.png");
  try {
    tray = new Tray(existsSync(icon) ? nativeImage.createFromPath(icon) : nativeImage.createEmpty());
  } catch (error) {
    log(`[desktop] no tray: ${String(error)}`);
    tray = null;
    return;
  }
  tray.setToolTip("AgentSDR");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open AgentSDR", click: openWindow },
      { label: "Open logs folder", click: () => void shell.openPath(dirname(logFile())) },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
  tray.on("click", openWindow);
}

async function boot(): Promise<void> {
  const userData = app.getPath("userData");
  const secrets = loadSecrets(userData);

  const dataDir = join(userData, "postgres");
  await stopLeftoverDatabase(dataDir, (line) => log(`[postgres] ${line}`));
  const dbPort = await freePort(54329);
  database = await startDatabase({
    dataDir,
    port: dbPort,
    password: secrets.POSTGRES_PASSWORD,
    dbDir: join(resources, "db"),
    log: (line) => log(`[postgres] ${line}`),
  });

  const port = await freePort(47321);
  appUrl = `http://127.0.0.1:${port}`;
  const { POSTGRES_PASSWORD: _unused, ...appSecrets } = secrets;
  server = startServer(port, {
    ...appSecrets,
    NODE_ENV: "production",
    DATABASE_URL: database.url,
    DATABASE_SSL: "disable",
    BETTER_AUTH_URL: appUrl,
    NEXT_PUBLIC_APP_URL: appUrl,
    OPENROUTER_SITE_URL: appUrl,
    AUTH_EMAIL_VERIFICATION: "off",
    INTERNAL_SCHEDULER: "true",
    DB_POOL_MAX: "8",
  });
  await waitForHttp(`${appUrl}/sign-in`, 90_000);
  log(`[desktop] ready at ${appUrl}`);
  createTray();
  openWindow();
}

async function shutdown(): Promise<void> {
  if (server && server.exitCode === null) {
    const exited = new Promise((resolve) => server?.once("exit", resolve));
    server.kill("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 8_000))]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  await database?.stop().catch((error: unknown) => log(`[postgres] stop failed: ${String(error)}`));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", openWindow);
  app.on("activate", openWindow);
  app.on("window-all-closed", () => {
    // With no tray (some Linux desktops) closing the window quits.
    if (!tray) app.quit();
  });
  // Ctrl+C in a terminal or a session logout still stops Postgres cleanly.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    void shutdown().finally(() => app.exit(0));
  });

  void app.whenReady().then(() =>
    boot().catch((error: unknown) => {
      log(`[desktop] could not start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      dialog.showErrorBox("AgentSDR could not start", `${error instanceof Error ? error.message : String(error)}\n\nDetails are in ${logFile()}.`);
      quitting = true;
      void shutdown().finally(() => app.exit(1));
    }),
  );
}
