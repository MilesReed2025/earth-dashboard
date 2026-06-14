// EARTH — backend proxy + config server.
// Serves Dashboard.html, proxies service API calls (secrets stay server-side),
// and owns earth.yaml as the single source of truth — read/written via the
// eemeli/yaml Document API so comments, ordering and anchors survive edits.
//
//   npm install
//   node server.mjs            # or: npm run dev (auto-restart on change)
//
// Endpoints:
//   GET  /                  → Dashboard.html
//   GET  /health            → liveness + loaded adapters
//   GET  /api/config        → earth.yaml parsed to JSON (env-var secrets NOT resolved — they never reach the browser)
//   POST /api/config        → JSON body merged into the YAML document, comments preserved
//   GET  /api/config/raw    → raw YAML text
//   POST /api/config/raw    → raw YAML text (validated, atomic write)
//   GET  /api/services      → [{ key, label, enabled }]
//   GET  /api/sysinfo       → host CPU/RAM/disk/uptime via Node os module (no Glances needed)
//   GET  /api/tmdb/trending        → TMDB trending movies this week
//   GET  /api/tmdb/now-playing     → now playing in cinemas (GB)
//   GET  /api/tmdb/upcoming        → upcoming releases (GB)
//   GET  /api/tmdb/genres          → movie genre id→name list
//   GET  /api/tmdb/movie/:id       → full movie detail with cast + trailers
//   GET  /api/tmdb/tv/trending     → trending TV shows this week
//   GET  /api/tmdb/tv/popular      → popular TV shows
//   GET  /api/tmdb/tv/on-air       → currently airing TV shows
//   GET  /api/tmdb/tv/genres       → TV genre id→name list
//   GET  /api/tmdb/tv/:id          → full TV show detail with cast + trailers
//   GET  /api/tmdb-status          → { configured: bool } — token check (no secret exposed)
//   POST /api/set-tmdb-token       → { token } — writes TMDB_TOKEN to .env, hot-reloads
//   GET  /api/feed?url=     → RSS/Atom/YouTube XML proxy (cached, no third-party)
//   POST /api/llm           → Mistral chat proxy (MISTRAL_KEY stays server-side)
//   GET  /api/:service      → adapter stats
//   WS   /ws                → { type: 'config', payload } pushed on file change

import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import fs from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { parseDocument, parse } from "yaml";
import chokidar from "chokidar";
import { WebSocketServer } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(here, "earth.yaml");
const HTML_PATH = join(here, "Dashboard.html");

/* ── .env loader — keeps secrets (MISTRAL_KEY etc.) out of the HTML ────── */
try {
  for (const line of (await readFile(join(here, ".env"), "utf8")).split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
} catch { /* no .env — fine */ }

const { PORT = "8787", CORS_ORIGIN = "*", RESPONSE_TTL = "15000", FEED_TTL = "300000" } = process.env;

/* ── tiny TTL cache (shared with adapters) ─────────────────────────────── */
const cacheStore = new Map();
export function cached(key, ttl, fn) {
  const hit = cacheStore.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then((v) => {
    cacheStore.set(key, { value: v, exp: Date.now() + ttl });
    return v;
  });
}

/* ── HTTP helper handed to adapters ────────────────────────────────────── */
function makeHttp() {
  function build(url, params) {
    const u = new URL(url);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u;
  }
  async function json(url, { params, headers, method = "GET", body, cookie } = {}) {
    const h = { Accept: "application/json", ...(headers || {}) };
    if (cookie) h.Cookie = cookie;
    const r = await fetch(build(url, params), { method, headers: h, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`${new URL(url).pathname} → HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r.text();
  }
  async function raw(url, { params, ...opts } = {}) {
    return fetch(build(url, params), { signal: AbortSignal.timeout(10_000), ...opts });
  }
  return { json, raw };
}
const http = makeHttp();

/* ── adapter auto-discovery: every adapters/*.mjs with { key, fetch } ──── */
async function loadAdapters() {
  const dir = join(here, "adapters");
  const map = new Map();
  // skip dotfiles — macOS SMB shares scatter "._*" AppleDouble files around
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".mjs") && !f.startsWith("."))) {
    const mod = await import(pathToFileURL(join(dir, f)).href);
    const a = mod.default;
    if (a?.key && typeof a.fetch === "function") map.set(a.key, a);
    else console.warn(`skipping adapters/${f}: missing key or fetch()`);
  }
  return map;
}
const adapters = await loadAdapters();

/* ── config: env-var resolution (server-side only) ─────────────────────── */
const resolveEnv = (v) =>
  typeof v === "string" ? v.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, n) => process.env[n] ?? "") : v;

async function readConfigText() {
  return readFile(CONFIG_PATH, "utf8");
}
async function readConfigJson() {
  // merge:true resolves <<: *anchor merge keys (documented yaml gotcha)
  return parse(await readConfigText(), { merge: true }) ?? {};
}

// Adapter credentials: env vars win (reference convention <KEY>_URL/_KEY/...),
// falling back to the matching service entry in earth.yaml (with ${ENV} refs
// resolved here, server-side — they are never sent to the browser).
async function serviceCfgFor(key) {
  const U = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const e = process.env;
  let svc = {};
  try {
    const cfg = await readConfigJson();
    // Check services[] first, then top-level key (e.g. cfg.glances for adapter 'glances')
    svc = (cfg.services || []).find((s) => (s.adapter || s.logo) === key)
       || cfg[key]
       || {};
  } catch { /* config unreadable — env-only */ }
  return {
    url: e[`${U}_URL`] || resolveEnv(svc.url),
    key: e[`${U}_KEY`] || e[`${U}_TOKEN`] || resolveEnv(svc.apiKey || svc.key),
    user: e[`${U}_USER`] || resolveEnv(svc.user),
    pass: e[`${U}_PASS`] || resolveEnv(svc.pass),
  };
}

/* ── comment-preserving JSON → YAML merge ──────────────────────────────── */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function mergeIntoDoc(doc, value, path = []) {
  const current = doc.getIn(path);
  const currentJs = current && typeof current.toJSON === "function" ? current.toJSON() : current;

  if (deepEq(currentJs, value)) return; // untouched → comments fully preserved

  if (isObj(value) && isObj(currentJs)) {
    for (const [k, v] of Object.entries(value)) mergeIntoDoc(doc, v, [...path, k]);
    for (const k of Object.keys(currentJs)) {
      if (!(k in value)) doc.deleteIn([...path, k]);
    }
    return;
  }
  if (Array.isArray(value) && Array.isArray(currentJs) && value.length === currentJs.length) {
    // same length → merge item-by-item so untouched items keep their comments
    value.forEach((v, i) => mergeIntoDoc(doc, v, [...path, i]));
    return;
  }
  // scalar change, type change, or array resize → replace the node
  doc.setIn(path, doc.createNode(value));
}

async function writeConfigAtomic(text) {
  // When earth.yaml is a bind-mounted file in Docker, rename() across the
  // overlay→host boundary fails with EXDEV. Write directly instead.
  await writeFile(CONFIG_PATH, text, "utf8");
}

/* ── app ───────────────────────────────────────────────────────────────── */
const app = new Hono();
app.use("*", cors({ origin: CORS_ORIGIN }));

app.get("/", async (c) => {
  const html = await readFile(HTML_PATH, "utf8");
  return c.html(html);
});

// Demo mode — same UI, all /api/* calls intercepted with realistic fake data
// No secrets, no real services needed. Share this URL to show off the dashboard.
app.get("/demo", async (c) => {
  const html = (await readFile(HTML_PATH, "utf8")).replace(
    "</head>",
    `<script>window.EARTH_DEMO=true;</script>\n</head>`
  );
  return c.html(html);
});

app.get("/health", (c) =>
  c.json({ ok: true, service: "earth-dashboard", adapters: [...adapters.keys()] }));

app.get("/api/config", async (c) => {
  try {
    return c.json(await readConfigJson());
  } catch (e) {
    return c.json({ error: `config unreadable: ${e.message}` }, 500);
  }
});

app.post("/api/config", async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: "body must be JSON" }, 400); }
  try {
    const doc = parseDocument(await readConfigText());
    if (doc.errors.length) return c.json({ error: "existing YAML has parse errors; fix it via /api/config/raw" }, 409);
    mergeIntoDoc(doc, body);
    const out = doc.toString();
    parse(out, { merge: true }); // sanity: never write something we can't read back
    await writeConfigAtomic(out);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e.message || e) }, 500);
  }
});

app.get("/api/config/raw", async (c) => {
  try {
    return c.text(await readConfigText());
  } catch (e) {
    return c.text(`# config unreadable: ${e.message}`, 500);
  }
});

app.post("/api/config/raw", async (c) => {
  const text = await c.req.text();
  try {
    const doc = parseDocument(text);
    if (doc.errors.length) throw new Error(doc.errors[0].message);
    parse(text, { merge: true });
  } catch (e) {
    return c.json({ error: `invalid YAML: ${String(e.message || e)}` }, 422);
  }
  await writeConfigAtomic(text);
  return c.json({ ok: true });
});

app.get("/api/services", async (c) => {
  const out = [];
  for (const a of adapters.values()) {
    const cfg = await serviceCfgFor(a.key);
    out.push({ key: a.key, label: a.label, enabled: Boolean(cfg.url) });
  }
  return c.json(out);
});

/* ── RSS / Atom / YouTube feed proxy ───────────────────────────────────────
   The browser previously round-tripped every feed through api.rss2json.com
   (slow, rate-limited third party). Fetch directly here instead, cache the
   XML for FEED_TTL ms, and let the client parse it. */
app.get("/api/feed", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url query param required" }, 400);
  let u;
  try { u = new URL(url); } catch { return c.json({ error: "invalid url" }, 400); }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return c.json({ error: "http(s) URLs only" }, 400);
  if (c.req.query("fresh") === "1") cacheStore.delete(`feed:${u.href}`); // manual refresh
  try {
    const xml = await cached(`feed:${u.href}`, Number(FEED_TTL), async () => {
      const isYouTube = u.hostname.includes("youtube.com");
      const r = await fetch(u, {
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7",
          "Accept-Language": "en-GB,en;q=0.9",
          "Cache-Control": "no-cache",
          // YouTube requires a consent cookie to serve RSS from server IPs
          ...(isYouTube ? { Cookie: "SOCS=CAESEwgDEgk3NjYxOTU3NzIaAmVuIAEaBgiAiNO2Bg; CONSENT=YES+cb" } : {}),
        },
      });
      if (!r.ok) throw new Error(`feed → HTTP ${r.status}`);
      return r.text();
    });
    return c.text(xml, 200, { "Content-Type": "text/xml; charset=utf-8" });
  } catch (e) {
    const msg = String(e?.message || e);
    console.warn(`[feed] ${url} → ${msg}`);
    return c.json({ error: msg }, 502);
  }
});

