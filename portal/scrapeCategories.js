// Standalone category-page scrapers (categories-first on approval).
// Selectors taken from the real markup:
//   METHOD_A: {base}/allcategory.html  ->  .cat-area  (name in .cat-text, link in a[href])
//   METHOD_B: {base}/categories        ->  div.abs_image_wrapper  (name in img[alt], link in a[href])
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import "dotenv/config";

puppeteer.use(StealthPlugin());

const LAUNCH = {
  headless: false,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  args: [
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
};

async function withPage(fn) {
  const browser = await puppeteer.launch(LAUNCH);
  try {
    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(45000);
    await page.setRequestInterception(true);
    page.on("request", (r) =>
      ["image", "stylesheet", "font", "media"].includes(r.resourceType()) ? r.abort() : r.continue()
    );
    return await fn(page);
  } finally {
    await browser.close();
  }
}

const clean = (b) => String(b || "").replace(/\/+$/, "");

// METHOD_A — names match the catName stamped on products (.cat-text === catTitle).
export async function scrapeCategoriesA(baseUrl) {
  const url = `${clean(baseUrl)}/allcategory.html`;
  return withPage(async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
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
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
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
