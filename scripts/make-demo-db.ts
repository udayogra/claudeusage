/**
 * Generates a synthetic usage.db full of INVENTED data, so the dashboard can be
 * screenshotted for docs without exposing any real (personal or company) usage.
 *
 * Usage:
 *   CLAUDEUSAGE_DB=/tmp/claudeusage-demo.db npx tsx scripts/make-demo-db.ts
 *
 * Nothing here reflects real projects, files, tickets, or costs.
 */
process.env.CLAUDEUSAGE_DB ||= "/tmp/claudeusage-demo.db";

const { getDb } = await import("../src/db.js");
const db = getDb();

// deterministic-ish PRNG so re-runs look stable
let seed = 1337;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const NOW = Date.parse("2026-07-27T18:00:00Z");
const DAY = 86_400_000;

const PROJECTS = [
  { name: "acme-web", branches: ["main", "feature/checkout", "feature/dark-mode"] },
  { name: "acme-api", branches: ["main", "fix/auth-timeout"] },
  { name: "billing-service", branches: ["main", "feature/invoices"] },
  { name: "mobile-app", branches: ["main", "feature/push-notifs"] },
  { name: "data-pipeline", branches: ["main", "spike/backfill"] },
  { name: "docs-site", branches: ["main"] },
  { name: "infra-terraform", branches: ["main", "fix/vpc-peering"] },
];

const TITLES = [
  "Refactor auth middleware", "Add checkout flow", "Fix flaky integration tests",
  "Design the events pipeline", "Investigate memory leak", "Wire up dark mode",
  "Migrate to new ORM", "Add invoice PDF export", "Speed up cold start",
  "Harden rate limiter", "Add push notifications", "Backfill historical data",
  "Rewrite the router", "Add e2e test coverage", "Tune database indexes",
  "Ship the settings page", "Fix timezone bug", "Add OpenAPI docs",
  "Extract shared UI kit", "Reduce bundle size",
];

const MODELS = [
  { id: "claude-opus-4-1-20250805", weight: 0.55 },
  { id: "claude-sonnet-4-5-20250929", weight: 0.33 },
  { id: "claude-haiku-4-5-20251001", weight: 0.12 },
];
const pickModel = () => {
  const x = rnd();
  let acc = 0;
  for (const m of MODELS) { acc += m.weight; if (x <= acc) return m.id; }
  return MODELS[0].id;
};

const STOP = ["end_turn", "end_turn", "end_turn", "tool_use", "tool_use", "max_tokens"];
const BASH = ["git status", "git diff", "git log", "git commit -m x", "npm test", "npm run build",
  "npm install", "grep -rn foo", "ls -la", "cd src", "cat package.json", "docker build .",
  "npx tsc --noEmit", "python3 script.py", "find . -name '*.ts'", "gh pr create"];
const FILES = [
  "src/auth/middleware.ts", "src/auth/session.ts", "src/api/routes.ts", "src/api/handlers.ts",
  "src/components/Checkout.tsx", "src/components/Settings.tsx", "services/billing.py",
  "services/invoices.py", "pipeline/ingest.py", "pipeline/transform.py", "src/router.ts",
  "src/db/schema.sql", "tests/e2e/checkout.spec.ts", "infra/main.tf", "README.md", "src/theme.css"];

