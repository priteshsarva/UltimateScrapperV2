// Chrome startup: ONE shared gate + retry, used by every scraper in the process.
//
// THE GUARANTEE
//   No matter how many things want a browser at the same moment — the rotator's
//   bulk crawl, a burst of live refresh-one scrapes from the plugin's stock
//   check, an admin category re-scrape — at most CHROME_MAX Chromes are ever
//   alive at once. Everyone else waits their turn (FIFO) instead of launching a
//   browser the box cannot afford.
//
// WHY A CAP OF 2
//   This runs on a ~1GB VPS. One bulk-crawl Chrome (images enabled) plus one
//   slim live Chrome (images/fonts blocked) fit. A third is what triggered the
//   OOM/launch-failure walls in the logs. The bulk path is already serialized to
//   one by the scrape queue, so in practice: 1 bulk + 1 live/category at a time,
//   and further live requests queue for the ~10-30s a live scrape takes.
//
// WHY RETRY
//   Startup failures here are transient: the unmaintained stealth plugin races
//   target creation on puppeteer >= 22 ("Requesting main frame too early!"), and
//   a tight box can kill Chrome as it boots. Both are cured by close-wait-retry.
//
// The slot is returned when the browser DISCONNECTS — which fires both on a
// normal close() and on a crash — so a dying Chrome can never leak its slot.

const CHROME_MAX = Math.max(1, parseInt(process.env.CHROME_MAX, 10) || 2);
let inUse = 0;
const waiters = [];

function acquireSlot(label) {
    if (inUse < CHROME_MAX) { inUse++; return Promise.resolve(); }
    console.log(`⏳ [${label}] waiting for a Chrome slot (${inUse}/${CHROME_MAX} busy, ${waiters.length} ahead)`);
    return new Promise((resolve) => waiters.push(resolve));
}

function releaseSlot() {
    const next = waiters.shift();
    if (next) next();                       // hand the slot straight to the next waiter
    else inUse = Math.max(0, inUse - 1);
}

export async function launchWithPage(puppeteer, launchOpts, { label = "chrome", attempts = 3, backoffMs = 3000 } = {}) {
    await acquireSlot(label);
    let lastErr;
    try {
        for (let attempt = 1; attempt <= attempts; attempt++) {
            let browser;
            try {
                browser = await puppeteer.launch(launchOpts);
                // newPage() is INSIDE the retry on purpose: the stealth race
                // throws here, not in launch(). A browser with no page is dead.
                const page = await browser.newPage();

                // success — the slot now belongs to this browser until it goes
                // away, however it goes away (close() and crash both disconnect)
                let released = false;
                browser.once("disconnected", () => { if (!released) { released = true; releaseSlot(); } });
                return { browser, page };
            } catch (err) {
                lastErr = err;
                if (browser) { try { await browser.close(); } catch { /* already gone */ } }
                console.warn(`⚠️ [${label}] Chrome start failed (attempt ${attempt}/${attempts}): ${err.message}`);
                if (attempt < attempts) await new Promise((r) => setTimeout(r, backoffMs * attempt));
            }
        }
        throw lastErr;
    } catch (e) {
        releaseSlot();                      // never got a working browser — give the slot back
        throw e;
    }
}
