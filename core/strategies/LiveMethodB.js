import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { dbManager } from '../../models/dbManager.js';
import "dotenv/config";

// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

export async function scrapeSingleProductMethodB(productUrl, dbName) {
    console.log(`\n🚀 [LiveMethodB] Starting single scrape for: ${productUrl}`);
    
    let browser = null;
    let freshData = null;

    try {
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
        await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        console.log(`🕵️‍♂️ Extracting product details (Method B)...`);
        freshData = await page.evaluate(() => {

             let availability = 0; 
            
            // --- TITLE ---
            // In Method B, the title is inside .product-right h3
            const titleEl = document.querySelector(".product-right h3");
            const productName = titleEl ? titleEl.textContent.trim() : null;

            // --- PRICE ---
            // In Method B, the price is inside .price-wrapper span.font-bold
            const priceEl = document.querySelector(".product-right .price-wrapper span.font-bold");
            let productOriginalPrice = null;
            if (priceEl && priceEl.textContent) {
                // Extracts digits, e.g., "₹350.00" -> 350
                const match = priceEl.textContent.match(/\d+/);
                if (match) productOriginalPrice = parseInt(match[0], 10);
            }

            // --- AVAILABILITY (STOCK) ---
            // Method B says "Out of stock" (or "In stock") inside .item-stock-status p
           
            const stockStatus = document.querySelector('.item-stock-status p');
            if (stockStatus && stockStatus.textContent.toLowerCase().includes('out of stock')) {
                availability = 0;
            }else{
                availability = 1;
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
            // Method B size extraction (You didn't provide HTML for sizes, but this is a standard fallback)
            const sizeElements = document.querySelectorAll('.size-badge, .size-setup ul li a');
            const sizeName = Array.from(sizeElements).map(el => el.textContent.trim());

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

        console.log('✅ Raw Extracted Data:', freshData);

    } catch (error) {
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
                console.log(`✅ DB Update successful. Rows changed: ${this.changes}`);
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