const insEvent = db.prepare(
  `INSERT OR IGNORE INTO events
   (uuid, session_id, project, cwd, git_branch, model, version, ts, ts_epoch,
    input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h, response_chars,
    entrypoint, stop_reason, request_id, is_sidechain)
   VALUES (@uuid,@session_id,@project,@cwd,@git_branch,@model,@version,@ts,@ts_epoch,
    @input_tokens,@output_tokens,@cache_read,@cache_write_5m,@cache_write_1h,@response_chars,
    @entrypoint,@stop_reason,@request_id,@is_sidechain)`
);
const insTool = db.prepare(
  `INSERT OR IGNORE INTO tool_calls (tool_use_id, session_id, project, ts_epoch, tool, target, is_error, entrypoint)
   VALUES (?,?,?,?,?,?,?,?)`
);
const insTitle = db.prepare(
  `INSERT OR REPLACE INTO session_titles (session_id, title, is_custom, ts_epoch) VALUES (?,?,?,?)`
);
const insComp = db.prepare(
  `INSERT OR IGNORE INTO compactions
   (uuid, session_id, project, git_branch, entrypoint, ts_epoch, trigger, pre_tokens, post_tokens, duration_ms, summary, file)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
);
const insPrompt = db.prepare(
  `INSERT OR IGNORE INTO prompts (id, session_id, project, ts_epoch, chars) VALUES (?,?,?,?,?)`
);

const iso = (ms: number) => new Date(ms).toISOString();
let uid = 0;
const nextId = (p: string) => `${p}-${(uid++).toString(36)}-${Math.floor(rnd() * 1e6).toString(36)}`;

const run = db.transaction(() => {
  let sessionN = 0;
  for (let d = 29; d >= 0; d--) {
    const dayStart = NOW - d * DAY;
    const sessionsToday = between(1, 4);
    for (let s = 0; s < sessionsToday; s++) {
      sessionN++;
      const sid = `sess-${sessionN.toString().padStart(4, "0")}`;
      const proj = pick(PROJECTS);
      const branch = pick(proj.branches);
      const model = pickModel();
      const entrypoint = rnd() < 0.4 ? "sdk-cli" : "cli"; // bot vs human
      const title = pick(TITLES);
      // start during working hours, weekdays weighted heavier
      const hour = between(8, 20);
      let startTs = dayStart - (dayStart % DAY) + hour * 3_600_000 + between(0, 3_500_000);
      const turns = between(4, 32);
      let ctx = between(8_000, 20_000); // context grows over the session
      insTitle.run(sid, title, rnd() < 0.15 ? 1 : 0, startTs);

      // a couple of prompts per session
      const promptCount = Math.max(1, Math.floor(turns / 6));
      for (let pi = 0; pi < promptCount; pi++) {
        insPrompt.run(nextId("p"), sid, proj.name, startTs + pi * 60_000, between(15, 480));
      }

      let ts = startTs;
      for (let t = 0; t < turns; t++) {
        ts += between(20_000, 180_000); // 20s–3m between turns
        ctx += between(1_500, 6_000);
        const isSub = rnd() < 0.18;
        const out = between(60, 1400);
        const ev = {
          uuid: nextId("u"),
          session_id: sid,
          project: proj.name,
          cwd: `/home/dev/${proj.name}`,
          git_branch: branch,
          model,
          version: "1.2.0",
          ts: iso(ts),
          ts_epoch: ts,
          input_tokens: between(20, 400),
          output_tokens: out,
          cache_read: ctx + between(0, 4000),
          cache_write_5m: rnd() < 0.5 ? between(500, 9000) : 0,
          cache_write_1h: rnd() < 0.15 ? between(2000, 14000) : 0,
          response_chars: out * between(3, 6),
          entrypoint,
          stop_reason: pick(STOP),
          request_id: nextId("req"),
          is_sidechain: isSub ? 1 : 0,
        };
        insEvent.run(ev);

        // tool calls for this turn
        const nTools = between(0, 4);
        for (let k = 0; k < nTools; k++) {
          const which = rnd();
          if (which < 0.5) {
            insTool.run(nextId("tc"), sid, proj.name, ts, "Bash", pick(BASH), rnd() < 0.05 ? 1 : 0, entrypoint);
          } else if (which < 0.8) {
            insTool.run(nextId("tc"), sid, proj.name, ts, "Read", pick(FILES), 0, entrypoint);
          } else {
            insTool.run(nextId("tc"), sid, proj.name, ts, "Edit", pick(FILES), rnd() < 0.04 ? 1 : 0, entrypoint);
          }
        }

        // occasional compaction when context gets large
        if (ctx > 70_000 && rnd() < 0.5) {
          const pre = between(150_000, 175_000);
          const post = between(12_000, 24_000);
          insComp.run(nextId("c"), sid, proj.name, branch, entrypoint, ts, "auto", pre, post,
            between(80_000, 150_000), "Summarized earlier conversation to free up context.", `/home/dev/${proj.name}/${sid}.jsonl`);
          ctx = post;
        }
      }
    }
  }
});
run();

const n = (db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
const tc = (db.prepare("SELECT COUNT(*) c FROM tool_calls").get() as { c: number }).c;
const cp = (db.prepare("SELECT COUNT(*) c FROM compactions").get() as { c: number }).c;
const pr = (db.prepare("SELECT COUNT(*) c FROM prompts").get() as { c: number }).c;
console.log(`demo db ready: ${n} events, ${tc} tool_calls, ${cp} compactions, ${pr} prompts -> ${process.env.CLAUDEUSAGE_DB}`);
