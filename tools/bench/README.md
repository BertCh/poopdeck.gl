# @poopdeck.gl/bench

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
