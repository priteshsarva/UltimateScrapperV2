import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';

class DbManager {
    constructor() {
        this.connections = {};
        this.dbFolder = path.resolve('./databases');

        if (!fs.existsSync(this.dbFolder)) {
            fs.mkdirSync(this.dbFolder, { recursive: true });
        }
    }

    async getDb(category) {



        if (!category) throw new Error("Category name is required.");
        const cat = category.toLowerCase();

        if (this.connections[cat]) return this.connections[cat];

        const dbPath = path.join(this.dbFolder, `${cat}.db`);

        return new Promise((resolve, reject) => {
            const db = new sqlite3.Database(dbPath, async (err) => {
                if (err) return reject(err);

                // db.run("PRAGMA journal_mode = DELETE"); // Write-Ahead Logging (Allows parallel read/write) comented because rishi claus said
                db.run("PRAGMA journal_mode = WAL"); //shown because rishi claus said
                db.run("PRAGMA busy_timeout = 5000"); // Wait up to 5 seconds if DB is busy
                try {
                    // Enable Foreign Keys
                    db.run("PRAGMA foreign_keys = ON");

                    // Initialize Schema
                    await this.initMasterSchema(db);

                    this.connections[cat] = db;
                    console.log(`[DB Manager] Connected: ${cat}.db`);
                    resolve(db);
                } catch (schemaError) {
                    reject(schemaError);
                }
            });
        });
    }


    // Add this inside the DbManager class
    async closeDb(category) {
        if (!category) return;
        const cat = category.toLowerCase();
        const db = this.connections[cat];

        if (db) {
            return new Promise((resolve, reject) => {
                db.close((err) => {
                    if (err) {
                        console.error("❌ Error closing " + cat + ".db:", err.message);
                        return reject(err);
                    }
                    // Remove the connection from the cache so it forces a fresh open next time
                    delete this.connections[cat];
                    console.log(`🔒 [DB Manager] Safely closed connection to: ${cat}.db`);
                    resolve();
                });
            });
        }
    }


    // Helper to turn db.run into a promise
    async runQuery(db, sql) {
        return new Promise((resolve, reject) => {
            db.run(sql, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    async initMasterSchema(db) {
        const schema = `
            CREATE TABLE IF NOT EXISTS TAGS (tagId INTEGER PRIMARY KEY AUTOINCREMENT, tagName TEXT UNIQUE NOT NULL);
            CREATE TABLE IF NOT EXISTS CATEGORIES (catId INTEGER PRIMARY KEY AUTOINCREMENT, catName TEXT UNIQUE NOT NULL, catImg TEXT, catSlug TEXT);
            CREATE TABLE IF NOT EXISTS SIZES (sizeId INTEGER PRIMARY KEY AUTOINCREMENT, sizeName TEXT UNIQUE NOT NULL);
            CREATE TABLE IF NOT EXISTS BRAND (brandId INTEGER PRIMARY KEY AUTOINCREMENT, brandName TEXT UNIQUE NOT NULL);
            CREATE TABLE IF NOT EXISTS VENDORS (vendorId INTEGER PRIMARY KEY AUTOINCREMENT, vendorName TEXT NOT NULL, vendorWebsiteUrl TEXT, vendorLastFetchedDate DATETIME, vendorDate DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS REVIEWS (reviewId INTEGER PRIMARY KEY AUTOINCREMENT, reviewName TEXT NOT NULL, reviewText TEXT NOT NULL, reviewStars INTEGER CHECK(reviewStars >= 1 AND reviewStars <= 5));
            
            CREATE TABLE IF NOT EXISTS PRODUCTS (
                productId INTEGER PRIMARY KEY AUTOINCREMENT,
                productName TEXT NOT NULL,
                productDateCreation DATETIME DEFAULT CURRENT_TIMESTAMP,
                productLastUpdated DATETIME DEFAULT CURRENT_TIMESTAMP,
                productPrice REAL,
                productPriceWithoutDiscount REAL,
                productOriginalPrice REAL NOT NULL,
                productFetchedFrom TEXT,     -- Restored to TEXT
                productUrl TEXT,
                featuredimg TEXT,
                imageUrl TEXT,
                videoUrl TEXT,
                productShortDescription TEXT,
                productDescription TEXT,
                productBrand TEXT,
                sizeName TEXT,
                catName TEXT,               
                availability BOOLEAN DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS ProductSizes (ProductId INTEGER, SizeId INTEGER, PRIMARY KEY (ProductId, SizeId), FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId) ON DELETE CASCADE, FOREIGN KEY (SizeId) REFERENCES SIZES(sizeId) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS ProductBrand (ProductId INTEGER, BrandId INTEGER, PRIMARY KEY (ProductId, BrandId), FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId) ON DELETE CASCADE, FOREIGN KEY (BrandId) REFERENCES BRAND(brandId) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS ProductCategories (ProductId INTEGER, CategoryId INTEGER, PRIMARY KEY (ProductId, CategoryId), FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId) ON DELETE CASCADE, FOREIGN KEY (CategoryId) REFERENCES CATEGORIES(catId) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS ProductTags (ProductId INTEGER, TagId INTEGER, PRIMARY KEY (ProductId, TagId), FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId) ON DELETE CASCADE, FOREIGN KEY (TagId) REFERENCES TAGS(tagId) ON DELETE CASCADE);
            CREATE TABLE IF NOT EXISTS ProductReviews (ProductId INTEGER, ReviewId INTEGER, PRIMARY KEY (ProductId, ReviewId), FOREIGN KEY (ProductId) REFERENCES PRODUCTS(productId) ON DELETE CASCADE, FOREIGN KEY (ReviewId) REFERENCES REVIEWS(reviewId) ON DELETE CASCADE);
        `;

        // Split by semicolon and run each statement
        const statements = schema.split(';').filter(s => s.trim() !== '');
        for (const sql of statements) {
            await this.runQuery(db, sql);
        }
    }
}



export const dbManager = new DbManager();