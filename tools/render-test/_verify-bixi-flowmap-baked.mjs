// Browser verification for the BIXI BAKED edge-bundling demo
// (BundledFlowmapLayer with preBundled:true — geometry bundled at build time).
// Loads /demo/bixi-flowmap-baked, confirms the WebGL canvas draws the bundled
// rivers, samples across playback to prove the matrix WIDTH animation changes the
// render (the geometry is static), tracks dataset fetches (load-once), and reports
// console errors. Unlike the live-bundled demo there is NO settling animation:
// the first lit frame is already the final bundle.
// Run with the showcase dev server up:
//   STT_BASE_URL=http://localhost:3001 node _verify-bixi-flowmap-baked.mjs
import { chromium } from 'playwright';

const BASE = process.env.STT_BASE_URL ?? 'http://localhost:3001';
const OUT = 'output/bixi-flowmap-baked-verify';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 400));
});
page.on('pageerror', (e) =>
  errors.push(`PAGEERROR ${String(e).slice(0, 400)}`),
);

// Track dataset asset fetches (manifest / index pages / packs).
const dataReqs = new Map();
page.on('response', (r) => {
  const u = r.url();
  if (u.includes('/data/bixi-flowmap-baked/')) {
    const key = u.split('/data/bixi-flowmap-baked/')[1].split('?')[0];
    dataReqs.set(key, (dataReqs.get(key) ?? 0) + 1);
  }
});

const sampleCanvas = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { canvas: false };
    const w = c.width,
      h = c.height;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { canvas: true, gl: false };
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let lit = 0;
    let hash = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] > 16 && (px[i] > 24 || px[i + 1] > 24 || px[i + 2] > 24)) {
        lit++;
        hash = (hash + i * 2654435761) % 4294967296;
      }
    }
    return {
      canvas: true,
      gl: true,
      litPct: +((lit / (w * h)) * 100).toFixed(3),
      hash,
    };
  });

console.log(`→ ${BASE}/demo/bixi-flowmap-baked`);
await page.goto(`${BASE}/demo/bixi-flowmap-baked`, {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(9000); // load tiles

// A baked bundle is final on load (no GPU relaxation frames). Capture before play.
const onLoad = await sampleCanvas();
await page.screenshot({ path: `${OUT}/onload.png` });
console.log(`onload: ${JSON.stringify(onLoad)}`);

// Demos do not autoplay — start playback so the matrix WIDTH animation advances.
await page.mouse.click(720, 450);
await page.keyboard.press('k');
await page.waitForTimeout(2000); // let the playhead leave bucket 0

const samples = [];
for (let i = 0; i < 4; i++) {
  const s = await sampleCanvas();
  samples.push(s);
  await page.screenshot({ path: `${OUT}/frame-${i}.png` });
  console.log(`frame ${i}: ${JSON.stringify(s)}`);
  await page.waitForTimeout(2500); // let the playhead advance a few buckets
}

const lit = samples.map((s) => s.litPct ?? 0);
const hashes = new Set(samples.map((s) => s.hash));
const rendered = (onLoad.litPct ?? 0) > 0.05 && lit.some((p) => p > 0.05);
const animated = hashes.size > 1; // frames differ → matrix width animation is live

console.log('\n=== dataset fetches (key → count) ===');
for (const [k, n] of [...dataReqs.entries()].sort())
  console.log(`  ${n}×  ${k}`);
const packFetches = [...dataReqs.entries()].filter(([k]) =>
  k.includes('packs/'),
);
const loadOnce = packFetches.every(([, n]) => n === 1);

console.log('\n=== console errors ===');
if (errors.length === 0) console.log('  (none)');
for (const e of errors) console.log(`  ${e}`);

console.log('\n=== verdict ===');
console.log(
  `  rendered (lit on load + during play): ${rendered}  [onload ${onLoad.litPct}, play ${lit.join(', ')}]`,
);
console.log(
  `  animated (frames differ): ${animated}  [${hashes.size} distinct of ${samples.length}]`,
);
console.log(`  load-once (each pack fetched 1×): ${loadOnce}`);
console.log(`  console errors: ${errors.length}`);
const ok = rendered && animated && loadOnce && errors.length === 0;
console.log(`\n  ${ok ? 'PASS ✅' : 'FAIL ❌'}`);

await browser.close();
process.exit(ok ? 0 : 1);
