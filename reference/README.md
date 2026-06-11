# Hearth — Phase 0 De-Risk Spike

Two runnable proofs for the riskiest assumptions in the Hearth PRD, **before** committing to the architecture.

## What this answers

1. **Can the UI mutate config and write back YAML without wrecking it?**
   (comments, ordering, anchors, flow style, env-var secrets)
2. **Can we do the full Home Assistant loop** — auth, live state, real-time
   updates, and two-way control — over the WebSocket API?

## Setup

```bash
npm install        # installs `yaml` (eemeli) + `ws`
```

Requires Node 18+ (tested on Node 22).

---

## 1. YAML round-trip proof  ✅ PASSING (28/28)

```bash
npm run yaml
```

Loads `yaml-roundtrip/sample.config.yaml` (deliberately full of comments,
non-alphabetical ordering, a `&refresh` anchor + merge alias, flow-style maps,
and `${ENV}` secret refs), then performs six **UI-equivalent edits**:

1. change a scalar (theme colour)
2. toggle an enum (density)
3. add a widget to a list
4. reorder widgets (drag-and-drop)
5. rename a nested value
6. delete a widget

…and asserts what survived the round-trip.

### Verdict

The `yaml` Document/CST API preserves **everything** that matters:
comments (block + inline), key ordering, anchors/aliases, flow style, and
untouched `${ENV}` secret references. Deleting a node correctly removes the
comment attached to it. **The core product bet is viable on the happy path.**

### One implementation note the spike surfaced

Merge keys (`<<: *refresh`) round-trip perfectly **as text**, but the runtime
loader only *resolves* the inherited values when you parse with
`{ merge: true }`. The Hearth config loader must set this. Without it,
`refreshSeconds` inherited via `<<` comes back `undefined`.

### Honest limits (decide before Phase 1)

- Blank-line ("spaceBefore") preservation is good for untouched nodes but not
  guaranteed around newly inserted ones — verify against your own real config.
- Single-file vs split-file config is still an open question (see PRD §13).
- Conflict policy on simultaneous UI + external edit is last-write-wins for v1;
  this spike doesn't implement the "warn before overwrite" guard yet.

---

## 2. Home Assistant WebSocket probe  ⏳ READY (point it at your HA)

```bash
cp ha-ws/.env.example ha-ws/.env     # then edit it
export HA_URL="http://homeassistant.local:8123"
export HA_TOKEN="<long-lived token: HA → profile → Security → create token>"
export HA_TOGGLE_ENTITY="light.kitchen"   # optional — proves control
npm run ha
```

Does the exact transport the Hearth backend will use (server-side, so the
token never reaches the browser):

1. WebSocket auth handshake (`auth_required` → `auth` → `auth_ok`)
2. `get_states` — full entity snapshot (a fresh dashboard load)
3. `subscribe_events: state_changed` — live deltas stream to the console
4. *(optional)* `call_service homeassistant.toggle` — fire a control command,
   then watch the `⚡` delta confirm the state actually changed

If you see `✓ authenticated`, the entity count, and live `⚡` lines when you
flip something in the HA app, the HA half of the thesis is proven too.

---

## Files

```
package.json                     # npm run yaml | npm run ha
yaml-roundtrip/
  sample.config.yaml             # torture-test config
  roundtrip.test.mjs             # the proof (28 assertions)
ha-ws/
  ha-probe.mjs                   # HA WebSocket probe
  .env.example
```