/* ── Mistral chat proxy — the API key never reaches the browser ─────────── */
app.post("/api/llm", async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: "body must be JSON" }, 400); }
  const provider = (body.provider || "mistral").toLowerCase();
  const { messages, max_tokens = 400, model } = body;
  // Normalise any response to OpenAI shape
  const ok = (text) => ({ choices: [{ message: { content: text } }] });
  try {
    if (provider === "mistral") {
      const key = process.env.MISTRAL_KEY;
      if (!key) return c.json({ error: "MISTRAL_KEY not set in .env" }, 503);
      const m = model || "mistral-small-latest";
      const r = await fetch("https://api.mistral.ai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: m, messages, max_tokens }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return c.json({ error: j?.message || `Mistral → HTTP ${r.status}` }, 502);
      return c.json(j);

    } else if (provider === "openai") {
      const key = process.env.OPENAI_KEY;
      if (!key) return c.json({ error: "OPENAI_KEY not set in .env" }, 503);
      const m = model || "gpt-4o-mini";
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: m, messages, max_tokens }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return c.json({ error: j?.error?.message || `OpenAI → HTTP ${r.status}` }, 502);
      return c.json(j);

    } else if (provider === "anthropic") {
      const key = process.env.ANTHROPIC_KEY;
      if (!key) return c.json({ error: "ANTHROPIC_KEY not set in .env" }, 503);
      const m = model || "claude-haiku-4-5-20251001";
      // Anthropic uses a different messages format — system must be a top-level param
      const sysMsg = messages.find(msg => msg.role === "system");
      const userMsgs = messages.filter(msg => msg.role !== "system");
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: m,
          max_tokens,
          ...(sysMsg ? { system: sysMsg.content } : {}),
          messages: userMsgs.map(msg => ({ role: msg.role === "assistant" ? "assistant" : "user", content: msg.content })),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return c.json({ error: j?.error?.message || `Anthropic → HTTP ${r.status}` }, 502);
      return c.json(ok(j.content?.[0]?.text || ""));

    } else if (provider === "gemini") {
      const key = process.env.GEMINI_KEY;
      if (!key) return c.json({ error: "GEMINI_KEY not set in .env" }, 503);
      const m = model || "gemini-2.0-flash-lite";
      const contents = messages
        .filter(msg => msg.role !== "system")
        .map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] }));
      const sysMsg = messages.find(msg => msg.role === "system");
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          ...(sysMsg ? { systemInstruction: { parts: [{ text: sysMsg.content }] } } : {}),
          generationConfig: { maxOutputTokens: max_tokens },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return c.json({ error: j?.error?.message || `Gemini → HTTP ${r.status}` }, 502);
      return c.json(ok(j.candidates?.[0]?.content?.parts?.[0]?.text || ""));

    } else {
      return c.json({ error: `Unknown provider: ${provider}` }, 400);
    }
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 502);
  }
});

