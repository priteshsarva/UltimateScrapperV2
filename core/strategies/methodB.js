import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as cheerio from 'cheerio';
// import { DB } from '../connect.js';
import fs from 'fs';
import path, { resolve } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { rejects } from 'assert';
import "dotenv/config";
import { exec } from 'child_process';
import { humanizePage, humanType } from '../humanize.js';
import { upsertProductSafe, syncProductToAllSites } from '../wpBulkSafeSync.js'
import { updateProductCategory } from '../../services/updateProductCategoryAndBrand.js';

// const baseUrls = ['https://oneshoess.cartpe.in', 'https://reseller-store.cartpe.in'];
// const baseUrls = ['https://oneshoess.cartpe.in'];


// Use the stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

let DB
// Promisify DB methods for easier async/await usage
// DB.run = promisify(DB.run);
// DB.get = promisify(DB.get);

// Utility function to introduce delays
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Get the current directory name
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Function to download images
async function downloadImage(url, folderPath) {
    try {
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const fileName = path.basename(url);
        const filePath = path.join(folderPath, fileName);

        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, Buffer.from(buffer));
            console.log(`Downloaded: ${fileName}`);
        } else {
            console.log(`File already exists: ${fileName}`);
        }

        return filePath;
    } catch (error) {
        console.error("Error downloading image:", url, error);
        return null;
    }
}

// Utility function to get the first two words of a string
function getFirstTwoWords(inputString) {
    const words = inputString.split(' ');
    return words.slice(0, 2).join(' ');
}

function gitAutoCommitAndPush() {
    const now = new Date();
    const dateTimeString = now.toISOString().replace('T', ' ').split('.')[0]; // Format: YYYY-MM-DD HH:mm:ss
    const commitMessage = `DB updated on ${dateTimeString}`;

    // Step 1: Add all changes
    exec('git add .', (err) => {
        if (err) {
            console.error('❌ Error adding files', err);
            return;
        }
        console.log('✅ Changes staged.');

        // Step 2: Commit with message
        exec(`git commit -m "${commitMessage}"`, (err) => {
            if (err) {
                if (err.message.includes('nothing to commit')) {
                    console.log('ℹ️ No changes to commit.');
                    return;
                }
                console.error('❌ Error committing:', err);
                return;
            }
            console.log('✅ Changes committed.');

            // Step 4: Push to remote
            exec('git push', (err) => {
                if (err) {
                    console.error('❌ Error pushing to remote:', err);
                    return;
                }
                console.log('✅ Changes pushed to remote repository.');
            });

            // Step 3: Pull before pushing to avoid remote conflicts
            // exec('git pull --rebase', (err, stdout, stderr) => {
            //     if (err) {
            // console.error('❌ Error pulling from remote:', stderr || err);
            //         return;
            //     }
            //     console.log('✅ Pulled latest changes from remote.');
            // });

        });
    });
}

// Main function to fetch data
async function fetchDataaB(singleUrl, DB) {
    console.log(Date.now());
    // gitAutoCommitAndPush();



    const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        defaultViewport: { width: 1080, height: 800 },
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--no-zygote',
            '--window-size=1080,800',
            '--start-maximized'
        ]
    });

    const page = await browser.newPage();

    // ✅ Use realistic headers
    await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
        'accept-language': 'en-US,en;q=0.9',
        'upgrade-insecure-requests': '1'
    });

    // ✅ Optional: add random delay to look human
    await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 2000) + 1000));


    const allproducts = [];


    const url = singleUrl;
    const fullUrl = `${url}//categories`;
    let productss = []; // Initialize productss for each URL

    try {
        // Scrape categories from the current URL 
        const categories = await scrapeCategories(page, fullUrl, DB);
        // Scrape products for each category
        productss = await scrapeProducts(page, categories, url, DB); // Pass the base URL here
    } catch (error) {
        console.error(`Error fetching data from ${url}` + ":", error);
    } finally {
        // Add scraped products to the final array        
        allproducts.push(...productss); // Use spread operator to flatten the array
    }

    // 🔁 Rotate: first to last
    // baseUrls.push(baseUrls.shift());

    // // 💾 Save updated rotation to baseUrls.js (live)
    // const newFileContent = `const baseUrls = ${JSON.stringify(baseUrls, null, 3)};\n\nexport { baseUrls };`;
    // try {
    //     fs.writeFileSync(baseUrlsPath, newFileContent, "utf-8");
    //     console.log("File written successfully!");
    // } catch (err) {
    //     // // // console.error("Failed to write baseUrls.js:", err);
    // }

    // console.log(`✅ Rotated & saved baseUrls.js — next start will begin from: ${baseUrls[0]}`);

    // Close the browser after scraping all URLs
    await browser.close();

    // Call the function when your task is done
    // gitAutoCommitAndPush();
    console.log("finished");
    console.log(Date.now());
    return allproducts;
    // }
}

