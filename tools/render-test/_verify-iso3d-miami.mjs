// Correctness-only regression check for the HD Miami iso-3D bundle
// (/drive/argoverse-02a00399-iso3d). NOT an aesthetic judgement — it only asserts
// PASS/FAIL: (a) the iso-lines actually render (non-black pixels) and (b) no GL
// "Vertex buffer is not big enough" / draw errors fire (the AnimatedPathLayer
// overflow the HD contour count could trip). Mirrors _repro-iso.mjs.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const SCENE = process.env.SCENE || 'argoverse-02a00399-iso3d';
const OUTPUT = path.resolve(process.cwd(), 'output/verify-iso3d-miami');
fs.mkdirSync(OUTPUT, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl',
    '--ignore-gpu-blocklist', '--disable-gpu-sandbox', '--disable-dev-shm-usage', '--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const logs = [];
page.on('console', (m) => {
  const t = m.type();
  if (t === 'error' || t === 'warning') logs.push(`[${t}] ${m.text()}`);
});
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.name}: ${e.message}`));

await page.goto(`${BASE_URL}/drive/${SCENE}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(3500);
// start playback so windows advance and tiles stream
await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button'))
    .find((x) => x.textContent && /^[▶⏸]$/.test(x.textContent.trim()));
  if (b) b.click();
});
await page.waitForTimeout(12000);
await page.screenshot({ path: path.join(OUTPUT, 'iso3d.png') });

const px = await page.evaluate(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const gl = c.getContext('webgl2') || c.getContext('webgl');
  if (!gl) return { note: 'no gl ctx' };
  const w = c.width, h = c.height;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
  let nonblack = 0;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] > 14 || buf[i + 1] > 14 || buf[i + 2] > 14) nonblack++;
  }
  return { w, h, nonblackPct: +(100 * nonblack / (w * h)).toFixed(2) };
});

const glErrs = logs.filter((l) => /vertex buffer|INVALID_OPERATION|drawElements|not big enough/i.test(l));
console.log(`=== /drive/${SCENE} (HD iso-3D) ===`);
console.log('pixels:', JSON.stringify(px));
console.log('total console errors/warnings:', logs.length);
console.log('GL draw errors:', glErrs.length);
for (const l of glErrs.slice(0, 6)) console.log('  ', l.slice(0, 300));
console.log('--- first 10 errors/warnings ---');
for (const l of logs.slice(0, 10)) console.log('  ', l.slice(0, 220));

const renders = px && px.nonblackPct != null && px.nonblackPct > 1.0;
const clean = glErrs.length === 0;
console.log(`\nRESULT: renders=${renders} (${px && px.nonblackPct}%), noGlDrawErrors=${clean}`);
console.log(renders && clean ? 'VERIFY: PASS' : 'VERIFY: FAIL');

await ctx.close();
await browser.close();
process.exit(renders && clean ? 0 : 1);
