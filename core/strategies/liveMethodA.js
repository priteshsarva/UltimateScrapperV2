import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { dbManager } from '../../models/dbManager.js'; // Adjust path if needed
import "dotenv/config";

// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

/**
 * Scrapes a single product using Method A structure, updates the local DB, 
 * and returns the fresh data object.
 */
export async function scrapeSingleProductMethodA(productUrl, dbName) {
    console.log(`\n🚀 [LiveMethodA] Starting single scrape for: ${productUrl}`);

    let browser = null;
    let freshData = null;

    try {
        // 👇 FIXED MEMORY LEAK: Removed 'const' so the outer 'browser' variable gets assigned and properly closed in 'finally'
        browser = await puppeteer.launch({
            headless: "new", // 'new' uses less RAM than the old 'true' architecture
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
            defaultViewport: { width: 800, height: 600 },
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // MUST be included on Linux
                '--disable-gpu',
                '--no-zygote',
                '--single-process', // Warning: Only use if 'new' headless mode is active
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
        });

        const page = await browser.newPage();
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

        // 👇 Grab the HTTP response to check the status code
        const response = await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // ==========================================
        // 🚨 404 ERROR HANDLING (PAGE DELETED)
        // ==========================================
        if (response && response.status() === 404) {
            console.log(`⚠️ [LiveMethodA] Product page returned 404 Not Found! Forcing availability to 0.`);

            // Set dummy data for 404. Smart Merge will keep the old Name/Price/Images but force stock to 0.
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
            // Page loaded normally, let's extract the data!
            console.log(`🕵️‍♂️ Extracting product details...`);
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

                if (titleEl) {
                    // --- PRICE ---
                    const priceEl = document.querySelector(".s_product_text #price_div h1");
                    if (priceEl && priceEl.textContent) {
                        const match = priceEl.textContent.match(/\d+/);
                        if (match) productOriginalPrice = parseInt(match[0], 10);
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

                return {
                    productName,
                    productOriginalPrice,
                    availability,
                    imageUrl: imageUrls,
                    featuredimg,
                    videoUrl,
                    sizeName
                };
            });
        }

        console.log('✅ Raw Extracted Data:', freshData);

    } catch (error) {
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

    const params = [
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
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else {
                console.log(`✅ DB Update successful. Rows changed: ${this.changes}`);
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