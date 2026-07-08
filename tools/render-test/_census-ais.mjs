// Color census of the ship-traffic demo at the Houston/Gulf zoom: what
// distinct colors are actually on the canvas? (Palette debug aid.)
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
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`${BASE}/demo/ship-traffic`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page
  .locator('.map-viewport canvas')
  .first()
  .waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(10_000);
const box = await page.locator('.map-viewport canvas').first().boundingBox();
await page.mouse.move(box.x + box.width * 0.516, box.y + box.height * 0.48);
for (let i = 0; i < 4; i++) {
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(450);
}
await page.waitForTimeout(8000);
// Pause-free: sample the parked frame (paused playback shows the window
// around the initial playhead).
const census = await page.evaluate(() => {
  const c = document.querySelector('.map-viewport canvas');
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  const w = c.width,
    h = c.height;
  const buf = new Uint8Array(4 * w * h);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  const counts = new Map();
  let lit = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i],
      g = buf[i + 1],
      b = buf[i + 2];
    const max = Math.max(r, g, b),
      min = Math.min(r, g, b);
    if (max < 55 || max - min < 22) continue;
    lit++;
    const key = `${r >> 4},${g >> 4},${b >> 4}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b2) => b2[1] - a[1])
    .slice(0, 14)
    .map(([k, n]) => ({
      rgb16: k,
      approx: k
        .split(',')
        .map((x) => (Number(x) << 4) + 8)
        .join(','),
      n,
    }));
  return { w, h, lit, distinctQuantized: counts.size, top };
});
console.log(JSON.stringify(census, null, 2));
await ctx.close();
await browser.close();
