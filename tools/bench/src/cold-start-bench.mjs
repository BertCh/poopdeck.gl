/**
 * Cold-start benchmark — REQUESTS and BYTES to first frame, over real HTTP,
 * against a real deployed dataset.
 *
 * The question this answers is the one COPC's README answers for point clouds
 * ("4 reads / ~110 KB on a 5.7 GB, 1.2-billion-point file"): before a client can
 * draw ANYTHING, how much of the archive must it pull? For the STT packed
 * format that is
 *
 *   1. `manifest.json`                     — one whole-object GET
 *   2. the paged directory ROOT page       — one range GET (`rootLength` bytes)
 *   3. the surviving directory LEAF pages  — range GETs, after the root's
 *                                            bbox/zoom/time pruning
 *   4. the tile blobs for the viewport     — coalesced range GETs into the packs
 *
 * and nothing else. Steps 2-4 are exactly the paged directory's reason to
 * exist, so this is the number that says whether it earns its keep.
 *
 * The harness drives the REAL `@poopdeck.gl/core` `STTArchive` — the same
 * reader the browser runs — behind an instrumented `fetch` that counts every
 * request and every response byte. It is not a model of the protocol; it IS the
 * protocol.
 *
 * WHAT IS COUNTED. The critical path only: opening the archive and resolving
 * the first viewport's tiles at the default playhead, via `getTilesInBounds`.
 * That mirrors what `SpatiotemporalTileset` fetches on its first selection pass
 * at the primary zoom. It deliberately EXCLUDES the tileset's speculative
 * extras — prefetch lookahead, coarse parent-fallback levels, the overview
 * storyboard tier — because those are throughput spent after the first frame is
 * already drawable. A real app's total first-second traffic is therefore
 * HIGHER than these numbers; the first-frame critical path is what they bound.
 *
 * The viewport is derived exactly as `SpatioTemporalLayer` derives it:
 *   zoom   = clamp(floor(viewState.zoom), metadata.minZoom, metadata.maxZoom)
 *   bounds = the Web-Mercator unprojection of the canvas corners
 *   time   = [t - timeWindow/2, t + timeWindow/2]
 *
 * Usage:
 *   node src/cold-start.mjs                       # every dataset in the table
 *   node src/cold-start.mjs earthquakes-v2 flights
 *   node src/cold-start.mjs --json                # machine-readable
 *   node src/cold-start.mjs --repeat 3            # median of N cold opens
 *   node src/cold-start.mjs --base https://host   # different deployment
 *   node src/cold-start.mjs --cache-bust          # force a COLD edge (origin)
 */

import { performance } from 'node:perf_hooks';

const coreEntryUrl = import.meta.resolve('@poopdeck.gl/core');
const { STTArchive } = await import(coreEntryUrl);

// ---------------------------------------------------------------------------
// Datasets under test
//
// Three shapes, chosen to bracket the format's behaviour rather than flatter
// it: a SPARSE global event set, a DENSE trajectory set, and a SUMMARY-tier
// set. `view` is the demo's real default camera where the showcase registers
// one (examples/showcase/src/datasets.ts), so the numbers describe the view a
// visitor actually lands on. `timeWindow` likewise mirrors the demo.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://tiles.poopdeck.gl/data';

/** Canvas the viewport math assumes (a typical desktop map pane). */
const VIEWPORT_PX = { width: 1280, height: 800 };

const DATASETS = [
  {
    id: 'earthquakes-v2',
    shape: 'sparse global events',
    note: 'USGS M4.0+, 2020-2024. The /demo/earthquake-activity camera.',
    view: { longitude: 140, latitude: 20, zoom: 2 },
    timeWindow: 30 * 86_400_000,
    // Playhead at the dataset start, where a freshly loaded demo sits.
    playheadFraction: 0,
  },
  {
    id: 'flights',
    shape: 'dense trajectories',
    note: 'One day of US flight positions.',
    view: { longitude: -95, latitude: 38, zoom: 4 },
    timeWindow: 3_600_000,
    // Mid-span: a trajectory set is empty at t=0 (nothing has moved yet), so
    // the start of the range would flatter the numbers with an empty viewport.
    playheadFraction: 0.5,
  },
  {
    id: 'goes-glm-lightning',
    shape: 'summary tier (h3)',
    note: 'GOES GLM flashes, 14.4M features, h3 summary over z0-4.',
    view: { longitude: -95, latitude: 38, zoom: 3 },
    timeWindow: 900_000,
    playheadFraction: 0.5,
  },
];

