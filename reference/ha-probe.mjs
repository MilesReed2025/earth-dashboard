// Hearth Phase-0 spike — Home Assistant WebSocket probe
// Question being answered: can we authenticate, pull live entity state,
// subscribe to real-time changes, AND fire a control command — the full
// loop a tile needs — over HA's WebSocket API?
//
// This is the exact transport the Hearth backend will use (server-side,
// so the long-lived token never reaches the browser).
//
// Usage:
//   export HA_URL="http://homeassistant.local:8123"
//   export HA_TOKEN="<long-lived access token from your HA profile>"
//   export HA_TOGGLE_ENTITY="light.kitchen"   # optional: proves control
//   node ha-ws/ha-probe.mjs
//
// Token: HA → your profile → Security → "Long-lived access tokens" → Create.

import WebSocket from "ws";

const HA_URL = process.env.HA_URL;
const HA_TOKEN = process.env.HA_TOKEN;
const TOGGLE = process.env.HA_TOGGLE_ENTITY || null;

if (!HA_URL || !HA_TOKEN) {
  console.error("Set HA_URL and HA_TOKEN env vars first. See header for details.");
  process.exit(1);
}

// http(s)://host:8123  ->  ws(s)://host:8123/api/websocket
const wsUrl =
  HA_URL.replace(/^http/, "ws").replace(/\/+$/, "") +
  (HA_URL.includes("/api/websocket") ? "" : "/api/websocket");

console.log(`→ connecting to ${wsUrl}`);
const ws = new WebSocket(wsUrl);

// Simple id-keyed command tracker (HA requires monotonically increasing ids).
let nextId = 1;
const pending = new Map();
function send(msg) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ ...msg, id }));
  });
}

let authed = false;

ws.on("open", () => console.log("✓ socket open, waiting for auth handshake…"));

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());

  // --- auth handshake (no id on these frames) ---
  if (msg.type === "auth_required") {
    console.log(`✓ HA ${msg.ha_version} requires auth — sending token`);
    ws.send(JSON.stringify({ type: "auth", access_token: HA_TOKEN }));
    return;
  }
  if (msg.type === "auth_invalid") {
    console.error("✗ auth_invalid — token rejected:", msg.message);
    ws.close();
    process.exit(1);
  }
  if (msg.type === "auth_ok") {
    authed = true;
    console.log("✓ authenticated\n");
    await runProbe();
    return;
  }

  // --- command results ---
  if (msg.type === "result" && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.success ? resolve(msg.result) : reject(msg.error);
    return;
  }

  // --- subscribed live events ---
  if (msg.type === "event") {
    const c = msg.event?.data;
    if (c?.entity_id) {
      const from = c.old_state?.state ?? "∅";
      const to = c.new_state?.state ?? "∅";
      console.log(`  ⚡ ${c.entity_id}: ${from} → ${to}`);
    }
  }
});

ws.on("error", (e) => console.error("✗ socket error:", e.message));
ws.on("close", () => { if (authed) console.log("\n→ socket closed"); });

async function runProbe() {
  // 1. Pull all current states (what a fresh dashboard load does).
  const states = await send({ type: "get_states" });
  console.log(`✓ get_states: ${states.length} entities`);
  const sample = states.slice(0, 5).map(s => `    ${s.entity_id} = ${s.state}`);
  console.log("  first few:\n" + sample.join("\n") + "\n");

  // 2. Subscribe to live changes (what keeps tiles current with zero polling).
  await send({ type: "subscribe_events", event_type: "state_changed" });
  console.log("✓ subscribed to state_changed — live deltas will stream below.\n");

  // 3. (Optional) fire a control command and watch the change echo back live.
  if (TOGGLE) {
    const domain = TOGGLE.split(".")[0];
    console.log(`→ toggling ${TOGGLE} via homeassistant.toggle …`);
    await send({
      type: "call_service",
      domain: "homeassistant",
      service: "toggle",
      target: { entity_id: TOGGLE },
    });
    console.log(`✓ toggle command accepted (domain inferred: ${domain})`);
    console.log("  watch for the ⚡ state delta confirming it actually changed.\n");
  } else {
    console.log("ℹ set HA_TOGGLE_ENTITY to also prove two-way control.\n");
  }

  console.log("Listening for live events… (Ctrl-C to stop)");
}

// Keepalive: HA closes idle sockets; ping every 30s.
setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30_000);
