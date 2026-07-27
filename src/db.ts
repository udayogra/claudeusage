import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.CLAUDEUSAGE_DB || join(__dirname, "..", "usage.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      uuid            TEXT PRIMARY KEY,
      session_id      TEXT,
      project         TEXT,
      cwd             TEXT,
      git_branch      TEXT,
      model           TEXT,
      version         TEXT,
      ts              TEXT,
      ts_epoch        INTEGER,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      cache_read      INTEGER DEFAULT 0,
      cache_write_5m  INTEGER DEFAULT 0,
      cache_write_1h  INTEGER DEFAULT 0,
      response_chars  INTEGER DEFAULT 0,
      entrypoint      TEXT,
      stop_reason     TEXT,
      request_id      TEXT,
      is_sidechain    INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts    ON events(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_events_model ON events(model);
    CREATE INDEX IF NOT EXISTS idx_events_proj  ON events(project);
    CREATE INDEX IF NOT EXISTS idx_events_sess  ON events(session_id);

    CREATE TABLE IF NOT EXISTS ingest_state (
      file        TEXT PRIMARY KEY,
      bytes_read  INTEGER DEFAULT 0,
      mtime_ms    INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS prompts (
      id          TEXT PRIMARY KEY,
      session_id  TEXT,
      project     TEXT,
      ts_epoch    INTEGER,
      chars       INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_ts   ON prompts(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_prompts_proj ON prompts(project);

    CREATE TABLE IF NOT EXISTS tool_calls (
      tool_use_id TEXT PRIMARY KEY,
      session_id  TEXT,
      project     TEXT,
      ts_epoch    INTEGER,
      tool        TEXT,
      target      TEXT,
      is_error    INTEGER DEFAULT 0,
      entrypoint  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tc_ts   ON tool_calls(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_tc_tool ON tool_calls(tool);
    CREATE INDEX IF NOT EXISTS idx_tc_proj ON tool_calls(project);

    CREATE TABLE IF NOT EXISTS session_titles (
      session_id  TEXT PRIMARY KEY,
      title       TEXT,
      is_custom   INTEGER DEFAULT 0,
      ts_epoch    INTEGER
    );

    CREATE TABLE IF NOT EXISTS compactions (
      uuid        TEXT PRIMARY KEY,
      session_id  TEXT,
      project     TEXT,
      git_branch  TEXT,
      entrypoint  TEXT,
      ts_epoch    INTEGER,
      trigger     TEXT,
      pre_tokens  INTEGER DEFAULT 0,
      post_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      summary     TEXT,
      file        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_comp_ts   ON compactions(ts_epoch);
    CREATE INDEX IF NOT EXISTS idx_comp_proj ON compactions(project);
  `);

  db.exec("CREATE INDEX IF NOT EXISTS idx_events_entry ON events(entrypoint)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_side ON events(is_sidechain)");
  // Token counting mirrors Claude Code's own /usage panel, which counts every
  // logged usage line — including the duplicate lines Claude Code writes for a
  // single API response (same message.id, fresh uuid). We therefore do NOT
  // collapse same-request_id rows into one; the uuid PRIMARY KEY alone still
  // guarantees idempotent re-ingest. This is a plain (non-unique) index for
  // request_id lookups/grouping — no dedupe constraint.
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_req ON events(request_id)");
  return db;
}

export interface EventRow {
  uuid: string;
  session_id: string;
  project: string;
  cwd: string;
  git_branch: string;
  model: string;
  version: string;
  ts: string;
  ts_epoch: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  response_chars: number;
  entrypoint: string;
  stop_reason: string;
  request_id: string;
  is_sidechain: number;
}

export interface CompactionRow {
  uuid: string;
  session_id: string;
  project: string;
  git_branch: string;
  entrypoint: string;
  ts_epoch: number;
  trigger: string;
  pre_tokens: number;
  post_tokens: number;
  duration_ms: number;
  summary: string;
  file: string;
}

export interface PromptRow {
  id: string;
  session_id: string;
  project: string;
  ts_epoch: number;
  chars: number;
}

export interface ToolCallRow {
  tool_use_id: string;
  session_id: string;
  project: string;
  ts_epoch: number;
  tool: string;
  target: string | null;
  is_error: number;
  entrypoint: string;
}

export interface TitleRow {
  session_id: string;
  title: string;
  is_custom: number;
  ts_epoch: number;
}
