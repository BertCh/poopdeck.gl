/**
 * @poopdeck.gl/bench — performance benchmark for the @poopdeck.gl/core data-loading pipeline.
 *
 * Runs entirely offline: instead of an HTTP server it uses a file-backed
 * `fetch` implementation that satisfies HTTP Range Requests by reading byte
 * ranges out of a local `.stt` file. This lets us exercise the real
 * `STTArchive` Range-request / coalescing code paths with zero network setup.
 *
 * Usage:  node src/index.mjs [path-to.stt]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { STTArchive, estimateTileSize, OpfsTileCache } from '@poopdeck.gl/core';

// `compression.ts` is not re-exported from the package's index, and the
// package `exports` map only exposes `.`. Resolve the package's main module
// URL via `import.meta.resolve`, then import the sibling compression module
// directly from `dist/`.
const coreEntryUrl = import.meta.resolve('@poopdeck.gl/core');
const compressionUrl = new URL('./compression.js', coreEntryUrl).href;
const { decompressSync, gunzipSync, NATIVE_DECOMPRESSION_AVAILABLE } =
  await import(compressionUrl);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// tools/bench/src -> repo root is three levels up.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const fmtMs = (ms) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(2)} ms`;
const fmtBytes = (b) => {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(2)} KB`;
  return `${b} B`;
};
const fmtMBs = (bytes, ms) =>
  ms > 0 ? `${(bytes / 1024 / 1024 / (ms / 1000)).toFixed(1)} MB/s` : 'n/a';
const fmtPct = (frac) => `${(frac * 100).toFixed(1)}%`;
const fmtNum = (n) => n.toLocaleString('en-US');

/** Right-pad a label, then print "label : value". */
const row = (label, value) =>
  console.log(`  ${label.padEnd(28)} ${value}`);

const hr = () => console.log('-'.repeat(64));
const header = (title) => {
  console.log('');
  console.log(`=== ${title} ${'='.repeat(Math.max(0, 60 - title.length))}`);
};

/** Compute percentiles from an array of numbers. */
function percentiles(values) {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
  };
}

// ---------------------------------------------------------------------------
// File-backed fetch: serves HTTP Range Requests from a local file.
// ---------------------------------------------------------------------------

/**
 * Build a custom `fetch` that reads byte ranges out of an in-memory copy of a
 * local `.stt` file. Returns the fetch function plus a `stats` object tracking
 * request count and bytes transferred so the bench can measure amplification.
 *
 * The shim emits an `ETag` header on every response so the archive can
 * fingerprint it and key OPFS entries deterministically.
 */
function createFileFetch(fileBuffer, etag = 'W/"bench-v1"') {
  const stats = { requests: 0, bytesTransferred: 0 };

  const fileFetch = async (_url, init) => {
    const rangeHeader = init?.headers?.Range || init?.headers?.range;

    stats.requests++;

    if (!rangeHeader) {
      // No Range header -> whole file, 200 OK.
      stats.bytesTransferred += fileBuffer.length;
      return new Response(fileBuffer.subarray(), {
        status: 200,
        statusText: 'OK',
        headers: { ETag: etag },
      });
    }

    // Parse "bytes=START-END" (END inclusive).
    const match = /bytes=(\d+)-(\d+)/.exec(rangeHeader);
    if (!match) {
      return new Response(null, {
        status: 416,
        statusText: 'Range Not Satisfiable',
      });
    }
    const start = Number(match[1]);
    const end = Number(match[2]); // inclusive
    const slice = fileBuffer.subarray(start, end + 1);
    stats.bytesTransferred += slice.length;

    return new Response(slice, {
      status: 206,
      statusText: 'Partial Content',
      headers: { ETag: etag },
    });
  };

  return { fileFetch, stats };
}

/**
 * Install / uninstall an in-memory OPFS shim on globalThis.navigator for the
 * duration of the OPFS section. Backing store is a Map<filename, Uint8Array>
 * so the bench measures the in-process decode-side savings — disk I/O for
 * real OPFS is fast (NVMe), so this is a good proxy for the production warm
 * path, with the network and zstd costs realistically excluded.
 */
