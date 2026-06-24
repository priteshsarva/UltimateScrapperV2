import { log } from "console";
import { DB } from "../models/connect.js";
import express from "express";
import { bulkSafeSyncProducts, BulkProductOutOfStock } from "../services/wpBulkSafeSync.js";

const product = express()



// Import necessary modules
import { promisify } from 'util';

// Promisify DB methods for easier async/await usage
DB.run = promisify(DB.run);
DB.get = promisify(DB.get);

const sizeMap = {
    "36": ["36", "36-4.5", "36-m4", "36-4", "36-3.5", "UK 4/EURO 36", "UK4.5/EURO 36", "UK 4 / EURO 36", "UK-4 EUR-36", "UK-3.5 EUR-36", "UK-3 EUR-36", "UK-4.5 EUR-36.5", "4.5", "Euro-36 UK-4", "Uk 4/Euro 36", "4/ Euro 36", "36/4.5", "36/4", "36/4 5", "M4", "Euro 36", "36 4.5", "36-UK4", "36 UK 4", "UK 4", "U.K-3.5 Euro-36", "U.K-3 Euro-36", "EURO 36", "40 - 6", "Euro 40- Uk 6", "36-37"],
    "37": ["37", "37-5", "37-m4", "37-4", "UK 4/EURO 37", "UK5/EURO 37", "UK 4 / EURO 37", "UK-4 EUR-37", "UK-5 EUR-37.5", "UK-4.5 EUR-37.5", "5", "Euro-37 UK-4", "Uk 4/Euro 37", "4/ Euro 37", "37/5", "37/4", "37/4 5", "M4", "Euro 37", "37 5", "37-UK4", "37 UK 4", "UK 4", "U.K-4 Euro-37", "EURO 37", "37-38"],
    "38": ["38", "38-5.5", "38-m5", "38-5", "UK 5/EURO 38", "UK5.5/EURO 38", "UK 5 / EURO 38", "UK-5 EUR-38", "UK-5.5 EUR-38.5", "UK-6 EUR-38.5", "5.5", "Euro-38 UK-5", "Uk 5/Euro 38", "5/ Euro 38", "38/5.5", "38/5", "38/5 5", "M5", "Euro 38", "38 5.5", "38-UK5", "38 UK 5", "UK 5", "U.K-5 Euro-38", "U.K-5.5 Euro-39", "EURO 38", "38-39"],
    "39": ["39", "39-6.5", "39-m6", "39-6", "UK 6/EURO 39", "UK6.5/EURO 39", "UK 6 / EURO 39", "UK-6 EUR-39", "UK-6.5 EUR-39.5", "UK-7 EUR-39.5", "6.5", "Euro-39 UK-6", "Uk 6/Euro 39", "6/ Euro 39", "39/6.5", "39/6", "39/6 5", "M6", "Euro 39", "39 6.5", "39-UK6", "39 UK 6", "UK 6", "U.K-6 Euro-39", "EURO 39", "39-40"],
    "40": ["40", "40-6.5", "40-m6", "40-6", "40-7.5", "UK 6/EURO 40", "UK6.5/EURO 40", "UK 7/EURO 40", "UK7.5/EURO 40", "UK 6 / EURO 40", "UK-6 EUR-40", "UK-7 EUR-40", "UK-6.5 EUR-40.5", "UK-7.5 EUR-40.5", "UK-8 EUR-40.5", "6.5", "7.5", "Euro-40 UK-6", "Euro-40 UK-7", "Uk 6/Euro 40", "Uk 7/Euro 40", "6/ Euro 40", "7/ Euro 40", "40/6.5", "40/6", "40/6 5", "40/7.5", "40/7", "M6", "M7", "Euro 40", "40 6.5", "40 7.5", "40-UK6", "40 UK 6", "40-UK7", "40 UK 7", "UK 6", "UK 7", "UK 6|Euro 40", "UK 6.5|EURO 40", "UK 7|EURO 40", "U.K-6 Euro-40", "UK-6 EURO-40", "EURO 40", "40 - 6", "Euro 40- Uk 6", "40-41"],
    "41": ["41", "41-7.5", "41-m7", "41-7", "41-8.5", "UK 7/EURO 41", "UK7.5/EURO 41", "UK 8/EURO 41", "UK8.5/EURO 41", "UK 7 / EURO 41", "UK-7 EUR-41", "UK-8 EUR-41", "UK-7.5 EUR-41.5", "UK-8.5 EUR-41.5", "UK-9 EUR-41.5", "7.5", "8.5", "Euro-41 UK-7", "Euro-41 UK-8", "Uk 7/Euro 41", "Uk 8/Euro 41", "7/ Euro 41", "8/ Euro 41", "41/7.5", "41/7", "41/7 5", "41/8.5", "41/8", "M7", "M8", "Euro 41", "41 7.5", "41 8.5", "41-UK7", "41 UK 7", "41-UK8", "41 UK 8", "UK 7", "UK 8", "UK 7|EURO 41", "UK 7.5|EURO 41", "UK 8|EURO 41", "U.K-7 Euro-41", "UK-7 EURO-41", "EURO 41", "41 - 7", "Euro 41- Uk 7", "41-42"],
    "42": ["42", "42-9.5", "42-m9", "42-9", "42-8", "42-7.5", "UK 9/EURO 42", "UK9.5/EURO 42", "UK 8/EURO 42", "UK8.5/EURO 42", "UK 7.5/EURO 42", "UK 9 / EURO 42", "UK-9 EUR-42", "UK-8 EUR-42", "UK-7.5 EUR-42", "UK-9.5 EUR-42.5", "UK-8.5 EUR-42.5", "UK-10 EUR-42.5", "9.5", "8.5", "7.5", "Euro-42 UK-9", "Euro-42 UK-8", "Euro-42.5 UK-8", "Euro-42. UK-7.5", "Uk 9/Euro 42", "Uk 8/Euro 42", "9/ Euro 42", "8/ Euro 42", "42/9.5", "42/9", "42/9 5", "42/8.5", "42/8", "42/7.5", "M9", "M8", "Euro 42", "42 9.5", "42 8.5", "42 7.5", "42-UK9", "42 UK 9", "42-UK8", "42 UK 8", "UK 9", "UK 8", "UK 9|EURO 42", "UK 9.5|EURO 42", "UK 8|EURO 42", "UK 8.5|EURO 42", "U.K-9 Euro-42", "UK-9 EURO-42", "EURO 42", "42 - 9", "Euro 42-UK 8", "Euro 42-UK 7.5", "42-43"],
    "43": ["43", "43-10.5", "43-m10", "43-10", "43-8.5", "43-9", "UK 10/EURO 43", "UK10.5/EURO 43", "UK 9/EURO 43", "UK9.5/EURO 43", "UK 8.5/EURO 43", "UK 10 / EURO 43", "UK-10 EUR-43", "UK-9 EUR-43", "UK-8.5 EUR-43", "UK-10.5 EUR-43.5", "UK-9.5 EUR-43.5", "UK-11 EUR-43.5", "10.5", "9.5", "8.5", "Euro-43 UK-10", "Euro-43 UK-9", "Euro-43. Uk-8.5", "Uk 10/Euro 43", "Uk 9/Euro 43", "10/ Euro 43", "9/ Euro 43", "43/10.5", "43/10", "43/10 5", "43/9.5", "43/9", "43/8.5", "M10", "M9", "Euro 43", "43 10.5", "43 9.5", "43 8.5", "43-UK10", "43 UK 10", "43-UK9", "43 UK 9", "UK 10", "UK 9", "UK 10|EURO 43", "UK 10.5|EURO 43", "UK 9|EURO 43", "UK 9.5|EURO 43", "U.K-10 Euro-43", "UK-10 EURO-43", "EURO 43", "43 - 10", "Euro 43-UK 9", "Euro 43-UK 8.5", "43-44", "UK 9/ EURO 43"],
    "44": ["44", "44-11.5", "44-m11", "44-11", "44-9.5", "44-10", "UK 11/EURO 44", "UK11.5/EURO 44", "UK 10/EURO 44", "UK10.5/EURO 44", "UK 9.5/EURO 44", "UK 9/EURO 44", "UK 11 / EURO 44", "UK-11 EUR-44", "UK-10 EUR-44", "UK-9.5 EUR-44", "UK-9 EUR-44", "UK-11.5 EUR-44.5", "UK-10.5 EUR-44.5", "UK-12 EUR-44.5", "11.5", "10.5", "9.5", "Euro-44 UK-11", "Euro-44 UK-10", "Euro-44. Uk-9", "Euro-44. Uk-9.5", "Uk 11/Euro 44", "Uk 10/Euro 44", "11/ Euro 44", "10/ Euro 44", "44/11.5", "44/11", "44/11 5", "44/10.5", "44/10", "44/9.5", "M11", "M10", "Euro 44", "44 11.5", "44 10.5", "44 9.5", "44-UK11", "44 UK 11", "44-UK10", "44 UK 10", "UK 11", "UK 10", "UK 11|EURO 44", "UK 11.5|EURO 44", "UK 10|EURO 44", "UK 10.5|EURO 44", "U.K-11 Euro-44", "UK-11 EURO-44", "EURO 44", "44 - 11", "Euro 44-UK 10", "Euro 44-UK 9.5", "44-45", "UK 10 /EURO 44", "44/9"],
    "45": ["45", "45-12.5", "45-m12", "45-12", "45-10.5", "45-11", "UK 12/EURO 45", "UK12.5/EURO 45", "UK 11/EURO 45", "UK11.5/EURO 45", "UK 10.5/EURO 45", "UK 10/EURO 45", "UK 12 / EURO 45", "UK-12 EUR-45", "UK-11 EUR-45", "UK-10.5 EUR-45", "UK-10 EUR-45", "UK-12.5 EUR-45.5", "UK-11.5 EUR-45.5", "UK-13 EUR-45.5", "12.5", "11.5", "10.5", "Euro-45 UK-12", "Euro-45 UK-11", "Euro-45. Uk-10", "Euro-45. Uk-10.5", "Uk 12/Euro 45", "Uk 11/Euro 45", "12/ Euro 45", "11/ Euro 45", "45/12.5", "45/12", "45/12 5", "45/11.5", "45/11", "45/10.5", "M12", "M11", "Euro 45", "45 12.5", "45 11.5", "45 10.5", "45-UK12", "45 UK 12", "45-UK11", "45 UK 11", "UK 12", "UK 11", "UK 12|EURO 45", "UK 12.5|EURO 45", "UK 11|EURO 45", "UK 11.5|EURO 45", "U.K-12 Euro-45", "UK-12 EURO-45", "EURO 45", "45 - 12", "Euro 45-UK 11", "Euro 45-UK 10.5", "45-46"],
    "46": ["46", "46-13.5", "46-m13", "46-13", "46-11", "46-12", "UK 13/EURO 46", "UK13.5/EURO 46", "UK 12/EURO 46", "UK12.5/EURO 46", "UK 11/EURO 46", "UK 10.5/EURO 46", "UK 13 / EURO 46", "UK-13 EUR-46", "UK-12 EUR-46", "UK-11 EUR-46", "UK-10.5 EUR-46", "UK-13.5 EUR-46.5", "UK-12.5 EUR-46.5", "UK-14 EUR-46.5", "13.5", "12.5", "11", "Euro-46 UK-13", "Euro-46 UK-12", "Euro-46. Uk-11", "Uk 13/Euro 46", "Uk 12/Euro 46", "13/ Euro 46", "12/ Euro 46", "46/13.5", "46/13", "46/13 5", "46/12.5", "46/12", "46/11", "M13", "M12", "Euro 46", "46 13.5", "46 12.5", "46 11", "46-UK13", "46 UK 13", "46-UK12", "46 UK 12", "46-UK 12", "UK 13", "UK 12", "UK 11", "UK 13|EURO 46", "UK 13.5|EURO 46", "UK 12|EURO 46", "UK 12.5|EURO 46", "U.K-13 Euro-46", "UK-13 EURO-46", "EURO 46", "46 - 13", "Euro 46-UK 12", "46-47"],
    "47": ["47", "47-14.5", "47-m14", "47-14", "47/12", "UK 14/EURO 47", "UK14.5/EURO 47", "UK 12/EURO 47", "UK12.5/EURO 47", "UK 14 / EURO 47", "UK-14 EUR-47", "UK-12 EUR-47", "UK-14.5 EUR-47.5", "UK-12.5 EUR-47.5", "UK-15 EUR-47.5", "14.5", "12.5", "Euro-47 UK-14", "Euro-47 UK-12", "Uk 14/Euro 47", "Uk 12/Euro 47", "14/ Euro 47", "12/ Euro 47", "47/14.5", "47/14", "47/14 5", "47/12.5", "47/12", "M14", "M12", "Euro 47", "47 14.5", "47 12.5", "47-UK14", "47 UK 14", "47-UK12", "47 UK 12", "UK 14", "UK 12", "UK 14|EURO 47", "UK 14.5|EURO 47", "UK 12|EURO 47", "UK 12.5|EURO 47", "U.K-14 Euro-47", "UK-14 EURO-47", "EURO 47", "47 - 14", "47-48"],
    "48": ["48", "48-15.5", "48-m15", "48-15", "UK 15/EURO 48", "UK15.5/EURO 48", "UK 15 / EURO 48", "UK-15 EUR-48", "UK-15.5 EUR-48.5", "UK-16 EUR-48.5", "15.5", "Euro-48 UK-15", "Uk 15/Euro 48", "15/ Euro 48", "48/15.5", "48/15", "48/15 5", "M15", "Euro 48", "48 15.5", "48-UK15", "48 UK 15", "UK 15", "UK 15|EURO 48", "UK 15.5|EURO 48", "U.K-15 Euro-48", "UK-15 EURO-48", "EURO 48", "48 - 15", "48-49"]
};


