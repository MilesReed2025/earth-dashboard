// Small HTTP helper handed to every adapter. Covers the auth styles real
// services use: query-param keys, header keys, basic auth, and cookie
// sessions (raw() exposes the response so adapters can read Set-Cookie).
export function makeHttp() {
  function build(url, params) {
    const u = new URL(url);
    if (params) for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
    return u;
  }
  async function json(url, { params, headers, method = "GET", body, cookie } = {}) {
    const h = { Accept: "application/json", ...(headers || {}) };
    if (cookie) h.Cookie = cookie;
    const r = await fetch(build(url, params), { method, headers: h, body });
    if (!r.ok) throw new Error(`${new URL(url).pathname} → HTTP ${r.status}`);
    const ct = r.headers.get("content-type") || "";
    return ct.includes("json") ? r.json() : r.text();
  }
  async function raw(url, { params, ...opts } = {}) {
    return fetch(build(url, params), opts);
  }
  return { json, raw };
}
