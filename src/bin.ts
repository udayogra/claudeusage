#!/usr/bin/env -S npx tsx
import { exec } from "node:child_process";
import { platform } from "node:os";
import { ingest, PROJECTS_DIR } from "./ingest.js";
import { buildServer } from "./server.js";

function openBrowser(url: string) {
  const cmd =
    platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${url}"`);
}

async function main() {
  const noOpen = process.argv.includes("--no-open");
  const port = Number(process.env.PORT || 4317);

  console.log(`Scanning ${PROJECTS_DIR} ...`);
  const r = await ingest();
  console.log(
    `Ingested ${r.newEvents} new events (${r.totalEvents} total) from ${r.filesScanned} files in ${r.elapsedMs}ms`
  );

  const app = await buildServer();
  await app.listen({ port, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${port}`;
  console.log(`\nDashboard running at ${url}`);
  console.log("Press Ctrl+C to stop.");
  if (!noOpen) openBrowser(url);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