const categories = {
    "Men's Shoe": [
        "MENS+SHOES", "EID SALE", "Exclusive Offer", "Diwali Dhamaka Sale", "Winter+Dhamaka+Sale",
        "Men's Kick", "Diwali Special Sale", "PREMIUM SHOES", "Biggest Sale", "Diwali sale shoes",
        "End Of Season Sale", "Shoes", "Diwali Offer 2022", "Men's shoes", "shoes+for+men",
        "Shoe for men", "Biggest sale 2025", "DIWALI SALE", "Shoes for Men", "MENS SHOES",
        "DIWALI+SALE+", "Men’s Shoes", "Bumper Sale", "Diwali Sale", "Mens+Shoes",
        "Mega Sale", "Mens's Sneakers", "Men Shoes", "Sale Product", "Slides-Crocs",
        "Sale Products", "MEN’S SHOES", "SPECIAL SALE", "Men’s Footwear", "sell+itam",
        "DIWALI+MEN+", "Sale", "Onitsuka+Tiger+Models", "MENS KICKS", "Sale Article"
    ],
    "Slides/Crocs": [
        "FLIPFLOP", "Flipflops/Crocs", "Flip+flops", "Flip-Flop", "Foam&Slide&Crocs",
        "Crocs+", "CROCS+SLIDE", "slide+", "crocs+%2B+slide+", "Crocs", "crocs+%2B+slide",
        "Flip-flops & Slides", "Birkenstock slide", "Slides+", "crocs", "FLIP/FLOPS",
        "Flip-flop", "Flipflops", "FLIP FLOP / SANDALS", "Flip Flops", "FlipFlop & CLOG",
        "flip flops", "Flip Flops & Crocs"
    ],
    "Women's Shoe": [
        "WOMANS+SHOES", "Women Sports Shoes", "Women's Kick", "womens", "Ladies Shoes",
        "Women's Shoes", "shoes+for+women", "shoes+for+girls", "Shoe for girls", "PREMIUM+HEELS",
        "Shoes For Her", "Womans shoes", "women shoes", "Womens+Shoes", "women%27s+%26+men%27s+",
        "Womens's Sneakers", "WOMEN’S SHOES", "Women’s Shoes", "Women’s Footwear", "WOMENS SHOES",
        "DIWALI+WOMEN+SELL", "Ladies+Shoes", "womens Kicks"
    ],
    "UA Quality": [
        "UA+QUALITY+SHOE", "UA QUALITY SHOES", "Men Sports Shoes", "wall+Clock",
        "UA+Quality+Shoes", "Premium Shoes", "UA Quality", "Bottle", "Premium Shoe",
        "UA+Models", "UA+QUALITY+SHOES", "Ua Quality", "Premium Article", "Premium kicks"
    ],
    // "Nill": [
    //     "Casual Shoes", "KeyChain", "BAG PACK", "Hoodie Unisex", "50% Off", "Lace", 
    //     "Bags", "Hand bags", "Jackets", "FORMAL", "LOFFER", "mojdi", "long+boots", 
    //     "SANDAL", "SPORTS", "Belt+", "Wallet+", "Sport Jersey", "Loafer/Formal Shoes", 
    //     "Yeezy Foam Runner", "SALE % SALE % SALE", "T-Shirts", "Travelling Bags", "Wallet", 
    //     "Belts", "Hoodies", "Clothing", "SALE", "Mens Accessories", "Mens Watch", "Cap", 
    //     "Accessories", "Stoles"
    // ],
    "Formal": [
        "Loafers Or Formals", "Formals", "Party Wear Shoes"
    ],
    "Womens Watch": [
        "Womens Watch", "Ladies Watch", "Watches For Her", "Ladies watch", "Girls Watch", "Ledish+Watch", "Women Watch"
    ],
    "Mens Watch": [
        "Mens Watch", "Watches For Men", "Men's Watch", "Men Watch", "men watch"
    ]
};







