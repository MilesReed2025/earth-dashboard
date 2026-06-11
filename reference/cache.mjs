// Shared TTL cache. Adapters use this to avoid hammering services —
// cheap stats get a short TTL, expensive ones (e.g. library size) a long one.
const store = new Map(); // key -> { value, exp }

export function cached(key, ttl, fn) {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return Promise.resolve(hit.value);
  return Promise.resolve(fn()).then((v) => {
    store.set(key, { value: v, exp: Date.now() + ttl });
    return v;
  });
}

export function clearCache() { store.clear(); }
