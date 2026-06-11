// Auto-discovers adapters: every *.mjs in ../adapters that default-exports
// an object with { key, fetch() } is registered. Add a service = drop a file.
import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const adaptersDir = join(here, "..", "adapters");

export async function loadAdapters() {
  const files = (await readdir(adaptersDir)).filter((f) => f.endsWith(".mjs"));
  const map = new Map();
  for (const f of files) {
    const mod = await import(pathToFileURL(join(adaptersDir, f)).href);
    const a = mod.default;
    if (a?.key && typeof a.fetch === "function") map.set(a.key, a);
    else console.warn(`skipping ${f}: missing key or fetch()`);
  }
  return map;
}