// Function to scrape categories
async function scrapeCategories(page, fullUrl, DB, retries = 3) {
    console.log("scrapeCategories");

    for (let i = 0; i < retries; i++) {
        try {
            // Navigate to the category page
            await page.goto(fullUrl, { waitUntil: 'networkidle2', timeout: 60000 });
            await delay(1500);
            // Extract category data
            const categories = await page.evaluate(() => {
                const categoryElements = document.querySelectorAll('div.abs_image_wrapper');
                return Array.from(categoryElements).map(element => ({
                    catTitle: element.querySelector('img').alt,
                    catimg: element.querySelector('img').src,
                    caturl: element.querySelector('a').href,

                }));
            });


            // Add categories to the database
            for (const cat of categories) {
                const catExists = await DB.get(`SELECT catId FROM CATEGORIES WHERE catName = ?`, [cat.catTitle]);

                if (!catExists) {
                    await DB.run(`INSERT INTO CATEGORIES (catName, catImg, catSlug) VALUES (?, ?, ?)`, [cat.catTitle, cat.catimg, cat.caturl]);
                    console.log(`Added category: ${cat.catTitle}`);
                }
            }

            console.log(categories);

            return categories;
        } catch (error) {
            console.error(`Attempt ${i + 1} failed`, error.message);
            if (i === retries - 1) throw error; // Throw error if all retries fail
            await delay(5000); // Wait 5 seconds before retrying
        }
    }
}