app.get("/api/ai-status", (c) => c.json({
  mistral:   !!process.env.MISTRAL_KEY,
  openai:    !!process.env.OPENAI_KEY,
  anthropic: !!process.env.ANTHROPIC_KEY,
  gemini:    !!process.env.GEMINI_KEY,
}));

// External service status — proxies Atlassian Statuspage /api/v2/status.json
// or any URL that returns { status: { indicator, description } }
// Cached 3 minutes so hammering the dashboard doesn't spam status pages.
/* ── /api/sysinfo — host stats via Node os module (no Glances needed) ───── */

// CPU % via core-time deltas (much more accurate than load-average %)
let _prevCpuTimes = null;
function cpuPercent() {
  const cpus = os.cpus();
  const curr = cpus.reduce((a, c) => {
    const t = c.times;
    a.idle  += t.idle;
    a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  if (!_prevCpuTimes) { _prevCpuTimes = curr; return null; }
  const idleDelta  = curr.idle  - _prevCpuTimes.idle;
  const totalDelta = curr.total - _prevCpuTimes.total;
  _prevCpuTimes = curr;
  return totalDelta > 0 ? Math.min((1 - idleDelta / totalDelta) * 100, 100) : 0;
}

// Network I/O via /proc/net/dev (Linux only)
let _prevNet = null;
let _prevNetTime = null;
function netIO() {
  try {
    const raw  = fs.readFileSync("/proc/net/dev", "utf8");
    const now  = Date.now();
    const lines = raw.trim().split("\n").slice(2); // skip 2 header lines
    let rxBytes = 0, txBytes = 0;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const iface = parts[0].replace(":", "");
      if (iface === "lo") continue; // skip loopback
      rxBytes += parseInt(parts[1])  || 0;
      txBytes += parseInt(parts[9])  || 0;
    }
    if (_prevNet && _prevNetTime) {
      const dt = (now - _prevNetTime) / 1000; // seconds
      const rxRate = (rxBytes - _prevNet.rx) / dt;
      const txRate = (txBytes - _prevNet.tx) / dt;
      _prevNet = { rx: rxBytes, tx: txBytes };
      _prevNetTime = now;
      return { rx: Math.max(0, rxRate), tx: Math.max(0, txRate) };
    }
    _prevNet = { rx: rxBytes, tx: txBytes };
    _prevNetTime = now;
    return null;
  } catch { return null; }
}

app.get("/api/sysinfo", async (c) => {
  try {
    const data = await cached("sysinfo", 5_000, async () => {
      const totalMem = os.totalmem();
      const freeMem  = os.freemem();
      const usedMem  = totalMem - freeMem;
      const memPct   = (usedMem / totalMem) * 100;
      const cpuPct   = cpuPercent();
      const loadAvg  = os.loadavg();
      const cpuInfo  = os.cpus();

      const stats = [];

      // CPU — use measured % if available, fall back to load-derived
      const cpuVal = cpuPct !== null ? cpuPct : Math.min((loadAvg[0] / cpuInfo.length) * 100, 100);
      stats.push({
        key: "cpu", label: "CPU", value: cpuVal.toFixed(1), format: "percent", bar: true,
        sub: `${cpuInfo.length} cores · ${(cpuInfo[0]?.speed / 1000).toFixed(1)} GHz`,
      });

      // RAM
      stats.push({
        key: "mem", label: "RAM", value: memPct.toFixed(1), format: "percent", bar: true,
        sub: `${fmtSI(usedMem)} / ${fmtSI(totalMem)}`,
      });

      // Disk — enumerate all real mounts via df -kP, filtering out known virtual filesystems
      // Uses exclusion list so ZFS pools, LVM, RAID (/dev/md*), and CIFS/NFS are all included.
      const VIRTUAL_FS = new Set([
        "tmpfs","devtmpfs","sysfs","proc","devpts","hugetlbfs","securityfs",
        "cgroup","cgroup2","pstore","debugfs","mqueue","tracefs","fusectl",
        "efivarfs","configfs","ramfs","nsfs","rpc_pipefs","overlay","overlayfs",
        "bindfs","squashfs","udev","autofs","binfmt_misc","sunrpc",
      ]);
      // Mount prefixes that are always OS internals (skip even if size is large)
      const SKIP_MOUNTS = ["/boot", "/sys", "/proc", "/dev", "/run"];
      try {
        const dfOut = execSync("df -kP", { encoding: "utf8", timeout: 2000 });
        const rows  = dfOut.trim().split("\n").slice(1); // drop header
        const seen  = new Set();
        let diskIdx = 0;
        for (const row of rows) {
          const cols = row.trim().split(/\s+/);
          // POSIX df cols: Filesystem  1024-blocks  Used  Available  Capacity  Mounted-on
          if (cols.length < 6) continue;
          const fs    = cols[0];
          const mount = cols[cols.length - 1];
          // Skip known virtual filesystem types
          if (VIRTUAL_FS.has(fs)) continue;
          // Skip internal OS mount points
          if (SKIP_MOUNTS.some(p => mount === p || mount.startsWith(p + "/"))) continue;
          // Deduplicate same device appearing at multiple bind-mounts
          if (seen.has(fs)) continue;
          seen.add(fs);
          const size = parseInt(cols[1]) * 1024;
          const used = parseInt(cols[2]) * 1024;
          const pct  = parseInt(cols[4]); // Capacity column e.g. "47%"
          // Skip zero-size or tiny (<100 MB) filesystems
          if (!size || isNaN(size) || size < 100 * 1024 * 1024) continue;
          const key   = diskIdx === 0 ? "disk" : `disk_${diskIdx}`;
          const label = `Disk ${mount}`;
          stats.push({
            key, label,
            value: String(isNaN(pct) ? ((used / size) * 100).toFixed(1) : pct),
            format: "percent", bar: true,
            sub: `${fmtSI(used)} / ${fmtSI(size)}`,
          });
          diskIdx++;
        }
      } catch { /* df not available */ }

      // Network I/O (Linux only — silently skipped on macOS/other)
      const net = netIO();
      if (net) {
        stats.push({ key: "net_tx", label: "Net ↑", value: net.tx, format: "speed" });
        stats.push({ key: "net_rx", label: "Net ↓", value: net.rx, format: "speed" });
      }

      // Load average — formatted with labels
      stats.push({
        key: "load", label: "Load avg",
        value: `${loadAvg[0].toFixed(2)} · ${loadAvg[1].toFixed(2)} · ${loadAvg[2].toFixed(2)}`,
        sub: "1m · 5m · 15m",
        format: "text",
      });

      // Uptime
      const sec  = os.uptime();
      const days = Math.floor(sec / 86400);
      const hrs  = Math.floor((sec % 86400) / 3600);
      const mins = Math.floor((sec % 3600) / 60);
      const uptimeStr = [days && `${days}d`, hrs && `${hrs}h`, `${mins}m`].filter(Boolean).join(" ");
      stats.push({ key: "uptime", label: "Uptime", value: uptimeStr, format: "text" });

      return { status: "ok", stats, source: "node" };
    });
    return c.json(data);
  } catch (e) {
    return c.json({ status: "error", error: String(e?.message || e), stats: [] });
  }
});

function fmtSI(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}

/* ── Home Assistant proxy routes ───────────────────────────────────────────── */
{
  const HA_URL   = () => process.env.HA_URL?.replace(/\/+$/, "");
  const HA_TOKEN = () => process.env.HA_TOKEN;
  const haHdr    = () => ({ Authorization: `Bearer ${HA_TOKEN()}`, "Content-Type": "application/json" });
  const noHA     = c  => c.json({ error: "HA_URL or HA_TOKEN not configured" }, 503);

  // GET /api/ha/states?domain=automation|scene|script
  app.get("/api/ha/states", async (c) => {
    if (!HA_URL() || !HA_TOKEN()) return noHA(c);
    const domain = c.req.query("domain") || "";
    return c.json(await cached(`ha:states:${domain}`, 15_000, async () => {
      const r = await fetch(`${HA_URL()}/api/states`, { headers: haHdr() });
      if (!r.ok) throw new Error(`HA ${r.status}`);
      const states = await r.json();
      return domain ? states.filter(s => s.entity_id.startsWith(domain + ".")) : states;
    }));
  });

  // POST /api/ha/service  { domain, service, entity_id, data? }
  // Clears relevant cache entry after call so next poll sees fresh state.
  app.post("/api/ha/service", async (c) => {
    if (!HA_URL() || !HA_TOKEN()) return noHA(c);
    const { domain, service, entity_id, data: svcData } = await c.req.json();
    const body = { ...(entity_id ? { entity_id } : {}), ...(svcData || {}) };
    const r = await fetch(`${HA_URL()}/api/services/${domain}/${service}`, {
      method: "POST", headers: haHdr(), body: JSON.stringify(body),
    });
    // Bust caches so next poll is fresh
    ["automation", "scene", "script", ""].forEach(d => cacheStore.delete(`ha:states:${d}`));
    const text = await r.text();
    try { return c.json(JSON.parse(text)); } catch { return c.json({ ok: r.ok }); }
  });
}

/* ── TMDB discovery routes ──────────────────────────────────────────────────── */
{
  const TMDB = "https://api.themoviedb.org/3";
  const tmdbHdr = () => ({ Authorization: `Bearer ${process.env.TMDB_TOKEN}` });
  const tmdbGet = (path, params) =>
    http.json(`${TMDB}${path}`, { headers: tmdbHdr(), params });
  const noToken = (c) =>
    c.json({ error: "TMDB_TOKEN not configured — add it in Settings → Discover", results: [] }, 503);

  // ── Movies ──
  app.get("/api/tmdb/trending",    async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:trending", 1_800_000, () =>
      tmdbGet("/trending/movie/week", { language: "en-GB" })));
  });
  app.get("/api/tmdb/now-playing", async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:now-playing", 1_800_000, () =>
      tmdbGet("/movie/now_playing", { language: "en-GB", region: "GB" })));
  });
  app.get("/api/tmdb/upcoming",    async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:upcoming", 1_800_000, () =>
      tmdbGet("/movie/upcoming", { language: "en-GB", region: "GB" })));
  });
  app.get("/api/tmdb/genres",      async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:genres", 86_400_000, () =>
      tmdbGet("/genre/movie/list", { language: "en-GB" })));
  });
  app.get("/api/tmdb/movie/:id",   async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    const id = c.req.param("id");
    return c.json(await cached(`tmdb:movie:${id}`, 3_600_000, () =>
      tmdbGet(`/movie/${id}`, { language: "en-GB", append_to_response: "credits,videos" })));
  });

  // ── TV Shows ──
  app.get("/api/tmdb/tv/trending", async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:tv:trending", 1_800_000, () =>
      tmdbGet("/trending/tv/week", { language: "en-GB" })));
  });
  app.get("/api/tmdb/tv/popular",  async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:tv:popular", 1_800_000, () =>
      tmdbGet("/tv/popular", { language: "en-GB" })));
  });
  app.get("/api/tmdb/tv/on-air",   async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:tv:on-air", 1_800_000, () =>
      tmdbGet("/tv/on_the_air", { language: "en-GB" })));
  });
  app.get("/api/tmdb/tv/genres",   async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    return c.json(await cached("tmdb:tv:genres", 86_400_000, () =>
      tmdbGet("/genre/tv/list", { language: "en-GB" })));
  });
  app.get("/api/tmdb/tv/:id",      async (c) => {
    if (!process.env.TMDB_TOKEN) return noToken(c);
    const id = c.req.param("id");
    return c.json(await cached(`tmdb:tv:${id}`, 3_600_000, () =>
      tmdbGet(`/tv/${id}`, { language: "en-GB", append_to_response: "credits,videos" })));
  });

  // ── Token management ──
  app.get("/api/tmdb-status", (c) =>
    c.json({ configured: !!process.env.TMDB_TOKEN }));

  app.post("/api/set-tmdb-token", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const token = (body.token || '').trim();
    if (!token) return c.json({ error: 'token required' }, 400);
    // Update .env file
    const envPath = join(here, ".env");
    let content = '';
    try { content = fs.readFileSync(envPath, "utf8"); } catch { /* no .env yet */ }
    if (/^TMDB_TOKEN\s*=/m.test(content)) {
      content = content.replace(/^TMDB_TOKEN\s*=.*/m, `TMDB_TOKEN=${token}`);
    } else {
      content += (content.endsWith('\n') || !content ? '' : '\n') + `TMDB_TOKEN=${token}\n`;
    }
    fs.writeFileSync(envPath, content, "utf8");
    // Apply immediately without restart
    process.env.TMDB_TOKEN = token;
    // Bust TMDB cache so first fetch uses new token
    for (const k of cacheStore.keys()) {
      if (k.startsWith('tmdb:')) cacheStore.delete(k);
    }
    return c.json({ ok: true });
  });
}

