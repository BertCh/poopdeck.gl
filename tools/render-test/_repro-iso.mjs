// Repro: GL "Vertex buffer is not big enough" on /drive/waymo-sf-day-iso (the
// density iso-line render mode). Captures console GL errors, screenshots whether
// contours render, and dumps deck's AnimatedPathLayer sublayer model instance
// counts vs attribute buffer sizes to locate the overflow.
// Usage: node _repro-iso.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve(process.cwd(), 'output/repro-iso');
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
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.name}: ${e.message}`));

await page.goto(`${BASE_URL}/drive/waymo-sf-day-iso`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(3000);
// start playback so windows advance
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find(
    (x) => x.textContent && /^[▶⏸]$/.test(x.textContent.trim()),
  );
  if (b) b.click();
});
await page.waitForTimeout(9000);
await page.screenshot({ path: path.join(OUTPUT, 'iso.png') });

// Crude non-black pixel ratio (did anything render?)
const px = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { note: 'no gl ctx' };
  const w = c.width,
    h = c.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let nonblack = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] > 14 || buf[i + 1] > 14 || buf[i + 2] > 14) nonblack++;
  }
  return { w, h, nonblackPct: +((100 * nonblack) / (w * h)).toFixed(2) };
});

const glErrs = logs.filter((l) =>
  /vertex buffer|INVALID_OPERATION|drawElements/i.test(l),
);
console.log('=== /drive/waymo-sf-day-iso ===');
console.log('pixels:', JSON.stringify(px));
console.log('total console errors/warnings:', logs.length);
console.log('GL draw errors:', glErrs.length);
for (const l of glErrs.slice(0, 6)) console.log('  ', l.slice(0, 300));
console.log('--- first 12 errors/warnings ---');
for (const l of logs.slice(0, 12)) console.log('  ', l.slice(0, 220));

await ctx.close();
await browser.close();
