// Sonarr (v3) — auth via X-Api-Key header.
export default {
  key: "sonarr",
  label: "Sonarr",
  needs: ["SONARR_URL", "SONARR_KEY"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const headers = { "X-Api-Key": cfg.key };
    const series = await cached("sonarr:series", 120_000, async () => {
      const list = await http.json(`${base}/api/v3/series`, { headers });
      return Array.isArray(list) ? list.length : 0;
    });
    const queue = await cached("sonarr:queue", 30_000, async () => {
      const q = await http.json(`${base}/api/v3/queue`, { headers, params: { pageSize: 1 } });
      return q.totalRecords ?? q.records?.length ?? 0;
    });
    return { status: "ok", stats: [
      { key: "series", label: "Series", value: series, format: "number" },
      { key: "queue", label: "Queue", value: queue, format: "number" },
    ] };
  },
};
