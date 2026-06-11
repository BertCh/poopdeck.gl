// Real-GPU sanity probe for osm-nyc-draw after the undefined-props fix.
// SwiftShader can't meet the sweep's first-frame budget for this demo once
// the slabs actually render; this checks the demo on the machine's real GL.
import { chromium } from 'playwright';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push(`${e.name}: ${e.message}`));

await page.goto(`${BASE_URL}/demo/osm-nyc-draw`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.locator('.map-viewport').first().waitFor({ state: 'visible', timeout: 30_000 });
await page.waitForTimeout(15_000); // load + consolidate

// Scrub to 60% of the range — cumulative draw should show years of edits.
await page.locator('input[type="range"]').first().evaluate((el) => {
  const input = el;
  const min = Number(input.min);
  const max = Number(input.max);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, String(min + (max - min) * 0.6));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForTimeout(15_000); // stream + absorb the buckets up to 60%
await page.screenshot({ path: 'output/repro-cube/osm-draw-gpu.png' });

// Main-thread responsiveness: a quick evaluate must return promptly.
const t0 = Date.now();
const probe = await page.evaluate(() => {
  const p = globalThis.__sttProbe;
  const snap = p?.snapshot?.() ?? null;
  return snap ? JSON.stringify(snap.snapshots ?? snap).slice(0, 400) : null;
});
console.log('evaluate-latency-ms:', Date.now() - t0);
console.log('errors:', errs.length ? errs.slice(0, 5).join(' | ') : '(none)');
if (probe) console.log('probe:', probe);
await browser.close();
