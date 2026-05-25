import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DatasetMetrics } from './metrics.js';
import type { FidelityResult } from './fidelity.js';
import type { DatasetManifestEntry } from './manifest.js';

export interface AnchorResult {
  anchor: string;
  /** Absolute timestamp (ms) we scrubbed to. */
  time: number;
  metrics: DatasetMetrics | null;
  fidelity: FidelityResult | null;
}

export interface DatasetResult {
  dataset: DatasetManifestEntry;
  status: 'ok' | 'data-missing' | 'render-failed' | 'webgl-unavailable';
  errors: string[];
  /** Render renderer hint when known (e.g., SwiftShader, ANGLE). */
  rendererTag: string | null;
  anchors: AnchorResult[];
  warmupMetrics: DatasetMetrics | null;
  /** Time-to-first-frame in ms from navigation to canvas containing pixels. */
  ttffMs: number | null;
  /** Total bytes the network panel saw flow into `/data/*.stt` requests. */
  archiveBytes: number;
}

export interface SweepReport {
  generatedAt: string;
  durationMs: number;
  baseURL: string;
  results: DatasetResult[];
}

const formatMB = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} MB`);
const formatMs = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} ms`);
const formatPct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
const formatFps = (v: number | null) => (v == null ? '—' : `${v.toFixed(1)} fps`);

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusBadge(status: DatasetResult['status']): string {
  const map: Record<DatasetResult['status'], { bg: string; label: string }> = {
    ok: { bg: '#2ea043', label: 'OK' },
    'data-missing': { bg: '#9b6800', label: 'DATA MISSING' },
    'render-failed': { bg: '#cf222e', label: 'RENDER FAILED' },
    'webgl-unavailable': { bg: '#6e7781', label: 'NO WEBGL' },
  };
  const v = map[status];
  return `<span class="badge" style="background:${v.bg}">${v.label}</span>`;
}

function fidelityBadge(fid: FidelityResult | null): string {
  if (!fid) return '<span class="badge muted">no run</span>';
  if (fid.status === 'blessed') {
    return '<span class="badge" style="background:#6e7781">BLESSED</span>';
  }
  if (fid.status === 'capture-failed') {
    return '<span class="badge" style="background:#cf222e">CAPTURE FAILED</span>';
  }
  if (fid.status === 'size-mismatch') {
    return '<span class="badge" style="background:#9b6800">SIZE MISMATCH</span>';
  }
  const ratio = fid.diffRatio ?? 0;
  // Thresholds are deliberately loose because SwiftShader is non-deterministic
  // at the sub-pixel level. > 2% diff is the "something visibly changed" line.
  if (ratio > 0.02) {
    return `<span class="badge" style="background:#cf222e">DIFF ${formatPct(ratio)}</span>`;
  }
  if (ratio > 0.005) {
    return `<span class="badge" style="background:#9b6800">DRIFT ${formatPct(ratio)}</span>`;
  }
  return `<span class="badge" style="background:#2ea043">MATCH ${formatPct(ratio)}</span>`;
}

