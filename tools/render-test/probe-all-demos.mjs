// Quick probe: navigate to every dataset, classify rendering result.
// Run with: pnpm --filter @poopdeck.gl/render-test probe   (or node ./probe-all-demos.mjs)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

const BASE_URL = process.env.STT_URL || 'http://localhost:3000';
const OUTPUT = path.resolve('tools/render-test/output/probe');
fs.mkdirSync(OUTPUT, { recursive: true });

// Order matches src/datasets.ts.
const DATASETS = [
  'earthquake-activity',
  'flights',
  'flight-paths',
  'flight-trips',
  'hurricanes',
  'nyc-rideshare',
  'nyc-taxi-paths',
  'nyc-taxi-trips',
  'ship-traffic',
  'wildfires',
  'satellites',
  'satellite-trips-flat',
];

const FATAL = [
  /failed to fetch/i,
  /bad magic/i,
  /404/,
  /unsupported stt format/i,
  /shader/i,
  /webgl/i,
  /typeerror/i,
  /uncaught/i,
];

// Blank-render guard. A blank map keeps the `.map-viewport` element and fires
// no console error, so the ok/errors classification above cannot see it. We
// decode the captured PNG, find the dominant (background) color via a coarse
// 4-bit-per-channel histogram, then count pixels that differ from it by more
// than `COLOR_TOL` per channel. If the non-background fraction is below
// `MIN_NONBG_FRACTION` the canvas is effectively a single flat color and we
// treat the demo as failed.
//
// The threshold is deliberately tiny (0.5%): a legitimately sparse demo (a
// handful of points on an otherwise empty basemap) still paints far more than
// 0.5% non-background pixels once labels, attribution, panels and controls are
// counted, while a truly blank WebGL canvas paints ~0%. Keeping it this low
// avoids false positives on sparse-but-valid renders.
const MIN_NONBG_FRACTION = 0.005;
const COLOR_TOL = 12; // per-channel tolerance when matching the background color

function nonBackgroundFraction(pngBuffer) {
  const img = PNG.sync.read(pngBuffer);
  const { data, width, height } = img;
  const total = width * height;
  if (total === 0) return 0;

  // Coarse histogram: quantize each channel to 4 bits (16 buckets) to find the
  // modal color cheaply, ignoring anti-aliasing noise.
  const hist = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const key =
      ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    hist.set(key, (hist.get(key) || 0) + 1);
  }
  let bgKey = 0;
  let bgCount = -1;
  for (const [key, count] of hist) {
    if (count > bgCount) {
      bgCount = count;
      bgKey = key;
    }
  }
  // Representative background color: center of the modal bucket.
  const bgR = ((bgKey >> 8) & 0xf) * 16 + 8;
  const bgG = ((bgKey >> 4) & 0xf) * 16 + 8;
  const bgB = (bgKey & 0xf) * 16 + 8;

  let nonBg = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (
      Math.abs(data[i] - bgR) > COLOR_TOL ||
      Math.abs(data[i + 1] - bgG) > COLOR_TOL ||
      Math.abs(data[i + 2] - bgB) > COLOR_TOL
    ) {
      nonBg++;
    }
  }
  return nonBg / total;
}

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

const results = [];
for (const id of DATASETS) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(`${err.name}: ${err.message}`));

  const url = `${BASE_URL}/demo/${id}`;
  let status = 'ok';
  let note = '';
  let nonBgFraction = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .locator('.map-viewport')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    // Give tiles a chance to load and render.
    await page.waitForTimeout(8000);
    const shot = await page.screenshot({
      path: path.join(OUTPUT, `${id}.png`),
      fullPage: false,
    });
    // Blank-render check on the captured frame.
    try {
      nonBgFraction = nonBackgroundFraction(shot);
      if (nonBgFraction < MIN_NONBG_FRACTION) {
        status = 'blank';
        note = `blank render: only ${(nonBgFraction * 100).toFixed(3)}% non-background pixels (< ${(MIN_NONBG_FRACTION * 100).toFixed(1)}%)`;
      }
    } catch (imgErr) {
      // Decoding failure shouldn't mask a real render; flag it loudly.
      status = 'errors';
      note = `screenshot decode failed: ${String(imgErr?.message || imgErr).slice(0, 160)}`;
    }
  } catch (e) {
    status = 'nav-fail';
    note = String(e?.message || e).slice(0, 200);
  }

  const fatal = [...consoleErrors, ...pageErrors].filter((e) =>
    FATAL.some((p) => p.test(e)),
  );
  if (fatal.length) status = 'errors';

  results.push({
    id,
    status,
    note,
    nonBgFraction,
    fatalCount: fatal.length,
    fatalSample: fatal.slice(0, 3),
    consoleErrors: consoleErrors.length,
    pageErrors: pageErrors.length,
  });

  await ctx.close();
}

await browser.close();
console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(
  path.join(OUTPUT, 'summary.json'),
  JSON.stringify(results, null, 2),
);

// Fail-closed: any demo that failed to navigate, errored, or rendered blank
// must fail the CI gate. Previously this script always exited 0, so the
// "Showcase (all demos load)" job could never catch a regression.
const FAILING = new Set(['nav-fail', 'errors', 'blank']);
const failed = results.filter((r) => FAILING.has(r.status));
if (failed.length) {
  console.error(
    `\nFAIL: ${failed.length}/${results.length} demo(s) did not render cleanly:`,
  );
  for (const r of failed) {
    console.error(`  - ${r.id}: ${r.status}${r.note ? ` — ${r.note}` : ''}`);
  }
  process.exitCode = 1;
} else {
  console.error(`\nPASS: all ${results.length} demos rendered cleanly.`);
}
