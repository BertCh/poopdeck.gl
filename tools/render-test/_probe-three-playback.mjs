// Differential playback probe for the TSL (Three.js + WebGPU) AV renderer.
// Plays on DECK (proven path) to confirm the shared clock advances, then switches
// to THREE and checks whether (a) the shared clock KEEPS advancing (governor gate
// still open on the three path) and (b) GPUQueue.submit keeps climbing (three's
// render loop repaints — deck is WebGL2 so submits are the three/WebGPU path only).
// Headless swiftshader throttles rAF hard, so we test LOGIC (does it advance at
// all / keep advancing), not smoothness.
import { chromium } from 'playwright';

const BASE = process.env.STT_URL || 'http://localhost:3009';
const SCENE = process.env.SCENE || 'argoverse-0bae3b5e-surfel';

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
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
});

await page.addInitScript(() => {
  const w = window;
  w.__gpuSubmits = 0;
  const patch = () => {
    try {
      const Q = window.GPUQueue && window.GPUQueue.prototype;
      if (Q && !Q.__patched) {
        const orig = Q.submit;
        Q.submit = function (...a) {
          w.__gpuSubmits++;
          return orig.apply(this, a);
        };
        Q.__patched = true;
      }
    } catch {}
  };
  patch();
  const origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    origRaf((t) => {
      patch();
      return cb(t);
    });
});

const sample = () =>
  page.evaluate(() => {
    const pos = document.querySelector('input[aria-label="Playback position"]');
    const chips = Array.from(document.querySelectorAll('div[title]'))
      .map((d) => d.getAttribute('title'))
      .filter((t) => /required|optional|gating/.test(t || ''));
    return {
      clock: pos ? Number(pos.value) : null,
      submits: window.__gpuSubmits || 0,
      renderer: /TSL/.test(
        (
          Array.from(document.querySelectorAll('button')).find((x) =>
            /deck\.gl|TSL/.test(x.textContent || ''),
          ) || {}
        ).textContent || '',
      )
        ? 'three'
        : 'deck',
      play: document.querySelector('button[aria-label="Play"]')
        ? 'Play'
        : document.querySelector('button[aria-label="Pause"]')
          ? 'Pause'
          : null,
      sources: chips,
    };
  });
const clickPlay = () =>
  page.evaluate(() => {
    const b = document.querySelector('button[aria-label="Play"]');
    if (b) {
      b.click();
      return true;
    }
    return false;
  });
const switchRenderer = () =>
  page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) =>
      /deck\.gl/.test(x.textContent || ''),
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  });

console.log(`Loading ${BASE}/drive/${SCENE} …`);
await page.goto(`${BASE}/drive/${SCENE}`, {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
await page.waitForTimeout(4500);
console.log('initial:', JSON.stringify(await sample()));

console.log('\n--- play on DECK ---');
console.log('clicked play:', await clickPlay());
const deck = [];
for (let i = 0; i < 3; i++) {
  await page.waitForTimeout(1000);
  deck.push(await sample());
  console.log(`  t+${i + 1}s:`, JSON.stringify(deck.at(-1)));
}

console.log('\n--- switch DECK -> THREE (keep playing) ---');
console.log('switched:', await switchRenderer());
await page.waitForTimeout(1500);
const three = [];
for (let i = 0; i < 12; i++) {
  await page.waitForTimeout(1000);
  three.push(await sample());
  console.log(`  t+${i + 1}s:`, JSON.stringify(three.at(-1)));
}

const deckAdvanced = deck.length > 1 && deck.at(-1).clock !== deck[0].clock;
const threeClockAdvanced =
  three.length > 1 && three.at(-1).clock !== three[0].clock;
const threeSubmits = three.at(-1).submits - three[0].submits;

console.log('\n=== DIFFERENTIAL RESULT ===');
console.log(
  'DECK clock advanced while playing:',
  deckAdvanced,
  `(${deck[0]?.clock} -> ${deck.at(-1)?.clock})`,
);
console.log(
  'THREE clock kept advancing after switch:',
  threeClockAdvanced,
  `(${three[0]?.clock} -> ${three.at(-1)?.clock})`,
);
console.log('THREE GPU submits over 6s:', threeSubmits);
console.log('errors:', errors.length);
for (const e of errors.slice(0, 6)) console.log('   ', e.slice(0, 150));
console.log(
  '\nDIAGNOSIS:',
  !deckAdvanced
    ? 'INCONCLUSIVE — clock did not advance even on deck (play not engaged / gate frozen for both)'
    : threeClockAdvanced && threeSubmits > 10
      ? 'THREE OK — shared clock advances on three AND canvas repaints (fix works; user issue is stale vite)'
      : threeClockAdvanced && threeSubmits <= 10
        ? 'RENDER LOOP DEAD on three — clock advances but canvas does not repaint'
        : 'GATE FROZEN on three — switching to three stalls the shared clock (governor source issue)',
);

await browser.close();
process.exit(0);