/* ── Last.fm music charts ────────────────────────────────────────────────── */
{
  const LASTFM = "https://ws.audioscrobbler.com/2.0";
  const lfmGet  = (method, extra = {}) =>
    http.json(LASTFM, { params: { method, api_key: process.env.LASTFM_KEY, format: "json", ...extra } });
  const noKey   = (c) =>
    c.json({ error: "LASTFM_KEY not configured — add it in Settings → Discover", results: [] }, 503);

  const lfmRoute = async (c, cacheKey, ttl, fn) => {
    if (!process.env.LASTFM_KEY) return noKey(c);
    try {
      return c.json(await cached(cacheKey, ttl, fn));
    } catch (e) {
      return c.json({ error: String(e?.message || e) }, 502);
    }
  };

  // Deezer API — free, no key, returns artwork reliably
  const deezerTrackImg = async (artist, track) => {
    try {
      const data = await http.json("https://api.deezer.com/search/track", {
        params: { q: `artist:"${artist}" track:"${track}"`, limit: 1 },
      });
      return data?.data?.[0]?.album?.cover_medium || null;
    } catch { return null; }
  };

  const deezerArtistImg = async (name) => {
    try {
      const data = await http.json("https://api.deezer.com/search/artist", {
        params: { q: name, limit: 1 },
      });
      return data?.data?.[0]?.picture_medium || null;
    } catch { return null; }
  };

  const enrichTracks = async (tracks) =>
    Promise.all(tracks.map(async (t) => ({
      ...t,
      _img: await deezerTrackImg(t.artist?.name || "", t.name),
    })));

  const enrichArtists = async (artists) =>
    Promise.all(artists.map(async (a) => ({
      ...a,
      _img: await deezerArtistImg(a.name),
    })));

  app.get("/api/lastfm/top-tracks",  (c) =>
    lfmRoute(c, "lfm:top-tracks",  3_600_000, async () => {
      const data = await lfmGet("chart.getTopTracks", { limit: 20 });
      const tracks = data?.tracks?.track || [];
      return { tracks: { track: await enrichTracks(tracks) } };
    }));

  app.get("/api/lastfm/top-artists", (c) =>
    lfmRoute(c, "lfm:top-artists", 3_600_000, async () => {
      const data = await lfmGet("chart.getTopArtists", { limit: 20 });
      const artists = data?.artists?.artist || [];
      return { artists: { artist: await enrichArtists(artists) } };
    }));
  app.get("/api/lastfm/album-info",  async (c) => {
    const artist = c.req.query("artist"), album = c.req.query("album");
    if (!artist || !album) return c.json({ error: "artist + album required" }, 400);
    return lfmRoute(c, `lfm:album:${artist}::${album}`, 86_400_000, () =>
      lfmGet("album.getInfo", { artist, album, autocorrect: 1 }));
  });

  app.get("/api/lastfm-status", (c) =>
    c.json({ configured: !!process.env.LASTFM_KEY }));

  app.post("/api/set-lastfm-key", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const key  = (body.key || "").trim();
    if (!key) return c.json({ error: "key required" }, 400);
    const envPath = join(here, ".env");
    let content = "";
    try { content = fs.readFileSync(envPath, "utf8"); } catch {}
    if (/^LASTFM_KEY\s*=/m.test(content)) {
      content = content.replace(/^LASTFM_KEY\s*=.*/m, `LASTFM_KEY=${key}`);
    } else {
      content += (content.endsWith("\n") || !content ? "" : "\n") + `LASTFM_KEY=${key}\n`;
    }
    fs.writeFileSync(envPath, content, "utf8");
    process.env.LASTFM_KEY = key;
    for (const k of cacheStore.keys()) { if (k.startsWith("lfm:")) cacheStore.delete(k); }
    return c.json({ ok: true });
  });
}