// Function to scrape products
async function scrapeProducts(page, categories, baseUrl, DB) {
    const products = [];
    await humanizePage(page, { mouseMoves: 3 });
    // Loop through each category
    for (const cat of categories) {
        const catProductss = []
        const productUrl = cat.caturl;
        console.log(cat.caturl);

        try {
            // Navigate to the product page
            await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 6000 }); // Increase timeout to 120 seconds
            await delay(1500);
            // await page.waitForSelector('#product_list_div', { timeout: 60000 }); // Increase timeout
            console.log("in product page");
            // will procced to next step if either products are found or "not found" message appears, otherwise it will timeout after 15 seconds
            const result = await Promise.race([
                page.waitForSelector('.shop-p-grid', { timeout: 15000 }).then(() => 'products'),
                page.waitForSelector('.alert.alert-danger.text-center', { timeout: 15000 }).then(() => 'notfound')
            ]);

            if (result === 'notfound') {
                console.log(`No products found on ${productUrl}, skipping...`);
                continue; // go to next category
            }

            // Get the total number of products
            const productCount = await page.evaluate(() => {
                return document.querySelector('#total_result_cnt')?.innerText || 0;
            });

            // for temporary disable 
            // await viewMore(page, productCount)
            await viewMore(page)
            console.log("After view more");


            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await delay(2000);

            const productElements = await page.evaluate(async () => {
                // 1. Helper function to sleep inside the browser
                const delay = (ms) => new Promise(res => setTimeout(res, ms));

                // 2. Check for placeholders
                const hasPlaceholders = () => {
                    const imgs = document.querySelectorAll('.shop-p-grid .product-card img');
                    return Array.from(imgs).some(img => img.src.includes('placeholder') || !img.src);
                };

                // 3. If placeholders exist, scroll down and wait to trigger lazy loading
                if (hasPlaceholders()) {
                    window.scrollBy(0, 800); // Small scroll to trigger Next.js IntersectionObserver
                    await delay(2000);       // Wait 2 seconds for URLs to swap
                    window.scrollBy(0, -800); // Scroll back up
                }

                const container = document.querySelector('.shop-p-grid');
                if (!container) return [];

                const items = container.querySelectorAll('.product-card');

                return Array.from(items).map(item => {
                    const link = item.querySelector('.abs_image_wrapper a');
                    const detailUrl = link?.href || null;

                    const img = item.querySelector('.abs_image_wrapper img');

                    // Use a prioritized selection for the image
                    // 1. Check srcset (best for high res) 
                    // 2. Check current src 
                    // 3. Check data-src (common lazy-load attribute)
                    let featuredimg = null;
                    const srcset = img?.getAttribute('srcset');
                    const dataSrc = img?.getAttribute('data-src');

                    if (srcset) {
                        const srcsetUrls = srcset.split(',').map(s => s.trim().split(' ')[0]);
                        featuredimg = srcsetUrls[srcsetUrls.length - 1];
                    } else {
                        featuredimg = dataSrc || img?.src || null;
                    }

                    // Clean up Next.js Proxy URLs
                    if (featuredimg && featuredimg.includes('/_next/image?url=')) {
                        try {
                            const urlObj = new URL(featuredimg, window.location.origin);
                            const rawUrl = urlObj.searchParams.get('url');
                            if (rawUrl) featuredimg = rawUrl;
                        } catch (e) { }
                    }

                    // Final Relative Path Fix
                    if (featuredimg && featuredimg.startsWith('/')) {
                        featuredimg = window.location.origin + featuredimg;
                    }

                    // Metadata extraction
                    const title = item.querySelector('h3')?.innerText.trim() || null;
                    const priceEl = item.querySelector('.product-cont-size p.font-bold');
                    const price = priceEl?.innerText.replace(/[^0-9.]/g, '').trim() || null;

                    const buttons = Array.from(item.querySelectorAll('button'));
                    const availability = buttons.some(btn => {
                        const text = btn.innerText.toLowerCase();
                        return text.includes("add to cart") || text.includes("buy now");
                    });

                    const sizeLabels = Array.from(item.querySelectorAll('label.badge, .size-badge, .text-xs.border'))
                        .map(l => l.innerText.trim())
                        .filter(s => s && s.toLowerCase() !== "size :");

                    return { title, price, featuredimg, detailUrl, availability, sizes: sizeLabels };
                });
            });

            // console.log(productElements);

            // Scrape images and descriptions for each product
            for (const product of productElements) {
                const { imageSlides, productShortDescription, videoURL } = await scrapeImages(page, product.detailUrl, DB);
                const result = getFirstTwoWords(product.title);

                // Download images and get local paths
                const imageFolder = path.join(__dirname, 'images', result.replace(/\s+/g, '_'));
                if (!fs.existsSync(imageFolder)) {
                    fs.mkdirSync(imageFolder, { recursive: true });
                }

                // const localImagePaths = [];
                // for (const imageUrl of imageSlides) {
                //     const localPath = await downloadImage(imageUrl, imageFolder);
                //     if (localPath) {
                //         localImagePaths.push(localPath);
                //     }
                // }

                // Add product to database
                catProductss.push({
                    productName: product.title,
                    productOriginalPrice: product.price,
                    productBrand: result,
                    featuredimg: product.featuredimg,
                    sizeName: product.sizes.map(String),
                    productUrl: product.detailUrl,
                    // imageUrl: localImagePaths,
                    imageUrl: imageSlides, //for img link
                    videoUrl: videoURL,
                    productShortDescription,
                    catName: cat.catTitle,
                    productFetchedFrom: baseUrl,
                    availability: product.availability
                });
            }



        } catch (error) {
            // // console.error(`Error scraping products frommmmmm ${productUrl}:`, error.message); 
        }

        console.log(catProductss);


        try {
            console.log("from try block");
            const API_DELAY_MS = 800; // 800ms between WooCommerce API calls

            for (let i = 0; i < catProductss.length; i++) {
                const eachproduct = catProductss[i];
                updateProductCategory(eachproduct);
                const { productId, skipforwordpress } = await updateProduct(eachproduct, DB);

                if (skipforwordpress) {
                    console.log(`⏭️ [${i + 1}/${catProductss.length}] Skipped WP sync (no changes). ProductID = ${productId}`);
                } else {
                    console.log(`🔄 [${i + 1}/${catProductss.length}] Syncing to WordPress... ProductID = ${productId}`);
                    await syncProductToAllSites(eachproduct, productId);

                    // 🔧 FIX: Wait between API calls to prevent MySQL connection flooding
                    if (i < catProductss.length - 1) {
                        console.log(`⏳ Waiting ${API_DELAY_MS}ms before next API call...`);
                        await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
                    }
                }
            }

            products.push(...catProductss)
            console.log("All products processed.");
            // Enable network domain to control cache
            const client = await page.target().createCDPSession();
            await client.send('Network.clearBrowserCache');
            await client.send('Network.clearBrowserCookies');

            console.log("Cache and cookies cleared!");
            // const productId = await addProductToDatabase(productData);

            // Add many-to-many relationships
            // await addProductRelationships(productId, productData);

        } catch (error) {
            // console.error(`Error adding product to database:`, error.message);
        }

    }

    // console.log([[products.length , url]]);

    // return [[products.length , url]];
    // console.log(products, `1`);

    return products;
}

