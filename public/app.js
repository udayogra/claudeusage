const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => "$" + (n ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (n) => (n ?? 0).toLocaleString();
const fmtTok = (n) => {
  n = n ?? 0;
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
};

const charts = {};
function draw(id, config) {
  if (charts[id]) charts[id].destroy();
  charts[id] = new Chart($(id), config);
}

const PALETTE = ["#d97757", "#5b8def", "#4bbf9a", "#c86fc9", "#e0b341", "#6fb3d9", "#e06666", "#9b8cff"];

function rangeParams() {
  const p = new URLSearchParams();
  const from = $("from").value, to = $("to").value;
  if (from) p.set("from", Date.parse(from + "T00:00:00"));
  if (to) p.set("to", Date.parse(to + "T23:59:59"));
  return p;
}

async function getJSON(path, extra = {}) {
  const p = rangeParams();
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const res = await fetch(path + "?" + p.toString());
  return res.json();
}

function renderCards(s) {
  const cards = [
    { label: "Total cost", value: fmtUsd(s.cost), sub: `${fmtUsd(s.avg_cost_per_day)}/active day` },
    { label: "Projected / month", value: fmtUsd(s.projected_month), sub: `run-rate over ${s.active_days} days` },
    { label: "Total tokens", value: fmtTok(s.total_tokens), sub: `${fmtNum(s.messages)} messages` },
    { label: "Output tokens", value: fmtTok(s.output_tokens), sub: `in ${fmtTok(s.input_tokens)} input` },
    { label: "Cache read", value: fmtTok(s.cache_read), sub: `saved ${fmtUsd(s.cache_savings)}` },
    { label: "Sessions", value: fmtNum(s.sessions), sub: `${fmtNum(s.projects)} projects` },
  ];
  $("cards").innerHTML = cards
    .map((c) => `<div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`)
    .join("");
}

function renderTimeCharts(ts) {
  const labels = ts.map((r) => r.bucket);
  draw("costChart", {
    type: "line",
    data: {
      labels,
      datasets: [{ label: "Cost (USD)", data: ts.map((r) => r.cost), borderColor: PALETTE[0], backgroundColor: PALETTE[0] + "33", fill: true, tension: 0.25, pointRadius: 2 }],
    },
    options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: (v) => "$" + v } } } },
  });
  draw("tokenChart", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Input", data: ts.map((r) => r.input_tokens), backgroundColor: PALETTE[1] },
        { label: "Output", data: ts.map((r) => r.output_tokens), backgroundColor: PALETTE[0] },
        { label: "Cache read", data: ts.map((r) => r.cache_read), backgroundColor: PALETTE[2] },
        { label: "Cache write", data: ts.map((r) => r.cache_write_5m + r.cache_write_1h), backgroundColor: PALETTE[4] },
      ],
    },
    options: { responsive: true, scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: fmtTok } } } },
  });
}

function renderModel(rows) {
  draw("modelChart", {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.key),
      datasets: [{ data: rows.map((r) => r.cost), backgroundColor: PALETTE }],
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } },
  });
}

function renderDim(rows, dim) {
  $("dimTitle").textContent = "Cost by " + dim.replace("_", " ");
  const top = rows.slice(0, 12);
  draw("dimChart", {
    type: "bar",
    data: {
      labels: top.map((r) => shorten(r.key)),
      datasets: [{ label: "Cost", data: top.map((r) => r.cost), backgroundColor: PALETTE[3] }],
    },
    options: { indexAxis: "y", responsive: true, plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: (v) => "$" + v } } } },
  });
}

