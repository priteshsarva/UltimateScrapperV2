// Canonical category mapping helpers.
import { query } from "./db.js";

// mappings for a set of sources -> { source_id: { rawCatName: canonical } }
export async function mapForSources(sourceIds) {
  if (!sourceIds || !sourceIds.length) return {};
  const rows = (await query(
    `select source_id, cat_name, canonical from category_map where source_id = any($1)`,
    [sourceIds]
  )).rows;
  const out = {};
  for (const r of rows) { (out[r.source_id] ||= {})[r.cat_name] = r.canonical; }
  return out;
}

// a source's categories, each with its current canonical mapping (for the admin UI)
export async function sourceCategoriesWithMap(sourceId) {
  const cats = (await query(
    `select cat_name, product_count, enabled
       from source_categories where source_id=$1 order by cat_name`,
    [sourceId]
  )).rows;
  const maps = (await query(
    `select cat_name, canonical from category_map where source_id=$1`, [sourceId]
  )).rows;
  const m = {};
  for (const x of maps) m[x.cat_name] = x.canonical;
  return cats.map((c) => ({ ...c, canonical: m[c.cat_name] || "" }));
}

// upsert mappings for a source; an empty/blank canonical removes the mapping
export async function saveMappings(sourceId, mappings) {
  for (const { cat_name, canonical } of mappings) {
    if (!cat_name) continue;
    const val = (canonical || "").trim();
    if (val) {
      await query(
        `insert into category_map (source_id, cat_name, canonical)
         values ($1,$2,$3)
         on conflict (source_id, cat_name) do update set canonical = excluded.canonical`,
        [sourceId, cat_name, val]
      );
    } else {
      await query(`delete from category_map where source_id=$1 and cat_name=$2`, [sourceId, cat_name]);
    }
  }
}

// distinct canonical names already in use (for the admin autocomplete)
export async function listCanonicals() {
  return (await query(`select distinct canonical from category_map order by canonical`)).rows.map((r) => r.canonical);
}
