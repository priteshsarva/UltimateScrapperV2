// portal/reconcileCategories.js
//
// Reconciles a fresh category scrape against public.source_categories.
//
// IDENTITY = `handle`, derived from the category URL (already stored in `slug`).
// Not cat_name: merchants rename display labels constantly, and a name-derived
// key makes rename detection impossible by construction.
//
// `slug` keeps holding the FULL URL exactly as today — portal/categories.js
// and the portal UI read it, so this module never clobbers it.
//
//   seen, handle known        -> name/count updated, `enabled` preserved
//   seen, name changed        -> same row, new cat_name, old kept in previous_name
//   seen, handle unknown but
//     cat_name matches a row  -> ADOPTED: that row gains the handle (bootstrap)
//   seen, no match at all     -> INSERT with enabled = false
//   not seen this run         -> status = 'deprecated' (never deleted)
//
// Nothing here deletes rows or flips `enabled`. Deprecation becomes destructive
// only once sync-feed filters on status — that is a separate, later change.

/**
 * Turn a category URL (or handle, or name) into a stable lowercase handle.
 *   'https://jilaniwatches11.cartpe.in/mens-watch.html'      -> 'mens-watch'
 *   'https://x.cartpe.in/ladies-watch-watches.html'          -> 'ladies-watch-watches'
 *   '/collections/mens-watch?page=2'                         -> 'mens-watch'
 *   "Men's Watch"                                            -> 'men-s-watch'  (fallback)
 */