/* ── ONBOARD — bulk first-boot setup ────────────────────────────────────── */
app.get("/api/mistral-status", (c) =>
  c.json({ configured: !!process.env.MISTRAL_KEY }));

app.post("/api/onboard", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const pairs = [
    ["MISTRAL_KEY",       (body.mistralKey  || "").trim()],
    ["TMDB_TOKEN",        (body.tmdbToken   || "").trim()],
    ["LASTFM_KEY",        (body.lastfmKey   || "").trim()],
    ["CALENDAR_ICS_URL",  (body.calendarUrl || "").trim()],
  ].filter(([, v]) => v);

  if (!pairs.length) return c.json({ ok: true });

  const envPath = join(here, ".env");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf8"); } catch {}

  for (const [key, val] of pairs) {
    if (new RegExp(`^${key}\\s*=`, "m").test(content)) {
      content = content.replace(new RegExp(`^${key}\\s*=.*`, "m"), `${key}=${val}`);
    } else {
      content += (content.endsWith("\n") || !content ? "" : "\n") + `${key}=${val}\n`;
    }
    process.env[key] = val;
  }

  fs.writeFileSync(envPath, content, "utf8");
  // Bust relevant caches so new keys take effect immediately
  cacheStore.clear();
  return c.json({ ok: true });
});

/* ── CALENDAR (ICS) ─────────────────────────────────────────────────────── */
function parseICS(text) {
  const events = [];
  // Unfold continuation lines (lines starting with space/tab)
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split(/BEGIN:VEVENT\r?\n?/i).slice(1);
  for (const block of blocks) {
    const get = (key) => {
      const m = block.match(new RegExp(`(?:^|\\r?\\n)${key}(?:;[^:]*)?:([^\\r\\n]*)`, 'i'));
      return m ? m[1].replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\t/g, '\t').trim() : '';
    };
    const summary = get('SUMMARY');
    if (!summary) continue;
    const dtStartRaw = (() => { const m = block.match(/(?:^|\r?\n)DTSTART(?:;[^:]*)?:([^\r\n]*)/i); return m ? m[1].trim() : ''; })();
    const dtEndRaw   = (() => { const m = block.match(/(?:^|\r?\n)DTEND(?:;[^:]*)?:([^\r\n]*)/i);   return m ? m[1].trim() : ''; })();
    const parseDate  = (s) => {
      if (!s) return null;
      if (/^\d{8}$/.test(s)) return new Date(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8));
      const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
      if (m) return m[7] ? new Date(Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]))
                         : new Date(+m[1],+m[2]-1,+m[3],+m[4],+m[5],+m[6]);
      return null;
    };
    const start = parseDate(dtStartRaw);
    const end   = parseDate(dtEndRaw);
    const allDay = /^\d{8}$/.test(dtStartRaw);
    const location = get('LOCATION');
    if (start) events.push({ summary, start, end, allDay, location });
  }
  return events;
}

function eventsForDate(events, targetDate) {
  const ref = targetDate ? new Date(targetDate + 'T00:00:00') : new Date();
  const sod  = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const eod  = new Date(sod); eod.setDate(eod.getDate() + 1);
  return events
    .filter(e => {
      const s = new Date(e.start.getFullYear(), e.start.getMonth(), e.start.getDate());
      const en = e.end ? new Date(e.end.getFullYear(), e.end.getMonth(), e.end.getDate()) : s;
      return s < eod && en >= sod;
    })
    .sort((a, b) => a.start - b.start)
    .map(e => ({
      summary: e.summary,
      start: e.start.toISOString(),
      end: e.end ? e.end.toISOString() : null,
      allDay: e.allDay,
      location: e.location,
    }));
}

