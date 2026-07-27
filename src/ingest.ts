import { createReadStream, statSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { getDb, type EventRow, type ToolCallRow, type TitleRow, type CompactionRow } from "./db.js";

export const CLAUDE_DIR = process.env.CLAUDE_DIR || join(homedir(), ".claude");
export const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || join(CLAUDE_DIR, "projects");
export const HISTORY_FILE = process.env.CLAUDE_HISTORY_FILE || join(CLAUDE_DIR, "history.jsonl");

function listJsonl(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function projectName(cwd: string | undefined, file: string): string {
  if (cwd && cwd.length) return cwd;
  // fall back to the encoded directory name: -Users-uogra-Downloads-foo -> Downloads/foo
  const dir = basename(join(file, ".."));
  return dir.replace(/^-/, "").replace(/-/g, "/");
}

interface ParsedLine {
  type?: string;
  subtype?: string;
  uuid?: string;
  requestId?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  aiTitle?: string;
  customTitle?: string;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
  };
  message?: {
    id?: string;
    role?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
  };
}

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);

/** Extract the target of a tool call: the file path for file tools, the command for Bash. */
function toolTarget(name: string, input: any): string | null {
  if (!input || typeof input !== "object") return null;
  if (name === "Bash") return typeof input.command === "string" ? input.command : null;
  if (FILE_TOOLS.has(name)) return typeof input.file_path === "string" ? input.file_path : null;
  return null;
}

/** Flatten a message `content` (string or block array) to its visible text. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text") {
      parts.push(String((block as any).text ?? ""));
    }
  }
  return parts.join("\n");
}

/** Length of the visible answer: sum of `text` block lengths (excludes thinking / tool_use). */
function responseChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content) {
    if (block && typeof block === "object" && (block as any).type === "text") {
      n += String((block as any).text ?? "").length;
    }
  }
  return n;
}

function toRow(line: ParsedLine): EventRow | null {
  if (line.type !== "assistant") return null;
  const msg = line.message;
  if (!msg?.usage) return null;
  const model = msg.model ?? "unknown";
  if (model === "<synthetic>") return null; // Claude Code synthetic messages have no real cost
  if (!line.uuid) return null;

  const u = msg.usage;
  const write5m = num(u.cache_creation?.ephemeral_5m_input_tokens);
  const write1h = num(u.cache_creation?.ephemeral_1h_input_tokens);
  // If the fine-grained breakdown is missing, treat total cache creation as 5m writes.
  const totalWrite = write5m + write1h;
  const fallbackWrite = totalWrite === 0 ? num(u.cache_creation_input_tokens) : 0;

  const ts = line.timestamp ?? new Date(0).toISOString();
  return {
    uuid: line.uuid,
    session_id: line.sessionId ?? "",
    project: projectName(line.cwd, ""),
    cwd: line.cwd ?? "",
    git_branch: line.gitBranch ?? "",
    model,
    version: line.version ?? "",
    ts,
    ts_epoch: Date.parse(ts) || 0,
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_read: num(u.cache_read_input_tokens),
    cache_write_5m: write5m + fallbackWrite,
    cache_write_1h: write1h,
    response_chars: responseChars(msg.content),
    entrypoint: line.entrypoint ?? "",
    stop_reason: msg.stop_reason ?? "",
    request_id: line.requestId ?? msg.id ?? "",
    is_sidechain: line.isSidechain ? 1 : 0,
  };
}

interface ParsedBatch {
  rows: EventRow[];
  toolCalls: ToolCallRow[];
  errorIds: string[];
  titles: TitleRow[];
  compactions: CompactionRow[];
  bytes: number;
}

