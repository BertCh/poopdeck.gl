// Quick probe: navigate to every dataset, classify rendering result.
// Run with: pnpm --filter @poopdeck.gl/render-test probe   (or node ./probe-all-demos.mjs)
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

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
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page
      .locator('.map-viewport')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
    // Give tiles a chance to load and render.
    await page.waitForTimeout(8000);
    await page.screenshot({
      path: path.join(OUTPUT, `${id}.png`),
      fullPage: false,
    });
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