product.get('/allresults', (req, res) => {

    res.set('content-type', 'application/json');
    // let sql = `SELECT * FROM PRODUCTS ORDER BY datetime(productDateCreation / 1000, 'unixepoch') ASC;`
    let sql = `SELECT * FROM PRODUCTS ORDER BY productDateCreation DESC;`

    // let sql = `SELECT * FROM PRODUCTS WHERE productUrl = "https://oneshoess.cartpe.in/nikee-airforce-1-first-leather-ua-oneshoess.html?color=";`

    try {
        DB.all(sql, [], (err, rows) => {
            if (err) {
                throw err;
            }
            let content = JSON.stringify(rows);
            res.send(content)
        })
    } catch (err) {
        console.log(err.message);
        res.status(467)
        res.send(`{"code":"467","status":${err.message}}`);
    }

});

product.get("/bulkSafeSyncProducts", bulkSafeSyncProducts);
product.get("/bulkProductOutOfStock", BulkProductOutOfStock);



product.get("/syncWP", async (req, res) => {
    res.set("content-type", "application/json");

    const sql = `SELECT * FROM PRODUCTS ORDER BY productDateCreation DESC;`;

    try {
        DB.all(sql, [], async (err, rows) => {
            if (err) {
                console.error("❌ DB fetch failed:", err);
                return res.status(500).json({ code: 500, error: err.message });
            }

            console.log(`🚀 Found ${rows.length} products in database, syncing to WooCommerce...`);

            let success = 0;
            let failed = 0;

            for (const product of rows) {
                try {
                    await upsertProduct(product);
                    success++;
                } catch (err) {
                    console.error(`❌ Failed to sync product ${product.productName}:`, err);
                    failed++;
                }
            }

            console.log(`✅ Sync completed. Success: ${success}, Failed: ${failed}`);
            res.json({ message: "Sync completed", success, failed });
        });
    } catch (err) {
        console.error("❌ Unexpected sync error:", err);
        res.status(500).json({ code: 500, error: err.message });
    }
});

