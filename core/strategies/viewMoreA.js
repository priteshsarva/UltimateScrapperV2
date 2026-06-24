// ============================================================
// HUMAN-LIKE viewMore Function
// Mimics real user behavior: scrolling, hovering, pausing, 
// occasionally clicking on products, moving mouse erratically
// ============================================================

import { humanizePage, smoothMouseMove, sleep } from '../humanize.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// Random delay that feels human (not perfectly timed)
const humanDelay = () => delay(randInt(400, 1200));

async function viewMore(page, productCount) {
    const count = Math.ceil(productCount / 12);
    const viewMoreButtonSelector = '#loadmore_btn_category_product';

    console.log(`🔄 Max clicks needed: ${count}`);

    // 1. Initial human behavior — scroll around, look at products first
    console.log(`👀 Browsing products naturally before loading more...`);
    await scrollDownSlowly(page, randInt(300, 600));
    await humanDelay();
    await hoverRandomProduct(page);
    await humanDelay();

    for (let i = 0; i < count; i++) {
        try {
            // 2. Check for "Sold Out" 
            const foundSoldOut = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('#product_list_div button'));
                return buttons.some(btn => btn.innerText.trim().toLowerCase().includes('sold out'));
            });

            if (foundSoldOut) {
                console.log(`🛑 "Sold Out" detected! Stopping.`);
                break;
            }

            // 3. Count products BEFORE clicking
            const beforeCount = await page.evaluate(() => {
                return document.querySelectorAll('#product_list_div div.col-lg-4, #product_list_div div.col-md-6, #product_list_div div.col-6').length;
            });

            // 4. Scroll down to make the "View More" button visible
            //    A real user would scroll to find the button, not just click it
            await scrollToElement(page, viewMoreButtonSelector);
            await delay(randInt(300, 800));

            // 5. Wait for button to be visible and clickable
            await page.waitForFunction(() => {
                const btn = document.querySelector('#loadmore_btn_category_product');
                return btn && btn.offsetParent !== null && btn.style.display !== 'none';
            }, { timeout: 10000 });

            // 6. HUMAN TOUCH: Hover over button before clicking (like a real user)
            await hoverElement(page, viewMoreButtonSelector);
            await delay(randInt(150, 400)); // Brief pause after hover

            // 7. Click with slight random delay (humans don't click instantly)
            await page.click(viewMoreButtonSelector, { delay: randInt(50, 150) });

            console.log(`👉 Clicked ${i + 1}/${count}. Waiting for AJAX...`);

            // 8. Wait for new products to appear in DOM
            try {
                await page.waitForFunction((prev) => {
                    const items = document.querySelectorAll('#product_list_div div.col-lg-4, #product_list_div div.col-md-6, #product_list_div div.col-6');
                    return items.length > prev;
                }, { timeout: 10000 }, beforeCount);

                const afterCount = await page.evaluate(() => {
                    return document.querySelectorAll('#product_list_div div.col-lg-4, #product_list_div div.col-md-6, #product_list_div div.col-6').length;
                });

                console.log(`✅ Products: ${beforeCount} → ${afterCount}`);

            } catch {
                const stillVisible = await page.evaluate(() => {
                    const btn = document.querySelector('#loadmore_btn_category_product');
                    return btn && btn.offsetParent !== null && btn.style.display !== 'none';
                });

                if (!stillVisible) {
                    console.log(`✅ Button gone. All products loaded.`);
                    break;
                }
                console.log(`⚠️ No new products but button still there. Retrying...`);
            }

            // 9. HUMAN BEHAVIOR between clicks — don't just spam the button
            await doHumanStuffBetweenClicks(page, i);

        } catch (error) {
            console.log(`✅ Done loading. (${error.message})`);
            break;
        }
    }

    // Final scroll back to top like a real user reviewing all products
    console.log(`📜 Scrolling back to review loaded products...`);
    await scrollToTop(page);
    await delay(randInt(500, 1000));
}


// ============================================================
// HELPER: Human-like behavior between "Load More" clicks
// ============================================================
async function doHumanStuffBetweenClicks(page, clickIndex) {
    const action = Math.random();

    if (action < 0.35) {
        // 35% chance: Scroll through newly loaded products
        console.log(`   🔍 Browsing new products...`);
        await scrollDownSlowly(page, randInt(200, 500));
        await delay(randInt(500, 1500));
        await hoverRandomProduct(page);
        await delay(randInt(300, 800));

    } else if (action < 0.55) {
        // 20% chance: Scroll up a bit then back down (like re-reading)
        console.log(`   ↕️ Scrolling back to check something...`);
        await page.evaluate(() => window.scrollBy({ top: -200, behavior: 'smooth' }));
        await delay(randInt(600, 1200));
        await page.evaluate(() => window.scrollBy({ top: 350, behavior: 'smooth' }));
        await delay(randInt(400, 800));

    } else if (action < 0.70) {
        // 15% chance: Move mouse randomly (reading/thinking)
        console.log(`   🖱️ Moving mouse around...`);
        await randomMouseMovements(page, randInt(2, 4));
        await delay(randInt(300, 700));

    } else if (action < 0.82) {
        // 12% chance: Hover over a product image (window shopping)
        console.log(`   👁️ Looking at a product closely...`);
        await hoverRandomProduct(page);
        await delay(randInt(800, 2000)); // Linger like actually reading
        
    } else if (action < 0.92) {
        // 10% chance: Brief pause — user distracted / reading phone
        const pauseMs = randInt(1500, 3500);
        console.log(`   ⏸️ Brief pause (${Math.round(pauseMs / 1000)}s)...`);
        await delay(pauseMs);

    } else {
        // 8% chance: Tiny micro-scroll (like adjusting view slightly)
        await page.evaluate(() => window.scrollBy({ top: randInt(-50, 100), behavior: 'smooth' }));
        await delay(randInt(200, 600));
    }

    // Always add a small random base delay (humans aren't instant)
    await delay(randInt(300, 900));
}


