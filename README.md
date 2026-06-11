# EARTH

**A personal homelab dashboard.** Weather, calendar, email, services, feeds, films, music — all in one place, running on your own hardware.

![Docker pulls](https://ghcr-badge.egpl.dev/milesreed2025/earth-dashboard/size?tag=latest)

<img width="2856" height="1640" alt="Macbook-Air-192 168 4 99 (1)" src="https://github.com/user-attachments/assets/c1a9741f-d3e7-4bd3-96be-e26fc0f327c5" />
<img width="2856" height="1640" alt="Macbook-Air-192 168 4 99 (2)" src="https://github.com/user-attachments/assets/8425cf22-8781-418c-b344-1adb5fe6860f" />
<img width="2856" height="1640" alt="Macbook-Air-192 168 4 99 (3)" src="https://github.com/user-attachments/assets/5892e5af-3a1b-47a1-87b0-9b347b288fbb" />



---

## What it is

EARTH is a single-page dashboard built for self-hosters. It talks to your services directly — Jellyfin, Radarr, Sonarr, Home Assistant, qBittorrent, and more — and surfaces everything you actually want to see when you open a new tab.

No cloud account. No telemetry. No vendor lock-in. Just a Node server, a YAML config file, and a browser.

Unlike most dashboards that lock your config inside a database or proprietary format, EARTH stores everything in plain `earth.yaml`. That means your entire setup is a single file you can read, back up, version-control, or hand to a friend. The settings UI writes directly to that file — so you get a nice interface to configure things without giving up the simplicity of text.

---

## Features

- **Weather** — current conditions + 7-day forecast via Open-Meteo (free, no key needed). Optional AI-written narrative via Mistral with five personality modes: Normal, Sarcastic, Borderline Rude, Cheerful, or Depressed.
- **Calendar** — today's events from any ICS feed (Google Calendar, iCloud, Outlook, Nextcloud, Proton, Fastmail — anything with a `.ics` URL). Navigate forward and back through days.
- **Email** — recent Gmail inbox via app password. No OAuth, no scopes, no drama.
- **Services** — live stat tiles for your homelab stack. Jellyfin, Radarr, Sonarr, Immich, qBittorrent, AdGuard, Glances, Home Assistant, and more via an adapter system.
- **System resources** — CPU, RAM, and disk chips in the topbar, pulled from the host via Node's `os` module (no Glances required for basic stats).
- **Feeds** — RSS, Atom, and YouTube channel feeds in a unified reading view.
- **Discover** — trending films and TV via TMDB, with ratings, posters, and a detail modal.
- **Music** — recently scrobbled tracks via Last.fm.
- **Automations** — trigger Home Assistant automations directly from the dashboard.
- **Status monitor** — service health chips (Atlassian Statuspage format) in the topbar.
- **5 themes** — Dark, Light, Nord, Catppuccin, Gruvbox. Cycle through them with the topbar button.
- **Work / Personal mode** — toggle manually or set a schedule to switch automatically.
- **First-boot wizard** — guided setup on first visit. Name, location, and API keys all in one place.
- **YAML-backed config** — your entire dashboard lives in one `earth.yaml` file. Back it up, commit it to git, share it with a friend, or restore it to a new machine in seconds. The settings UI reads and writes the same file, so you never have to choose between a nice interface and staying in control of your data.

---

## Quick start

The fastest path: Docker Compose with the pre-built image. No cloning required.

**1. Create a folder and grab the two config templates:**

```bash
mkdir earth-dashboard && cd earth-dashboard
curl -O https://raw.githubusercontent.com/MilesReed2025/earth-dashboard/main/earth.yaml.example
curl -O https://raw.githubusercontent.com/MilesReed2025/earth-dashboard/main/.env.example
cp earth.yaml.example earth.yaml
cp .env.example .env
```

**2. Create a `docker-compose.yml`:**

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
    env_file:
      - .env
```

**3. Start it:**

```bash
docker compose up -d
```

Open [http://localhost:8787](http://localhost:8787). The onboarding wizard will walk you through the rest.

---

## Configuration

Everything lives in two files:

| File | Purpose |
|------|---------|
| `earth.yaml` | Your config — name, location, services, links, feeds. Edits here reflect in the browser instantly (no restart). |
| `.env` | Secrets — API keys and service credentials. Never committed to git. |

Both files are hot-reloaded. You can edit `earth.yaml` in your text editor while the dashboard is open and watch it update live.

See [`earth.yaml.example`](earth.yaml.example) and [`.env.example`](.env.example) for full reference configs with comments.

---

## Integrations

All optional. The dashboard works without any API keys — these unlock extra features.

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
| AdGuard Home | `ADGUARD_URL` + credentials | DNS query stats |
| Glances | `GLANCES_URL` | Extended system stats |

Integrations can also be configured from within the dashboard at **Settings → Integrations**.

---

## Themes

Switch themes using the button in the top-right corner of the topbar, or via **Settings → General**.

| Theme | Preview |
|-------|---------|
| Dark | Default dark theme |
| Light | Clean light mode |
| Nord | Arctic, bluish palette |
| Catppuccin | Pastel Mocha variant |
| Gruvbox | Warm retro earth tones |

---

## Weather personality

If you have a Mistral API key, the 7-day forecast gets a written narrative. You can choose how it sounds in **Settings → General → AI forecast personality**:

- **Normal** — clear and practical
- **Sarcastic** — dry, resigned, deeply suspicious of sunshine *(default)*
- **Borderline Rude** — clipped and irritated at the weather and at you for asking
- **Cheerful** — finds silver linings in storms, possibly unhinged
- **Depressed** — the rain is a metaphor for something

---

## Running from source

If you want to hack on it or run without Docker:

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
docker compose pull
docker compose up -d
```

Your `earth.yaml` and `.env` are mounted from the host — they are never overwritten by an update.

---

## Architecture

- **Frontend** — single-file React 18 app (`Dashboard.html`), no build step. CDN imports only.
- **Backend** — [Hono](https://hono.dev) server (`server.mjs`) that serves the HTML, proxies API calls, reads/writes `earth.yaml`, and keeps secrets server-side.
- **Config** — `earth.yaml` as the source of truth, synced to the browser via WebSocket for live edits.
- **Secrets** — all API keys stay in `.env` and are resolved server-side. Nothing sensitive ever reaches the browser.

---

## Roadmap

EARTH is actively being developed. Coming up:

- More widget types and panel integrations
- Deeper customization — layouts, panel sizing, per-panel settings
- Additional service adapters for the homelab ecosystem
- Community theme sharing

Suggestions and PRs welcome.

---

## License

MIT
