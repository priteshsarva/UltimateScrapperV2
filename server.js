import express from 'express';
import cors from 'cors';
import { dbManager } from './models/dbManager.js';
import { SITES_REGISTRY } from './config/sites.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// HELPER: Promisify SQLite all()
const queryAll = (db, sql, params = []) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
};

/**
 * 4.1 GET /api/sites
 * Returns the registry of all websites we scrape.
 */
app.get('/api/sites', (req, res) => {
    res.json(SITES_REGISTRY);
});

/**
 * 4.2 GET /api/:category/products
 * Multi-site filter logic.
 * Example: /api/watches/products?sites=zeewatches,watchhouse11
 */
app.get('/api/:category/products', async (req, res) => {
    try {
        const { category } = req.params;
        const { sites } = req.query; 
        
        const db = await dbManager.getDb(category);
        
        let sql = "SELECT * FROM PRODUCTS";
        let params = [];

        if (sites) {
            const siteIds = sites.split(',');
            // Map IDs from URL to searchKeys from Registry
            const searchKeys = SITES_REGISTRY
                .filter(s => siteIds.includes(s.id))
                .map(s => `%${s.searchKey}%`);

            if (searchKeys.length > 0) {
                const whereClause = searchKeys.map(() => "productFetchedFrom LIKE ?").join(" OR ");
                sql += ` WHERE ${whereClause}`;
                params = searchKeys;
            }
        }

        const rows = await queryAll(db, sql, params);
        res.json({
            category,
            count: rows.length,
            products: rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * 4.3 GET /api/stats
 * Provides a summary of all databases currently in the folder.
 */
app.get('/api/stats', async (req, res) => {
    try {
        // Get unique categories from the registry
        const categories = [...new Set(SITES_REGISTRY.map(s => s.category))];
        const stats = [];

        for (const cat of categories) {
            const db = await dbManager.getDb(cat);
            const countRow = await queryAll(db, "SELECT COUNT(*) as total FROM PRODUCTS");
            stats.push({
                category: cat,
                totalProducts: countRow[0].total
            });
        }

        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`✅ Phase 4 API Online at http://localhost:${PORT}`);
});