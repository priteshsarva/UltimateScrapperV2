// Auto-derive brand mappings for the thousands of raw scraped brand spellings,
// using the canonical vocabulary the admin already defined in brand_map (the
// primary brands + the sub-brand spellings). For each unmapped raw brand:
//   - normalise it (lowercase, drop separators, collapse doubled letters), then
//   - find the longest leading word-group whose normalised form EXACTLY matches
//     a known canonical brand → that's the primary; the remaining words are the
//     sub-brand (cleaned through the known sub-brand spellings when possible).
// Conservative on purpose (exact normalised match, never overwrites a curated
// row) so it collapses the real duplicate families without wild guesses.
//
//   node portal/deriveBrandMap.js         # dry run: prints coverage + samples
//   node portal/deriveBrandMap.js --apply # writes the derived rows
import { query } from "./db.js";

const APPLY = process.argv.includes("--apply");

// normalise: lowercase, keep a-z0-9, collapse runs of the same char to one.
// Unifies "Nik.E"/"Nikee"/"Nikke"/"Nik_e" → "nike", "Role_x" → "rolex", etc.
const nk = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").replace(/(.)\1+/g, "$1");
const titleCase = (s) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

const map = await (async () => {
  const { rows } = await query(`select raw, canonical, secondary from brand_map`);
  const canonByKey = new Map(); // nk(primary) -> canonical display
  const secByKey = new Map();   // nk(secondary) -> secondary display
  const mappedRaw = new Set();  // raws already mapped (skip)
  for (const r of rows) {
    mappedRaw.add(String(r.raw).toLowerCase());
    if (r.canonical) canonByKey.set(nk(r.canonical), r.canonical);
    if (r.secondary) secByKey.set(nk(r.secondary), r.secondary);
  }
  return { canonByKey, secByKey, mappedRaw };
})();

// derive { primary, secondary } for a raw brand, or null if no confident match
function derive(raw) {
  const words = String(raw).trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  // longest leading word-group that normalises to a known primary brand
  for (let wc = Math.min(4, words.length); wc >= 1; wc--) {
    const key = nk(words.slice(0, wc).join(""));
    const primary = map.canonByKey.get(key);
    if (!primary) continue;
    // remaining words = sub-brand candidate
    let rest = words.slice(wc).join(" ").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
    if (rest.length <= 1) return { primary, secondary: null }; // garbled single-letter tail
    const secondary = map.secByKey.get(nk(rest)) || titleCase(rest);
    return { primary, secondary };
  }
  return null;
}

const known = (await query(`select raw_lower, raw from known_brands`)).rows;
const derived = [];
let skippedMapped = 0, unmatched = 0;
for (const b of known) {
  if (map.mappedRaw.has(b.raw_lower)) { skippedMapped++; continue; }
  const d = derive(b.raw);
  if (!d) { unmatched++; continue; }
  derived.push([b.raw_lower, d.primary, d.secondary]);
}

console.log(`known brands: ${known.length}`);
console.log(`  already mapped (curated): ${skippedMapped}`);
console.log(`  newly derived: ${derived.length}`);
console.log(`  still unmatched (junk / unknown brand): ${unmatched}`);
console.log(`\nsample derived:`);
for (const [raw, p, s] of derived.slice(0, 30)) console.log(`  ${raw}  ->  ${p}${s ? ` · ${s}` : ""}`);

if (APPLY && derived.length) {
  // chunked upsert; DO NOTHING so curated rows are never overwritten
  for (let i = 0; i < derived.length; i += 500) {
    const chunk = derived.slice(i, i + 500);
    const vals = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(",");
    const params = chunk.flatMap(([raw, p, s]) => [raw, p, s]);
    await query(`insert into brand_map (raw, canonical, secondary) values ${vals} on conflict (raw) do nothing`, params);
  }
  console.log(`\napplied ${derived.length} derived mappings.`);
} else if (!APPLY) {
  console.log(`\n(dry run — re-run with --apply to write these)`);
}
process.exit(0);
