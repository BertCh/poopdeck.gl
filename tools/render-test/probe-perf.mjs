// Targeted perf probe for the ship-traffic dataset.
// Captures: console errors, whether the worker decoder spun up, how many tiles
// are loaded, and where main-thread time is spent during a 6-second playback
// window.
// Run with: node tools/render-test/probe-perf.mjs

import { chromium } from 'playwright';

const URL = process.env.STT_URL || 'http://localhost:3000/demo/ship-traffic';

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
});

const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});

// Install BEFORE navigation so we capture workers created during page init,
// including the WorkerTileDecoder pool spun up when STTArchive first decodes.
await ctx.addInitScript(() => {
  // @ts-ignore
  window.__sttProbe = {
    workerUrls: [],
    rafTimes: [],
    longTasks: [],
  };
  const origWorker = window.Worker;
  // @ts-ignore
  const Wrapped = function (url, opts) {
    // @ts-ignore
    window.__sttProbe.workerUrls.push(String(url));
    return new origWorker(url, opts);
  };
  Wrapped.prototype = origWorker.prototype;
  // @ts-ignore
  window.Worker = Wrapped;

  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // @ts-ignore
        window.__sttProbe.longTasks.push({
          duration: e.duration,
          start: e.startTime,
        });
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {}
});

const page = await ctx.newPage();

const consoleLines = [];
page.on('console', (msg) => {
  consoleLines.push(`[${msg.type()}] ${msg.text()}`);
});
page.on('pageerror', (e) => {
  consoleLines.push(`[pageerror] ${e.message}`);
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Wait for canvas
await page.waitForSelector('canvas', { timeout: 60_000 });
await page.waitForTimeout(3000); // initial paint

// Toggle: PLAY=1 hits play, otherwise just waits for tiles to load and
// measures static-scene FPS. Use the PLAY env var to compare playback vs
// paused-scene cost.
const PLAY = process.env.PLAY === '1';
if (PLAY) {
  const play = page
    .locator('button')
    .filter({ hasText: /^[▶⏸]$/ })
    .first();
  const glyph = (await play.innerText()).trim();
  if (glyph === '▶') await play.click();
}

// Let tiles stream in before we sample (gives the scene a chance to settle
// when we're measuring paused FPS).
await page.waitForTimeout(5000);

// Sample for 6 seconds while watching rAF cadence + long tasks
const sample = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const start = performance.now();
  let last = start;
  // @ts-ignore
  window.__sttProbe.rafTimes = [];
  return new Promise((resolve) => {
    function tick(now) {
      // @ts-ignore
      window.__sttProbe.rafTimes.push(now - last);
      last = now;
      if (now - start < 6000) {
        requestAnimationFrame(tick);
      } else {
        resolve({
          // @ts-ignore
          workerUrls: window.__sttProbe.workerUrls,
          // @ts-ignore
          rafFrames: window.__sttProbe.rafTimes.length,
          // @ts-ignore
          rafTimes: window.__sttProbe.rafTimes,
          // @ts-ignore
          longTasks: window.__sttProbe.longTasks,
          // @ts-ignore
          consolidations: window.__sttProbe.consolidations || [],
        });
      }
    }
    requestAnimationFrame(tick);
  });
});

console.log('--- console (filtered) ---');
for (const line of consoleLines) {
  if (/worker|error|warn|tile-decoder|stt\]/i.test(line)) console.log(line);
}

console.log('\n--- summary ---');
console.log(`Workers created (${sample.workerUrls.length} total):`);
for (const u of sample.workerUrls) {
  console.log(`  ${u}`);
}
console.log(
  `rAF frames in 6s: ${sample.rafFrames}  (fps=${(sample.rafFrames / 6).toFixed(2)})`,
);

const sorted = [...sample.rafTimes].sort((a, b) => a - b);
const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
const max = sorted[sorted.length - 1] || 0;
console.log(
  `rAF frame time  p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
);

console.log(`\nLong tasks (>50ms): ${sample.longTasks.length}`);
const topTasks = [...sample.longTasks]
  .sort((a, b) => b.duration - a.duration)
  .slice(0, 8);
for (const t of topTasks) {
  console.log(`  ${t.duration.toFixed(0)}ms at t=${t.start.toFixed(0)}`);
}

console.log(`\nConsolidations recorded: ${sample.consolidations.length}`);
const topCons = [...sample.consolidations]
  .sort((a, b) => b.ms - a.ms)
  .slice(0, 8);
for (const c of topCons) {
  console.log(
    `  tiles=${c.tiles}  features=${c.features}  ms=${c.ms.toFixed(0)}`,
  );
}

await browser.close();
