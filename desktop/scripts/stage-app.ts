// Copies the built Next.js server into desktop/app, the folder electron-builder
// ships as a resource: the standalone server with its static files and
// public/, plus db/ (the fresh-install schema). Run from the repository root
// after `bun run build` (desktop's `build:app` script does both).
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const out = join(root, "desktop", "app");
const standalone = join(root, ".next", "standalone");
if (!existsSync(join(standalone, "server.js"))) {
  console.error("No .next/standalone/server.js: run `bun run build` first.");
  process.exit(1);
}
rmSync(out, { recursive: true, force: true });
cpSync(standalone, join(out, "server"), { recursive: true, verbatimSymlinks: true });
cpSync(join(root, ".next", "static"), join(out, "server", ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(out, "server", "public"), { recursive: true });
cpSync(join(root, "db"), join(out, "db"), { recursive: true });
console.log(`Staged the app into ${out}`);
