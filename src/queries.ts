import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { getDb, type CompactionRow, type EventRow } from "./db.js";
import { costOf, uncachedInputCostOf, getPricing, rateFor, type TokenBreakdown } from "./pricing.js";
import { PROJECTS_DIR } from "./ingest.js";

export interface Range {
  from?: number; // epoch ms
  to?: number;
}

function whereRange(r: Range, ...extra: string[]): { sql: string; params: number[] } {
  const clauses: string[] = [];
  const params: number[] = [];
  if (r.from != null) {
    clauses.push("ts_epoch >= ?");
    params.push(r.from);
  }
  if (r.to != null) {
    clauses.push("ts_epoch <= ?");
    params.push(r.to);
  }
  clauses.push(...extra);
  return { sql: clauses.length ? "WHERE " + clauses.join(" AND ") : "", params };
}

interface TokenAgg extends TokenBreakdown {
  model: string;
  messages: number;
}

function tokenCols(): string {
  return `SUM(input_tokens) input_tokens,
          SUM(output_tokens) output_tokens,
          SUM(cache_read) cache_read,
          SUM(cache_write_5m) cache_write_5m,
          SUM(cache_write_1h) cache_write_1h,
          COUNT(*) messages`;
}

function addCost(rows: TokenAgg[]) {
  return rows.map((r) => ({
    ...r,
    cost: costOf(r.model, r),
    uncached_cost: uncachedInputCostOf(r.model, r),
  }));
}

/** Collapse per-model rows (each priced correctly) into a single total. */
function totalize(rows: TokenAgg[]) {
  const priced = addCost(rows);
  const t = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
    total_tokens: 0,
    messages: 0,
    cost: 0,
    cache_savings: 0,
  };
  for (const r of priced) {
    t.input_tokens += r.input_tokens;
    t.output_tokens += r.output_tokens;
    t.cache_read += r.cache_read;
    t.cache_write_5m += r.cache_write_5m;
    t.cache_write_1h += r.cache_write_1h;
    t.messages += r.messages;
    t.cost += r.cost;
    // savings = what cache reads would have cost at full input price minus what they did cost
    t.cache_savings += r.uncached_cost - r.cost;
  }
  t.total_tokens =
    t.input_tokens + t.output_tokens + t.cache_read + t.cache_write_5m + t.cache_write_1h;
  return t;
}

export function summary(r: Range) {
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(`SELECT model, ${tokenCols()} FROM events ${w.sql} GROUP BY model`)
    .all(...w.params) as TokenAgg[];
  const sessions = db
    .prepare(`SELECT COUNT(DISTINCT session_id) c FROM events ${w.sql}`)
    .get(...w.params) as { c: number };
  const projects = db
    .prepare(`SELECT COUNT(DISTINCT project) c FROM events ${w.sql}`)
    .get(...w.params) as { c: number };
  const days = db
    .prepare(
      `SELECT COUNT(DISTINCT substr(ts,1,10)) c FROM events ${w.sql}`
    )
    .get(...w.params) as { c: number };

  const totals = totalize(rows);
  const activeDays = Math.max(days.c, 1);
  return {
    ...totals,
    sessions: sessions.c,
    projects: projects.c,
    active_days: days.c,
    avg_cost_per_day: totals.cost / activeDays,
    projected_month: (totals.cost / activeDays) * 30,
    by_model: addCost(rows).sort((a, b) => b.cost - a.cost),
  };
}

const BUCKET_SQL: Record<string, string> = {
  hour: "substr(ts,1,13) || ':00'",
  day: "substr(ts,1,10)",
  week: "strftime('%Y-W%W', ts)",
  month: "substr(ts,1,7)",
};

export function timeseries(r: Range, bucket: string) {
  const db = getDb();
  const w = whereRange(r);
  const bexpr = BUCKET_SQL[bucket] ?? BUCKET_SQL.day;
  const rows = db
    .prepare(
      `SELECT ${bexpr} bucket, model, ${tokenCols()} FROM events ${w.sql} GROUP BY bucket, model ORDER BY bucket`
    )
    .all(...w.params) as (TokenAgg & { bucket: string })[];

  // fold per-model rows into one entry per bucket with cost applied per model
  const map = new Map<string, ReturnType<typeof totalize>>();
  const grouped = new Map<string, TokenAgg[]>();
  for (const row of rows) {
    if (!grouped.has(row.bucket)) grouped.set(row.bucket, []);
    grouped.get(row.bucket)!.push(row);
  }
  for (const [b, rs] of grouped) map.set(b, totalize(rs));
  return [...map.entries()].map(([bucket, t]) => ({ bucket, ...t }));
}

export function groupBy(r: Range, dim: "model" | "project" | "session_id" | "git_branch") {
  const db = getDb();
  const w = whereRange(r);
  const col = dim === "session_id" ? "session_id" : dim;
  // fetch per-(dim, model) so cost is priced per model, then fold up to dim
  const rows = db
    .prepare(
      `SELECT ${col} k, model, ${tokenCols()} FROM events ${w.sql} GROUP BY k, model`
    )
    .all(...w.params) as (TokenAgg & { k: string })[];
  const grouped = new Map<string, TokenAgg[]>();
  for (const row of rows) {
    if (!grouped.has(row.k)) grouped.set(row.k, []);
    grouped.get(row.k)!.push(row);
  }
  const out = [...grouped.entries()].map(([key, rs]) => ({ key, ...totalize(rs) }));
  return out.sort((a, b) => b.cost - a.cost);
}

