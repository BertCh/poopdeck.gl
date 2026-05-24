// FPS perf probe for nyc-taxi-od-heatmap (and a baseline for comparison).
// Run: node tools/render-test/probe-od-heatmap-perf.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve('tools/render-test/output/od-heatmap-perf');
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

/** Measure FPS over `durationMs` of animation. Returns mean + p5/p50/p95 of
 *  per-second FPS samples. */
async function measure(demoId, durationMs) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 150)); });

  const url = `${BASE_URL}/demo/${demoId}`;
  console.log(`\n=== ${demoId} ===`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.map-viewport').first().waitFor({ state: 'visible', timeout: 30_000 });
  // Wait for tile loads.
  await page.waitForTimeout(10_000);

  // Click play.
  const playBtn = page.locator('button:has-text("▶")').first();
  if (await playBtn.count() > 0) {
    await playBtn.click();
  }
  // Let animation warm up.
  await page.waitForTimeout(2_000);

  // Sample FPS bucketed per-second in the page context.
  const samples = await page.evaluate((dur) => new Promise((resolve) => {
    const buckets = [];
    let bucketStart = performance.now();
    let bucketCount = 0;
    const start = bucketStart;
    function tick() {
      const now = performance.now();
      bucketCount++;
      if (now - bucketStart >= 1000) {
        buckets.push(bucketCount * 1000 / (now - bucketStart));
        bucketStart = now;
        bucketCount = 0;
      }
      if (now - start < dur) requestAnimationFrame(tick);
      else resolve(buckets);
    }
    requestAnimationFrame(tick);
  }), durationMs);

  samples.sort((a, b) => a - b);
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p = (q) => samples[Math.floor(samples.length * q)];
  const stats = {
    demoId,
    samples: samples.length,
    mean: +mean.toFixed(1),
    p5: +p(0.05).toFixed(1),
    p50: +p(0.5).toFixed(1),
    p95: +p(0.95).toFixed(1),
    min: +samples[0].toFixed(1),
    max: +samples[samples.length - 1].toFixed(1),
    perFrameSamples: samples.map((v) => +v.toFixed(1)),
    consoleErrorCount: errs.length,
    consoleErrorSample: errs.slice(0, 5),
  };
  console.log(JSON.stringify(stats, null, 2));
  await ctx.close();
  return stats;
}

const DURATION_MS = 8_000;
const results = {
  // Baseline: single-layer point demo on the same source archive.
  baseline_nyc_rideshare: await measure('nyc-rideshare', DURATION_MS),
  // Target: dual heatmap.
  od_heatmap: await measure('nyc-taxi-od-heatmap', DURATION_MS),
};

fs.writeFileSync(path.join(OUTPUT, 'fps-report.json'), JSON.stringify(results, null, 2));
console.log('\n=== SUMMARY ===');
for (const [k, r] of Object.entries(results)) {
  console.log(`${k}: mean=${r.mean} p50=${r.p50} p5=${r.p5} (${r.samples} 1s buckets)`);
}

await browser.close();
