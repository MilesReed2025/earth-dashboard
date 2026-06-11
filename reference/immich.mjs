// Immich — auth via x-api-key (admin key). Endpoint moved between versions,
// so we try the current path and fall back to the older one.
export default {
  key: "immich",
  label: "Immich",
  needs: ["IMMICH_URL", "IMMICH_KEY"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const headers = { "x-api-key": cfg.key };
    const s = await cached("immich:stats", 300_000, async () => {
      try { return await http.json(`${base}/api/server/statistics`, { headers }); }
      catch { return await http.json(`${base}/api/server-info/statistics`, { headers }); }
    });
    return { status: "ok", stats: [
      { key: "photos", label: "Photos", value: s.photos ?? 0, format: "number" },
      { key: "videos", label: "Videos", value: s.videos ?? 0, format: "number" },
      { key: "usage", label: "Usage", value: s.usage ?? 0, format: "bytes" },
    ] };
  },
};