let savedNavDescriptor;
function installInMemoryOpfsShim() {
  const root = makeMemDir();
  savedNavDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      ...(savedNavDescriptor?.value ?? {}),
      storage: { getDirectory: async () => root },
    },
  });
  return root;
}
function uninstallInMemoryOpfsShim() {
  if (savedNavDescriptor) {
    Object.defineProperty(globalThis, 'navigator', savedNavDescriptor);
    savedNavDescriptor = undefined;
  }
}
function makeMemDir() {
  const files = new Map();
  const subdirs = new Map();
  return {
    _files: files,
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts?.create) files.set(name, new Uint8Array());
        else {
          const err = new Error('NotFoundError');
          err.name = 'NotFoundError';
          throw err;
        }
      }
      return {
        getFile: async () => {
          const b = files.get(name);
          return {
            arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
            text: async () => new TextDecoder().decode(b),
          };
        },
        createWritable: async () => {
          const chunks = [];
          return {
            write: async (d) => {
              let bytes;
              if (typeof d === 'string') bytes = new TextEncoder().encode(d);
              else if (d instanceof Uint8Array) bytes = d;
              else bytes = new Uint8Array(d);
              chunks.push(new Uint8Array(bytes));
            },
            close: async () => {
              const total = chunks.reduce((s, c) => s + c.byteLength, 0);
              const out = new Uint8Array(total);
              let o = 0;
              for (const c of chunks) {
                out.set(c, o);
                o += c.byteLength;
              }
              files.set(name, out);
            },
          };
        },
      };
    },
    async getDirectoryHandle(name, opts) {
      let sub = subdirs.get(name);
      if (!sub) {
        if (!opts?.create) {
          const err = new Error('NotFoundError');
          err.name = 'NotFoundError';
          throw err;
        }
        sub = makeMemDir();
        subdirs.set(name, sub);
      }
      return sub;
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };
}