function shorten(s) {
  if (!s) return "(none)";
  if (s.length <= 32) return s;
  return "…" + s.slice(-30);
}

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function renderHeatmap(cells) {
  const max = Math.max(...cells.map((c) => c.cost), 0.0001);
  const byKey = {};
  cells.forEach((c) => (byKey[`${c.dow}-${c.hour}`] = c));
  let html = '<div class="hm"><div></div>';
  for (let h = 0; h < 24; h++) html += `<div>${h}</div>`;
  for (let d = 0; d < 7; d++) {
    html += `<div class="rowlabel">${DOW[d]}</div>`;
    for (let h = 0; h < 24; h++) {
      const c = byKey[`${d}-${h}`];
      const v = c ? c.cost / max : 0;
      const bg = v > 0 ? `rgba(217,119,87,${0.12 + v * 0.88})` : "var(--panel-2)";
      const title = c ? `${DOW[d]} ${h}:00 — ${fmtUsd(c.cost)}, ${c.messages} msgs` : `${DOW[d]} ${h}:00`;
      html += `<div class="cell" style="background:${bg}" title="${title}"></div>`;
    }
  }
  html += "</div>";
  $("heatmap").innerHTML = html;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function renderSessions(rows, all) {
  const t = $("sessTitle");
  if (t) t.textContent = all ? `All sessions (${rows.length})` : `Top ${rows.length} sessions by cost`;
  const body = rows
    .map(
      (r) => `<tr class="crow" data-sid="${esc(r.session_id)}" title="Click to inspect this session">
        <td>${new Date(r.started).toLocaleDateString()}</td>
        <td title="${esc(r.title)}">${r.title ? esc(shorten2(r.title, 40)) : "—"}</td>
        <td>${shorten(r.project)}</td>
        <td>${r.git_branch || "—"}</td>
        <td class="num">${fmtTok(r.total_tokens)}</td>
        <td class="num">${fmtNum(r.messages)}</td>
        <td class="num">${fmtUsd(r.cost)}</td>
        <td class="inspect"><span class="hint">Inspect </span><span class="chev">›</span></td>
      </tr>`
    )
    .join("");
  $("sessions").innerHTML = `<table>
    <thead><tr><th>Date</th><th>Title</th><th>Project</th><th>Branch</th><th class="num">Tokens</th><th class="num">Msgs</th><th class="num">Cost</th><th></th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

// Lazily build the slide-over modal shell used for session detail.
function ensureSessionModal() {
  let backdrop = $("sessModal");
  if (backdrop) return backdrop;
  backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  backdrop.id = "sessModal";
  backdrop.hidden = true;
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="sessModalTitle">
      <div class="modal-head">
        <div class="mh-main">
          <h2 class="mh-title" id="sessModalTitle"></h2>
          <div class="mh-sub" id="sessModalSub"></div>
        </div>
        <div class="mh-cost" id="sessModalCost"></div>
        <button class="modal-close" id="sessModalClose" title="Close (Esc)" aria-label="Close">✕</button>
      </div>
      <div class="modal-body" id="sessModalBody"></div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = () => closeSessionModal();
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  $("sessModalClose").addEventListener("click", close);
  return backdrop;
}

function closeSessionModal() {
  const backdrop = $("sessModal");
  if (backdrop) { backdrop.hidden = true; backdrop.dataset.open = ""; }
  document.removeEventListener("keydown", onSessModalKey);
}

function onSessModalKey(e) { if (e.key === "Escape") closeSessionModal(); }

async function showSessionDetail(sid) {
  const backdrop = ensureSessionModal();
  backdrop.hidden = false;
  backdrop.dataset.open = sid;
  document.addEventListener("keydown", onSessModalKey);
  const box = $("sessModalBody");
  $("sessModalTitle").textContent = "Loading…";
  $("sessModalSub").textContent = "";
  $("sessModalCost").textContent = "";
  box.innerHTML = `<div style="color:var(--muted);font-size:12px;padding:10px 0">Loading session…</div>`;
  const d = await fetch("/api/session?id=" + encodeURIComponent(sid)).then((r) => r.json());
  if (backdrop.dataset.open !== sid) return; // a newer open superseded this fetch
  if (d.error) { box.innerHTML = `<div class="cdcol">Session not found.</div>`; return; }

  const models = d.by_model
    .map((m) => `<tr><td>${esc(m.model)}</td><td class="num">${fmtTok(m.total_tokens)}</td><td class="num">${fmtNum(m.messages)}</td><td class="num">${fmtUsd(m.cost)}</td></tr>`)
    .join("");

  const sentBadge = (k) =>
    k === "prompt"
      ? '<span class="pill sent-you">you</span>'
      : k === "tool_result"
      ? '<span class="pill sent-tool">tool result</span>'
      : '<span class="pill">context</span>';
  const respTags = (t) => {
    const tags = [];
    if (t.thinking) tags.push('<span class="pill">💭 thinking</span>');
    for (const tool of t.tools || []) tags.push(`<span class="pill">⚙ ${esc(tool)}</span>`);
    return tags.join(" ");
  };
  const calls = (d.timeline || [])
    .map((t) => `<tr class="${t.is_sidechain ? "muted" : ""}">
        <td class="num">${t.n}</td>
        <td>${t.ts ? new Date(t.ts).toLocaleTimeString() : "—"}</td>
        <td title="${esc(t.sent)}">${sentBadge(t.sent_kind)} ${t.sent ? esc(shorten2(t.sent, 60)) : "—"}${t.is_sidechain ? ` <span class="pill sub" title="subagent${t.agent ? ": " + esc(t.agent) : ""}">${t.agent ? "sub · " + esc(t.agent) : "sub"}</span>` : ""}</td>
        <td title="${esc(t.text)}">${respTags(t)}${t.text ? " " + esc(shorten2(t.text, 60)) : t.thinking || (t.tools && t.tools.length) ? "" : " —"}</td>
        <td class="num">${fmtTok(t.output_tokens)}</td>
        <td class="num">${fmtTok(t.cache_read)}</td>
        <td class="num">${fmtTok(t.cache_write)}</td>
        <td class="num">${fmtUsd(t.cost)}</td>
      </tr>`)
    .join("");

  const cp = d.composition, sh = cp.shares;
  const seg = (frac, color, label) =>
    frac > 0.02 ? `<div style="width:${(frac * 100).toFixed(1)}%;background:${color}" title="${label}"></div>` : "";
  const compBar = `<div class="compbar">
      ${seg(sh.cache_write, PALETTE[6], "Cache write " + (sh.cache_write * 100).toFixed(0) + "%")}
      ${seg(sh.cache_read, PALETTE[1], "Cache read " + (sh.cache_read * 100).toFixed(0) + "%")}
      ${seg(sh.output, PALETTE[2], "Output " + (sh.output * 100).toFixed(0) + "%")}
      ${seg(sh.input, PALETTE[4], "Input " + (sh.input * 100).toFixed(0) + "%")}
    </div>`;
  const ratioWarn = cp.write_read_ratio >= 1;
  const verdict = `<div class="compmeta">
      <span><i style="background:${PALETTE[6]}"></i>Cache write ${fmtUsd(cp.cache_write)} (${(sh.cache_write * 100).toFixed(0)}%)</span>
      <span><i style="background:${PALETTE[1]}"></i>Cache read ${fmtUsd(cp.cache_read)} (${(sh.cache_read * 100).toFixed(0)}%)</span>
      <span><i style="background:${PALETTE[2]}"></i>Output ${fmtUsd(cp.output)} (${(sh.output * 100).toFixed(0)}%)</span>
    </div>
    <div class="compmeta">
      <span class="${ratioWarn ? "warn" : ""}">write:read ${Number(cp.write_read_ratio).toFixed(2)}${ratioWarn ? " ⚠ cache churn" : ""}</span>
      <span class="${d.idle_gaps > 5 ? "warn" : ""}">${d.idle_gaps} idle gaps &gt;5m</span>
      <span>avg context ${fmtTok(d.avg_context_tokens)}/call</span>
    </div>`;

  // populate the sticky header so it's always clear which session this is
  $("sessModalTitle").textContent = d.title || "(untitled session)";
  $("sessModalSub").innerHTML =
    `<span>${new Date(d.started).toLocaleDateString()}</span>` +
    `<span>${esc(d.project)}</span>` +
    `<span>${esc(d.git_branch || "—")}</span>` +
    `<span>${d.call_count} calls · ${fmtNum(d.turn_count || 0)} turns</span>`;
  $("sessModalCost").textContent = fmtUsd(d.totals.cost);

  const trunc = d.truncated ? ` (showing first ${d.calls_shown})` : "";
  box.innerHTML = `
    <div class="cdetail">
      <div class="cdcol">
        <h3>Session totals — ${d.call_count} calls${trunc}</h3>
        <table>
          <thead><tr><th>Model</th><th class="num">Tokens</th><th class="num">Calls</th><th class="num">Cost</th></tr></thead>
          <tbody>${models}<tr><td><b>Total</b></td><td class="num"><b>${fmtTok(d.totals.total_tokens)}</b></td><td class="num"><b>${fmtNum(d.totals.messages)}</b></td><td class="num"><b>${fmtUsd(d.totals.cost)}</b></td></tr></tbody>
        </table>
      </div>
      <div class="cdcol">
        <h3>What drove the cost</h3>
        ${compBar}
        ${verdict}
      </div>
    </div>
    <div class="sectlabel">Ask Claude about this session</div>
    <div class="sessask">
      <div id="sessChat" class="sesschat" data-resume=""></div>
      <div class="askbar">
        <input type="text" id="sessAskInput" placeholder="Ask about this session — leave blank for a full cost breakdown; follow-ups keep context" />
        <button id="sessAskBtn">Ask Claude</button>
      </div>
    </div>
    <div class="sectlabel">Conversation replay — ${fmtNum(d.turn_count || 0)} turns${d.timeline_truncated ? ` (showing first ${d.timeline.length})` : ""}</div>
    <div style="color:var(--muted);font-size:11px;margin-bottom:6px">Each row is one API round-trip: what was <b>sent</b> that turn (your prompt or the tool result fed back), and what the model <b>responded</b>. Rows tagged <span class="pill">sub</span> are subagent calls.</div>
    <div class="beforelist">
      <table>
        <thead><tr><th class="num">#</th><th>Time</th><th>Sent</th><th>Response</th><th class="num">Out</th><th class="num">Cache rd</th><th class="num">Cache wr</th><th class="num">Cost</th></tr></thead>
        <tbody>${calls}</tbody>
      </table>
    </div>`;

  $("sessAskBtn").addEventListener("click", () => runSessionAsk(sid));
  $("sessAskInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runSessionAsk(sid); });
}

function addBubble(chat, role, text) {
  const b = document.createElement("div");
  b.className = "bubble " + role;
  const t = document.createElement("div");
  t.className = "bubbletext";
  t.textContent = text;
  b.appendChild(t);
  chat.appendChild(b);
  chat.scrollTop = chat.scrollHeight;
  return b;
}

async function runSessionAsk(sid) {
  const btn = $("sessAskBtn"), input = $("sessAskInput"), chat = $("sessChat");
  const q = input.value.trim();
  const resumeId = chat.dataset.resume || "";
  // follow-ups require text; only the very first message may be blank
  if (!q && resumeId) { input.focus(); return; }

  addBubble(chat, "user", q || "(full cost breakdown)");
  input.value = "";
  btn.disabled = true;
  btn.textContent = "Thinking…";
  const bubble = addBubble(chat, "assistant", resumeId ? "…" : "Sending this session's diagnostics to Claude…");

  try {
    const res = await fetch("/api/ask-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sid, question: q, resumeId }),
    }).then((r) => r.json());
    if (res.error) {
      bubble.classList.add("err");
      bubble.querySelector(".bubbletext").textContent = res.error;
    } else {
      bubble.querySelector(".bubbletext").textContent = res.answer || "(no answer)";
      if (res.session_id) chat.dataset.resume = res.session_id;
      const meta = [];
      if (res.usage) meta.push(`${fmtTok(res.usage.input_tokens)} in / ${fmtTok(res.usage.output_tokens)} out`);
      if (res.cost_usd != null) meta.push(`${fmtUsd(res.cost_usd)} this turn`);
      if (meta.length) {
        const m = document.createElement("div");
        m.className = "meta";
        m.textContent = meta.join(" · ");
        bubble.appendChild(m);
      }
    }
  } catch (e) {
    bubble.classList.add("err");
    bubble.querySelector(".bubbletext").textContent = "Request failed: " + e;
  } finally {
    btn.disabled = false;
    btn.textContent = "Ask Claude";
    chat.scrollTop = chat.scrollHeight;
    input.focus();
  }
}

function shorten2(s, n) {
  if (!s) return "";
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

function renderBotVsHuman(d) {
  const bot = d.bot, human = d.human;
  draw("botChart", {
    type: "doughnut",
    data: {
      labels: ["Bot (sdk-cli)", "Human (interactive)"],
      datasets: [{ data: [bot.cost, human.cost], backgroundColor: [PALETTE[5], PALETTE[0]] }],
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } },
  });
  const row = (label, x) =>
    `<tr><td>${label}</td><td class="num">${fmtUsd(x.cost)}</td><td class="num">${(x.share * 100).toFixed(1)}%</td><td class="num">${fmtNum(x.messages)}</td><td class="num">${fmtNum(x.sessions)}</td></tr>`;
  $("botlegend").innerHTML = `<table><thead><tr><th></th><th class="num">Cost</th><th class="num">Share</th><th class="num">Msgs</th><th class="num">Sess</th></tr></thead><tbody>${row("Bot", bot)}${row("Human", human)}</tbody></table>`;
}

function renderSubagents(d) {
  const main = d.main, sub = d.subagent;
  draw("subagentChart", {
    type: "doughnut",
    data: {
      labels: ["Main thread", "Subagents (Task)"],
      datasets: [{ data: [main.cost, sub.cost], backgroundColor: [PALETTE[1], PALETTE[3]] }],
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } },
  });
  const row = (label, x) =>
    `<tr><td>${label}</td><td class="num">${fmtUsd(x.cost)}</td><td class="num">${(x.share * 100).toFixed(1)}%</td><td class="num">${fmtTok(x.total_tokens)}</td><td class="num">${fmtNum(x.messages)}</td></tr>`;
  $("subagentlegend").innerHTML = `<table><thead><tr><th></th><th class="num">Cost</th><th class="num">Share</th><th class="num">Tokens</th><th class="num">Msgs</th></tr></thead><tbody>${row("Main", main)}${row("Subagents", sub)}</tbody></table>`;
}

function renderCompactions(d) {
  if (!d.count) {
    $("compactions").innerHTML = `<div style="color:var(--muted);font-size:13px">No context-window compactions in this range. 🎉</div>`;
    return;
  }
  const cards = [
    { label: "Compactions", value: fmtNum(d.count), sub: `${fmtNum(d.auto)} auto · ${fmtNum(d.manual)} manual` },
    { label: "Time lost", value: fmtDur(d.total_duration_ms), sub: "wall-time spent compacting" },
    { label: "Tokens reclaimed", value: fmtTok(d.tokens_reclaimed), sub: "shed from context" },
    { label: "Sessions affected", value: fmtNum(d.sessions), sub: "hit the window limit" },
  ];
  const cardHtml =
    `<div class="cards" style="margin:0 0 12px">` +
    cards.map((c) => `<div class="card"><div class="label">${c.label}</div><div class="value">${c.value}</div><div class="sub">${c.sub}</div></div>`).join("") +
    `</div>`;
  const body = d.recent
    .map((r) => {
      const shed = r.pre_tokens - r.post_tokens;
      return `<tr class="crow" data-uuid="${esc(r.uuid)}" title="Click to see before / after">
        <td>${new Date(r.ts_epoch).toLocaleString()}</td>
        <td title="${esc(r.project)}">${shorten(r.project)}</td>
        <td>${r.git_branch || "—"}</td>
        <td>${esc(r.trigger)}</td>
        <td class="num">${fmtTok(r.pre_tokens)} → ${fmtTok(r.post_tokens)}</td>
        <td class="num">${fmtTok(shed)}</td>
        <td class="num">${fmtDur(r.duration_ms)}</td>
      </tr>`;
    })
    .join("");
  const table = `<table><thead><tr><th>When</th><th>Project</th><th>Branch</th><th>Trigger</th><th class="num">Tokens</th><th class="num">Shed</th><th class="num">Took</th></tr></thead><tbody>${body}</tbody></table>`;
  $("compactions").innerHTML = cardHtml + table + `<div id="compactionDetail"></div>`;
}

async function showCompactionDetail(uuid) {
  const box = $("compactionDetail");
  box.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px">Loading…</div>`;
  const d = await getJSON("/api/compaction", { uuid });
  if (d.error) {
    box.innerHTML = `<div style="color:var(--muted);font-size:13px;padding:8px">Not found.</div>`;
    return;
  }
  const beforeRows = d.before
    .map((t) => {
      const time = t.ts ? new Date(t.ts).toLocaleTimeString() : "";
      const badge = t.role === "user" ? "user" : "asst";
      const cls = t.kind === "text" ? "" : ' style="color:var(--muted)"';
      return `<tr${cls}>
        <td style="white-space:nowrap;color:var(--muted)">${time}</td>
        <td style="white-space:nowrap"><span class="pill">${badge}</span></td>
        <td>${esc(t.preview)}</td>
      </tr>`;
    })
    .join("");
  const shownNote = d.truncated
    ? `showing latest ${fmtNum(d.before_shown)} of ${fmtNum(d.before_total)} turns`
    : `${fmtNum(d.before_total)} turns`;
  box.innerHTML = `
    <div class="cdetail">
      <div class="cdcol">
        <h3>After — surviving context (${fmtNum(d.summary.length)} chars ≈ ${fmtTok(d.compaction.post_tokens)} tokens)</h3>
        <pre class="summary">${esc(d.summary) || "<no summary captured>"}</pre>
      </div>
      <div class="cdcol">
        <h3>Before — what was compacted away (${shownNote}, ≈ ${fmtTok(d.compaction.pre_tokens)} tokens)</h3>
        <div class="beforelist"><table><tbody>${beforeRows || '<tr><td style="color:var(--muted)">Transcript file not available.</td></tr>'}</tbody></table></div>
      </div>
    </div>`;
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function renderStopReasons(rows) {
  draw("stopChart", {
    type: "doughnut",
    data: {
      labels: rows.map((r) => r.stop_reason),
      datasets: [{ data: rows.map((r) => r.count), backgroundColor: PALETTE }],
    },
    options: { responsive: true, plugins: { legend: { position: "bottom" } } },
  });
}

function renderTools(rows) {
  const top = rows.slice(0, 15);
  const body = top
    .map((r) => {
      const rate = (r.error_rate * 100).toFixed(1);
      const hot = r.error_rate >= 0.1 ? ' style="color:var(--accent)"' : "";
      return `<tr>
        <td title="${esc(r.tool)}">${esc(shorten2(r.tool, 28))}</td>
        <td class="num">${fmtNum(r.calls)}</td>
        <td class="num"${hot}>${rate}%</td>
      </tr>`;
    })
    .join("");
  $("tools").innerHTML = `<table><thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Err</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderCommands(rows) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  const body = rows
    .map(
      (r) => `<tr>
        <td><code>${esc(r.command)}</code></td>
        <td style="width:40%"><div style="background:var(--accent);height:10px;border-radius:3px;width:${Math.max((r.count / max) * 100, 2)}%"></div></td>
        <td class="num">${fmtNum(r.count)}</td>
      </tr>`
    )
    .join("");
  $("commands").innerHTML = `<table><tbody>${body}</tbody></table>`;
}

function renderFiles(rows) {
  const body = rows
    .map(
      (r) => `<tr>
        <td title="${esc(r.file)}">${esc(shortFile(r.file))}</td>
        <td class="num">${fmtNum(r.reads)}</td>
        <td class="num">${fmtNum(r.edits)}</td>
        <td class="num">${fmtNum(r.total)}</td>
      </tr>`
    )
    .join("");
  $("files").innerHTML = `<table><thead><tr><th>File</th><th class="num">Reads</th><th class="num">Edits</th><th class="num">Total</th></tr></thead><tbody>${body}</tbody></table>`;
}

function shortFile(p) {
  if (!p) return "(none)";
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}

function fmtChars(n) {
  n = n ?? 0;
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return fmtNum(n);
}
function fmtDur(ms) {
  const h = ms / 3.6e6;
  if (h >= 1) return h.toFixed(1) + "h";
  const m = ms / 60000;
  if (m >= 1) return m.toFixed(m < 10 ? 1 : 0) + "m";
  return Math.round(ms / 1000) + "s";
}

function renderTextStats(t) {
  const p = t.prompts, r = t.responses, lc = t.largest_conversation;
  const rows = [
    ["Prompts counted", fmtNum(p.count)],
    ["Avg prompt length", fmtNum(p.avg) + " chars"],
    ["Longest prompt", fmtNum(p.longest) + " chars"],
    ["Shortest prompt", fmtNum(p.shortest) + " chars"],
    ["Responses counted", fmtNum(r.count)],
    ["Avg response length", fmtNum(r.avg) + " chars"],
    ["Longest response", fmtNum(r.longest) + " chars"],
    ["Largest conversation", lc ? `${fmtNum(lc.messages)} msgs · ${fmtChars(lc.chars)} chars` : "—"],
  ];
  let html = `<table><tbody>${rows
    .map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`)
    .join("")}</tbody></table>`;
  if (lc) html += `<div style="color:var(--muted);font-size:11px;margin-top:8px">Largest: ${shorten(lc.project)}${lc.git_branch ? " · " + lc.git_branch : ""}</div>`;
  $("textstats").innerHTML = html;
}

function renderTimeBreakdown(d) {
  const total = d.total_ms || 1;
  const top = d.by_project.slice(0, 10);
  const rows = top
    .map((x) => {
      const pct = (x.share * 100).toFixed(1);
      return `<tr>
        <td title="${x.project}">${shorten(x.project)}</td>
        <td style="width:45%"><div style="background:var(--accent);height:10px;border-radius:3px;width:${Math.max(x.share * 100, 1)}%"></div></td>
        <td class="num">${pct}%</td>
        <td class="num">${fmtDur(x.ms)}</td>
      </tr>`;
    })
    .join("");
  $("timebreakdown").innerHTML =
    `<div style="color:var(--muted);font-size:12px;margin-bottom:8px">Total active: <b style="color:var(--text)">${fmtDur(total)}</b></div>` +
    `<table><tbody>${rows}</tbody></table>`;
}

async function loadAll() {
  const bucket = $("bucket").value;
  const dim = $("dim").value;
  const sessLimit = Number($("sessLimit").value);
  const [s, ts, models, dims, hm, sessions, text, tb, bot, sub, comp, tools, stops, cmds, files] = await Promise.all([
    getJSON("/api/summary"),
    getJSON("/api/timeseries", { bucket }),
    getJSON("/api/by", { dim: "model" }),
    getJSON("/api/by", { dim }),
    getJSON("/api/heatmap"),
    getJSON("/api/sessions", { limit: sessLimit }),
    getJSON("/api/textstats"),
    getJSON("/api/timebreakdown"),
    getJSON("/api/botvshuman"),
    getJSON("/api/subagents"),
    getJSON("/api/compactions", { limit: 20 }),
    getJSON("/api/tools"),
    getJSON("/api/stopreasons"),
    getJSON("/api/commands", { limit: 15 }),
    getJSON("/api/files", { limit: 25 }),
  ]);
  renderCards(s);
  renderTimeCharts(ts);
  renderModel(models);
  renderDim(dims, dim);
  renderTextStats(text);
  renderTimeBreakdown(tb);
  renderBotVsHuman(bot);
  renderSubagents(sub);
  renderCompactions(comp);
  renderStopReasons(stops);
  renderTools(tools);
  renderCommands(cmds);
  renderFiles(files);
  renderHeatmap(hm);
  renderSessions(sessions, sessLimit === 0);
}

// reload only the sessions table (used by the row-count selector)
async function loadSessions() {
  const sessLimit = Number($("sessLimit").value);
  const sessions = await getJSON("/api/sessions", { limit: sessLimit });
  renderSessions(sessions, sessLimit === 0);
}

async function runAsk() {
  const q = $("askInput").value.trim();
  if (!q) return;
  const btn = $("askBtn"), box = $("askAnswer");
  btn.disabled = true;
  btn.textContent = "Thinking…";
  box.hidden = false;
  box.className = "askanswer";
  box.textContent = "Asking Claude… (this uses your Claude Code login and may take a few seconds)";
  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: q }),
    }).then((r) => r.json());
    if (res.error) {
      box.className = "askanswer err";
      box.textContent = res.error;
    } else {
      const meta = [];
      if (res.usage) meta.push(`${fmtTok(res.usage.input_tokens)} in / ${fmtTok(res.usage.output_tokens)} out`);
      if (res.cost_usd != null) meta.push(`${fmtUsd(res.cost_usd)} this query`);
      box.innerHTML = "";
      const ans = document.createElement("div");
      ans.textContent = res.answer || "(no answer)";
      box.appendChild(ans);
      if (meta.length) {
        const m = document.createElement("div");
        m.className = "meta";
        m.textContent = meta.join(" · ");
        box.appendChild(m);
      }
    }
  } catch (e) {
    box.className = "askanswer err";
    box.textContent = "Request failed: " + e;
  } finally {
    btn.disabled = false;
    btn.textContent = "Ask Claude";
  }
}

