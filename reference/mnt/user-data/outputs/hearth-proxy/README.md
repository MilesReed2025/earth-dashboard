# Hearth Proxy

The backend that lets the Hearth dashboard pull live stats from your services'
APIs. It holds the secrets (API keys never reach the browser), proxies the
calls (sidestepping CORS), and returns a **normalized stats shape** so the
dashboard can render any service generically.

## Run

```bash
npm install
cp .env.example .env        # set <SERVICE>_URL/_KEY for the ones you run
npm start                   # = node --env-file=.env server.mjs
```

A service is **enabled** the moment its `_URL` is set — everything else stays off.

## Endpoints

| Route | Returns |
|---|---|
| `GET /health` | liveness + auto-discovered adapters |
| `GET /api/services` | `[{ key, label, enabled }]` — what's available + configured |
| `GET /api/<service>` | `{ service, label, status, stats:[…], generatedAt }` |

```bash
curl localhost:8787/api/jellyfin
# { "service":"jellyfin","label":"Jellyfin","status":"ok",
#   "stats":[{"key":"movies","label":"Films","value":1248,"format":"number"}, …] }
```

## Built-in adapters

| Service | Auth style | Stats |
|---|---|---|
| jellyfin | `?api_key=` | films, library size, latest |
| radarr | `X-Api-Key` header | movies, queue |
| sonarr | `X-Api-Key` header | series, queue |
| qbittorrent | cookie login | down, up, active |
| immich | `x-api-key` header | photos, videos, usage |
| adguard | basic auth | queries, blocked, block rate |

## Adding a service

Copy `adapters/_template.mjs.txt` → `adapters/<service>.mjs`, implement
`fetch(cfg, ctx)`, drop it in. The proxy auto-discovers it and exposes
`/api/<key>` — no server edits. See the template for the full contract.

Normalized stat: `{ key, label, value, format, meta? }`
where `format ∈ number | bytes | speed | percent | text`.

## Caching

Cheap stats use short TTLs (30–120s); expensive ones (e.g. Jellyfin library
size, which pages every movie) cache for an hour. The server also caches each
service's whole response for `RESPONSE_TTL` ms to coalesce bursty reloads.

## Structure

```
server.mjs            generic routing + caching
core/
  registry.mjs        auto-discovers adapters/
  config.mjs          <SERVICE>_URL/_KEY/_USER/_PASS resolution
  http.mjs            fetch helper (params, headers, cookies, raw)
  cache.mjs           shared TTL cache
adapters/
  jellyfin.mjs … adguard.mjs
  _template.mjs.txt   copy this to add your own
```
