// Correctness verifier for the TSL (Three.js + WebGPU) AV cockpit renderer.
// PASS/FAIL only (no aesthetic judgement): loads /drive/<scene>, switches to the
// TSL renderer under real WebGPU, starts playback, and asserts NO per-frame WGSL
// build throws / missing-attribute errors fire. These were the bugs that blanked
// the viewport: (1) BoundingBoxLayer rendered a position-less geometry, (2) the
// surfel material wrapped a `select()` (ConditionalNode) in a `varying()`, and
// (3) the SAME select-in-varying in point-material.ts (raw points / splat / scan).
// Each aborts every frame's render on the WGSL backend → black screen.
//
// It now sweeps MULTIPLE scenes so EVERY material path is exercised: a raw-points
// scene (point-material) AND a surfel scene (surfel-material). Override the sweep
// with SCENE=<id>[,<id>…] (or the legacy single SCENE).
//
// NB: a pixel/screenshot readback is intentionally NOT done here — the headless
// WebGPU (swiftshader) compositor hangs Playwright's screenshot, and the visual
// look is verified in a real browser by hand. This guards the CRASH regression.
import { chromium } from 'playwright';

const BASE = process.env.STT_URL || 'http://localhost:3000';
// Raw points first (point-material path), then surfel (surfel-material path).
const SCENES = (
  process.env.SCENE || 'argoverse-0bae3b5e,argoverse-0bae3b5e-surfel'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--enable-unsafe-webgpu',
    '--enable-features=Vulkan',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});

/** Load one scene, switch to TSL, play, and report whether any WGSL crash fired. */
async function verifyScene(scene) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();
  const errors = [];
  const warns = [];
  page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
    else if (m.type() === 'warning') warns.push(m.text());
  });

  await page.goto(`${BASE}/drive/${scene}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForTimeout(4000);
  const gpu = await page.evaluate(() => 'gpu' in navigator);
  // Switch deck → TSL.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      /deck\.gl|TSL/.test(x.textContent || ''),
    );
    if (b && /deck\.gl/.test(b.textContent || '')) b.click();
  });
  await page.waitForTimeout(2500);
  // Start playback so the temporal-windowed cloud + animated boxes exercise every path.
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      /^[▶⏸]$/.test((x.textContent || '').trim()),
    );
    if (b) b.click();
  });
  // Let the clock advance — if the governor source is unregistered the clock
  // would freeze ~8 s; 7 s of playback also exercises the moving-cloud paths.
  await page.waitForTimeout(7000);

  const buildThrows = errors.filter((e) =>
    /reading 'build'|not found on geometry/.test(e),
  );
  const zeroDraws = warns.filter((w) => /vertex count of 0/i.test(w));
  console.log(`=== TSL verify /drive/${scene} ===`);
  console.log('navigator.gpu present:', gpu);
  console.log('total page/console errors:', errors.length);
  console.log('WGSL build throws / missing-attribute:', buildThrows.length);
  console.log('"Draw with a vertex count of 0" warnings:', zeroDraws.length);
  for (const e of errors.slice(0, 8)) console.log('   ', e.slice(0, 160));

  const clean = buildThrows.length === 0 && zeroDraws.length === 0;
  console.log(
    `RESULT(${scene}): noBuildThrows=${buildThrows.length === 0} noZeroDraws=${zeroDraws.length === 0}\n`,
  );
  await ctx.close();
  return clean;
}

let allClean = true;
for (const scene of SCENES) {
  // eslint-disable-next-line no-await-in-loop
  const ok = await verifyScene(scene);
  allClean = allClean && ok;
}

console.log(
  `VERIFY (${SCENES.length} scene${SCENES.length === 1 ? '' : 's'}): ${allClean ? 'PASS' : 'FAIL'}`,
);
await browser.close();
process.exit(allClean ? 0 : 1);
