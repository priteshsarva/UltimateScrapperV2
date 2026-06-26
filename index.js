import { exec } from 'child_process';

import express, { json } from "express";
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import productRoutes from './routes/productRoutes.js'
import devRoutes from './routes/devRoutes.js'

import { tenantIdentify } from './middleware/tenantIdentify.js';
import { SITES_REGISTRY } from './config/sites.js';
import { dbManager } from './models/dbManager.js';

import { CLIENT_CONFIGS } from './config/clients.js';

import { executeScraper } from './core/scraperManager.js'
import authRoutes from "./portal/authRoutes.js";
import enrollmentRoutes from "./portal/enrollmentRoutes.js";
import adminRoutes from "./portal/adminRoutes.js";
import sourceRoutes from "./portal/sourceRoutes.js";
import { nextSourceToScrape } from './portal/sources.js';
import { enqueueScrape } from './portal/scrapeQueue.js';
import { scrapeRequestRoutes, adminScrapeRequestRoutes } from "./portal/scrapeRequestRoutes.js";
import { sourceCategoryRoutes, adminSourceCategoryRoutes } from "./portal/categoryRoutes.js";
import enrollmentSourceRoutes from "./portal/enrollmentSourceRoutes.js";

// const PORT = process.env.PORT || 5000;
const PORT = 3002; // Force port 3002 for production behind Cloudflare


const STATE_FILE = path.join(process.cwd(), 'scraper-state.json');




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

async function runRotator() {
    // Least-recently-scraped ACTIVE source from Supabase.
    // Paused sources are skipped automatically; no positional cursor.
    const source = await nextSourceToScrape();
    if (!source) {
        console.log("🔄 [ROTATOR] No active sources to scrape.");
        return;
    }

    console.log(`\n🔄 [ROTATOR] Scraping: ${source.name || source.id} (${source.search_key})`);

    // Through the shared single-runner queue (serializes with on-demand scrapes).
    // enqueueScrape stamps last_scraped_at on completion, so the next run advances.
    await enqueueScrape(source);

    console.log(`✅ Rotator run complete: ${source.name || source.id}\n`);
}



