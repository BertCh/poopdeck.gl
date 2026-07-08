import { chromium } from 'playwright';
const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const page = await (
  await browser.newContext({ viewport: { width: 1280, height: 800 } })
).newPage();
const errs = [];
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text().slice(0, 200));
});
await page.goto('http://localhost:3000/demo/nyc-rideshare', {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(10000);
console.log(
  JSON.stringify(
    { errorCount: errs.length, sample: errs.slice(0, 3) },
    null,
    2,
  ),
);
await browser.close();
