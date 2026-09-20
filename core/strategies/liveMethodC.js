// LiveMethodC — single-product refresh for cartpe.in stores (METHOD_C).
// Loads /product-detail/<siteSlug>, harvests the DECRYPTED /api/product-details
// response (see methodC.js for why), smart-merges over the existing DB row, and
// returns the fresh row. Same contract as scrapeSingleProductMethodA/B.
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { launchWithPage } from '../launchBrowser.js';
import { dbManager } from '../../models/dbManager.js';
import { harvestHook, classifyHarvest, cartpeImg } from './methodC.js';
import "dotenv/config";

puppeteer.use(StealthPlugin());

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function scrapeSingleProductMethodC(productUrl, dbName) {
  console.log(`\n🚀 [LiveMethodC] ${productUrl}`);
  let browser = null;
  let detail = null;      // decrypted product-details data, or null when dead
  let dead = false, deadReason = '';

  try {
    const lp = await launchWithPage(puppeteer, {
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
      defaultViewport: { width: 800, height: 600 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--mute-audio'],
    }, { label: 'liveMethodC' });
    browser = lp.browser;
    const page = lp.page;

    await page.evaluateOnNewDocument(harvestHook);
    // Keep script/xhr/fetch (the API must run); drop heavy assets.
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'media', 'font', 'stylesheet'].includes(req.resourceType())) req.abort();
      else req.continue();
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

    let status = 0;
    try {
      const resp = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      status = resp ? resp.status() : 0;
    } catch (e) { dead = true; deadReason = `navigation failed: ${e.message}`; }
    if (!dead && status >= 400) { dead = true; deadReason = `HTTP ${status}`; }

    if (!dead) {
      // Poll for the decrypted product-details response (the XHR may resolve just
      // after networkidle2).
      for (let i = 0; i < 12 && !detail; i++) {
        const { details } = classifyHarvest(await page.evaluate(() => (window.__harvest ? window.__harvest.slice() : [])));
        if (details.length) detail = details[details.length - 1];
        else await delay(1000);
      }
      if (!detail) { dead = true; deadReason = 'no product-details response harvested'; }
    }
  } catch (e) {
    console.error('❌ [LiveMethodC] infra failure:', e.message);
    throw e;
  } finally {
    if (browser) await browser.close();
  }

  // Build the fresh values (or a dead marker that only forces stock to 0).
  let fresh;
  if (dead || !detail) {
    console.log(`⚠️ [LiveMethodC] unavailable — ${deadReason}. Forcing availability 0.`);
    fresh = { productName: null, productOriginalPrice: null, availability: 0, imageUrl: [], featuredimg: null, videoUrl: null, sizeName: [] };
  } else {
    const sizes = Array.isArray(detail.sizes) ? detail.sizes : [];
    const gallery = Array.isArray(detail.gallery) && detail.gallery.length
      ? detail.gallery.map((g) => cartpeImg(g.image)).filter(Boolean)
      : [cartpeImg(detail.image)].filter(Boolean);
    fresh = {
      productName: detail.productName || null,
      productOriginalPrice: detail.wpBasicPrice ?? detail.basicPrice ?? null,
      availability: (detail.stock === 1 || sizes.some((s) => Number(s.qty) > 0)) ? 1 : 0,
      imageUrl: gallery,
      featuredimg: cartpeImg(detail.image) || gallery[0] || null,
      videoUrl: detail.video || null,
      sizeName: sizes.map((s) => String(s.sizeName)).filter(Boolean),
    };
    console.log('✅ [LiveMethodC] extracted:', fresh.productName, fresh.productOriginalPrice, 'stock=' + fresh.availability);
  }

  // Smart-merge over the existing row (keep name/price/images when dead).
  const db = await dbManager.getDb(dbName);
  const existing = await new Promise((resolve, reject) =>
    db.get("SELECT * FROM PRODUCTS WHERE productUrl = ?", [productUrl], (e, r) => (e ? reject(e) : resolve(r))));
  if (!existing) throw new Error(`Product URL not in '${dbName}' DB — cannot merge.`);

  const finalImages = fresh.imageUrl.length ? JSON.stringify(fresh.imageUrl) : existing.imageUrl;
  const params = [
    fresh.productName || existing.productName,
    fresh.productOriginalPrice || existing.productOriginalPrice,
    fresh.availability,
    finalImages,
    fresh.featuredimg || existing.featuredimg,
    fresh.videoUrl || existing.videoUrl,
    fresh.availability === 0 ? '[]' : JSON.stringify(fresh.sizeName),
    Date.now(),
    productUrl,
  ];
  await new Promise((resolve, reject) => {
    db.run(`UPDATE PRODUCTS SET productName=?, productOriginalPrice=?, availability=?, imageUrl=?, featuredimg=?, videoUrl=?, sizeName=?, productLastUpdated=? WHERE productUrl=?`,
      params, function (e) { e ? reject(e) : resolve(this.changes); });
  });

  return await new Promise((resolve, reject) =>
    db.get("SELECT * FROM PRODUCTS WHERE productUrl = ?", [productUrl], (e, r) => (e ? reject(e) : resolve(r))));
}
