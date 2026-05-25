// Throwaway probe: compare nyc-taxi-trips (now on VAT-trail backend) vs
// nyc-taxi-vat (head-dot baseline). Captures: console errors, rAF FPS over
// a 6s sample with playback on.
import { chromium } from '/Users/robertchristie/Documents/GitHub/spatiotemporal-tiles/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs';

const DEMOS = [
  ['nyc-taxi-trips', 'http://localhost:3000/demo/nyc-taxi-trips'],
  ['nyc-taxi-vat', 'http://localhost:3000/demo/nyc-taxi-vat'],
];

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

async function probe(name, url) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  const warns = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if (msg.type() === 'error') errors.push(t);
    if (msg.type() === 'warning') warns.push(t);
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await page.waitForTimeout(3000);

  const play = page.locator('button').filter({ hasText: /^[▶⏸]$/ }).first();
  try {
    const glyph = (await play.innerText()).trim();
    if (glyph === '▶') await play.click();
  } catch {}

  await page.waitForTimeout(5000);

  const sample = await page.evaluate(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    const start = performance.now();
    let last = start;
    const times = [];
    return new Promise((resolve) => {
      function tick(now) {
        times.push(now - last);
        last = now;
        if (now - start < 6000) requestAnimationFrame(tick);
        else resolve({ frames: times.length, times });
      }
      requestAnimationFrame(tick);
    });
  });

  const screenshotPath = `/tmp/vat-trail-${name}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });

  const sorted = [...sample.times].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const max = sorted[sorted.length - 1] || 0;
  const fps = sample.frames / 6;

  await ctx.close();
  return { name, url, fps, p50, p95, max, errors, warns, screenshotPath };
}

const results = [];
for (const [name, url] of DEMOS) {
  console.log(`\n=== ${name} ===`);
  const r = await probe(name, url);
  results.push(r);
  console.log(`fps=${r.fps.toFixed(1)}  p50=${r.p50.toFixed(1)}ms  p95=${r.p95.toFixed(1)}ms  max=${r.max.toFixed(1)}ms`);
  console.log(`screenshot=${r.screenshotPath}`);
  if (r.errors.length) {
    console.log(`ERRORS (${r.errors.length}):`);
    for (const e of r.errors.slice(0, 15)) console.log('  ' + e);
  }
  const sigWarns = r.warns.filter((w) =>
    /shader|webgl|link|compile|texture|attribute/i.test(w),
  );
  if (sigWarns.length) {
    console.log(`shader/gl warns (${sigWarns.length}):`);
    for (const w of sigWarns.slice(0, 8)) console.log('  ' + w);
  }
}

await browser.close();

console.log('\n=== summary ===');
for (const r of results) {
  console.log(`${r.name.padEnd(20)} fps=${r.fps.toFixed(1).padStart(6)}  p95=${r.p95.toFixed(1)}ms  errors=${r.errors.length}`);
}
