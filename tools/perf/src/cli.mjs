#!/usr/bin/env node
/**
 * stt-perf — real-WebGL perf harness for the STT showcase.
 *
 * Examples:
 *   stt-perf nyc-taxi-od-heatmap
 *   stt-perf nyc-taxi-paths --scenarios playback,zoom,paused-idle
 *   stt-perf nyc-taxi-paths --backend swiftshader
 *   stt-perf nyc-taxi-paths --baseline write
 *   stt-perf nyc-taxi-paths --baseline check --tolerance 0.15
 *
 * The showcase dev server must be reachable; the harness will not start it
 * (the existing tools/render-test playwright config already auto-starts it via
 * its own webServer block, but the perf harness deliberately stays decoupled —
 * you'll generally have the dev server up in another terminal). Use
 * STT_URL=http://localhost:3000 to override.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

import { launchOptions } from './browser-profile.mjs';
import { PAGE_PROBE_SCRIPT } from './page-probe.mjs';
import { settle, SCENARIOS } from './scenarios.mjs';
import { summarizeSample, printConsoleSummary, writeReport, buildRun, diffAgainstBaseline } from './report.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERF_ROOT = path.resolve(__dirname, '..');
const HARNESS_VERSION = '0.1.0';

const DEFAULT_SCENARIOS = ['playback', 'zoom', 'paused-idle'];

function parseArgs(argv) {
  const out = {
    demo: null,
    backend: 'gpu',
    scenarios: DEFAULT_SCENARIOS.slice(),
    baseURL: process.env.STT_URL || 'http://localhost:3000',
    baseline: null,            // 'write' | 'check' | null
    baselineFile: null,        // optional explicit path
    tolerance: 0.15,
    outputDir: path.join(PERF_ROOT, 'output'),
    initialLoadMs: 10_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--backend') out.backend = argv[++i];
    else if (a === '--scenarios') out.scenarios = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--baseline-file') out.baselineFile = argv[++i];
    else if (a === '--tolerance') out.tolerance = parseFloat(argv[++i]);
    else if (a === '--output-dir') out.outputDir = argv[++i];
    else if (a === '--initial-load-ms') out.initialLoadMs = parseInt(argv[++i], 10);
    else if (a === '--url') out.baseURL = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!a.startsWith('--') && !out.demo) out.demo = a;
    else {
      console.error(`Unknown arg: ${a}`);
      printHelp();
      process.exit(2);
    }
  }
  if (!out.demo) { printHelp(); process.exit(2); }
  for (const s of out.scenarios) {
    if (!SCENARIOS[s]) {
      console.error(`Unknown scenario: ${s}. Known: ${Object.keys(SCENARIOS).join(', ')}`);
      process.exit(2);
    }
  }
  if (out.baseline && !['write', 'check'].includes(out.baseline)) {
    console.error('--baseline must be "write" or "check"');
    process.exit(2);
  }
  return out;
}

function printHelp() {
  console.log(`
stt-perf — real-WebGL perf harness for STT showcase demos.

Usage:
  stt-perf <demo-id> [options]

Demo IDs (see examples/showcase/src/datasets.ts):
  earthquake-activity   flights   flight-paths    flight-trips
  hurricanes            nyc-rideshare             nyc-taxi-od-heatmap
  nyc-taxi-paths        nyc-taxi-trips            ship-traffic
  wildfires             satellites                satellite-trips-flat

Options:
  --backend gpu|swiftshader     WebGL backend (default: gpu)
  --scenarios LIST              Comma-separated scenarios (default: playback,zoom,paused-idle)
                                Known: ${Object.keys(SCENARIOS).join(', ')}
  --url URL                     Base URL of the showcase (default: http://localhost:3000)
  --baseline write|check        Write current run as baseline / check vs baseline
  --baseline-file PATH          Override the baseline JSON path
  --tolerance FRACTION          Regression tolerance for --baseline check (default: 0.15)
  --initial-load-ms MS          Settle time before the first scenario (default: 10000)
  --output-dir DIR              Where to write per-run JSON (default: tools/perf/output)
`);
}

async function runDemo(opts) {
  const { demo, backend, scenarios, baseURL, outputDir, initialLoadMs } = opts;

  const browser = await chromium.launch(launchOptions(backend));
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let runError = null;
  let scenarioResults = [];
  let workerCount = 0;
  let heapDeltaBytes = 0;

  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript({ content: PAGE_PROBE_SCRIPT });

    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`));

    const url = `${baseURL.replace(/\/$/, '')}/demo/${demo}`;
    console.log(`[perf] navigating to ${url} (backend=${backend})`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await settle(page, { initialLoadMs });

    // Run scenarios sequentially. Each scenario opens its own sample bucket
    // via __sttPerf.beginSample(label) and closes it with endSample().
    for (const scenarioName of scenarios) {
      const fn = SCENARIOS[scenarioName];
      console.log(`[perf]  scenario: ${scenarioName}`);
      try {
        await fn(page, { label: scenarioName });
      } catch (err) {
        console.error(`[perf]  scenario ${scenarioName} failed: ${err.message}`);
        // Continue with remaining scenarios; the report will note the failure.
        scenarioResults.push({ label: scenarioName, error: String(err.message || err) });
      }
    }

    const snapshot = await page.evaluate(() => window.__sttPerf.snapshot());
    workerCount = snapshot.workerUrls.length;
    heapDeltaBytes = snapshot.heap?.delta || 0;

    // Map snapshot.samples into the report shape, preserving original order.
    for (const scenarioName of scenarios) {
      if (scenarioResults.find((r) => r.label === scenarioName && r.error)) continue;
      const sample = snapshot.samples[scenarioName];
      if (!sample) {
        scenarioResults.push({ label: scenarioName, error: 'no sample data' });
        continue;
      }
      scenarioResults.push(summarizeSample(scenarioName, sample));
    }

    if (consoleErrors.length > 0) {
      console.log(`[perf]  console errors (${consoleErrors.length}):`);
      for (const e of consoleErrors.slice(0, 5)) console.log(`         ${e}`);
    }
  } catch (err) {
    runError = err;
    console.error(`[perf] run failed: ${err.message}`);
  } finally {
    await browser.close();
  }

  if (runError) throw runError;

  const durationMs = Date.now() - t0;
  const run = buildRun({
    demo,
    backend,
    startedAt,
    durationMs,
    scenarios: scenarioResults,
    workerCount,
    heapDeltaBytes,
    harnessVersion: HARNESS_VERSION,
  });

  printConsoleSummary(run);
  const outPath = writeReport(outputDir, run);
  console.log(`[perf] wrote ${path.relative(process.cwd(), outPath)}`);
  return { run, outPath };
}

async function handleBaseline(opts, run) {
  if (!opts.baseline) return 0;
  const baselineFile = opts.baselineFile || path.join(PERF_ROOT, 'baselines', `${run.demo}-${run.backend}.json`);
  if (opts.baseline === 'write') {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    fs.writeFileSync(baselineFile, JSON.stringify(run, null, 2));
    console.log(`[perf] baseline written: ${path.relative(process.cwd(), baselineFile)}`);
    return 0;
  }
  // 'check'
  if (!fs.existsSync(baselineFile)) {
    console.error(`[perf] no baseline at ${baselineFile} (use --baseline write first)`);
    return 1;
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
  const { regressions, lines } = diffAgainstBaseline(run, baseline, opts.tolerance);
  console.log(`\nBaseline check (tolerance ±${(opts.tolerance * 100).toFixed(0)}%):`);
  for (const l of lines) console.log(l);
  if (regressions.length > 0) {
    console.error(`\n${regressions.length} regression(s) past tolerance.`);
    return 1;
  }
  console.log('\nAll metrics within tolerance.');
  return 0;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let exitCode = 0;
  try {
    const { run } = await runDemo(opts);
    exitCode = await handleBaseline(opts, run);
  } catch (err) {
    console.error('[perf] fatal:', err.stack || err);
    exitCode = 1;
  }
  process.exit(exitCode);
}

main();
