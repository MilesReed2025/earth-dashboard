// AdGuard Home — auth via HTTP basic. DNS queries + blocked today.
export default {
  key: "adguard",
  label: "AdGuard Home",
  needs: ["ADGUARD_URL", "ADGUARD_USER", "ADGUARD_PASS"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const auth = "Basic " + Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64");
    const s = await cached("adguard:stats", 60_000, () =>
      http.json(`${base}/control/stats`, { headers: { Authorization: auth } }));
    const total = s.num_dns_queries ?? 0;
    const blocked = s.num_blocked_filtering ?? 0;
    return { status: "ok", stats: [
      { key: "queries", label: "Queries", value: total, format: "number" },
      { key: "blocked", label: "Blocked", value: blocked, format: "number" },
      { key: "rate", label: "Block rate", value: total ? (blocked / total) * 100 : 0, format: "percent" },
    ] };
  },
};