product.get('/all', (req, res) => {
    res.set('content-type', 'application/json');

    const limit = parseInt(req.query.result) || 60;
    const page = parseInt(req.query.page) || 1; // default to page 1 if not provided
    const offset = (page - 1) * limit;

    // const sql = `SELECT * FROM PRODUCTS WHERE sizeName <> '[]' ORDER BY datetime(productLastUpdated / 1000, 'unixepoch') DESC LIMIT ? OFFSET ?`;
    const sql = `SELECT * FROM PRODUCTS WHERE availability IN (1, TRUE, 'true')   ORDER BY productDateCreation DESC LIMIT ? OFFSET ?`;

    try {
        DB.all(sql, [limit, offset], (err, rows) => {
            if (err) {
                throw err;
            }
            res.json(rows); // same as res.send(JSON.stringify(rows))
        });
    } catch (err) {
        console.log(err.message);
        res.status(467).send({ code: '467', status: err.message });
    }
});


product.get('/search', (req, res) => {
    const { q = '', brand, size, category } = req.query;
    const limit = parseInt(req.query.result) || 20;
    const page = parseInt(req.query.page) || 1;
    const offset = (page - 1) * limit;
    console.log(category);

    // let sql = `SELECT * FROM products WHERE 1=1 AND sizeName <> '[]' `;
    let sql = `SELECT * FROM products WHERE 1=1 AND availability IN (1, TRUE, 'true') `;
    const params = [];

    // Handle q
    if (q) {
        sql += ` AND LOWER(productName) LIKE ?`;
        params.push(`%${q.toLowerCase()}%`);
    }

    // Handle brand
    if (brand) {
        sql += ` AND LOWER(productBrand) = ?`;
        params.push(brand.toLowerCase());
    }

    // Handle size
    if (size) {
        const normalizedSize = size.trim().toLowerCase();
        const matchedSizeKey = Object.keys(sizeMap).find((key) =>
            sizeMap[key].some((variant) => variant.toLowerCase() === normalizedSize)
        );

        if (matchedSizeKey) {
            const variants = sizeMap[matchedSizeKey];
            const likeClauses = variants.map(() => `sizeName LIKE ?`).join(" OR ");
            // const likeClauses = variants.map(() => `sizeName = ?`).join(" OR ");
            sql += ` AND (${likeClauses})`;
            params.push(...variants.map(v => `%${v}%`));
            // params.push(...variants.map(v => `${v}`));

        } else {
            sql += ` AND sizeName LIKE ?`;
            params.push(`%${size}%`);
            // sql += ` AND sizeName = ?`;            
            // params.push(`${size}`);

        }
    }

    // Handle category
    if (category) {
        const normalizedCategory = category.trim().toLowerCase();
        const matchedCatKey = Object.keys(categories).find((key) =>
            categories[key].some((variant) => variant.toLowerCase() === normalizedCategory)
        );

        if (matchedCatKey) {
            const variants = categories[matchedCatKey];
            // const likeClauses = variants.map(() => `LOWER(catName) = ?`).join(" OR ");
            const likeClauses = variants.map(() => `LOWER(catName) LIKE ?`).join(" OR ");
            sql += ` AND (${likeClauses})`;
            // params.push(...variants.map(v => `%${v.toLowerCase()}%`));
            params.push(...variants.map(v => `${v.toLowerCase()}`));

        } else {
            // sql += ` AND LOWER(catName) LIKE ?`;
            // params.push(`%${category.toLowerCase()}%`);

            sql += ` AND LOWER(catName) = ?`;
            params.push(`${category.toLowerCase()}`);

        }
    }

    // sql += `ORDER BY datetime(productLastUpdated / 1000, 'unixepoch') DESC`;
    sql += ` ORDER BY productDateCreation DESC`;


    // Fetch all matching results first
    log(sql, params)
    DB.all(sql, params, (err, allRows) => {
        if (err) {
            console.error("DB error:", err);
            return res.status(500).json({ error: err.message });
        }

        const totalCount = allRows.length;
        const totalPages = Math.ceil(totalCount / limit);
        const paginatedRows = allRows.slice(offset, offset + limit);

        res.json({
            currentPage: page,
            limit,
            totalPages,
            totalCount,
            results: paginatedRows
        });
    });
});

