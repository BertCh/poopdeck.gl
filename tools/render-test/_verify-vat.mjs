import { chromium } from 'playwright';
import fs from 'fs';

const port = process.argv[2] || '3002';
const IDS = ['nyc-taxi-vat', 'nyc-taxi-trips'];
const isShaderErr = (t) => /shader|program|glsl|webgl|compil|link error|uniform|vat/i.test(t);

const browser = await chromium.launch();
const results = {};
for (const id of IDS) {
  const page = await browser.newPage();
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`http://localhost:${port}/demo/${id}`, { waitUntil: 'load' });
  // Let tiles load, layer build, and several animation frames run (shaders
  // compile lazily on first draw).
  await page.waitForTimeout(6000);
  const shot = `/tmp/vat-${id}.png`;
  await page.screenshot({ path: shot });
  // Non-blank check: sample the deck canvas pixels.
  const nonBlank = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return false;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return null; // can't read; rely on screenshot
    const px = new Uint8Array(4 * 64 * 64);
    gl.readPixels(c.width / 2 - 32, c.height / 2 - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let varied = false;
    for (let i = 4; i < px.length; i += 4) if (px[i] !== px[0] || px[i + 1] !== px[1] || px[i + 2] !== px[2]) { varied = true; break; }
    return varied;
  }).catch(() => null);
  results[id] = {
    errorCount: errs.length,
    shaderErrors: errs.filter(isShaderErr),
    sampleErrors: errs.slice(0, 6),
    centerPixelsVaried: nonBlank,
    screenshot: shot,
    screenshotBytes: fs.existsSync(shot) ? fs.statSync(shot).size : 0,
  };
  await page.close();
}
await browser.close();
fs.writeFileSync('/tmp/vat-result.json', JSON.stringify(results, null, 2));
console.log('DONE');