// async function scrapeImages(page, url, DB) {

//     console.log(`Scraping images from: ${url}`);
//     const imageSlides = [];

//     const query = `SELECT * FROM PRODUCTS WHERE productUrl = ?`;

//     try {
//         // Step 1: Select the productId based on the productUrl
//         console.log('from updateProduct TRY BLOCK: ' + url);

//         const row = await new Promise((resolve, reject) => {
//             DB.all(query, [url], (err, row) => {
//                 if (err) {
//                     // <!-- // console.error(`DB GET Error: ${err}`); -->
//                     reject(err);
//                 } else {
//                     resolve(row);
//                 }
//             });
//         });

//         // console.log(`Row: ${JSON.stringify(row)}`);

//         if (row && row.length > 0) {
//             console.log("product alredy exist");
//             return { imageSlides: [], productShortDescription: '' };
//         } else {

//             try {
//                 // Navigate to the product detail page
//                 await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
//                 const htmlContent = await page.content();

//                 // Load the HTML into Cheerio
//                 const $ = cheerio.load(htmlContent);

//                 // Extract the product description and video url
//                 const productShortDescription = $('#home p').html();
//                 const videoURL = $("#myVideo > source").attr('src');

//                 // Extract image URLs
//                 $('#slider img').each((index, element) => {
//                     const imgSrc = $(element).attr('src');
//                     if (imgSrc) {
//                         imageSlides.push(imgSrc);
//                     }
//                 });

//                 console.log('Scraped images:', imageSlides);
//                 console.log('Scraped description:', productShortDescription);
//                 console.log('Scraped videoUrl:', videoURL);

//                 // want to download those images in my project
//                 // and send that images link in return file
//                 // if that image from the same url exist then don't download it
//                 // make folder according to your for the image
//                 // just send that img link from my project to return file in imageSlides

//                 return { imageSlides, productShortDescription, videoURL };
//             } catch (error) {
//                 // <!-- // console.error('Error fetching images:', error.message); -->
//                 return { imageSlides: [], productShortDescription: '', videoURL: '' };
//             }

//         }

//     } catch (error) {
//         // <!-- // console.error("Error in query:", error.message); -->
//     }

// }


