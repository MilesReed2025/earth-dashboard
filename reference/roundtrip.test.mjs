// Hearth Phase-0 spike — YAML round-trip proof
// Question being answered: can the UI mutate config and write back YAML
// WITHOUT destroying comments, key ordering, anchors, or flow style?
//
// Strategy: parse with the Document (CST-backed) API, mutate via node paths
// exactly as the UI editor would, re-serialise, and assert what survived.
//
// Run: node yaml-roundtrip/roundtrip.test.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseDocument, parse } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(here, "sample.config.yaml"), "utf8");

// ---- helpers ---------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  (cond ? pass++ : fail++);
  console.log(`  ${cond ? "✅" : "❌"} ${name}${extra ? "  — " + extra : ""}`);
};
const commentsOf = (s) =>
  s.split("\n").map(l => l.trim()).filter(l => l.startsWith("#") || l.includes(" #") || l.includes("\t#"))
    // normalise: pull just the comment text after the first '#'
    .map(l => "#" + l.split("#").slice(1).join("#").trimEnd());

// ---- parse -----------------------------------------------------------------
const doc = parseDocument(SRC);
if (doc.errors.length) { console.error("PARSE ERRORS:", doc.errors); process.exit(1); }

// ============================================================================
// Simulate the UI editor performing six real edits.
// ============================================================================

// 1. Change a scalar (theme accent — colour picker in the UI)
doc.setIn(["settings", "theme", "accent"], "#3b82e8"); // ember -> blue

// 2. Toggle a boolean-ish enum (density toggle)
doc.setIn(["settings", "theme", "density"], "compact");

// 3. Add a new widget to the Media group (the formatting-risky one)
const mediaWidgets = doc.getIn(["dashboard", "groups", 1, "widgets"], true);
const newWidget = doc.createNode({
  type: "immich",
  url: "http://immich.local:2283",
  label: "Photos",
});
mediaWidgets.add(newWidget);

// 4. Reorder Smart Home widgets (drag-and-drop: swap the two tiles)
const homeWidgets = doc.getIn(["dashboard", "groups", 0, "widgets"], true);
[homeWidgets.items[0], homeWidgets.items[1]] = [homeWidgets.items[1], homeWidgets.items[0]];

// 5. Edit a nested value (rename the HA sensor's friendly label)
//    After the swap, the temp sensor is now at index 1.
doc.setIn(["dashboard", "groups", 0, "widgets", 1, "label"], "Forth Sea Temp");

// 6. Delete a widget (remove the Sonarr tile)
mediaWidgets.items = mediaWidgets.items.filter(
  (w) => w.get("type") !== "sonarr"
);

// ---- serialise back --------------------------------------------------------
const OUT = doc.toString();

console.log("\n================ OUTPUT YAML ================\n");
console.log(OUT);
console.log("=============================================\n");

// ============================================================================
// ASSERTIONS
// ============================================================================
console.log("ROUND-TRIP ASSERTIONS\n");

// --- comment preservation ---
const inComments = commentsOf(SRC);
const outComments = commentsOf(OUT);

// Comments we expect to SURVIVE (their nodes were untouched or only value-edited)
const survivors = [
  "# Hearth dashboard config",
  "# Keep this file readable",
  "# Shared defaults referenced below",
  "# how often live widgets poll",
  "theme is intentionally first",   // full line is "# NOTE: theme is intentionally first…"
  "# warm ember",                   // attached to accent value we edited
  "# browser tab + header",
  "# Home Assistant lives here",
  "# friendly name shown on the tile",
  "# the one my partner actually uses",
  "kept tile — this secret must survive",
  "# flow style on purpose",
];
for (const c of survivors) {
  ok(`comment preserved: "${c}"`, OUT.includes(c));
}

// The Sonarr widget was deleted — its inline secret comment should go WITH it.
ok("deleted tile's comment removed with it (correct)", !OUT.includes("never committed plaintext"));
ok("sonarr tile actually removed", !OUT.includes("sonarr"));

// --- ordering preservation ---
// settings.theme must still come before settings.title; theme.mode before accent.
const themeBeforeTitle = OUT.indexOf("theme:") < OUT.indexOf("title:");
ok("settings key order preserved (theme before title)", themeBeforeTitle);
const modeBeforeAccent = OUT.indexOf("mode:") < OUT.indexOf("accent:");
ok("nested key order preserved (mode before accent)", modeBeforeAccent);

// --- anchor / alias preservation ---
ok("anchor &refresh preserved", OUT.includes("&refresh"));
ok("alias *refresh preserved (merge key)", OUT.includes("*refresh"));

// --- flow style preservation ---
ok("flow-style bookmark preserved", /\{\s*name: Gitea/.test(OUT));

// --- env-var secret on a KEPT tile left untouched ---
ok("env-var secret on kept tile intact", OUT.includes("${HEARTH_JELLYFIN_KEY}"));
ok("env-var secret on deleted tile gone (correct)", !OUT.includes("${HEARTH_SONARR_KEY}"));

// --- SEMANTIC correctness (re-parse and check the data) ---
// NB: merge keys (<<) only RESOLVE at load time with { merge: true }.
const re = parse(OUT, { merge: true });
ok("accent value updated", re.settings.theme.accent === "#3b82e8");
ok("density value updated", re.settings.theme.density === "compact");
ok("new immich widget added", re.dashboard.groups[1].widgets.some(w => w.type === "immich"));
ok("widgets reordered (toggle now first)", re.dashboard.groups[0].widgets[0].type === "ha.toggle");
ok("nested label renamed", re.dashboard.groups[0].widgets[1].label === "Forth Sea Temp");
// The ha.entity tile (now index 1) carries <<: *refresh, so it inherits refreshSeconds.
ok("merge key resolved with {merge:true} (refresh inherited)",
   re.dashboard.groups[0].widgets[1].refreshSeconds === 30);
// And without the flag it is NOT resolved — the implementation must opt in.
const reNoMerge = parse(OUT);
ok("merge NOT resolved without the flag (documented gotcha)",
   reNoMerge.dashboard.groups[0].widgets[1].refreshSeconds === undefined);

// --- comment count sanity ---
console.log(`\n  comments in:  ${inComments.length}`);
console.log(`  comments out: ${outComments.length}  (one fewer expected — sonarr's was deleted with its tile)`);

// ---- verdict ---------------------------------------------------------------
console.log(`\n${"=".repeat(45)}`);
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("=".repeat(45));
process.exit(fail === 0 ? 0 : 1);
