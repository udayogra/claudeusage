# claudeusage

A local, on-demand dashboard for your Claude Code token & cost usage. It parses
the session transcripts Claude Code writes to `~/.claude/projects/**/*.jsonl`,
stores normalized per-message events in a local SQLite file, and serves an
interactive charts dashboard.

Everything runs on your machine. The dashboard itself makes no outbound API
calls (it only loads Chart.js from a CDN in the browser). The optional **Ask**
feature is the one exception — it shells out to your locally installed `claude`
CLI to answer questions about your data, which does reach Anthropic. It uses
your existing Claude Code login, so no API key is stored or required here.

## Quick start

```bash
npm install
npm start        # ingests new events, starts the server, opens the browser
```

Then open http://127.0.0.1:4317 (opened automatically).

**Zero configuration.** There's nothing to set up. It auto-detects your Claude
Code data at `~/.claude` (transcripts under `~/.claude/projects`), and the
SQLite database (`usage.db`) is created automatically on first run — you never
create or configure it. The server binds to `127.0.0.1` (localhost only), so
it's reachable only from your own machine. Every path is overridable via env
vars (see [Config](#config-env-vars)) if your setup is non-standard, but the
defaults work out of the box.

`npm start` re-ingests every time; ingestion is incremental (it only reads new
bytes appended to each transcript since last run), so it stays fast. While the
dashboard is running it also re-ingests in the background every 60s, so live
sessions stay current without a restart.

## Commands

| Command             | What it does                                             |
| ------------------- | -------------------------------------------------------- |
| `npm start`         | Ingest + serve + open browser (add `-- --no-open` to skip) |
| `npm run ingest`    | Ingest only (parse transcripts into `usage.db`)          |
| `npm run serve`     | Serve the dashboard without re-ingesting                 |
| `npm run typecheck` | Type-check the TypeScript                                |

## What you get

- **Summary cards**: total cost, projected monthly run-rate, tokens, messages,
  cache reads + estimated cache savings, sessions & projects.
- **Cost over time** and **stacked tokens over time** (hourly / daily / weekly / monthly).
- **Cost by model** (doughnut) and **cost by group** — switch between project,
  git branch, or session.
- **Activity heatmap** — cost by day-of-week × hour-of-day.
- **Bot vs human** and **main vs subagent** cost splits.
- **Tool usage**, **stop reasons**, **top slash commands**, and **hottest files**.
- **Compactions** — when context was compacted, and the token cost of each.
- **Top sessions by cost** table, each opening a per-session view with a
  turn-by-turn **replay** and a token/cost breakdown.
- **Ask** — a natural-language assistant (global or per-session) that answers
  questions about your usage, grounded only in the dashboard's own data. Runs
  through your local `claude` CLI (see note above).
- **Re-ingest** button to pull in new usage on demand (in addition to the
  background auto-ingest).

## Pricing

Costs are computed at query time from `pricing.json` (USD per 1M tokens, matched
by model-name prefix). Edit that file and refresh the page to re-cost your whole
history — no re-ingest needed.

The shipped defaults are tuned to **match Claude Code's own `/usage` panel** on
Opus 4.x, which reflects effective/subscription pricing (~0.40× the Anthropic
public list price), not the raw list rate. To see raw list-price estimates
instead, multiply every number in `pricing.json` by 2.5. Adjust any of the
values to match your own actual rates.

## How it works

- Only `assistant` records carry a `usage` block, so those are the events stored.
- `<synthetic>` model messages (Claude Code internal) are skipped — they cost nothing.
- Cache writes are split into 5-minute and 1-hour ephemeral tokens, which are
  priced differently.
- Token totals count every logged `usage` line — the same way `/usage` does,
  including the duplicate lines Claude Code sometimes writes for a single API
  response — so the dashboard's read/write/cost totals line up with `/usage`.
  The distinct-request count (and the session replay) still de-duplicates, so
  you don't see doubled turns.
- Incremental ingest tracks each file's byte offset + mtime in an `ingest_state`
  table, so re-runs only parse appended lines. The `uuid` primary key keeps
  re-ingest idempotent.

## Config (env vars)

| Variable                          | Default              | Purpose                                   |
| --------------------------------- | -------------------- | ----------------------------------------- |
| `PORT`                            | `4317`               | Dashboard port                            |
| `CLAUDE_DIR`                      | `~/.claude`          | Root of your Claude Code data             |
| `CLAUDE_PROJECTS_DIR`             | `$CLAUDE_DIR/projects` | Where transcripts live                  |
| `CLAUDE_HISTORY_FILE`             | `$CLAUDE_DIR/history.jsonl` | Prompt history file                 |
| `CLAUDEUSAGE_DB`                  | `./usage.db`         | SQLite database path                      |
| `CLAUDEUSAGE_INGEST_INTERVAL_MS`  | `60000`              | Background re-ingest interval (min 5000)  |

## Notes / caveats

- Reflects **Claude Code** usage only. It does not see raw Anthropic API traffic
  from other apps (that would need a separate logging layer) or Console billing.
- The transcript JSON shape can change between Claude Code versions; the parser
  skips anything it can't read rather than crashing.
- The **Ask** feature requires the `claude` CLI to be installed and signed in
  (`claude` runnable on your PATH). Without it, the rest of the dashboard works
  fine — only the Ask panels are affected.
