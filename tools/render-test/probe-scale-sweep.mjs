/**
 * Scale-sweep perf probe.
 *
 * Visits each STT showcase demo, captures time-to-first-tile, FPS, a
 * full frame-time histogram, and a long-task ms breakdown over a fixed
 * playback window. Emits machine-readable JSON to stdout (and a CSV
 * sidecar) so before/after comparisons across the optimization sprint
 * are quantified, not vibe-checked.
 *
 * Notable differences from `probe-perf.mjs` (which was a one-off):
 * - Multi-demo sweep instead of a single dataset.
 * - Histogram-based frame timing (16 / 33 / 50 / 100 / 250 / 500 ms buckets).
 * - TTFT: time from `goto` resolved to the first `__sttProbe.tileset.stats`
 *   snapshot reporting `visibleTiles > 0`.
 * - Decode / consolidation / renderLayers samples drained from the
 *   in-app `globalThis.__sttProbe` channel (see packages/deck.gl/src/telemetry.ts).
 * - Survives a missing demo (missing .stt, navigation timeout) without
 *   aborting the whole sweep — bad demos are reported and skipped.
 *
 * Usage:
 *   node tools/render-test/probe-scale-sweep.mjs                   # all demos
 *   node tools/render-test/probe-scale-sweep.mjs earthquakes       # one demo
 *   STT_PROBE_DEMOS=ship-traffic,flight-trips node …               # comma-list
 *   STT_PROBE_DURATION_MS=10000 node …                              # custom window
 *   STT_PROBE_OUTPUT=/tmp/sweep.json node …                         # custom output
 *
 * Requires the showcase dev server to be running on :3000.
 */

