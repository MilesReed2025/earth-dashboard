// SSL certificate expiry — opens a raw TLS socket to read the peer cert's
// valid_to date. rejectUnauthorized is intentionally off: we want the expiry
// of self-signed/internal-CA certs too, this is not a trust check.
import { connect } from "node:tls";

export function getCertExpiry(hostname, port) {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 8000 },
      () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert || !cert.valid_to) return reject(new Error("no certificate returned"));
        resolve({
          validTo: new Date(cert.valid_to),
          issuer: cert.issuer?.O || cert.issuer?.CN || "Unknown",
        });
      }
    );
    socket.on("error", reject);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("TLS connect timeout"));
    });
  });
}

function parseHostPort(url) {
  const host = (url || "").replace(/^https?:\/\//, "").split("/")[0];
  const [hostname, portStr] = host.split(":");
  return { hostname, port: Number(portStr) || 443 };
}

export default {
  key: "sslcheck",
  label: "SSL Certificate",
  needs: ["SSLCHECK_HOST"],
  async fetch(cfg, { cached }) {
    const { hostname, port } = parseHostPort(cfg.url);
    const info = await cached(`sslcheck:${hostname}:${port}`, 3_600_000, () => getCertExpiry(hostname, port));
    const daysLeft = Math.floor((info.validTo - Date.now()) / 86_400_000);
    return {
      status: daysLeft < 0 ? "error" : "ok",
      stats: [
        { key: "daysLeft", label: "Expires in", value: `${daysLeft} day${daysLeft === 1 ? "" : "s"}`, format: "text" },
        { key: "validTo", label: "Valid until", value: info.validTo.toISOString().slice(0, 10), format: "text" },
        { key: "issuer", label: "Issuer", value: info.issuer, format: "text" },
      ],
    };
  },
};