async function scrapeImages(page, url, DB) {
    console.log(`Scraping images from: ${url}`);
    const imageSlides = [];

    const query = `SELECT * FROM PRODUCTS WHERE productUrl = ?`;

    try {
        // Step 1: Select the productId based on the productUrl
        console.log('from updateProduct TRY BLOCK: ' + url);

        const row = await new Promise((resolve, reject) => {
            DB.all(query, [url], (err, row) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        if (row && row.length > 0) {
            console.log("product already exist");
            return { imageSlides: [], productShortDescription: '', videoURL: '' };
        } else {
            try {
                // Navigate to the product detail page
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                const htmlContent = await page.content();
                await delay(1500);
                // Load the HTML into Cheerio
                const $ = cheerio.load(htmlContent);

                // ✅ EXTRACT DESCRIPTION
                // ==========================================
                // The description is wrapped in a div immediately following the <h4>Product Details</h4>
                // Since the class list is a massive generated Tailwind string, we target the wrapper 
                // and grab its direct sibling div.
                const productShortDescription = $('.description-wrapper h4').next('div').html() || '';


                // ==========================================
                // ✅ EXTRACT VIDEO URL
                // ==========================================
                // Found the video tag! It's mixed in with the image sliders.
                const videoURL = $("video source").attr('src') || '';


                // ==========================================
                // ✅ IMAGES (Fixed for new layout)
                // ==========================================
                // The new layout uses a thumbnail slider. We grab images from the buttons.
                $('.thumbs-sub-slider img').each((index, element) => {
                    const imgSrc = $(element).attr('src');
                    // Push to array and prevent duplicates
                    if (imgSrc && !imageSlides.includes(imgSrc)) {
                        imageSlides.push(imgSrc);
                    }
                });

                // Fallback: If the thumbnail slider isn't there, grab from the main view
                if (imageSlides.length === 0) {
                    $('.product-slide img').each((index, element) => {
                        const imgSrc = $(element).attr('src');
                        if (imgSrc && !imageSlides.includes(imgSrc)) {
                            imageSlides.push(imgSrc);
                        }
                    });
                }

                console.log('Scraped images:', imageSlides);
                console.log('Scraped description:', productShortDescription);
                console.log('Scraped videoUrl:', videoURL);

                return { imageSlides, productShortDescription, videoURL };

            } catch (error) {
                console.error('Error fetching images:', error.message);
                return { imageSlides: [], productShortDescription: '', videoURL: '' };
            }
        }
    } catch (error) {
        console.error("Error in query:", error.message);
        return { imageSlides: [], productShortDescription: '', videoURL: '' };
    }
}

async function addProductToDatabase(product, DB) {
    console.log("from add product");
    console.log(product);

    const sql = `INSERT INTO PRODUCTS (
        productName, productOriginalPrice, productBrand, featuredimg, 
        sizeName, productUrl, imageUrl, videoUrl, availability, productShortDescription, 
        catName, productFetchedFrom, productLastUpdated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const values = [
        product.productName,
        product.productOriginalPrice,
        product.productBrand,
        product.featuredimg,
        JSON.stringify(product.sizeName),
        product.productUrl,
        JSON.stringify(product.imageUrl),
        product.videoUrl ?? null,
        product.availability,
        product.productShortDescription,
        product.catName,
        product.productFetchedFrom,
        Date.now()
    ];

    console.log('⚙️ Running SQL insert now...');
    console.log('➡️ SQL:', sql);
    console.log('➡️ Values:', values);

    console.log('🧠 DB object type:', typeof DB);
    console.log('🧠 Has run method?', typeof DB.run);

    const lastID = await new Promise((resolve, reject) => {
        const stmt = DB.prepare(sql);
        stmt.run(...values, function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.lastID); // ✅ always gives the correct inserted row ID
            }
        });
        stmt.finalize();
    });

    if (!lastID) {
        throw new Error('Failed to retrieve last inserted ID');
    }

    console.log('Inserted product with ID:', lastID);
    return lastID;

}

// Function to add many-to-many relationships
async function addProductRelationships(productId, product, DB) {

    // Add product-category relationship
    const catRow = await DB.get(`SELECT catId FROM CATEGORIES WHERE catName = ?`, [product.catName]);
    if (catRow) {
        await DB.run(`INSERT OR IGNORE INTO ProductCategories (ProductId, CategoryId) VALUES (?, ?)`, [productId, catRow.catId]);
    }


    await realtiontosize(productId, product, DB)
    await relationToBrand(productId, product, DB)

}

async function realtiontosize(productId, product, DB) {
    console.log("product size ");
    console.log(product.sizeName);

    // Add product-sizes relationships

    for (const size of product.sizeName) {
        console.log("from size for");

        try {
            // Insert size if it doesn't exist
            const sizesql = `INSERT INTO SIZES (sizeName) VALUES (?) ON CONFLICT(sizeName) DO NOTHING;`;
            await DB.run(sizesql, [size]);

            // Get the sizeId of the inserted or existing size
            const sizeRow = await DB.get(`SELECT sizeId FROM SIZES WHERE sizeName = ?`, [size]);

            if (sizeRow) {
                console.log(`Size ID for "${size}":`, sizeRow.sizeId);

                // Add product-size relationship
                await DB.run(
                    `INSERT OR IGNORE INTO ProductSizes (ProductId, SizeId) VALUES (?, ?)`,
                    [productId, sizeRow.sizeId]
                );
            } else {
                // console.error(`Size "${size}" not found in the database.`);
            }
        } catch (err) {
            // console.error(`Error processing size "${size}":`, err.message);
        }
    }
}
async function relationToBrand(productId, product, DB) {
    console.log("product productBrand ");
    console.log(product.productBrand);

    // Add product-sizes relationships

    const productBrand = product.productBrand

    try {
        // Insert size if it doesn't exist
        const sizesql = `INSERT INTO BRAND (brandName) VALUES (?) ON CONFLICT(brandName) DO NOTHING;`;
        await DB.run(sizesql, [productBrand]);

        // Get the sizeId of the inserted or existing size
        const sizeRow = await DB.get(`SELECT brandId FROM BRAND WHERE brandName = ?`, [productBrand]);

        if (sizeRow) {

            // Add product-size relationship
            await DB.run(
                `INSERT OR IGNORE INTO ProductBrand (ProductId, BrandId) VALUES (?, ?)`,
                [productId, sizeRow.brandId]
            );
        } else {
            // console.error(`Size "${productBrand}" not found in the database.`);
        }
    } catch (err) {
        // console.error(`Error processing size "${productBrand}":`, err.message);
    }

}

function toBoolean(val) {
    if (val === true || val === "true" || val === 1 || val === "1") {
        return true;
    }
    if (val === false || val === "false" || val === 0 || val === "0") {
        return false;
    }
    // console.warn("Unrecognized boolean-like value:", val);
    return false; // or throw error
}

async function updateProduct(product, DB) {
    console.log('from updateProduct');
    let skipforwordpress = false;

    const query = `SELECT * FROM PRODUCTS WHERE productUrl = ?`;

    try {
        // Step 1: Select the productId based on the productUrl
        console.log('from updateProduct TRY BLOCK: ' + product.productUrl);

        const row = await new Promise((resolve, reject) => {
            DB.all(query, [product.productUrl], (err, row) => {
                if (err) {
                    // <!-- // console.error(`DB GET Error: ${err}`); -->
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        console.log(`Row: ${JSON.stringify(row)}`);

        let productId;

        if (row && row.length > 0) {
            productId = row[0].productId;
            console.log(`Product ID: ${productId}`);

            // Step 2: Update all values where productId matches
            let updateQuery = 'UPDATE PRODUCTS SET ';
            const updates = [];
            const values = [];

            if (typeof product.productName !== 'undefined' && product.productName !== row[0].productName) {
                updates.push(`productName = ?`);
                values.push(product.productName);
            }

            if (typeof product.productPrice !== 'undefined' && product.productPrice !== row[0].productPrice) {
                updates.push(`productPrice = ?`);
                values.push(product.productPrice);
            }
            if (typeof product.productPriceWithoutDiscount !== 'undefined' && product.productPriceWithoutDiscount !== row[0].productPriceWithoutDiscount) {
                updates.push(`productPriceWithoutDiscount = ?`);
                values.push(product.productPriceWithoutDiscount);
            }
            if (typeof product.productOriginalPrice !== 'undefined' && product.productOriginalPrice !== row[0].productOriginalPrice) {
                updates.push(`productOriginalPrice = ?`);
                values.push(product.productOriginalPrice);
            }
            if (typeof product.sizeName !== 'undefined' && product.sizeName !== row[0].sizeName) {
                updates.push(`sizeName = ?`);
                values.push(JSON.stringify(product.sizeName));
            }
            if (typeof product.availability !== 'undefined' && toBoolean(product.availability) !== toBoolean(row[0].availability)) {
                updates.push(`availability = ?`);
                values.push(JSON.stringify(product.availability));
            }



            // Check if there are fields to update
            if (updates.length > 0) {

                updates.push(`productLastUpdated = ?`);
                values.push(Date.now());

                const sql = updateQuery + updates.join(', ') + ` WHERE productId = ?`;
                skipforwordpress = false;
                try {
                    const params = [...values, productId];
                    console.log("Executing update query:", sql, params);

                    const changes = await new Promise((resolve, reject) => {
                        const stmt = DB.prepare(sql);
                        stmt.run(...params, function (err) {
                            if (err) {
                                reject(err);
                            } else {
                                resolve(this.changes);
                            }
                        });
                        stmt.finalize();
                    });

                    if (changes === 1) {
                        console.log(JSON.stringify({ status: 200, message: `Data updated with id: ${productId}` }));
                    } else {
                        console.log(JSON.stringify({ status: 201, message: `No data has been changed` }));
                    }
                } catch (err) {
                    if (err.code === 'SQLITE_CONSTRAINT') {
                        // <!-- // console.error({ code: 400, status: "Unique constraint failed", message: "A record with this unique value already exists." }); -->
                    } else {
                        // <!-- // console.error({ code: 500, status: "Internal Server Error", message: err.message }); -->
                    }
                }
            }
        } else {
            console.log('No product found with the given URL.');
            console.log("Product uploaded");

            productId = await addProductToDatabase(product, DB);
            skipforwordpress = false;
            console.log("addProductToDatabase Completed")
            await addProductRelationships(productId, product, DB);
        }

        // ✅ Return the productId in all cases
        return {
            productId: productId,
            skipforwordpress: skipforwordpress
        };
    } catch (error) {
        // <!-- // console.error("Error in query:", error.message); -->
        return {
            productId: null,
            skipforwordpress: null
        }; // Return null if there was a failure
    }
}

// async function viewMore(page) {
//     console.log("Starting to load all products...");
//     let clickCount = 0;
//     let hasMoreButton = true;

//     while (hasMoreButton) {

//         try {
//             // 1. Wait UP TO 4 seconds for the exact button to appear and be visible
//             await page.waitForFunction(() => {
//                 const grid = document.querySelector('.shop-p-grid.word-break');
//                 if (!grid) return false;

//                 const children = grid.children;
//                 if (children.length === 0) return false;

//                 const lastChild = children[children.length - 1];
//                 if (lastChild && lastChild.classList.contains('col-span-full')) {
//                     const button = lastChild.querySelector('button');

//                     // Make sure it exists, says "Load More", is visible, and NOT disabled
//                     if (button &&
//                         button.innerText.trim().toLowerCase().includes('load more') &&
//                         button.offsetParent !== null &&
//                         !button.disabled) {
//                         return true;
//                     }
//                 }
//                 return false;
//             }, { timeout: 4000 }); // <-- Fails automatically if 4000ms pass

//             // 2. If the code reaches here, the button appeared! Let's click it.
//             await page.evaluate(() => {
//                 const grid = document.querySelector('.shop-p-grid.word-break');
//                 const lastChild = grid.children[grid.children.length - 1];
//                 lastChild.querySelector('button').click();
//             });

//             clickCount++;
//             console.log('Load More button clicked =', clickCount);

//             // 3. Tiny 500ms buffer after clicking
//             // This gives the website a fraction of a second to change the button to "Loading..."
//             // so our loop doesn't accidentally click the exact same button twice!
//             await delay(500);

//         } catch (error) {

//             console.log("📜 Scrolling top to bottom to load all Next.js images...");
//             await page.evaluate(async () => {
//                 await new Promise((resolve) => {
//                     let totalHeight = 0;
//                     let distance = 600; // Scroll 600px at a time
//                     let timer = setInterval(() => {
//                         let scrollHeight = document.body.scrollHeight;
//                         window.scrollBy(0, distance);
//                         totalHeight += distance;

//                         // Stop when we hit the bottom
//                         if (totalHeight >= scrollHeight - window.innerHeight) {
//                             clearInterval(timer);
//                             window.scrollTo(0, 0); // Instantly jump back to top
//                             resolve();
//                         }
//                     }, 150); // Pause for 150ms between each scroll step
//                 });
//             });

//             // Wait 1.5 seconds for network requests to finish downloading the images
//             console.log("⏳ Waiting 2.5 seconds for images to fully render...");
//             await delay(2500);


//             // 4. Timeout reached! 
//             // If 4 seconds pass and the button didn't appear, waitForFunction throws an error.
//             // We catch that error here to cleanly exit the loop.
//             console.log('✅ "Load More" button not found or disappeared after 4 seconds. All products loaded! Total clicks: ', clickCount);
//             hasMoreButton = false;
//         }
//     }
//     await delay(1500);

// }

async function viewMore(page) {
    console.log("🔄 [Method B] Starting infinite scroll to load all products...");

    let previousCount = 0;
    let isScrolling = true;
    let scrollAttempts = 0; // Used to double-check if the network is just being slow

    while (isScrolling) {
        try {
            // 1. SMART-STOPPING: Check if ANY product on the screen says "Sold Out" or "Out of Stock"
            const foundSoldOut = await page.evaluate(() => {
                const cards = Array.from(document.querySelectorAll('.product-card'));
                return cards.some(card => {
                    const text = card.innerText.toLowerCase();
                    // Checks for the red overlay "Out of Stock" or the traditional "Sold Out"
                    return text.includes('sold out') || text.includes('out of stock');
                });
            });

            if (foundSoldOut) {
                console.log(`🛑 "Out of Stock" product detected! Stopping infinite scroll early to save time.`);
                break; // Instantly exits the loop and moves on to scraping!
            }

            // 2. Count how many products are currently on the screen
            previousCount = await page.evaluate(() => document.querySelectorAll('.product-card').length);

            // 3. Scroll to the very bottom to trigger the Infinite Scroll API
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));

            // 4. Wait for the website to fetch and render the new batch of products
            console.log(`📜 Scrolled down... waiting for new products. (Current count: ${previousCount})`);
            await delay(3000);

            // 5. Count the products again to see if new ones appeared
            const newCount = await page.evaluate(() => document.querySelectorAll('.product-card').length);

            if (newCount === previousCount) {
                // If the count didn't change, the network might be slow. Give it one more try.
                scrollAttempts++;
                if (scrollAttempts >= 2) {
                    console.log(`✅ No new products loaded. Reached the end of the list! Total products: ${newCount}`);
                    isScrolling = false; // Stop the loop
                } else {
                    console.log(`⚠️ No new products yet, waiting an extra 2 seconds just in case...`);
                    await delay(2000);
                }
            } else {
                // Reset the attempts counter because we successfully loaded new items!
                scrollAttempts = 0;
            }

        } catch (error) {
            console.error('⚠️ Error during infinite scroll sequence:', error.message);
            isScrolling = false; // Break loop safely if something crashes
        }
    }

    // ==========================================
    // 📜 FULL PAGE SMOOTH SCROLL (Next.js Image Fix)
    // Now that all products are on the screen, we do one final smooth scroll
    // to force Next.js IntersectionObserver to load the high-res images!
    // ==========================================
    console.log("📜 Performing final smooth scroll to render all Next.js images...");
    await page.evaluate(async () => {
        window.scrollTo(0, 0); // Jump back to the top

        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 600; // Scroll 600px at a time
            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                // Stop when we hit the bottom
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    window.scrollTo(0, 0); // Jump back to top
                    resolve();
                }
            }, 150); // Pause for 150ms between each scroll step
        });
    });

    console.log("⏳ Waiting 2.5 seconds for images to fully render...");
    await delay(2500);
}


// Start the scraping process
export {
    fetchDataaB, addProductToDatabase,
    updateProduct
}; 
