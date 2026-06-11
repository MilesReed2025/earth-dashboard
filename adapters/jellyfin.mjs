// Jellyfin — auth via ?api_key=. Films count, library size (paged sum of
// MediaSources, cached hourly), and latest movie added.
function uid(base, key, http, cached) {
  return cached("jellyfin:uid", 3_600_000, async () => {
    const users = await http.json(`${base}/Users`, { params: { api_key: key } });
    const admin = users.find((u) => u.Policy?.IsAdministrator) || users[0];
    if (!admin) throw new Error("no Jellyfin users for this key");
    return admin.Id;
  });
}

export default {
  key: "jellyfin",
  label: "Jellyfin",
  needs: ["JELLYFIN_URL", "JELLYFIN_KEY"],
  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const api_key = cfg.key;
    const items = `${base}/Users/${await uid(base, api_key, http, cached)}/Items`;

    const movies = await cached("jellyfin:movies", 60_000, async () => {
      // Use /Items/Counts for the real server-wide total — the per-user
      // Items endpoint only returns movies visible to that user, which can
      // under-count if the admin account has library filters applied.
      const counts = await http.json(`${base}/Items/Counts`, { params: { api_key } })
        .catch(() => null);
      if (counts?.MovieCount != null) return counts.MovieCount;
      // Fallback: per-user query (pre-10.8 servers don't have /Items/Counts)
      const d = await http.json(items, { params: { api_key, Recursive: "true", IncludeItemTypes: "Movie", Limit: "0" } });
      return d.TotalRecordCount ?? 0;
    });
    const latest = await cached("jellyfin:latest", 60_000, async () => {
      const d = await http.json(items, { params: {
        api_key, Recursive: "true", IncludeItemTypes: "Movie",
        SortBy: "DateCreated,SortName", SortOrder: "Descending", Limit: "1", Fields: "DateCreated,ProductionYear",
      } });
      const it = d.Items?.[0];
      return it ? { name: it.Name, year: it.ProductionYear ?? null, date: it.DateCreated ?? null } : null;
    });
    const size = await cached("jellyfin:size", 3_600_000, async () => {
      let total = 0, start = 0; const page = 200;
      for (;;) {
        const d = await http.json(items, { params: {
          api_key, Recursive: "true", IncludeItemTypes: "Movie", Fields: "MediaSources",
          Limit: String(page), StartIndex: String(start),
        } });
        for (const it of d.Items ?? []) for (const ms of it.MediaSources ?? []) total += ms.Size || 0;
        start += page;
        if (start >= (d.TotalRecordCount ?? 0)) break;
      }
      return total;
    });

    const stats = [
      { key: "movies", label: "Films", value: movies, format: "number" },
      { key: "size", label: "Library", value: size, format: "bytes" },
    ];
    if (latest)
      stats.push({ key: "latest", label: "Latest",
        value: `${latest.name}${latest.year ? ` (${latest.year})` : ""}`, format: "text", meta: latest.date });
    return { status: "ok", stats };
  },
};
