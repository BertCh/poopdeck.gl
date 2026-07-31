// Targeted perf probe for a COMPOSITE demo (primary archive + overlay archive).
//
// Built for /demo/nyc-flow-and-riders (nyc-taxi-flows corridors + nyc-taxi-paths
// heads) but archive-agnostic: pass STT_URL and STT_ARCHIVES (comma-separated
// path fragments) to point it anywhere.
//
// Captures, per phase (cold load → settle → 8 s of playback):
//   • rAF frame cadence (fps, p50/p95/max frame time) and long tasks
//   • network requests + bytes, split PER ARCHIVE (range reads on packs vs
//     directory pages vs manifest) — the loader-side cost
//   • __sttProbe channels: decode, tilePrepare, renderLayers, consolidations
//   • deck.gl layer-tree size + draw-call proxy (sublayer count per layer)
//   • tileset cache stats for BOTH tilesets (read per-layer, not the
//     single-key `tileset.stats` snapshot which the two tilesets overwrite)
//
// Run: node tools/render-test/probe-flow-riders.mjs
//      STT_PHASE=play node tools/render-test/probe-flow-riders.mjs

import { chromium } from 'playwright';

const URL =
  process.env.STT_URL || 'http://localhost:3000/demo/nyc-flow-and-riders';
const ARCHIVES = (
  process.env.STT_ARCHIVES || 'nyc-taxi-flows,nyc-taxi-paths'
).split(',');
const SETTLE_MS = Number(process.env.STT_SETTLE_MS || 8000);
const SAMPLE_MS = Number(process.env.STT_SAMPLE_MS || 8000);
const LABEL = process.env.STT_LABEL || 'run';

// SwiftShader keeps the run reproducible on any machine, but it makes the GPU
// the bottleneck and hides main-thread signal. Default to ANGLE/Metal (real
// GPU) on darwin; STT_SWIFTSHADER=1 forces software.
const gpuArgs =
  process.env.STT_SWIFTSHADER === '1'
    ? ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
    : ['--use-angle=metal'];

const browser = await chromium.launch({
  headless: true,
  args: [
    ...gpuArgs,
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    // The probe measures steady-state cost; background throttling in headless
    // would otherwise clamp rAF the moment the page loses "focus".
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});

const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});

await ctx.addInitScript(() => {
  // Enable the layers' telemetry channels BEFORE any layer constructs.
  window.__sttProbe = { enabled: true, longTasks: [], rafTimes: [] };
  try {
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        window.__sttProbe.longTasks.push({
          duration: e.duration,
          start: e.startTime,
        });
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch {}
});

const page = await ctx.newPage();

const consoleLines = [];
page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));

// ── Network accounting, split per archive ────────────────────────────────────
// `response` fires for every fetch; range reads on a pack report the SLICE
// length in content-length, which is what we want (bytes over the wire).
const net = new Map(); // archive -> {manifest, directory, packs, bytes, byKind}
const bucketFor = (url) => ARCHIVES.find((a) => url.includes(`/${a}/`)) ?? null;
const kindFor = (url) =>
  url.includes('/packs/')
    ? 'packs'
    : url.includes('/index/')
      ? 'index'
      : url.includes('manifest.json')
        ? 'manifest'
        : 'other';
let phase = 'cold';
page.on('response', async (res) => {
  const url = res.url();
  const a = bucketFor(url);
  if (!a) return;
  const len = Number(res.headers()['content-length'] || 0);
  const key = `${a}`;
  if (!net.has(key))
    net.set(key, {
      cold: { n: 0, bytes: 0, kinds: {} },
      play: { n: 0, bytes: 0, kinds: {} },
    });
  const slot = net.get(key)[phase === 'play' ? 'play' : 'cold'];
  slot.n++;
  slot.bytes += len;
  const k = kindFor(url);
  slot.kinds[k] = (slot.kinds[k] || 0) + 1;
});

await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas', { timeout: 90_000 });

// ── Phase 1: cold load / settle ─────────────────────────────────────────────
await page.waitForTimeout(SETTLE_MS);

const drainChannels = () =>
  page.evaluate(() => {
    const b = window.__sttProbe || {};
    const take = (k) => {
      const arr = b[k] || [];
      b[k] = [];
      return arr;
    };
    return {
      decode: take('decode'),
      tilePrepare: take('tilePrepare'),
      renderLayers: take('renderLayers'),
      consolidations: take('consolidations'),
      snapshots: JSON.parse(JSON.stringify(b.snapshots || {})),
    };
  });