async function readFrom(file: string, startByte: number): Promise<ParsedBatch> {
  const rows: EventRow[] = [];
  const toolCalls: ToolCallRow[] = [];
  const errorIds: string[] = [];
  const titles: TitleRow[] = [];
  const compactions: CompactionRow[] = [];
  // A compact_boundary is immediately followed by a user event carrying the
  // summary text (isCompactSummary). Hold the boundary row here to attach it.
  let pendingCompaction: CompactionRow | null = null;
  const size = statSync(file).size;
  if (startByte >= size) return { rows, toolCalls, errorIds, titles, compactions, bytes: size };
  const stream = createReadStream(file, { start: startByte, encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: ParsedLine;
    try {
      parsed = JSON.parse(trimmed) as ParsedLine;
    } catch {
      continue; // skip malformed / partially-written trailing line
    }
    const type = parsed.type;
    const ts = parsed.timestamp ?? "";
    const tsEpoch = Date.parse(ts) || 0;

    // session titles
    if (type === "ai-title" && parsed.aiTitle && parsed.sessionId) {
      titles.push({ session_id: parsed.sessionId, title: parsed.aiTitle, is_custom: 0, ts_epoch: tsEpoch });
    } else if (type === "custom-title" && parsed.customTitle && parsed.sessionId) {
      titles.push({ session_id: parsed.sessionId, title: parsed.customTitle, is_custom: 1, ts_epoch: tsEpoch });
    }

    // context-window compaction events
    if (type === "system" && parsed.subtype === "compact_boundary" && parsed.compactMetadata && parsed.uuid) {
      const cm = parsed.compactMetadata;
      const row: CompactionRow = {
        uuid: parsed.uuid,
        session_id: parsed.sessionId ?? "",
        project: projectName(parsed.cwd, ""),
        git_branch: parsed.gitBranch ?? "",
        entrypoint: parsed.entrypoint ?? "",
        ts_epoch: tsEpoch,
        trigger: cm.trigger ?? "",
        pre_tokens: num(cm.preTokens),
        post_tokens: num(cm.postTokens),
        duration_ms: num(cm.durationMs),
        summary: "",
        file,
      };
      compactions.push(row);
      pendingCompaction = row;
    } else if (pendingCompaction && type === "user" && parsed.isCompactSummary) {
      // the summary event that replaces the compacted context
      pendingCompaction.summary = contentText(parsed.message?.content);
      pendingCompaction = null;
    } else if (pendingCompaction && type !== "system") {
      // summary should be the immediate next event; give up if it isn't
      pendingCompaction = null;
    }

    if (type === "assistant") {
      const row = toRow(parsed);
      if (row) rows.push(row);
      // tool_use blocks
      const content = parsed.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as any[]) {
          if (b && b.type === "tool_use" && b.id && b.name) {
            toolCalls.push({
              tool_use_id: b.id,
              session_id: parsed.sessionId ?? "",
              project: projectName(parsed.cwd, ""),
              ts_epoch: tsEpoch,
              tool: b.name,
              target: toolTarget(b.name, b.input),
              is_error: 0,
              entrypoint: parsed.entrypoint ?? "",
            });
          }
        }
      }
    } else if (type === "user") {
      const content = parsed.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as any[]) {
          if (b && b.type === "tool_result" && b.is_error && b.tool_use_id) {
            errorIds.push(b.tool_use_id);
          }
        }
      }
    }
  }
  return { rows, toolCalls, errorIds, titles, compactions, bytes: size };
}

export interface IngestResult {
  filesScanned: number;
  filesUpdated: number;
  newEvents: number;
  totalEvents: number;
  prompts: number;
  elapsedMs: number;
}