import { chromium } from '/Users/robertchristie/Documents/GitHub/spatiotemporal-tiles/node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/index.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOST = process.env.STT_PROBE_HOST || 'http://localhost:3000';
const DURATION_MS = Number(process.env.STT_PROBE_DURATION_MS || 8000);
const OUTPUT_PATH =
  process.env.STT_PROBE_OUTPUT ||
  `tools/render-test/output/scale-sweep-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;

// Frame-time histogram buckets in ms. Anything > the last bucket is reported
// as `>500ms`. The buckets were chosen to map onto common rendering targets:
// 16 ms = 60 fps, 33 ms = 30 fps, 50 ms = "noticeable jank", 100 ms = "users
// notice the stall", 250 / 500 ms = "the tab feels broken".
const FRAME_BUCKETS_MS = [16, 33, 50, 100, 250, 500];

// All showcase demo IDs (from examples/showcase/src/datasets.ts). Kept inline
// to avoid a dependency on the showcase build; if a demo ID is removed or
// added the sweep just reports it as missing and moves on.
const ALL_DEMOS = [
  'earthquake-activity',
  'flights',
  'flight-paths',
  'flight-trips',
  'hurricanes',
  'nyc-rideshare',
  'nyc-taxi-od-heatmap',
  'nyc-taxi-paths',
  'nyc-taxi-trips',
  'ship-traffic',
  'wildfires',
  'satellites',
  'satellite-trips-flat',
];

// ---------------------------------------------------------------------------
// CLI parse
// ---------------------------------------------------------------------------

function parseDemos() {
  const fromEnv = process.env.STT_PROBE_DEMOS;
  if (fromEnv) return fromEnv.split(',').map((s) => s.trim()).filter(Boolean);
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (positional.length > 0) return positional;
  return ALL_DEMOS;
}

const demos = parseDemos();
console.log(`Probing ${demos.length} demo(s) at ${DURATION_MS} ms each…\n`);

// ---------------------------------------------------------------------------
// Browser setup (shared across demos to keep startup cost amortised)
// ---------------------------------------------------------------------------

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

// Install the probe activator BEFORE navigation so layers see an enabled
// channel on first render. The showcase's PerformanceMonitor also enables
// the probe, but it does so on mount — installing here catches earlier
// samples like the first decode.
await ctx.addInitScript(() => {
  // @ts-ignore
  window.__sttProbe = { enabled: true };
  // @ts-ignore
  window.__sttSweep = { workerUrls: [], longTasks: [] };
  const origWorker = window.Worker;
  // @ts-ignore
  const Wrapped = function (url, opts) {
    // @ts-ignore
    window.__sttSweep.workerUrls.push(String(url));
    return new origWorker(url, opts);
  };
  Wrapped.prototype = origWorker.prototype;
  // @ts-ignore
  window.Worker = Wrapped;
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        // @ts-ignore
        window.__sttSweep.longTasks.push({ duration: e.duration, start: e.startTime });
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask is Chromium-only — fine to ignore on other runtimes.
  }
});

// ---------------------------------------------------------------------------
// Per-demo run
// ---------------------------------------------------------------------------

/**
 * Drop `t0` from each absolute timestamp so the result is relative-since-goto.
 */
function relative(t0, samples) {
  return samples.map((s) => ({ ...s, start: s.start - t0 }));
}

/**
 * Summarise a telemetry channel keyed on `.ms`. Returns null when empty,
 * otherwise `{ n, totalMs, mean, p50, p95, max }`.
 */
function summarizeMs(samples) {
  if (!samples || samples.length === 0) return null;
  const ms = samples.map((s) => s.ms ?? 0).filter((v) => Number.isFinite(v));
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const total = sorted.reduce((a, b) => a + b, 0);
  return {
    n: ms.length,
    totalMs: Number(total.toFixed(1)),
    mean: Number((total / ms.length).toFixed(2)),
    p50: Number(pct(0.5).toFixed(2)),
    p95: Number(pct(0.95).toFixed(2)),
    max: Number(sorted[sorted.length - 1].toFixed(2)),
  };
}

/**
 * Bucket an array of frame-time samples into `FRAME_BUCKETS_MS` plus a
 * `>last` overflow. Returns `{ counts, p50, p95, p99, max, mean, n }`.
 */
function histogram(samples) {
  if (samples.length === 0) {
    return {
      counts: Object.fromEntries(FRAME_BUCKETS_MS.map((b) => [`<=${b}`, 0])),
      overflow: 0,
      p50: 0, p95: 0, p99: 0, max: 0, mean: 0, n: 0,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const counts = Object.fromEntries(FRAME_BUCKETS_MS.map((b) => [`<=${b}`, 0]));
  let overflow = 0;
  for (const v of samples) {
    let placed = false;
    for (const b of FRAME_BUCKETS_MS) {
      if (v <= b) { counts[`<=${b}`]++; placed = true; break; }
    }
    if (!placed) overflow++;
  }
  const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
  const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    counts,
    overflow,
    p50: pct(0.50), p95: pct(0.95), p99: pct(0.99),
    max: sorted[sorted.length - 1], mean, n: sorted.length,
  };
}

async function probeDemo(demoId) {
  const url = `${HOST}/demo/${demoId}`;
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`[error] ${msg.text()}`);
  });

  const result = {
    demo: demoId,
    url,
    status: 'ok',
    error: null,
    ttftMs: null,
    fps: null,
    frameTime: null,
    longTasks: null,
    consolidations: null,
    renderLayers: null,
    tilePrepare: null,
    decodes: null,
    workersStarted: null,
    visibleTilesAtEnd: null,
    consoleErrors: [],
  };

  try {
    const navStart = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForSelector('canvas', { timeout: 30_000 });

    // Time-to-first-tile: poll the tileset snapshot until visibleTiles > 0.
    // Cap at 25 s; if no tile arrives, record null and move on.
    const ttftMs = await page.evaluate(async () => {
      const t0 = performance.now();
      const deadline = t0 + 25_000;
      while (performance.now() < deadline) {
        // @ts-ignore
        const snap = window.__sttProbe?.snapshots?.['tileset.stats'];
        if (snap && (snap.visibleTiles ?? 0) > 0) {
          return performance.now() - t0;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return null;
    });
    result.ttftMs = ttftMs;

    // Reset rolling sample buffers so the measurement window is clean.
    await page.evaluate(() => {
      // @ts-ignore
      const bag = window.__sttProbe;
      if (bag) {
        bag.consolidations = [];
        bag.renderLayers = [];
        bag.tilePrepare = [];
        bag.decode = [];
      }
      // @ts-ignore
      window.__sttSweep.longTasks = [];
    });

    // Start playback — find the play button by glyph. We DON'T fail if
    // it isn't present (some demos may pre-play or have an unusual UI);
    // we still capture a "static scene" measurement.
    try {
      const play = page.locator('button').filter({ hasText: /^[▶⏸]$/ }).first();
      if (await play.count()) {
        const glyph = (await play.innerText()).trim();
        if (glyph === '▶') await play.click({ timeout: 2_000 });
      }
    } catch {
      // Best-effort: continue with whatever state the page is in.
    }

    // Sample frame timing + drain telemetry channels during the window.
    const sampleStart = Date.now();
    const sample = await page.evaluate(async (durationMs) => {
      const start = performance.now();
      const deadline = start + durationMs;
      const frameTimes = [];
      let last = start;
      return new Promise((resolve) => {
        function tick(now) {
          frameTimes.push(now - last);
          last = now;
          if (now < deadline) {
            requestAnimationFrame(tick);
          } else {
            const finalize = () => {
              // @ts-ignore
              const bag = window.__sttProbe || {};
              // @ts-ignore
              const sweep = window.__sttSweep || {};
              // @ts-ignore
              const snap = bag.snapshots?.['tileset.stats'];
              resolve({
                frameTimes,
                consolidations: bag.consolidations || [],
                renderLayers: bag.renderLayers || [],
                tilePrepare: bag.tilePrepare || [],
                decode: bag.decode || [],
                longTasks: sweep.longTasks || [],
                workerUrls: sweep.workerUrls || [],
                visibleTilesAtEnd: snap?.visibleTiles ?? 0,
              });
            };
            // Drop the first frame (often abnormally large) before resolving.
            frameTimes.shift();
            finalize();
          }
        }
        requestAnimationFrame(tick);
      });
    }, DURATION_MS);

    const fps = (sample.frameTimes.length / DURATION_MS) * 1000;
    result.fps = Number(fps.toFixed(2));
    result.frameTime = histogram(sample.frameTimes);
    result.longTasks = sample.longTasks.length;
    result.consolidations = sample.consolidations.length;
    result.renderLayers = sample.renderLayers.length;
    result.tilePrepare = sample.tilePrepare.length;
    result.decodes = sample.decode.length;
    result.workersStarted = sample.workerUrls.length;
    result.visibleTilesAtEnd = sample.visibleTilesAtEnd;
    result.consoleErrors = consoleErrors;
    // Channel-level summaries — turn the raw sample arrays into the few
    // numbers that actually matter for before/after comparison: aggregate
    // count, total CPU ms, p50/p95/max latency, and (where present) the
    // decompress-vs-ipc breakdown so we can attribute decode cost to the
    // right subsystem.
    result.decodeStats = summarizeMs(sample.decode);
    result.consolidationStats = summarizeMs(sample.consolidations);
    result.renderLayersStats = summarizeMs(sample.renderLayers);
    result.tilePrepareStats = summarizeMs(sample.tilePrepare);
    if (sample.decode.length > 0 && sample.decode[0].decompressMs !== undefined) {
      result.decodeBreakdown = {
        decompress: summarizeMs(sample.decode.map((d) => ({ ms: d.decompressMs }))),
        ipc: summarizeMs(sample.decode.map((d) => ({ ms: d.ipcMs }))),
        compressedBytesTotal: sample.decode.reduce(
          (a, d) => a + (d.compressedBytes || 0),
          0,
        ),
      };
    }
    result._raw = {
      // Top 8 longest long-tasks (relative to nav start) — useful when
      // diagnosing jank without inflating the JSON tenfold.
      topLongTasks: [...sample.longTasks]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 8)
        .map(({ duration, start }) => ({
          duration: Number(duration.toFixed(1)),
          startSinceNav: Number((sampleStart - navStart + start).toFixed(0)),
        })),
      // Top 5 slow decodes — useful for diagnosing IPC parse hot spots.
      topDecodes: [...sample.decode]
        .sort((a, b) => (b.ms || 0) - (a.ms || 0))
        .slice(0, 5),
      topConsolidations: [...sample.consolidations]
        .sort((a, b) => (b.ms || 0) - (a.ms || 0))
        .slice(0, 5),
    };
  } catch (err) {
    result.status = 'error';
    result.error = err instanceof Error ? err.message : String(err);
    result.consoleErrors = consoleErrors;
  } finally {
    await page.close();
  }

  return result;
}

// ---------------------------------------------------------------------------
// Drive the sweep
// ---------------------------------------------------------------------------

const runs = [];
for (const demo of demos) {
  process.stdout.write(`▶ ${demo}… `);
  const r = await probeDemo(demo);
  runs.push(r);
  if (r.status === 'ok') {
    const ft = r.frameTime || {};
    console.log(
      `fps=${r.fps?.toFixed(1)} ` +
        `ttft=${r.ttftMs?.toFixed(0) ?? 'na'}ms ` +
        `p95=${ft.p95?.toFixed(1)}ms ` +
        `decodes=${r.decodes} ` +
        `tiles=${r.visibleTilesAtEnd}`,
    );
  } else {
    console.log(`ERROR: ${r.error}`);
  }
}

await browser.close();

const report = {
  capturedAt: new Date().toISOString(),
  durationMs: DURATION_MS,
  host: HOST,
  bucketsMs: FRAME_BUCKETS_MS,
  runs,
};

// Ensure output dir exists.
await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, JSON.stringify(report, null, 2));
console.log(`\nWrote ${OUTPUT_PATH}`);

// Compact CSV sidecar — handy for spreadsheet-style diffing across runs.
const csvLines = [
  'demo,status,fps,ttft_ms,p50_ms,p95_ms,p99_ms,frames_le16,frames_le33,frames_le50,frames_le100,frames_overflow,long_tasks,consolidations,decodes,visible_tiles',
];
for (const r of runs) {
  const ft = r.frameTime || {};
  csvLines.push([
    r.demo,
    r.status,
    r.fps ?? '',
    r.ttftMs?.toFixed(0) ?? '',
    ft.p50?.toFixed(1) ?? '',
    ft.p95?.toFixed(1) ?? '',
    ft.p99?.toFixed(1) ?? '',
    ft.counts?.['<=16'] ?? '',
    ft.counts?.['<=33'] ?? '',
    ft.counts?.['<=50'] ?? '',
    ft.counts?.['<=100'] ?? '',
    ft.overflow ?? '',
    r.longTasks ?? '',
    r.consolidations ?? '',
    r.decodes ?? '',
    r.visibleTilesAtEnd ?? '',
  ].join(','));
}
const csvPath = OUTPUT_PATH.replace(/\.json$/, '.csv');
await writeFile(csvPath, csvLines.join('\n') + '\n');
console.log(`Wrote ${csvPath}`);
