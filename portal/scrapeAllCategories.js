// Live-scrape categories for ALL sources (headless Chrome), one at a time.
// Accurate per-source name + slug + img from each source's own category page,
// plus product counts merged from the DB.
//
//   node portal/scrapeAllCategories.js            # rebuild all (upsert)
//   node portal/scrapeAllCategories.js --reset    # wipe source_categories first, then rebuild
import "dotenv/config";
import { pool, query } from "./db.js";
import { listSources } from "./sources.js";
import { scrapeSourceCategories } from "./categories.js";

const RESET = process.argv.includes("--reset");

if (RESET) {
  await query("truncate table source_categories");
  console.log("🧹 Cleared source_categories (old rows removed).\n");
}

const sources = await listSources({});
console.log(`Live-scraping categories for ${sources.length} sources (sequential)…\n`);

let ok = 0, fail = 0;
for (const s of sources) {
  try {
    const n = await scrapeSourceCategories(s);
    console.log(`  ✅ ${s.id.padEnd(24)} ${n} categories`);
    ok++;
  } catch (e) {
    console.log(`  ❌ ${s.id.padEnd(24)} ${e.message}`);
    fail++;
  }
}

console.log(`\nDone. ${ok} ok, ${fail} failed.`);
await pool.end();
process.exit(0);
