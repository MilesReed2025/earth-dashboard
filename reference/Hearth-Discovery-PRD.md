# Hearth — Discovery PRD

> **Working codename:** Hearth (the warm centre of the home). Rename freely.
> **Document type:** Discovery PRD / living build doc
> **Status:** Draft v0.1 — intended to grow over months
> **One-liner:** A self-hosted home/homelab dashboard with declarative YAML config as the source of truth *and* a first-class visual editor that round-trips to it cleanly — Home Assistant native, GitOps-friendly, beautiful by default.

---

## 1. Vision

Every self-hosted dashboard today forces a choice:

- **homepage** — declarative, fast, version-controllable, 100+ integrations. But config is YAML-only with **no UI whatsoever**. Editing means SSH-ing into a container, hand-indenting YAML, and refreshing to regenerate static HTML. Hostile to non-experts and tedious even for experts.
- **Homarr** — gorgeous drag-and-drop UI, live editing, HA integration. But config lives in a database/UI state, so it's **not GitOps-friendly**, hard to back up as text, and you can't reason about it in a PR.

Hearth refuses the choice. **The YAML file is the single source of truth.** The UI is a beautiful, schema-aware editor that reads and writes that exact file without mangling it — preserving comments, ordering, and formatting. Edit in the UI or in `$EDITOR`; both stay in sync. Commit it to a repo. Diff it. Roll it back.

The bet: power users want declarative + Git; everyone wants a UI; **nobody should have to pick.**

---

## 2. Problem Statement

Homelabbers and smart-home owners run dozens of services (media, *arr stack, monitoring, HA, etc.) and need a single pane of glass. Existing dashboards make them trade configurability for usability: homepage demands raw YAML editing inside containers (a documented, recurring pain point in its own GitHub discussions), while Homarr's UI-first approach sacrifices the version-control, reproducibility, and backup story that the same audience increasingly expects from "everything as code." The cost of not solving this is a permanently bifurcated market where users tolerate one tool's friction because the alternative trades away something they value more.

---

## 3. Goals

1. **Eliminate the config trade-off.** A user can fully configure the dashboard through the UI *and* end up with clean, hand-editable, commit-ready YAML — verified by round-trip tests (UI edit → file → re-parse → identical semantic + preserved comments).
2. **Be HA-native, not HA-adjacent.** Live entity state via WebSocket, two-way control, and entity-aware widgets that beat both competitors' HA support. Target: configure an HA light/sensor tile in under 60 seconds with autocomplete from the user's actual entities.
3. **Beautiful by default, themeable without CSS.** A new install looks better than homepage and Homarr out of the box, with theming exposed in the UI (not buried in YAML).
4. **Extensible by the community.** A documented Widget SDK so the long tail of integrations is contributed, not bottlenecked — the only sustainable answer to homepage's 100+ integration moat.
5. **Trustworthy with secrets.** API keys/tokens never live in committed YAML in plaintext; all backend calls are proxied so credentials never reach the browser.

---

## 4. Non-Goals (v1)

- **Matching homepage's 100+ integrations on day one.** Premature; we win on the config model + HA + extensibility, then grow breadth via the SDK. Ship ~12–15 high-value integrations first.
- **Multi-user / RBAC / SSO.** Single-admin model for v1. Architect so it's *addable* (see §11) but don't build it.
- **A hosted/SaaS offering.** Self-hosted, single-container only. No accounts, no cloud.
- **Mobile-native apps.** Responsive PWA only (mirrors your existing deploy pattern).
- **Being a full HA dashboard replacement (Lovelace).** We surface and control HA; we don't try to replace HA's own dashboarding.

---

## 5. Target Users / Personas

**P1 — The GitOps Homelabber (primary).** Runs many Docker services, keeps infra as code, wants their dashboard config in a repo alongside their compose files. Today uses homepage and resents the editing experience. *Wants:* declarative config + a UI that doesn't break it.

**P2 — The Smart-Home Owner.** Heavy Home Assistant user, less interested in *arr stacks, wants a wall-tablet/PWA start page with live sensors and controls. Today might use Homarr or a custom Lovelace view. *Wants:* fast, attractive, live HA tiles with minimal fuss.

