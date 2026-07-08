import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
});
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[INSTR]') || t.startsWith('[PERF]')) logs.push(t);
});

await page.goto('http://localhost:3000/demo/earthquake-activity', {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(2000);

// Patch the AnimatedPointLayer's buildConsolidatedData via prototype injection.
// We can't easily reach the layer instance directly, so instead we wrap the
// `renderLayers` method on any layer matching the layer name.
await page.evaluate(() => {
  const w = window;
  // Find the deck instance — the demo exposes window.deck or attaches it to the canvas.
  // Try common globals.
  const dump = (label, fn) => {
    const t0 = performance.now();
    const r = fn();
    const dt = performance.now() - t0;
    if (dt > 5) console.log(`[INSTR] ${label}: ${dt.toFixed(1)}ms`);
    return r;
  };
  w.__dump = dump;

  // Walk up from a known global. The deck.gl React wrapper stores the deck
  // instance in a ref — find it by walking React fibers from the canvas element.
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    console.log('[INSTR] no canvas');
    return;
  }
  const key = Object.keys(canvas).find((k) => k.startsWith('__reactFiber'));
  if (!key) {
    console.log('[INSTR] no react fiber on canvas');
    return;
  }
  let fiber = canvas[key];
  let deck = w.deck || null;
  if (!deck) {
    while (fiber) {
      if (fiber.stateNode && fiber.stateNode.deck) {
        deck = fiber.stateNode.deck;
        break;
      }
      if (fiber.memoizedState && fiber.memoizedState.deck) {
        deck = fiber.memoizedState.deck;
        break;
      }
      fiber = fiber.return;
    }
  }
  if (!deck || !deck.layerManager) {
    console.log(
      '[INSTR] no deck.layerManager; window.deck is',
      typeof w.deck,
      Object.keys(w.deck || {})
        .slice(0, 10)
        .join(','),
    );
    return;
  }
  w.__deck = deck;
  console.log(
    '[INSTR] deck found, layerManager layers:',
    deck.layerManager?.layers?.length,
  );

  // Patch each layer's renderLayers if it's an animated point layer
  for (const layer of deck.layerManager.layers) {
    const proto = Object.getPrototypeOf(layer);
    if (
      proto.constructor.layerName === 'AnimatedPointLayer' &&
      !proto.__patched
    ) {
      proto.__patched = true;
      const origRender = proto.renderLayers;
      proto.renderLayers = function () {
        return dump('AnimatedPointLayer.renderLayers', () =>
          origRender.call(this),
        );
      };
      const origBuild = proto.buildConsolidatedData;
      if (origBuild) {
        proto.buildConsolidatedData = function (tiles) {
          let total = 0;
          for (const tile of tiles || []) {
            for (const layer of tile.layers || []) {
              total += layer.features?.featureCount || 0;
            }
          }
          return dump(
            `buildConsolidatedData[tiles=${tiles?.length},features=${total}]`,
            () => origBuild.call(this, tiles),
          );
        };
      }
      const origUpdate = proto._handleTimeUpdate;
      if (origUpdate) {
        proto._handleTimeUpdate = function (time) {
          return dump('_handleTimeUpdate', () => origUpdate.call(this, time));
        };
      }
      console.log('[INSTR] patched AnimatedPointLayer prototype');
      break;
    }
  }
});

// Start playback
const playBtn = page
  .locator('button')
  .filter({ hasText: /play|▶/i })
  .first();
if (await playBtn.count()) {
  await playBtn.click();
}
console.log('=== 5s playback ===');
await page.waitForTimeout(5000);

const counts = {};
for (const l of logs) {
  const tag = l.split(':')[0].replace('[INSTR] ', '').split('[')[0].trim();
  counts[tag] = (counts[tag] || 0) + 1;
}
console.log('Event counts:', counts);
console.log('\nSample logs:');
console.log(logs.slice(0, 30).join('\n'));
console.log('...');
console.log(logs.slice(-10).join('\n'));

await ctx.close();
await browser.close();
