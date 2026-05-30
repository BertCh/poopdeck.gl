// Screenshot satellite demos in a fresh (uncached) browser, paused and playing.
// Usage: node _shot-sats.mjs <tag>
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.argv[2] || 'check';
const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve(process.cwd(), 'output/sats');
fs.mkdirSync(OUTPUT, { recursive: true });
const ONLY = process.env.ONLY;
const DATASETS = ONLY ? ONLY.split(',') : ['satellites', 'satellite-trips-flat'];

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-sandbox'],
});

for (const id of DATASETS) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, bypassCSP: true });
  await ctx.clearCookies();
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));
  try {
    await page.goto(`${BASE_URL}/demo/${id}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('.map-viewport').first().waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: path.join(OUTPUT, `${id}.${TAG}.paused.png`) });
    // start playback
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent && x.textContent.trim() === '▶');
      if (b) b.click();
    });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: path.join(OUTPUT, `${id}.${TAG}.playing.png`) });
    console.log(`${id}: ok (errors ${errs.length})`, errs.slice(0, 3).join(' | '));
  } catch (e) {
    console.log(`${id}: FAIL ${String(e?.message || e).slice(0, 120)}`);
  }
  await ctx.close();
}
await browser.close();
