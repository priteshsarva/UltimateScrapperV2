import sqlite3 from 'sqlite3';
import { dbManager } from './models/dbManager.js';

const MIGRATION_CONFIG = [
    { category: 'shoes', oldDbPath: './old_shoes.db' },
    // { category: 'watches', oldDbPath: './old_watch.db' }
];

async function startMigration() {
    console.log("🚀 Starting Final Migration...");

    for (const task of MIGRATION_CONFIG) {
        try {
            console.log(`\n--- Migrating [${task.category.toUpperCase()}] ---`);
            const oldDb = new sqlite3.Database(task.oldDbPath);
            const newDb = await dbManager.getDb(task.category);

            // Disable all checks for speed and to prevent crashes
            await new Promise(res => newDb.run("PRAGMA foreign_keys = OFF", res));
            await new Promise(res => newDb.run("BEGIN TRANSACTION", res));

            // List of all tables to copy exactly
            const tables = [
                'TAGS', 'CATEGORIES', 'SIZES', 'BRAND', 'VENDORS', 'REVIEWS',
                'PRODUCTS', 'ProductSizes', 'ProductBrand', 'ProductCategories', 
                'ProductTags', 'ProductReviews'
            ];

            for (const table of tables) {
                await copyTable(oldDb, newDb, table);
            }

            await new Promise(res => newDb.run("COMMIT", res));
            console.log(`✅ Finished ${task.category}`);
            oldDb.close();
        } catch (err) {
            console.error(`❌ Error:`, err.message);
        }
    }
    console.log("\n✨ Done! Check your file sizes now.");
    process.exit(0);
}

async function copyTable(oldDb, newDb, tableName) {
    return new Promise((resolve) => {
        oldDb.all(`SELECT * FROM ${tableName}`, [], async (err, rows) => {
            if (err || !rows || rows.length === 0) return resolve();

            const columns = Object.keys(rows[0]);
            const placeholders = columns.map(() => '?').join(',');
            const sql = `INSERT OR REPLACE INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`;

            // Process in chunks of 1000 for speed
            for (let i = 0; i < rows.length; i++) {
                const values = columns.map(col => rows[i][col]);
                newDb.run(sql, values);
            }
            console.log(`   ✔ ${tableName}: ${rows.length} rows`);
            resolve();
        });
    });
}

startMigration();