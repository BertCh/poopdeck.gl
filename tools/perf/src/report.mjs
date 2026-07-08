/**
 * Reporting helpers: percentile math, console table, JSON write, baseline diff.
 *
 * Frame times are in milliseconds. fps is derived as 1000/frame.
 *
 * The JSON report is the source of truth; the console table is a one-screen
 * digest derived from it.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Sort ascending and return percentile values. */
function percentiles(values, qs = [0.05, 0.5, 0.95, 0.99]) {
  if (!values || values.length === 0) {
    return Object.fromEntries(qs.map((q) => [q, 0]));
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) =>
    sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return Object.fromEntries(qs.map((q) => [q, at(q)]));
}

/** Summarize a single sample bucket from the page-probe snapshot. */
export function summarizeSample(label, sample) {
  const frames = sample.frames || [];
  const durationMs = (sample.endedAt || 0) - (sample.startedAt || 0);
  const fps = frames.map((f) => (f > 0 ? 1000 / f : 0));
  const framePct = percentiles(frames);
  const fpsPct = percentiles(fps);
  const longTasks = sample.longTasks || [];
  const longTasksTotalMs = longTasks.reduce((s, t) => s + t.duration, 0);
  return {
    label,
    durationMs,
    frameCount: frames.length,
    fps_mean:
      frames.length > 0 ? +((1000 * frames.length) / durationMs).toFixed(1) : 0,
    fps_p5: +fpsPct[0.05].toFixed(1),
    fps_p50: +fpsPct[0.5].toFixed(1),
    fps_p95: +fpsPct[0.95].toFixed(1),
    frame_p50_ms: +framePct[0.5].toFixed(2),
    frame_p95_ms: +framePct[0.95].toFixed(2),
    frame_p99_ms: +framePct[0.99].toFixed(2),
    frame_max_ms: frames.length > 0 ? +Math.max(...frames).toFixed(2) : 0,
    longTaskCount: longTasks.length,
    longTaskTotalMs: +longTasksTotalMs.toFixed(0),
    longTaskMaxMs:
      longTasks.length > 0
        ? +Math.max(...longTasks.map((t) => t.duration)).toFixed(0)
        : 0,
    networkCount: sample.networkCount || 0,
    networkMb: +((sample.networkBytes || 0) / 1024 / 1024).toFixed(2),
  };
}

/** Pretty-print a one-screen ASCII summary of a run. */
export function printConsoleSummary(run) {
  const W = (s, n) => String(s).padEnd(n);
  const Wr = (s, n) => String(s).padStart(n);

  console.log('');
  console.log('='.repeat(96));
  console.log(
    `${run.demo} [${run.backend}]   ${run.scenarios.length} scenarios   ` +
      `workers=${run.workerCount}   heap=+${run.heapDeltaMb.toFixed(1)}MB`,
  );
  console.log('='.repeat(96));

  console.log(
    `  ${W('scenario', 16)} ${Wr('fps_p50', 8)} ${Wr('fps_p5', 8)} ${Wr('frame_p95', 11)} ` +
      `${Wr('longTasks', 11)} ${Wr('maxLT', 8)} ${Wr('netMB', 8)}`,
  );
  console.log('  ' + '-'.repeat(94));
  for (const s of run.scenarios) {
    const jank = s.fps_p5 < 30 || s.frame_p95_ms > 33 || s.longTaskMaxMs > 100;
    const marker = jank ? '  <- jank' : '';
    console.log(
      `  ${W(s.label, 16)} ${Wr(s.fps_p50, 8)} ${Wr(s.fps_p5, 8)} ` +
        `${Wr(s.frame_p95_ms + 'ms', 11)} ${Wr(s.longTaskCount, 11)} ` +
        `${Wr(s.longTaskMaxMs + 'ms', 8)} ${Wr(s.networkMb, 8)}${marker}`,
    );
  }
  console.log('');
}

/** Write the structured run report. */
export function writeReport(outputDir, run) {
  fs.mkdirSync(outputDir, { recursive: true });
  const fname = `${run.demo}-${run.backend}-${run.startedAt.replace(/[:.]/g, '-')}.json`;
  const outPath = path.join(outputDir, fname);
  fs.writeFileSync(outPath, JSON.stringify(run, null, 2));
  return outPath;
}

/**
 * Compare a current run against a baseline. Returns regression list +
 * one-line-per-metric verdict. lower-is-better metrics: frame_p95_ms,
 * longTaskCount, longTaskMaxMs. higher-is-better: fps_p50, fps_p5.
 */
export function diffAgainstBaseline(current, baseline, tolerance = 0.15) {
  const regressions = [];
  const lines = [];
  // Index scenarios by label for cross-comparison.
  const cBy = Object.fromEntries(current.scenarios.map((s) => [s.label, s]));
  const bBy = Object.fromEntries(baseline.scenarios.map((s) => [s.label, s]));
  const labels = Array.from(
    new Set([...Object.keys(cBy), ...Object.keys(bBy)]),
  );

  for (const label of labels) {
    const c = cBy[label];
    const b = bBy[label];
    if (!c || !b) {
      lines.push(
        `  ${label.padEnd(16)} ${!c ? 'missing in current' : 'missing in baseline'}`,
      );
      continue;
    }
    const checks = [
      { key: 'fps_p50', dir: 'higher' },
      { key: 'fps_p5', dir: 'higher' },
      { key: 'frame_p95_ms', dir: 'lower' },
      { key: 'longTaskCount', dir: 'lower' },
      { key: 'longTaskMaxMs', dir: 'lower' },
    ];
    for (const { key, dir } of checks) {
      const cv = c[key];
      const bv = b[key];
      if (!Number.isFinite(bv) || bv === 0) continue;
      const rel = (cv - bv) / bv;
      const regressed = dir === 'lower' ? rel > tolerance : rel < -tolerance;
      const marker = regressed ? 'REGRESS' : 'ok';
      lines.push(
        `  ${label.padEnd(16)} ${key.padEnd(16)} ${bv} → ${cv} (${(rel * 100).toFixed(1)}%)  ${marker}`,
      );
      if (regressed)
        regressions.push({
          scenario: label,
          key,
          baseline: bv,
          current: cv,
          rel,
        });
    }
  }
  return { regressions, lines };
}

/** Standardize the run object shape so downstream tools can rely on it. */
export function buildRun({
  demo,
  backend,
  startedAt,
  durationMs,
  scenarios,
  workerCount,
  heapDeltaBytes,
  harnessVersion,
}) {
  return {
    schemaVersion: 1,
    harnessVersion,
    startedAt,
    demo,
    backend,
    durationMs,
    workerCount,
    heapDeltaMb: heapDeltaBytes / 1024 / 1024,
    scenarios,
  };
}