function metricsTable(m: DatasetMetrics | null): string {
  if (!m) return '<div class="muted">No metrics collected.</div>';
  const probeRow = (label: string, p: { count: number; p50: number; p95: number } | null) =>
    `<tr><td>${label}</td><td>${p ? p.count : '—'}</td><td>${p ? formatMs(p.p50) : '—'}</td><td>${p ? formatMs(p.p95) : '—'}</td></tr>`;
  return `
    <table class="metrics">
      <tr><th>fps</th><td>${formatFps(m.fps)}</td><th>frame p50/p95</th><td>${formatMs(m.frameTimeP50)} / ${formatMs(m.frameTimeP95)}</td></tr>
      <tr><th>frames</th><td>${m.frames}</td><th>worst frame</th><td>${formatMs(m.frameTimeMax)}</td></tr>
      <tr><th>heap used</th><td>${formatMB(m.jsHeapUsedMB)}</td><th>heap growth</th><td>${formatMB(m.jsHeapGrowthMB)}</td></tr>
      <tr><th>detailed mem</th><td>${formatMB(m.detailedMemoryMB)}</td><th>heap total</th><td>${formatMB(m.jsHeapTotalMB)}</td></tr>
      <tr><th>longtasks</th><td>${m.longTaskCount}</td><th>blocked / max</th><td>${formatMs(m.longTaskTotalMs)} / ${formatMs(m.longTaskMaxMs)}</td></tr>
    </table>
    <table class="probe">
      <thead><tr><th>probe channel</th><th>count</th><th>p50</th><th>p95</th></tr></thead>
      <tbody>
        ${probeRow('tilePrepare', m.tilePrepare)}
        ${probeRow('decode', m.tileDecode)}
        ${probeRow('consolidations', m.consolidations)}
        ${probeRow('renderLayers', m.renderLayers)}
      </tbody>
    </table>`;
}

function fidelityBlock(datasetId: string, anchor: AnchorResult, baseURL: string): string {
  const fid = anchor.fidelity;
  if (!fid) return '<div class="muted">No fidelity capture.</div>';
  const rel = (p: string | null) => (p ? path.relative(baseURL, p).replace(/\\/g, '/') : null);
  const current = rel(fid.currentPath);
  const baseline = rel(fid.baselinePath);
  const diff = rel(fid.diffPath);
  const cell = (label: string, src: string | null) => {
    if (!src || !fs.existsSync(path.join(baseURL, src))) {
      return `<figure class="empty"><figcaption>${label}</figcaption><div class="missing">missing</div></figure>`;
    }
    return `<figure><figcaption>${label}</figcaption><a href="${esc(src)}" target="_blank"><img src="${esc(src)}" loading="lazy" alt="${esc(label)} for ${datasetId} @ ${anchor.anchor}"/></a></figure>`;
  };
  return `
    <div class="fidelity-row">
      ${cell('baseline', baseline)}
      ${cell('current', current)}
      ${cell('diff', diff)}
    </div>
    <div class="fidelity-meta">${fidelityBadge(fid)} ${fid.reason ? `<span class="muted">${esc(fid.reason)}</span>` : ''}</div>`;
}

function datasetSection(d: DatasetResult, outputRoot: string): string {
  const header = `
    <header>
      <h2>${esc(d.dataset.name)} <span class="mono">${esc(d.dataset.id)}</span></h2>
      <div class="row">
        ${statusBadge(d.status)}
        <span class="muted">${esc(d.dataset.type)} · ${esc(d.dataset.url)} · ttff ${formatMs(d.ttffMs)} · archive ${(d.archiveBytes / (1024 * 1024)).toFixed(2)} MB</span>
      </div>
      ${d.errors.length ? `<details class="errors"><summary>${d.errors.length} error(s)</summary><pre>${esc(d.errors.join('\n'))}</pre></details>` : ''}
    </header>`;

  if (d.status !== 'ok' && !d.anchors.length) {
    return `<section class="dataset">${header}</section>`;
  }

  const anchorBlocks = d.anchors
    .map(
      (anchor) => `
      <article class="anchor">
        <h3>anchor ${anchor.anchor} <span class="muted">t = ${new Date(anchor.time).toISOString()}</span></h3>
        <div class="grid">
          <div>${metricsTable(anchor.metrics)}</div>
          <div>${fidelityBlock(d.dataset.id, anchor, outputRoot)}</div>
        </div>
      </article>`,
    )
    .join('\n');

  return `<section class="dataset">${header}${anchorBlocks}</section>`;
}

