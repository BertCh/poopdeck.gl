// TEMP-DIAGNOSTIC probe: reproduce the "slight flashing every so often" on
// the nyc-taxi-points / nyc-taxi-trips demos. Records:
//  - backjumps: backward sim-time jumps while playing (governor frontier clamp)
//  - timeline: ~20Hz (wall, sim) playhead samples
//  - tileSwaps: visible-tile set deltas (added/removed keys + sim time)
//  - playback: governor statechange/waiting/ready QoE events
//  - renderLayers: per-render tile/sublayer counts
// Run: node tools/render-test/_probe-taxi-flash.mjs [demo-id] [seconds]
import { chromium } from 'playwright';

const demo = process.argv[2] || 'nyc-taxi-trips';
const seconds = Number(process.argv[3] || 45);
const URL = `http://localhost:3003/demo/${demo}`;

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--no-sandbox',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
});
await ctx.addInitScript(() => {
  window.__sttProbe = {
    enabled: true,
    backjumps: [],
    timeline: [],
    tileSwaps: [],
    playback: [],
    renderLayers: [],
    tilePrepare: [],
    batches: [],
  };
});
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 60_000 });
await page.waitForTimeout(4000);

const play = page
  .locator('button')
  .filter({ hasText: /^[▶⏸]$/ })
  .first();
try {
  const glyph = (await play.innerText()).trim();
  if (glyph === '▶') await play.click();
} catch (e) {
  console.log('play click failed:', e.message);
}

console.log(`playing ${demo} for ${seconds}s…`);
await page.waitForTimeout(seconds * 1000);

const out = await page.evaluate(() => {
  const p = window.__sttProbe;
  return {
    backjumps: p.backjumps,
    timeline: p.timeline,
    tileSwaps: p.tileSwaps,
    playback: p.playback,
    renderTileCounts: p.renderLayers.map((r) => ({
      l: r.layer,
      t: r.tiles,
      s: r.sublayers,
    })),
    tilePrepareCount: p.tilePrepare.length,
    batches: p.batches,
  };
});

const fs = await import('node:fs');
const path = `/tmp/taxi-flash-${demo}.json`;
fs.writeFileSync(path, JSON.stringify(out, null, 1));

// ── Summary ──
console.log(`\n=== ${demo} (${seconds}s) → ${path} ===`);
console.log(`backjumps: ${out.backjumps.length}`);
for (const b of out.backjumps.slice(0, 20)) {
  console.log(
    `  wall=${b.wall.toFixed(0)} deltaSimMs=${b.deltaSimMs.toFixed(0)}`,
  );
}
// timeline monotonicity (loop wrap excluded: huge negative)
let regressions = 0;
for (let i = 1; i < out.timeline.length; i++) {
  const d = out.timeline[i].sim - out.timeline[i - 1].sim;
  if (d < 0 && Math.abs(d) < 3.6e6) regressions++;
}
console.log(
  `timeline samples: ${out.timeline.length}, small regressions: ${regressions}`,
);
// playhead stalls: wall advancing, sim frozen
let stalls = 0;
for (let i = 1; i < out.timeline.length; i++) {
  const dw = out.timeline[i].wall - out.timeline[i - 1].wall;
  const ds = out.timeline[i].sim - out.timeline[i - 1].sim;
  if (dw > 40 && Math.abs(ds) < 1) stalls++;
}
console.log(`frozen-sim samples: ${stalls}`);
console.log(`tileSwaps: ${out.tileSwaps.length}`);
const removalsOnly = out.tileSwaps.filter(
  (s) => s.removed.length > 0 && s.added.length === 0,
);
console.log(`  swaps with removals-only: ${removalsOnly.length}`);
// detect remove-then-readd churn
const removedAt = new Map();
let readds = 0;
for (const s of out.tileSwaps) {
  for (const k of s.removed) removedAt.set(k, s.wall);
  for (const k of s.added) {
    if (removedAt.has(k) && s.wall - removedAt.get(k) < 5000) {
      readds++;
      if (readds <= 10)
        console.log(
          `  re-add ${k} after ${(s.wall - removedAt.get(k)).toFixed(0)}ms`,
        );
    }
  }
}
console.log(`  remove→re-add within 5s: ${readds}`);
console.log(`playback events: ${out.playback.length}`);
for (const e of out.playback.slice(0, 30)) {
  console.log(
    `  ${e.event} state=${e.state} stalls=${e.stallCount ?? '?'} creepMs=${e.creepMs?.toFixed?.(0) ?? '?'}`,
  );
}
// render tile-count dips
const counts = out.renderTileCounts.map((r) => r.t);
let dips = 0;
for (let i = 1; i < counts.length - 1; i++) {
  if (counts[i] < counts[i - 1] && counts[i + 1] > counts[i]) dips++;
}
console.log(
  `renderLayers samples: ${counts.length}, transient tile-count dips: ${dips}`,
);
console.log(`tilePrepare events: ${out.tilePrepareCount}`);
const prio = out.batches.filter((b) => b.tier === 'priority');
const pref = out.batches.filter((b) => b.tier === 'prefetch');
console.log(
  `batches: priority=${prio.length} (tiles ${prio.reduce((a, b) => a + b.n, 0)}), prefetch=${pref.length} (tiles ${pref.reduce((a, b) => a + b.n, 0)})`,
);
console.log(`console errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log('  ', e.slice(0, 200));

await ctx.close();
await browser.close();
