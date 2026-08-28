// Global brand mapping (super-admin managed). Maps a raw scraped brand to a
// clean canonical name, applied to EVERY storefront. Cached in memory with a
// short TTL so the hot product paths don't hit Postgres per request.
import { query } from "./db.js";

let cache = { at: 0, byRaw: new Map(), byCanon: new Map() };
const TTL_MS = 60 * 1000;

async function load() {
  if (Date.now() - cache.at < TTL_MS && cache.byRaw.size >= 0 && cache.at) return cache;
  const { rows } = await query(`select raw, canonical from brand_map`);
  const byRaw = new Map();       // lowercased raw -> canonical
  const byCanon = new Map();     // lowercased canonical -> Set(raw lowercased)
  for (const r of rows) {
    const raw = String(r.raw).toLowerCase();
    byRaw.set(raw, r.canonical);
    const k = String(r.canonical).toLowerCase();
    if (!byCanon.has(k)) byCanon.set(k, new Set());
    byCanon.get(k).add(raw);
  }
  cache = { at: Date.now(), byRaw, byCanon };
  return cache;
}

export function invalidateBrandMap() { cache = { at: 0, byRaw: new Map(), byCanon: new Map() }; }

// canonical display brand for a raw scraped brand (unchanged if unmapped)
export async function canonicalBrand(raw) {
  if (!raw) return raw;
  const { byRaw } = await load();
  return byRaw.get(String(raw).toLowerCase()) || raw;
}

// every raw brand that maps to a canonical (for expanding a brand filter). Always
// includes the value itself so a filter on an unmapped brand still works.
export async function rawBrandsFor(canonical) {
  const { byCanon } = await load();
  const set = byCanon.get(String(canonical || "").toLowerCase());
  const out = new Set([String(canonical || "").toLowerCase()]);
  if (set) for (const r of set) out.add(r);
  return [...out];
}

// synchronous apply over a batch, given a preloaded map (for hot loops)
export async function applyBrandToRows(rows) {
  const { byRaw } = await load();
  for (const r of rows) {
    const c = r.productBrand && byRaw.get(String(r.productBrand).toLowerCase());
    if (c) r.productBrand = c;
  }
  return rows;
}