async function init() {
  const meta = await fetch("/api/meta").then((r) => r.json());
  if (meta.min_ts) {
    $("from").value = new Date(meta.min_ts).toISOString().slice(0, 10);
    $("to").value = new Date(meta.max_ts).toISOString().slice(0, 10);
  }
  $("meta").textContent = `${fmtNum(meta.total_events)} events · ${meta.models.length} models · ${meta.projects.length} projects`;
  ["from", "to", "bucket", "dim"].forEach((id) => $(id).addEventListener("change", loadAll));
  $("sessLimit").addEventListener("change", loadSessions);
  $("askBtn").addEventListener("click", runAsk);
  $("askInput").addEventListener("keydown", (e) => { if (e.key === "Enter") runAsk(); });
  $("compactions").addEventListener("click", (e) => {
    const row = e.target.closest(".crow");
    if (row && row.dataset.uuid) showCompactionDetail(row.dataset.uuid);
  });
  $("sessions").addEventListener("click", (e) => {
    const row = e.target.closest(".crow");
    if (row && row.dataset.sid) showSessionDetail(row.dataset.sid);
  });
  $("refresh").addEventListener("click", async () => {
    $("refresh").textContent = "Ingesting…";
    await fetch("/api/ingest", { method: "POST" });
    await init();
    $("refresh").textContent = "Re-ingest";
  });
  await loadAll();
}

init();
