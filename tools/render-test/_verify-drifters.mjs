// Verify the ocean-drifters demo renders a per-vertex SST gradient (blue→red),
// not a single flat color. Requires a running showcase dev server.
// Usage: node _verify-drifters.mjs [port]
import { chromium } from 'playwright';
import fs from 'node:fs';

const PORT = process.argv[2] || '3000';
const BASE = `http://localhost:${PORT}`;
const OUT = '/tmp/drifters-verify.png';

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
  bypassCSP: true,
});
const page = await ctx.newPage();
const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});
page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));

let result = { ok: false };
try {
  await page.goto(`${BASE}/demo/ocean-drifters`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .locator('.map-viewport')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  // Globe + 2.3GB archive: give tiles time to load, then play several frames.
  await page.waitForTimeout(6000);
  const click = async (label) =>
    page.evaluate((l) => {
      const b = Array.from(document.querySelectorAll('button')).find(
        (x) => x.textContent?.trim() === l,
      );
      if (b) b.click();
    }, label);
  // Race past the data-sparse early years (the GDP fleet was tiny in 1979) at
  // 10× into a globally-dense era, then PAUSE and let the tile loader fully
  // settle so the frame isn't a half-loaded seek artifact.
  await click('▶');
  await click('10x');
  await page.waitForTimeout(30000); // ~13 sim-years → ~1992+ (dense fleet)
  await click('⏸');
  await page.waitForTimeout(12000); // let z0 buckets for this instant load
  await page.screenshot({ path: OUT });

  // Sample the whole canvas; classify lit (non-background) pixels by hue.
  result = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { ok: false, reason: 'no canvas' };
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { ok: false, reason: 'no gl' };
    const w = c.width,
      h = c.height;
    const px = new Uint8Array(4 * w * h);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let cool = 0,
      warm = 0,
      mid = 0,
      lit = 0;
    // Background is dark slate (~[36,39,48]); count clearly-lit track pixels.
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i],
        g = px[i + 1],
        b = px[i + 2];
      const bright = r + g + b;
      const bgish =
        Math.abs(r - 36) < 22 && Math.abs(g - 39) < 22 && Math.abs(b - 48) < 22;
      if (bright < 90 || bgish) continue; // skip background / near-black
      lit++;
      if (b > r + 25)
        cool++; // blue-dominant → cold SST
      else if (r > b + 25)
        warm++; // red/orange-dominant → warm SST
      else mid++; // teal/yellow midrange
    }
    return { ok: true, w, h, lit, cool, warm, mid };
  });
} catch (e) {
  result = { ok: false, reason: String(e?.message || e).slice(0, 160) };
}

result.errorCount = errs.length;
result.sampleErrors = errs.slice(0, 5);
result.screenshot = OUT;
result.screenshotBytes = fs.existsSync(OUT) ? fs.statSync(OUT).size : 0;
console.log(JSON.stringify(result, null, 2));
await ctx.close();
await browser.close();