app.get("/api/calendar/today", async (c) => {
  const url = process.env.CALENDAR_ICS_URL;
  if (!url) return c.json({ error: "CALENDAR_ICS_URL not configured — add it in Settings → Integrations", events: [] }, 503);
  const date = (c.req.query('date') || '').match(/^\d{4}-\d{2}-\d{2}$/) ? c.req.query('date') : null;
  try {
    // Cache the raw parsed events for 5 min, then filter by requested date
    const allEvents = await cached("cal:parsed", 300_000, async () => {
      const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`ICS fetch → HTTP ${r.status}`);
      return parseICS(await r.text());
    });
    return c.json({ events: eventsForDate(allEvents, date) });
  } catch (e) {
    return c.json({ error: String(e?.message || e), events: [] }, 502);
  }
});
app.get("/api/calendar-status", (c) => c.json({ configured: !!process.env.CALENDAR_ICS_URL }));
app.post("/api/set-calendar-url", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const url  = (body.url || "").trim();
  if (!url) return c.json({ error: "url required" }, 400);
  const envPath = join(here, ".env");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf8"); } catch {}
  if (/^CALENDAR_ICS_URL\s*=/m.test(content)) content = content.replace(/^CALENDAR_ICS_URL\s*=.*/m, `CALENDAR_ICS_URL=${url}`);
  else content += (content.endsWith("\n") || !content ? "" : "\n") + `CALENDAR_ICS_URL=${url}\n`;
  fs.writeFileSync(envPath, content, "utf8");
  process.env.CALENDAR_ICS_URL = url;
  cacheStore.delete("cal:today");
  return c.json({ ok: true });
});

/* ── GMAIL (Atom feed via HTTP Basic Auth) ──────────────────────────────── */
function parseGmailAtom(xml) {
  const entries = [];
  const blocks  = xml.split(/<entry[^>]*>/i).slice(1);
  for (const block of blocks) {
    const getTag = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
    };
    const subject = getTag('title');
    if (!subject) continue;
    entries.push({
      subject,
      summary:     getTag('summary'),
      from:        getTag('name') || getTag('email') || '',
      fromAddress: getTag('email') || '',
      date:        getTag('issued') || getTag('modified') || null,
    });
  }
  return entries.slice(0, 10);
}

app.get("/api/gmail/recent", async (c) => {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASS)
    return c.json({ error: "Gmail not configured — add credentials in Settings → Integrations", emails: [] }, 503);
  try {
    const emails = await cached("gmail:recent", 120_000, async () => {
      const auth = Buffer.from(`${process.env.GMAIL_USER}:${process.env.GMAIL_APP_PASS}`).toString("base64");
      const r    = await fetch("https://mail.google.com/mail/feed/atom", {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`Gmail Atom → HTTP ${r.status} (check credentials)`);
      return parseGmailAtom(await r.text());
    });
    return c.json({ emails });
  } catch (e) {
    return c.json({ error: String(e?.message || e), emails: [] }, 502);
  }
});
app.get("/api/gmail-status", (c) => c.json({ configured: !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASS) }));
app.post("/api/set-gmail-creds", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const user = (body.user || "").trim();
  const pass = (body.pass || "").trim();
  if (!user || !pass) return c.json({ error: "user and pass required" }, 400);
  const envPath = join(here, ".env");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf8"); } catch {}
  const set = (k, v) => {
    if (new RegExp(`^${k}\\s*=`, "m").test(content)) content = content.replace(new RegExp(`^${k}\\s*=.*`, "m"), `${k}=${v}`);
    else content += (content.endsWith("\n") || !content ? "" : "\n") + `${k}=${v}\n`;
  };
  set("GMAIL_USER", user); set("GMAIL_APP_PASS", pass);
  fs.writeFileSync(envPath, content, "utf8");
  process.env.GMAIL_USER = user; process.env.GMAIL_APP_PASS = pass;
  cacheStore.delete("gmail:recent");
  return c.json({ ok: true });
});

/* ── GITHUB ─────────────────────────────────────────────────────────────── */
app.get("/api/github-status", (c) => c.json({ configured: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_USER) }));
app.post("/api/set-github-creds", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const token    = (body.token    || "").trim();
  const username = (body.username || "").trim();
  if (!token || !username) return c.json({ error: "token and username required" }, 400);
  const envPath = join(here, ".env");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf8"); } catch {}
  const set = (k, v) => {
    if (new RegExp(`^${k}\s*=`, "m").test(content)) content = content.replace(new RegExp(`^${k}\s*=.*`, "m"), `${k}=${v}`);
    else content += (content.endsWith("\n") || !content ? "" : "\n") + `${k}=${v}\n`;
  };
  set("GITHUB_TOKEN", token); set("GITHUB_USER", username);
  fs.writeFileSync(envPath, content, "utf8");
  process.env.GITHUB_TOKEN = token; process.env.GITHUB_USER = username;
  return c.json({ ok: true });
});

/* ── LAST.FM ─────────────────────────────────────────────────────────────── */
app.get("/api/lastfm-status", (c) => c.json({ configured: !!(process.env.LASTFM_KEY && process.env.LASTFM_USER) }));
app.post("/api/set-lastfm-creds", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const apiKey   = (body.apiKey   || "").trim();
  const username = (body.username || "").trim();
  if (!apiKey || !username) return c.json({ error: "apiKey and username required" }, 400);
  const envPath = join(here, ".env");
  let content = "";
  try { content = fs.readFileSync(envPath, "utf8"); } catch {}
  const set = (k, v) => {
    if (new RegExp(`^${k}\s*=`, "m").test(content)) content = content.replace(new RegExp(`^${k}\s*=.*`, "m"), `${k}=${v}`);
    else content += (content.endsWith("\n") || !content ? "" : "\n") + `${k}=${v}\n`;
  };
  set("LASTFM_KEY", apiKey); set("LASTFM_USER", username);
  fs.writeFileSync(envPath, content, "utf8");
  process.env.LASTFM_KEY = apiKey; process.env.LASTFM_USER = username;
  return c.json({ ok: true });
});

/* ── SERVER-SIDE PROXY (for custom API widgets) ─────────────────────────── */
app.get("/api/proxy", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url param required" }, 400);
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return c.json({ ok: r.ok, status: r.status, data });
  } catch (e) {
    return c.json({ error: String(e?.message || e) }, 502);
  }
});

app.get("/api/df-debug", (c) => {
  try {
    const out = execSync("df -kP", { encoding: "utf8", timeout: 3000 });
    return c.text(out);
  } catch (e) {
    return c.text("error: " + e.message);
  }
});

app.get("/api/status-check", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url param required" }, 400);
  try {
    const data = await cached(`status:${url}`, 180_000, async () => {
      const r = await http.json(url);
      // Atlassian Statuspage format: { status: { indicator, description } }
      const ind = r?.status?.indicator || r?.indicator || "unknown";
      const desc = r?.status?.description || r?.description || "";
      return { indicator: ind, description: desc };
    });
    return c.json(data);
  } catch (e) {
    return c.json({ indicator: "unknown", description: String(e?.message || e) }, 200);
  }
});

