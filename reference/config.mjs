// Resolve a service's config from env vars by convention:
//   <SERVICE>_URL, <SERVICE>_KEY (or _TOKEN), <SERVICE>_USER, <SERVICE>_PASS
// e.g. JELLYFIN_URL, RADARR_KEY, QBITTORRENT_USER/_PASS.
// A service is "enabled" iff its _URL is set — so configuring it is opt-in,
// and secrets live in the environment, never in committed config.
export function serviceConfig(key) {
  const U = key.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const e = process.env;
  return {
    url: e[`${U}_URL`],
    key: e[`${U}_KEY`] || e[`${U}_TOKEN`],
    user: e[`${U}_USER`],
    pass: e[`${U}_PASS`],
  };
}

export const isEnabled = (cfg) => Boolean(cfg.url);
