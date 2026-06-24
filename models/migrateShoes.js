import sqlite3 from 'sqlite3';
import { dbFactory } from './src/models/dbManager.js';

// 1. Path to your current OLD shoes database file
const oldShoesPath = './Old_Shoe_Database.db';
const oldDb = new sqlite3.Database(oldShoesPath);

async function migrate() {
    console.log("Starting Migration...");

    // 2. Get the NEW shoes database connection (automatically creates the master schema)
    const newDb = await dbFactory.getDb('shoes');

    // 3. Fetch all products from old DB
    oldDb.all("SELECT * FROM PRODUCTS", [], async (err, rows) => {
        if (err) return console.error("Error reading old DB:", err);

        console.log(`Found ${rows.length} products to migrate.`);

        for (const row of rows) {
            const query = `INSERT INTO PRODUCTS (
                productName, productPrice, productPriceWithoutDiscount, productOriginalPrice,
                productFetchedFrom, productUrl, featuredimg, imageUrl, videoUrl,
                productShortDescription, productDescription, productBrand, sizeName, catName, availability
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

            const params = [
                row.productName,
                row.productPrice,
                row.productPriceWithoutDiscount,
                row.productOriginalPrice,
                row.productFetchedFrom,
                row.productUrl,
                row.featuredimg,
                row.imageUrl,
                null, // videoUrl (Didn't exist in old DB)
                row.productShortDescription,
                row.productDescription,
                row.productBrand,
                row.sizeName,
                row.catName,
                1     // availability (Default to 1/True)
            ];

            newDb.run(query, params, (err) => {
                if (err) console.error(`Failed to migrate ${row.productName}:`, err.message);
            });
        }
        console.log("Migration Successful! Your shoes are now in /databases/shoes.db");
    });
}

migrate();