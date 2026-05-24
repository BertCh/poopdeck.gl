import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[PERF]') || t.startsWith('[LT]')) logs.push(t);
});

await page.addInitScript(() => {
  // Capture every longtask with its start time
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration > 16) console.log(`[LT] ${e.duration.toFixed(1)}ms @ ${e.startTime.toFixed(0)}`);
    }
  });
  obs.observe({ entryTypes: ['longtask'] });
});

await page.goto('http://localhost:3000/demo/earthquake-activity', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);

const playBtn = page.locator('button').filter({ hasText: /play|▶/i }).first();
if (await playBtn.count()) {
  await playBtn.click();
}
console.log('=== 5s playback ===');
await page.waitForTimeout(5000);

// Sort logs by approximate time
console.log(`\nTotal events: ${logs.length}`);
const longtasks = logs.filter((l) => l.startsWith('[LT]'));
const renders = logs.filter((l) => l.startsWith('[PERF] renderLayers'));
const sumLT = longtasks.reduce((s, l) => s + parseFloat(l.match(/(\d+\.\d+)ms/)[1]), 0);
const sumR = renders.reduce((s, l) => s + parseFloat(l.match(/(\d+\.\d+)ms/)[1]), 0);
console.log(`Longtasks: ${longtasks.length}, total ${sumLT.toFixed(0)}ms`);
console.log(`renderLayers calls: ${renders.length}, total ${sumR.toFixed(0)}ms`);

console.log('\nLast 20 events (chronological):');
console.log(logs.slice(-30).join('\n'));

await ctx.close();
await browser.close();