export async function ingest(root = PROJECTS_DIR): Promise<IngestResult> {
  const t0 = Date.now();
  const db = getDb();
  const files = listJsonl(root);

  const getState = db.prepare<[string], { bytes_read: number; mtime_ms: number }>(
    "SELECT bytes_read, mtime_ms FROM ingest_state WHERE file = ?"
  );
  const upsertState = db.prepare(
    "INSERT INTO ingest_state(file, bytes_read, mtime_ms) VALUES (?,?,?) " +
      "ON CONFLICT(file) DO UPDATE SET bytes_read=excluded.bytes_read, mtime_ms=excluded.mtime_ms"
  );
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
     (uuid, session_id, project, cwd, git_branch, model, version, ts, ts_epoch,
      input_tokens, output_tokens, cache_read, cache_write_5m, cache_write_1h, response_chars,
      entrypoint, stop_reason, request_id, is_sidechain)
     VALUES (@uuid,@session_id,@project,@cwd,@git_branch,@model,@version,@ts,@ts_epoch,
      @input_tokens,@output_tokens,@cache_read,@cache_write_5m,@cache_write_1h,@response_chars,
      @entrypoint,@stop_reason,@request_id,@is_sidechain)`
  );
  const insertCompaction = db.prepare(
    `INSERT OR IGNORE INTO compactions
     (uuid, session_id, project, git_branch, entrypoint, ts_epoch, trigger, pre_tokens, post_tokens, duration_ms, summary, file)
     VALUES (@uuid,@session_id,@project,@git_branch,@entrypoint,@ts_epoch,@trigger,@pre_tokens,@post_tokens,@duration_ms,@summary,@file)`
  );
  const insertTool = db.prepare(
    `INSERT OR IGNORE INTO tool_calls
     (tool_use_id, session_id, project, ts_epoch, tool, target, is_error, entrypoint)
     VALUES (@tool_use_id,@session_id,@project,@ts_epoch,@tool,@target,@is_error,@entrypoint)`
  );
  const markError = db.prepare("UPDATE tool_calls SET is_error = 1 WHERE tool_use_id = ?");
  const upsertTitle = db.prepare(
    `INSERT INTO session_titles(session_id, title, is_custom, ts_epoch) VALUES (?,?,?,?)
     ON CONFLICT(session_id) DO UPDATE SET
       title = excluded.title, is_custom = excluded.is_custom, ts_epoch = excluded.ts_epoch
     WHERE excluded.is_custom >= session_titles.is_custom AND excluded.ts_epoch >= session_titles.ts_epoch`
  );

  let filesUpdated = 0;
  let newEvents = 0;

  for (const file of files) {
    const st = statSync(file);
    const prev = getState.get(file);
    if (prev && prev.mtime_ms === st.mtimeMs && prev.bytes_read >= st.size) continue;

    const startByte = prev && prev.mtime_ms === st.mtimeMs ? prev.bytes_read : 0;
    const batch = await readFrom(file, startByte);

    const tx = db.transaction((b: ParsedBatch) => {
      for (const r of b.rows) newEvents += insertEvent.run(r).changes;
      for (const tc of b.toolCalls) insertTool.run(tc);
      for (const id of b.errorIds) markError.run(id);
      for (const t of b.titles) upsertTitle.run(t.session_id, t.title, t.is_custom, t.ts_epoch);
      for (const c of b.compactions) insertCompaction.run(c);
      upsertState.run(file, b.bytes, st.mtimeMs);
    });
    tx(batch);
    if (batch.rows.length || batch.toolCalls.length || batch.compactions.length) filesUpdated++;
  }

  const prompts = ingestHistory();

  const totalEvents = (db.prepare("SELECT COUNT(*) c FROM events").get() as { c: number }).c;
  return {
    filesScanned: files.length,
    filesUpdated,
    newEvents,
    totalEvents,
    prompts,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Rebuild the `prompts` table from ~/.claude/history.jsonl — the authoritative
 * record of user-typed prompts. It's a single small file, so we clear + reload
 * each run (cheap, avoids dedup edge cases).
 */
function ingestHistory(file = HISTORY_FILE): number {
  const db = getDb();
  if (!existsSync(file)) return 0;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO prompts(id, session_id, project, ts_epoch, chars) VALUES (?,?,?,?,?)"
  );
  const rows: [string, string, string, number, number][] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const d = JSON.parse(t) as {
        display?: string;
        timestamp?: number;
        project?: string;
        sessionId?: string;
      };
      const text = d.display ?? "";
      if (!text) continue;
      const ts = typeof d.timestamp === "number" ? d.timestamp : 0;
      const id = createHash("sha1")
        .update(`${ts}|${d.sessionId ?? ""}|${text}`)
        .digest("hex");
      rows.push([id, d.sessionId ?? "", d.project ?? "", ts, text.length]);
    } catch {
      /* skip malformed line */
    }
  }
  const tx = db.transaction(() => {
    db.exec("DELETE FROM prompts");
    for (const r of rows) insert.run(...r);
  });
  tx();
  return rows.length;
}

// Allow running directly: `tsx src/ingest.ts`
if (import.meta.url === `file://${process.argv[1]}`) {
  ingest().then((r) => {
    console.log(
      `Ingest complete: ${r.newEvents} new events from ${r.filesScanned} files ` +
        `(${r.filesUpdated} updated), ${r.totalEvents} total, ${r.prompts} prompts, ${r.elapsedMs}ms`
    );
  });
}
