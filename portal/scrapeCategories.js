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
    await page.setRequestInterception(true);
    page.on("request", (r) =>
      ["image", "stylesheet", "font", "media"].includes(r.resourceType()) ? r.abort() : r.continue()
    );
    return await fn(page);
  } finally {
    await browser.close();
  }
}

// These storefront hosts COLD-START: the first request to a site nobody has
// visited for a while can take longer than any sane timeout, and the very next
// request is instant (which is why the bulk scrape seconds later "magically"
// works). So attempt 1 is also the wake-up call — on timeout, retry, and the
// retry lands on a warm site.
async function gotoWithRetry(page, url, { attempts = 2, timeout = 60000 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout });
      return;
    } catch (e) {
      lastErr = e;
      console.warn(`⚠️ [categories] goto attempt ${i}/${attempts} failed for ${url}: ${e.message}`);
    }
  }
  throw lastErr;
}

const clean = (b) => String(b || "").replace(/\/+$/, "");

// METHOD_A — names match the catName stamped on products (.cat-text === catTitle).
export async function scrapeCategoriesA(baseUrl) {
  const url = `${clean(baseUrl)}/allcategory.html`;
  return withPage(async (page) => {
    await gotoWithRetry(page, url);
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
    await gotoWithRetry(page, url);
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
