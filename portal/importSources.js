// One-time import of your static SITES_REGISTRY into Supabase `sources`.
//   node portal/importSources.js
// Read-only on your code. Safe to re-run (upserts). Surfaces duplicate ids
// and malformed entries so you can verify parity before cutting over.
import "dotenv/config";
import { pool } from "./db.js";
import { upsertSource } from "./sources.js";
import { SITES_REGISTRY } from "../config/sites.js"; // <-- adjust path if needed

// ---- field mapping: edit if your registry uses different key names ----
const mapEntry = (s) => ({
  id:         s.id,
  name:       s.name ?? s.id,
  category:   s.category,                                  // 'shoes' | 'watches'
  method:     s.method,                                    // 'METHOD_A' | 'METHOD_B'
  base_url:   s.base_url ?? s.baseUrl ?? null,
  search_key: s.searchKey ?? s.search_key ?? s.id,         // productFetchedFrom LIKE
  status:     s.status ?? "active",
});

// --- pre-scan for problems (the watchflex dup id should show up here) ---
const seen = new Set();
const dups = new Set();
const bad = [];
for (const raw of SITES_REGISTRY) {
  const s = mapEntry(raw);
  if (!s.id || !s.category || !s.method) { bad.push(raw); continue; }
  if (seen.has(s.id)) dups.add(s.id);
  seen.add(s.id);
}
if (dups.size) console.warn("⚠️  Duplicate ids (last one wins on upsert):", [...dups]);
if (bad.length) console.warn(`⚠️  ${bad.length} entr${bad.length === 1 ? "y" : "ies"} missing id/category/method — skipped. First:`, bad[0]);

// --- import ---
let ok = 0;
for (const raw of SITES_REGISTRY) {
  const s = mapEntry(raw);
  if (!s.id || !s.category || !s.method) continue;
  try { await upsertSource(s); ok++; }
  catch (e) { console.error("Failed:", s.id, e.message); }
}
console.log(`✅ Imported/updated ${ok} sources (registry had ${SITES_REGISTRY.length} entries, ${seen.size} unique ids).`);

await pool.end();
process.exit(0);
