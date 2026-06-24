// Single-runner scrape queue (concurrency 1).
// Shared by the rotator AND the approval-triggered scrape so two scrapes
// never write the same SQLite DB at once (avoids "database is locked").
import PQueue from "p-queue";
import { executeScraper } from "../core/scraperManager.js";
import { markScraped } from "./sources.js";

export const scrapeQueue = new PQueue({ concurrency: 1 });

// Enqueue a scrape for a source object (or id). Resolves when it has run.
// Stamps last_scraped_at on completion so the rotator advances naturally —
// this is why both the rotator and on-demand scrapes go through here.
export function enqueueScrape(source) {
  return scrapeQueue.add(async () => {
    const id = typeof source === "string" ? source : source?.id;
    try {
      await executeScraper(source);
    } catch (err) {
      console.error("Queued scrape failed:", id, err.message);
    } finally {
      if (id) await markScraped(id).catch(() => {});
    }
  });
}

export const scrapeQueueDepth = () => scrapeQueue.size + scrapeQueue.pending;
