# EARTH Dashboard — Overnight Build Session

## Context

You are working on **EARTH** (codename Hearth) — a self-hosted personal dashboard for Miles at Port Seton. The goal is a polished, configurable dashboard that replaces tools like homepage.dev and Homarr. The core differentiator is a **YAML config file as the single source of truth**, with a visual editor that round-trips cleanly to it (preserving comments, ordering, anchors) — see the PRD for the full vision.

**Working directory:** `/Volumes/docker/webserver/dashboard/`

The workspace contains:
- `Dashboard.html` — the current single-file frontend (React 18 CDN, no JSX, OKLCH design system, localStorage-based config). This is the main artifact.
- `reference/` — PRD, sample config, and a proven backend prototype (server.mjs, adapters). **Read these before doing anything.**
- `reference/Hearth-Discovery-PRD.md` — full product vision
- `reference/sample.config.yaml` — the canonical YAML format (comments, anchors, env-var refs — all must survive round-trips)
- `reference/server.mjs` — proven Hono proxy server pattern
- `reference/registry.mjs`, `reference/config.mjs` — adapter auto-discovery + env-var config resolution
- `reference/jellyfin.mjs`, `reference/sonarr.mjs`, `reference/radarr.mjs`, `reference/qbittorrent.mjs`, `reference/immich.mjs`, `reference/adguard.mjs` — working service adapters

Read every reference file in full before writing a single line of code.

---

## Current State of Dashboard.html

The frontend is functionally rich but has these gaps:

1. **Service stats are hardcoded/fake.** The "Servers" view is a `PlaceholderView` — it never loads real data. Service tiles in the home view show static strings.
2. **No backend.** All config lives in `localStorage('earth:cfg')`. There's no proxy server, so API keys can't be held securely and service integrations don't work.
3. **No YAML.** Config round-trip (the product's core bet) is unimplemented.
4. **Good bones.** The UI, design system, RSS feeds, YouTube (Mistral suggestions), weather (open-meteo), and settings editor are all working well. Don't break these.

---

## What to Build — Ordered by Priority

Work through these in order. Commit to each fully before moving on.

### Priority 1 — Backend proxy server

Create `/Volumes/docker/webserver/dashboard/server.mjs` based on `reference/server.mjs`. This is a Hono server that:

- Serves `Dashboard.html` at `/` (reads the file, sets correct Content-Type)
- Proxies service calls: `GET /api/:service` → adapter fetch → JSON stats
- Reads/writes `hearth.yaml` config: `GET /api/config` returns parsed YAML as JSON; `POST /api/config` accepts JSON, merges into YAML document preserving comments (use `eemeli/yaml` Document API — the round-trip spike already proves this works, see `reference/roundtrip.test.mjs`)
- Pushes config changes over WebSocket at `/ws` (so the browser auto-refreshes when YAML is edited externally via `$EDITOR`)
- Resolves `${ENV_VAR}` secrets in YAML values at read time, so API keys never reach the browser
- CORS: allow `*` for local use; configurable via `CORS_ORIGIN` env

Create `/Volumes/docker/webserver/dashboard/adapters/` directory and copy/adapt the reference adapters (jellyfin, sonarr, radarr, qbittorrent, immich, adguard). Each adapter must match the `{ key, label, fetch(cfg, { http, cached }) }` interface from `reference/server.mjs`. Also add a simple `ping` adapter: just does `GET {url}` and returns `{ status: ok|error, responseMs }`.

Create `/Volumes/docker/webserver/dashboard/package.json`:
```json
{
  "name": "earth-dashboard",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "start": "node server.mjs",
    "dev": "node --watch server.mjs"
  },
  "dependencies": {
    "hono": "^4",
    "@hono/node-server": "^1",
    "yaml": "^2",
    "chokidar": "^3"
  }
}
```

Create `/Volumes/docker/webserver/dashboard/hearth.yaml` based on `reference/sample.config.yaml` — a working example config that Miles can immediately edit. Pre-populate it with the same services that are currently hardcoded in `Dashboard.html` (Jellyfin, Radarr, Sonarr, Immich).

### Priority 2 — Wire up Dashboard.html to the backend

**Config loading:** On startup, `Dashboard.html` should try `GET /api/config`. If it succeeds (backend is running), use that as the source of truth and disable localStorage writes. If it fails (file:// or backend not running), fall back to localStorage — this preserves the current offline-capable behaviour.

```js
// In the main App component, replace the loadCfg() call with:
async function loadConfig() {
  try {
    const r = await fetch('/api/config', { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json();
  } catch {}
  return loadCfg(); // localStorage fallback
}
```

**Config saving:** When `saveCfg()` is called and the backend is available, also `POST /api/config` with the JSON. The backend merges it into YAML preserving comments.

**WebSocket live reload:** If backend is available, open a WebSocket to `ws://[location.host]/ws`. On message `{ type: 'config', payload }`, update React state — so editing `hearth.yaml` in a terminal immediately refreshes the browser.

**Live service stats:** Replace the hardcoded stats in `DEFAULT_CFG.services` with a `useServiceStats` hook that fetches from `/api/:service` for each configured service. Show a subtle animated pulse on stat values while loading, and a small red dot on the service tile if the adapter returns `status: error`. This is the "Servers view" — build it out.

```js
function useServiceStats(services) {
  const [stats, setStats] = useState({});
  useEffect(() => {
    if (!services?.length) return;
    services.forEach(svc => {
      const key = svc.logo; // adapter key matches the logo name (jellyfin, sonarr, etc.)
      fetch(`/api/${key}`)
        .then(r => r.ok ? r.json() : Promise.reject())
        .then(data => setStats(p => ({ ...p, [svc.id]: data })))
        .catch(() => setStats(p => ({ ...p, [svc.id]: { status: 'error' } })));
    });
  }, [services]);
  return stats;
}
```

Replace the `PlaceholderView` for the "Servers" route with a real `ServersView` component that renders each service's live stats grid, status badge, and a link to the service URL.

### Priority 3 — YAML config round-trip in the UI

In Settings, add a new **"Config"** tab (after the existing tabs) with:
- A `<textarea>` showing the live `hearth.yaml` content (`GET /api/config/raw` endpoint — return the raw YAML text, not JSON)
- A "Save" button that `POST`s to `/api/config/raw` with the edited text (validate YAML client-side first using a simple try/catch with the `yaml` library loaded from CDN: `https://cdn.jsdelivr.net/npm/yaml@2/browser/dist/index.min.js`)
- A read-only indicator when the backend is unavailable ("Config file editing requires the backend server")
- Below the editor, a clear note: "This file is the single source of truth. Comments and formatting are preserved."

Add a `GET /api/config/raw` route to `server.mjs` that returns the raw YAML text with `Content-Type: text/plain`.
Add a `POST /api/config/raw` route that accepts raw YAML text, validates it parses cleanly, then writes it atomically (write to `.hearth.yaml.tmp`, then `rename` — never corrupt the file on a failed write).

### Priority 4 — Polish pass (do this last, spend remaining time here)

Work through each section of the UI and fix real bugs and rough edges:

**Navigation & layout:**
- Collapsed sidebar tooltip positioning: verify `data-label` tooltips don't clip off screen on the right edge for the mode pill buttons
- Ensure the Earth icon in the brand mark doesn't have any rendering artifacts
- Confirm the mode toggle pill transitions smoothly on expand/collapse (both `flex-direction` animation and `border-radius` change)

**Home view:**
- Weather widget: if `open-meteo` returns an error, show a graceful "Weather unavailable" state rather than a blank card
- Service tiles: if `useServiceStats` is unavailable (no backend), show the hardcoded stats from config so the UI isn't broken
- YouTube section: if no channels are configured, show a friendly empty state with a button that navigates to Settings → Feeds
- RSS feeds: if all feeds fail, show "No feeds configured" with a Settings link rather than empty space

**Settings:**
- YouTube channels: after bulk-adding from Mistral suggestions, close the form and show the "Saved ✓" confirmation
- Validate that service URLs are well-formed before saving (simple `new URL()` test with a try/catch, inline red message)
- The "Display name" input in feed/link/service edit forms: if the user leaves it blank and tries to save, shake the field (CSS `animation: shake .2s`) rather than silently disabling the button

**News view:**
- Feed color dots: currently assigned by index; persist the color assignment per feed ID so colors don't shift when feeds are reordered

**General:**
- Ensure all `<button>` elements have `type="button"` to prevent accidental form submission
- Add `title` attributes to icon-only buttons for keyboard/screen-reader users
- All `fetch` calls should have `AbortSignal.timeout(...)` — audit and add where missing

---

## Architecture Notes

**Single-file constraint:** `Dashboard.html` must remain a single HTML file. Do NOT split it into separate JS/CSS files. The backend (`server.mjs`) simply `fs.readFile`s and serves it. This is intentional — the whole dashboard is one file you can drop anywhere.

**No build step:** The frontend uses React 18 from CDN + `React.createElement` aliased as `h`. No JSX, no TypeScript, no Vite. Keep it this way.

**Design system:** OKLCH color variables (`--desk`, `--frame`, `--inner`, `--s1`, `--s2`, `--t1`–`--t4`, `--a`, `--a-lo`, `--b`, `--r`). Never use hex or rgb directly in new CSS — use these variables. Dark/light theme is toggled via `body[data-theme="light"]`.

**State management:** React `useState`/`useEffect` only, no external state library. Config is loaded once into a `cfg` state object and threaded down as props. `saveCfg` is a function that both updates state and persists (to backend if available, localStorage always as backup).

**Backend availability detection:** Store a module-level `let backendAvailable = false` flag. Set it to `true` on first successful `/api/config` call. Use it to conditionally show backend-dependent UI (Config tab, live stats, WebSocket reload).

---

## Acceptance Criteria

Before finishing, verify:

- [ ] `node server.mjs` starts without errors (after `npm install`)
- [ ] Browser at `http://localhost:8787` loads the dashboard
- [ ] `GET /api/config` returns the parsed `hearth.yaml` as JSON
- [ ] Editing `hearth.yaml` in a terminal and saving causes the browser to update within 2 seconds (WebSocket push)
- [ ] Service tiles show real stats when adapters are configured (or clear error state when not)
- [ ] `POST /api/config` from the Settings UI saves changes to `hearth.yaml` without losing comments
- [ ] If the backend is not running, `Dashboard.html` loads fine from `file://` and falls back to localStorage
- [ ] No console errors on page load (audit with DevTools)
- [ ] All placeholder views are replaced with real content

---

## File Layout When Done

```
/Volumes/docker/webserver/dashboard/
  Dashboard.html          ← single-file frontend (modified)
  server.mjs              ← Hono proxy + config API + WS (NEW)
  package.json            ← (NEW)
  hearth.yaml             ← example config (NEW)
  adapters/               ← (NEW)
    jellyfin.mjs
    sonarr.mjs
    radarr.mjs
    qbittorrent.mjs
    immich.mjs
    adguard.mjs
    ping.mjs
  reference/              ← (unchanged — source material only)
    ...
```

---

## Final Note

The Mistral API key `3H1RD1tnTiyA376RMmhwm7Yga4hauZvB` is intentionally hardcoded in Dashboard.html as `const MISTRAL_KEY`. Do not remove or externalize it.

Take your time on each section. Quality over quantity — a working Servers view with real stats is worth more than five half-built features. If you finish early, do a full design polish pass: spacing, typography, hover states, transitions, empty states. Make it feel like software Miles is proud to have running on his homelab.