**P3 — The Reluctant Self-Hoster.** Capable but config-averse. Bounced off homepage's YAML. *Wants:* to never see a config file unless they choose to.

---

## 6. User Stories

**Configuration (all personas)**
- As a homelabber, I want to edit my dashboard in a visual editor so that I don't hand-indent YAML, **and** have it write clean YAML to a file I can commit.
- As a GitOps user, I want my comments and section ordering preserved when the UI saves, so my version history stays meaningful.
- As any user, I want to edit the YAML directly in my own editor and see the UI reflect the change without restarting the container.
- As a reluctant self-hoster, I want inline validation (red underline + plain-English message) when a value is wrong, so I fix it before saving.

**Home Assistant**
- As a smart-home owner, I want to add a tile bound to an HA entity by searching my actual entity list, so I don't copy entity IDs by hand.
- As a smart-home owner, I want to toggle a light / run a scene from a tile and see the state update live.
- As a smart-home owner, I want sensor tiles (temp, humidity, power) that update in real time without page refresh.

**Services & layout**
- As a homelabber, I want service tiles that show live status/stats (e.g. Jellyfin streams, *arr queue, container health) via proxied API calls.
- As a homelabber, I want Docker containers auto-discovered via labels so new services appear without manual config.
- As any user, I want drag-and-drop layout with responsive breakpoints, so it looks right on desktop and a wall tablet.

**Trust & ops**
- As a homelabber, I want to reference secrets via env vars (`${HEARTH_SONARR_KEY}`) so my committed YAML contains no plaintext keys.
- As any user, I want a one-container Docker deploy behind my existing reverse proxy + tunnel.

---

## 7. The Core Bet: YAML ⇄ UI Round-Trip (the thing that must work)

This is the make-or-break feature and the hardest engineering problem. Detail it now so the architecture serves it.

**Requirement:** The UI and the on-disk YAML are two views of one source of truth. Either can change; both converge.

