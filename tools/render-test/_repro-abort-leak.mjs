// Capture the stack of the unhandled AbortError rejection seen during the
// drifters loop verify. Scrubs trigger flushPrefetch abort storms.
import { chromium } from 'playwright';

const BASE = process.env.STT_URL || 'http://localhost:3000';
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
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();
await page.addInitScript(() => {
  globalThis.__rejections = [];
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    globalThis.__rejections.push({
      name: r?.name,
      message: String(r?.message ?? r).slice(0, 200),
      stack: String(r?.stack ?? '').slice(0, 1500),
    });
  });
});
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', {
  offline: false,
  latency: 40,
  downloadThroughput: (8 * 1024 * 1024) / 8,
  uploadThroughput: (1024 * 1024) / 8,
});
await page.goto(`${BASE}/demo/ocean-drifters`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page
  .locator('.map-viewport')
  .first()
  .waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(8000);
const setRange = (v) =>
  page
    .locator('input[type="range"]')
    .first()
    .evaluate((el, val) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(el, String(val));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);
const b = await page
  .locator('input[type="range"]')
  .first()
  .evaluate((el) => ({ min: Number(el.min), max: Number(el.max) }));
// Rapid scrubs while loads are in flight → supersession + flushPrefetch aborts.
for (const f of [0.3, 0.7, 0.15, 0.9, 0.5]) {
  await setRange(b.min + (b.max - b.min) * f);
  await page.waitForTimeout(2500);
}
await page.waitForTimeout(6000);
const rej = await page.evaluate(() => globalThis.__rejections);
console.log(JSON.stringify(rej, null, 2));
await ctx.close();
await browser.close();
