// Global brand mapping (super-admin managed). Maps a raw scraped brand to a
// clean PRIMARY brand and an optional SECONDARY (sub-)brand, applied to every
// storefront. Cached in memory with a short TTL so the hot product paths don't
// hit Postgres per request.
import { query } from "./db.js";

let cache = { at: 0, byRaw: new Map(), byPrimary: new Map() };
const TTL_MS = 60 * 1000;

async function load() {
  if (cache.at && Date.now() - cache.at < TTL_MS) return cache;
  const { rows } = await query(`select raw, canonical, secondary from brand_map`);
  const byRaw = new Map();      // lowercased raw -> { primary, secondary }
  const byPrimary = new Map();  // lowercased primary -> Set(raw lowercased)
  for (const r of rows) {
    const raw = String(r.raw).toLowerCase();
    byRaw.set(raw, { primary: r.canonical, secondary: r.secondary || null });
    const k = String(r.canonical).toLowerCase();
    if (!byPrimary.has(k)) byPrimary.set(k, new Set());
    byPrimary.get(k).add(raw);
  }
  cache = { at: Date.now(), byRaw, byPrimary };
  return cache;
}

export function invalidateBrandMap() { cache = { at: 0, byRaw: new Map(), byPrimary: new Map() }; }

// primary (display) brand for a raw scraped brand (unchanged if unmapped)
export async function canonicalBrand(raw) {
  if (!raw) return raw;
  const { byRaw } = await load();
  return byRaw.get(String(raw).toLowerCase())?.primary || raw;
}

// every raw brand that maps to a PRIMARY brand (for expanding a brand filter).
// Always includes the value itself so a filter on an unmapped brand still works.
export async function rawBrandsFor(primary) {
  const { byPrimary } = await load();
  const set = byPrimary.get(String(primary || "").toLowerCase());
  const out = new Set([String(primary || "").toLowerCase()]);
  if (set) for (const r of set) out.add(r);
  return [...out];
}

// apply over a batch: set productBrand -> primary, and stamp subBrand -> secondary
export async function applyBrandToRows(rows) {
  const { byRaw } = await load();
  for (const r of rows) {
    const m = r.productBrand && byRaw.get(String(r.productBrand).toLowerCase());
    if (m) { r.productBrand = m.primary; if (m.secondary) r.subBrand = m.secondary; }
  }
  return rows;
}