/** day-of-week (0=Sun) x hour-of-day activity, valued by cost. */
export function heatmap(r: Range) {
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(
      `SELECT CAST(strftime('%w', ts) AS INTEGER) dow,
              CAST(strftime('%H', ts) AS INTEGER) hour,
              model, ${tokenCols()}
       FROM events ${w.sql} GROUP BY dow, hour, model`
    )
    .all(...w.params) as (TokenAgg & { dow: number; hour: number })[];
  const cells = new Map<string, { dow: number; hour: number; cost: number; messages: number }>();
  for (const row of rows) {
    const key = `${row.dow}-${row.hour}`;
    if (!cells.has(key)) cells.set(key, { dow: row.dow, hour: row.hour, cost: 0, messages: 0 });
    const c = cells.get(key)!;
    c.cost += costOf(row.model, row);
    c.messages += row.messages;
  }
  return [...cells.values()];
}

export function topSessions(r: Range, limit = 20) {
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(
      `SELECT session_id, model,
              MIN(ts) started, MAX(ts) ended,
              MAX(project) project, MAX(git_branch) git_branch,
              ${tokenCols()}
       FROM events ${w.sql} GROUP BY session_id, model`
    )
    .all(...w.params) as (TokenAgg & {
    session_id: string;
    started: string;
    ended: string;
    project: string;
    git_branch: string;
  })[];
  const bySession = new Map<string, any>();
  for (const row of rows) {
    if (!bySession.has(row.session_id)) {
      bySession.set(row.session_id, {
        session_id: row.session_id,
        project: row.project,
        git_branch: row.git_branch,
        started: row.started,
        ended: row.ended,
        rows: [] as TokenAgg[],
      });
    }
    const s = bySession.get(row.session_id);
    s.rows.push(row);
    if (row.started < s.started) s.started = row.started;
    if (row.ended > s.ended) s.ended = row.ended;
  }
  const out = [...bySession.values()].map((s) => {
    const t = totalize(s.rows);
    return {
      session_id: s.session_id,
      project: s.project,
      git_branch: s.git_branch,
      started: s.started,
      ended: s.ended,
      cost: t.cost,
      total_tokens: t.total_tokens,
      messages: t.messages,
      title: "" as string,
    };
  });
  const sorted = out.sort((a, b) => b.cost - a.cost);
  const ranked = limit > 0 ? sorted.slice(0, limit) : sorted;
  // attach human-readable titles
  const getTitle = db.prepare<[string], { title: string }>(
    "SELECT title FROM session_titles WHERE session_id = ?"
  );
  for (const s of ranked) s.title = getTitle.get(s.session_id)?.title ?? "";
  return ranked;
}

/** Locate a session's transcript file (`<sessionId>.jsonl`) under the projects dir. */
function findSessionFile(sessionId: string): string | null {
  const target = sessionId + ".jsonl";
  const stack = [PROJECTS_DIR];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === target) return full;
    }
  }
  return null;
}

/**
 * Locate the subagent transcripts spawned by a session. Claude Code writes them
 * to `<dir>/<sessionId>/subagents/agent-*.jsonl` next to the main
 * `<dir>/<sessionId>.jsonl` transcript. Each subagent turn is billed
 * separately, so the conversation replay must include them to match the totals
 * the diagnosis reasons over.
 */
function findSubagentFiles(mainFile: string): { file: string; agent: string }[] {
  const sessionId = basename(mainFile).replace(/\.jsonl$/, "");
  const subDir = join(dirname(mainFile), sessionId, "subagents");
  let entries;
  try {
    entries = readdirSync(subDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /^agent-.*\.jsonl$/.test(e.name))
    .map((e) => {
      const file = join(subDir, e.name);
      // The sibling `<agent-id>.meta.json` names the subagent (agentType).
      let agent = "";
      try {
        const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, ".meta.json"), "utf8"));
        agent = String(meta.agentType || meta.description || "");
      } catch {
        /* no meta — leave unnamed */
      }
      return { file, agent };
    });
}

/**
 * Preview of a `user`-role message — which in the transcript is EITHER a real
 * human prompt (text) OR a tool result the CLI fed back during a tool loop.
 * Tool results are prefixed so they're distinguishable from human input.
 */
function userInputPreview(content: unknown): { text: string; kind: "prompt" | "tool_result" | "empty" } {
  if (typeof content === "string") return { text: content, kind: "prompt" };
  if (!Array.isArray(content)) return { text: "", kind: "empty" };
  const texts: string[] = [];
  let sawToolResult = false;
  let sawText = false;
  for (const b of content as any[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") {
      texts.push(String(b.text ?? ""));
      sawText = true;
    } else if (b.type === "tool_result") {
      sawToolResult = true;
      const inner = b.content;
      let body = "";
      if (typeof inner === "string") body = inner;
      else if (Array.isArray(inner))
        body = inner
          .filter((x: any) => x && x.type === "text")
          .map((x: any) => String(x.text ?? ""))
          .join("\n");
      else if (Array.isArray(content) && content.some((x: any) => x?.type === "image")) body = "[image]";
      texts.push((b.is_error ? "⚠ tool error: " : "↩ tool result: ") + body);
    } else if (b.type === "image") {
      texts.push("🖼 image");
    }
  }
  const text = texts.join("\n");
  if (sawText && !sawToolResult) return { text, kind: "prompt" };
  if (sawToolResult) return { text, kind: "tool_result" };
  return { text, kind: text ? "prompt" : "empty" };
}

