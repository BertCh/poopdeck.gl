#!/usr/bin/env node
/**
 * Policy trace RECORDER — the capture half of the P0-3 replay harness.
 *
 * ── FIDELITY BOUNDARY — READ THIS BEFORE QUOTING ANY NUMBER ────────────────
 * What this records is the input to a **policy** replay: the client's
 * viewport/playhead trajectory and the telemetry channels that describe what
 * the loader decided (`requests`, `decode`, `evict`, `scrub`, `playback`).
 *
 * It records NOTHING about the GPU or the renderer. No frame pacing, no draw
 * calls, no uploads, no rasterisation. Its sibling `policy-replay.mjs` models
 * policy decisions, not render feedback; anything render-coupled stays with
 * `frame-cost.mjs`, which measures it properly in a live browser. Do not read
 * a trace as a performance measurement — read it as a decision log.
 * ───────────────────────────────────────────────────────────────────────────
 *
 * WHY. Live QoE runs are browser sessions against a real network, so a policy
 * A/B drowns in transport noise, and `cold-start.mjs` stops at first frame and
 * never exercises playback policy at all. The answer is to record once, on the
 * real composite routes, then replay offline against policy variants where the
 * only thing that varies is the policy.
 *
 * Usage:
 *   node src/policy-record.mjs <demo-id> [seconds] [port] [options]
 *   ROUTE=/drive node src/policy-record.mjs drive 30 3000
 *
 * Routes worth recording (the composites, where policy actually bites):
 *   severe-weather        radar + fronts, multi-source coordination
 *   storm-4d-greenfield   volumetric, heavy bytes
 *   ROUTE=/drive          the slowest topline surface
 *
 * Options:
 *   --out <path>          trace destination (default out/traces/<route>-<date>.jsonl)
 *   --sample-ms N         trajectory sample period (default 250)
 *   --bucket-ms N         declared temporal bucket; derived from keys when omitted
 *   --horizon N           prefetch horizon in buckets for the replay config
 *   --max-tiles N         tileset maxCacheSize for the replay config
 *   --max-bytes N         tileset maxCacheByteSize for the replay config
 *   --loop-start N, --loop-end N   the playback loop extent, if the demo loops
 *   --allow-trajectory-gap         write the trace even with no trajectory source
 *
 * Start the showcase first (`pnpm --filter @poopdeck.gl/showcase dev`) and pass
 * the port it printed — Vite walks forward from 3000 when the port is taken.
 *
 * Playwright is a devDependency of the workspace ROOT, not of this package, so
 * it is required by absolute path rather than by bare specifier — same as
 * `frame-cost.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DEFAULT_CONFIG,
  TRACE_VERSION,
  serializeTrace,
} from './policy-replay.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

/** The probe channels a trace carries. `viewport` is synthesised here. */
const PROBE_CHANNELS = ['requests', 'decode', 'evict', 'scrub', 'playback'];

/** Stable channel order for the file, so two identical captures sort alike. */
const CHANNEL_RANK = new Map(
  ['viewport', 'requests', 'decode', 'evict', 'scrub', 'playback'].map(
    (c, i) => [c, i],
  ),
);

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (name === 'allow-trajectory-gap' || name === 'help') flags[name] = true;
    else flags[name] = argv[++i];
  }
  return { positional, flags };
}

/**
 * The page-side sampler. Installed BEFORE any app code runs so the probe bag
 * exists when the first layer initialises, but it stays disarmed until the
 * driver says go — everything before that is startup, and startup is
 * `cold-start.mjs`'s measurement, not this one.
 *
 * Draining the channels on a timer (rather than reading them once at the end)
 * matters: the probe rings cap at 4096 samples and a busy composite route
 * overflows them in seconds, which would silently truncate the trace.
 */
