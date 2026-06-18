// Uptime Kuma — reads a public status-page (no auth needed). Create a status
// page in Kuma listing the monitors to expose, then set its slug as `apiKey`
// in earth.yaml (or UPTIMEKUMA_KEY in .env).
export default {
  key: "uptimekuma",
  label: "Uptime Kuma",
  needs: ["UPTIMEKUMA_URL", "UPTIMEKUMA_KEY"],
  async fetch(cfg, { http, cached }) {
    const base = (cfg.url || "").replace(/\/+$/, "");
    const slug = cfg.key; // status-page slug, smuggled through the shared "key" field
    if (!slug) throw new Error("missing status-page slug (apiKey/UPTIMEKUMA_KEY)");

    let page, heartbeat;
    try {
      [page, heartbeat] = await Promise.all([
        cached(`uptimekuma:page:${slug}`, 60_000, () => http.json(`${base}/api/status-page/${slug}`)),
        cached(`uptimekuma:hb:${slug}`, 60_000, () => http.json(`${base}/api/status-page/heartbeat/${slug}`)),
      ]);
    } catch (e) {
      if (String(e.message).includes("401")) {
        throw new Error("status page may be password-protected; use an unprotected page");
      }
      throw e;
    }

    const monitors = (page.publicGroupList || []).flatMap((g) => g.monitorList || []);
    const heartbeatList = heartbeat.heartbeatList || {};

    let upCount = 0;
    let pingSum = 0;
    let pingCount = 0;
    for (const m of monitors) {
      const beats = heartbeatList[m.id] || [];
      const last = beats[beats.length - 1];
      if (last?.status === 1) {
        upCount++;
        if (typeof last.ping === "number") {
          pingSum += last.ping;
          pingCount++;
        }
      }
    }
    const total = monitors.length;
    const uptimePct = total ? (upCount / total) * 100 : 0;

    const stats = [
      { key: "up", label: "Monitors up", value: `${upCount}/${total}`, format: "text" },
      { key: "uptimePct", label: "Uptime", value: uptimePct, format: "percent", bar: true },
    ];
    if (pingCount) {
      stats.push({ key: "avgPing", label: "Avg ping", value: Math.round(pingSum / pingCount), format: "text", sub: "ms" });
    }

    return { status: "ok", stats };
  },
};
