import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { dbManager } from '../models/dbManager.js';
import { fetchDataa } from "./strategies/methodA.js";
import { fetchDataaB } from "./strategies/methodB.js";
import { getSource } from "../portal/sources.js"; // source config now comes from Supabase

puppeteer.use(StealthPlugin());

/**
 * Run one scrape for a single source.
 * Accepts EITHER a source object { id, name, category, method, base_url, search_key }
 * (as returned from Supabase) OR a source id string (resolved from Supabase).
 * No longer depends on the static SITES_REGISTRY — so newly approved sources
 * that exist only in Supabase scrape with no code change.
 *
 * The scraper still WRITES products to SQLite (dbManager) exactly as before.
 */
export async function executeScraper(source) {
    const config = typeof source === "string" ? await getSource(source) : source;
    if (!config) throw new Error(`Source not found: ${source}`);
    if (!config.category) throw new Error(`Source '${config.id}' has no category`);

    // 1. Correct SQLite DB (shoes vs watches).
    const DB = await dbManager.getDb(config.category);

    try {
        // 2. Strategy by method.
        if (config.method === "METHOD_A") {
            console.log(`🚀 METHOD_A → ${config.name || config.id}`);
            await fetchDataa(config.base_url, DB);
        } else if (config.method === "METHOD_B") {
            console.log(`🚀 METHOD_B → ${config.name || config.id}`);
            await fetchDataaB(config.base_url, DB);
        } else {
            console.warn(`⚠️ Unknown method '${config.method}' for ${config.id} — skipped.`);
        }
    } catch (err) {
        console.error(`❌ Scraper failed for ${config.id}:`, err.message);
    } finally {
        console.log(`🏁 Finished ${config.name || config.id}`);
        // 3. Close the DB to release the WAL lock for backups (unchanged).
        try {
            await dbManager.closeDb(config.category);
        } catch (closeErr) {
            console.error("⚠️ Failed to close DB after scraping:", closeErr);
        }
    }
}
