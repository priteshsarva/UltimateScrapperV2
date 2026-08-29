// Apply the AI-decoded brand mappings: read result_chunk_*.json from the
// scratchpad, validate, and upsert into brand_map (never overwriting a curated
// row — ON CONFLICT DO NOTHING). Run: node portal/applyAiBrandMap.js <scratchDir>
import fs from "fs";
import path from "path";
import { query } from "./db.js";

const dir = process.argv[2];
if (!dir) { console.error("usage: node portal/applyAiBrandMap.js <scratchDir>"); process.exit(1); }

const rows = [];
let files = 0, skipped = 0, bad = 0;
for (const f of fs.readdirSync(dir).filter((f) => /^result_chunk_\d+\.json$/.test(f)).sort()) {
  files++;
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }
  catch (e) { console.error("bad JSON:", f, e.message); continue; }
  for (const r of arr || []) {
    const raw = r && r.raw != null ? String(r.raw) : null;
    const primary = r && r.primary != null && String(r.primary).trim() ? String(r.primary).trim() : null;
    const secondary = r && r.secondary != null && String(r.secondary).trim() ? String(r.secondary).trim() : null;
    if (!raw) { bad++; continue; }
    if (!primary) { skipped++; continue; } // agent decided it's not a real brand
    rows.push([raw.toLowerCase(), primary, secondary]);
  }
}
console.log(`files: ${files} | to map: ${rows.length} | skipped(no brand): ${skipped} | bad: ${bad}`);

// chunked upsert, never overwrite curated/derived rows already present
let applied = 0;
for (let i = 0; i < rows.length; i += 500) {
  const chunk = rows.slice(i, i + 500);
  const vals = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(",");
  const params = chunk.flatMap(([raw, p, s]) => [raw, p, s]);
  const r = await query(`insert into brand_map (raw, canonical, secondary) values ${vals} on conflict (raw) do nothing`, params);
  applied += r.rowCount;
}
const total = (await query(`select count(*) c from brand_map`)).rows[0].c;
console.log(`newly applied: ${applied} | brand_map total now: ${total}`);
process.exit(0);