// ---------------------------------------------------------------------------
// Viewport math (Web Mercator), mirroring SpatioTemporalLayer.getViewportBounds
// ---------------------------------------------------------------------------

const TILE_SIZE = 512;

function lonLatToWorld([lon, lat], scale) {
  const lambda = (lon * Math.PI) / 180;
  const phi = (lat * Math.PI) / 180;
  const x = (TILE_SIZE * (lambda + Math.PI)) / (2 * Math.PI);
  const y =
    (TILE_SIZE * (Math.PI - Math.log(Math.tan(Math.PI / 4 + phi / 2)))) /
    (2 * Math.PI);
  return [x * scale, y * scale];
}

function worldToLonLat([x, y], scale) {
  const wx = x / scale;
  const wy = y / scale;
  const lambda = (wx * 2 * Math.PI) / TILE_SIZE - Math.PI;
  const phi2 = Math.PI - (wy * 2 * Math.PI) / TILE_SIZE;
  const phi = 2 * (Math.atan(Math.exp(phi2)) - Math.PI / 4);
  return [(lambda * 180) / Math.PI, (phi * 180) / Math.PI];
}

/** Geographic bounds of a {longitude, latitude, zoom} camera on a WxH canvas. */
function viewportBounds(view, px) {
  const scale = Math.pow(2, view.zoom);
  const [cx, cy] = lonLatToWorld([view.longitude, view.latitude], scale);
  const [minLon, maxLat] = worldToLonLat(
    [cx - px.width / 2, cy - px.height / 2],
    scale,
  );
  const [maxLon, minLat] = worldToLonLat(
    [cx + px.width / 2, cy + px.height / 2],
    scale,
  );
  return {
    minLon: Math.max(-180, minLon),
    minLat: Math.max(-90, minLat),
    maxLon: Math.min(180, maxLon),
    maxLat: Math.min(90, maxLat),
  };
}

// ---------------------------------------------------------------------------
// Instrumented fetch
// ---------------------------------------------------------------------------

/**
 * Wraps `fetch`, recording one row per request: the object class (manifest /
 * directory / pack), the requested byte range, the response status, the bytes
 * the server actually returned, and Cloudflare's `cf-cache-status`.
 *
 * Response size is taken from `content-length`, which for a 206 is the length
 * of the range body — exact, and cheaper than buffering a clone. When the
 * header is missing the body is measured directly.
 */
function instrumentedFetch(log, cacheBust) {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const range = init?.headers?.Range ?? init?.headers?.range;
    // `--cache-bust` appends a nonce so Cloudflare's cache key misses and the
    // request goes to the R2 origin: the COLD-EDGE figure. Without it the
    // numbers are warm-edge (`cf-cache-status: HIT`), which is what a second
    // visitor in the same PoP actually experiences.
    const target = cacheBust
      ? `${url}${url.includes('?') ? '&' : '?'}__cb=${Math.random().toString(36).slice(2)}`
      : input;
    const t0 = performance.now();
    const res = await fetch(target, init);
    const cl = res.headers.get('content-length');
    let bytes = cl == null ? null : Number(cl);
    let body;
    if (bytes == null) {
      body = await res.arrayBuffer();
      bytes = body.byteLength;
    }
    log.push({
      kind: url.includes('/manifest.json')
        ? 'manifest'
        : url.includes('/index/')
          ? 'directory'
          : url.includes('/packs/')
            ? 'pack'
            : 'other',
      url,
      range: range ?? null,
      status: res.status,
      bytes,
      ms: performance.now() - t0,
      cache: res.headers.get('cf-cache-status'),
    });
    // Hand back an untouched response when the body was not consumed above.
    return body === undefined
      ? res
      : new Response(body, {
          status: res.status,
          statusText: res.statusText,
          headers: res.headers,
        });
  };
}

