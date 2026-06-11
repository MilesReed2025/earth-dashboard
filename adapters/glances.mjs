// Glances REST API v3 — system monitoring
// Glances must be started with: glances -w
// Set GLANCES_URL=http://host:61208 in .env (no auth needed by default).
// If you've set a password, also set GLANCES_USER and GLANCES_PASS.

export default {
  key: "glances",
  label: "System",
  needs: ["GLANCES_URL"],

  async fetch(cfg, { http, cached }) {
    const base = cfg.url.replace(/\/+$/, "");
    const api  = `${base}/api/3`;

    // Basic-auth header (optional — only sent if user+pass are set)
    const authHeader = cfg.user && cfg.pass
      ? { Authorization: `Basic ${Buffer.from(`${cfg.user}:${cfg.pass}`).toString("base64")}` }
      : {};

    // Glances can return HTTP 200 with {"error": "Plugin not available"} — treat as null
    const get = async (path) => {
      const res = await http.json(`${api}/${path}`, { headers: authHeader });
      if (res && typeof res === "object" && "error" in res) return null;
      return res;
    };

    // Parallel fetch — fastest possible response
    const [cpu, mem, load, fsArr, uptime, netArr] = await Promise.all([
      get("cpu").catch(() => null),
      get("mem").catch(() => null),
      get("load").catch(() => null),
      get("fs").catch(() => null),
      get("uptime").catch(() => null),
      get("network").catch(() => null),
    ]);

    const stats = [];

    // CPU
    if (cpu != null) {
      const pct = typeof cpu === "number" ? cpu : (cpu.total ?? 0);
      stats.push({ key: "cpu", label: "CPU", value: pct, format: "percent", bar: true });
    }

    // RAM
    if (mem != null) {
      const pct  = mem.percent ?? 0;
      const used = mem.used   ?? 0;
      const tot  = mem.total  ?? 0;
      stats.push({
        key: "mem", label: "RAM", value: pct, format: "percent", bar: true,
        sub: tot ? `${fmtBytes(used)} / ${fmtBytes(tot)}` : null,
      });
    }

    // Primary disk (root or largest mount)
    if (Array.isArray(fsArr) && fsArr.length) {
      const root = fsArr.find(f => f.mnt_point === "/") || fsArr[0];
      stats.push({
        key: "disk", label: "Disk", value: root.percent ?? 0, format: "percent", bar: true,
        sub: root.size ? `${fmtBytes(root.used)} / ${fmtBytes(root.size)}` : null,
      });
    }

    // Load (1-min)
    if (load != null) {
      stats.push({
        key: "load", label: "Load",
        value: `${fmt1(load.min1)} ${fmt1(load.min5)} ${fmt1(load.min15)}`,
        format: "text",
      });
    }

    // Network (sum across active interfaces, excluding loopback)
    if (Array.isArray(netArr) && netArr.length) {
      const ifaces = netArr.filter(n =>
        n.interface_name !== "lo" && !n.interface_name.startsWith("lo")
      );
      if (ifaces.length) {
        const rxSum = ifaces.reduce((s, n) => s + (n.rx ?? 0), 0);
        const txSum = ifaces.reduce((s, n) => s + (n.tx ?? 0), 0);
        stats.push({ key: "net_rx", label: "Net ↓", value: rxSum, format: "speed" });
        stats.push({ key: "net_tx", label: "Net ↑", value: txSum, format: "speed" });
      }
    }

    // Uptime (last — decorative)
    if (uptime) {
      const u = typeof uptime === "string" ? uptime : String(uptime);
      stats.push({ key: "uptime", label: "Uptime", value: u.replace(/\s+\d+:\d+:\d+$/, "").trim() || u, format: "text" });
    }

    return { status: "ok", stats };
  },
};

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9)  return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6)  return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1e3)  return `${(n / 1e3).toFixed(1)} kB`;
  return `${n} B`;
}
function fmt1(n) { return Number(n || 0).toFixed(2); }
