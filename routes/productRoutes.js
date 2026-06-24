import express from 'express';
import { CLIENT_CONFIGS } from '../config/clients.js';
import { getClientData } from '../utils/multiDbHandler.js';
import { dbManager } from '../models/dbManager.js';
import { requireEnrollmentKey } from '../portal/enrollmentKey.js';

const router = express.Router();


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


const categoriesMap = {
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
    ]
};


/**
 * Endpoint: /product/search
 */
// router.get('/search', async (req, res) => {
//     // console.log("search");

//     const { q, brand, size, category } = req.query;
//     const limit = parseInt(req.query.result) || 2;
//     const page = parseInt(req.query.page) || 1;
//     const offset = (page - 1) * limit;

//     let sql = `SELECT * FROM products WHERE 1=1 AND availability IN (1, TRUE, 'true') `;
//     let params = [];

//     if (q) { sql += ` AND LOWER(productName) LIKE ?`; params.push(`%${q.toLowerCase()}%`); }
//     if (brand) { sql += ` AND LOWER(productBrand) = ?`; params.push(brand.toLowerCase()); }

//     // Combined query across allowed DBs
//     const allMatching = await getClientData(req.clientConfig, 'search', { sql, params });
//     // console.log(allMatching);

//     const totalCount = allMatching.length;
//     const paginated = allMatching.slice(offset, offset + limit);

//     res.json({
//         currentPage: page,
//         totalPages: Math.ceil(totalCount / limit),
//         totalCount,
//         results: paginated
//     });
// });

router.get('/search', async (req, res) => {
    try {
        const { q, brand, size, category } = req.query;
        const limit = parseInt(req.query.result) || 12; // Adjusted default for better grid view (you can change back to 2)
        const page = parseInt(req.query.page) || 1;
        const offset = (page - 1) * limit;

        // 1. Handle dbName (Support both ?dbName=watches and ?cat=watches)
        let targetDb = req.query.dbName || req.query.cat;

        // Clean up weird frontend edge cases ('undefined' as string)
        if (targetDb === 'undefined' || targetDb === 'null' || targetDb === '') {
            targetDb = null;
        }

        // 2. Build the SQL Query dynamically
        let sql = `SELECT * FROM PRODUCTS WHERE availability IN (1, '1', TRUE, 'true') `;
        let params = [];

        if (q) {
            sql += ` AND LOWER(productName) LIKE ?`;
            params.push(`%${q.toLowerCase()}%`);
        }
        if (brand) {
            sql += ` AND LOWER(productBrand) = ?`;
            params.push(`%${brand.toLowerCase()}%`);
        }
        // if (category) {
        //     sql += ` AND LOWER(catName) LIKE ?`;
        //     params.push(`%${category.toLowerCase()}%`);
        // }
        // if (size) {
        //     sql += ` AND sizeName LIKE ?`;
        //     params.push(`%${size}%`);
        // }



        if (category) {
            const normalizedCategory = category.trim().toLowerCase();
            const matchedCatKey = Object.keys(categoriesMap).find((key) =>
                key.toLowerCase() === normalizedCategory || // Check the master key
                categoriesMap[key].some((variant) => variant.toLowerCase() === normalizedCategory)
            );

            if (matchedCatKey) {
                // If match found, search for the Key AND all Variants
                const variants = [matchedCatKey, ...categoriesMap[matchedCatKey]];
                const likeClauses = variants.map(() => `LOWER(catName) LIKE ?`).join(" OR ");
                sql += ` AND (${likeClauses})`;
                
                // Add wildcards to params for partial matching inside the database string
                params.push(...variants.map(v => `%${v.toLowerCase()}%`));
            } else {
                // Fallback to "old way"
                sql += ` AND LOWER(catName) LIKE ?`;
                params.push(`%${category.toLowerCase()}%`);
            }
        }

        // ==========================================
        // SIZE NORMALIZATION
        // ==========================================
        if (size) {
            const normalizedSize = size.trim().toLowerCase();
            const matchedSizeKey = Object.keys(sizeMap).find(key =>
                key.toLowerCase() === normalizedSize || 
                sizeMap[key].some(variant => variant.toLowerCase() === normalizedSize)
            );

            if (matchedSizeKey) {
                // Search for the Key AND all its string variants
                const variants = [matchedSizeKey, ...sizeMap[matchedSizeKey]];
                const likeClauses = variants.map(() => `sizeName LIKE ?`).join(" OR ");
                sql += ` AND (${likeClauses})`;
                
                // Sizes are stored as JSON arrays in DB so MUST use wildcard %
                params.push(...variants.map(v => `%${v}%`)); 
            } else {
                // Fallback to "old way"
                sql += ` AND sizeName LIKE ?`;
                params.push(`%${size}%`);
            }
        }

        // 3. Filter which databases we are allowed to search
        // If targetDb is provided, strictly search ONLY that DB. 
        // Otherwise, search all DBs this client has access to.
        const filteredAccess = targetDb
            ? req.clientConfig.access.filter(rule => rule.database === targetDb)
            : req.clientConfig.access;

        // If the requested DB is invalid or client doesn't have access, return empty
        if (filteredAccess.length === 0) {
            return res.json({
                currentPage: page,
                totalPages: 0,
                totalCount: 0,
                results: []
            });
        }

        // 4. Create a temporary config object with ONLY the allowed databases
        const searchConfig = {
            ...req.clientConfig,
            access: filteredAccess
        };
        
        console.log({ sql, params });
        

        // 5. Run the combined query across the filtered DBs
        const allMatching = await getClientData(searchConfig, 'search', { sql, params });

        // 6. Handle Pagination
        const totalCount = allMatching.length;
        const paginated = allMatching.slice(offset, offset + limit);

        // 7. Return the final results
        res.json({
            currentPage: page,
            totalPages: Math.ceil(totalCount / limit),
            totalCount,
            results: paginated
        });

    } catch (error) {
        console.error("Search Route Error:", error);
        res.status(500).json({ error: 'Failed to perform search' });
    }
});