app.get("/api/:service", async (c) => {
  const key = c.req.param("service");
  const a = adapters.get(key);
  if (!a) return c.json({ error: `unknown service "${key}"` }, 404);

  // If svcid is provided, resolve config for that specific service entry
  // (important for generic adapters like "ping" used by multiple services)
  const svcid = c.req.query("svcid");
  let cfg;
  if (svcid) {
    try {
      const parsed = await readConfigJson();
      const entry = (parsed.services || []).find(s => s.id === svcid);
      if (entry) {
        const U = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
        cfg = {
          url:  process.env[`${U}_URL`] || resolveEnv(entry.url),
          key:  process.env[`${U}_KEY`] || process.env[`${U}_TOKEN`] || resolveEnv(entry.apiKey || entry.key),
          user: process.env[`${U}_USER`] || resolveEnv(entry.user),
          pass: process.env[`${U}_PASS`] || resolveEnv(entry.pass),
        };
      }
    } catch { /* fall through to default */ }
  }
  if (!cfg) cfg = await serviceCfgFor(key);

  if (!cfg.url)
    return c.json({ service: key, label: a.label, status: "unconfigured",
      error: `${key} not configured — set ${key.toUpperCase()}_URL or a url in earth.yaml` }, 503);
  try {
    const cacheKey = svcid ? `resp:${key}:${svcid}` : `resp:${key}`;
    const data = await cached(cacheKey, Number(RESPONSE_TTL), async () => {
      const res = await a.fetch(cfg, { http, cached });
      return { service: a.key, label: a.label, status: res.status || "ok",
        stats: res.stats || [], generatedAt: new Date().toISOString() };
    });
    return c.json(data);
  } catch (e) {
    return c.json({ service: key, label: a.label, status: "error", error: String(e?.message || e) }, 502);
  }
});

/* ── serve + WebSocket config push ─────────────────────────────────────── */
const server = serve({ fetch: app.fetch, port: Number(PORT), createServer }, (info) =>
  console.log(`EARTH on http://localhost:${info.port} — adapters: ${[...adapters.keys()].join(", ")}`));

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url, "http://x").pathname !== "/ws") return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