// ============================================================
// HELPER: Scroll down smoothly like a human
// ============================================================
async function scrollDownSlowly(page, totalDistance) {
    const steps = randInt(3, 6);
    const stepDistance = Math.round(totalDistance / steps);

    for (let i = 0; i < steps; i++) {
        // Vary each scroll step slightly (humans aren't precise)
        const variance = randInt(-30, 30);
        await page.evaluate((dist) => {
            window.scrollBy({ top: dist, behavior: 'smooth' });
        }, stepDistance + variance);

        await delay(randInt(100, 350));
    }
}


// ============================================================
// HELPER: Scroll to a specific element naturally
// ============================================================
async function scrollToElement(page, selector) {
    const exists = await page.evaluate((sel) => !!document.querySelector(sel), selector);
    if (!exists) return;

    // First scroll roughly into view
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, selector);

    await delay(randInt(300, 600));

    // Then do a small adjustment scroll (humans overshoot/undershoot)
    await page.evaluate(() => {
        window.scrollBy({ top: Math.floor(Math.random() * 60) - 20, behavior: 'smooth' });
    });

    await delay(randInt(150, 400));
}


// ============================================================
// HELPER: Scroll back to top
// ============================================================
async function scrollToTop(page) {
    const scrollY = await page.evaluate(() => window.scrollY);
    const steps = Math.max(3, Math.round(scrollY / 500));

    for (let i = 0; i < steps; i++) {
        await page.evaluate(() => {
            window.scrollBy({ top: -500, behavior: 'smooth' });
        });
        await delay(randInt(150, 350));
    }
}


// ============================================================
// HELPER: Hover over a random product card
// ============================================================
async function hoverRandomProduct(page) {
    try {
        const productCount = await page.evaluate(() => {
            return document.querySelectorAll('#product_list_div div.col-lg-4, #product_list_div div.col-md-6, #product_list_div div.col-6').length;
        });

        if (productCount === 0) return;

        // Pick a random product from the LAST batch (more natural — user looks at new stuff)
        const targetIndex = Math.max(0, productCount - randInt(1, Math.min(12, productCount)));

        const box = await page.evaluate((idx) => {
            const cards = document.querySelectorAll('#product_list_div div.col-lg-4, #product_list_div div.col-md-6, #product_list_div div.col-6');
            const card = cards[idx];
            if (!card) return null;
            const rect = card.getBoundingClientRect();
            return {
                x: rect.x + rect.width * (0.2 + Math.random() * 0.6),
                y: rect.y + rect.height * (0.2 + Math.random() * 0.6),
                visible: rect.top >= 0 && rect.bottom <= window.innerHeight
            };
        }, targetIndex);

        if (box && box.visible) {
            // Move mouse to the product card with natural movement
            await smoothMouseMove(page, box.x, box.y, randInt(8, 16));
            await delay(randInt(200, 600));

            // Sometimes hover over the image specifically
            if (Math.random() < 0.4) {
                const imgBox = await page.evaluate((idx) => {
                    const cards = document.querySelectorAll('#product_list_div div.col-lg-4, #product_list_div div.col-md-6, #product_list_div div.col-6');
                    const img = cards[idx]?.querySelector('img.img-fluid');
                    if (!img) return null;
                    const rect = img.getBoundingClientRect();
                    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
                }, targetIndex);

                if (imgBox) {
                    await smoothMouseMove(page, imgBox.x, imgBox.y, randInt(5, 10));
                    await delay(randInt(300, 800));
                }
            }
        }
    } catch (e) {
        // Silently fail — hover is cosmetic
    }
}


// ============================================================
// HELPER: Hover over a specific element before clicking
// ============================================================
async function hoverElement(page, selector) {
    try {
        const box = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {
                x: rect.x + rect.width * (0.3 + Math.random() * 0.4),
                y: rect.y + rect.height * (0.3 + Math.random() * 0.4)
            };
        }, selector);

        if (box) {
            await smoothMouseMove(page, box.x, box.y, randInt(8, 14));
        }
    } catch (e) {
        // Fall through — clicking will still work
    }
}


// ============================================================
// HELPER: Random mouse movements (fidgeting / reading behavior)
// ============================================================
async function randomMouseMovements(page, count = 3) {
    const viewport = page.viewport() || { width: 1080, height: 800 };

    for (let i = 0; i < count; i++) {
        const x = randInt(100, viewport.width - 100);
        const y = randInt(100, viewport.height - 100);
        await smoothMouseMove(page, x, y, randInt(6, 14));
        await delay(randInt(100, 400));
    }
}


export { viewMore };
