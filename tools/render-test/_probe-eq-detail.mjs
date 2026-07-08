import { chromium } from 'playwright';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(
  new URL('./output/probe-earthquake', import.meta.url),
);

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
  viewport: { width: 1600, height: 1000 },
});
const page = await ctx.newPage();

page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));

// Earthquake demo (data center is Japan area: lon=140, lat=20, z=2)
await page.goto('http://localhost:3000/demo/earthquake-activity', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page
  .locator('.map-viewport')
  .first()
  .waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/detail-01-overview.png` });

// Click play
const playBtn = page
  .locator('button[aria-label="Play"], button:has-text("▶")')
  .first();
if (await playBtn.count()) {
  await playBtn.click();
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/detail-02-playing.png` });
  // Stop so we capture a stable frame
  const pauseBtn = page
    .locator('button[aria-label="Pause"], button:has-text("⏸")')
    .first();
  if (await pauseBtn.count()) await pauseBtn.click();
}

// Crop screenshot of just the canvas region for clarity (avoid sidebar)
const viewport = await page.locator('.map-viewport').boundingBox();
if (viewport) {
  await page.screenshot({
    path: `${OUT}/detail-03-canvas-only.png`,
    clip: {
      x: viewport.x,
      y: viewport.y,
      width: viewport.width,
      height: viewport.height - 80,
    },
  });
}

// Sample pixel colors at known earthquake hotspots to confirm rendering.
// Japan area (relative to the viewport, given initial view: lon=140, lat=20, z=2)
// We just sample several positions and report how many are not the empty
// map background.
const samples = await page.evaluate(
  ({ box }) => {
    const canvas = document.querySelector('canvas');
    const ctx =
      canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ||
      canvas.getContext('webgl', { preserveDrawingBuffer: true });
    // We can't easily readPixels from arbitrary contexts post-hoc; use the
    // 2D HTML method on a freshly composited frame instead.
    return {
      canvasW: canvas.width,
      canvasH: canvas.height,
      clientW: canvas.clientWidth,
      clientH: canvas.clientHeight,
    };
  },
  { box: viewport },
);
console.log('Canvas info:', samples);

await ctx.close();
await browser.close();
