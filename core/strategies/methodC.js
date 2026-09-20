// METHOD_C — cartpe.in stores (e.g. resellerzone.cartpe.in, watchcultures.cartpe.in).
//
// cartpe is a React SPA whose API is ENCRYPTED (every request/response is
// { payload, iv } AES-GCM). Rather than reverse the cipher, we run the site in
// Puppeteer and HARVEST the DECRYPTED responses: the app itself calls
// crypto.subtle.decrypt to render, so we wrap it and collect the plaintext JSON.
// No key needed, and it survives key rotation.
//
// Flow:  /category            -> POST /api/all-category      (categories)
//        /shop?c=<slug>        -> POST /api/category-products (paginated "Load More")
//        /product-detail/<sl>  -> POST /api/product-details   (live re-scrape, see liveMethodC)
//
// Products are written through methodA's updateProduct() (keyed on productUrl),
// exactly like Methods A/B, so the rest of the pipeline is unchanged.
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { launchWithPage } from '../launchBrowser.js';
import { updateProduct } from './methodA.js';
import { updateProductCategory } from '../../services/updateProductCategoryAndBrand.js';
import "dotenv/config";

puppeteer.use(StealthPlugin());

const CDN = "https://cdn.cartpe.in/images";
export const cartpeImg = (file, size = "gallery_lg") => (file ? `${CDN}/${size}/${file}` : null);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Injected BEFORE the app's JS on every navigation: wrap crypto.subtle.decrypt so
// every decrypted API response lands in window.__harvest as a JSON string.
export function harvestHook() {
  window.__harvest = [];
  try {
    const od = crypto.subtle.decrypt.bind(crypto.subtle);
    crypto.subtle.decrypt = async function (a, k, d) {
      const r = await od(a, k, d);
      try { window.__harvest.push(new TextDecoder().decode(r)); } catch (e) { /* not text */ }
      return r;
    };
  } catch (e) { /* subtle unavailable */ }
}

// Sort harvested JSON strings by shape: all-category / category-products / product-details.
export function classifyHarvest(strings) {
  const categories = [], listItems = [], details = [];
  for (const s of strings) {
    let o; try { o = JSON.parse(s); } catch { continue; }
    const d = o && o.data;
    if (!d) continue;
    if (Array.isArray(d.categories)) categories.push(...d.categories);
    else if (Array.isArray(d)) listItems.push(...d);
    else if (d.siteSlug || Array.isArray(d.gallery)) details.push(d);
  }
  return { categories, listItems, details };
}

// A cartpe listing/detail record -> the product shape methodA's updateProduct wants.
export function toProduct(p, catName, base) {
  const price = p.wpBasicPrice ?? p.basicPrice ?? null;        // the DISPLAYED price (e.g. 901)
  const mrp = p.wpOldPrice ?? p.oldPrice ?? null;
  const sizes = Array.isArray(p.sizes) ? p.sizes.map((s) => String(s.sizeName)).filter(Boolean) : [];
  const inStock = p.stock === 1 || (Array.isArray(p.sizes) && p.sizes.some((s) => Number(s.qty) > 0));
  const brand = (p.productName || "").trim().split(/\s+/).slice(0, 2).join(" ");
  const gallery = Array.isArray(p.gallery) && p.gallery.length
    ? p.gallery.map((g) => cartpeImg(g.image)).filter(Boolean)
    : [cartpeImg(p.image)].filter(Boolean);
  return {
    productName: p.productName,
    productOriginalPrice: price,
    productPriceWithoutDiscount: mrp,
    productBrand: brand,
    featuredimg: cartpeImg(p.image) || gallery[0] || null,
    sizeName: sizes,
    productUrl: `${base}/product-detail/${p.siteSlug}`,
    imageUrl: gallery,
    videoUrl: p.video || null,
    productShortDescription: p.description || "",
    catName,
    productFetchedFrom: base,
    availability: inStock,
  };
}

const readHarvest = (page) => page.evaluate(() => (window.__harvest ? window.__harvest.splice(0) : []));

// Click "Load More Product" until the whole category is loaded (or the button is gone).
async function loadAllProducts(page) {
  for (let i = 0; i < 800; i++) {
    const st = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find((b) => /load more/i.test(b.textContent || ""));
      const total = parseInt((document.querySelector('#total_result_cnt')?.textContent || '0').replace(/\D/g, ''), 10) || 0;
      const loaded = document.querySelectorAll('.featured-products-grid .product-card').length;
      if (btn && (!total || loaded < total)) { btn.click(); return { more: true, loaded, total }; }
      return { more: false, loaded, total };
    });
    if (!st.more) break;
    await delay(1600);
  }
}

export async function fetchDataC(baseUrl, DB) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  console.log(`🚀 [methodC] crawl ${base}`);

  const { browser, page } = await launchWithPage(puppeteer, {
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
    defaultViewport: { width: 1080, height: 900 },
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote'],
  }, { label: 'methodC' });

  const products = [];
  try {
    await page.evaluateOnNewDocument(harvestHook);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    // Keep script/xhr/fetch (the app + API must run); drop heavy assets to save RAM.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    // 1) categories
    await page.goto(`${base}/category`, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(2000);
    const { categories } = classifyHarvest(await readHarvest(page));
    console.log(`[methodC] ${categories.length} categories`);

    // 2) products per category
    for (const cat of categories) {
      if (!cat || !cat.slug) continue;
      try {
        await readHarvest(page); // clear buffer
        await page.goto(`${base}/shop?c=${encodeURIComponent(cat.slug)}`, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(2000);
        await loadAllProducts(page);
        await delay(500);
        const { listItems } = classifyHarvest(await readHarvest(page));

        const seen = new Set();
        let n = 0;
        for (const p of listItems) {
          if (!p || !p.siteSlug || seen.has(p.id)) continue;
          seen.add(p.id);
          const prod = toProduct(p, cat.category_name, base);
          products.push(prod);
          try { updateProductCategory(prod); } catch (e) { /* best effort */ }
          try { await updateProduct(prod, DB); } catch (e) { console.error('[methodC] updateProduct:', e.message); }
          n++;
        }
        console.log(`[methodC] ${cat.category_name}: ${n} products`);
      } catch (e) {
        console.error(`[methodC] category '${cat.category_name}' failed:`, e.message);
      }
    }
  } catch (e) {
    console.error('[methodC] crawl failed:', e.message);
  } finally {
    await browser.close();
  }
  console.log(`🏁 [methodC] done — ${products.length} products`);
  return products;
}
