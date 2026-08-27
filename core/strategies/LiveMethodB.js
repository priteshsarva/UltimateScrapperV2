import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { launchWithPage } from '../launchBrowser.js';
import { dbManager } from '../../models/dbManager.js';
import "dotenv/config";

// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

/**
 * Scrapes a single product using Method B structure, updates the local DB,
 * and returns the fresh data object.
 *
 * DEAD-PAGE HANDLING (same contract as Method A)
 * availability is forced to 0 when ANY of these is true:
 *   - navigation failed (timeout, DNS, connection reset)
 *   - HTTP status >= 400
 *   - the page renders an error/404 body despite a 200 status (SOFT 404)
 *   - the product title element is missing (not a product page)
 *
 * FIXED: the previous version defaulted to availability = 1 whenever the
 * `.item-stock-status p` element was absent. On a 404 page that element is
 * always absent, so dead products were being marked IN STOCK.
 */
export async function scrapeSingleProductMethodB(productUrl, dbName) {
    console.log(`\n🚀 [LiveMethodB] Starting single scrape for: ${productUrl}`);

    let browser = null;
    let freshData = null;
    let dead = false;
    let deadReason = '';

    try {
        // Retry wrapper + '--single-process' removed — see core/launchBrowser.js
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
        }, { label: 'liveMethodB' });
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
        // Treated as "product unavailable", NOT as a crash.
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
            console.log(`🕵️‍♂️ Extracting product details (Method B)...`);
            try {
                freshData = await page.evaluate(() => {

                    let availability = 0;

                    // --- TITLE ---
                    // In Method B, the title is inside .product-right h3
                    const titleEl = document.querySelector(".product-right h3");
                    const productName = titleEl ? titleEl.textContent.trim() : null;

                    // --- SOFT 404 DETECTION ---
                    const errBox   = document.querySelector('.error_box_404, .img_404, .error-404, .page-404');
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

                    // --- PRICE ---
                    // In Method B, the price is inside .price-wrapper span.font-bold
                    const priceEl = document.querySelector(".product-right .price-wrapper span.font-bold");
                    let productOriginalPrice = null;
                    if (priceEl && priceEl.textContent) {
                        // strip currency/commas — /\d+/ alone truncated "₹6,200" to 6
                        const n = priceEl.textContent.replace(/[^0-9.]/g, "");
                        if (n) productOriginalPrice = parseFloat(n);
                    }

                    // --- AVAILABILITY (STOCK) ---
                    // Method B says "Out of stock" (or "In stock") inside .item-stock-status p
                    //
                    // FIXED: previously a MISSING stock element fell into `else` and set
                    // availability = 1. On a 404 page the element is always missing, so
                    // deleted products were marked in stock. Now a missing element only
                    // means "in stock" when there is a real product title on the page.
                    const stockStatus = document.querySelector('.item-stock-status p');
                    if (stockStatus) {
                        availability = stockStatus.textContent.toLowerCase().includes('out of stock') ? 0 : 1;
                    } else {
                        availability = titleEl ? 1 : 0;
                    }

                    // --- IMAGES ---
                    // Method B hides high-res images in the thumbnail buttons: .thumbs-sub-slider button img
                    const imgElements = document.querySelectorAll('.thumbs-sub-slider button img');
                    let imageUrls = Array.from(imgElements).map(img => img.src).filter(src => src && !src.includes('placeholder'));

                    // Fallback: Check the main slider if thumbs aren't loaded yet
                    if (imageUrls.length === 0) {
                        const mainImgs = document.querySelectorAll('.product-slide .relative.w-full img');
                        imageUrls = Array.from(mainImgs).map(img => img.src).filter(src => src && !src.includes('placeholder'));
                    }

                    const featuredimg = imageUrls.length > 0 ? imageUrls[0] : null;

                    // --- VIDEO ---
                    // Method B has the video hidden inside the thumbnail slider or main slider: video source
                    const videoEl = document.querySelector('.product-slide video source');
                    const videoUrl = videoEl ? videoEl.src : null;

                    // --- SIZES ---
                    const sizeElements = document.querySelectorAll('.size-badge, .size-setup ul li a');
                    const sizeName = Array.from(sizeElements).map(el => el.textContent.trim());

                    return {
                        productName,
                        productOriginalPrice,
                        availability,
                        imageUrl: imageUrls,
                        featuredimg,
                        videoUrl,
                        sizeName,
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
            console.log(`⚠️ [LiveMethodB] Product unavailable — ${deadReason}. Forcing availability to 0.`);
            // Smart Merge keeps the old Name/Price/Images but forces stock to 0.
            freshData = {
                productName: null,
                productOriginalPrice: null,
                availability: 0,
                imageUrl: [],
                featuredimg: null,
                videoUrl: null,
                sizeName: []
            };
        } else {
            console.log('✅ Raw Extracted Data:', freshData);
        }

    } catch (error) {
        // Only infrastructure failures reach here (browser launch, page creation).
        console.error('❌[LiveMethodB] Scraping failed:', error.message);
        throw error;
    } finally {
        if (browser) await browser.close();
    }

    if (!freshData) {
        throw new Error("Failed to extract any data from the page.");
    }

    // 3. SMART MERGE & UPDATE LOCAL DATABASE
    console.log(`💾 Smart Merging and Updating '${dbName}.db'...`);
    const db = await dbManager.getDb(dbName);
    
    const existingRow = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM PRODUCTS WHERE productUrl = ?",[productUrl], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    if (!existingRow) {
        throw new Error(`Product URL not found in local DB '${dbName}'. Cannot perform Smart Merge.`);
    }

    // Merge logic: Keep old name/price if scraper couldn't find it (common when OOS)
    const finalName = freshData.productName || existingRow.productName;
    const finalPrice = freshData.productOriginalPrice || existingRow.productOriginalPrice;
    
    const finalAvailability = freshData.availability;
    const finalImages = freshData.imageUrl.length > 0 ? JSON.stringify(freshData.imageUrl) : existingRow.imageUrl;
    const finalFeatured = freshData.featuredimg || existingRow.featuredimg;
    const finalVideo = freshData.videoUrl || existingRow.videoUrl;
    
    // Clear sizes if OOS
    const finalSizes = finalAvailability === 0 ? '[]' : JSON.stringify(freshData.sizeName);
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
            productLastUpdated = ? 
        WHERE productUrl = ?
    `;

    const params =[
        finalName,
        finalPrice,
        finalAvailability,
        finalImages,
        finalFeatured,
        finalVideo,
        finalSizes,
        nowTimestamp, 
        productUrl
    ];

    await new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err);
            else {
                console.log(`✅ DB Update successful. Rows changed: ${this.changes}`
                    + (dead ? ` (marked OUT OF STOCK — ${deadReason})` : ''));
                resolve(this.changes);
            }
        });
    });

    // 4. Return the fully merged row
    const updatedRow = await new Promise((resolve, reject) => {
        db.get("SELECT * FROM PRODUCTS WHERE productUrl = ?", [productUrl], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });

    return updatedRow; 
}
