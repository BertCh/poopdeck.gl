# @poopdeck.gl/bench

Measurement instruments for the `@poopdeck.gl/core` data-loading pipeline.

| Command                    | Measures                                    | Where it runs          |
| -------------------------- | ------------------------------------------- | ---------------------- |
| `pnpm bench`               | decode / cache throughput — **INOPERABLE**  | offline, local `.stt`  |
| `pnpm bench:cold-start`    | requests + bytes to first frame             | real HTTP              |
| `pnpm bench:frame-cost`    | cost per **drawn frame**                    | live browser           |
| `pnpm bench:scrub-cost`    | what a timeline **drag** costs              | live browser           |
| `pnpm bench:policy-record` | captures a **policy trace**                 | live browser           |
| `pnpm bench:policy-replay` | replays a trace against **policy variants** | offline, deterministic |
| `pnpm test`                | the harness's own unit / determinism tests  | offline                |

**Which one answers your question.** If it is about pixels or frame pacing, it
is `frame-cost`. If it is about the network protocol, it is `cold-start`. If it
is about a _decision_ the loader made — what to prefetch, what to evict, what
to decode first — it is `policy-replay`, and only `policy-replay`:
[jump to it](#policy-trace-replay). If it is about what happens while the user
_drags the timeline_, it is [`scrub-cost`](#scrub-cost-the-scrublod-keep-vs-delete-evidence).

---

## Throughput benchmark (`pnpm bench`)

> ### ⚠️ INOPERABLE — it cannot open any archive this repo produces
>
> `bench.mjs` is written against the **single-file `.stt` container**, which the
> packed migration retired. Its `createFileFetch` answers every Range request
> out of one in-memory buffer, so a packed archive — `manifest.json` +
> `index/<hash>.sttd` + `packs/<hash>.sttp`, three object classes at three URLs —
> has nowhere to come from. Verbatim, 2026-08-10:
>
> ```
> $ node src/index.mjs tools/bench/baselines/earthquakes-ci.stt
> Error: STT manifest: invalid JSON (Unexpected token 'S', "STTqZ*"... is not valid JSON)
>
> $ node src/index.mjs crates/stt-core/tests/fixtures/v2-golden/single/manifest.json
> Error: STT directory truncated: got 5024 bytes, expected 156
> ```
>
> The first is the retired container being JSON-parsed as a manifest; the second
> is the manifest buffer being served back as the directory object. **Feeding it
> a freshly built archive does not help** — the limitation is the harness, not
> the fixture.
>
> The CI job that ran it (`bench-regression`) was retired on 2026-08-10 rather
> than left to launder confidence. The repair is a URL-aware local fetch, the
> way [`policy-replay.mjs`](./src/policy-replay.mjs) already does it: resolve the
> request URL against the archive directory and read that file. Everything below
> describes what this harness measured, and will measure again once that lands —
> see [`baselines/README.md`](./baselines/README.md) and
> [`docs/roadmap/measurements-2026-08.md` §8.6](../../docs/roadmap/measurements-2026-08.md).
>
> Nothing else in this directory is affected: `cold-start`, `frame-cost`,
> `scrub-cost`, `policy-record`, `policy-replay` and `pnpm test` all read the
> packed format correctly.

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
front and reported with a clear message instead of an opaque decode error —
but see the INOPERABLE note above: the _container_ check happens before that,
and today it rejects everything.

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
are spent _after_ the first frame is drawable. A real app's first-second traffic
is therefore higher than these numbers; what they bound is the critical path.

Committed results, with method, hardware and caveats:
[`docs/roadmap/measurements-2026-07.md`](../../docs/roadmap/measurements-2026-07.md).

---

## Policy trace replay

`src/policy-record.mjs` + `src/policy-replay.mjs` answer the question the other
two harnesses cannot:

> Did that policy change actually help, or did the network just have a good day?

Frame-cost and live QoE runs are browser sessions against a real network, so a
policy A/B drowns in transport noise; cold-start stops at first frame and never
exercises playback policy at all. So: **record once on a real route, then
replay offline against policy variants**, where the only thing that varies is
the policy.

### The fidelity boundary (read this before quoting a number)

The replayer models **policy decisions only** — demand, speculation, residency,
eviction order, decode-queue occupancy. It models:

- **no GPU or render feedback.** No frame pacing, no draw calls, no uploads.
  Anything render-coupled stays with `bench:frame-cost`.
- **no transport.** Fetches complete instantly on a mock clock. Removing
  transport noise is the entire point; latency claims belong to
  `bench:cold-start`.

A number out of this harness is a statement about what the policy _decided_,
never about what the screen _did_.

### Cost is always blended

Every cost it prints is `bytes + g·reads`. `g` defaults to 2 MiB — not invented
here, it is `DEFAULT_RANGE_COALESCE_GAP` in `packages/core/src/archive.ts`, the
reader's own standing "one extra request is worth this many bytes" estimate.
Override with `--read-cost-bytes` to test sensitivity.

Request count is reported as a _counter_, beside the bytes it cost. It is never
a cost and never a ranking key on its own — ranking by request count is a
standing rejection in the do-not-touch register (the 669 MiB "2 reads =
cheapest" incident), and there is a guard test for it.

### Recording

```sh
pnpm --filter @poopdeck.gl/showcase dev            # in another terminal
pnpm bench:policy-record severe-weather 30 3000
ROUTE=/drive pnpm bench:policy-record drive 30 3000
```

Traces land in `out/traces/<route>-<date>.jsonl` (JSON Lines; local artifacts,
not committed). The recorder enables `globalThis.__sttProbe`, plays the route,
and drains the core telemetry channels (`requests`, `decode`, `evict`, `scrub`,
`playback`) on a timer — draining matters because the probe rings cap at 4096
samples and a composite route overflows them in seconds.

> ⚠️ **The trajectory is a known gap.** A replay needs the viewport + playhead
> per step, and no package publishes a `tileset.viewport` probe snapshot yet
> (`tileset.stats` carries cache counters only). The recorder feature-detects
> that snapshot and, finding none, **refuses to write the trace** rather than
> emit one that replays to an empty report. Pass `--allow-trajectory-gap` to
> keep the channel capture for inspection anyway.

### Replaying

```sh
pnpm bench:policy-replay test/fixtures/micro-loop-boundary.jsonl --all
pnpm bench:policy-replay out/traces/demo-severe-weather-2026-08-10.jsonl \
  --variant incumbent --json
pnpm bench:policy-replay <trace> --archive path/to/archive/manifest.json
pnpm bench:policy-replay --list-variants
```

`--archive` takes the addressable tile set and its byte sizes from the archive
**directory** (`getTileByteSize`) instead of from the trace — measured entry
lengths, never an analytic size model. It accepts a packed archive directory, a
`manifest.json`, or an `https://` base. Without it the replay runs off the byte
sizes the recorder observed, which is what makes the committed micro-trace a
self-contained fixture.

Reported per variant: blended cost, bytes, reads, refetch cycles (the
fetch-evict-refetch of a key that was previously dropped), `runwayEvictions`,
evictions by tier, runway violations, and the decode-queue wait distribution.

### The variants

| Variant      | What it is                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `incumbent`  | The shipping playhead-relative tiered eviction, ported faithfully from `evictUnusedTiles`. The default, and the "before" for any policy claim. |
| `lru`        | Plain LRU — the tileset's own no-coverage fallback branch. The control that tiering replaced.                                                  |
| `loop-aware` | A **reference model**: circular playhead distance over the declared loop. Not a shipping policy; it exists to bound the loop pathology.        |
| `belady`     | The offline optimum. It reads the future, so it can never ship — it is the lower bound a real policy's claim is measured against.              |

Every variant changes exactly one thing: eviction order. A policy work item
that changes a controller registers its own variant here and pins its
before/after against `incumbent`.

### The committed micro-trace

`test/fixtures/micro-loop-boundary.jsonl` is a hand-written 22-line trace: one
spatial cell, eight 1000 ms buckets, a playhead that sweeps `0 → 7000` and then
**wraps to 0**. Cache holds 6 tiles; the prefetch horizon is 2 buckets.

It exists to pin a specific pathology. The incumbent measures playhead distance
_linearly_, so on the approach to the wrap it evicts buckets 0 and 1000 as
"furthest behind" — the exact tiles the wrap demands next. Replaying it yields
the pinned incumbent baseline:

| variant      | reads | bytes   | refetch cycles | of which on demand | runway evictions |
| ------------ | ----- | ------- | -------------- | ------------------ | ---------------- |
| `incumbent`  | 10    | 129 000 | **2**          | **1**              | **2**            |
| `lru`        | 11    | 142 000 | 3              | 1                  | 0                |
| `loop-aware` | 9     | 121 000 | 1              | 0                  | 0                |
| `belady`     | 9     | 121 000 | 1              | 0                  | 1                |

(`lru` reports zero runway evictions because the incumbent's own no-coverage
branch sets `runwayFrom = plan.length` — "nothing counts as a runway eviction".
That is faithful, and it is exactly why the counter alone is not a ranking:
`lru` is the most expensive variant in the table.)

That is the §9.4 "inverse of Belady" pathology as an executable before. The
numbers are asserted in `test/policy-replay.test.mjs`; if a policy change turns
that test red, re-pin it **deliberately**, in the item that changed the policy,
and record the delta.

### Determinism is the contract

Same trace + same variant ⇒ byte-identical JSON report. Every reported figure
is an integer; there is no wall clock, no RNG, no arrival-order or
Map-iteration dependence in any output-affecting path, and every sort carries a
total tiebreak. That is what makes the harness usable as an arbiter rather than
as an anecdote. `pnpm test` asserts it — including at the process boundary, by
running the CLI twice and diffing stdout.

---

## Scrub cost (the scrubLod keep-vs-delete evidence)

`src/scrub-cost.mjs` exists to settle one recorded question, and only that one:

> Should the `scrubLod` wiring be kept or deleted?

`scrubLod` — the tileset's scrub-time LOD "motion tier" — is a complete,
end-to-end tested capability with **zero call sites**. Nothing anywhere under
`examples/` passes it, across all three renderers. The roadmap calls it _counted
out_ rather than open and attaches a standing clause: if the revival triggers do
not fire by the next format revision, **delete the wiring rather than carry a
dark feature** ([playback-and-loading.md §7](../../docs/roadmap/playback-and-loading.md)).
The decision hinges on a measurement nobody had taken. This is that measurement.

### What it does

Opens a demo route, synthesizes a pointer drag across the real timeline
scrubber at **fixed, replayable velocities**, and reports the five recorded
criteria — with the motion tier **absent** (today's shipped state, and therefore
the baseline) and with it **enabled**.

| Metric                    | Read from                                   | Recorded target                    |
| ------------------------- | ------------------------------------------- | ---------------------------------- |
| scrub time-to-first-pixel | `ScrubQoeStats.timeToFirstPixelMs`          | **< 16.7 ms** from a resident tile |
| fresh-frame fraction      | `ScrubQoeStats.freshFrameFraction`          | ≥ baseline                         |
| bytes-during-scrub        | `ScrubQoeStats.bytesDuringScrub`            | **≤ baseline (hard)**              |
| settle-to-full-detail     | `ScrubQoeStats.settleMs`, polled to closure | reported, no threshold             |
| pop / oscillation count   | `ScrubQoeStats.tierSwitchCount`             | ~1–2 per drag                      |

plus the rollback drill (`scrubLod` off is byte- and behavior-identical).

```sh
pnpm --filter @poopdeck.gl/showcase dev            # in another terminal
pnpm bench:scrub-cost nyc-taxi 3000
ROUTE=/drive pnpm bench:scrub-cost drive 3000
WARMUP_MS=30000 pnpm bench:scrub-cost bixi 3000 --repeat 5
```

The heavy routes the revival trigger names are NYC taxi (~10 M vertices), the AV
cockpit (`ROUTE=/drive`), and BIXI. **One route cannot decide it**: §11.6 slates
the wiring for deletion only if the enabled state fails byte-discipline or
fresh-frame on _all three_. The printed verdict says so on every run.

### Bytes are the criterion that can condemn it

> "Bytes fetched during the drag ≤ the no-policy baseline — a motion tier that
> fetches MORE than full detail is worse than nothing."

That one is evaluated as a hard PASS/FAIL per velocity and is never averaged
away; any velocity failing it condemns the route. The others are targets.
`bytesDuringScrub` comes from the governor's own attribution (the `requests`
probe channel windowed over the drag bracket) and is cross-checked by an
independent sum the harness computes from the same channel — both appear in the
JSON, and a divergence between them is a bug in one of them, not a result.

### What it is not

- **It tunes nothing.** Two contracts are in the standing do-not-touch register
  and are _observed, never altered_: **preview-never-gates (G7)** — no gate may
  start the clock while the thumb is held — and the **restore invariant** — the
  fine tier is restored before the commit's readiness is measured. Both are
  asserted on every drag. A violation is a **hard failure of the run** (exit 4),
  not a metric: it means the thing being measured is no longer the thing that
  shipped.
- **It builds no controller.** Velocity-scaled degrade, scrub-velocity prefetch
  (ATLAS), and the Funkhouser–Séquin predictive LOD budget are all counted out.
  This produces evidence; it does not act on it.
- **It ships nothing.** `scrubLod` stays DEFAULT OFF and this harness adds
  **zero showcase call sites**. The enabled variant is produced entirely in the
  page context, by reaching the live `SpatioTemporalTileset` through the React
  fiber tree and calling its public `setOptions({ scrubLod })`. If that handle
  cannot be found, the enabled variant is reported as NOT-ACHIEVED and the run
  exits 5 — it is never silently replaced by a second baseline.
- **It judges no pixels.** Per the browser-verify protocol boundary, automated
  evaluation reads counters, bytes and frame timings; whether a demo _looks_
  right is the user's own in-browser pass. The one screenshot per variant exists
  solely to prove the canvas was not blank.
- **`timeToFirstPixelMs` is a lower bound.** The governor sees the clock and the
  buffered ranges, not the compositor, so it reports data readiness. The harness
  adds the render-side companion it can honestly measure —
  `firstFrameAfterGrabMs`, the gap from the grab to the next rAF callback — and
  labels it as such.

### Fairness

Cache warmth is the obvious confound, so **each variant gets its own page load**,
an identical warmup, and the same fixed drag order. Playback is paused before
the drag series (the clock is frozen under a held thumb anyway) so
bytes-during-scrub attributes to the drag rather than to background streaming;
`--keep-playing` opts out. Trajectories are pure functions of the scrubber's
bounding box and the velocity constants, so the same pixels are traversed in the
same order in every variant, and a box that moved between variants is flagged as
`geometryDrift` rather than quietly averaged in.

### Exit codes — a run that wrote a file is not automatically a result

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| 0    | measured                                                                     |
| 3    | nothing measured — no drag produced a `scrubstart`/`scrubend` bracket        |
| 4    | **hard failure** — preview-never-gates or the restore invariant did not hold |
| 5    | the enabled state was requested but the motion tier was never applied        |

### ⚠️ Standing blocker as of 2026-08-10

The working tree carries an **uncommitted** bump of `PACKED_FORMAT_VERSION` from
`2` to `3` in `packages/core/src/archive.ts`, and the reader gates on strict
equality. Every archive that exists — all 64 under
`examples/showcase/public/data`, and the whole live 68-archive fleet — is
`formatVersion: 2`, so a working-tree showcase build opens **nothing**:

```
[STL] Archive init failed: /data/<id>/manifest.json
      Error: STT manifest: unsupported formatVersion 2 (expected 3)
```

With no archive there is no tileset, no governor, no `requests` samples, and so
no §11.6 metrics. The driver still navigates, drags, and reports — it just
reports `UNOBSERVED` and exits 3. Run it against a build of `@poopdeck.gl/core`
whose format version matches the data (a HEAD-committed v2 build today, or the
whole tree once the v3 rebuild window lands).

Do **not** work around it by editing `PACKED_FORMAT_VERSION` in either
direction, and do **not** spoof the manifest's version at the fetch boundary:
v3 is a payload break, so a spoofed run would decode v2 bytes with v3 logic and
produce numbers that look plausible and are not.
