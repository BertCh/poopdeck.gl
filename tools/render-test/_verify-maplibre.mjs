// Verify the maplibre renderer surface: /maplibre/:id mounts the @stt/maplibre
// adapter, tiles load, and playback paints moving features.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.STT_URL || 'http://localhost:3000';
const ID = process.argv[2] || 'nyc-taxi-points';
const OUT = path.resolve(process.cwd(), 'output/verify-seams');
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.name}: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console.error] ${m.text().slice(0, 200)}`); });

await page.goto(`${BASE}/maplibre/${ID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('canvas').first().waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(12_000); // basemap + tile load

const litStats = () => page.evaluate(() => {
  // The maplibre canvas composites basemap + STT custom layer.
  const c = document.querySelector('.maplibregl-map canvas');
  if (!c) return { reason: 'no maplibre canvas' };
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { reason: 'no gl' };
  const w = c.width, h = c.height;
  const buf = new Uint8Array(4 * w * h);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let lit = 0, sum = 0;
  for (let i = 0; i < buf.length; i += 4) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    // STT point default is bright cyan (0.12,0.73,0.84): count saturated
    // non-basemap pixels (carto dark-matter is near-greyscale).
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 90 && max - min > 50) { lit++; sum += max; }
  }
  return { w, h, lit, meanMax: lit ? Math.round(sum / lit) : 0 };
});

const before = await litStats();
const shot1 = path.join(OUT, `maplibre-${ID}-t0.png`);
await page.screenshot({ path: shot1 });

// Play ~10s and confirm the picture changes (time forwarding works).
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => /^[▶]$/.test(x.textContent?.trim() ?? ''));
  if (b) b.click();
});
await page.waitForTimeout(10_000);
const after = await litStats();
const shot2 = path.join(OUT, `maplibre-${ID}-t1.png`);
await page.screenshot({ path: shot2 });

console.log(JSON.stringify({
  id: ID, before, after,
  litChanged: before.lit !== after.lit,
  screenshots: [shot1, shot2],
  pageErrors: errs.slice(0, 8),
  pass: (before.lit > 50 || after.lit > 50) && errs.filter((e) => e.startsWith('[pageerror]')).length === 0,
}, null, 2));
await ctx.close();
await browser.close();
