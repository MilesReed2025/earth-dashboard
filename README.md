# EARTH

**A personal homelab dashboard.** Weather, calendar, email, services, feeds, films, music, and now full Docker management — all in one place, running on your own hardware.

![Docker pulls](https://ghcr-badge.egpl.dev/milesreed2025/earth-dashboard/size?tag=latest)

<img width="2856" height="1640" alt="Macbook-Air-192 168 4 99 (1)" src="https://github.com/user-attachments/assets/c1a9741f-d3e7-4bd3-96be-e26fc0f327c5" />

---

## What it is

EARTH is a single-page dashboard built for self-hosters. It talks to your services directly — Jellyfin, Radarr, Sonarr, Home Assistant, qBittorrent, and more — and surfaces everything you actually want to see when you open a new tab.

No cloud account. No telemetry. No vendor lock-in. Just a Node server, a YAML config file, and a browser.

Unlike most dashboards that lock your config inside a database or proprietary format, EARTH stores everything in plain `earth.yaml`. Your entire setup is a single file you can read, back up, version-control, or hand to a friend. The settings UI writes directly to that file — nice interface, full control.

<img width="2856" height="1640" alt="Macbook-Air-192 168 4 99 (2)" src="https://github.com/user-attachments/assets/8425cf22-8781-418c-b344-1adb5fe6860f" />

---

## Features

- **Weather** — current conditions + 7-day forecast via Open-Meteo (free, no key needed). Today's AI-written narrative shown inline in the hero. Optional personality modes via Mistral: Normal, Sarcastic, Borderline Rude, Cheerful, or Depressed.
- **Calendar** — today's events from any ICS feed (Google Calendar, iCloud, Outlook, Nextcloud, Proton, Fastmail). Navigate forward and back through days.
- **Email** — recent Gmail inbox via app password. No OAuth, no scopes, no drama.
- **Services** — live stat tiles for your homelab stack. Jellyfin, Radarr, Sonarr, Immich, qBittorrent, AdGuard, Glances, Home Assistant, and more.
- **Docker** — full container management in a master-detail layout. Logs with live search, CPU/memory stats with sparklines, container info, grouped by Compose project. No extra tools required — mounts the Docker socket directly.
- **System resources** — CPU, RAM, and disk chips in the topbar, pulled from the host via Node's `os` module (no Glances required for basic stats).
- **Feeds** — RSS, Atom, and YouTube channel feeds in a unified reading view.
- **Discover** — trending films and TV via TMDB, with ratings, posters, and a detail modal.
- **Music** — recently scrobbled tracks via Last.fm.
- **Automations** — trigger Home Assistant automations directly from the dashboard.
- **Proactive alerts** — WebSocket-pushed toasts (and browser notifications) when a service goes down, a disk hits 85%, or a torrent completes.
- **Command palette** — `⌘S` / `Ctrl+S` to jump anywhere: pages, services, links, themes, and Docker containers all searchable in one place.
- **10 themes** — Dark, Light, Nord, Catppuccin, Gruvbox, Dracula, Tokyo Night, Rosé Pine, Solarized, Monokai.
- **Work / Personal mode** — toggle manually or schedule it.
- **First-boot wizard** — guided setup on first visit.
- **YAML-backed config** — your entire dashboard in one `earth.yaml` file.

<img width="2856" height="1640" alt="Macbook-Air-192 168 4 99 (3)" src="https://github.com/user-attachments/assets/5892e5af-3a1b-47a1-87b0-9b347b288fbb" />

---

## Quick start

### Option A: Interactive setup script (recommended)

Clone the repo and run the guided setup — it handles geocoding, fills in your `.env` and `earth.yaml`, and brings everything up:

```bash
git clone https://github.com/MilesReed2025/earth-dashboard.git
cd earth-dashboard
chmod +x setup.sh && ./setup.sh
```

The script will print your live URL when it's done.

### Option B: Manual Docker Compose

**1. Grab the config templates:**

```bash
mkdir earth-dashboard && cd earth-dashboard
curl -O https://raw.githubusercontent.com/MilesReed2025/earth-dashboard/main/earth.yaml.example
curl -O https://raw.githubusercontent.com/MilesReed2025/earth-dashboard/main/.env.example
cp earth.yaml.example earth.yaml
cp .env.example .env
```

**2. Create `docker-compose.yml`:**

```yaml
services:
  earth:
    image: ghcr.io/milesreed2025/earth-dashboard:latest
    container_name: earth-dashboard
    restart: unless-stopped
    ports:
      - "8787:8787"
    volumes:
      - ./earth.yaml:/app/earth.yaml
      - ./.env:/app/.env
      - /var/run/docker.sock:/var/run/docker.sock   # optional: enables Docker view
    env_file:
      - .env
```

**3. Start it:**

```bash
docker compose up -d
```

Open [http://localhost:8787](http://localhost:8787). The onboarding wizard will walk you through the rest.

---

## Docker view

Mount the Docker socket to unlock full container management:

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Then open the Docker view from the sidebar. You get:

- Container list grouped by Compose project, searchable by name, image, or state
- **Logs tab** — live-polling logs with inline search and auto-scroll
- **Stats tab** — CPU and memory bars with 30-point sparkline history
- **Info tab** — image, container ID, ports, created timestamp
- Restart controls with confirmation

---

## Command palette

Press `⌘S` (Mac) or `Ctrl+S` (Linux/Windows) from anywhere to open the command palette. Search across pages, services, links, Docker containers, and themes in one place. Keyboard-navigable with `↑↓` and `↵`.

---

## Configuration

Everything lives in two files:

| File | Purpose |
|------|---------|
| `earth.yaml` | Your config — name, location, services, links, feeds. Hot-reloaded; edits reflect instantly. |
| `.env` | Secrets — API keys and credentials. Never committed to git. |

See [`earth.yaml.example`](earth.yaml.example) and [`.env.example`](.env.example) for full annotated reference configs.

---

## Integrations

All optional. The dashboard works without any API keys.

| Service | Key | What it unlocks |
|---------|-----|-----------------|
| [Mistral AI](https://console.mistral.ai) | `MISTRAL_KEY` | AI-written weather narrative (free tier available) |
| [TMDB](https://www.themoviedb.org/settings/api) | `TMDB_TOKEN` | Discover tab — trending films & TV (free) |
| [Last.fm](https://www.last.fm/api) | `LASTFM_KEY` | Music scrobbling & recently played (free) |
| Gmail | `GMAIL_USER` + `GMAIL_APP_PASS` | Recent inbox in the home view |
| Calendar | `CALENDAR_ICS_URL` | Calendar events in the home view |
| Home Assistant | `HA_URL` + `HA_TOKEN` | Automations view, entity states |
| Jellyfin | `JELLYFIN_URL` + `JELLYFIN_KEY` | Live library stats |
| Radarr | `RADARR_URL` + `RADARR_KEY` | Queue, missing films |
| Sonarr | `SONARR_URL` + `SONARR_KEY` | Series, missing episodes |
| Immich | `IMMICH_URL` + `IMMICH_KEY` | Photo library stats |
| qBittorrent | `QBITTORRENT_URL` + credentials | Download queue |
| Deluge | `DELUGE_URL` + `DELUGE_PASS` | Download queue |
| AdGuard Home | `ADGUARD_URL` + credentials | DNS query stats |
| Glances | `GLANCES_URL` | Extended system stats |
| Uptime Kuma | `UPTIMEKUMA_URL` + `UPTIMEKUMA_KEY` | Monitor up/down status (see below) |
| SSL certificate expiry | none — just a host:port | Days until a cert expires (see below) |

### Network & Security

- **Uptime Kuma** needs a one-time setup: in Kuma go to Settings → Status Pages, create a status page listing the monitors you want on the dashboard, then set its slug as the service's `apiKey` in `earth.yaml` (or `UPTIMEKUMA_KEY` in `.env`). The status page must be unauthenticated — Kuma doesn't expose a plain JSON API for authenticated monitor data.
- **SSL certificate expiry** needs no credentials at all — it opens a TLS handshake to whatever `host:port` you list and reads the certificate's expiry date directly. Add one `sslcheck` entry per host in `earth.yaml`'s `services[]` (only hosts that actually terminate TLS — a plain-HTTP host will time out after 8s on every poll). You'll get a proactive alert when a cert has under 14 days left, and again under 3 days.

---

## Themes

10 themes, switchable from the topbar, Settings, or the command palette (`⌘S` → type "theme").

| Theme | Style |
|-------|-------|
| Dark | Default dark |
| Light | Clean light mode |
| Nord | Arctic blue |
| Catppuccin | Pastel Mocha |
| Gruvbox | Warm retro earth tones |
| Dracula | Purple-accented dark |
| Tokyo Night | Deep blue with neon accents |
| Rosé Pine | Muted, rose-tinted dark |
| Solarized | Precision contrast dark |
| Monokai | Classic editor green-on-dark |

---

## Weather personality

If you have a Mistral API key, the forecast gets an AI-written narrative shown right in the hero. Choose the tone in **Settings → General → AI forecast personality**:

- **Normal** — clear and practical
- **Sarcastic** — dry, resigned, deeply suspicious of sunshine *(default)*
- **Borderline Rude** — clipped and irritated at the weather and at you for asking
- **Cheerful** — finds silver linings in storms, possibly unhinged
- **Depressed** — the rain is a metaphor for something

---

## Running from source

```bash
git clone https://github.com/MilesReed2025/earth-dashboard.git
cd earth-dashboard
npm install
cp .env.example .env
cp earth.yaml.example earth.yaml
node server.mjs          # production
node --watch server.mjs  # development (auto-restarts on changes)
```

Open [http://localhost:8787](http://localhost:8787).

**Requirements:** Node.js 20+

---

## Updating

```bash
docker compose pull && docker compose up -d
```

Your `earth.yaml` and `.env` are mounted from the host — never overwritten by an update.

---

## Architecture

- **Frontend** — single-file React 18 app (`Dashboard.html`), no build step. CDN imports only.
- **Backend** — [Hono](https://hono.dev) server (`server.mjs`) that serves the HTML, proxies API calls, reads/writes `earth.yaml`, manages the Docker socket connection, and keeps secrets server-side.
- **Config** — `earth.yaml` as source of truth, synced to the browser via WebSocket for live edits.
- **Alerts** — server polls services every 30 seconds and pushes alerts over the existing WebSocket connection.
- **Secrets** — all API keys stay in `.env`, resolved server-side. Nothing sensitive ever reaches the browser.

---

## License

MIT