export function renderReport(report: SweepReport, outputRoot: string): string {
  const ok = report.results.filter((r) => r.status === 'ok').length;
  const total = report.results.length;
  const failed = report.results.filter((r) => r.status === 'render-failed').length;
  const missingData = report.results.filter((r) => r.status === 'data-missing').length;
  const fidelityRegressions = report.results.flatMap((r) =>
    r.anchors.filter((a) => (a.fidelity?.diffRatio ?? 0) > 0.02),
  ).length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>STT showcase render evaluation</title>
  <style>
    :root { color-scheme: dark; }
    body { font: 14px/1.45 ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; padding: 32px 40px; }
    h1 { font-size: 20px; margin: 0 0 8px; }
    h2 { font-size: 16px; margin: 0; display: flex; gap: 8px; align-items: center; }
    h3 { font-size: 14px; margin: 16px 0 8px; color: #8b949e; font-weight: 500; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: #8b949e; }
    .muted { color: #8b949e; font-size: 12px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; }
    .badge.muted { background: #30363d; color: #8b949e; }
    .row { display: flex; gap: 12px; align-items: center; margin-top: 6px; }
    .summary { display: flex; gap: 24px; padding: 16px 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 24px; }
    .summary div { display: flex; flex-direction: column; }
    .summary .label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.04em; }
    .summary .value { font-size: 22px; font-weight: 600; }
    section.dataset { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px 24px; margin-bottom: 16px; }
    section.dataset > header { border-bottom: 1px solid #21262d; padding-bottom: 12px; margin-bottom: 8px; }
    article.anchor { padding-top: 8px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
    @media (max-width: 1200px) { .grid { grid-template-columns: 1fr; } }
    table { border-collapse: collapse; font-size: 12px; }
    table.metrics td, table.metrics th { padding: 4px 10px; border-bottom: 1px solid #21262d; text-align: left; }
    table.metrics th { color: #8b949e; font-weight: 500; }
    table.probe { margin-top: 10px; width: 100%; }
    table.probe th, table.probe td { padding: 4px 8px; border-bottom: 1px solid #21262d; text-align: left; }
    table.probe th { color: #8b949e; font-weight: 500; font-size: 11px; }
    .fidelity-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
    .fidelity-row figure { margin: 0; }
    .fidelity-row figcaption { font-size: 11px; color: #8b949e; margin-bottom: 4px; }
    .fidelity-row img { width: 100%; height: auto; border: 1px solid #30363d; border-radius: 4px; background: #0d1117; }
    .fidelity-row .missing { padding: 24px; text-align: center; color: #6e7781; background: #0d1117; border: 1px dashed #30363d; border-radius: 4px; }
    .fidelity-meta { margin-top: 8px; }
    details.errors { margin-top: 8px; }
    details.errors pre { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 8px 10px; overflow: auto; font-size: 11px; max-height: 200px; }
  </style>
</head>
<body>
  <h1>STT showcase render evaluation</h1>
  <div class="muted">generated ${esc(report.generatedAt)} · ${(report.durationMs / 1000).toFixed(1)}s · ${esc(report.baseURL)}</div>
  <div class="summary">
    <div><span class="label">datasets</span><span class="value">${total}</span></div>
    <div><span class="label">ok</span><span class="value" style="color:#3fb950">${ok}</span></div>
    <div><span class="label">render-failed</span><span class="value" style="color:#f85149">${failed}</span></div>
    <div><span class="label">data-missing</span><span class="value" style="color:#d29922">${missingData}</span></div>
    <div><span class="label">fidelity regressions</span><span class="value" style="color:${fidelityRegressions ? '#f85149' : '#3fb950'}">${fidelityRegressions}</span></div>
  </div>
  ${report.results.map((d) => datasetSection(d, outputRoot)).join('\n')}
</body>
</html>`;
}

export function writeReport(report: SweepReport, outputRoot: string): {
  jsonPath: string;
  htmlPath: string;
} {
  fs.mkdirSync(outputRoot, { recursive: true });
  const jsonPath = path.join(outputRoot, 'report.json');
  const htmlPath = path.join(outputRoot, 'report.html');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(htmlPath, renderReport(report, outputRoot));
  return { jsonPath, htmlPath };
}
