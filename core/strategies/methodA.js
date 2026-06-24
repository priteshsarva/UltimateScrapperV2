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
import { log } from 'console';
import { upsertProductSafe, syncProductToAllSites } from '../wpBulkSafeSync.js'
import { updateProductCategory } from '../../services/updateProductCategoryAndBrand.js';
import { viewMore } from './viewMoreA.js';
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
async function fetchDataa(singleUrl, DB) {
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
    const fullUrl = `${url}/allcategory.html`;
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

            // Extract category data
            const categories = await page.evaluate(() => {
                const categoryElements = document.querySelectorAll('.cat-area');
                return Array.from(categoryElements).map(element => ({
                    catTitle: element.querySelector('.cat-text').innerText,
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
        try {
            // Navigate to the product page
            await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 6000 }); // Increase timeout to 120 seconds

            // await page.waitForSelector('#product_list_div', { timeout: 60000 }); // Increase timeout

            // will procced to next step if either products are found or "not found" message appears, otherwise it will timeout after 15 seconds
            const result = await Promise.race([
                page.waitForSelector('#product_list_div', { timeout: 15000 }).then(() => 'products'),
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
            await viewMore(page, productCount)
            console.log("After view more");

            const productElements = await page.evaluate(() => {
                const container = document.querySelector('#product_list_div');
                if (!container) return [];

                const items = container.querySelectorAll('div.col-lg-4, div.col-md-6, div.col-6');

                return Array.from(items).map(item => {

                    // ============================
                    // IMAGE + DETAIL URL
                    // ============================
                    const img = item.querySelector('img.img-fluid');
                    const featuredimg = img?.src || null;

                    // Most reliable: parent <a> of the image
                    const detailUrl = img?.closest('a')?.href || null;

                    // ============================
                    // TITLE (first <h6> in card)
                    // ============================
                    const title =
                        item.querySelector('h6')?.innerText.trim() || null;

                    // ============================
                    // PRICE (first <h6> inside the price wrapper)
                    // ============================
                    // const price = item.querySelector('div h6')?.innerText.trim() || null;

                    const rawPrice = Array.from(item.querySelectorAll('h6'))
                        .map(el => el.innerText.trim())
                        .find(text => /^[₹\s]*\d/.test(text)) || null;

                    const price = rawPrice
                        ?.replace(/[^0-9.]/g, '')  // keep only digits + decimal
                        .trim() || null;
                    console.log(price);


                    // ============================
                    // STOCK / BUTTON TEXT
                    // ============================
                    const button = item.querySelector('button');
                    const btnText = button?.innerText.trim().toLowerCase() || "";
                    let availability
                    if (btnText.includes("add to cart")) {
                        availability = true;
                    } else {
                        availability = false;
                    }

                    // ============================
                    // SIZES (all label.badge after "Size :")
                    // ============================
                    const sizeLabels = Array.from(
                        item.querySelectorAll('label.badge')
                    )
                        .map(l => l.innerText.trim())
                        .filter(s => s && s.toLowerCase() !== "size :");

                    return {
                        title,
                        price,
                        featuredimg,
                        detailUrl,
                        availability,
                        sizes: sizeLabels
                    };
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

// async function viewMore(page, productCount) {
//     const count = Math.ceil(productCount / 12);
//     const viewMoreButtonSelector = '#loadmore_btn_category_product';

//     await page.waitForSelector(viewMoreButtonSelector, { timeout: 10000 });
//     for (let i = 0; i < count; i++) {
//         try {
//             await page.click(viewMoreButtonSelector);
//             console.log(`Button clicked = ${i}`);
//             await delay(4000);
//         } catch (error) {
//             // <!-- // console.error('Error clicking "View More" button:', error + i); -->
//         }
//     }
// }


 async function viewMoreold (page, productCount) {
     // Math logic from your old code to set a hard limit on clicks
     const count = Math.ceil(productCount / 12);
     const viewMoreButtonSelector = '#loadmore_btn_category_product';

     console.log(`🔄 Starting to load products. Max clicks needed: ${count}. Monitoring for 'Sold Out'...`);

     for (let i = 0; i < count; i++) {
         try {
             // 1. SMART-STOPPING: Check if ANY product on the screen says "Sold Out"
             const foundSoldOut = await page.evaluate(() => {
                 const buttons = Array.from(document.querySelectorAll('#product_list_div button'));
                 return buttons.some(btn => btn.innerText.trim().toLowerCase().includes('sold out'));
             });

             if (foundSoldOut) {
                 console.log(`🛑 "Sold Out" product detected! Stopping 'View More' clicks early to save time.`);
                 break; // Instantly exits the for-loop and moves on to scraping!
             }

             // 2. Wait for the button and click it safely
             await page.waitForSelector(viewMoreButtonSelector, { timeout: 10000 });

             const buttonClicked = await page.evaluate((selector) => {
                 const btn = document.querySelector(selector);
                 if (btn && btn.offsetParent !== null && !btn.disabled && btn.style.display !== 'none') {
                    btn.click();
                     return true;
                 }
                 return false;
             }, viewMoreButtonSelector);

             if (buttonClicked) {
                 console.log(`👉 "Load More" button clicked = ${i + 1} / ${count}`);
                 await delay(1500); // Wait for the new products to render
             } else {
                 console.log(`✅ "Load More" button disappeared or is unclickable.`);
                 break; // Exit loop if button is broken/hidden
             }

         } catch (error) {
             // If waitForSelector times out, it means the button is completely gone from the HTML
             console.log(`✅ "Load More" button no longer found. Reached the end of the list.`);
             break;
         }
     }
 }

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
                    // <!-- // console.error(`DB GET Error: ${err}`); -->
                    reject(err);
                } else {
                    resolve(row);
                }
            });
        });

        // console.log(`Row: ${JSON.stringify(row)}`);

        if (row && row.length > 0) {
            console.log("product alredy exist");
            return { imageSlides: [], productShortDescription: '' };
        } else {

            try {
                // Navigate to the product detail page
                await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
                const htmlContent = await page.content();

                // Load the HTML into Cheerio
                const $ = cheerio.load(htmlContent);

                // Extract the product description and video url
                const productShortDescription = $('#home p').html();
                const videoURL = $("#myVideo > source").attr('src');

                // Extract image URLs
                $('#slider img').each((index, element) => {
                    const imgSrc = $(element).attr('src');
                    if (imgSrc) {
                        imageSlides.push(imgSrc);
                    }
                });

                console.log('Scraped images:', imageSlides);
                console.log('Scraped description:', productShortDescription);
                console.log('Scraped videoUrl:', videoURL);

                // want to download those images in my project
                // and send that images link in return file
                // if that image from the same url exist then don't download it
                // make folder according to your for the image
                // just send that img link from my project to return file in imageSlides

                return { imageSlides, productShortDescription, videoURL };
            } catch (error) {
                // <!-- // console.error('Error fetching images:', error.message); -->
                return { imageSlides: [], productShortDescription: '', videoURL: '' };
            }

        }

    } catch (error) {
        // <!-- // console.error("Error in query:", error.message); -->
    }

}

// Start the scraping process
export {
    fetchDataa, addProductToDatabase,
    updateProduct
}; 