const coldChannels = await drainChannels();

// ── Phase 2: play + sample ──────────────────────────────────────────────────
phase = 'play';
let played = false;
try {
  const btn = page.locator('button[aria-label="Play"]').first();
  if (await btn.count()) {
    await btn.click({ timeout: 5000 });
    played = true;
  } else if (await page.locator('button[aria-label="Pause"]').count()) {
    played = true; // already playing
  }
} catch (e) {
  consoleLines.push(`[probe] play click failed: ${e.message}`);
}

// Let the clock get past the start gate and reach steady-state churn.
await page.waitForTimeout(6000);
await drainChannels(); // discard the start-gate transient

// Is the CLOCK actually advancing? A frozen playhead with a healthy fps is the
// buffer-gate stall failure mode, and it must not read as "smooth".
const clockAt = () =>
  page.evaluate(() => {
    const el = document.querySelector('input[aria-label="Playback position"]');
    return el ? Number(el.value) : null;
  });
const clockBefore = await clockAt();

const sample = await page.evaluate(async (ms) => {
  const b = window.__sttProbe;
  b.longTasks = [];
  b.rafTimes = [];
  const start = performance.now();
  let last = start;
  await new Promise((resolve) => {
    function tick(now) {
      b.rafTimes.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });
  return {
    rafTimes: b.rafTimes.slice(),
    longTasks: b.longTasks.slice(),
    elapsed: performance.now() - start,
  };
}, SAMPLE_MS);

const clockAfter = await clockAt();
const playChannels = await drainChannels();

// ── deck.gl layer tree: how many sublayers / draw calls the frame issues ────
const tree = await page.evaluate(() => {
  // The showcase keeps no global deck handle; reach it through the canvas'
  // React fiber-free route: deck stashes itself on the DeckGL instance which
  // registers a global `deck` in dev builds of some setups. Fall back to
  // walking `window` for an object with a `layerManager`.
  const findDeck = () => {
    for (const k of Object.keys(window)) {
      const v = window[k];
      if (v && typeof v === 'object' && v.layerManager && v.viewManager)
        return v;
    }
    return null;
  };
  const deck = findDeck();
  if (!deck) return { found: false };
  const layers = deck.layerManager.getLayers();
  const byRoot = {};
  for (const l of layers) {
    const root = l.id.split('-')[0] + (l.parent ? '' : ' (root)');
    const key = l.parent ? `${l.root?.id ?? 'sub'}` : l.id;
    byRoot[key] = (byRoot[key] || 0) + 1;
    void root;
  }
  return {
    found: true,
    total: layers.length,
    drawable: layers.filter((l) => l.isComposite === false && l.props.visible)
      .length,
    byRoot,
  };
});

// ── report ──────────────────────────────────────────────────────────────────
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const sum = (arr, f) => arr.reduce((t, x) => t + (f(x) || 0), 0);

const out = {
  label: LABEL,
  url: URL,
  played,
  gpu: process.env.STT_SWIFTSHADER === '1' ? 'swiftshader' : 'angle-metal',
  // Sim-ms of clock advanced during the sample window. 0 with a healthy fps =
  // the governor never opened the gate (a stall, not smoothness).
  clockAdvancedMs:
    clockBefore != null && clockAfter != null ? clockAfter - clockBefore : null,
  frames: {
    count: sample.rafTimes.length,
    fps: +(sample.rafTimes.length / (sample.elapsed / 1000)).toFixed(2),
    p50: +pct(sample.rafTimes, 0.5).toFixed(2),
    p95: +pct(sample.rafTimes, 0.95).toFixed(2),
    max: +Math.max(0, ...sample.rafTimes).toFixed(2),
  },
  longTasks: {
    count: sample.longTasks.length,
    totalMs: +sum(sample.longTasks, (t) => t.duration).toFixed(0),
    p95Ms: +pct(
      sample.longTasks.map((t) => t.duration),
      0.95,
    ).toFixed(0),
    maxMs: +Math.max(0, ...sample.longTasks.map((t) => t.duration)).toFixed(0),
  },
  network: Object.fromEntries(
    [...net.entries()].map(([k, v]) => [
      k,
      {
        cold: {
          reqs: v.cold.n,
          mb: +(v.cold.bytes / 1e6).toFixed(2),
          kinds: v.cold.kinds,
        },
        play: {
          reqs: v.play.n,
          mb: +(v.play.bytes / 1e6).toFixed(2),
          kinds: v.play.kinds,
        },
      },
    ]),
  ),
  channels: {},
  layerTree: tree,
  snapshots: playChannels.snapshots,
};

for (const [name, ch] of [
  ['cold', coldChannels],
  ['play', playChannels],
]) {
  out.channels[name] = {
    decode: (() => {
      // `tileKey` is `z/x/y/t`, so the samples say WHICH tiles were decoded —
      // which zooms, and how often the same tile came back (a re-decode means
      // it was evicted and re-fetched, the thrash signature).
      const byZoom = {};
      const seen = new Map();
      for (const d of ch.decode) {
        const z = String(d.tileKey || '?').split('/')[0];
        byZoom[z] = (byZoom[z] || 0) + 1;
        seen.set(d.tileKey, (seen.get(d.tileKey) || 0) + 1);
      }
      let repeats = 0;
      for (const c of seen.values()) if (c > 1) repeats += c - 1;
      return {
        n: ch.decode.length,
        distinctTiles: seen.size,
        redecodes: repeats,
        byZoom,
        totalMs: +sum(ch.decode, (d) => d.ms).toFixed(0),
        compressedMB: +(sum(ch.decode, (d) => d.compressedBytes) / 1e6).toFixed(
          2,
        ),
      };
    })(),
    tilePrepare: {
      n: ch.tilePrepare.length,
      totalMs: +sum(ch.tilePrepare, (d) => d.ms).toFixed(0),
      byLayer: ch.tilePrepare.reduce((m, d) => {
        const k = d.layer || '?';
        m[k] = m[k] || { n: 0, ms: 0 };
        m[k].n++;
        m[k].ms += d.ms || 0;
        return m;
      }, {}),
    },
    renderLayers: {
      n: ch.renderLayers.length,
      totalMs: +sum(ch.renderLayers, (d) => d.ms).toFixed(0),
      byLayer: ch.renderLayers.reduce((m, d) => {
        const k = d.layer || '?';
        m[k] = m[k] || {
          n: 0,
          ms: 0,
          tiles: 0,
          skippedTiles: 0,
          sublayers: 0,
          dots: 0,
          dotsByZoom: {},
          maxLagMs: 0,
          maxLeadMs: 0,
        };
        m[k].n++;
        m[k].ms += d.ms || 0;
        m[k].tiles = Math.max(m[k].tiles, d.tiles || 0);
        m[k].skippedTiles = Math.max(m[k].skippedTiles, d.skippedTiles || 0);
        m[k].sublayers = Math.max(m[k].sublayers, d.sublayers || 0);
        m[k].dots = Math.max(m[k].dots, d.dots || 0);
        // Per-frame dot totals per zoom, averaged over the sample: a frame with
        // dots at two zooms is drawing a parent stand-in over its own children.
        for (const [z, n] of Object.entries(d.dotsByZoom || {})) {
          m[k].dotsByZoom[z] = (m[k].dotsByZoom[z] || 0) + n;
        }
        m[k].frames = (m[k].frames || 0) + 1;
        m[k].maxLagMs = Math.max(m[k].maxLagMs, d.maxLagMs || 0);
        m[k].maxLeadMs = Math.max(m[k].maxLeadMs, d.maxLeadMs || 0);
        return m;
      }, {}),
    },
    consolidations: {
      n: ch.consolidations.length,
      totalMs: +sum(ch.consolidations, (d) => d.ms).toFixed(0),
    },
  };
  // Round the byLayer ms
  for (const g of ['tilePrepare', 'renderLayers'])
    for (const v of Object.values(out.channels[name][g].byLayer)) {
      v.ms = +v.ms.toFixed(1);
      if (v.dotsByZoom && v.frames)
        for (const z of Object.keys(v.dotsByZoom))
          v.dotsByZoom[z] = +(v.dotsByZoom[z] / v.frames).toFixed(0);
    }
}

console.log(JSON.stringify(out, null, 2));

const interesting = consoleLines.filter((l) =>
  /error|warn|pageerror|stall|reject|budget/i.test(l),
);
if (interesting.length) {
  console.log('\n--- console (errors/warnings) ---');
  for (const l of interesting.slice(0, 40)) console.log(l);
}

await browser.close();
