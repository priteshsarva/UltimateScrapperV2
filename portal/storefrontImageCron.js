// Reclaim orphaned storefront images from R2. Any object under "storefront/" older
// than 30 days whose key no longer appears anywhere in site_settings (logo_url,
// favicon_url, hero.image_url, reviews[], …) is deleted — it was uploaded but never
// saved, or was replaced. Scoped to the storefront/ prefix, so product and shipment
// images are never touched. No-op when R2 isn't configured.
import { query } from "./db.js";
import { isConfigured, listObjects, deleteObject } from "./storage.js";

const AGE_MS = 30 * 24 * 3600 * 1000;

export async function purgeStorefrontImagesTick() {
  if (!isConfigured()) return { skipped: "storage not configured" };
  const objects = await listObjects("storefront/");
  const cutoff = Date.now() - AGE_MS;
  const old = objects.filter((o) => o.lastModified && new Date(o.lastModified).getTime() < cutoff);
  if (!old.length) return { checked: objects.length, old: 0, deleted: 0 };

  // One blob of every settings row; if an object's key doesn't appear in it, the image
  // is not linked to any store. (The stored value is the full URL, which contains the key.)
  const { rows } = await query(`select coalesce(string_agg(to_jsonb(site_settings)::text, ' '), '') as t from site_settings`);
  const refs = rows[0]?.t || "";

  let deleted = 0;
  for (const o of old) {
    if (refs.includes(o.key)) continue;   // still linked to a store
    await deleteObject(o.key);
    deleted++;
  }
  return { checked: objects.length, old: old.length, deleted };
}
