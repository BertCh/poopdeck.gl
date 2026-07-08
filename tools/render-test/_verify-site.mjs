// One-off verification sweep for the showcase+docs site restructure.
// Visits each new surface, captures console errors and a screenshot.
import { chromium } from 'playwright';

const BASE = process.env.STT_BASE_URL ?? 'http://localhost:3000';
const OUT = 'output/site-verify';

const PAGES = [
  { name: 'home', path: '/', wait: 4000 },
  { name: 'demos-catalog', path: '/demos', wait: 1500 },
  { name: 'demo-detail-drifters', path: '/demos/ocean-drifters', wait: 9000 },
  { name: 'demo-detail-taxi-cube', path: '/demos/nyc-taxi-cube', wait: 9000 },
  { name: 'docs-landing', path: '/docs', wait: 2000 },
  {
    name: 'docs-api-point-layer',
    path: '/docs/api/animated-point-layer',
    wait: 2500,
  },
  {
    name: 'docs-system-overview',
    path: '/docs/architecture/system-overview',
    wait: 6000,
  },
  { name: 'docs-cli-reference', path: '/docs/api/cli-reference', wait: 2500 },
  {
    name: 'docs-manifest-schema',
    path: '/docs/spec/manifest-schema',
    wait: 2000,
  },
  { name: 'docs-404', path: '/docs/nope/missing', wait: 1000 },
  { name: 'fullscreen-drifters', path: '/demo/ocean-drifters', wait: 9000 },
  {
    name: 'fullscreen-od-summary',
    path: '/demo/nyc-taxi-od-summary',
    wait: 9000,
  },
  { name: 'excluded-redirect', path: '/demos/satellites', wait: 4000 },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error')
    errors.push({ page: current, text: msg.text().slice(0, 300) });
});
page.on('pageerror', (err) =>
  errors.push({
    page: current,
    text: `PAGEERROR ${String(err).slice(0, 300)}`,
  }),
);

let current = '';
for (const p of PAGES) {
  current = p.name;
  try {
    await page.goto(BASE + p.path, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(p.wait);
    await page.screenshot({ path: `${OUT}/${p.name}.png` });
    console.log(`OK   ${p.name}  →  ${page.url()}`);
  } catch (e) {
    console.log(`FAIL ${p.name}: ${String(e).slice(0, 200)}`);
  }
}

// Docs cross-link click-through: API page → another API page via in-content link.
current = 'docs-crosslink';
await page.goto(`${BASE}/docs/api/animated-point-layer`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(2000);
const link = page.locator('article a[href^="/docs/"]').first();
if ((await link.count()) > 0) {
  const href = await link.getAttribute('href');
  await link.click();
  await page.waitForTimeout(1500);
  console.log(`OK   docs-crosslink → clicked ${href} → ${page.url()}`);
} else {
  console.log('WARN docs-crosslink: no internal links found in article');
}

console.log('\n=== console errors ===');
if (errors.length === 0) console.log('(none)');
for (const e of errors) console.log(`[${e.page}] ${e.text}`);

await browser.close();
