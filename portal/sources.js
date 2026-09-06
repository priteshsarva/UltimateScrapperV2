// Sources (the scrape registry/config) — data access against Supabase.
// The scraper still WRITES products to SQLite; this only governs the
// list/config of sources and is what gives admin control + the approval flow.
import { query } from "./db.js";

// Categories are FREE-FORM now (any niche, not just shoes/watches) — but a
// category is also a SQLite FILENAME (dbManager opens `<category>.db`), so every
// write path must slug it. Lowercase, spaces -> '-', strip everything outside
// [a-z0-9_-], max 40 chars. Returns '' when nothing usable is left.
export function sanitizeCategory(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40);
}

export async function listSources({ status } = {}) {
  const sql = `select * from sources ${status ? "where status=$1" : ""} order by name`;
  const { rows } = await query(sql, status ? [status] : []);
  return rows;
}

export async function getSource(id) {
  const { rows } = await query(`select * from sources where id=$1`, [id]);
  return rows[0] || null;
}

export async function upsertSource(s) {
  // single choke-point: everything that creates/edits a source funnels through
  // here (admin routes AND scrape-request approval), so slugging once covers all
  s = { ...s, category: sanitizeCategory(s.category) };
  if (!s.category) throw new Error("category must contain at least one letter or digit");
  const { rows } = await query(
    `insert into sources (id, name, category, method, base_url, search_key, status)
     values ($1,$2,$3,$4,$5,$6, coalesce($7,'active'))
     on conflict (id) do update set
       name       = excluded.name,
       category   = excluded.category,
       method     = excluded.method,
       base_url   = excluded.base_url,
       search_key = excluded.search_key
     returning *`,
    [s.id, s.name, s.category, s.method, s.base_url, s.search_key, s.status]
  );
  return rows[0];
}

export async function setSourceStatus(id, status) {
  const { rows } = await query(
    `update sources set status=$1 where id=$2 returning *`,
    [status, id]
  );
  return rows[0] || null;
}

// Pick the next source to scrape: least-recently-scraped active source.
// (Replaces the positional scraper-state.json cursor — more robust.)
export async function nextSourceToScrape() {
  const { rows } = await query(
    `select * from sources
      where status='active' and method <> 'MANUAL'
      order by last_scraped_at asc nulls first, name asc
      limit 1`
  );
  return rows[0] || null;
}

export async function markScraped(id, productCount) {
  if (productCount != null) {
    await query(
      `update sources set last_scraped_at=now(), product_count=$2 where id=$1`,
      [id, productCount]
    );
  } else {
    await query(`update sources set last_scraped_at=now() where id=$1`, [id]);
  }
}