**Approach:**
- Use a **comment- and structure-preserving YAML library** (e.g. `eemeli/yaml`'s Document/CST API) — *not* naive `parse`→object→`stringify`, which destroys comments, key order, and anchors.
- Config is governed by a **schema** (Zod internally + exported JSON Schema for editor tooling). Schema drives: UI form generation, inline validation, autocomplete, and documentation.
- **File watcher** (chokidar) detects external edits → pushes to the UI over WebSocket → UI re-renders.
- **UI edits** mutate the YAML Document AST in place (preserving surrounding comments/formatting) → atomic write to disk.
- **Conflict handling:** last-write-wins for v1, but detect external change since last UI load and warn before overwriting. (CRDT/merge is a P2 over-engineering trap — avoid.)

**Acceptance criteria (P0):**
- [ ] Given a YAML file with comments and custom key ordering, when the user makes an unrelated edit in the UI and saves, then all original comments and ordering are preserved.
- [ ] Given an external edit to the file, when saved, then the UI reflects it within 1s without a manual refresh.
- [ ] Given an invalid value entered in the UI, then it is flagged inline and cannot corrupt the file on save.
- [ ] Round-trip test suite: UI-driven mutation of every widget type produces YAML that re-parses to the expected semantic state.

**Risk:** This is genuinely fiddly. If perfect comment preservation proves too costly, the fallback is "UI owns a `dashboard.yaml`; comments preserved on untouched nodes only" — still better than every competitor. Time-box the spike to 1 week (see Open Questions).

---

## 8. Functional Requirements

### Must-Have (P0) — v1 cannot ship without these

| # | Requirement | Acceptance criteria |
|---|-------------|---------------------|
| F1 | YAML source of truth + visual editor round-trip | See §7 |
| F2 | Schema-validated config (Zod + JSON Schema export) | Invalid config surfaces a clear error; valid config never throws at runtime |
| F3 | Backend proxy for all service/HA API calls | API keys never appear in browser network tab; keys resolvable from env vars |
| F4 | Home Assistant integration (WebSocket live state + REST control) | Add entity tile via autocomplete; toggle updates live <1s; sensor tiles push-update |
| F5 | Core service widgets (~12–15): Jellyfin, Sonarr, Radarr, Prowlarr, qBittorrent, Immich, Paperless-ngx, Portainer/Docker stats, Uptime Kuma, Pi-hole/AdGuard, generic REST/ping, generic iframe | Each shows live data; configurable via UI and YAML |
| F6 | Docker label auto-discovery (read-only socket) | Labelled containers appear as tiles automatically |
| F7 | Drag-and-drop responsive layout (grid, groups/categories) | Layout persists to YAML; reflows at defined breakpoints |
| F8 | Theming via UI (color, background, light/dark, density) | No CSS required; persists to YAML |
| F9 | Bookmarks & quick links with icon picker (bundled icon packs) | Add/edit via UI; icon search |
| F10 | Single-container Docker deploy, env-var secrets, reverse-proxy friendly | `docker run` with one config volume works behind nginx + Cloudflare tunnel |

### Nice-to-Have (P1) — fast follows

- Widget SDK + docs (community integrations). *Promote toward P0 if breadth proves urgent.*
- Quick-search / command palette (services, bookmarks, HA entities).
- Weather, RSS, calendar, system-resource widgets.
- Config backup/restore + "export to repo" helper; visual diff of pending UI changes before save.
- Per-tile health/error states and retry.
- Import-from-homepage migration tool (parse existing `services.yaml`/`settings.yaml`).

### Future Considerations (P2) — design for, don't build

- Multi-user, RBAC, SSO (you've done Authentik before — keep the auth boundary clean).
- Multiple dashboards / per-device profiles (wall tablet vs desktop).
- HA template/automation triggers from tiles; conditional/templated tiles.
- Plugin marketplace.
- Status-history / time-series mini-charts per widget.

---

## 9. Home Assistant Integration (deep dive — the must-have)

- **Transport:** HA WebSocket API for live state (auth via long-lived access token, stored as env-referenced secret). Subscribe to `state_changed`; maintain an entity-state cache server-side; push deltas to clients.
- **Control:** REST `POST /api/services/<domain>/<service>` for actions (toggle, scene, script, etc.), proxied through the backend.
- **Config UX:** On connect, fetch entity registry → power **autocomplete** in the UI so users pick entities/areas by name, never hand-type IDs. This alone beats both competitors' HA UX.
- **Widget types:** entity state (sensor), toggle (light/switch), scene/script button, climate, media player, area summary.
- **Acceptance:** see F4. Plus: token never reaches the browser; reconnect with backoff if HA restarts.

---

## 10. Competitive Landscape

| | homepage | Homarr | Dashy | Glance | **Hearth (target)** |
|---|---|---|---|---|---|
| Config model | YAML only | DB/UI | YAML + partial UI | YAML | **YAML source of truth ⇄ full UI** |
| Visual editor | ❌ | ✅ | partial | ❌ | ✅ |
| GitOps / committable | ✅ | ❌ | ✅ | ✅ | ✅ |
| Comment/format-preserving round-trip | n/a | ❌ | ✗ (lossy) | n/a | ✅ **(the wedge)** |
| Live UI editing | ❌ (refresh) | ✅ | partial | ❌ | ✅ |
| HA integration | shallow widget | yes (limited) | limited | limited | **native, entity-aware** |
| Integration breadth | 100+ | many | many | feeds-focused | ~15 → SDK-grown |
| Docker discovery | ✅ | ✅ | partial | ✗ | ✅ |
| Out-of-box looks | good | excellent | good | minimal | target: best |

**Where we win:** the round-trip config model + HA depth + default polish.
**Where we're behind at launch:** integration breadth (mitigate with SDK + homepage import) and Homarr's mature UI polish (mitigate with strong design system from day one — lean on your frontend skill set).

---

## 11. Technical Architecture (proposed)

- **Frontend:** React + Vite + TypeScript (mirrors your Settle/Larder/Workbook pattern). Component-driven widget registry; Tailwind or a tokenised design system for themeability.
- **Backend:** Lightweight Node server (Fastify or Hono). Responsibilities: serve SPA, hold secrets, **proxy** all integration/HA calls, watch + read/write the YAML file, expose a config API + WebSocket for live state and config-change push.
- **Why not a static SPA like Settle:** the moment you touch HA, *arr, Jellyfin, etc. you have secrets + CORS. A server that proxies and holds tokens is non-optional. This is the one structural departure from your usual PWA pattern.
- **Widget model:** each widget = `{ schema (Zod), config UI component, data adapter, render component }`, registered in a central registry. New integration = implement those four. This is the abstraction that makes the SDK (P1) and round-trip validation (F2) fall out naturally.
- **Config:** single `hearth.yaml` (or a small set) in a bind-mounted volume. Env-var interpolation for secrets (`${HEARTH_*}`). JSON Schema published for external editor LSP/autocomplete.
- **Deploy:** single Docker image (AMD64/ARM64), one config volume, optional read-only Docker socket mount for discovery. Sits behind your existing nginx + Cloudflare tunnel.
- **Auth boundary:** v1 trusts the reverse proxy / network (no built-in login). Keep a clean middleware seam so Authentik/SSO drops in later (P2).

---

## 12. Success Metrics

**Leading (project health, since this is OSS not SaaS):**
- Time-to-first-useful-dashboard for a new user (target: < 10 min from `docker run` to live HA tile). Measure via your own onboarding + a couple of testers.
- Round-trip test suite pass rate = 100% before any release tag.
- "Configured without touching YAML" — can a P3 persona build a full dashboard UI-only? (binary success gate for v1).
- GitHub stars / forks trajectory vs Homarr's early curve (directional only).

**Lagging:**
- Community-contributed widgets via SDK (proxy for extensibility working): target ≥ 5 external contributions within 3 months of SDK release.
- Migration adoption: % of homepage users who try the import tool and stay.
- Issue ratio: config-corruption bugs per release → must trend to ~0 (the wedge depends on trust).

---

## 13. Open Questions

- **[ENG — blocking]** Spike: can `eemeli/yaml` Document API give us *lossless* comment + ordering preservation across all widget mutations? Time-box 1 week. If no, adopt the §7 fallback before committing to the architecture.
- **[ENG]** One `hearth.yaml` vs split files (settings / dashboard / secrets) like homepage? Single file is simpler for round-trip; split is friendlier for large configs. Decide before F1.
- **[ENG]** Docker socket exposure — read-only mount vs a socket-proxy sidecar for security-conscious users? Recommend documenting both.
- **[DESIGN]** Design system / component library choice up front — this determines whether we beat Homarr on polish. Decide before F7/F8.
- **[PRODUCT]** SDK timing: is breadth urgent enough to pull the Widget SDK into P0? Depends on whether early adopters are HA-led (P2 persona, breadth less urgent) or homelab-led (P1, breadth matters).
- **[PRODUCT]** License: MIT (like Homarr) vs something with a weak copyleft? Affects contribution + any future commercial option.

---

## 14. Suggested Phasing (months, not a sprint)

**Phase 0 — De-risk (1–2 weeks).** Round-trip YAML spike (§13). HA WebSocket proof: live state + one toggle. Decide architecture. *Gate: round-trip works or fallback chosen.*

**Phase 1 — Walking skeleton (v0.1).** Backend proxy + config API + file watcher. React shell + widget registry. 3 widgets: HA entity, generic link, generic REST. UI editor for those. Single-container deploy. *You can dogfood it on your own homelab here.*

**Phase 2 — v1 core.** All P0 widgets (F5), Docker discovery (F6), drag-and-drop layout (F7), theming (F8), bookmarks (F9), full round-trip test suite. Polish pass on default look.

**Phase 3 — Differentiate & grow (P1).** Widget SDK + docs. homepage import tool. Command palette. Weather/RSS/calendar/system widgets. Backup/restore + visual diff-before-save.

**Phase 4 — Beyond (P2, opportunistic).** Multi-dashboard/device profiles, auth/SSO seam, HA template triggers, plugin ecosystem.

---

## 15. Key Risks

1. **Round-trip fidelity** — the entire positioning rests on it. Mitigate: de-risk in Phase 0, have a fallback, never ship a release that can corrupt a user's file.
2. **Integration breadth gap vs homepage** — mitigate: SDK + import tool; compete on depth (HA) not count at launch.
3. **Design polish vs Homarr** — mitigate: invest in the design system early; this is a frontend strength you have.
4. **Scope creep** — the §4 non-goals and MoSCoW split are the guardrails. Any P0 addition must remove another or move the date.
5. **Solo/part-time bandwidth** — it's a months-long side project. The phasing is built so each phase is independently dogfoodable and shippable; don't let v1 balloon.