async function broadcastConfig() {
  let payload;
  try { payload = await readConfigJson(); }
  catch (e) { payload = null; console.warn("config push skipped:", e.message); }
  if (!payload) return;
  const msg = JSON.stringify({ type: "config", payload });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

let debounce;
chokidar.watch(CONFIG_PATH, { ignoreInitial: true }).on("all", () => {
  clearTimeout(debounce);
  debounce = setTimeout(broadcastConfig, 150);
});

/* ── PROACTIVE ALERT ENGINE ─────────────────────────────────────────────────
   Polls services, disk, and downloads every 30 s.
   Pushes { type: "alert", payload: { level, title, body } } over WebSocket.
   Deduplicates: same key suppressed until it clears then re-fires.
────────────────────────────────────────────────────────────────────────────── */

function broadcastAlert(level, title, body) {
  const msg = JSON.stringify({ type: "alert", payload: { level, title, body } });
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
}

// Track known-bad state so we only alert on transitions, not every 30 s
const alertState = {
  downServices: new Set(),   // service ids currently down
  diskAlerted:  new Set(),   // disk labels already alerted at >85%
  knownDone:    new Set(),   // torrent hashes already reported as done
};

async function runAlerts() {
  let cfg;
  try { cfg = await readConfigJson(); } catch { return; }

  // ── 1. Service reachability ─────────────────────────────────────────────
  const services = cfg.services || [];
  for (const svc of services) {
    if (!svc.url || !svc.id) continue;
    try {
      const r = await fetch(svc.url, { signal: AbortSignal.timeout(4000), redirect: "follow" });
      if (r.ok || r.status < 500) {
        // Back online
        if (alertState.downServices.has(svc.id)) {
          alertState.downServices.delete(svc.id);
          broadcastAlert("info", `${svc.name} is back online`, svc.url);
        }
      } else throw new Error(`HTTP ${r.status}`);
    } catch {
      if (!alertState.downServices.has(svc.id)) {
        alertState.downServices.add(svc.id);
        broadcastAlert("error", `${svc.name} is unreachable`, `Could not connect to ${svc.url}`);
      }
    }
  }

  // ── 2. Disk usage via Glances ───────────────────────────────────────────
  const glancesUrl = cfg.glances?.url || process.env.GLANCES_URL;
  if (glancesUrl) {
    try {
      const res = await fetch(`${glancesUrl}/api/3/fs`, { signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        const disks = await res.json();
        for (const d of (Array.isArray(disks) ? disks : [])) {
          const pct = d.percent ?? ((d.used / d.size) * 100);
          const label = d.mnt_point || d.device_name || "disk";
          if (pct >= 90 && !alertState.diskAlerted.has(label)) {
            alertState.diskAlerted.add(label);
            broadcastAlert("error", `Disk almost full: ${label}`, `${Math.round(pct)}% used`);
          } else if (pct >= 85 && !alertState.diskAlerted.has(label)) {
            alertState.diskAlerted.add(label);
            broadcastAlert("warn", `Disk space low: ${label}`, `${Math.round(pct)}% used`);
          } else if (pct < 80) {
            alertState.diskAlerted.delete(label);
          }
        }
      }
    } catch { /* glances unavailable */ }
  }

  // ── 3. qBittorrent completed downloads ─────────────────────────────────
  const qbUrl  = process.env.QBITTORRENT_URL;
  const qbUser = process.env.QBITTORRENT_USER || "admin";
  const qbPass = process.env.QBITTORRENT_PASS;
  if (qbUrl && qbPass) {
    try {
      // Login
      const loginRes = await fetch(`${qbUrl}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `username=${encodeURIComponent(qbUser)}&password=${encodeURIComponent(qbPass)}`,
        signal: AbortSignal.timeout(4000),
      });
      const cookie = loginRes.headers.get("set-cookie")?.split(";")[0] || "";
      if (cookie) {
        const torRes = await fetch(`${qbUrl}/api/v2/torrents/info?filter=completed`, {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(4000),
        });
        if (torRes.ok) {
          const torrents = await torRes.json();
          for (const t of torrents) {
            if (!alertState.knownDone.has(t.hash)) {
              alertState.knownDone.add(t.hash);
              // Only notify for torrents completed in last 90 s (avoid flood on startup)
              if (t.completion_on && (Date.now()/1000 - t.completion_on) < 90) {
                const size = t.size >= 1e9
                  ? `${(t.size/1e9).toFixed(1)} GB`
                  : `${(t.size/1e6).toFixed(0)} MB`;
                broadcastAlert("info", `Download complete`, `${t.name} (${size})`);
              }
            }
          }
        }
      }
    } catch { /* qb unavailable */ }
  }
}

// Kick off after a short delay then every 30 s
setTimeout(() => {
  runAlerts();
  setInterval(runAlerts, 30_000);
}, 8_000);

/* ── DOCKER INTEGRATION ─────────────────────────────────────────────────────
   Talks to /var/run/docker.sock (mount it read-only in docker-compose.yml).
   All routes return JSON; errors return { error: "..." }.
────────────────────────────────────────────────────────────────────────────── */
import { request as nodeHttpRequest } from "http";

function dockerAPI(path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = nodeHttpRequest(
      { socketPath: "/var/run/docker.sock", path: `/v1.41${path}`, method },
      res => {
        const chunks = [];
        res.on("data", c => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

// Docker multiplexed log stream → plain text
function demuxDockerLogs(buf) {
  const lines = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off + 4);
    off += 8;
    if (size > 0 && off + size <= buf.length) {
      lines.push(buf.slice(off, off + size).toString("utf8"));
      off += size;
    } else break;
  }
  // Fall back to raw text if demux produced nothing sensible
  return lines.length ? lines.join("") : buf.toString("utf8");
}

// GET /api/docker/ping — is the socket reachable?
app.get("/api/docker/ping", async c => {
  try {
    const { status } = await dockerAPI("/info");
    return c.json({ ok: status < 300 });
  } catch {
    return c.json({ ok: false });
  }
});

// GET /api/docker/containers — list all containers
app.get("/api/docker/containers", async c => {
  try {
    const { buf, status } = await dockerAPI("/containers/json?all=1");
    if (status !== 200) return c.json({ error: `Docker API ${status}` }, 502);
    const raw = JSON.parse(buf.toString());
    const containers = raw.map(ct => ({
      id:      ct.Id.slice(0, 12),
      name:    (ct.Names[0] || "").replace(/^\//, ""),
      image:   ct.Image,
      state:   ct.State,   // running | exited | paused | restarting | dead
      status:  ct.Status,  // "Up 2 hours", "Exited (0) 3 minutes ago"
      created: ct.Created,
      ports:   (ct.Ports || [])
        .filter(p => p.PublicPort)
        .map(p => `${p.PublicPort}:${p.PrivatePort}`)
        .slice(0, 4),
    }));
    return c.json(containers);
  } catch (e) {
    return c.json({ error: e.message }, 503);
  }
});

// GET /api/docker/logs/:id?tail=200 — last N log lines
app.get("/api/docker/logs/:id", async c => {
  const id   = c.req.param("id");
  const tail = Math.min(Number(c.req.query("tail") || 200), 500);
  try {
    const { buf, status } = await dockerAPI(
      `/containers/${id}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`
    );
    if (status !== 200) return c.json({ error: `Docker API ${status}` }, 502);
    const text = demuxDockerLogs(buf);
    return c.json({ logs: text });
  } catch (e) {
    return c.json({ error: e.message }, 503);
  }
});

// GET /api/docker/stats/:id — one-shot CPU + memory
app.get("/api/docker/stats/:id", async c => {
  const id = c.req.param("id");
  try {
    const { buf, status } = await dockerAPI(`/containers/${id}/stats?stream=false`);
    if (status !== 200) return c.json({ error: `Docker API ${status}` }, 502);
    const s = JSON.parse(buf.toString());
    // CPU %
    const cpuDelta  = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
    const sysDelta  = s.cpu_stats.system_cpu_usage    - s.precpu_stats.system_cpu_usage;
    const cpuCount  = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpuPct    = sysDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0;
    // Memory
    const memUsage  = s.memory_stats.usage - (s.memory_stats.stats?.cache || 0);
    const memLimit  = s.memory_stats.limit;
    const memPct    = memLimit > 0 ? (memUsage / memLimit) * 100 : 0;
    return c.json({
      cpu:    Math.round(cpuPct * 10) / 10,
      memMB:  Math.round(memUsage / 1e6),
      memPct: Math.round(memPct * 10) / 10,
    });
  } catch (e) {
    return c.json({ error: e.message }, 503);
  }
});

// POST /api/docker/restart/:id
app.post("/api/docker/restart/:id", async c => {
  const id = c.req.param("id");
  try {
    const { status } = await dockerAPI(`/containers/${id}/restart`, "POST");
    return c.json({ ok: status === 204 });
  } catch (e) {
    return c.json({ error: e.message }, 503);
  }
});

// POST /api/docker/stop/:id
app.post("/api/docker/stop/:id", async c => {
  const id = c.req.param("id");
  try {
    const { status } = await dockerAPI(`/containers/${id}/stop`, "POST");
    return c.json({ ok: status === 204 });
  } catch (e) {
    return c.json({ error: e.message }, 503);
  }
});

// ── Easter eggs ───────────────────────────────────────────────────────────────
// Fires random log lines so anyone tailing the EARTH container gets a surprise.

const EGG_LINES = [
  "INFO  [earth] All systems nominal. Totally not held together with duct tape.",
  "DEBUG [earth] Checked if anyone is watching. They are. Behaving accordingly.",
  "WARN  [earth] Low entropy detected in /dev/random. Telling it a joke.",
  "INFO  [earth] Disk usage acceptable. The 400GB of ISOs is definitely research.",
  "DEBUG [earth] Pinged Google to check internet. Google said hi back.",
  "INFO  [earth] Cron job completed. It has no idea what it does either.",
  "WARN  [earth] Fan speed elevated. Server is just really passionate about its work.",
  "INFO  [earth] Uptime looking healthy. Please do not reboot to install updates.",
  "DEBUG [earth] Memory usage fine. The leak is a feature we call 'warm cache'.",
  "ERROR [earth] Could not find a reason to restart. Continuing indefinitely.",
  "INFO  [earth] Docker socket available. With great power comes great responsibility.",
  "WARN  [earth] Detected unread documentation. Flagging for eternal procrastination.",
  "DEBUG [earth] Checked SMART status on all drives. They feel smart. Flattered.",
  "INFO  [earth] No alerts fired. Either everything is perfect or nothing is monitored.",
  "WARN  [earth] /tmp growing. Someone is having a good time in there.",
  "INFO  [earth] SSL cert valid for 89 more days. Setting calendar reminder. Losing it.",
  "DEBUG [earth] Ran self-diagnostics. Ego within acceptable bounds.",
  "INFO  [earth] All containers healthy. Even the one you forgot you deployed.",
  "WARN  [earth] Detected 3am deploy attempt. Routing to /dev/null.",
  "INFO  [earth] Backup completed. Restore never tested. Classic.",
];

function fireEasterEgg() {
  const line = EGG_LINES[Math.floor(Math.random() * EGG_LINES.length)];
  console.log(line);
}

// One at startup, then every ~12 minutes ± jitter
setTimeout(fireEasterEgg, 3_500);
setInterval(() => {
  setTimeout(fireEasterEgg, Math.random() * 120_000);
}, 720_000);
