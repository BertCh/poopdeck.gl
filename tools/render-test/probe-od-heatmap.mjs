// Drive the new nyc-taxi-od-heatmap demo and capture screenshots.
// Run: node tools/render-test/probe-od-heatmap.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve('tools/render-test/output/od-heatmap');
fs.mkdirSync(OUTPUT, { recursive: true });

const FATAL = [
  /failed to fetch/i,
  /bad magic/i,
  /unsupported stt format/i,
  /shader/i,
  /webgl/i,
  /typeerror/i,
  /uncaught/i,
];

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

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const consoleErrors = [];
const pageErrors = [];
const allConsole = [];
page.on('console', (msg) => {
  allConsole.push(`[${msg.type()}] ${msg.text()}`);
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

const url = `${BASE_URL}/demo/nyc-taxi-od-heatmap`;
console.log(`→ navigating to ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('.map-viewport').first().waitFor({ state: 'visible', timeout: 30_000 });

// Let tiles load.
console.log('… waiting for tile loads');
await page.waitForTimeout(10_000);

await page.screenshot({ path: path.join(OUTPUT, '01-initial.png'), fullPage: false });
console.log('✓ wrote 01-initial.png');

// Sample some pixels from the canvas to verify both layers are contributing color.
const colorSample = await page.evaluate(() => {
  const canvases = Array.from(document.querySelectorAll('.map-viewport canvas'));
  const dc = canvases.find((c) => !(c.className || '').includes('mapboxgl-canvas'));
  if (!dc) return { ok: false, reason: 'no-canvas' };
  // deck.gl uses preserveDrawingBuffer=false → readPixels via gl, not 2d ctx.
  const gl = dc.getContext('webgl2') || dc.getContext('webgl');
  if (!gl) return { ok: false, reason: 'no-gl' };
  const w = dc.width, h = dc.height;
  // Force a redraw flush.
  const pixels = new Uint8Array(w * h * 4);
  try {
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  } catch (e) {
    return { ok: false, reason: `readPixels failed: ${e.message}` };
  }
  let greenish = 0, reddish = 0, opaque = 0, samples = 0;
  // Sample every 200th pixel
  for (let i = 0; i < pixels.length; i += 4 * 200) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (a === 0) continue;
    samples++;
    opaque++;
    if (g > r + 15 && g > b + 5) greenish++;
    if (r > g + 25 && r > b + 5) reddish++;
  }
  return { ok: true, samples, greenish, reddish, opaque, w, h };
});
console.log('pixel sample:', colorSample);

// Find and click the play button — TimeControls has an aria-label or icon.
// Try several known patterns.
const playSelectors = [
  'button[aria-label="Play"]',
  'button:has-text("▶")',
  'button:has-text("Play")',
  '[data-testid="play-button"]',
];
let played = false;
for (const sel of playSelectors) {
  const loc = page.locator(sel).first();
  if (await loc.count() > 0) {
    await loc.click().catch(() => {});
    played = true;
    console.log(`✓ clicked ${sel}`);
    break;
  }
}
if (!played) console.log('⚠ could not find play button; sampling without animation');

await page.waitForTimeout(4000);
await page.screenshot({ path: path.join(OUTPUT, '02-mid-animation.png'), fullPage: false });
console.log('✓ wrote 02-mid-animation.png');

const fatal = [...consoleErrors, ...pageErrors].filter((e) => FATAL.some((p) => p.test(e)));
const report = {
  url,
  consoleErrorCount: consoleErrors.length,
  pageErrorCount: pageErrors.length,
  fatalCount: fatal.length,
  fatalSample: fatal.slice(0, 5),
  consoleErrorSample: consoleErrors.slice(0, 5),
  pageErrorSample: pageErrors.slice(0, 5),
  colorSample,
};
fs.writeFileSync(path.join(OUTPUT, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(OUTPUT, 'console.log'), allConsole.join('\n'));
console.log('\n=== REPORT ===');
console.log(JSON.stringify(report, null, 2));

await browser.close();
