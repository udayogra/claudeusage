import { spawn } from "node:child_process";
import {
  summary,
  timeseries,
  groupBy,
  topSessions,
  botVsHuman,
  subagentSplit,
  compactions,
  toolUsage,
  topCommands,
  hottestFiles,
  meta,
  sessionDiagnostics,
  type Range,
} from "./queries.js";

const DAY = 86_400_000;

/** Build a compact-but-broad snapshot of the dataset that Claude can reason over. */
function buildSnapshot() {
  const now = Date.now();
  const last7: Range = { from: now - 7 * DAY };
  const last30: Range = { from: now - 30 * DAY };
  const m = meta();
  return {
    dataset: {
      from: m.min_ts ? new Date(m.min_ts).toISOString() : null,
      to: m.max_ts ? new Date(m.max_ts).toISOString() : null,
      total_events: m.total_events,
      models: m.models,
      projects: m.projects,
    },
    totals_all_time: summary({}),
    totals_last_30_days: summary(last30),
    totals_last_7_days: summary(last7),
    daily_last_30_days: timeseries(last30, "day"),
    monthly_all_time: timeseries({}, "month"),
    by_project: groupBy({}, "project"),
    by_model: groupBy({}, "model"),
    top_sessions: topSessions({}, 10),
    bot_vs_human: botVsHuman({}),
    main_vs_subagent: subagentSplit({}),
    compactions: compactions({}, 10),
    tool_usage: toolUsage({}),
    top_commands: topCommands({}, 15),
    hottest_files: hottestFiles({}, 15),
  };
}

function buildPrompt(question: string, snapshot: unknown): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are the analytics assistant inside "claudeusage", a personal dashboard that tracks the user's Claude Code token usage and cost (parsed from local session transcripts).

Answer the user's question using ONLY the DATA snapshot below. Do not use any tools, do not read files, do not browse — everything you need is in the JSON. If the snapshot doesn't contain what's needed to answer, say so plainly.

Rules:
- Today is ${today}. All costs are US dollars from this app's local pricing table.
- Lead with the single number/fact that answers the question, then 1-3 supporting details.
- Format money as $X.XX; abbreviate large token counts (e.g. 1.4M, 320K).
- Be concise. Use short bullet lists only when comparing multiple items.
- Never invent numbers not present in the data.

DATA (JSON):
${JSON.stringify(snapshot)}

QUESTION:
${question}`;
}

export interface AskResult {
  answer: string;
  session_id?: string;
  cost_usd?: number;
  usage?: { input_tokens: number; output_tokens: number; cache_read: number };
  error?: string;
}

interface CliResult {
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/**
 * Invoke the local `claude` CLI in non-interactive print mode with JSON output.
 * Extra args let callers resume an existing conversation (`--resume <id>`) so
 * follow-up questions keep the prior chat context.
 */
function runClaude(prompt: string, extraArgs: string[] = []): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", ["-p", "--output-format", "json", ...extraArgs], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      const text = out.trim();
      if (text) {
        try {
          resolve(JSON.parse(text) as CliResult);
          return;
        } catch {
          /* fall through */
        }
      }
      reject(new Error(err.trim() || `claude exited with code ${code} and no JSON output`));
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Answer a natural-language question grounded in the dashboard's own data. */
export async function ask(question: string): Promise<AskResult> {
  const q = (question || "").trim();
  if (!q) return { answer: "", error: "Empty question." };

  let cli: CliResult;
  try {
    cli = await runClaude(buildPrompt(q, buildSnapshot()));
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/ENOENT/.test(msg)) {
      return { answer: "", error: "The `claude` CLI was not found on PATH. Install Claude Code and ensure `claude` is runnable." };
    }
    return { answer: "", error: `Failed to run claude CLI: ${msg}` };
  }

  if (cli.is_error) {
    const detail = cli.result || "unknown error";
    const hint = /logged in|\/login/i.test(detail)
      ? " — run `claude` once in a terminal and sign in, then restart the dashboard."
      : "";
    return { answer: "", error: `claude CLI error: ${detail}${hint}` };
  }

  return {
    answer: (cli.result ?? "").trim(),
    cost_usd: cli.total_cost_usd,
    usage: {
      input_tokens: cli.usage?.input_tokens ?? 0,
      output_tokens: cli.usage?.output_tokens ?? 0,
      cache_read: cli.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

function cliToResult(cli: CliResult): AskResult {
  return {
    answer: (cli.result ?? "").trim(),
    session_id: cli.session_id,
    cost_usd: cli.total_cost_usd,
    usage: {
      input_tokens: cli.usage?.input_tokens ?? 0,
      output_tokens: cli.usage?.output_tokens ?? 0,
      cache_read: cli.usage?.cache_read_input_tokens ?? 0,
    },
  };
}

function buildSessionPrompt(question: string, diag: unknown): string {
  return `You are a cost-optimization analyst inside "claudeusage", a dashboard that tracks Claude Code usage. You are diagnosing ONE session.

