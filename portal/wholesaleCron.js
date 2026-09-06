// Daily wholesale maintenance:
//   1. reverifyListingsTick — wholesale listings not reconfirmed within
//      listing_reverify_days flip to 'needs_review' and are hidden (availability=0)
//      until the wholesaler taps "Still accurate".
//   2. purgeShipmentPhotosTick — parcel photos past purge_after are deleted from
//      R2 (evidence retained 60 days). Admin can download first via
//      /portal/admin/shipments/purge-preview.
import { query } from "./db.js";
import { getPlatformConfig } from "./settings.js";
import { wholesaleDb, wsRun, wsAll } from "./wholesaleDb.js";
import { deleteObject } from "./storage.js";

export async function reverifyListingsTick() {
  const { listing_reverify_days } = await getPlatformConfig();
  const days = Number(listing_reverify_days) || 30;
  const db = await wholesaleDb();
  // sqlite: lastVerifiedAt older than N days AND still active -> needs_review, hidden
  const r = await wsRun(db,
    `UPDATE PRODUCTS SET listingStatus='needs_review', availability=0
      WHERE listingStatus='active'
        AND lastVerifiedAt IS NOT NULL
        AND julianday('now') - julianday(lastVerifiedAt) > ?`,
    [days]
  );
  return { flagged: r?.changes ?? null, days };
}

export async function purgeShipmentPhotosTick() {
  const rows = (await query(
    `select id, photos from shipments where purged=false and purge_after <= now() and jsonb_array_length(photos) > 0`
  )).rows;
  let deleted = 0;
  for (const s of rows) {
    for (const p of (s.photos || [])) { if (p.key) { await deleteObject(p.key); deleted++; } }
    await query(`update shipments set photos='[]'::jsonb, purged=true where id=$1`, [s.id]);
  }
  return { shipments: rows.length, photos_deleted: deleted };
}
