// qBittorrent (Web API v2) — auth is a cookie session: POST /auth/login,
// capture the SID cookie, reuse it. Reports transfer speeds + torrent counts.
const ACTIVE = ["downloading", "uploading", "forcedDL", "forcedUP", "stalledUP", "stalledDL"];

export default {
  key: "qbittorrent",
  label: "qBittorrent",
  needs: ["QBITTORRENT_URL", "QBITTORRENT_USER", "QBITTORRENT_PASS"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const cookie = await cached("qbittorrent:sid", 1_800_000, async () => {
      const r = await http.raw(`${base}/api/v2/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: base },
        body: new URLSearchParams({ username: cfg.user, password: cfg.pass }).toString(),
      });
      if (!r.ok) throw new Error(`qbittorrent login → HTTP ${r.status}`);
      const sid = (r.headers.getSetCookie?.() || [])
        .map((c) => c.split(";")[0]).find((c) => c.startsWith("SID="));
      if (!sid) throw new Error("qbittorrent: no SID cookie (check host whitelist / creds)");
      return sid;
    });

    const info = await http.json(`${base}/api/v2/transfer/info`, { cookie });
    const torrents = await http.json(`${base}/api/v2/torrents/info`, { cookie });
    const list = Array.isArray(torrents) ? torrents : [];
    const active = list.filter((t) => ACTIVE.includes(t.state)).length;

    return { status: "ok", stats: [
      { key: "down", label: "Down", value: info.dl_info_speed ?? 0, format: "speed" },
      { key: "up", label: "Up", value: info.up_info_speed ?? 0, format: "speed" },
      { key: "active", label: "Active", value: active, format: "number", meta: `${list.length} total` },
    ] };
  },
};