How Claude Code billing works (use this to reason about the numbers):
- Every turn re-sends the whole conversation + files as context. Most tokens are CONTEXT, not new generation.
- Cache READ is cheap (~$0.50/M for Opus); cache WRITE is ~12.5x more expensive (~$6.25/M). Reads should dominate.
- The prompt cache has a ~5-minute TTL. If turns are spaced further apart than that, the cache expires and the ENTIRE context must be rewritten (paying the expensive write price again). So idle gaps > 5 min and a high write:read ratio both signal wasted spend.
- Output tokens are the priciest per-token (~$25/M) but usually a tiny share of total tokens.
- Large, growing context (avg_context_tokens climbing) means every later turn re-pays for a bigger conversation. /compact or splitting the session reduces this.

Analyze the DATA below and answer the user's question. Be specific and quantitative — cite the actual numbers (dollars, %, token counts) from the data. Structure your answer as:
1. What drove the cost (the dominant factor, with numbers).
2. What went wrong / was inefficient (idle gaps, cache churn, context bloat, redundant tool loops — whichever the data shows).
3. Concrete, actionable ways it could have been cheaper.
Do not invent numbers not present in the data. Be concise.

DATA (JSON):
${JSON.stringify(diag)}

QUESTION:
${question}`;
}

/**
 * Diagnose a single session with Claude as a running chat.
 *
 * First turn (no `resumeId`): seeds a fresh claude conversation with the full
 * diagnostic snapshot + the question, and returns the claude session id.
 * Follow-up turns (`resumeId` set): resume that same claude conversation with
 * just the new question, so prior context (snapshot + earlier answers) carries
 * over and the user can build on previous replies.
 */
export async function askSession(
  sessionId: string,
  question: string,
  resumeId?: string
): Promise<AskResult> {
  const sid = (sessionId || "").trim();
  const rid = (resumeId || "").trim();
  const typed = (question || "").trim();
  // A default question is only reasonable on the first turn.
  const q =
    typed ||
    (rid
      ? ""
      : "Diagnose this session: what drove the cost, what went wrong or was inefficient, and how could it have been run more cheaply?");
  if (rid && !q) return { answer: "", error: "Empty question." };

  let cli: CliResult;
  try {
    if (rid) {
      // continue the existing conversation — no need to resend the snapshot
      cli = await runClaude(q, ["--resume", rid]);
    } else {
      if (!sid) return { answer: "", error: "Missing session id." };
      const diag = sessionDiagnostics(sid);
      if (diag && (diag as any).error) return { answer: "", error: "Session not found." };
      cli = await runClaude(buildSessionPrompt(q, diag));
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (/ENOENT/.test(msg)) {
      return { answer: "", error: "The `claude` CLI was not found on PATH." };
    }
    return { answer: "", error: `Failed to run claude CLI: ${msg}` };
  }
  if (cli.is_error) {
    const detail = cli.result || "unknown error";
    const hint = /logged in|\/login/i.test(detail)
      ? " — run `claude` once in a terminal and sign in, then restart the dashboard."
      : "";
    return { answer: "", error: `claude CLI error: ${detail}${hint}` };
  }
  return cliToResult(cli);
}