router.get('/allresults', async (req, res) => {
    // REMOVE the ORDER BY from here. 
    // getClientData handles sorting automatically for you.
    // const sql = `SELECT * FROM PRODUCTS WHERE availability = 1 OR availability = '1' OR availability = TRUE OR availability = 'true' OR availability = 'TRUE' ORDER BY productDateCreation DESC`;

    const sql = `SELECT * FROM PRODUCTS ORDER BY productDateCreation DESC`;


    try {
        const results = await getClientData(req.clientConfig, 'allresults', { sql, params: [] });
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/sync-feed', requireEnrollmentKey, async (req, res) => {
  try {
    const by    = req.query.by === 'ts' ? 'ts' : 'id';     // 'id' = new, 'ts' = updated
    const after = parseInt(req.query.after) || 0;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    // Scope comes from the enrollment key, not a tenant config.
    const { sourceCategory, searchKey, categories } = req.enrollment;

    const db  = await dbManager.getDb(sourceCategory);   // live DB only (shoes/watches)
    const col = by === 'ts' ? 'CAST(productLastUpdated AS INTEGER)' : 'productId';

    // base: this source's rows, keyset-paginated
    const params = [];
    let where = `${col} > ? AND productFetchedFrom LIKE '%' || ? || '%'`;
    params.push(after, searchKey);

    // category allow-list (skip filter if the client picked nothing yet)
    if (Array.isArray(categories) && categories.length) {
      const placeholders = categories.map(() => '?').join(',');
      where += ` AND catName IN (${placeholders})`;
      params.push(...categories);
    }

    const sql = `SELECT * FROM PRODUCTS WHERE ${where} ORDER BY ${col} ASC LIMIT ?`;
    params.push(limit);

    const rows = await new Promise((resolve, reject) => {
      db.all(sql, params, (e, r) => e ? reject(e) : resolve(r || []));
    });
    rows.forEach(r => r.dbName = sourceCategory);   // so the plugin knows the source DB

    res.json({ by, after, count: rows.length, results: rows });
  } catch (e) {
    console.error('sync-feed error', e);
    res.status(500).json({ error: e.message });
  }
});


/**
 * Endpoint: /product/firstdata
 */
router.get('/firstdata', async (req, res) => {
    try {
        // Fetch top 30 from EACH database in their normal order (e.g., newest first)
        // You can change 'productId DESC' to 'productDateCreation DESC' if you prefer
        const sql = `SELECT * FROM PRODUCTS WHERE availability IN (1, '1', TRUE, 'true') ORDER BY productId DESC LIMIT 30`;

        const results = await getClientData(req.clientConfig, 'firstdata', { sql, params: [] });

        // Take exactly 30 items from the newly blended array
        const limited = results.slice(0, 60);
        res.json({ totalCount: limited.length, results: limited });
    } catch (error) {
        console.error("Route Error:", error);
        res.status(500).json({ error: 'Failed to fetch first data' });
    }
});
 

router.get('/:id', async (req, res, next) => {
    try {
        const productId = req.params.id;

        // Grab dbName from query
        let targetDb = req.query.cat;

        // Clean up weird frontend edge cases
        if (targetDb === 'undefined' || targetDb === 'null' || targetDb === '') {
            targetDb = null;
        }

        let foundProduct = null;

        for (const rule of req.clientConfig.access) {

            // 1. If dbName provided, only search that DB
            if (targetDb && rule.database !== targetDb) {
                continue;
            }

            const db = await dbManager.getDb(rule.database);

            let sql = "SELECT * FROM products WHERE productId = ?";
            let params = [productId];

            // 2. SECURITY CHECK: Manufacturer filter
            if (rule.manufacturers !== "all") {
                const searchKeys = SITES_REGISTRY
                    .filter(s => rule.manufacturers.includes(s.id))
                    .map(s => `%${s.searchKey}%`);

                if (searchKeys.length > 0) {
                    const whereClause = searchKeys
                        .map(() => "productFetchedFrom LIKE ?")
                        .join(" OR ");

                    sql += ` AND (${whereClause})`;
                    params.push(...searchKeys);
                } else {
                    // No allowed manufacturers → skip this DB
                    continue;
                }
            }

            // Fetch single product
            const row = await new Promise((resolve, reject) => {
                db.get(sql, params, (err, row) => {
                    if (err) return reject(err);
                    resolve(row);
                });
            });

            if (row) {
                // 3. Attach dbName
                foundProduct = { ...row, dbName: rule.database };
                break;
            }
        }

        // 4. Return result properly (FIXED)
        res.json({
            results: foundProduct ? [foundProduct] : []
        });

    } catch (error) {
        next(error);
    }
});



export default router;