/**
 * Read a session transcript and pair each assistant event (by uuid) with the
 * text it produced and the message that immediately preceded it — either the
 * human's prompt or the CLI's tool-result reply during a tool loop.
 */
function sessionTurns(
  file: string
): Map<string, { asked: string; asked_kind: string; response: string; kind: string }> {
  const map = new Map<string, { asked: string; asked_kind: string; response: string; kind: string }>();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return map;
  }
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  let prevInput = "";
  let prevKind = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let d: any;
    try {
      d = JSON.parse(t);
    } catch {
      continue;
    }
    if (d.type === "user" && !d.isCompactSummary) {
      const p = userInputPreview(d.message?.content);
      if (p.kind !== "empty") {
        prevInput = clean(p.text);
        prevKind = p.kind;
      }
    } else if (d.type === "assistant" && d.uuid) {
      const p = previewOf(d.message?.content);
      map.set(d.uuid, { asked: prevInput, asked_kind: prevKind, response: clean(p.text), kind: p.kind });
    }
  }
  return map;
}

interface TimelineTurn {
  n: number;
  ts: string;
  ts_epoch: number;
  sent: string;
  sent_kind: "prompt" | "tool_result" | "continuation";
  thinking: boolean;
  text: string;
  tools: string[];
  model: string;
  output_tokens: number;
  input_tokens: number;
  cache_read: number;
  cache_write: number;
  cost: number;
  is_sidechain: boolean;
  agent: string;
}

/**
 * A conversation replay of the session: one turn per API round-trip
 * (grouped by request_id / message id). Each turn pairs the message that was
 * SENT that turn — the human prompt or the tool result(s) fed back during a
 * tool loop — with what the model RESPONDED (thinking, text, tool calls).
 *
 * This collapses the multiple content-block lines a single assistant message
 * can be split across (thinking / text / tool_use each on their own line) into
 * one row, so the same prompt no longer appears repeated across fragments.
 * Token/cost figures are taken once per request (never summed across the
 * duplicated per-block usage).
 */
function sessionTimeline(file: string, rows: EventRow[], maxTurns = 2000) {
  // Look up token usage by the uuid of the exact transcript line. Usage is
  // duplicated across every content-block line of one message, so we read it
  // once (from the line that opens the turn) and never sum siblings. `rows`
  // already contains BOTH main-thread and subagent (sidechain) events for the
  // session, so subagent turns get priced the same way.
  const evByUuid = new Map<string, EventRow>();
  for (const r of rows) evByUuid.set(r.uuid, r);

  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const turns: TimelineTurn[] = [];

  // Parse one transcript file, folding its content-block lines into turns. Each
  // file keeps its own request-grouping + pending-input state so a subagent's
  // request ids never collide with the main thread's.
  const ingestFile = (raw: string, sidechain: boolean, agent = "") => {
    const byReq = new Map<string, TimelineTurn>();
    let pendingSent = "";
    let pendingKind: "prompt" | "tool_result" | "" = "";
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let d: any;
      try {
        d = JSON.parse(t);
      } catch {
        continue;
      }
      if (d.type === "user" && !d.isCompactSummary) {
        const p = userInputPreview(d.message?.content);
        if (p.kind !== "empty") {
          pendingSent = clean(p.text);
          pendingKind = p.kind;
        }
      } else if (d.type === "assistant" && d.uuid) {
        const req: string = d.requestId || d.message?.id || d.uuid;
        let turn = byReq.get(req);
        if (!turn) {
          const ev = evByUuid.get(d.uuid);
          turn = {
            n: 0, // assigned after chronological sort below
            ts: d.timestamp || ev?.ts || "",
            ts_epoch: ev?.ts_epoch || Date.parse(d.timestamp) || 0,
            sent: pendingSent,
            sent_kind: pendingKind || "continuation",
            thinking: false,
            text: "",
            tools: [],
            model: ev?.model || d.message?.model || "",
            output_tokens: ev?.output_tokens ?? 0,
            input_tokens: ev?.input_tokens ?? 0,
            cache_read: ev?.cache_read ?? 0,
            cache_write: ev ? ev.cache_write_5m + ev.cache_write_1h : 0,
            cost: ev ? costOf(ev.model, ev) : 0,
            is_sidechain: sidechain || !!(ev?.is_sidechain || d.isSidechain),
            agent,
          };
          byReq.set(req, turn);
          turns.push(turn);
          pendingSent = "";
          pendingKind = "";
        }
        const c = d.message?.content;
        if (Array.isArray(c)) {
          for (const b of c as any[]) {
            if (!b || typeof b !== "object") continue;
            if (b.type === "thinking") turn.thinking = true;
            else if (b.type === "text")
              turn.text = turn.text ? turn.text + " " + clean(b.text || "") : clean(b.text || "");
            else if (b.type === "tool_use" && b.name && !turn.tools.includes(b.name))
              turn.tools.push(b.name);
          }
        } else if (typeof c === "string") {
          turn.text = turn.text ? turn.text + " " + clean(c) : clean(c);
        }
      }
    }
  };

  try {
    ingestFile(readFileSync(file, "utf8"), false);
  } catch {
    return { turns: [] as TimelineTurn[], total: 0, truncated: false };
  }
  // Fold in every subagent transcript spawned by this session so the replay
  // covers all billed calls (main thread + subagents), matching the diagnosis.
  for (const sub of findSubagentFiles(file)) {
    try {
      ingestFile(readFileSync(sub.file, "utf8"), true, sub.agent);
    } catch {
      /* skip unreadable subagent file */
    }
  }

  // Order all turns (main + subagents) chronologically, then number them.
  turns.sort((a, b) => a.ts_epoch - b.ts_epoch);
  turns.forEach((t, i) => (t.n = i + 1));

  const truncated = turns.length > maxTurns;
  const kept = truncated ? turns.slice(0, maxTurns) : turns;
  return {
    turns: kept.map((t) => ({ ...t, sent: t.sent.slice(0, 400), text: t.text.slice(0, 400) })),
    total: turns.length,
    truncated,
  };
}