// ---------------------------------------------------------------------------
// One measurement
// ---------------------------------------------------------------------------

async function measure(spec, base, cacheBust) {
  const url = `${base}/${spec.id}/manifest.json`;
  const probe = await fetch(url, { method: 'GET' });
  if (!probe.ok) {
    return { id: spec.id, error: `manifest ${probe.status} at ${url}` };
  }
  const manifest = await probe.json();

  const log = [];
  // A brand-new archive per run: no in-memory byte cache, no directory, no
  // manifest — the same state a browser tab is in on first paint. OPFS is
  // absent in Node, so nothing persists between runs either.
  const archive = new STTArchive({
    url,
    fetch: instrumentedFetch(log, cacheBust),
  });

  const t0 = performance.now();
  const metadata = await archive.getMetadata();

  const zoom = Math.max(
    metadata.minZoom,
    Math.min(metadata.maxZoom, Math.floor(spec.view.zoom)),
  );
  const bounds = viewportBounds(spec.view, VIEWPORT_PX);
  const span = metadata.timeRange.end - metadata.timeRange.start;
  const playhead = metadata.timeRange.start + span * spec.playheadFraction;
  const timeRange = {
    start: playhead - spec.timeWindow / 2,
    end: playhead + spec.timeWindow / 2,
  };

  const tiles = await archive.getTilesInBounds(bounds, zoom, timeRange);
  const ms = performance.now() - t0;

  const by = (kind) => log.filter((r) => r.kind === kind);
  const sum = (rows) => rows.reduce((a, r) => a + r.bytes, 0);
  const features = tiles.reduce(
    (a, t) =>
      a + t.layers.reduce((b, l) => b + (l.features?.featureCount ?? 0), 0),
    0,
  );

  return {
    id: spec.id,
    shape: spec.shape,
    note: spec.note,
    // Dataset scale, for interpreting the cold-start cost.
    archiveBytes:
      (manifest.packs ?? []).reduce((a, p) => a + p.length, 0) +
      (manifest.directory?.length ?? 0),
    packBytes: (manifest.packs ?? []).reduce((a, p) => a + p.length, 0),
    packCount: (manifest.packs ?? []).length,
    directoryBytes: manifest.directory?.length ?? 0,
    directoryLayout: manifest.directory?.layout ?? 'single',
    directoryPages: manifest.directory?.pageCount ?? 1,
    directoryRootBytes: manifest.directory?.rootLength ?? 0,
    tileCount: metadata.tileCount ?? manifest.metadata?.tile_count,
    featureCount: manifest.metadata?.feature_count,
    // The measurement.
    zoom,
    bounds,
    timeRange,
    requests: log.length,
    bytes: sum(log),
    manifestRequests: by('manifest').length,
    manifestBytes: sum(by('manifest')),
    directoryRequests: by('directory').length,
    directoryFetchedBytes: sum(by('directory')),
    packRequests: by('pack').length,
    packBytes_fetched: sum(by('pack')),
    tilesDrawn: tiles.length,
    featuresDrawn: features,
    ms,
    cacheBust,
    cacheStatuses: [...new Set(log.map((r) => r.cache ?? 'none'))],
    log,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// `pnpm bench:cold-start -- --verbose` leaves a bare `--` in argv; drop it so
// it can never be mistaken for a dataset id.
const argv = process.argv.slice(2).filter((a) => a !== '--');
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  argv.splice(i, v == null ? 1 : 2);
  return v ?? true;
};

const asJson = argv.includes('--json');
if (asJson) argv.splice(argv.indexOf('--json'), 1);
const verbose = argv.includes('--verbose');
if (verbose) argv.splice(argv.indexOf('--verbose'), 1);
const base = String(flag('--base', DEFAULT_BASE)).replace(/\/$/, '');
const repeat = Number(flag('--repeat', 1));
const cacheBust = argv.includes('--cache-bust');
if (cacheBust) argv.splice(argv.indexOf('--cache-bust'), 1);

const wanted = argv.length
  ? DATASETS.filter((d) => argv.includes(d.id))
  : DATASETS;
if (wanted.length === 0) {
  console.error(
    `No dataset matched. Known: ${DATASETS.map((d) => d.id).join(', ')}`,
  );
  process.exit(1);
}

const fmtB = (b) =>
  b >= 1024 * 1024
    ? `${(b / 1024 / 1024).toFixed(2)} MiB`
    : b >= 1024
      ? `${(b / 1024).toFixed(1)} KiB`
      : `${b} B`;
const fmtN = (n) => (n == null ? '?' : n.toLocaleString('en-US'));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2
    ? s[(s.length - 1) / 2]
    : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const results = [];
for (const spec of wanted) {
  const runs = [];
  for (let i = 0; i < repeat; i++) {
    const r = await measure(spec, base, cacheBust);
    if (r.error) {
      results.push(r);
      break;
    }
    runs.push(r);
  }
  if (runs.length === 0) continue;
  const last = runs[runs.length - 1];
  results.push({
    ...last,
    ms: median(runs.map((r) => r.ms)),
    runs: runs.length,
  });
}

if (asJson) {
  console.log(
    JSON.stringify(
      results.map(({ log, ...r }) => (verbose ? { ...r, log } : r)),
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    console.log('');
    if (r.error) {
      console.log(`${r.id}: SKIPPED — ${r.error}`);
      continue;
    }
    console.log(
      `=== ${r.id} — ${r.shape} ${'='.repeat(Math.max(0, 34 - r.id.length - r.shape.length))}`,
    );
    console.log(`  ${r.note}`);
    const row = (l, v) => console.log(`  ${l.padEnd(26)} ${v}`);
    row('archive on disk', `${fmtB(r.archiveBytes)} in ${r.packCount} pack(s)`);
    row('features / tiles', `${fmtN(r.featureCount)} / ${fmtN(r.tileCount)}`);
    row(
      'directory',
      `${fmtB(r.directoryBytes)}, ${r.directoryLayout}, ${r.directoryPages} page(s), root ${r.directoryRootBytes} B`,
    );
    row(
      'viewport',
      `z${r.zoom}, ${VIEWPORT_PX.width}x${VIEWPORT_PX.height} px`,
    );
    console.log('  ' + '-'.repeat(52));
    row('REQUESTS to first frame', String(r.requests));
    row('BYTES to first frame', `${fmtB(r.bytes)} (${fmtN(r.bytes)} B)`);
    row('  manifest', `${r.manifestRequests} req, ${fmtB(r.manifestBytes)}`);
    row(
      '  directory (root+leaf)',
      `${r.directoryRequests} req, ${fmtB(r.directoryFetchedBytes)}` +
        ` — ${((r.directoryFetchedBytes / (r.directoryBytes || 1)) * 100).toFixed(1)}% of the directory`,
    );
    row('  tile blobs', `${r.packRequests} req, ${fmtB(r.packBytes_fetched)}`);
    row(
      'fraction of archive',
      `${((r.bytes / r.archiveBytes) * 100).toFixed(3)}%`,
    );
    row(
      'tiles / features drawn',
      `${fmtN(r.tilesDrawn)} / ${fmtN(r.featuresDrawn)}`,
    );
    row(
      'wall time',
      `${r.ms.toFixed(0)} ms` + (r.runs > 1 ? ` (median of ${r.runs})` : ''),
    );
    row(
      'cf-cache-status',
      `${r.cacheStatuses.join(', ')}${r.cacheBust ? '  (--cache-bust: forced to origin)' : ''}`,
    );
    if (verbose) {
      console.log('  ' + '-'.repeat(52));
      for (const e of r.log) {
        console.log(
          `  ${String(e.status).padEnd(4)} ${e.kind.padEnd(10)} ${fmtB(e.bytes).padStart(10)}  ${e.ms.toFixed(0)} ms  ${e.cache ?? '-'}  ${e.range ?? ''}`,
        );
      }
    }
  }
  console.log('');
}
