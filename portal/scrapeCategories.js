// Standalone category-page scrapers (categories-first on approval).
// Selectors taken from the real markup:
//   METHOD_A: {base}/allcategory.html  ->  .cat-area  (name in .cat-text, link in a[href])
//   METHOD_B: {base}/categories        ->  div.abs_image_wrapper  (name in img[alt], link in a[href])
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { launchWithPage } from "../core/launchBrowser.js";
import "dotenv/config";

puppeteer.use(StealthPlugin());

const LAUNCH = {
  headless: 'new',
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
};

// Goes through the shared Chrome gate (core/launchBrowser.js) like every other
// scraper — an admin category re-scrape can no longer add a third browser on
// top of a bulk crawl and a live refresh.
async function withPage(fn) {
  const { browser, page } = await launchWithPage(puppeteer, LAUNCH, { label: "categories" });
  try {
    await page.setDefaultNavigationTimeout(60000);
    // Realistic UA + language. A bare headless UA gets these storefronts to
    // serve a bot shell / blank page — one reason the standalone category scrape
    // returned nothing while the bulk scraper (which sets a UA) worked.
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    await page.setRequestInterception(true);
    // Block only heavy media. Do NOT block scripts (the category tiles are
    // JS-rendered — blocking JS = no tiles) or stylesheets (a SPA can gate its
    // render on CSS). The bulk scraper blocks nothing at all and works.
    page.on("request", (r) =>
      ["image", "media", "font"].includes(r.resourceType()) ? r.abort() : r.continue()
    );
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// goto AND WAIT for the tiles to actually render.
//
// These sites are JavaScript SPAs: the HTML arrives at domcontentloaded, but
// `selector` does not exist until the bundle runs. Reading the DOM too early is
// exactly why categories came back empty — the bulk scraper only avoided it by
// waiting networkidle2 + a fixed 1.5s. Waiting for the SELECTOR is strictly
// better: it returns the instant the tiles appear and tolerates a slow render.
//
// Retrying the whole navigation also covers a cold-started first hit that
// returns a blank shell. Returns false (not throw) when the tiles never show —
// the approval flow treats "0 categories" as non-fatal and the bulk scrape
// still fills them in later.
async function gotoAndWait(page, url, selector, { attempts = 3 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector(selector, { timeout: 15000 });
      return true;
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ [categories] attempt ${i}/${attempts} for ${url}: ${e.message}`);
      if (i < attempts) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  console.warn(`⚠️ [categories] no tiles at ${url} after ${attempts} tries: ${lastErr && lastErr.message}`);
  return false;
}

const clean = (b) => String(b || "").replace(/\/+$/, "");

// METHOD_A — names match the catName stamped on products (.cat-text === catTitle).
export async function scrapeCategoriesA(baseUrl) {
  const url = `${clean(baseUrl)}/allcategory.html`;
  return withPage(async (page) => {
    if (!(await gotoAndWait(page, url, ".cat-area"))) return [];
    return page.evaluate(() =>
      Array.from(document.querySelectorAll(".cat-area"))
        .map((el) => {
          const a = el.querySelector("a");
          return {
            name: (el.querySelector(".cat-text")?.innerText || "").trim(),
            slug: (a && a.getAttribute("href")) ? a.href : null, // absolute, source's own domain
            img: el.querySelector("img")?.src || null,
          };
        })
        .filter((c) => c.name)
    );
  });
}

// METHOD_B — img[alt] === the <h3> label === the catName stamped on products.
export async function scrapeCategoriesB(baseUrl) {
  const url = `${clean(baseUrl)}/categories`;
  return withPage(async (page) => {
    if (!(await gotoAndWait(page, url, "div.abs_image_wrapper"))) return [];
    return page.evaluate(() =>
      Array.from(document.querySelectorAll("div.abs_image_wrapper"))
        .map((el) => {
          const a = el.querySelector("a");
          const im = el.querySelector("img");
          return {
            name: (im?.getAttribute("alt") || "").trim(),
            slug: (a && a.getAttribute("href")) ? a.href : null, // absolute, source's own domain
            img: im?.src || null,
          };
        })
        .filter((c) => c.name)
    );
  });
}
