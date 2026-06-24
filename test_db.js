import { dbManager } from './models/dbManager.js';

async function populateWithRealData() {
    try {
        console.log("--- Populating with Real Test Data ---");

        const shoeDb = await dbManager.getDb('shoes');
        const watchDb = await dbManager.getDb('watches');

        // 1. Setup Vendors first (to satisfy Foreign Key constraints)
        const shoeVendorId = await ensureVendor(shoeDb, "ShoeMart", "https://shoemartt.cartpe.in/");
        const watchVendorId = await ensureVendor(watchDb, "WatchMaster", "https://watchmaster.com");

        // 2. Prepare Data
        const shoeData = {
            productName: "Travis Scott X Nikee Air Jordan 1 Low Velvet Brown Semi UA",
            productOriginalPrice: 2499,
            productFetchedFrom: shoeVendorId, // Use the ID, not the string
            productUrl: "https://shoemartt.cartpe.in/travis-scott-x-nikee-air-jordan-1-low-velvet-brown-shoemartt.html?color=",
            featuredimg: "https://cdn.cartpe.in/images/gallery_sm/6874cce6c66b3.jpeg",
            imageUrl: JSON.stringify(["img1.jpg", "img2.jpg"]),
            productBrand: "Travis Scott",
            sizeName: JSON.stringify(["41","42","43","44","45"]),
            catName: "Men's Shoes",
            videoUrl: "urlll",
            availability: 1
        };

        const watchData = {
            productName: "Rolex Day-Date 40 Olive Green Dial",
            productOriginalPrice: 42000,
            productFetchedFrom: watchVendorId, // Use the ID
            productUrl: "https://watchmaster.com/rolex-day-date-olive",
            featuredimg: "https://images.rolex.com/featured_img.jpg",
            imageUrl: JSON.stringify(["w1.jpg", "w2.jpg"]),
            productBrand: "Rolex",
            sizeName: "40mm",
            catName: "Luxury Watches",
            videoUrl: "watch_video_url",
            availability: 1
        };

        // 3. Insert Products
        await insertProduct(shoeDb, shoeData);
        console.log("✅ Shoe Inserted with Vendor Link");

        await insertProduct(watchDb, watchData);
        console.log("✅ Watch Inserted with Vendor Link");

        console.log("\n--- Success! Run 'node server.js' to view the data ---");
        process.exit(0);
    } catch (err) {
        console.error("❌ Test Failed:", err);
        process.exit(1);
    }
}

// Helper: Ensure vendor exists and return ID
async function ensureVendor(db, name, url) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT OR IGNORE INTO VENDORS (vendorName, vendorWebsiteUrl) VALUES (?, ?)`, [name, url], function(err) {
            if (err) return reject(err);
            // If it already existed, we need to fetch the ID
            db.get(`SELECT vendorId FROM VENDORS WHERE vendorName = ?`, [name], (err, row) => {
                if (err) reject(err);
                else resolve(row.vendorId);
            });
        });
    });
}

async function insertProduct(db, p) {
    const sql = `INSERT INTO PRODUCTS (
        productName, productOriginalPrice, productFetchedFrom, productUrl, 
        featuredimg, imageUrl, productBrand, sizeName, catName, videoUrl, availability
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    return new Promise((resolve, reject) => {
        db.run(sql, [
            p.productName, p.productOriginalPrice, p.productFetchedFrom, p.productUrl,
            p.featuredimg, p.imageUrl, p.productBrand, p.sizeName, p.catName, p.videoUrl, p.availability
        ], (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

populateWithRealData();