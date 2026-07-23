// portal/test-reconcile.js
//
// Standalone dry-run. Touches no routes, writes nothing (rolls back).
// Proves: DATABASE_URL works, the module loads, and — most importantly —
// whether the scraped category NAMES match your existing cat_name rows.
//
// Usage:
//   cd /home/ubuntu/UltimateScrapperV2
//   node portal/test-reconcile.js <source_id>
//
// Get <source_id> from Supabase:
//   SELECT id, name FROM sources WHERE name ILIKE '%jilani%';

import 'dotenv/config'; // Automatically loads .env variables
import pg from 'pg';
import { reconcileCategories, toHandle } from './reconcileCategories.js';

const sourceId = process.argv[2];
if (!sourceId) {
  console.error('Usage: node portal/test-reconcile.js <source_id>');
  process.exit(1);
}

// ── Hand-typed to match what the portal currently shows for Jilani.
// EDIT THESE to match your source exactly (names as they appear in the
// portal, urls as they appear on the supplier site).
const FAKE_SCRAPE = [
  { name: 'Mens Watch',   url: '/collections/mens-watch',   productCount: 4171 },
  { name: 'Ladies Watch', url: '/collections/ladies-watch', productCount: 710  },
];

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

try {
  console.log('\n── what the handles will become ─────────────');
  for (const c of FAKE_SCRAPE) {
    console.log(`  ${JSON.stringify(c.name).padEnd(18)} url=${c.url}  ->  handle="${toHandle(c.url)}"`);
  }

  console.log('\n── existing rows in the database ────────────');
  const { rows } = await pool.query(
    `SELECT cat_name, slug, status, enabled, product_count
       FROM public.source_categories
      WHERE source_id = $1
      ORDER BY cat_name`,
    [sourceId]
  );
  if (rows.length === 0) {
    console.log('  (none — this source has no categories yet)');
  }
  for (const r of rows) {
    console.log(`  cat_name="${r.cat_name}"  slug=${r.slug ?? 'NULL'}  ` +
                `status=${r.status}  enabled=${r.enabled}  count=${r.product_count}`);
  }

  console.log('\n── DRY RUN (nothing is written) ─────────────');
  const result = await reconcileCategories(pool, sourceId, FAKE_SCRAPE, { dryRun: true });
  console.log(JSON.stringify(result, null, 2));

  console.log('\n── verdict ─────────────────────────────────');
  if (result.added.length === 0 && result.deprecated.length === 0) {
    console.log('  GOOD — every scraped category matched an existing row.');
    console.log(`  adopted=${result.adopted.length} (rows that will gain a handle)`);
  } else {
    console.log('  PROBLEM — names did not line up:');
    if (result.added.length) {
      console.log(`    would INSERT ${result.added.length} new: ` +
                  result.added.map(a => `"${a.name}"`).join(', '));
    }
    if (result.deprecated.length) {
      console.log(`    would DEPRECATE ${result.deprecated.length}: ` +
                  result.deprecated.map(d => `"${d.name}"`).join(', '));
    }
    console.log('  Fix the names in FAKE_SCRAPE to match cat_name exactly, then re-run.');
  }
} catch (err) {
  console.error('\nFAILED:', err.message);
  if (/DATABASE_URL|ECONNREFUSED|SASL|password/i.test(err.message)) {
    console.error('Check DATABASE_URL in .env — it must be the Supabase SESSION POOLER string.');
  }
  process.exitCode = 1;
} finally {
  await pool.end();
}
