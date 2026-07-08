// Screenshot the animal-migration demo mid-playback to check for the
// antimeridian "globe-spanning line" artifact. Captures the map viewport only
// (full-page screenshot stalls on web-font loading).
// Usage: node _shot-animals.mjs <tag>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.argv[2] || 'check';
const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve(process.cwd(), 'output/sats');
fs.mkdirSync(OUTPUT, { recursive: true });

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
  viewport: { width: 1600, height: 800 },
  bypassCSP: true,
});
await ctx.clearCookies();
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));

await page.goto(`${BASE_URL}/demo/animal-migration`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
const map = page.locator('.map-viewport').first();
await map.waitFor({ state: 'visible', timeout: 30_000 });
// Preload web fonts so the screenshot's font-stability wait resolves instantly.
await page.evaluate(() => document.fonts.ready).catch(() => {});
await page.waitForTimeout(3000);

// Start playback and let trails accumulate across many tracks.
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(
    (x) => x.textContent && x.textContent.trim() === '▶',
  );
  if (b) b.click();
});
await page.waitForTimeout(12000);
await page.screenshot({
  path: path.join(OUTPUT, `animal-migration.${TAG}.playing.png`),
  timeout: 60_000,
});
console.log(
  `animal-migration: ok (errors ${errs.length})`,
  errs.slice(0, 3).join(' | '),
);

await ctx.close();
await browser.close();
