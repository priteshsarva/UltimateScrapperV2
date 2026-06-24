// humanize.mjs
// ESM version — use `import { humanizePage } from './humanize.mjs'`

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function smoothMouseMove(page, x, y, steps = 12) {
  const box = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const clampX = Math.max(1, Math.min(x, Math.max(2, box.w - 1)));
  const clampY = Math.max(1, Math.min(y, Math.max(2, box.h - 1)));
  let curX = randInt(10, Math.min(200, clampX));
  let curY = randInt(10, Math.min(200, clampY));
  for (let i = 0; i < steps; i++) {
    const nx = Math.round(curX + ((clampX - curX) * (i + 1)) / steps);
    const ny = Math.round(curY + ((clampY - curY) * (i + 1)) / steps);
    try {
      await page.mouse.move(nx, ny, { steps: 1 });
    } catch (e) {
      await page.mouse.move(nx, ny);
    }
    await sleep(randInt(15, 60));
  }
}

async function humanScroll(page, {minDelay = 200, maxDelay = 900, maxScrolls = 6, scrollPct = 0.25} = {}) {
  const height = await page.evaluate(() => document.body.scrollHeight || document.documentElement.scrollHeight);
  const viewport = (await page.viewport()) || { height: 800 };
  const scrollBy = Math.max(200, Math.round((height - (viewport.height||800)) * scrollPct));
  for (let i = 0; i < randInt(1, maxScrolls); i++) {
    await page.evaluate((y) => window.scrollBy({ top: y, left: 0, behavior: 'smooth' }), scrollBy);
    await sleep(randInt(minDelay, maxDelay));
    if (Math.random() < 0.25) {
      await page.evaluate(() => window.scrollBy({ top: -50, left: 0, behavior: 'smooth' }));
      await sleep(randInt(80, 220));
    }
    const pos = await page.evaluate(() => window.scrollY + window.innerHeight);
    const total = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
    if (pos + 100 >= total) break;
  }
  await sleep(randInt(150, 600));
}

async function humanType(page, selectorOrHandle, text, {minDelay = 50, maxDelay = 180, clickBefore = true} = {}) {
  let handle = selectorOrHandle;
  if (typeof selectorOrHandle === 'string') {
    handle = await page.$(selectorOrHandle);
    if (!handle) throw new Error('humanType: selector not found -> ' + selectorOrHandle);
  }
  if (clickBefore) {
    try {
      await handle.click({ delay: randInt(50, 120) });
    } catch (e) {
      await page.evaluate((el) => el.focus(), await handle);
    }
    await sleep(randInt(80, 200));
  }
  for (const ch of text) {
    if (handle.type) {
      await handle.type(ch, { delay: randInt(minDelay, maxDelay) });
    } else {
      await page.keyboard.type(ch, { delay: randInt(minDelay, maxDelay) });
    }
    if (Math.random() < 0.02) await sleep(randInt(120, 350));
  }
}

async function humanizePage(page, {minDelay = 800, maxDelay = 2500, mouseMoves = 2, doScroll = true} = {}) {
  await sleep(randInt(minDelay, maxDelay));
  for (let i = 0; i < mouseMoves; i++) {
    const x = randInt(50, (page.viewport()?.width || 1080) - 50);
    const y = randInt(50, (page.viewport()?.height || 800) - 50);
    await smoothMouseMove(page, x, y, randInt(6, 20));
    await sleep(randInt(120, 500));
  }
  if (doScroll) await humanScroll(page, {minDelay: 200, maxDelay: 700, maxScrolls: 5, scrollPct: 0.2});
  await sleep(randInt(300, 1000));
}

export {
  humanizePage,
  humanType,
  humanScroll,
  smoothMouseMove,
  sleep
};
