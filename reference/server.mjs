// Hearth — service proxy (PRD §11 adapter model).
// Holds secrets, talks to LAN service APIs, returns normalized stats.
// Routes are generic: every adapter in adapters/ gets /api/<key> for free.
//
//   cp .env.example .env   # set <SERVICE>_URL / _KEY for the ones you run
//   node --env-file=.env server.mjs
//
// Endpoints:
//   GET /health            → liveness + loaded adapters
//   GET /api/services      → [{ key, label, enabled }]  (enabled = _URL set)
//   GET /api/<service>     → { service, label, status, stats:[...], generatedAt }

import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { makeHttp } from "./core/http.mjs";
import { cached } from "./core/cache.mjs";
import { loadAdapters } from "./core/registry.mjs";
import { serviceConfig, isEnabled } from "./core/config.mjs";

const { PORT = "8787", CORS_ORIGIN = "*", RESPONSE_TTL = "15000" } = process.env;

const adapters = await loadAdapters();
const http = makeHttp();
const app = new Hono();
app.use("*", cors({ origin: CORS_ORIGIN }));

app.get("/health", (c) =>
  c.json({ ok: true, service: "hearth-proxy", adapters: [...adapters.keys()] }));

// list everything the proxy can do + whether it's configured
app.get("/api/services", (c) =>
  c.json([...adapters.values()].map((a) => ({
    key: a.key, label: a.label, enabled: isEnabled(serviceConfig(a.key)),
  }))));

// generic per-service stats
app.get("/api/:service", async (c) => {
  const key = c.req.param("service");
  const a = adapters.get(key);
  if (!a) return c.json({ error: `unknown service "${key}"` }, 404);

  const cfg = serviceConfig(key);
  if (!isEnabled(cfg))
    return c.json({ error: `${key} not configured — set ${key.toUpperCase()}_URL` }, 503);

  try {
    const data = await cached(`resp:${key}`, Number(RESPONSE_TTL), async () => {
      const res = await a.fetch(cfg, { http, cached });
      return {
        service: a.key, label: a.label,
        status: res.status || "ok", stats: res.stats || [],
        generatedAt: new Date().toISOString(),
      };
    });
    return c.json(data);
  } catch (e) {
    return c.json({ service: key, label: a.label, status: "error", error: String(e?.message || e) }, 502);
  }
});

serve({ fetch: app.fetch, port: Number(PORT) }, (info) =>
  console.log(`Hearth proxy on http://localhost:${info.port} — adapters: ${[...adapters.keys()].join(", ")}`));