export function toHandle(input) {
  if (input === null || input === undefined) return '';
  let s = String(input).trim();
  if (!s) return '';

  if (s.includes('/')) {
    let path = s;
    try {
      const u = s.startsWith('http') ? new URL(s) : new URL(s, 'https://placeholder.invalid');
      path = u.pathname;
    } catch {
      path = s.split('?')[0].split('#')[0];
    }
    const segs = path.split('/').filter(Boolean);
    if (segs.length) s = segs[segs.length - 1];
  }

  return s
    .toLowerCase()
    .replace(/\.(html?|php|aspx?)$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} sourceId   sources.id (text, e.g. 'jilaniwatches11')
 * @param {Array<{name?:string, cat_name?:string, url?:string, slug?:string,
 *                handle?:string, productCount?:number, product_count?:number,
 *                img?:string}>} scraped
 * @param {{minRatio?:number, dryRun?:boolean}} [opts]
 */
export async function reconcileCategories(pool, sourceId, scraped, opts = {}) {
  const minRatio = opts.minRatio ?? 0.5;
  const dryRun   = opts.dryRun === true;

  if (!Array.isArray(scraped) || scraped.length === 0) {
    throw new Error(
      `Refusing to reconcile ${sourceId}: scrape returned 0 categories. ` +
      `Existing categories left untouched.`
    );
  }

  // ── normalise + de-dupe (storefronts list categories twice: nav + footer)
  // Field names are accepted in both camelCase and snake_case so this drops
  // straight onto whatever scrapeCategoriesA/B already return.
  const items = new Map(); // handle -> item
  for (const c of scraped) {
    const name = String(c.name ?? c.cat_name ?? '').trim();
    if (!name) continue;

    const urlRaw = c.url ?? c.slug ?? null;
    const handle = toHandle(c.handle ?? urlRaw ?? name);
    if (!handle) continue;

    const rawCount = c.productCount ?? c.product_count;
    const count = Number.isFinite(Number(rawCount)) ? Number(rawCount) : 0;

    const prev = items.get(handle);
    if (!prev || count > prev.productCount) {
      items.set(handle, {
        handle,
        name,
        url: urlRaw ? String(urlRaw) : null,   // full URL -> stored in `slug`
        img: c.img ?? null,
        productCount: count,
      });
    }
  }

  if (items.size === 0) {
    throw new Error(`Refusing to reconcile ${sourceId}: no usable categories after normalisation.`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Serialise concurrent reconciles of the same source (double-clicked
    // button, cron overlapping a manual run). Released at COMMIT/ROLLBACK.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [String(sourceId)]);

    const { rows: existing } = await client.query(
      `SELECT id, handle, slug, cat_name, status, enabled, product_count
         FROM public.source_categories
        WHERE source_id = $1`,
      [sourceId]
    );

    const activeBefore = existing.filter(r => r.status === 'active').length;

    // Guard against a PARTIAL scrape — nav half-rendered, timeout mid-page,
    // bot-block serving a stub. Finding 2 categories where 11 were active is
    // not a supplier dropping 9 categories; it's a broken scrape.
    if (activeBefore > 0 && items.size < Math.ceil(activeBefore * minRatio)) {
      throw new Error(
        `Refusing to reconcile ${sourceId}: scrape found ${items.size} categories ` +
        `but ${activeBefore} were active. Looks like a partial scrape.`
      );
    }

    const byHandle = new Map();
    const byName   = new Map();
    for (const r of existing) {
      if (r.handle) byHandle.set(r.handle, r);
      byName.set(r.cat_name.trim().toLowerCase(), r);
    }

    const matchedIds = new Set();
    const added = [], renamed = [], revived = [], adopted = [];
    let updated = 0;

    for (const item of items.values()) {
      // tier 1: the stable handle
      let row = byHandle.get(item.handle);

      // tier 2: bootstrap — a pre-handle row still keyed by its display name
      let wasAdopted = false;
      if (!row) {
        const cand = byName.get(item.name.toLowerCase());
        if (cand && !matchedIds.has(cand.id)) {
          row = cand;
          wasAdopted = true;
        }
      }

      if (row) {
        matchedIds.add(row.id);
        const nameChanged = row.cat_name !== item.name;

        if (!dryRun) {
          await client.query(
            `UPDATE public.source_categories
                SET handle        = $2,
                    cat_name      = $3,
                    previous_name = CASE WHEN cat_name IS DISTINCT FROM $3
                                         THEN cat_name ELSE previous_name END,
                    slug          = COALESCE($4, slug),
                    img           = COALESCE($5, img),
                    product_count = $6,
                    status        = 'active',
                    deprecated_at = NULL,
                    last_seen_at  = now(),
                    updated_at    = now()
              WHERE id = $1`,
            [row.id, item.handle, item.name, item.url, item.img, item.productCount]
          );
        }

        updated++;
        if (wasAdopted)                  adopted.push({ name: item.name, handle: item.handle });
        if (row.status === 'deprecated') revived.push({ name: item.name, handle: item.handle });
        if (nameChanged)                 renamed.push({ handle: item.handle, from: row.cat_name, to: item.name });

      } else {
        // New category: inserted DISABLED so it never silently starts pushing
        // products into client stores. Admin enables it deliberately.
        if (!dryRun) {
          const { rows: ins } = await client.query(
            `INSERT INTO public.source_categories
               (source_id, cat_name, handle, slug, img, product_count,
                enabled, status, last_seen_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, false, 'active', now(), now())
             RETURNING id`,
            [sourceId, item.name, item.handle, item.url, item.img, item.productCount]
          );
          matchedIds.add(ins[0].id);
        }
        added.push({ name: item.name, handle: item.handle, productCount: item.productCount });
      }
    }

    // Everything on this source we did NOT match is gone from the site.
    // Marked, never deleted: enrollment_sources and per-store category_map
    // point at these rows, and the sources FK cascades on delete.
    let deprecated = [];
    if (!dryRun) {
      const { rows } = await client.query(
        `UPDATE public.source_categories
            SET status = 'deprecated',
                deprecated_at = now(),
                updated_at = now()
          WHERE source_id = $1
            AND status <> 'deprecated'
            AND NOT (id = ANY($2::uuid[]))
          RETURNING cat_name, handle, enabled, product_count`,
        [sourceId, Array.from(matchedIds)]
      );
      deprecated = rows.map(d => ({
        name: d.cat_name, handle: d.handle,
        wasEnabled: d.enabled, productCount: d.product_count,
      }));

      await client.query(
        `UPDATE public.sources SET last_category_scrape_at = now() WHERE id = $1`,
        [sourceId]
      );
    }

    if (dryRun) await client.query('ROLLBACK');
    else        await client.query('COMMIT');

    return {
      sourceId,
      dryRun,
      scrapedCount: items.size,
      activeBefore,
      added, renamed, revived, adopted, updated, deprecated,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