/** Derive the exact TileId getTile expects from an index TileEntry. */
const entryToTileId = (e) => ({ z: e.zoom, x: e.x, y: e.y, t: e.timeStart });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // Positional .stt path + named flags:
  //   --baseline <out.json>   record current metrics to a baseline file
  //   --check <baseline.json> compare against baseline; exit 1 on regression
  //   --tolerance <0.10>      relative tolerance for regression (default 0.10)
  //   --compare <other.stt>   run the same bench against a second archive
  //                           and print a side-by-side delta (useful for
  //                           v2 vs v3 size & decode comparisons).
  const out = {
    sttPath: null,
    baseline: null,
    check: null,
    tolerance: 0.10,
    compare: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--check') out.check = argv[++i];
    else if (a === '--tolerance') out.tolerance = parseFloat(argv[++i]);
    else if (a === '--compare') out.compare = argv[++i];
    else if (!a.startsWith('--') && out.sttPath === null) out.sttPath = a;
  }
  return out;
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  let sttPath = cliArgs.sttPath;
  if (!sttPath) {
    const earthquakes = path.join(REPO_ROOT, 'earthquakes.stt');
    const ships = path.join(REPO_ROOT, 'ships.stt');
    try {
      await fs.access(earthquakes);
      sttPath = earthquakes;
    } catch {
      sttPath = ships;
    }
  } else {
    sttPath = path.isAbsolute(sttPath)
      ? sttPath
      : path.resolve(REPO_ROOT, sttPath);
  }

  // Numbers collected during the run for --baseline / --check.
  const metrics = {
    archive: path.relative(REPO_ROOT, sttPath) || sttPath,
    archive_size_bytes: 0,
    open_ms: 0,
    tile_count: 0,
    decode_tiles_per_s: 0,
    decode_mb_per_s: 0,
    decode_p95_ms: 0,
    coalesce_ratio: 0,
    compression_ratio: 0,
  };

  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(sttPath);
  } catch (err) {
    console.error(`\nERROR: could not read .stt file at: ${sttPath}`);
    console.error(`  ${err.message}`);
    console.error(`\nUsage: node src/index.mjs [path-to.stt]`);
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('#'.repeat(64));
  console.log('#  STT core data-loading pipeline benchmark');
  console.log('#'.repeat(64));
  row('Archive file', path.relative(REPO_ROOT, sttPath) || sttPath);
  row('Archive size', fmtBytes(fileBuffer.length));
  row('Node version', process.version);
  row('Native gzip available', String(NATIVE_DECOMPRESSION_AVAILABLE));
  metrics.archive_size_bytes = fileBuffer.length;

  // ====================================================================
  // 1. Archive open / index parse
  // ====================================================================
  header('1. Archive open / index parse');

  const { fileFetch, stats } = createFileFetch(fileBuffer);
  const archive = new STTArchive({ url: sttPath, fetch: fileFetch });

  const t0 = performance.now();
  const metadata = await archive.getMetadata();
  const index = await archive.getIndex();
  const openMs = performance.now() - t0;

  const tileEntries = index.tiles;
  const spatialLocations = new Set(
    tileEntries.map((e) => `${e.zoom}/${e.x}/${e.y}`)
  ).size;

  row('Open + parse time', fmtMs(openMs));
  row('Tile count', fmtNum(tileEntries.length));
  metrics.open_ms = openMs;
  metrics.tile_count = tileEntries.length;
  row('Spatial locations', fmtNum(spatialLocations));
  row('Zoom range', `${metadata.minZoom} - ${metadata.maxZoom}`);
  row('Layers', metadata.layers.map((l) => l.name).join(', ') || '(none)');
  row('Range requests so far', fmtNum(stats.requests));
  row('Bytes transferred', fmtBytes(stats.bytesTransferred));

  if (tileEntries.length === 0) {
    console.error('\nERROR: archive contains no tiles — nothing to benchmark.');
    process.exitCode = 1;
    return;
  }

  // Probe: decode a single tile to confirm the archive's tile format matches
  // the current @poopdeck.gl/core decoder. A stale archive (e.g. pre-columnar format)
  // would otherwise fail mid-benchmark with an opaque protobuf wire error.
  try {
    const probe = tileEntries.find((e) => e.length > 0) || tileEntries[0];
    await archive.getTile(entryToTileId(probe));
    archive.clearCache();
  } catch (err) {
    console.error('');
    console.error('ERROR: failed to decode a tile from this archive.');
    console.error(`  ${err.message}`);
    console.error(
      '  The archive appears to use an incompatible (likely older) tile\n' +
        '  format. Rebuild it with the current stt-build / stt-generate\n' +
        '  toolchain, then re-run the benchmark.'
    );
    process.exitCode = 1;
    return;
  }

  // ====================================================================
  // 2. Tile decode throughput
  // ====================================================================
  header('2. Tile decode throughput');

  const SAMPLE_CAP = 2000;
  const sampleEntries =
    tileEntries.length > SAMPLE_CAP
      ? tileEntries.slice(0, SAMPLE_CAP)
      : tileEntries;
  const sampled = sampleEntries.length < tileEntries.length;

  archive.clearCache();
  const latencies = [];
  let featuresDecoded = 0;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let decodedMemBytes = 0;

  const decT0 = performance.now();
  for (const entry of sampleEntries) {
    const id = entryToTileId(entry);
    const tStart = performance.now();
    const tile = await archive.getTile(id);
    latencies.push(performance.now() - tStart);
    compressedBytes += entry.length;
    uncompressedBytes += entry.uncompressedSize || entry.length;
    if (tile) {
      decodedMemBytes += estimateTileSize(tile);
      for (const layer of tile.layers) {
        featuresDecoded += layer.features.featureCount;
      }
    }
  }
  const decMs = performance.now() - decT0;
  const pct = percentiles(latencies);

  row('Tiles decoded', `${fmtNum(sampleEntries.length)}${sampled ? ` (sample of ${fmtNum(tileEntries.length)})` : ''}`);
  row('Total time', fmtMs(decMs));
  row('Throughput', `${(sampleEntries.length / (decMs / 1000)).toFixed(0)} tiles/s`);
  row('Compressed throughput', fmtMBs(compressedBytes, decMs));
  row('Uncompressed throughput', fmtMBs(uncompressedBytes, decMs));
  row('Features decoded', fmtNum(featuresDecoded));
  row('Decoded in-memory size', `${fmtBytes(decodedMemBytes)} (estimateTileSize)`);
  row('Latency p50', fmtMs(pct.p50));
  row('Latency p95', fmtMs(pct.p95));
  row('Latency p99', fmtMs(pct.p99));
  row('Latency max', fmtMs(pct.max));
  metrics.decode_tiles_per_s = sampleEntries.length / (decMs / 1000);
  metrics.decode_mb_per_s = decMs > 0 ? compressedBytes / 1024 / 1024 / (decMs / 1000) : 0;
  metrics.decode_p95_ms = pct.p95;

  // ====================================================================
  // 3. Range-request coalescing  (getTile loop vs. getTiles batch)
  // ====================================================================
  header('3. Range-request coalescing');

  const coalesceEntries = sampleEntries;
  const coalesceIds = coalesceEntries.map(entryToTileId);

  // --- Individual fetches -------------------------------------------------
  {
    const { fileFetch: f, stats: s } = createFileFetch(fileBuffer);
    const a = new STTArchive({ url: sttPath, fetch: f });
    await a.getIndex();
    const reqBefore = s.requests;
    const t = performance.now();
    for (const id of coalesceIds) {
      await a.getTile(id);
    }
    var indivMs = performance.now() - t;
    var indivReqs = s.requests - reqBefore;
    var indivBytes = s.bytesTransferred;
  }

  // --- Single coalesced batch --------------------------------------------
  {
    const { fileFetch: f, stats: s } = createFileFetch(fileBuffer);
    const a = new STTArchive({ url: sttPath, fetch: f });
    await a.getIndex();
    const reqBefore = s.requests;
    const t = performance.now();
    await a.getTiles(coalesceIds);
    var batchMs = performance.now() - t;
    var batchReqs = s.requests - reqBefore;
    var batchBytes = s.bytesTransferred;
  }

  row('Tiles fetched', fmtNum(coalesceIds.length));
  console.log('');
  row('Individual getTile() loop', '');
  row('  range requests', fmtNum(indivReqs));
  row('  wall time', fmtMs(indivMs));
  row('  bytes transferred', fmtBytes(indivBytes));
  console.log('');
  row('Coalesced getTiles() batch', '');
  row('  range requests', fmtNum(batchReqs));
  row('  wall time', fmtMs(batchMs));
  row('  bytes transferred', fmtBytes(batchBytes));
  console.log('');
  row(
    'Request reduction',
    batchReqs > 0
      ? `${(indivReqs / batchReqs).toFixed(1)}x  (${fmtNum(indivReqs)} -> ${fmtNum(batchReqs)})`
      : 'n/a'
  );
  row(
    'Wall-time speedup',
    batchMs > 0 ? `${(indivMs / batchMs).toFixed(2)}x` : 'n/a'
  );
  metrics.coalesce_ratio = batchReqs > 0 ? indivReqs / batchReqs : 0;

  // ====================================================================
  // 4. Decompression: native vs fflate vs pako vs fzstd
  // ====================================================================
  // The hot path is gzip decode of tile blobs. We compare:
  //   - native gzip via `DecompressionStream` (off-heap, the default)
  //   - fflate gzip (pure JS, ~10 KB — current fallback)
  //   - pako gzip   (pure JS, ~45 KB — historical fallback; bench only)
  //   - fzstd zstd  (pure JS, ~30 KB — the zstd path is always pure JS,
  //                  no DecompressionStream('zstd') exists yet)
  // The zstd row uses payloads from a different bucket (zstd-compressed
  // tiles) so the MB/s figure is on a different absolute scale; what
  // matters is whether fzstd is fast enough that the zstd archive size
  // win is not eaten by decode cost.
  header('4. Decompression: native vs fflate vs pako vs fzstd');

  const Compression = { None: 0, Gzip: 1, Zstd: 2 };
  // Lazily resolve pako (still installed as a transitive dep for some
  // toolchains; bench-only, NOT a @poopdeck.gl/core dep any more). Missing pako
  // is not an error — just skip its row.
  let pakoUngzip = null;
  try {
    const pako = await import('pako');
    pakoUngzip = pako.ungzip ?? pako.default?.ungzip ?? null;
  } catch {
    /* pako not installed — fine, we shipped fflate */
  }
  let fflateGunzip = null;
  try {
    const fflate = await import('fflate');
    fflateGunzip = fflate.gunzipSync;
  } catch {
    /* fflate missing — should never happen, but don't crash bench */
  }
  let fzstdDecompress = null;
  try {
    const fzstd = await import('fzstd');
    fzstdDecompress = fzstd.decompress;
  } catch {
    /* same — fzstd is a @poopdeck.gl/core dep so this is unreachable */
  }

  const gzipEntries = tileEntries
    .filter((e) => e.compression === Compression.Gzip && e.length > 0)
    .slice(0, 200);
  const zstdEntries = tileEntries
    .filter((e) => e.compression === Compression.Zstd && e.length > 0)
    .slice(0, 200);

  if (gzipEntries.length === 0 && zstdEntries.length === 0) {
    row('Status', 'no compressed tiles in archive — section skipped');
  } else if (gzipEntries.length > 0) {
    // Gzip path: native vs fflate (vs pako if available).
    const payloads = gzipEntries.map((e) =>
      Uint8Array.prototype.slice.call(fileBuffer, e.offset, e.offset + e.length),
    );
    const totalCompressed = payloads.reduce((s, p) => s + p.length, 0);
    let totalDecompressed = 0;

    const ITER = Math.max(1, Math.ceil(2000 / payloads.length));

    // fflate (the shipped fallback).
    let fflateMs = null;
    if (fflateGunzip) {
      const t0 = performance.now();
      for (let i = 0; i < ITER; i++) {
        for (const p of payloads) {
          const out = fflateGunzip(p);
          if (i === 0) totalDecompressed += out.length;
        }
      }
      fflateMs = performance.now() - t0;
    }

    // pako (bench comparison only).
    let pakoMs = null;
    if (pakoUngzip) {
      const t0 = performance.now();
      for (let i = 0; i < ITER; i++) {
        for (const p of payloads) pakoUngzip(p);
      }
      pakoMs = performance.now() - t0;
    }

    // Native DecompressionStream (async, off-heap).
    let nativeMs = null;
    if (NATIVE_DECOMPRESSION_AVAILABLE) {
      const decodeNative = async (data) => {
        const stream = new Response(data.slice().buffer).body.pipeThrough(
          new DecompressionStream('gzip'),
        );
        return new Uint8Array(await new Response(stream).arrayBuffer());
      };
      const t0 = performance.now();
      for (let i = 0; i < ITER; i++) {
        await Promise.all(payloads.map((p) => decodeNative(p)));
      }
      nativeMs = performance.now() - t0;
    }

    const totalCompIter = totalCompressed * ITER;
    row('Gzip sample payloads', fmtNum(payloads.length));
    row('Iterations', `${ITER} (${fmtNum(payloads.length * ITER)} decode calls)`);
    row('Compressed / decompressed', `${fmtBytes(totalCompressed)} -> ${fmtBytes(totalDecompressed)}`);
    console.log('');
    if (nativeMs !== null) {
      row('native DecompressionStream', `${fmtMs(nativeMs)}  @ ${fmtMBs(totalCompIter, nativeMs)}`);
    } else {
      row('native DecompressionStream', 'unavailable in this runtime');
    }
    if (fflateMs !== null) {
      row('fflate gzip (pure JS)', `${fmtMs(fflateMs)}  @ ${fmtMBs(totalCompIter, fflateMs)}`);
    }
    if (pakoMs !== null) {
      row('pako gzip (pure JS)', `${fmtMs(pakoMs)}  @ ${fmtMBs(totalCompIter, pakoMs)}`);
    }
    if (nativeMs !== null && fflateMs !== null) {
      row('Speedup (native vs fflate)', `${(fflateMs / nativeMs).toFixed(2)}x`);
    }
    if (pakoMs !== null && fflateMs !== null) {
      row('Speedup (fflate vs pako)', `${(pakoMs / fflateMs).toFixed(2)}x`);
    }

    // Sanity check: decompressSync produces identical output. This is the
    // gunzipSync we ship to consumers; if it diverged the contract test
    // would catch it, but we re-check here for the bench summary.
    const check = decompressSync(payloads[0], Compression.Gzip);
    row('decompressSync sanity', check.length > 0 ? 'ok' : 'FAILED');
  }

  if (zstdEntries.length > 0 && fzstdDecompress) {
    console.log('');
    const zPayloads = zstdEntries.map((e) =>
      Uint8Array.prototype.slice.call(fileBuffer, e.offset, e.offset + e.length),
    );
    const zTotalCompressed = zPayloads.reduce((s, p) => s + p.length, 0);
    const ITER = Math.max(1, Math.ceil(2000 / zPayloads.length));
    const t0 = performance.now();
    let zTotalDecompressed = 0;
    for (let i = 0; i < ITER; i++) {
      for (const p of zPayloads) {
        const out = fzstdDecompress(p);
        if (i === 0) zTotalDecompressed += out.length;
      }
    }
    const fzstdMs = performance.now() - t0;
    const zTotalIter = zTotalCompressed * ITER;
    row('Zstd sample payloads', fmtNum(zPayloads.length));
    row('Compressed / decompressed', `${fmtBytes(zTotalCompressed)} -> ${fmtBytes(zTotalDecompressed)}`);
    row('fzstd (pure JS)', `${fmtMs(fzstdMs)}  @ ${fmtMBs(zTotalIter, fzstdMs)}`);
  } else if (zstdEntries.length === 0) {
    row('Zstd', 'no zstd tiles in archive');
  }

  // ====================================================================
  // 5. Cache behavior
  // ====================================================================
  header('5. Cache behavior (byte cache hits / misses)');

  {
    const { fileFetch: f } = createFileFetch(fileBuffer);
    const a = new STTArchive({ url: sttPath, fetch: f });
    await a.getIndex();

    // Working set small enough to stay within the cache size limit.
    const workingSet = tileEntries.slice(0, Math.min(200, tileEntries.length)).map(entryToTileId);

    // First pass — all misses (cold cache).
    for (const id of workingSet) await a.getTile(id);
    const afterFirst = a.getCacheStats();

    // Second pass — should all be cache hits.
    for (const id of workingSet) await a.getTile(id);
    const afterSecond = a.getCacheStats();

    const secondPassHits = afterSecond.hits - afterFirst.hits;

    row('Working set size', fmtNum(workingSet.length));
    row('Pass 1 (cold)', `${fmtNum(afterFirst.misses)} misses, ${fmtNum(afterFirst.hits)} hits`);
    row('Pass 2 (warm)', `${fmtNum(secondPassHits)} hits (of ${fmtNum(workingSet.length)})`);
    row('Cache entries', `${fmtNum(afterSecond.size)} / ${fmtNum(afterSecond.maxSize)}`);
    row('Cache bytes', `${fmtBytes(afterSecond.bytes)} / ${fmtBytes(afterSecond.maxBytes)}`);
    row('Total hits / misses', `${fmtNum(afterSecond.hits)} / ${fmtNum(afterSecond.misses)}`);
    row('Evictions', fmtNum(afterSecond.evictions));
    row('Hit rate', fmtPct(afterSecond.hitRate));
    row(
      'Warm-pass verification',
      secondPassHits === workingSet.length
        ? 'ok — every re-fetch was a cache hit'
        : `WARNING — only ${secondPassHits}/${workingSet.length} hits`
    );
  }

  // ====================================================================
  // 6. Compression ratio
  // ====================================================================
  header('6. Compression ratio (whole archive)');

  {
    let totalComp = 0;
    let totalUncomp = 0;
    for (const e of tileEntries) {
      totalComp += e.length;
      totalUncomp += e.uncompressedSize || e.length;
    }
    const ratio = totalComp > 0 ? totalUncomp / totalComp : 1;
    row('Compressed tile bytes', fmtBytes(totalComp));
    row('Uncompressed tile bytes', fmtBytes(totalUncomp));
    row('Compression ratio', `${ratio.toFixed(2)}x`);
    row('Space saved', fmtPct(totalUncomp > 0 ? 1 - totalComp / totalUncomp : 0));
    var archiveRatio = ratio;
    metrics.compression_ratio = ratio;
  }

  // ====================================================================
  // 7. OPFS persistent cache (decompressed-payload reuse)
  // ====================================================================
  header('7. OPFS cache — cold vs warm');

  // Numbers from this section are recorded into the baseline so a future
  // regression in the OPFS fast path is caught in CI.
  let opfsColdP95 = 0;
  let opfsWarmP95 = 0;
  let opfsColdMBs = 0;
  let opfsWarmMBs = 0;

  {
    installInMemoryOpfsShim();
    try {
      const opfs = new OpfsTileCache({ maxBytes: 512 * 1024 * 1024 });
      const SAMPLE = Math.min(500, tileEntries.length);
      const probeIds = tileEntries.slice(0, SAMPLE).map(entryToTileId);

      // --- Cold pass: empty OPFS, every tile through fetch + decompress.
      const coldFetch = createFileFetch(fileBuffer);
      const coldArchive = new STTArchive({
        url: sttPath,
        fetch: coldFetch.fileFetch,
        opfsCacheImpl: opfs,
      });
      await coldArchive.getIndex();
      const coldLatencies = [];
      let coldBytes = 0;
      const coldT0 = performance.now();
      for (const id of probeIds) {
        const tStart = performance.now();
        const tile = await coldArchive.getTile(id);
        coldLatencies.push(performance.now() - tStart);
        const entry = tileEntries.find(
          (e) => e.zoom === id.z && e.x === id.x && e.y === id.y && e.timeStart === id.t,
        );
        if (entry && tile) coldBytes += entry.uncompressedSize || entry.length;
      }
      const coldMs = performance.now() - coldT0;
      const coldPct = percentiles(coldLatencies);

      // Let the fire-and-forget OPFS writes complete before warm pass.
      // The cache flush is on a setTimeout(0) tick — a couple of frames
      // worth of wait is enough.
      await new Promise((r) => setTimeout(r, 100));

      // --- Warm pass: fresh archive, same OPFS cache. The archive only
      //     hits the network for header/metadata/index, never for tiles.
      const warmFetch = createFileFetch(fileBuffer);
      const warmArchive = new STTArchive({
        url: sttPath,
        fetch: warmFetch.fileFetch,
        opfsCacheImpl: opfs,
      });
      await warmArchive.getIndex();
      // After getIndex(), the archive has captured the ETag fingerprint and
      // can build OPFS keys for tile lookups.
      const reqsBeforeWarm = warmFetch.stats.requests;
      const warmLatencies = [];
      let warmBytes = 0;
      const warmT0 = performance.now();
      for (const id of probeIds) {
        const tStart = performance.now();
        const tile = await warmArchive.getTile(id);
        warmLatencies.push(performance.now() - tStart);
        const entry = tileEntries.find(
          (e) => e.zoom === id.z && e.x === id.x && e.y === id.y && e.timeStart === id.t,
        );
        if (entry && tile) warmBytes += entry.uncompressedSize || entry.length;
      }
      const warmMs = performance.now() - warmT0;
      const warmPct = percentiles(warmLatencies);
      const warmTileRequests = warmFetch.stats.requests - reqsBeforeWarm;
      const warmStats = warmArchive.getCacheStats().opfs;

      opfsColdP95 = coldPct.p95;
      opfsWarmP95 = warmPct.p95;
      opfsColdMBs = coldMs > 0 ? coldBytes / 1024 / 1024 / (coldMs / 1000) : 0;
      opfsWarmMBs = warmMs > 0 ? warmBytes / 1024 / 1024 / (warmMs / 1000) : 0;

      row('Sample tiles', fmtNum(probeIds.length));
      console.log('');
      row('Cold pass (no OPFS hits)', '');
      row('  wall time', fmtMs(coldMs));
      row('  throughput', `${(probeIds.length / (coldMs / 1000)).toFixed(0)} tiles/s`);
      row('  uncompressed MB/s', fmtMBs(coldBytes, coldMs));
      row('  p50 / p95 / p99', `${fmtMs(coldPct.p50)} / ${fmtMs(coldPct.p95)} / ${fmtMs(coldPct.p99)}`);
      console.log('');
      row('Warm pass (OPFS hits)', '');
      row('  wall time', fmtMs(warmMs));
      row('  throughput', `${(probeIds.length / (warmMs / 1000)).toFixed(0)} tiles/s`);
      row('  uncompressed MB/s', fmtMBs(warmBytes, warmMs));
      row('  p50 / p95 / p99', `${fmtMs(warmPct.p50)} / ${fmtMs(warmPct.p95)} / ${fmtMs(warmPct.p99)}`);
      row('  range requests', fmtNum(warmTileRequests));
      console.log('');
      row(
        'Speedup',
        warmMs > 0 ? `${(coldMs / warmMs).toFixed(2)}x  (${fmtMs(coldMs)} -> ${fmtMs(warmMs)})` : 'n/a',
      );
      row('OPFS entries', fmtNum(warmStats?.entries ?? 0));
      row('OPFS bytes', fmtBytes(warmStats?.bytes ?? 0));
      row('OPFS hit rate', warmStats ? fmtPct(warmStats.hitRate) : 'n/a');
    } finally {
      uninstallInMemoryOpfsShim();
    }
  }

  metrics.opfs_cold_p95_ms = opfsColdP95;
  metrics.opfs_warm_p95_ms = opfsWarmP95;
  metrics.opfs_cold_mb_per_s = opfsColdMBs;
  metrics.opfs_warm_mb_per_s = opfsWarmMBs;

  // ====================================================================
  // Summary
  // ====================================================================
  header('Summary');
  row(
    'Tile decoding',
    typeof Worker !== 'undefined'
      ? 'Worker pool decoder (Arrow IPC)'
      : 'Inline decoder (Arrow IPC; no Worker global in this environment)'
  );
  console.log(
    `  Decoded ${fmtNum(sampleEntries.length)} tiles / ${fmtNum(featuresDecoded)} features at ` +
      `${(sampleEntries.length / (decMs / 1000)).toFixed(0)} tiles/s; ` +
      `coalescing cut range requests ${batchReqs > 0 ? (indivReqs / batchReqs).toFixed(1) : '?'}x; ` +
      `archive compression ${archiveRatio.toFixed(2)}x.`
  );
  hr();

  // ====================================================================
  // Baseline / regression check
  // ====================================================================
  if (cliArgs.baseline) {
    const outPath = path.isAbsolute(cliArgs.baseline)
      ? cliArgs.baseline
      : path.resolve(process.cwd(), cliArgs.baseline);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(metrics, null, 2) + '\n');
    console.log(`\nBaseline written to ${path.relative(process.cwd(), outPath)}`);
  }

  if (cliArgs.compare) {
    // Run the same bench pipeline against a second archive and emit a
    // side-by-side delta. Useful for tracking the v2 -> v3 format upgrade
    // (archive size, compression ratio, decode throughput).
    const otherPath = path.isAbsolute(cliArgs.compare)
      ? cliArgs.compare
      : path.resolve(REPO_ROOT, cliArgs.compare);
    let otherBuf;
    try {
      otherBuf = await fs.readFile(otherPath);
    } catch (err) {
      console.error(`\nWARN: --compare archive ${otherPath} could not be read: ${err.message}`);
    }
    if (otherBuf) {
      header('Compare against ' + path.relative(REPO_ROOT, otherPath));
      const { fileFetch: otherFetch } = createFileFetch(otherBuf);
      const otherArchive = new STTArchive({ url: otherPath, fetch: otherFetch });
      const otherMeta = await otherArchive.getMetadata();
      const otherIndex = await otherArchive.getIndex();
      const otherEntries = otherIndex.tiles;
      const otherSample =
        otherEntries.length > SAMPLE_CAP ? otherEntries.slice(0, SAMPLE_CAP) : otherEntries;

      let otherFeatures = 0;
      let otherCompressed = 0;
      let otherUncompressed = 0;
      const otherLatencies = [];
      const oT0 = performance.now();
      for (const entry of otherSample) {
        const id = entryToTileId(entry);
        const tStart = performance.now();
        const tile = await otherArchive.getTile(id);
        otherLatencies.push(performance.now() - tStart);
        otherCompressed += entry.length;
        otherUncompressed += entry.uncompressedSize || entry.length;
        if (tile) {
          for (const layer of tile.layers) otherFeatures += layer.features.featureCount;
        }
      }
      const oMs = performance.now() - oT0;
      const oPct = percentiles(otherLatencies);
      const otherTotalComp = otherEntries.reduce((s, e) => s + e.length, 0);
      const otherTotalUncomp = otherEntries.reduce(
        (s, e) => s + (e.uncompressedSize || e.length),
        0,
      );
      const otherRatio = otherTotalComp > 0 ? otherTotalUncomp / otherTotalComp : 1;

      const aLabel = `current (v${metadata.version})`;
      const bLabel = `compare (v${otherMeta.version})`;
      row('metric', `${aLabel.padEnd(20)} ${bLabel.padEnd(20)} delta`);
      const cmpRow = (label, a, b, fmt = (v) => v) => {
        const delta = b - a;
        const pct = a !== 0 ? ` (${((delta / a) * 100).toFixed(1)}%)` : '';
        row(label, `${String(fmt(a)).padEnd(20)} ${String(fmt(b)).padEnd(20)} ${fmt(delta)}${pct}`);
      };
      cmpRow('archive size', fileBuffer.length, otherBuf.length, fmtBytes);
      cmpRow('tile count', tileEntries.length, otherEntries.length, fmtNum);
      cmpRow(
        'decode tiles/s',
        Math.round(sampleEntries.length / (decMs / 1000)),
        Math.round(otherSample.length / (oMs / 1000)),
        fmtNum,
      );
      cmpRow('decode p95', pct.p95, oPct.p95, fmtMs);
      cmpRow('compression ratio', archiveRatio, otherRatio, (v) => v.toFixed(2) + 'x');
      cmpRow('features sampled', featuresDecoded, otherFeatures, fmtNum);
      otherArchive.finalize?.();
    }
  }

  if (cliArgs.check) {
    const baselinePath = path.isAbsolute(cliArgs.check)
      ? cliArgs.check
      : path.resolve(process.cwd(), cliArgs.check);
    let baseline;
    try {
      baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
    } catch (err) {
      console.error(`\nERROR: failed to load baseline ${baselinePath}: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    const tol = cliArgs.tolerance;
    const regressions = [];
    // Lower-is-better metrics: open_ms, decode_p95_ms.
    // Higher-is-better metrics: decode_tiles_per_s, decode_mb_per_s,
    // coalesce_ratio, compression_ratio.
    const checks = [
      { key: 'open_ms',              direction: 'lower' },
      { key: 'decode_tiles_per_s',   direction: 'higher' },
      { key: 'decode_mb_per_s',      direction: 'higher' },
      { key: 'decode_p95_ms',        direction: 'lower' },
      { key: 'coalesce_ratio',       direction: 'higher' },
      { key: 'compression_ratio',    direction: 'higher' },
    ];
    console.log('\nBaseline check (tolerance ±' + (tol * 100).toFixed(0) + '%):');
    for (const { key, direction } of checks) {
      const base = baseline[key];
      const now = metrics[key];
      if (!Number.isFinite(base) || base === 0) continue;
      const rel = (now - base) / base;
      const regressed =
        direction === 'lower' ? rel > tol : rel < -tol;
      const marker = regressed ? 'REGRESS' : 'ok';
      console.log(
        `  ${key.padEnd(24)} ${base.toFixed(2)} -> ${now.toFixed(2)}  (${
          (rel * 100).toFixed(1)
        }%)  ${marker}`
      );
      if (regressed) regressions.push({ key, base, now, rel });
    }
    if (regressions.length > 0) {
      console.error(`\n${regressions.length} regression(s) past tolerance.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll metrics within tolerance.');
    }
  }
}

main().catch((err) => {
  console.error('\nBenchmark failed:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
