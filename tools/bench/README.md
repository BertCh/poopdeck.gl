# @poopdeck.gl/bench

Two benchmarks over the `@poopdeck.gl/core` data-loading pipeline:

- **`pnpm bench`** — decode/cache throughput against a **local** `.stt`, offline.
- **`pnpm bench:cold-start`** — **requests and bytes to first frame** against a
  **deployed** dataset over real HTTP. [Jump to it](#cold-start-benchmark).

---

## Throughput benchmark (`pnpm bench`)

Performance benchmark for the `@poopdeck.gl/core` data-loading pipeline.

It exercises the real `STTArchive` reader entirely offline: instead of an HTTP
server, a custom file-backed `fetch` satisfies HTTP Range Requests by reading
byte ranges out of a local `.stt` file. This drives the genuine Range-request,
coalescing, decode and caching code paths with zero network setup.

## What it measures

1. **Archive open / index parse** — header + metadata + index parse time, tile
   count, spatial locations, archive size.
2. **Tile decode throughput** — tiles/sec, MB/sec (compressed and
   uncompressed), features decoded, decoded in-memory size, and per-tile
   latency p50 / p95 / p99 / max.
3. **Range-request coalescing** — individual `getTile()` calls vs. one
   coalesced `getTiles()` batch: request count, wall time, and reduction
   factor.
4. **Decompression: native vs pako** — native `DecompressionStream('gzip')`
   vs. the pure-JS `pako` fallback over many iterations, in MB/sec.
5. **Cache behavior** — the compressed-byte LRU cache: hits, misses,
   evictions, and hit rate, with a warm-pass verification.
6. **Compression ratio** — overall compressed vs. uncompressed bytes.

Tile decoding in the current `@poopdeck.gl/core` (Apache Arrow IPC pipeline) is
inline / synchronous — there is no web-worker pool.

## Running

```sh
node src/index.mjs [path-to.stt]
# or
pnpm bench
```

With no argument it uses the repo's `earthquakes.stt` (falling back to
`ships.stt`), resolved relative to the repo root regardless of the current
working directory.

Requires `@poopdeck.gl/core` to be built first (`pnpm --filter @poopdeck.gl/core build`).

> `src/loader-hook.mjs` is an ESM resolution shim registered by `index.mjs`.
> It lets the unmodified `@poopdeck.gl/core` `dist/` output load under Node's strict
> ESM resolver, which rejects the extensionless relative imports `tsc` emits.

The benchmarked archive must be built with the current `stt-build` /
`stt-generate` toolchain. An archive in an older tile format is detected up
front and reported with a clear message instead of an opaque decode error.

---

## Cold-start benchmark

`src/cold-start.mjs` answers the question a skeptic asks first, and the one the
paged directory exists to make good:

> Before a client can draw anything, how much of the archive must it fetch?

It is the STT analogue of COPC's "4 reads / ~110 KB on a 5.7 GB,
1.2-billion-point file". It reports **requests to first frame** and **bytes to
first frame** for a default viewport and playhead, split across the three object
classes the format defines: `manifest.json`, the paged directory
(`index/*.sttd`: root page + surviving leaf pages), and the tile blobs
(`packs/*.sttp`).

```sh
pnpm bench:cold-start                          # all three datasets
node src/cold-start.mjs earthquakes-v2         # one
node src/cold-start.mjs --verbose              # one line per HTTP request
node src/cold-start.mjs --repeat 5             # median wall time over N opens
node src/cold-start.mjs --cache-bust           # force a COLD edge (origin RTT)
node src/cold-start.mjs --json                 # machine-readable
node src/cold-start.mjs --base https://host/x  # another deployment
```

Unlike `pnpm bench`, this one needs the **network** — it opens live archives on
`tiles.poopdeck.gl`. Nothing is stubbed: it drives the real `STTArchive` behind
an instrumented `fetch` that records every request, its byte range, its response
size, and Cloudflare's `cf-cache-status`. A dataset whose manifest 404s is
reported as SKIPPED rather than guessed at.

### What is and isn't counted

Counted: the critical path to a first drawable frame — opening the archive and
resolving the first viewport's tiles at the default playhead
(`getTilesInBounds`), at the primary zoom the layer would pick.

**Not** counted: `SpatiotemporalTileset`'s speculative work — prefetch
lookahead, coarse parent-fallback levels, the overview storyboard tier. Those
are spent *after* the first frame is drawable. A real app's first-second traffic
is therefore higher than these numbers; what they bound is the critical path.

Committed results, with method, hardware and caveats:
[`docs/roadmap/measurements-2026-07.md`](../../docs/roadmap/measurements-2026-07.md).