function installSampler(sampleMs, channels) {
  globalThis.__sttProbe = { enabled: true };
  globalThis.__sttTrace = {
    armed: false,
    t0: 0,
    events: [],
    trajectorySource: null,
    samples: 0,
  };

  const drain = () => {
    const T = globalThis.__sttTrace;
    if (!T.armed) return;
    const probe = globalThis.__sttProbe ?? {};
    const now = Math.round(performance.now() - T.t0);

    for (const ch of channels) {
      const arr = probe[ch];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      // Splice, don't read: the ring is capped and a busy route overflows it.
      const taken = arr.splice(0, arr.length);
      for (const s of taken) {
        const stamp =
          typeof s?.completedAt === 'number' && s.completedAt > 0
            ? s.completedAt
            : typeof s?.enqueuedAt === 'number' && s.enqueuedAt > 0
              ? s.enqueuedAt
              : performance.now();
        T.events.push({ ...s, ch, tMs: Math.max(0, Math.round(stamp - T.t0)) });
      }
    }

    // ── Trajectory ────────────────────────────────────────────────────────
    // The replay needs the recorded viewport + playhead. No package publishes
    // one today (`tileset.stats` carries cache counters only), so this
    // feature-detects the snapshot the trace format wants and records the gap
    // honestly rather than inventing a trajectory.
    const snaps = probe.snapshots ?? {};
    const vp = snaps['tileset.viewport'] ?? snaps['playback.state'] ?? null;
    if (vp && typeof vp === 'object') {
      T.trajectorySource = snaps['tileset.viewport']
        ? 'tileset.viewport'
        : 'playback.state';
      const b = vp.bounds;
      T.events.push({
        ch: 'viewport',
        tMs: now,
        playheadMs:
          typeof vp.playheadMs === 'number'
            ? Math.round(vp.playheadMs)
            : typeof vp.time === 'number'
              ? Math.round(vp.time)
              : null,
        timeWindowMs:
          typeof vp.timeWindowMs === 'number'
            ? Math.round(vp.timeWindowMs)
            : typeof vp.timeWindow === 'number'
              ? Math.round(vp.timeWindow)
              : null,
        zoom: typeof vp.zoom === 'number' ? Math.round(vp.zoom) : null,
        bounds: Array.isArray(b)
          ? b.map((n) => Number(n))
          : b && typeof b === 'object'
            ? [b.west, b.south, b.east, b.north].map((n) => Number(n))
            : null,
        direction: vp.direction === -1 ? -1 : 1,
        animating: vp.animating !== false,
      });
    }
    T.samples++;
  };

  globalThis.__sttTraceDrain = drain;
  setInterval(drain, sampleMs);
}