/** Cost broken down by token type (what actually drove the bill). */
function costComposition(rows: EventRow[]) {
  const c = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  // Token sums (not dollars) — the write:read ratio must compare token counts,
  // otherwise the 12.5–20x per-token price gap inflates it into a meaningless number.
  let readTokens = 0;
  let writeTokens = 0;
  for (const r of rows) {
    const rate = rateFor(r.model);
    c.input += (r.input_tokens * rate.input) / 1e6;
    c.output += (r.output_tokens * rate.output) / 1e6;
    c.cache_read += (r.cache_read * rate.cache_read) / 1e6;
    c.cache_write += (r.cache_write_5m * rate.cache_write_5m + r.cache_write_1h * rate.cache_write_1h) / 1e6;
    readTokens += r.cache_read;
    writeTokens += r.cache_write_5m + r.cache_write_1h;
  }
  const total = c.input + c.output + c.cache_read + c.cache_write || 1;
  return {
    input: c.input,
    output: c.output,
    cache_read: c.cache_read,
    cache_write: c.cache_write,
    total,
    shares: {
      input: c.input / total,
      output: c.output / total,
      cache_read: c.cache_read / total,
      cache_write: c.cache_write / total,
    },
    // Compare TOKENS written-to-cache vs read-from-cache. Healthy reuse keeps this
    // well below 1 (you read back far more than you write). A ratio > 1 means you
    // wrote more cache than you reused — genuine churn (cache expiring before reuse).
    write_read_ratio: readTokens > 0 ? writeTokens / readTokens : writeTokens > 0 ? Infinity : 0,
  };
}

const IDLE_MS = 5 * 60 * 1000; // prompt-cache 5-minute TTL

/**
 * Drill-down for a single session: every API call (assistant turn with usage)
 * in time order, each priced individually, with the prompt/response text paired
 * from the transcript, plus per-model totals and a cost-composition breakdown.
 */
