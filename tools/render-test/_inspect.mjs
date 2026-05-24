import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('console', m => console.log(`[${m.type()}]`, m.text().slice(0, 200)));
await page.goto('http://localhost:3000/demo/nyc-taxi-od-heatmap', { waitUntil: 'domcontentloaded' });
// Wait for tiles to load.
await page.waitForTimeout(15_000);
const counts = await page.evaluate(async () => {
  // Pull tiles via deck — they aren't exposed globally. Pull from fetched archive directly.
  const r = await fetch('/data/nyc-rideshare.stt', { headers: { Range: 'bytes=0-63' } });
  return { status: r.status, len: (await r.arrayBuffer()).byteLength };
});
console.log('archive head probe:', counts);
await browser.close();
