/**
 * Loaded into the Next.js server with --import. The app keeps the server's
 * stdin open as a pipe; when the app dies without quitting (killed, crashed)
 * the pipe closes and the server stops, instead of running its scheduled jobs
 * against a database that is gone.
 */
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
export {};