const app = express()
app.use(express.json());// for parsing application/json
// Enable CORS for all routes
app.use(cors({
    // origin: 'http://localhost:5173', // Allow requests from this origin
    // origin: ['http://localhost:5173', 'https://your-frontend-domain.com'], // Allow specific origins
    // credentials: true, // Allow credentials (cookies, authorization headers)

    origin: '*', // Allow requests from all origin
    credentials: false,// Allow credentials (cookies, authorization headers)

    methods: 'GET,POST,PUT,DELETE', // Allow specific HTTP methods
    allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use("/portal/scrape-requests", scrapeRequestRoutes);
app.use("/portal/admin/scrape-requests", adminScrapeRequestRoutes);
app.use("/portal/admin/sources", sourceRoutes);
app.use("/portal/sources", sourceCategoryRoutes);              // GET /portal/sources/:id/categories
app.use("/portal/admin/sources", adminSourceCategoryRoutes);  // alongside the existing sourceRoutes
app.use("/portal", enrollmentSourceRoutes);

app.options('*', cors()); // Handle preflight requests for all routes

app.get('/', async (req, res) => {
    console.log("working");

    res.set('content-type', 'application/json');
    res.status(200).json({ status: 200, server: "Runnnig" });

});


app.use('/product', tenantIdentify, productRoutes);

app.get('/updateserver', async (req, res) => {
    try {
        console.log("working");

        const now = new Date();
        const dateTimeString = now.toISOString().replace('T', ' ').split('.')[0];
        const commitMessage = `DB updated on ${dateTimeString}`;

        console.log("🧹 Smart Checkpoint & Backup triggered for ALL databases...");

        // 1. Dynamically find all unique databases
        const databasesToSync = new Set();
        for (const client of Object.values(CLIENT_CONFIGS)) {
            for (const rule of client.access) {
                databasesToSync.add(rule.database);
            }
        }
        const dbList = Array.from(databasesToSync);

        // 2. Perform a SMART merge (Try TRUNCATE first, fallback to PASSIVE if busy)
        for (const dbName of dbList) {
            if (dbManager.connections[dbName]) {
                const db = dbManager.connections[dbName];

                await new Promise((resolve) => {
                    // Try the aggressive TRUNCATE first to shrink WAL to 0 bytes
                    db.run("PRAGMA wal_checkpoint(TRUNCATE);", function (err) {
                        if (err) {
                            console.log(`⚠️ ${dbName} is busy. Falling back to PASSIVE merge...`);
                            // Fallback to passive if the scraper is currently locking it
                            db.run("PRAGMA wal_checkpoint(PASSIVE);", () => resolve());
                        } else {
                            console.log(`✅ ${dbName}.db fully merged and WAL truncated to 0 bytes!`);
                            resolve();
                        }
                    });
                });
            }
        }

        // 3. Respond to the API immediately
        res.status(200).json({ status: 200, message: `Server updating and backing up to Git in the background...` });

        // 4. THE FIX: Give the server's Hard Drive 3 seconds to physically finish writing the files
        console.log("⏳ Waiting 3 seconds for disk I/O to settle before Git commit...");
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 5. Run Git commands
        exec('git add .', (err) => {
            if (err) {
                console.error('❌ Error adding files:', err);
                return;
            }
            console.log('✅ Changes staged.');

            exec(`git commit -m "${commitMessage}"`, (err) => {
                if (err && !err.message.includes('nothing to commit')) {
                    console.error('❌ Error committing:', err);
                    return;
                }

                if (err && err.message.includes('nothing to commit')) {
                    console.log('ℹ️ No changes to commit.');
                } else {
                    console.log('✅ Changes committed.');
                }

                exec('git push', (err) => {
                    if (err) {
                        console.error('❌ Error pushing to remote:', err);
                    } else {
                        console.log('✅ Changes pushed to remote repository.');
                    }
                });
            });
        });

    } catch (error) {
        console.error("❌ Error in updateserver:", error);
        if (!res.headersSent) {
            res.status(500).json({ error: "Update failed", details: error.message });
        }
    }
});

app.get('/devproductupdates', async (req, res) => {
    res.set('content-type', 'application/json');
    // Get the current timestamp
    const timestamp = Date.now();

    // Convert the timestamp to a Date object
    const date = new Date(timestamp);

    // Format the date and time with time zone
    const options = {
        weekday: 'short', // "Fri"
        year: 'numeric', // "2017"
        month: 'short', // "Nov"
        day: 'numeric', // "17"
        hour: '2-digit', // "19"
        minute: '2-digit', // "15"
        second: '2-digit', // "15"
        timeZone: 'Asia/Kolkata', // Time zone for Kolkata
        timeZoneName: 'longOffset', // "GMT+05:30"
    };

    // Format the date and time
    const formattedDate = date.toLocaleString('en-IN', options);
    try {
        gitAutoCommitAndPush();
        res.status(200).json({ status: 200, message: `Scrapping started at: ${formattedDate}` });

        for (const site of SITES_REGISTRY) {
            console.log(site.searchKey);
            // Execute the rotator and this also executeScraper
            await runRotator();
            // await executeScraper(site.searchKey);

        }
        gitAutoCommitAndPush();

    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).json({ status: 500, message: 'Internal Server Error' });
    }

})

app.use('/dev', tenantIdentify, devRoutes)


app.use("/auth", authRoutes);       // /auth/signup, /auth/login, /auth/me
app.use("/portal/admin", adminRoutes);  // mount admin BEFORE the client router
app.use("/portal", enrollmentRoutes);   // /portal/enrollments ...











app.listen(PORT, '0.0.0.0', (err) => {
    if (err) {
        return console.log(err);
    }
    console.log(`Server is running on port ${PORT}`);
});


