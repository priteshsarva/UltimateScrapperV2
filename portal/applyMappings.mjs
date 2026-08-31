// Apply the user's curated brand mappings from two sources:
//   portal/user_brandmap.txt   (raw|||primary|||secondary)   — markdown sections 1-48
//   Downloads/brands.csv       (Raw Title,Primary,Secondary) — the T-Z tail
// Skips non-brand buckets (Unbranded / Generic / UA). Upserts into brand_map
// (user is authoritative → ON CONFLICT DO UPDATE).
import fs from "fs";
import { query } from "./db.js";

const ALIAS = { "air jordan": "Jordan", "golf le fleur / converse": "Converse" };
const SKIP = /unbranded|generic|^ua\b|special ip|collaborat|footwear$/i;

const rows = new Map(); // raw_lower -> [primary, secondary]
const add = (raw, primary, secondary) => {
  raw = String(raw || "").trim();
  primary = String(primary || "").trim();
  if (!raw || !primary || SKIP.test(primary)) return;
  primary = ALIAS[primary.toLowerCase()] || primary;
  secondary = (secondary || "").replace(/^"|"$/g, "").trim() || null;
  rows.set(raw.toLowerCase(), [primary, secondary]);
};

// 1) pipe-delimited file
for (const line of fs.readFileSync("portal/user_brandmap.txt", "utf8").split(/\r?\n/)) {
  if (!line.trim() || line.startsWith("#")) continue;
  const [raw, primary, secondary] = line.split("|||");
  add(raw, primary, secondary);
}

// 2) CSV (primary never contains a comma; secondary may be quoted)
const csv = fs.readFileSync("C:/Users/Sarva/Downloads/brands.csv", "utf8").split(/\r?\n/);
for (const line of csv.slice(1)) {
  if (!line.trim()) continue;
  const c1 = line.indexOf(",");
  if (c1 < 0) continue;
  const rawTitle = line.slice(0, c1);
  const rest = line.slice(c1 + 1);
  const c2 = rest.indexOf(",");
  const primary = c2 < 0 ? rest : rest.slice(0, c2);
  const secondary = c2 < 0 ? "" : rest.slice(c2 + 1);
  const raw = rawTitle.replace(/\s+\d+$/, ""); // strip trailing count
  add(raw, primary, secondary);
}

const list = [...rows].map(([raw, [p, s]]) => [raw, p, s]);
console.log(`rows to apply: ${list.length}`);

let applied = 0;
for (let i = 0; i < list.length; i += 400) {
  const chunk = list.slice(i, i + 400);
  const vals = chunk.map((_, j) => `($${j * 3 + 1},$${j * 3 + 2},$${j * 3 + 3})`).join(",");
  const params = chunk.flatMap(([raw, p, s]) => [raw, p, s]);
  const r = await query(
    `insert into brand_map (raw, canonical, secondary) values ${vals}
     on conflict (raw) do update set canonical = excluded.canonical, secondary = excluded.secondary, updated_at = now()`,
    params
  );
  applied += r.rowCount;
}
const total = (await query(`select count(*) c from brand_map`)).rows[0].c;
console.log(`applied: ${applied} | brand_map total: ${total}`);
process.exit(0);
