// Deluge (JSON-RPC v2) — auth via POST /json with method auth.login,
// session kept in a cookie. Reports transfer speeds + torrent counts.
// Env vars: DELUGE_URL, DELUGE_PASS (single password, no username needed)

const RPC_ID = { login: 1, transfer: 2, torrents: 3 };

export default {
  key: "deluge",
  label: "Deluge",
  needs: ["DELUGE_URL", "DELUGE_PASS"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const rpc   = `${base}/json`;

    // ── Session cookie (cached 30 min) ─────────────────────
    const cookie = await cached("deluge:sid", 1_800_000, async () => {
      const r = await http.raw(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ method: "auth.login", params: [cfg.pass || cfg.key], id: RPC_ID.login }),
      });
      if (!r.ok) throw new Error(`Deluge auth → HTTP ${r.status}`);
      const j = await r.json();
      if (!j.result) throw new Error("Deluge: auth.login returned false — check password");
      const sid = (r.headers.getSetCookie?.() || [])
        .map(c => c.split(";")[0]).find(c => c.toLowerCase().startsWith("_session_id="));
      if (!sid) throw new Error("Deluge: no session cookie returned");
      return sid;
    });

    const call = (method, params = []) =>
      http.json(rpc, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        cookie,
        body:    JSON.stringify({ method, params, id: RPC_ID[method] ?? 9 }),
      });

    // ── Transfer speeds ─────────────────────────────────────
    const transfer = await call("core.get_transfer_info");
    const info     = transfer?.result || {};

    // ── Torrent counts ──────────────────────────────────────
    const torrentRes = await call("core.get_torrents_status", ["", ["state"]]);
    const torrents   = torrentRes?.result || {};
    const list       = Object.values(torrents);
    const downloading = list.filter(t => t.state === "Downloading").length;
    const seeding     = list.filter(t => t.state === "Seeding").length;

    return {
      status: "ok",
      stats: [
        { key: "down",        label: "↓ Speed",     value: info.download_rate ?? 0, format: "speed"  },
        { key: "up",          label: "↑ Speed",     value: info.upload_rate   ?? 0, format: "speed"  },
        { key: "downloading", label: "Downloading", value: downloading,             format: "number" },
        { key: "seeding",     label: "Seeding",     value: seeding,                 format: "number" },
      ],
    };
  },
};
