// Ping — simplest possible adapter: GET the service URL, report up/down + latency.
// Use for anything without a real API integration (set PING_URL or a `url`
// on a service whose adapter/logo is "ping").
export default {
  key: "ping",
  label: "Ping",
  needs: ["PING_URL"],
  async fetch(cfg, { http }) {
    const t0 = Date.now();
    let status = "ok";
    try {
      const r = await http.raw(cfg.url, { method: "GET", redirect: "follow" });
      if (!r.ok && r.status >= 500) status = "error";
    } catch {
      status = "error";
    }
    const responseMs = Date.now() - t0;
    return {
      status,
      stats: [
        { key: "status", label: "Status", value: status === "ok" ? "Up" : "Down", format: "text" },
        { key: "responseMs", label: "Response", value: `${responseMs} ms`, format: "text" },
      ],
    };
  },
};