product.get('/firstdata', (req, res) => {
    const categories = [
        "Mens Watch",
        "Ladies Watch",
        "Luxury Watch",
    ];
    // dont know where this code come from----------------------------------------------------
    //  db.all("SELECT * FROM products WHERE productId = ?", ['sync-products'], (err, rows) => {
    //     if (err) console.error(err);
    //     else console.log(rows);
    // });

    const itemsPerCategory = 30;
    const allPromises = categories.map(category => {
        return new Promise((resolve, reject) => {
            DB.all(
                // `SELECT * FROM products  WHERE sizeName <> '[]' AND LOWER(catName) LIKE ?  ORDER BY datetime(productLastUpdated / 1000, 'unixepoch') DESC LIMIT ?`
                `SELECT * FROM products WHERE availability IN (1, TRUE, 'true') AND LOWER(catName) LIKE ?  ORDER BY productDateCreation DESC LIMIT ?`
                // `SELECT * FROM products WHERE availability IN (1, TRUE, 'true') ORDER BY productDateCreation DESC LIMIT ?`
                ,
                [category, itemsPerCategory],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    });



    Promise.all(allPromises)
        .then(results => {
            // Merge all category results into one array
            const mergedResults = results.flat();

            res.json({
                totalCount: mergedResults.length,
                results: mergedResults
            });
        })
        .catch(err => {
            console.error("Error in /firstdata:", err);
            res.status(500).json({ error: err.message });
        });
});

product.get('/check-old-sizes', (req, res) => {
    res.set('content-type', 'application/json');

    const sql = `
        SELECT *
        FROM PRODUCTS
        WHERE (
           
        );
    `;
    console.log("sdsdsd");


    DB.all(sql, [], (err, rows) => {
        if (err) {
            console.error("❌ SQL Error:", err.message);
            return res.status(500).json({ error: err.message });
        }

        if (rows.length === 0) {
            return res.status(204).json({ message: "No outdated products found" });
        }

        return res.status(200).json({
            message: "Outdated products found",
            count: rows.length,
            data: rows
        });
    });
});

product.get('/update-stale-sizes', (req, res) => {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000; // 24 hours ago
    const staleIds = [];

    console.log('Now:', new Date(now).toISOString());
    console.log('Cutoff:', new Date(cutoff).toISOString());

    const selectSQL = `SELECT productId, productLastUpdated FROM products`;

    DB.all(selectSQL, [], (err, rows) => {
        if (err) {
            console.error('DB error:', err);
            return res.status(500).json({ error: err.message });
        }

        console.log(`Fetched ${rows.length} rows from database`);

        // First pass: identify all stale products
        rows.forEach(row => {
            try {
                let lastUpdated = row.productLastUpdated;

                // Convert to number if it's a string
                if (typeof lastUpdated === 'string') {
                    lastUpdated = parseInt(lastUpdated);
                }

                // Skip if we can't parse the date
                if (isNaN(lastUpdated)) {
                    console.warn(`Invalid lastUpdated for product ${row.productId}: ${row.productLastUpdated}`);
                    return;
                }

                if (lastUpdated < cutoff) {
                    staleIds.push(row.productId);
                }
            } catch (e) {
                console.error(`Error processing product ${row.productId}:`, e);
            }
        });

        console.log(`Found ${staleIds.length} stale products to update`);

        if (staleIds.length === 0) {
            return res.status(200).json({ message: 'No outdated products found.' });
        }

        // Process updates with transaction for better performance
        DB.serialize(() => {
            DB.run('BEGIN TRANSACTION');

            let updateCount = 0;
            const updateSQL = `UPDATE products SET sizeName = ?, productLastUpdated = ? WHERE productId = ?`;

            staleIds.forEach(id => {
                DB.run(updateSQL, ['[]', now, id], function (err) {
                    if (err) {
                        console.error(`Error updating product ${id}:`, err.message);
                        // Continue with other updates even if one fails
                    } else {
                        updateCount += this.changes;
                        console.log(`Updated product ${id}, rows affected: ${this.changes}`);
                    }
                });
            });

            DB.run('COMMIT', [], (err) => {
                if (err) {
                    console.error('Transaction error:', err);
                    return res.status(500).json({ error: 'Transaction failed', details: err.message });
                }

                console.log(`Successfully updated ${updateCount} products`);
                res.status(200).json({
                    message: 'Update completed',
                    updatedCount: updateCount,
                    totalStale: staleIds.length,
                    staleIds: staleIds
                });
            });
        });
    });
});

product.get('/mark-unavailable-products', (req, res) => {
    const now = Date.now();
    const cutoff = now - 3 * 24 * 60 * 60 * 1000; // 3 days ago
    const staleIds = [];

    console.log('Now:', new Date(now).toISOString());
    console.log('Cutoff (3 days ago):', new Date(cutoff).toISOString());

    const selectSQL = `SELECT productId, productLastUpdated FROM products`;

    DB.all(selectSQL, [], (err, rows) => {
        if (err) {
            console.error('DB error:', err);
            return res.status(500).json({ error: err.message });
        }

        console.log(`Fetched ${rows.length} rows from database`);

        // Identify products that haven’t been updated in over 3 days
        rows.forEach(row => {
            try {
                let lastUpdated = row.productLastUpdated;

                // Convert to number if it's a string
                if (typeof lastUpdated === 'string') {
                    lastUpdated = parseInt(lastUpdated);
                }

                // Skip invalid timestamps
                if (isNaN(lastUpdated)) {
                    console.warn(`Invalid productLastUpdated for product ${row.productId}: ${row.productLastUpdated}`);
                    return;
                }

                if (lastUpdated < cutoff) {
                    staleIds.push(row.productId);
                }
            } catch (e) {
                console.error(`Error processing product ${row.productId}:`, e);
            }
        });

        console.log(`Found ${staleIds.length} products older than 3 days`);

        if (staleIds.length === 0) {
            return res.status(200).json({ message: 'No outdated products found.' });
        }

        // Update availability in transaction
        DB.serialize(() => {
            DB.run('BEGIN TRANSACTION');

            let updateCount = 0;
            const updateSQL = `UPDATE products SET availability = ?, productLastUpdated = ? WHERE productId = ?`;

            staleIds.forEach(id => {
                DB.run(updateSQL, [false, now, id], function (err) {
                    if (err) {
                        console.error(`Error updating product ${id}:`, err.message);
                    } else {
                        updateCount += this.changes;
                        console.log(`Marked product ${id} unavailable`);
                    }
                });
            });

            DB.run('COMMIT', [], (err) => {
                if (err) {
                    console.error('Transaction error:', err);
                    return res.status(500).json({ error: 'Transaction failed', details: err.message });
                }

                console.log(`Successfully marked ${updateCount} products unavailable`);
                res.status(200).json({
                    message: 'Mark unavailable completed',
                    updatedCount: updateCount,
                    totalOutdated: staleIds.length,
                    productIds: staleIds
                });
            });
        });
    });
});

// API: Mark selected categories as unavailable
product.get('/mark-categories-unavailable', (req, res) => {
    const blockedCategories = [
        "Perfume For Women",
        "Perfume For Men",
        "Couple Watches",
        "G-Shock In SALE",
        "Wall Clock",
        "Belts",
        "Wallet",
        "Wallets and Belts",
        "G-SHOCK+",
        "WALLET+BELT",
        "Sunglasses and Frames",
        "Hand bags",
        "Home Decor",
        "Diwali Offer 2022",
        "Sunglasses"
    ];

    // Prepare SQL placeholders (?, ?, ?, ...)
    const placeholders = blockedCategories.map(() => '?').join(',');
    const updateSQL = `
        UPDATE products 
        SET availability = 0, productLastUpdated = ? 
        WHERE catName IN (${placeholders})
    `;

    const now = Date.now();

    DB.run(updateSQL, [now, ...blockedCategories], function (err) {
        if (err) {
            console.error('Error updating categories:', err.message);
            return res.status(500).json({ error: err.message });
        }

        console.log(`Marked ${this.changes} products as unavailable`);
        res.status(200).json({
            message: 'Categories marked unavailable successfully',
            updatedCount: this.changes,
            blockedCategories
        });
    });
});

product.get('/set-luxury-watch-category', (req, res) => {
    console.log("Hit /set-luxury-watch-category API");

    const targetSources = [
        "https://wristifyreseller.cartpe.in/",
        "https://watchfactorys.cartpe.in/",
        "https://watchkart.cartpe.in/",
        "https://timepiece.cartpe.in/",
        "https://hypewrist.cartpe.in/"
    ];

    const placeholders = targetSources.map(() => '?').join(',');
    const updateSQL = `
        UPDATE products 
        SET catName = 'Luxury Watch' 
        WHERE productFetchedFrom IN (${placeholders})
    `;


    const params = [...targetSources];

    console.log("Executing SQL:", updateSQL);
    console.log("With params:", params);

    DB.run(updateSQL, params, function (err) {
        if (err) {
            console.error('Error updating luxury watch categories:', err.message);
            return res.status(500).json({ error: err.message });
        }

        console.log(`Updated ${this.changes} products to category 'Luxury Watch'`);
        return res.status(200).json({
            message: "Luxury Watch category applied successfully",
            updatedCount: this.changes,
            updatedSources: targetSources
        });
    });




});

product.get('/results/', (req, res) => {
    res.set('content-type', 'application/json');

    // Parse query parameters
    const page = parseInt(req.query.page) || 1; // Default to page 1
    const limit = parseInt(req.query.limit) || 20; // Default to 10 items per page

    // Calculate start and end indices
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;

    // let sql = `SELECT * FROM PRODUCTS WHERE sizeName <> '[]';`;
    // let sql = `SELECT * FROM PRODUCTS WHERE sizeName <> '[]' ORDER BY datetime(productLastUpdated / 1000, 'unixepoch') DESC`;
    let sql = `SELECT * FROM PRODUCTS WHERE sizeName <> '[]' ORDER BY productDateCreation DESC`;


    DB.all(sql, [], (err, rows) => {
        if (err) {
            // Handle database error
            console.error(err.message);
            res.status(500).json({ code: 500, status: "Internal Server Error", message: err.message });
            return;
        }

        // Paginate the results
        const results = rows.slice(startIndex, endIndex);
        const totalPage = Math.ceil(rows.length / limit);

        // Send the response
        res.json({
            page,
            limit,
            totalPage,
            totalItems: rows.length,
            results,
        });
    });
});

product.get('/:id', (req, res) => {

    // let sql = `SELECT * FROM products WHERE 1=1 AND sizeName <> '[]' `;
    let sql = `SELECT * FROM products WHERE productId = ${req.params.id}`;

    DB.all(sql, (err, allRows) => {
        if (err) {
            console.error("DB error:", err);
            return res.status(500).json({ error: err.message });
        }
        res.json({
            results: allRows
        });
    });

});


product.get('/total-pages', (req, res) => {
    const limit = parseInt(req.query.result) || 20;

    if (isNaN(limit) || limit <= 0) {
        return res.status(400).json({ error: "Invalid result (limit) parameter" });
    }

    const countSql = `SELECT COUNT(*) AS count FROM products WHERE sizeName <> '[]'`;

    DB.get(countSql, [], (err, row) => {
        if (err) {
            console.error("SQLite error:", err.message);
            return res.status(500).json({ error: err.message });
        }

        const totalCount = row.count;
        const totalPages = Math.ceil(totalCount / limit);

        res.json({
            totalCount,
            totalPages,
            resultPerPage: limit
        });
    });
});


product.post('/add', async (req, res) => {
    try {
        console.log(req.body);

        // Serialize arrays to JSON strings
        const dynamicValues = { ...req.body };
        if (Array.isArray(dynamicValues.imageUrl)) {
            dynamicValues.imageUrl = JSON.stringify(dynamicValues.imageUrl);
        }
        if (Array.isArray(dynamicValues.sizeName)) {
            dynamicValues.sizeName = JSON.stringify(dynamicValues.sizeName);
        }

        const columns = Object.keys(dynamicValues).join(', ');
        const placeholders = Object.keys(dynamicValues).map(() => '?').join(', ');
        const values = Object.values(dynamicValues);

        res.set('content-type', 'application/json');

        // Handle Sizes
        let sizeIds = [];
        if (typeof req.body.sizeName !== 'undefined') {
            const sizeNames = Array.isArray(req.body.sizeName) ? req.body.sizeName : [req.body.sizeName];

            for (const sizeName of sizeNames) {
                // Insert size if it doesn't exist
                const sizesql = `INSERT INTO SIZES (sizeName) VALUES (?) ON CONFLICT(sizeName) DO NOTHING;`;
                await DB.run(sizesql, [sizeName]);

                // Get the sizeId
                const sizeRow = await DB.get(`SELECT sizeId FROM SIZES WHERE sizeName = ?`, [sizeName]);
                if (sizeRow) {
                    sizeIds.push(sizeRow.sizeId);
                }
            }
        }

        // Handle Category
        let catId;
        if (typeof req.body.catName !== 'undefined') {
            const catName = req.body.catName;

            // Insert category if it doesn't exist
            const catNamesql = `INSERT INTO CATEGORIES (catName) VALUES (?) ON CONFLICT(catName) DO NOTHING;`;
            await DB.run(catNamesql, [catName]);

            // Get the catId
            const catRow = await DB.get(`SELECT catId FROM CATEGORIES WHERE catName = ?`, [catName]);
            if (catRow) {
                catId = catRow.catId;
            }
        }

        // Insert Product
        const sql = `INSERT INTO PRODUCTS (${columns}) VALUES (${placeholders})`;
        await DB.run(sql, [...values]);

        // Get the last inserted productId
        const productRow = await DB.get(`SELECT last_insert_rowid() as lastID`);
        const newId = productRow.lastID;

        // Insert Product-Category Relationship
        if (catId) {
            const productCatSql = `INSERT INTO ProductCategories (ProductId, CategoryId) VALUES (?, ?)`;
            await DB.run(productCatSql, [newId, catId]);
        }

        // Insert Product-Size Relationships
        for (const sizeId of sizeIds) {
            const productSizeSql = `INSERT INTO ProductSizes (ProductId, SizeId) VALUES (?, ?)`;
            await DB.run(productSizeSql, [newId, sizeId]);
        }

        // Send Success Response
        res.status(201).json({
            status: 201,
            message: `Data added with id: ${newId}`,
        });
    } catch (err) {
        console.error(err.message);

        if (err.code === 'SQLITE_CONSTRAINT') {
            res.status(400).json({
                code: "400",
                status: "Unique constraint failed",
                message: "A record with this unique value already exists.",
            });
        } else {
            res.status(500).json({
                code: "500",
                status: "Internal Server Error",
                message: err.message,
            });
        }
    }
});


product.post('/update', (req, res) => {
    res.set('content-type', 'application/json');
    let query = 'UPDATE PRODUCTS SET ';
    const updates = []
    const values = []

    if (typeof req.body.productName !== 'undefined') {
        updates.push(`productName = ?`);
        values.push(req.body.productName);
    }
    if (typeof req.body.productPrice !== 'undefined') {
        updates.push(`productPrice = ?`);
        values.push(req.body.productPrice);
    }
    if (typeof req.body.productPriceWithoutDiscount !== 'undefined') {
        updates.push(`productPriceWithoutDiscount = ?`);
        values.push(req.body.productPriceWithoutDiscount);
    }
    if (typeof req.body.productOriginalPrice !== 'undefined') {
        updates.push(`productOriginalPrice = ?`);
        values.push(req.body.productOriginalPrice);
    }
    if (typeof req.body.productFetchedFrom !== 'undefined') {
        updates.push(`productFetchedFrom = ?`);
        values.push(req.body.productFetchedFrom);
    }
    if (typeof req.body.ProductUrl !== 'undefined') {
        updates.push(`ProductUrl = ?`);
        values.push(req.body.ProductUrl);
    }
    if (typeof req.body.productShortDescription !== 'undefined') {
        updates.push(`productShortDescription = ?`);
        values.push(req.body.productShortDescription);
    }
    if (typeof req.body.productDescription !== 'undefined') {
        updates.push(`productDescription = ?`);
        values.push(req.body.productDescription);
    }
    if (typeof req.body.productBrand !== 'undefined') {
        updates.push(`productBrand = ?`);
        values.push(req.body.productBrand);
    }
    if (typeof req.body.productLastUpdated !== 'undefined') {
        updates.push(`productLastUpdated = ?`);
        values.push(req.body.productLastUpdated);
    } else {
        updates.push(`productLastUpdated = ?`);
        values.push(Date.now());
    }

    let sql = query += updates.join(', ') + ' WHERE productId = ?';
    let id = req.body.productId;

    try {
        DB.run(sql, [...values, id], function (err) {

            if (err) {
                // console.error(err.message); // Log the error message
                // Check for specific error codes if needed
                if (err.code === 'SQLITE_CONSTRAINT') {
                    return res.status(400).send({
                        code: "400",
                        status: "Unique constraint failed",
                        message: "A record with this unique value already exists."
                    });
                } else {
                    return res.status(500).send({
                        code: "500",
                        status: "Internal Server Error",
                        message: err.message,
                    });
                }
            }


            if (this.changes === 1) {
                // file updated succefully
                res.status(200);
                let data = { status: 200, message: `data updated with id: ${id} ` }
                let content = JSON.stringify(data);
                res.send(content);
            } else {
                res.status(201);
                let data = { status: 201, message: `no data has been changed` }
                let content = JSON.stringify(data);
                res.send(content);
            }

        })

    } catch (err) {
        console.log(err.message);
        res.status(467);
        res.send(`{ "code": "467", "status":${err.message} } `);

    }
})

product.delete('/delete', (req, res) => {
    res.set('content-type', 'application/json');
    let sql = 'DELETE FROM PRODUCTS WHERE productId = ?';
    let id = req.body.productId;

    try {
        DB.run(sql, [id], function (err) {
            if (err) throw err;
            if (this.changes === 1) {
                // file deleted succefully
                res.status(200);
                let data = { status: 200, message: `data delete with id: ${id} ` }
                let content = JSON.stringify(data);
                res.send(content);
            } else {
                res.status(201);
                let data = { status: 201, message: `no data has been found` }
                let content = JSON.stringify(data);
                res.send(content);
            }

        })

    } catch (err) {
        console.log(err.message);
        res.status(467)
        res.send(`{ "code": "467", "status":${err.message} } `);
    }

})


export default product;