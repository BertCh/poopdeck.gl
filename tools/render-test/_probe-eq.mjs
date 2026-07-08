import { chromium } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(
  new URL('./output/probe-earthquake', import.meta.url),
);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--no-sandbox',
  ],
});

const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (msg) => {
  const t = msg.type();
  if (t === 'error' || t === 'warning') {
    consoleErrors.push(`[${t}] ${msg.text()}`);
  }
});
page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

// Step 1: navigate
await page.goto('http://localhost:3000/demo/earthquake-activity', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page
  .locator('.map-viewport')
  .first()
  .waitFor({ state: 'visible', timeout: 30_000 });

// Initial frame
await page.waitForTimeout(3000);
await page.screenshot({ path: `${OUT}/01-initial.png` });

// Wait for animation to load some tiles
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/02-after-load.png` });

// Try to click play if there's a play button (to advance through time)
try {
  const playBtn = page
    .locator('button')
    .filter({ hasText: /play|▶/i })
    .first();
  if (await playBtn.count()) {
    await playBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/03-playing.png` });
  }
} catch (e) {
  console.log('No play button found:', e.message);
}

// Zoom into Japan area to verify Ring of Fire
try {
  // Find the deck.gl canvas and use mouse wheel to zoom
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (box) {
    // The dataset starts centered on (140, 20) zoom 2 — fine for Japan view
    // Wheel-zoom in once
    await canvas.hover({ position: { x: box.width / 2, y: box.height / 2 } });
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/04-zoomed.png` });
  }
} catch (e) {
  console.log('Zoom probe failed:', e.message);
}

// Re-check the page state
await page.waitForTimeout(2000);
await page.screenshot({ path: `${OUT}/05-final.png`, fullPage: false });

// Try to read what features were drawn — count canvas pixels by sampling.
// Use the page's deck.gl instance if exposed, otherwise just rely on
// screenshot inspection.

const summary = {
  url: page.url(),
  title: await page.title(),
  consoleErrorCount: consoleErrors.length,
  consoleErrors: consoleErrors.slice(0, 20),
  pageErrorCount: pageErrors.length,
  pageErrors: pageErrors.slice(0, 10),
};
fs.writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

await ctx.close();
await browser.close();
