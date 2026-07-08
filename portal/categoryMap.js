// Per-store canonical category mapping helpers.
import { query } from "./db.js";

// this store's mappings -> { source_id: { rawCatName: canonical } }
export async function mapForEnrollment(enrollmentId) {
  const rows = (await query(
    `select source_id, cat_name, canonical from category_map where enrollment_id=$1`,
    [enrollmentId]
  )).rows;
  const out = {};
  for (const r of rows) { (out[r.source_id] ||= {})[r.cat_name] = r.canonical; }
  return out;
}

// each attached source + its categories + this store's current mapping (for the UI)
export async function enrollmentCategoriesWithMap(enrollmentId) {
  const srcs = (await query(
    `select es.source_id, s.name
       from enrollment_sources es
       join sources s on s.id = es.source_id
      where es.enrollment_id = $1
      order by s.name`,
    [enrollmentId]
  )).rows;

  const maps = (await query(
    `select source_id, cat_name, canonical from category_map where enrollment_id=$1`,
    [enrollmentId]
  )).rows;
  const mm = {};
  for (const m of maps) { (mm[m.source_id] ||= {})[m.cat_name] = m.canonical; }

  const out = [];
  for (const s of srcs) {
    const cats = (await query(
      `select cat_name, product_count from source_categories where source_id=$1 order by cat_name`,
      [s.source_id]
    )).rows;
    out.push({
      source_id: s.source_id,
      name: s.name,
      categories: cats.map((c) => ({ ...c, canonical: (mm[s.source_id] || {})[c.cat_name] || "" })),
    });
  }
  return out;
}

// upsert this store's mappings; blank canonical clears that one
export async function saveEnrollmentMappings(enrollmentId, mappings) {
  for (const { source_id, cat_name, canonical } of mappings) {
    if (!source_id || !cat_name) continue;
    const val = (canonical || "").trim();
    if (val) {
      await query(
        `insert into category_map (enrollment_id, source_id, cat_name, canonical)
         values ($1,$2,$3,$4)
         on conflict (enrollment_id, source_id, cat_name) do update set canonical = excluded.canonical`,
        [enrollmentId, source_id, cat_name, val]
      );
    } else {
      await query(
        `delete from category_map where enrollment_id=$1 and source_id=$2 and cat_name=$3`,
        [enrollmentId, source_id, cat_name]
      );
    }
  }
}

// distinct canonical names this store already uses (for autocomplete)
export async function listCanonicalsForEnrollment(enrollmentId) {
  return (await query(
    `select distinct canonical from category_map where enrollment_id=$1 order by canonical`,
    [enrollmentId]
  )).rows.map((r) => r.canonical);
}
