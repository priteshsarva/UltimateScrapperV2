// One-time: populate Supabase source_categories for ALL existing sources,
// read instantly from the products already in SQLite (no re-scrape).
//   node portal/populateCategories.js
import "dotenv/config";
import { pool } from "./db.js";
import { refreshAllSourceCategoriesFromDB } from "./categories.js";

const n = await refreshAllSourceCategoriesFromDB();
console.log(`✅ Categories populated for all sources. Category rows touched: ${n}`);
await pool.end();
process.exit(0);
