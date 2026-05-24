import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[perf]') || t.startsWith('[STL]') || t.includes('Error')) {
    logs.push(t);
  }
});

// Inject perf instrumentation before page load
await page.addInitScript(() => {
  // Hook deck.gl's animation frame to count FPS
  let frameCount = 0;
  let lastReport = performance.now();
  const origRAF = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    return origRAF.call(window, (t) => {
      frameCount++;
      const now = performance.now();
      if (now - lastReport >= 1000) {
        console.log(`[perf] FPS=${frameCount} (${(now - lastReport).toFixed(0)}ms)`);
        frameCount = 0;
        lastReport = now;
      }
      cb(t);
    });
  };
});

await page.goto('http://localhost:3000/demo/earthquake-activity', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

// Capture baseline (paused, no panning)
logs.length = 0;
console.log('=== PAUSED, IDLE (3s) ===');
await page.waitForTimeout(3000);
console.log(logs.filter((l) => l.startsWith('[perf]')).slice(-3).join('\n'));

// Capture pan while paused
logs.length = 0;
console.log('\n=== PAUSED, PANNING (3s) ===');
const canvas = page.locator('canvas').first();
const box = await canvas.boundingBox();
const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
const panStart = Date.now();
(async () => {
  while (Date.now() - panStart < 3000) {
    await page.mouse.move(cx - 50, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 50, cy, { steps: 10 });
    await page.mouse.up();
  }
})();
await page.waitForTimeout(3100);
console.log(logs.filter((l) => l.startsWith('[perf]')).slice(-3).join('\n'));

// Start playback
logs.length = 0;
console.log('\n=== PLAYING (3s) ===');
const playBtn = page.locator('button').filter({ hasText: /play|▶/i }).first();
if (await playBtn.count()) {
  await playBtn.click();
}
await page.waitForTimeout(3000);
console.log(logs.filter((l) => l.startsWith('[perf]')).slice(-3).join('\n'));

// Now profile what's slow during playback - capture long tasks
logs.length = 0;
console.log('\n=== PLAYING + LONGTASKS (3s) ===');
await page.evaluate(() => {
  const obs = new PerformanceObserver((list) => {
    const tasks = list.getEntries().filter((e) => e.duration > 20);
    for (const t of tasks) {
      console.log(`[perf] longtask: ${t.duration.toFixed(1)}ms`);
    }
  });
  obs.observe({ entryTypes: ['longtask'] });
});
await page.waitForTimeout(3000);
console.log(logs.filter((l) => l.includes('longtask')).slice(0, 20).join('\n'));

await ctx.close();
await browser.close();
