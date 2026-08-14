/**
 * Frame-cost benchmark — what a topline demo costs per DRAWN FRAME during
 * steady-state playback, measured in a real browser against a running dev
 * server. The sibling `cold-start.mjs` measures the network protocol (requests
 * and bytes to first frame); this measures what happens after the tiles have
 * landed and the playhead is moving.
 *
 * See `docs/roadmap/measurements-2026-08.md` for the numbers this produced,
 * the method in prose, and the caveats.
 *
 * Usage:
 *   node src/frame-cost.mjs <demo-id> [seconds] [port]
 *   WARMUP_MS=20000 node src/frame-cost.mjs storm-4d-greenfield 12 3000
 *
 * `<demo-id>` is a showcase dataset id — it is opened at `/demo/<id>`, so the
 * `/worlds` and `/drive` surfaces are out of scope. Start the showcase first
 * (`pnpm --filter @poopdeck.gl/showcase dev`) and pass the port it printed;
 * Vite walks forward from 3000 when the port is taken, so it is rarely 3000.
 *
 * WHY A DEV SERVER. The showcase's `build` script typechecks first, so a
 * production bundle is only available when the tree is green. Read the caveat
 * in §7 of the measurements doc before quoting a JS-side percentage from a dev
 * run: React's development build inflates its own share. The GL counters below
 * are measured at the browser boundary and are unaffected, as are deck.gl and
 * luma.gl, which are consumed pre-built either way.
 *
 * Playwright is a devDependency of the workspace ROOT, not of this package, so
 * it is imported by absolute path off this file rather than by bare specifier.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
// CommonJS: `playwright` has no named ESM exports.
const { chromium } = require(
  require.resolve('playwright', { paths: [repoRoot] }),
);

const demoId = process.argv[2] ?? 'ocean-drifters';
const seconds = Number(process.argv[3] ?? 12);
const port = Number(process.argv[4] ?? 3000);
const outDir = process.env.OUT_DIR ?? path.join(repoRoot, 'tools/bench/out');

/**
 * How long to let tiles stream and the governor's start gate open before the
 * clock starts. Composite demos (severe-weather, storm4d) need noticeably more
 * than the single-source ones: a run that catches a half-loaded scene reports
 * a high frame rate for a scene that is not drawing, which is worse than no
 * measurement. Check `draws` in the output against the demo's usual value
 * before believing a fast reading.
 */
const warmupMs = Number(process.env.WARMUP_MS ?? 20000);

const browser = await chromium.launch({
  args: [
    '--use-gl=angle',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-webgpu',
  ],
});
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 300));
});

