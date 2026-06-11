// Radarr (v3) — auth via X-Api-Key header.
export default {
  key: "radarr",
  label: "Radarr",
  needs: ["RADARR_URL", "RADARR_KEY"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const headers = { "X-Api-Key": cfg.key };
    const movies = await cached("radarr:movies", 120_000, async () => {
      const list = await http.json(`${base}/api/v3/movie`, { headers });
      return Array.isArray(list) ? list.length : 0;
    });
    const queue = await cached("radarr:queue", 30_000, async () => {
      const q = await http.json(`${base}/api/v3/queue`, { headers, params: { pageSize: 1 } });
      return q.totalRecords ?? q.records?.length ?? 0;
    });
    return { status: "ok", stats: [
      { key: "movies", label: "Movies", value: movies, format: "number" },
      { key: "queue", label: "Queue", value: queue, format: "number" },
    ] };
  },
};
