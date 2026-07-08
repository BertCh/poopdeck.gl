// Repro probe for the cube-demo t75 blank-points regression found by the sweep.
// Scenario A: fresh page, scrub straight to 75%.
// Scenario B: fresh page, sweep sequence (scrub 25% -> play 5s -> pause -> scrub 75%).
// Usage: node _repro-cube-t75.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve(process.cwd(), 'output/repro-cube');
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

async function setRange(page, value) {
  await page
    .locator('input[type="range"]')
    .first()
    .evaluate((el, v) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(el, String(v));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, value);
}

async function bounds(page) {
  return page
    .locator('input[type="range"]')
    .first()
    .evaluate((el) => ({
      min: Number(el.min),
      max: Number(el.max),
    }));
}

async function clickPlay(page) {
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => x.textContent && /^[▶⏸]$/.test(x.textContent.trim()),
    );
    if (b) b.click();
  });
}

async function run(label, steps) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warning')
      logs.push(`[console.${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) =>
    logs.push(`[pageerror] ${e.name}: ${e.message}\n${e.stack || ''}`),
  );
  await page.goto(`${BASE_URL}/demo/nyc-taxi-cube`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page
    .locator('.map-viewport')
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForTimeout(8000); // warmup, mirror sweep
  await steps(page);
  await page.screenshot({ path: path.join(OUTPUT, `${label}.png`) });
  // Dump any probe/tileset state exposed on window.
  const probe = await page
    .evaluate(() => {
      const p = globalThis.__sttProbe;
      if (!p) return null;
      try {
        return JSON.parse(JSON.stringify(p.snapshot?.() ?? p));
      } catch {
        return String(p);
      }
    })
    .catch(() => null);
  console.log(`=== ${label} ===`);
  console.log('console/page errors+warnings:', logs.length ? '' : '(none)');
  for (const l of logs.slice(0, 30)) console.log(' ', l.slice(0, 400));
  if (probe) console.log('probe:', JSON.stringify(probe).slice(0, 600));
  await ctx.close();
}

await run('A-straight-to-75', async (page) => {
  const b = await bounds(page);
  await setRange(page, b.min + (b.max - b.min) * 0.75);
  await page.waitForTimeout(12_000);
});

await run('B-sweep-sequence', async (page) => {
  const b = await bounds(page);
  await setRange(page, b.min + (b.max - b.min) * 0.25);
  await page.waitForTimeout(5000);
  await clickPlay(page); // play
  await page.waitForTimeout(5000);
  await clickPlay(page); // pause
  await setRange(page, b.min + (b.max - b.min) * 0.75);
  await page.waitForTimeout(12_000);
});

await browser.close();