await page.addInitScript(() => {
  // Turn on the probe channels the layers already publish (lib/telemetry.ts)
  // BEFORE any layer code runs, so the first samples are captured.
  globalThis.__sttProbe = { enabled: true };

  globalThis.__frames = [];
  globalThis.__gl = {
    draws: 0,
    bufferSubData: 0,
    bufferData: 0,
    bindVAO: 0,
    useProgram: 0,
  };
  // Count GL calls at the browser boundary. This is the one measurement that
  // is independent of the bundle being a dev or production build, and it is
  // what makes a per-draw uniform-upload regression visible as a ratio rather
  // than as an unattributed slice of a CPU profile.
  const wrap = (proto, name, key) => {
    if (!proto || !proto[name]) return;
    const orig = proto[name];
    proto[name] = function (...a) {
      globalThis.__gl[key]++;
      return orig.apply(this, a);
    };
  };
  for (const P of [
    globalThis.WebGL2RenderingContext?.prototype,
    globalThis.WebGLRenderingContext?.prototype,
  ]) {
    wrap(P, 'drawElementsInstanced', 'draws');
    wrap(P, 'drawArraysInstanced', 'draws');
    wrap(P, 'drawElements', 'draws');
    wrap(P, 'drawArrays', 'draws');
    wrap(P, 'bufferSubData', 'bufferSubData');
    wrap(P, 'bufferData', 'bufferData');
    wrap(P, 'bindVertexArray', 'bindVAO');
    wrap(P, 'useProgram', 'useProgram');
  }

  const tick = (t) => {
    globalThis.__frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

// ROUTE override for the surfaces that are not `/demo/:id`. `/worlds` and
// `/drive` are two of the six home-grid demos and went unmeasured for exactly
// this reason, so the escape hatch is worth having:
//   ROUTE=/drive node src/frame-cost.mjs drive 12 3000
const route = process.env.ROUTE ?? `/demo/${demoId}`;

await page.goto(`http://localhost:${port}${route}`, {
  waitUntil: 'domcontentloaded',
  timeout: 120000,
});
await page.waitForSelector('canvas', { timeout: 120000 });
await page.waitForTimeout(warmupMs);

// Start playback if the transport is parked. The bar labels the button by
// what it WILL do, so an 'play' aria-label means it is currently paused.
await page.evaluate(() => {
  const play = [...document.querySelectorAll('button')].find((b) =>
    /play|pause/i.test(b.getAttribute('aria-label') ?? b.title ?? ''),
  );
  if (play && /play/i.test(play.getAttribute('aria-label') ?? '')) play.click();
});
await page.waitForTimeout(3000);

// Reset every counter here, not at load: everything above this line is
// startup, and startup is a different measurement.
await page.evaluate(() => {
  globalThis.__frames.length = 0;
  for (const k in globalThis.__gl) globalThis.__gl[k] = 0;
  const p = globalThis.__sttProbe;
  // `playback` joins the capture set. It is the PlaybackGovernor's QoE channel
  // and it was missing here, which is the only reason the stallCount /
  // totalStallMs acceptance cells had no instrument — this is the harness that
  // names them.
  for (const k of [
    'consolidations',
    'renderLayers',
    'tilePrepare',
    'decode',
    'playback',
  ]) {
    if (p[k]) p[k].length = 0;
  }
  // The QoE counters themselves are CUMULATIVE over the governor's lifetime,
  // so clearing the channel does not zero them — they still carry every stall
  // the warm-up paid for. Stash the value at the window boundary and difference
  // it at the end; that, not the raw counter, is this run's stall count.
  const st = p.snapshots?.['playback.state'] ?? {};
  globalThis.__qoeBase = {
    stallCount: st.stallCount ?? 0,
    totalStallMs: st.totalStallMs ?? 0,
    degradedResumeCount: st.degradedResumeCount ?? 0,
    creepMs: st.creepMs ?? 0,
  };
});

const client = await page.context().newCDPSession(page);
await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 200 });
await client.send('Profiler.start');
await page.waitForTimeout(seconds * 1000);
const { profile } = await client.send('Profiler.stop');

fs.mkdirSync(outDir, { recursive: true });
const slug = demoId.replace(/\//g, '_');
// A screenshot every run, so a "fast" reading cannot come from a blank canvas.
await page.screenshot({ path: path.join(outDir, `frame-cost-${slug}.png`) });

const result = await page.evaluate(() => {
  const f = globalThis.__frames;
  const deltas = [];
  for (let i = 1; i < f.length; i++) deltas.push(f[i] - f[i - 1]);
  deltas.sort((a, b) => a - b);
  const pct = (q) =>
    deltas[Math.min(deltas.length - 1, Math.floor(deltas.length * q))] ?? 0;
  const mean = deltas.reduce((s, x) => s + x, 0) / (deltas.length || 1);
  const probe = globalThis.__sttProbe ?? {};
  const channel = (name) => {
    const arr = probe[name] ?? [];
    return {
      n: arr.length,
      totalMs: arr.reduce((s, x) => s + (x.ms ?? 0), 0),
    };
  };
  // ── Playback QoE ────────────────────────────────────────────────────────
  // Cumulative counters ride every `playback` sample AND the `playback.state`
  // snapshot. Prefer the snapshot: it is republished on the governor's data
  // pulse, so it is present even when the window contained no state
  // transition (the healthy case — a run with zero stalls emits zero samples,
  // which must read as "0 stalls", never as "no data").
  const samples = probe.playback ?? [];
  const latest =
    probe.snapshots?.['playback.state'] ?? samples[samples.length - 1] ?? null;
  const base = globalThis.__qoeBase ?? {
    stallCount: 0,
    totalStallMs: 0,
    degradedResumeCount: 0,
    creepMs: 0,
  };
  const delta = (k) =>
    latest && typeof latest[k] === 'number'
      ? +(latest[k] - (base[k] ?? 0)).toFixed(1)
      : null;
  const qoe = {
    // null ⇒ no governor published on this route, NOT "zero stalls".
    available: latest !== null,
    // Windowed: counters at the end minus counters at the reset above.
    stallCount: delta('stallCount'),
    totalStallMs: delta('totalStallMs'),
    degradedResumeCount: delta('degradedResumeCount'),
    creepMs: delta('creepMs'),
    // Whole-session, deliberately NOT differenced: the start gate happens
    // during warm-up, so there is no in-window value to report.
    startupMs: latest?.startupMs ?? null,
    state: latest?.state ?? null,
    transitions: samples.length,
    cumulative: latest
      ? {
          stallCount: latest.stallCount ?? null,
          totalStallMs: latest.totalStallMs ?? null,
          degradedResumeCount: latest.degradedResumeCount ?? null,
          creepMs: latest.creepMs ?? null,
        }
      : null,
  };

  return {
    frames: deltas.length,
    fps: deltas.length ? 1000 / mean : 0,
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: deltas[deltas.length - 1] ?? 0,
    gl: globalThis.__gl,
    probe: {
      renderLayers: channel('renderLayers'),
      tilePrepare: channel('tilePrepare'),
      consolidations: channel('consolidations'),
      // Sample COUNT only — a `playback` sample carries QoE counters, not a
      // duration, so the shared `channel()` helper's `totalMs` would read 0
      // and mean nothing. The counters are in `qoe` below.
      playback: { n: samples.length },
    },
    // `snapshots` is dumped whole, so the trajectory publisher's
    // `tileset.viewport` (bounds / zoom / playheadMs / timeWindowMs /
    // direction / animating) lands in the JSON without a key change here.
    snapshots: probe.snapshots ?? {},
    qoe,
  };
});

// ── Fold the CPU profile to self time ──────────────────────────────────────
// Self time (a node's own `hitCount`), not total: the question is which frame
// is burning the samples, and a total-time view just re-reports the render
// loop at the top every time.
const selfByFn = new Map();
const selfByFile = new Map();
for (const node of profile.nodes) {
  const cf = node.callFrame;
  const file = (cf.url || '(native)')
    .split('?')[0]
    .split('/')
    .slice(-2)
    .join('/');
  const fn = `${cf.functionName || '(anon)'} @ ${file}:${cf.lineNumber}`;
  selfByFn.set(fn, (selfByFn.get(fn) ?? 0) + (node.hitCount ?? 0));
  selfByFile.set(file, (selfByFile.get(file) ?? 0) + (node.hitCount ?? 0));
}
const totalHits = [...selfByFn.values()].reduce((s, x) => s + x, 0) || 1;
const topN = (map, n) =>
  [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => ({ name: k, pct: +((v / totalHits) * 100).toFixed(2) }));

const perFrame = (k) => +(result.gl[k] / (result.frames || 1)).toFixed(2);

const out = {
  demoId,
  seconds,
  ...result,
  perFrame: {
    draws: perFrame('draws'),
    bufferSubData: perFrame('bufferSubData'),
    useProgram: perFrame('useProgram'),
    bindVAO: perFrame('bindVAO'),
    // The ratio that makes a per-draw uniform-upload regression obvious.
    // ~1 is healthy; ~6 was the luma.gl 9.3.3 bug (measurements-2026-08 §1).
    uboWritesPerDraw: result.gl.draws
      ? +(result.gl.bufferSubData / result.gl.draws).toFixed(2)
      : null,
  },
  topFunctions: topN(selfByFn, 30),
  topFiles: topN(selfByFile, 15),
  errors: errors.slice(0, 10),
};

const jsonPath = path.join(outDir, `frame-cost-${slug}.json`);
fs.writeFileSync(jsonPath, JSON.stringify(out, null, 2));

console.log(
  `${demoId}  ${out.fps.toFixed(1)} fps   p50 ${out.p50.toFixed(1)} ms   ` +
    `p95 ${out.p95.toFixed(1)} ms   p99 ${out.p99.toFixed(1)} ms`,
);
console.log(
  `  draws/frame ${out.perFrame.draws}   UBO writes/draw ` +
    `${out.perFrame.uboWritesPerDraw}   visible tiles ` +
    `${out.snapshots['tileset.stats']?.visibleTiles ?? '-'}`,
);
// QoE + trajectory. A '-' in the stall columns means no governor published on
// this route, which is not the same as a clean run — check `qoe.available`.
const vp = out.snapshots['tileset.viewport'];
console.log(
  `  stalls ${out.qoe.available ? out.qoe.stallCount : '-'}   stall ms ` +
    `${out.qoe.available ? out.qoe.totalStallMs : '-'}   state ` +
    `${out.qoe.state ?? '-'}   playhead ` +
    `${vp ? `${Math.round(vp.playheadMs)} (z${vp.zoom}, ${vp.animating ? 'animating' : 'paused'})` : '-'}`,
);
if (out.perFrame.draws < 1) {
  console.log(
    '  ⚠  fewer than one draw call per frame — the scene was not rendering. ' +
      'Raise WARMUP_MS and re-run; this fps figure is meaningless.',
  );
}
if (out.errors.length) {
  console.log(`  ⚠  ${out.errors.length} console error(s); see ${jsonPath}`);
}
console.log('  top self-time frames:');
for (const f of out.topFunctions.slice(0, 8)) {
  console.log(`    ${String(f.pct).padStart(6)}%  ${f.name}`);
}
console.log(`  wrote ${jsonPath}`);

await browser.close();
