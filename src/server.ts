import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingest } from "./ingest.js";
import { ask, askSession } from "./ask.js";
import {
  summary,
  timeseries,
  groupBy,
  heatmap,
  topSessions,
  sessionDetail,
  textStats,
  timeBreakdown,
  botVsHuman,
  subagentSplit,
  compactions,
  compactionDetail,
  toolUsage,
  stopReasons,
  topCommands,
  hottestFiles,
  meta,
} from "./queries.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

function parseRange(q: Record<string, unknown>) {
  const from = q.from != null ? Number(q.from) : undefined;
  const to = q.to != null ? Number(q.to) : undefined;
  return {
    from: Number.isFinite(from) ? from : undefined,
    to: Number.isFinite(to) ? to : undefined,
  };
}

// Keep the DB fresh while the dashboard runs. Transcripts (especially bot
// sessions) grow continuously, but ingest() otherwise only fires at startup —
// so live sessions show stale $0.00 rows until a manual re-ingest. This polls
// on an interval; a guard skips a tick if the previous run is still going, so
// slow ingests never stack up.
function startAutoIngest(app: ReturnType<typeof Fastify>) {
  const ms = Math.max(5_000, Number(process.env.CLAUDEUSAGE_INGEST_INTERVAL_MS || 60_000));
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await ingest();
    } catch (err) {
      app.log.error({ err }, "auto-ingest failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, ms);
  timer.unref?.(); // don't keep the process alive just for the timer
  app.addHook("onClose", async () => clearInterval(timer));
}

export async function buildServer() {
  const app = Fastify({ logger: false });

  await app.register(fastifyStatic, { root: PUBLIC_DIR });

  app.get("/api/meta", async () => meta());

  app.get("/api/summary", async (req) => summary(parseRange(req.query as any)));

  app.get("/api/timeseries", async (req) => {
    const q = req.query as any;
    return timeseries(parseRange(q), (q.bucket as string) || "day");
  });

  app.get("/api/by", async (req) => {
    const q = req.query as any;
    const dim = (["model", "project", "session_id", "git_branch"] as const).includes(q.dim)
      ? q.dim
      : "model";
    return groupBy(parseRange(q), dim);
  });

  app.get("/api/heatmap", async (req) => heatmap(parseRange(req.query as any)));

  app.get("/api/sessions", async (req) => {
    const q = req.query as any;
    return topSessions(parseRange(q), q.limit != null ? Number(q.limit) : 20);
  });

  app.get("/api/session", async (req) => {
    const q = req.query as any;
    return sessionDetail(String(q.id ?? ""));
  });

  app.get("/api/textstats", async (req) => textStats(parseRange(req.query as any)));

  app.get("/api/timebreakdown", async (req) => timeBreakdown(parseRange(req.query as any)));

  app.get("/api/botvshuman", async (req) => botVsHuman(parseRange(req.query as any)));

  app.get("/api/subagents", async (req) => subagentSplit(parseRange(req.query as any)));

  app.get("/api/compactions", async (req) => {
    const q = req.query as any;
    return compactions(parseRange(q), q.limit != null ? Number(q.limit) : 20);
  });

  app.get("/api/compaction", async (req) => {
    const q = req.query as any;
    return compactionDetail(String(q.uuid ?? ""));
  });

  app.get("/api/tools", async (req) => toolUsage(parseRange(req.query as any)));

  app.get("/api/stopreasons", async (req) => stopReasons(parseRange(req.query as any)));

  app.get("/api/commands", async (req) => {
    const q = req.query as any;
    return topCommands(parseRange(q), q.limit ? Number(q.limit) : 20);
  });

  app.get("/api/files", async (req) => {
    const q = req.query as any;
    return hottestFiles(parseRange(q), q.limit ? Number(q.limit) : 25);
  });

  app.post("/api/ingest", async () => ingest());

  startAutoIngest(app);

  app.post("/api/ask", async (req) => {
    const body = (req.body ?? {}) as { question?: string };
    return ask(String(body.question ?? ""));
  });

  app.post("/api/ask-session", async (req) => {
    const body = (req.body ?? {}) as { id?: string; question?: string; resumeId?: string };
    return askSession(String(body.id ?? ""), String(body.question ?? ""), String(body.resumeId ?? ""));
  });

  return app;
}

// run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 4317);
  buildServer().then((app) => {
    app.listen({ port, host: "127.0.0.1" }).then(() => {
      console.log(`claudeusage dashboard: http://127.0.0.1:${port}`);
    });
  });
}