export function sessionDetail(sessionId: string, maxCalls = 2000) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT uuid, ts, ts_epoch, model, project, git_branch, input_tokens, output_tokens, cache_read,
              cache_write_5m, cache_write_1h, response_chars, stop_reason, is_sidechain, request_id
       FROM events WHERE session_id = ? ORDER BY ts_epoch ASC`
    )
    .all(sessionId) as EventRow[];
  if (!rows.length) return { error: "not found" };

  // Distinct API requests. Token/cost totals sum every logged row (mirroring
  // /usage, which counts Claude Code's duplicate log lines), but the "N calls"
  // count reflects distinct requests so it stays consistent with the replay.
  const distinctCalls = new Set(rows.map((r) => r.request_id || r.uuid)).size;

  // per-model totals (each model priced with its own rates), then folded up
  const byModelMap = new Map<string, TokenAgg[]>();
  for (const r of rows) {
    const agg: TokenAgg = {
      model: r.model,
      messages: 1,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read: r.cache_read,
      cache_write_5m: r.cache_write_5m,
      cache_write_1h: r.cache_write_1h,
    };
    if (!byModelMap.has(r.model)) byModelMap.set(r.model, []);
    byModelMap.get(r.model)!.push(agg);
  }
  const totals = totalize(rows.map((r) => ({ ...r, messages: 1 } as TokenAgg)));
  const by_model = [...byModelMap.entries()]
    .map(([, aggs]) => {
      const t = totalize(aggs);
      return { model: aggs[0].model, ...t };
    })
    .sort((a, b) => b.cost - a.cost);

  const composition = costComposition(rows);

  // idle gaps > cache TTL: each one likely forced a full cache rewrite
  let idleGaps = 0;
  let idleMs = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].ts_epoch - rows[i - 1].ts_epoch;
    if (gap > IDLE_MS) {
      idleGaps++;
      idleMs += gap;
    }
  }

  // pair prompt/response text from the transcript
  const file = findSessionFile(sessionId);
  const turns = file ? sessionTurns(file) : new Map();

  const truncated = rows.length > maxCalls;
  const kept = truncated ? rows.slice(0, maxCalls) : rows;
  const calls = kept.map((r) => {
    const t = turns.get(r.uuid);
    return {
      ts: r.ts,
      ts_epoch: r.ts_epoch,
      model: r.model,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cache_read: r.cache_read,
      cache_write_5m: r.cache_write_5m,
      cache_write_1h: r.cache_write_1h,
      total_tokens:
        r.input_tokens + r.output_tokens + r.cache_read + r.cache_write_5m + r.cache_write_1h,
      response_chars: r.response_chars,
      stop_reason: r.stop_reason,
      is_sidechain: r.is_sidechain,
      cost: costOf(r.model, r),
      asked: t?.asked ? t.asked.slice(0, 300) : "",
      asked_kind: t?.asked_kind ?? "",
      response: t?.response ? t.response.slice(0, 300) : "",
      response_kind: t?.kind ?? "",
    };
  });

  const title =
    db
      .prepare<[string], { title: string }>("SELECT title FROM session_titles WHERE session_id = ?")
      .get(sessionId)?.title ?? "";
  const head = rows[0];

  // conversation replay grouped by API round-trip (one turn = one request)
  const tl = file ? sessionTimeline(file, rows) : { turns: [], total: 0, truncated: false };

  return {
    session_id: sessionId,
    title,
    project: head.project,
    git_branch: head.git_branch,
    started: rows[0].ts,
    ended: rows[rows.length - 1].ts,
    duration_ms: rows[rows.length - 1].ts_epoch - rows[0].ts_epoch,
    totals,
    by_model,
    composition,
    idle_gaps: idleGaps,
    idle_ms: idleMs,
    avg_context_tokens: Math.round(totals.cache_read / rows.length),
    transcript_available: !!file,
    calls,
    call_count: distinctCalls,
    calls_shown: calls.length,
    truncated,
    timeline: tl.turns,
    turn_count: tl.total,
    timeline_truncated: tl.truncated,
  };
}

/**
 * Compact, LLM-friendly diagnostic snapshot of a session: cost composition,
 * context-growth curve, idle gaps, the costliest calls (with their text), and
 * tool usage. Small enough to hand to a model for a "what went wrong" analysis.
 */
export function sessionDiagnostics(sessionId: string) {
  const d = sessionDetail(sessionId, 100000);
  if ("error" in d) return d;

  // bucket the calls into ~24 segments to show how context grew over the session
  const N = Math.min(24, d.calls.length);
  const growth: { seg: number; avg_context_tokens: number; cost: number; calls: number }[] = [];
  if (N > 0) {
    const per = Math.ceil(d.calls.length / N);
    for (let i = 0; i < d.calls.length; i += per) {
      const slice = d.calls.slice(i, i + per);
      const ctx = slice.reduce((a, c) => a + c.cache_read, 0) / slice.length;
      const cost = slice.reduce((a, c) => a + c.cost, 0);
      growth.push({
        seg: growth.length + 1,
        avg_context_tokens: Math.round(ctx),
        cost: +cost.toFixed(2),
        calls: slice.length,
      });
    }
  }

  const topCalls = [...d.calls]
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10)
    .map((c) => ({
      time: c.ts,
      cost: +c.cost.toFixed(2),
      output_tokens: c.output_tokens,
      cache_read_tokens: c.cache_read,
      cache_write_tokens: c.cache_write_5m + c.cache_write_1h,
      stop_reason: c.stop_reason,
      asked: c.asked.slice(0, 200),
      response: c.response.slice(0, 200),
    }));

  const db = getDb();
  const tools = db
    .prepare(
      `SELECT tool, COUNT(*) calls, SUM(is_error) errors FROM tool_calls
       WHERE session_id = ? GROUP BY tool ORDER BY calls DESC`
    )
    .all(sessionId) as { tool: string; calls: number; errors: number }[];
  const comp = db
    .prepare(`SELECT COUNT(*) c FROM compactions WHERE session_id = ?`)
    .get(sessionId) as { c: number };

  const firstPrompt = d.calls.find((c) => c.asked_kind === "prompt")?.asked?.slice(0, 500) ?? "";

  return {
    session_id: d.session_id,
    title: d.title,
    project: d.project,
    git_branch: d.git_branch,
    started: d.started,
    ended: d.ended,
    duration_ms: d.duration_ms,
    call_count: d.call_count,
    total_cost: +d.totals.cost.toFixed(2),
    total_tokens: d.totals.total_tokens,
    output_tokens: d.totals.output_tokens,
    avg_context_tokens: d.avg_context_tokens,
    cost_composition: {
      output: +d.composition.output.toFixed(2),
      cache_read: +d.composition.cache_read.toFixed(2),
      cache_write: +d.composition.cache_write.toFixed(2),
      input: +d.composition.input.toFixed(2),
      shares_pct: {
        output: +(d.composition.shares.output * 100).toFixed(1),
        cache_read: +(d.composition.shares.cache_read * 100).toFixed(1),
        cache_write: +(d.composition.shares.cache_write * 100).toFixed(1),
        input: +(d.composition.shares.input * 100).toFixed(1),
      },
      write_read_ratio: +Number(d.composition.write_read_ratio).toFixed(2),
    },
    idle_gaps_over_5min: d.idle_gaps,
    compactions: comp.c,
    tool_usage: tools,
    context_growth: growth,
    costliest_calls: topCalls,
    first_prompt: firstPrompt,
    transcript_available: d.transcript_available,
  };
}

/** Split cost & activity between automated (sdk-cli) and human (interactive) usage. */
export function botVsHuman(r: Range) {
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(
      `SELECT (CASE WHEN entrypoint = 'sdk-cli' THEN 'bot' ELSE 'human' END) k, model, ${tokenCols()}
       FROM events ${w.sql} GROUP BY k, model`
    )
    .all(...w.params) as (TokenAgg & { k: string })[];
  const sessions = db
    .prepare(
      `SELECT (CASE WHEN entrypoint = 'sdk-cli' THEN 'bot' ELSE 'human' END) k,
              COUNT(DISTINCT session_id) c
       FROM events ${w.sql} GROUP BY k`
    )
    .all(...w.params) as { k: string; c: number }[];
  const sessMap = new Map(sessions.map((s) => [s.k, s.c]));

  const grouped = new Map<string, TokenAgg[]>();
  for (const row of rows) {
    if (!grouped.has(row.k)) grouped.set(row.k, []);
    grouped.get(row.k)!.push(row);
  }
  const build = (k: string) => {
    const t = totalize(grouped.get(k) ?? []);
    return { ...t, sessions: sessMap.get(k) ?? 0 };
  };
  const bot = build("bot");
  const human = build("human");
  const totalCost = bot.cost + human.cost || 1;
  return {
    bot: { ...bot, share: bot.cost / totalCost },
    human: { ...human, share: human.cost / totalCost },
  };
}

/** Split cost & activity between the main thread and subagents (Task/sidechain). */
export function subagentSplit(r: Range) {
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(
      `SELECT (CASE WHEN is_sidechain = 1 THEN 'subagent' ELSE 'main' END) k, model, ${tokenCols()}
       FROM events ${w.sql} GROUP BY k, model`
    )
    .all(...w.params) as (TokenAgg & { k: string })[];
  const sessions = db
    .prepare(
      `SELECT (CASE WHEN is_sidechain = 1 THEN 'subagent' ELSE 'main' END) k,
              COUNT(DISTINCT session_id) c
       FROM events ${w.sql} GROUP BY k`
    )
    .all(...w.params) as { k: string; c: number }[];
  const sessMap = new Map(sessions.map((s) => [s.k, s.c]));

  const grouped = new Map<string, TokenAgg[]>();
  for (const row of rows) {
    if (!grouped.has(row.k)) grouped.set(row.k, []);
    grouped.get(row.k)!.push(row);
  }
  const build = (k: string) => {
    const t = totalize(grouped.get(k) ?? []);
    return { ...t, sessions: sessMap.get(k) ?? 0 };
  };
  const main = build("main");
  const subagent = build("subagent");
  const totalCost = main.cost + subagent.cost || 1;
  return {
    main: { ...main, share: main.cost / totalCost },
    subagent: { ...subagent, share: subagent.cost / totalCost },
  };
}

/** Context-window compaction events: how often the window fills up and the cost in wall-time. */
export function compactions(r: Range, limit = 20) {
  const db = getDb();
  const w = whereRange(r);
  const totals = db
    .prepare(
      `SELECT COUNT(*) count,
              SUM(CASE WHEN trigger = 'auto' THEN 1 ELSE 0 END) auto,
              SUM(CASE WHEN trigger = 'manual' THEN 1 ELSE 0 END) manual,
              SUM(duration_ms) total_duration_ms,
              SUM(pre_tokens) pre_tokens,
              SUM(post_tokens) post_tokens,
              COUNT(DISTINCT session_id) sessions
       FROM compactions ${w.sql}`
    )
    .get(...w.params) as {
    count: number;
    auto: number;
    manual: number;
    total_duration_ms: number;
    pre_tokens: number;
    post_tokens: number;
    sessions: number;
  };

  const byProject = db
    .prepare(
      `SELECT project, COUNT(*) count, SUM(duration_ms) duration_ms,
              SUM(pre_tokens - post_tokens) tokens_reclaimed
       FROM compactions ${w.sql} GROUP BY project ORDER BY count DESC`
    )
    .all(...w.params) as { project: string; count: number; duration_ms: number; tokens_reclaimed: number }[];

  const recent = db
    .prepare(
      `SELECT uuid, session_id, project, git_branch, ts_epoch, trigger, pre_tokens, post_tokens, duration_ms
       FROM compactions ${w.sql} ORDER BY ts_epoch DESC LIMIT ?`
    )
    .all(...w.params, limit) as {
    uuid: string;
    session_id: string;
    project: string;
    git_branch: string;
    ts_epoch: number;
    trigger: string;
    pre_tokens: number;
    post_tokens: number;
    duration_ms: number;
  }[];

  return {
    count: totals.count ?? 0,
    auto: totals.auto ?? 0,
    manual: totals.manual ?? 0,
    total_duration_ms: totals.total_duration_ms ?? 0,
    tokens_reclaimed: (totals.pre_tokens ?? 0) - (totals.post_tokens ?? 0),
    sessions: totals.sessions ?? 0,
    by_project: byProject,
    recent,
  };
}

/** Human-readable one-line preview of a message's content (text, else a tag). */
function previewOf(content: unknown): { text: string; kind: string } {
  if (typeof content === "string") return { text: content, kind: "text" };
  if (!Array.isArray(content)) return { text: "", kind: "empty" };
  const texts: string[] = [];
  const tags: string[] = [];
  for (const b of content as any[]) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") texts.push(String(b.text ?? ""));
    else if (b.type === "tool_use") tags.push(`⚙ ${b.name ?? "tool"}`);
    else if (b.type === "tool_result") tags.push(b.is_error ? "⚠ tool error" : "↩ tool result");
    else if (b.type === "thinking") tags.push("💭 thinking");
    else if (b.type === "image") tags.push("🖼 image");
  }
  if (texts.join("").trim()) return { text: texts.join("\n"), kind: "text" };
  return { text: tags.join(", "), kind: tags.length ? "meta" : "empty" };
}

/**
 * Drill-down for a single compaction: the summary that survived (the "after")
 * and the run of turns from the previous boundary up to this one (the "before").
 * The transcript is read live from the stored file path.
 */
export function compactionDetail(uuid: string, maxTurns = 400) {
  const db = getDb();
  const c = db.prepare("SELECT * FROM compactions WHERE uuid = ?").get(uuid) as CompactionRow | undefined;
  if (!c) return { error: "not found" };

  const meta = {
    uuid: c.uuid,
    session_id: c.session_id,
    project: c.project,
    git_branch: c.git_branch,
    ts_epoch: c.ts_epoch,
    trigger: c.trigger,
    pre_tokens: c.pre_tokens,
    post_tokens: c.post_tokens,
    duration_ms: c.duration_ms,
  };

  const before: { role: string; ts: number; kind: string; preview: string }[] = [];
  let truncated = false;
  let totalBefore = 0;
  try {
    const raw = readFileSync(c.file, "utf8");
    const parsed = raw.split("\n").map((l) => {
      const t = l.trim();
      if (!t) return null;
      try {
        return JSON.parse(t) as any;
      } catch {
        return null;
      }
    });
    let boundaryIdx = parsed.findIndex((d) => d && d.uuid === uuid && d.subtype === "compact_boundary");
    if (boundaryIdx < 0) boundaryIdx = parsed.length;
    // start of this window = just after the previous compact_boundary (or file start)
    let startIdx = 0;
    for (let i = boundaryIdx - 1; i >= 0; i--) {
      if (parsed[i] && parsed[i].subtype === "compact_boundary") {
        startIdx = i + 1;
        break;
      }
    }
    const turns: { role: string; ts: number; kind: string; preview: string }[] = [];
    for (let i = startIdx; i < boundaryIdx; i++) {
      const d = parsed[i];
      if (!d || d.isSidechain || d.isMeta) continue;
      if (d.type !== "user" && d.type !== "assistant") continue;
      const p = previewOf(d.message?.content);
      if (p.kind === "empty") continue;
      turns.push({
        role: d.type,
        ts: Date.parse(d.timestamp ?? "") || 0,
        kind: p.kind,
        preview: p.text.replace(/\s+/g, " ").trim().slice(0, 280),
      });
    }
    totalBefore = turns.length;
    // keep the most recent maxTurns (the tail is what was freshest in context)
    if (turns.length > maxTurns) {
      truncated = true;
      before.push(...turns.slice(turns.length - maxTurns));
    } else {
      before.push(...turns);
    }
  } catch {
    /* file gone or unreadable — summary still available below */
  }

  return {
    compaction: meta,
    summary: c.summary ?? "",
    before,
    before_shown: before.length,
    before_total: totalBefore,
    truncated,
    file_available: totalBefore > 0 || !!c.summary,
  };
}

/** Tool-call counts + error rate, most-used first. */
export function toolUsage(r: Range) {
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(
      `SELECT tool, COUNT(*) calls, SUM(is_error) errors
       FROM tool_calls ${w.sql} GROUP BY tool ORDER BY calls DESC`
    )
    .all(...w.params) as { tool: string; calls: number; errors: number }[];
  return rows.map((x) => ({ ...x, error_rate: x.calls ? x.errors / x.calls : 0 }));
}

export function stopReasons(r: Range) {
  const db = getDb();
  const w = whereRange(r, "stop_reason <> ''");
  return db
    .prepare(`SELECT stop_reason, COUNT(*) count FROM events ${w.sql} GROUP BY stop_reason ORDER BY count DESC`)
    .all(...w.params) as { stop_reason: string; count: number }[];
}

/** Normalize a raw Bash command into a coarse label: `git commit`, `npm run`, `grep`, ... */
function normalizeCommand(cmd: string): string {
  const c = cmd.trim().replace(/^\(+/, "");
  const first = c.split(/\s+/)[0]?.split("/").pop() ?? "";
  const rest = c.slice(first.length).trim().split(/\s+/)[0] ?? "";
  const twoWord = new Set(["git", "npm", "npx", "yarn", "pnpm", "mvn", "docker", "kubectl", "gh", "cargo", "python3", "python", "pip", "brew"]);
  if (twoWord.has(first) && rest && !rest.startsWith("-")) return `${first} ${rest}`;
  return first || "(empty)";
}

export function topCommands(r: Range, limit = 20) {
  const db = getDb();
  const w = whereRange(r, "tool = 'Bash'", "target IS NOT NULL");
  const rows = db.prepare(`SELECT target FROM tool_calls ${w.sql}`).all(...w.params) as {
    target: string;
  }[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = normalizeCommand(row.target);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([command, count]) => ({ command, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

export function hottestFiles(r: Range, limit = 25) {
  const db = getDb();
  const w = whereRange(r, "tool IN ('Read','Edit','Write','NotebookEdit')", "target IS NOT NULL");
  const rows = db
    .prepare(`SELECT target, tool, COUNT(*) c FROM tool_calls ${w.sql} GROUP BY target, tool`)
    .all(...w.params) as { target: string; tool: string; c: number }[];
  const files = new Map<string, { file: string; reads: number; edits: number; total: number }>();
  for (const row of rows) {
    if (!files.has(row.target))
      files.set(row.target, { file: row.target, reads: 0, edits: 0, total: 0 });
    const f = files.get(row.target)!;
    if (row.tool === "Read") f.reads += row.c;
    else f.edits += row.c;
    f.total += row.c;
  }
  return [...files.values()].sort((a, b) => b.total - a.total).slice(0, limit);
}

/** Prompt (from history.jsonl) + response (from transcripts) length statistics. */
export function textStats(r: Range) {
  const db = getDb();

  const pw = whereRange(r, "chars > 0");
  const p = db
    .prepare(
      `SELECT COUNT(*) count, AVG(chars) avg, MAX(chars) longest, MIN(chars) shortest, SUM(chars) total
       FROM prompts ${pw.sql}`
    )
    .get(...pw.params) as {
    count: number;
    avg: number;
    longest: number;
    shortest: number;
    total: number;
  };

  const rw = whereRange(r, "response_chars > 0");
  const resp = db
    .prepare(
      `SELECT COUNT(*) count, AVG(response_chars) avg, MAX(response_chars) longest, SUM(response_chars) total
       FROM events ${rw.sql}`
    )
    .get(...rw.params) as { count: number; avg: number; longest: number; total: number };

  // largest conversation = session with the most total response characters
  const cw = whereRange(r);
  const largest = db
    .prepare(
      `SELECT session_id, MAX(project) project, MAX(git_branch) git_branch,
              SUM(response_chars) chars, COUNT(*) messages,
              SUM(input_tokens+output_tokens+cache_read+cache_write_5m+cache_write_1h) tokens
       FROM events ${cw.sql}
       GROUP BY session_id ORDER BY chars DESC LIMIT 1`
    )
    .get(...cw.params) as
    | { session_id: string; project: string; git_branch: string; chars: number; messages: number; tokens: number }
    | undefined;

  return {
    prompts: {
      count: p.count ?? 0,
      avg: Math.round(p.avg ?? 0),
      longest: p.longest ?? 0,
      shortest: p.shortest ?? 0,
      total: p.total ?? 0,
    },
    responses: {
      count: resp.count ?? 0,
      avg: Math.round(resp.avg ?? 0),
      longest: resp.longest ?? 0,
      total: resp.total ?? 0,
    },
    largest_conversation: largest ?? null,
  };
}

/**
 * Estimated active "time spent" per project, in milliseconds. For each session,
 * sum gaps between consecutive assistant events, capping any single gap at
 * IDLE_CAP so long breaks between turns don't inflate the total.
 */
export function timeBreakdown(r: Range) {
  const IDLE_CAP = 5 * 60 * 1000; // 5 minutes
  const db = getDb();
  const w = whereRange(r);
  const rows = db
    .prepare(`SELECT project, session_id, ts_epoch FROM events ${w.sql} ORDER BY session_id, ts_epoch`)
    .all(...w.params) as { project: string; session_id: string; ts_epoch: number }[];

  const byProject = new Map<string, number>();
  let prevSession = "";
  let prevTs = 0;
  for (const row of rows) {
    if (row.session_id === prevSession && prevTs) {
      const gap = row.ts_epoch - prevTs;
      if (gap > 0)
        byProject.set(row.project, (byProject.get(row.project) ?? 0) + Math.min(gap, IDLE_CAP));
    }
    prevSession = row.session_id;
    prevTs = row.ts_epoch;
  }
  const total = [...byProject.values()].reduce((a, b) => a + b, 0) || 1;
  return {
    total_ms: total,
    by_project: [...byProject.entries()]
      .map(([project, ms]) => ({ project, ms, share: ms / total }))
      .sort((a, b) => b.ms - a.ms),
  };
}

export function meta() {
  const db = getDb();
  const bounds = db
    .prepare("SELECT MIN(ts_epoch) min, MAX(ts_epoch) max, COUNT(*) c FROM events")
    .get() as { min: number; max: number; c: number };
  const models = (db.prepare("SELECT DISTINCT model FROM events ORDER BY model").all() as {
    model: string;
  }[]).map((r) => r.model);
  const projects = (db
    .prepare("SELECT project, COUNT(*) c FROM events GROUP BY project ORDER BY c DESC")
    .all() as { project: string; c: number }[]).map((r) => r.project);
  return {
    min_ts: bounds.min,
    max_ts: bounds.max,
    total_events: bounds.c,
    models,
    projects,
    pricing: getPricing(),
  };
}
