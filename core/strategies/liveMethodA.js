import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { launchWithPage } from '../launchBrowser.js';
import { dbManager } from '../../models/dbManager.js'; // Adjust path if needed
import "dotenv/config";

// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

/**
 * Scrapes a single product using Method A structure, updates the local DB,
 * and returns the fresh data object.
 *
 * DEAD-PAGE HANDLING
 * A product is forced to availability = 0 when ANY of these is true:
 *   - navigation failed (timeout, DNS, connection reset)
 *   - HTTP status >= 400
 *   - the page renders cartpe's 404 body (.error_box_404 / .img_404 /
 *     "Page Not Found") even though it returns HTTP 200 — a SOFT 404
 *   - the product title element is missing (not a product page)
 *
 * The DB row is still UPDATED in that case rather than skipped: the smart merge
 * keeps the old name/price/images and only flips stock to 0. productLastUpdated
 * is bumped, so the WordPress plugin's ts-sweep picks the change up next pass.
 */
export async function scrapeSingleProductMethodA(productUrl, dbName) {
    console.log(`\n🚀 [LiveMethodA] Starting single scrape for: ${productUrl}`);

    let browser = null;
    let freshData = null;
    let dead = false;
    let deadReason = '';

    try {
        // Launch through the shared retry wrapper (see core/launchBrowser.js) —
        // '--single-process' removed: with new headless it is the most fragile
        // Chrome mode and the classic trigger for "Requesting main frame too early".
        const lp = await launchWithPage(puppeteer, {
            headless: "new", // 'new' uses less RAM than the old 'true' architecture
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            defaultViewport: { width: 800, height: 600 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // MUST be included on Linux
                '--disable-gpu',
                '--no-zygote',
                '--disable-extensions',
                '--no-first-run',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-client-side-phishing-detection',
                '--disable-default-apps',
                '--disable-hang-monitor',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--mute-audio',
                '--safebrowsing-disable-auto-update',
                '--js-flags=--max-old-space-size=256 --expose-gc' // Force aggressive garbage collection
            ]
        }, { label: 'liveMethodA' });
        browser = lp.browser;   // outer var so 'finally' still closes it
        const page = lp.page;
        // Prevent images and fonts from loading in the single scraper to save massive amounts of RAM
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(request.resourceType())) {
                request.abort(); // Don't download images or fonts!
            } else {
                request.continue();
            }
        });

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        );

        console.log(`⏳ Navigating to product page...`);

        // ==========================================
        // 🚨 NAVIGATION FAILURE (timeout / DNS / reset)
        // Treated as "product unavailable", NOT as a crash — we still want to
        // write availability = 0 rather than leave a dead product in stock.
        // ==========================================
        let httpStatus = 0;
        try {
            const response = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            httpStatus = response ? response.status() : 0;
        } catch (navErr) {
            dead = true;
            deadReason = `navigation failed: ${navErr.message}`;
        }

        // ==========================================
        // 🚨 HTTP ERROR STATUS (hard 404 / 410 / 5xx)
        // ==========================================
        if (!dead && httpStatus >= 400) {
            dead = true;
            deadReason = `HTTP ${httpStatus}`;
        }

        if (!dead) {
            console.log(`🕵️‍♂️ Extracting product details...`);
            try {
                freshData = await page.evaluate(() => {

                    // Initialize default values to prevent ReferenceErrors
                    let productName = null;
                    let productOriginalPrice = null;
                    let availability = 0;
                    let imageUrls = [];
                    let featuredimg = null;
                    let videoUrl = null;
                    let sizeName = [];

                    // --- TITLE ---
                    const titleEl = document.querySelector(".s_product_text > h1");
                    productName = titleEl ? titleEl.textContent.trim() : null;

                    // --- SOFT 404 DETECTION ---
                    // cartpe serves its 404 body with a 200 status. Markers taken
                    // from the real 404 markup: hidden #container h1, .error_box_404,
                    // .img_404.
                    const errBox   = document.querySelector('.error_box_404, .img_404');
                    const hiddenH1 = document.querySelector('#container h1');
                    const docTitle = (document.title || '').toLowerCase();
                    const bodyTxt  = (document.body ? (document.body.innerText || '') : '')
                                        .slice(0, 2000).toLowerCase();

                    const pageIsError =
                        !!errBox ||
                        (hiddenH1 && /404|not\s*found/i.test(hiddenH1.textContent || '')) ||
                        /404|page not found/.test(docTitle) ||
                        // body text is only trusted when there is no product title
                        // anyway, so a product legitimately named "404" can't
                        // false-positive
                        (!titleEl && /page not found|404/.test(bodyTxt));

                    if (titleEl) {
                        // --- PRICE ---
                        const priceEl = document.querySelector(".s_product_text #price_div h1");
                        if (priceEl && priceEl.textContent) {
                            // strip currency/commas like the bulk crawler — /\d+/ alone
                            // truncated "₹6,200" to 6, overwriting the real price with 6
                            const n = priceEl.textContent.replace(/[^0-9.]/g, "");
                            if (n) productOriginalPrice = parseFloat(n);
                        }

                        // --- AVAILABILITY (STOCK) ---
                        const outOfStockBadge = document.querySelector('.badge-danger');
                        if (outOfStockBadge && outOfStockBadge.textContent.toLowerCase().includes('out of stock')) {
                            availability = 0;
                        } else {
                            availability = 1;
                        }

                        // --- IMAGES ---
                        const imgElements = document.querySelectorAll('#slider .slides .main-image img');
                        imageUrls = Array.from(imgElements).map(img => img.src).filter(src => src);
                        featuredimg = imageUrls.length > 0 ? imageUrls[0] : null;

                        // --- VIDEO ---
                        const videoEl = document.querySelector('video#myVideo source');
                        videoUrl = videoEl ? videoEl.src : null;

                        // --- SIZES ---
                        const sizeElements = document.querySelectorAll('.size-setup ul li a.size_click');
                        sizeName = Array.from(sizeElements).map(el => el.textContent.trim());
                    }

                    // --- CATEGORY (best-effort, from the breadcrumb) ---
                    // The last crumb is usually the product itself, so the category
                    // is the crumb before it. Left null when no breadcrumb is present
                    // (the merge then keeps the existing catName).
                    let catName = null;
                    const crumbEls = document.querySelectorAll('.breadcrumb a, .breadcrumb li, ul.breadcrumb li, nav.breadcrumb a, .breadcrumbs a, .product-breadcrumb a');
                    const crumbTexts = Array.from(crumbEls)
                        .map(c => (c.textContent || '').trim())
                        .filter(t => t && t.length < 60 && !/^home$/i.test(t));
                    if (crumbTexts.length >= 2) catName = crumbTexts[crumbTexts.length - 2];
                    else if (crumbTexts.length === 1) catName = crumbTexts[0];

                    return {
                        productName,
                        productOriginalPrice,
                        availability,
                        imageUrl: imageUrls,
                        featuredimg,
                        videoUrl,
                        sizeName,
                        catName,
                        pageIsError,
                        hasTitle: !!titleEl
                    };
                });
            } catch (evalErr) {
                dead = true;
                deadReason = `extraction failed: ${evalErr.message}`;
            }
        }

        // ==========================================
        // 🚨 SOFT 404 / NOT A PRODUCT PAGE
        // ==========================================
        if (!dead && freshData) {
            if (freshData.pageIsError) {
                dead = true;
                deadReason = 'soft 404 (error page markup)';
            } else if (!freshData.hasTitle) {
                dead = true;
                deadReason = 'no product title on page';
            }
        }

        if (dead) {
            console.log(`⚠️ [LiveMethodA] Product unavailable — ${deadReason}. Forcing availability to 0.`);
            // Smart Merge keeps the old Name/Price/Images but forces stock to 0.
            freshData = {
                productName: null,
                productOriginalPrice: null,
                availability: 0,
                imageUrl: [],
                featuredimg: null,
                videoUrl: null,
                sizeName: [],
                catName: null
            };
        } else {
            console.log('✅ Raw Extracted Data:', freshData);
        }

    } catch (error) {
        // Only infrastructure failures reach here (browser launch, page creation).
        // Those are our problem, not the product's — surface them.
        console.error('❌ [LiveMethodA] Scraping failed:', error.message);
        throw error;
    } finally {
        if (browser) await browser.close(); // Memory leak fixed!
    }

    if (!freshData) {
        throw new Error("Failed to extract any data from the page.");
    }

    // 3. SMART MERGE & UPDATE LOCAL DATABASE
    console.log(`💾 Smart Merging and Updating '${dbName}.db'...`);
    const db = await dbManager.getDb(dbName);

    // Fetch existing product to protect old data (like Name and Price if it's Out of Stock or 404)
    const existingRow = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM PRODUCTS WHERE productUrl = ?", [productUrl], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    if (!existingRow) {
        throw new Error(`Product URL not found in local DB '${dbName}'. Cannot perform Smart Merge.`);
    }

    // Merge logic: If the site returned 404 or hid the name/price because it's OOS, keep our DB's saved name/price!
    const finalName = freshData.productName || existingRow.productName;
    const finalPrice = freshData.productOriginalPrice || existingRow.productOriginalPrice;

    // Always trust the live scraper for availability and images
    const finalAvailability = freshData.availability;
    const finalImages = freshData.imageUrl.length > 0 ? JSON.stringify(freshData.imageUrl) : existingRow.imageUrl;
    const finalFeatured = freshData.featuredimg || existingRow.featuredimg;
    const finalVideo = freshData.videoUrl || existingRow.videoUrl;

    // If it's out of stock (or 404), clear the sizes array
    const finalSizes = finalAvailability === 0 ? '[]' : JSON.stringify(freshData.sizeName);
    // Category: only overwrite when we actually read one (and the page was live) —
    // otherwise keep the crawler's stored catName so the vendor's category map
    // keeps matching.
    const finalCat = (!dead && freshData.catName) ? freshData.catName : existingRow.catName;
    const nowTimestamp = Date.now();

    const sql = `
        UPDATE PRODUCTS
        SET productName = ?,
            productOriginalPrice = ?,
            availability = ?,
            imageUrl = ?,
            featuredimg = ?,
            videoUrl = ?,
            sizeName = ?,
            catName = ?,
            productLastUpdated = ?
        WHERE productUrl = ?
    `;

    const params = [
        finalName,
        finalPrice,
        finalAvailability,
        finalImages,
        finalFeatured,
        finalVideo,
        finalSizes,
        finalCat,
        nowTimestamp,
        productUrl
    ];

    await new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else {
                console.log(`✅ DB Update successful. Rows changed: ${this.changes}`
                    + (dead ? ` (marked OUT OF STOCK — ${deadReason})` : ''));
                resolve(this.changes);
            }
        });
    });

    // 4. Return the beautifully merged row so WooCommerce gets perfect data
    const updatedRow = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM PRODUCTS WHERE productUrl = ?", [productUrl], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    return updatedRow;
}
