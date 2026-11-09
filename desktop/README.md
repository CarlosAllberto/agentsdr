# AgentSDR desktop

AgentSDR as one app on one computer: an embedded PostgreSQL, the Next.js
server and its scheduled jobs, and a window on it. Nothing runs in the cloud
except the services AgentSDR calls (Zernio, Unipile for LinkedIn, Google
Workspace, OpenRouter, …).

## How it starts

`src/main.ts`, in order:

1. **Secrets** (`src/secrets.ts`): `BETTER_AUTH_SECRET`,
   `INTEGRATION_CREDENTIALS_KEY`, the cron and worker secrets and the database
   password are generated on first run and kept in `<userData>/secrets.bin`,
   encrypted with the OS keychain (Electron `safeStorage`) where there is one.
   They are never regenerated: losing `INTEGRATION_CREDENTIALS_KEY` makes every
   saved integration unreadable.
2. **Database** (`src/database.ts`): PostgreSQL 18 from `embedded-postgres`,
   data in `<userData>/postgres`, listening on 127.0.0.1 only. First run
   creates the cluster and the `agentsdr` database and applies `db/schema.sql`
   then `db/seed.sql` in one transaction. A Postgres left running by an app
   that was killed is stopped first.
3. **Server**: the Next.js standalone build, run by Electron's own Node
   (`ELECTRON_RUN_AS_NODE`) on 127.0.0.1, with `NODE_ENV=production` so the
   in-process scheduler runs (campaigns, follow-ups, the Zernio poll every
   minute). `AUTH_EMAIL_VERIFICATION=off`: there is no mail service, so sign-up
   signs straight in. `src/parent-guard.ts` stops the server if the app dies.
   Where the installed folder is read-only (AppImage) or must stay unchanged
   (the macOS .app, whose signature covers it) the server runs from a copy in
   `<userData>/server-<version>`, because Next writes `.next/cache`.
4. **Window**: opens the app; closing it keeps AgentSDR in the tray so the
   jobs keep running. Quit (tray menu, Cmd+Q) stops the server and Postgres.

`<userData>` is `~/.config/agentsdr-desktop` (Linux),
`~/Library/Application Support/agentsdr-desktop` (macOS),
`%APPDATA%\agentsdr-desktop` (Windows). Logs are in `<userData>/logs`.

No webhook can reach a desktop app, so WhatsApp replies arrive by polling
Zernio (`src/lib/whatsapp/zernioPoll.ts`, job `whatsapp-zernio-poll`).

## Build

```sh
cd desktop
npm install
npm run build:app     # next build at the root, then stage .next/standalone, static, public and db/ into desktop/app
npm start             # compile src/ and run it
npm run dist:dir      # an unpacked app in release/ (quick check)
npm run dist          # the installer for this OS (dmg / nsis / AppImage)
```

Installers are built on the OS they target, so they come from GitHub Actions
(`.github/workflows/desktop.yml`): Actions → Desktop installers → Run
workflow, or push a tag `desktop-v<version>` to also get a draft release with
the files. It builds a dmg for Apple Silicon and one for Intel, a Windows
installer (per-user, no admin needed) and an AppImage.

They are not signed with a paid certificate yet. macOS gets an ad-hoc
signature: the first time, right-click the app → Open (or System Settings →
Privacy & Security → Open Anyway). If macOS says the app "is damaged", run
`xattr -cr /Applications/AgentSDR.app` once (it removes the download
quarantine). Builds before the ad-hoc signature fix need this. Windows SmartScreen: More info → Run
anyway. Signing needs an Apple Developer ID (plus notarization) and a Windows
code-signing certificate, passed to electron-builder as `CSC_LINK` /
`CSC_KEY_PASSWORD` and `APPLE_*` secrets.

Icons are `build/icon.png` (rendered from `src/app/icon.svg`) and
`build/tray.png`. `asar` is off because
`embedded-postgres` finds its binaries next to its own files.

PostgreSQL refuses to run as root, so test as a normal user.