async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(
      'node src/policy-record.mjs <demo-id> [seconds] [port] [--out p] ' +
        '[--sample-ms N] [--allow-trajectory-gap]\n',
    );
    return 0;
  }

  const demoId = positional[0] ?? 'severe-weather';
  const seconds = Number(positional[1] ?? 30);
  const port = Number(positional[2] ?? 3000);
  const sampleMs = Number(flags['sample-ms'] ?? 250);
  const warmupMs = Number(process.env.WARMUP_MS ?? 20000);
  const route = process.env.ROUTE ?? `/demo/${demoId}`;

  const require = createRequire(import.meta.url);
  // CommonJS: `playwright` has no named ESM exports.
  const { chromium } = require(
    require.resolve('playwright', { paths: [repoRoot] }),
  );

  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--enable-gpu', '--ignore-gpu-blocklist'],
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

  await page.addInitScript(installSampler, sampleMs, PROBE_CHANNELS);

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
    if (play && /play/i.test(play.getAttribute('aria-label') ?? ''))
      play.click();
  });
  await page.waitForTimeout(2000);

  // Arm: reset the clock origin and drop everything startup produced.
  const channelsPresent = await page.evaluate((chs) => {
    const probe = globalThis.__sttProbe ?? {};
    const present = chs.filter((c) => Array.isArray(probe[c]));
    for (const c of chs) if (Array.isArray(probe[c])) probe[c].length = 0;
    const T = globalThis.__sttTrace;
    T.events.length = 0;
    T.t0 = performance.now();
    T.armed = true;
    return present;
  }, PROBE_CHANNELS);

  await page.waitForTimeout(seconds * 1000);

  const captured = await page.evaluate(() => {
    globalThis.__sttTraceDrain?.();
    const T = globalThis.__sttTrace;
    T.armed = false;
    return {
      events: T.events,
      trajectorySource: T.trajectorySource,
      samples: T.samples,
    };
  });
  await browser.close();

  // ── Assemble the trace ────────────────────────────────────────────────────
  const events = [...captured.events].sort(
    (a, b) =>
      a.tMs - b.tMs ||
      (CHANNEL_RANK.get(a.ch) ?? 99) - (CHANNEL_RANK.get(b.ch) ?? 99) ||
      String(a.key ?? '').localeCompare(String(b.key ?? '')),
  );

  const viewportCount = events.filter((e) => e.ch === 'viewport').length;
  if (viewportCount === 0 && !flags['allow-trajectory-gap']) {
    process.stderr.write(
      '\n  !! NO TRAJECTORY RECORDED.\n' +
        '     The replay needs the viewport + playhead per step, and no package\n' +
        "     publishes a 'tileset.viewport' probe snapshot yet — `tileset.stats`\n" +
        '     carries cache counters only. A trace without a trajectory replays\n' +
        '     to an empty report, so it is NOT written.\n' +
        '     Publish the snapshot (viewport bounds, zoom, playheadMs,\n' +
        '     timeWindowMs, direction) or re-run with --allow-trajectory-gap to\n' +
        '     keep the channel capture for inspection.\n',
    );
    return 3;
  }

  // Bucket width, derived from the recorded keys rather than assumed: the
  // smallest positive gap between distinct bucket starts at one cell.
  const ts = [
    ...new Set(
      events
        .map((e) =>
          typeof e.key === 'string' ? e.key.split('/')[3] : undefined,
        )
        .map((s) => (s === undefined ? Number.NaN : Number(s.split('#')[0])))
        .filter((n) => Number.isFinite(n)),
    ),
  ].sort((a, b) => a - b);
  let derivedBucketMs = 0;
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0 && (derivedBucketMs === 0 || d < derivedBucketMs))
      derivedBucketMs = d;
  }

  const num = (v, fallback) => (v === undefined ? fallback : Number(v));
  const config = {
    temporalBucketMs: num(
      flags['bucket-ms'],
      derivedBucketMs || DEFAULT_CONFIG.temporalBucketMs,
    ),
    prefetchHorizonBuckets: num(
      flags.horizon,
      DEFAULT_CONFIG.prefetchHorizonBuckets,
    ),
    maxResidentTiles: num(flags['max-tiles'], DEFAULT_CONFIG.maxResidentTiles),
    maxResidentBytes: num(flags['max-bytes'], DEFAULT_CONFIG.maxResidentBytes),
    decodePoolSize: DEFAULT_CONFIG.decodePoolSize,
    decodeBytesPerMs: DEFAULT_CONFIG.decodeBytesPerMs,
    loopStartMs: num(flags['loop-start'], DEFAULT_CONFIG.loopStartMs),
    loopEndMs: num(flags['loop-end'], DEFAULT_CONFIG.loopEndMs),
  };

  const header = {
    ch: 'header',
    traceVersion: TRACE_VERSION,
    route,
    demoId,
    recordedAt: new Date().toISOString(),
    seconds,
    sampleMs,
    channelsPresent,
    trajectorySource: captured.trajectorySource ?? 'none',
    // Which config numbers were OBSERVED and which were assumed. A replay
    // report is only as honest as this line.
    configSource: derivedBucketMs
      ? 'bucketMs derived from recorded keys; limits from CLI/defaults'
      : 'all values from CLI/defaults (nothing observed)',
    consoleErrors: errors.length,
    config,
  };

  const outDir = path.join(repoRoot, 'tools/bench/out/traces');
  const stamp = header.recordedAt.slice(0, 10);
  const slug =
    route.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'route';
  const outPath = flags.out
    ? path.resolve(flags.out)
    : path.join(outDir, `${slug}-${stamp}.jsonl`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serializeTrace({ header, events }));

  const perChannel = new Map();
  for (const e of events) perChannel.set(e.ch, (perChannel.get(e.ch) ?? 0) + 1);
  process.stdout.write(
    `recorded ${events.length} events over ${seconds}s on ${route}\n`,
  );
  for (const ch of CHANNEL_RANK.keys()) {
    if (perChannel.has(ch)) {
      process.stdout.write(`  ${ch.padEnd(10)} ${perChannel.get(ch)}\n`);
    }
  }
  const missing = PROBE_CHANNELS.filter((c) => !channelsPresent.includes(c));
  if (missing.length) {
    process.stdout.write(
      `  ⚠  channels absent from this build: ${missing.join(', ')}\n`,
    );
  }
  if (errors.length) {
    process.stdout.write(
      `  ⚠  ${errors.length} console error(s) during capture\n`,
    );
  }
  process.stdout.write(`  wrote ${outPath}\n`);
  process.stdout.write(
    `  replay: node src/policy-replay.mjs ${path.relative(path.join(repoRoot, 'tools/bench'), outPath)} --all\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}

export { installSampler, main };
