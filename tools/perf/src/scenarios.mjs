/**
 * Reusable scenario building blocks.
 *
 * Each scenario takes a (page, opts) and runs:
 *   await page.evaluate((l) => window.__sttPerf.beginSample(l), label);
 *   ...interactions...
 *   await page.evaluate(() => window.__sttPerf.endSample());
 *
 * Scenarios are intentionally short and stateless — composition happens in
 * cli.mjs which sequences them per demo.
 *
 * Conventions:
 *  - Wait for `.map-viewport canvas` before any scenario; the deck.gl canvas
 *    is the only stable selector across demos.
 *  - Settle for a tile-load grace period BEFORE beginSample(), so cold-start
 *    decoding doesn't dominate the per-scenario stats.
 */

/** Wait for the canvas + give tiles a chance to stream in. */
export async function settle(page, { initialLoadMs = 10_000 } = {}) {
  await page.locator('.map-viewport canvas').first().waitFor({
    state: 'visible',
    timeout: 60_000,
  });
  // The first paint can take a few seconds even with hot tiles — give the
  // tileset's debounced prefetch one full PREFETCH_DEBOUNCE_MS cycle plus a
  // worker-warmup window before sampling.
  await page.waitForTimeout(initialLoadMs);
}

/** Click the play button (▶) if it's currently paused. */
async function clickPlay(page) {
  const btn = page.locator('button:has-text("▶")').first();
  if (await btn.count() === 0) return; // already playing
  await btn.click();
}

/** Click the pause button (⏸) if it's currently playing. */
async function clickPause(page) {
  const btn = page.locator('button:has-text("⏸")').first();
  if (await btn.count() === 0) return; // already paused
  await btn.click();
}

/**
 * playback — sample frame timings while the time controller advances.
 *
 * The "playback" perf signal is FPS p5/p50/p95 + long-task count over a
 * sustained ~6-second window AFTER initial warmup. Long tasks here usually
 * indicate consolidation rebuilds or main-thread decode contention.
 */
export async function playback(page, { durationMs = 6_000, label = 'playback' } = {}) {
  await clickPlay(page);
  // Let animation reach steady-state (the tileset prefetch warms up over a
  // couple of ticks; sampling immediately captures cold-start cost).
  await page.waitForTimeout(2_000);
  await page.evaluate((l) => window.__sttPerf.beginSample(l), label);
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => window.__sttPerf.endSample());
  await clickPause(page);
}

/**
 * pausedIdle — sample frame timings with NO animation and NO interaction.
 *
 * A well-behaved deck.gl scene should sit at the browser's vsync rate with
 * effectively zero CPU work. Jank here is the most damning symptom: it means
 * some per-frame work is firing even when nothing changed. Common causes:
 *  - a React state-update loop driven by a ref that "looks" idle
 *  - a layer extension whose draw() does work unconditionally
 *  - a setNeedsRedraw() called from a setInterval/setTimeout
 */
export async function pausedIdle(page, { durationMs = 4_000, label = 'paused-idle' } = {}) {
  await clickPause(page);
  // Settle so any in-flight tile loads don't bleed into the sample.
  await page.waitForTimeout(1_500);
  await page.evaluate((l) => window.__sttPerf.beginSample(l), label);
  await page.waitForTimeout(durationMs);
  await page.evaluate(() => window.__sttPerf.endSample());
}

/**
 * zoom — drive a zoom-in / zoom-out sequence while sampling.
 *
 * Zoom is a stress test for the tileset's request-cancel + prefetch path:
 * each zoom step changes the bounds and the tile set, which should cancel
 * in-flight requests at the old zoom and enqueue priority requests at the
 * new zoom. Janky zoom usually points to a tile churn / consolidation
 * rebuild storm, not GPU cost.
 *
 * We dispatch `wheel` events via CDP rather than keyboard +/- because
 * deck.gl's MapView listens for wheel events on the canvas directly and the
 * default Mapbox/Maplibre controllers respond to those, but +/- keyboard
 * shortcuts aren't bound in the showcase. The wheel deltaY is negative to
 * zoom in (browser scrolls toward the cursor).
 */
export async function zoom(page, { steps = 6, perStepMs = 800, label = 'zoom' } = {}) {
  await clickPause(page);
  const canvas = page.locator('.map-viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) return;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  await page.evaluate((l) => window.__sttPerf.beginSample(l), label);

  // Zoom in N steps, then back out N steps. Each `wheel` is roughly one
  // discrete zoom level under the default MapView controller.
  for (let dir of [-100, 100]) {
    for (let i = 0; i < steps; i++) {
      await page.mouse.move(cx, cy);
      await page.mouse.wheel(0, dir);
      await page.waitForTimeout(perStepMs);
    }
  }

  await page.evaluate(() => window.__sttPerf.endSample());
}

export const SCENARIOS = {
  playback,
  'paused-idle': pausedIdle,
  zoom,
};
