import { dbManager } from '../models/dbManager.js';
import { SITES_REGISTRY } from '../config/sites.js';

export async function getClientData(clientConfig, queryType, queryParams) {
    // We will store the results from each database in separate arrays first
    let dbArrays = [];

    for (const rule of clientConfig.access) {
        
        
        const db = await dbManager.getDb(rule.database);
        let sql = queryParams.sql;
        let params = [...queryParams.params];

        // Apply Manufacturer Filter
        if (rule.manufacturers !== "all") {
            const searchKeys = SITES_REGISTRY
                .filter(s => rule.manufacturers.includes(s.id))
                .map(s => `%${s.searchKey}%`);

            if (searchKeys.length > 0) {
                const whereClause = searchKeys.map(() => "productFetchedFrom LIKE ?").join(" OR ");
                sql += ` AND (${whereClause})`;
                params.push(...searchKeys);
            }
        }

        const rows = await new Promise((res) => db.all(sql, params, (err, rows) => res(rows || [])));

        // Add the database name to the rows and push as a separate array
        dbArrays.push(rows.map(r => ({ ...r, primarycat: rule.database })));
    }

    // ==========================================
    // Round-Robin Interleaving (The "Blend")
    // ==========================================
    // ==========================================
    // Combine all results and completely Randomize (Shuffle)
    // ==========================================

    // 1. Flatten the array of arrays into one single list
    let blendedResults = dbArrays.flat();

    // 2. Fisher-Yates Random Shuffle on the combined results
    for (let i = blendedResults.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        // Swap elements
        [blendedResults[i], blendedResults[j]] = [blendedResults[j], blendedResults[i]];
    }

    return blendedResults;
}