# Measurements — browser frame cost, 2026-08

**What this file is.**
[`measurements-2026-07.md`](./measurements-2026-07.md) §6 lists, under "not
measured and worth measuring next", _"the same figures from a real browser"_.
This is that measurement, for the steady-state PLAYBACK frame rather than the
cold open — how much CPU a topline demo burns per drawn frame, where it goes,
and what changed when the four hot spots it found were fixed.

The cold-start file measures the network protocol. This one measures what
happens after the tiles have arrived and the playhead is moving.

Harness:
[`tools/bench/src/frame-cost.mjs`](../../tools/bench/src/frame-cost.mjs).

```sh
node tools/bench/src/frame-cost.mjs <demo-id> [seconds] [dev-server-port]

# /worlds and /drive are their own routes, not /demo/:id
ROUTE=/drive node tools/bench/src/frame-cost.mjs drive 12 3000
```

**§1–§7 are the 2026-08-03 frame-cost capture and are unchanged.** §8 onward
were added on **2026-08-10** by the optimization program's Phase 0 and turn
this file into the program's standing measurement record: §8 is the instrument
inventory (which harness exists, how it is invoked, what it emits, who owns
it), §9 is the K10 cold-start re-capture against the republished fleet, and
§10 is the evaluation matrix that binds every O1–O5 acceptance criterion to a
concrete instrument. Section numbers §1–§7 are load-bearing — `frame-cost.mjs`
cites `measurements-2026-08 §1` — so later work appends, it does not renumber.

---

## 1. The headline

One upstream bug in luma.gl 9.3.3 was re-uploading **every uniform block of
every model on every frame**, whether or not a single value in it had changed.
Cost scales with draw calls, so it hit the heaviest demos hardest.

| demo                  | before       | after        |                    |
| --------------------- | ------------ | ------------ | ------------------ |
| `storm-4d-greenfield` | **44.6 fps** | **86.8 fps** | p95 42.1 → 24.8 ms |
| `ocean-drifters`      | 101.0 fps    | 116.0 fps    | p95 16.9 → 9.2 ms  |
| `nyc-taxi-trips`      | 115.1 fps    | 116.3 fps    | p95 9.3 → 9.2 ms   |

The mechanism is visible in one number — **uniform-buffer writes per draw
call**, counted at the WebGL2 boundary:

| demo                  | `bufferSubData` / draw, before | after    |
| --------------------- | ------------------------------ | -------- |
| `storm-4d-greenfield` | 6.87                           | **1.03** |
| `ocean-drifters`      | 6.04                           | **1.49** |
| `nyc-taxi-trips`      | 6.04                           | **1.03** |

A deck.gl model carries roughly six uniform blocks (`project`, `layer`,
`picking`, the layer's own, plus each extension's). Exactly one of them —
`timeFilter`, carrying the playhead — actually changes between frames during
playback. The other five were being re-serialized and re-uploaded anyway.

`ocean-drifters` sits above 1.0 because it is a trips demo whose `project`
block genuinely changes every frame under the auto-rotating globe camera.

---

## 2. Where the frame went

CDP CPU profile, self time, `storm-4d-greenfield`, before the fix:

| frame                      | self % | what it is                        |
| -------------------------- | -----: | --------------------------------- |
| `updateUniformBuffer`      |   7.22 | luma, re-uploading unchanged UBOs |
| `ShaderInputs.setProps`    |   5.66 | merging module props, per model   |
| `getData`                  |   4.85 | re-serializing a UBO to bytes     |
| `UniformStore.setUniforms` |   3.31 | ↑                                 |
| `UniformBlock.setUniforms` |   3.03 | ↑                                 |
| `_flattenCompositeValue`   |   2.60 | ↑                                 |
| `bindBuffer`               |   8.56 | GL state for the above            |

That is ~27 % of one frame spent re-uploading uniform values that had not
moved, plus the GL traffic to bind the buffers it wrote.

---

## 3. The four changes

### 3.1 luma.gl `UniformBlock.setUniforms` — the upstream bug

`patches/@luma.gl__core@9.3.3.patch`, applied via `pnpm.patchedDependencies`.

```js
// upstream
this._setUniform(key, value);
if (!this.needsRedraw) {
  this.setNeedsRedraw(`${this.name}.${key}=${value}`);
}
```

`_setUniform` already early-returns when the value is unchanged. The redraw
flag beside it does not: it fires for the first key of **every** call. So every
block reported dirty on every `Model.predraw()`, and
`UniformStore.updateUniformBuffer()` re-serialized and re-wrote it.

The fix gates the flag on the same "did it change" signal `_setUniform` already
records:

```js
this._setUniform(key, value);
if (this.modifiedUniforms[key] && !this.needsRedraw) {
```

`modifiedUniforms` is set only on a real change and cleared by
`getAllUniforms()` on each write — i.e. it is exactly "changed since the last
upload".

**Why this cannot under-upload.** The skip is reached only when
`_setUniform` found the value equal, and it decides that with luma's own
`arrayEqual`, which is deliberately conservative: it returns `false` for
anything it cannot cheaply prove equal (non-number-array values, mismatched
lengths, arrays longer than 16). It never reports two different values as
equal, so the patch can only ever skip a write that would have been a no-op.
The first write is also safe: a block is constructed with
`needsRedraw = 'initialized'` and that flag is only cleared by an actual write,
so a lazily-created buffer is always populated before its first draw.

This is a defect in luma.gl, not in this project. The patch is a local
stopgap; it should be sent upstream and dropped when it lands.

### 3.2 `TimeFilterExtension.draw` — push the delta, not the block

`draw()` runs once per model per frame, which on a tiled layer is once per
visible tile. It was building a 12-key uniform object and handing all of it to
`setShaderModuleProps`, which walks every key and clones every value. Eleven of
the twelve are constants for the layer's lifetime.

It now caches the last block pushed and sends only `currentTime` in the steady
state — or nothing at all when the playhead has not moved. The full block is
re-sent whenever a real prop changes **or the layer's models were rebuilt**
(deck recreates models on a shader change, and a fresh model starts from the
module defaults, so a partial push there would silently render a layer with
`windowHalf: 0`).

Measured: `ShaderInputs.setProps` 8.97 % → 7.55 % on `storm-4d-greenfield`.
A modest win — most of that frame is deck.gl pushing its own module props, not
ours.

The field set is compile-enforced: `STATIC_UNIFORM_FIELDS` is declared
`satisfies Record<Exclude<keyof TimeFilterUniformProps, 'currentTime'>, true>`,
so adding a uniform to the block without adding it to the comparison fails
`tsc` rather than silently sticking that uniform at a stale value.

### 3.3 `DemoViewer` — split the space-time-cube overlay

The tile lattice and the now-plane shared one `useMemo` keyed on the 20 Hz UI
clock. The lattice is 12 line segments per loaded tile and does **not** move
with the playhead, but it was being rebuilt — new `data` array, new
`LineLayer` — 20 times a second, so deck.gl re-ran attribute generation and
re-uploaded its vertex buffers for geometry that had not changed.

Now the lattice memo excludes `currentTime` (only the single-quad now-plane
rides it), and the combined layer array is memoized so a non-cube demo hands
deck.gl an identical `layers` reference on a UI tick — which `LayerManager`
short-circuits outright.

### 3.4 `PlaybackControls` — one `Intl.DateTimeFormat`, not eighty a second

`formatDate` was `new Date(t).toLocaleString(undefined, {...})`. That is not a
cheap call: it re-normalizes the option bag and resolves a formatter every
time. The transport bar renders on the 20 Hz clock and formats at least four
timestamps per render, so it was resolving ~80 formatters a second to produce
four strings — 1.08 % of total CPU on the `ocean-drifters` profile.

Now one lazily-built formatter is reused. `Intl.DateTimeFormat.format` throws a
`RangeError` on a non-finite timestamp where `toLocaleString` degraded to the
string `'Invalid Date'`, so the non-fatal behaviour is preserved explicitly — a
malformed range should render a bad label, not take the transport bar down.

---

## 4. Where the topline demos stand now

Ten of the twelve shipped demos, steady-state playback, after the changes.
`cosmos-drive-dreams` (`/worlds`) and `argoverse-02678d04` (`/drive`) live on
their own routes and are not covered by this harness.

| demo                  |       fps | p50 ms | p95 ms | draws/frame | UBO/draw | visible tiles |
| --------------------- | --------: | -----: | -----: | ----------: | -------: | ------------: |
| `earthquake-activity` |  **44.7** |   18.0 |   41.1 |         346 |     1.23 |           252 |
| `storm-4d-greenfield` |  **86.8** |    8.4 |   24.8 |         189 |     1.03 |            18 |
| `severe-weather-2024` | **~78**\* |    9.2 |   25.2 |         170 |     1.05 |            42 |
| `osm-nyc-draw`        |     115.8 |    8.4 |    9.3 |          12 |     1.00 |          1866 |
| `ocean-drifters`      |     116.0 |    8.3 |    9.2 |          63 |     1.49 |            30 |
| `ship-traffic`        |     116.0 |    8.3 |    9.2 |          52 |     1.02 |            45 |
| `ecco-currents`       |     116.1 |    8.3 |    9.2 |          21 |     1.38 |             9 |
| `nyc-taxi-trips`      |     116.3 |    8.3 |    9.2 |          66 |     1.03 |            57 |
| `nyc-taxi-cube`       |     116.8 |    8.2 |    9.2 |           3 |     0.67 |            24 |
| `gtfs-nl`             |     117.0 |    8.3 |    9.2 |           3 |     1.00 |             2 |

**~117 fps is the vsync ceiling on this display**, not a measurement of
headroom. Seven of the ten are pinned to it — for those the question is no
longer frame rate but how much idle is left, and on `ocean-drifters` that went
from 11 % to 41 % of wall time.

\* `severe-weather-2024` is quoted from the two runs where the whole composite
had finished loading (77.8 and 79.1 fps). A third run caught it with only 4
draws/frame resident and reported 111.8 fps; that number describes a
half-loaded scene, not a fast one. Composite demos need a longer warm-up than
the harness default before their figures mean anything.

### 4.1 The two surfaces the harness had never covered

`/worlds` and `/drive` are two of the six home-grid demos and neither had ever
been profiled, because both live outside `/demo/:id`. Measured via the
harness's `ROUTE` override:

| surface   |      fps | p50 ms | p95 ms | draws/frame | program switches |
| --------- | -------: | -----: | -----: | ----------: | ---------------: |
| `/drive`  | **28.5** |   33.3 |   58.3 |         342 |             78.1 |
| `/worlds` |    110.9 |    8.6 |   12.1 |          27 |             14.0 |

**`/drive` is the slowest topline surface there is** — slower than
`earthquake-activity`, and it was invisible until now. `/worlds` is fine: 74 %
idle.

---

## 5. What is still slow, and why

The two slowest surfaces — `/drive` (28.5 fps) and `earthquake-activity`
(44.7 fps) — turn out to have the **same** root cause, and the luma fix moved
neither: both are **draw-call bound**, and both are drawing a small number of
points through a large number of sublayers.

`AnimatedPointLayer` now reports this directly on the `renderLayers` probe
channel (`points` and `offsets`, added with this pass) so the pathology is
visible instead of inferred:

| surface / layer          | tiles | sublayers |  points | **points per draw call** |
| ------------------------ | ----: | --------: | ------: | -----------------------: |
| `earthquake-activity`    |   248 |       248 |   3,169 |                 **12.8** |
| `/drive` LIDAR           |   145 |       145 |  63,935 |                  **441** |
| `ship-traffic` (healthy) |    25 |        25 | 404,514 |               **15,989** |

`ship-traffic` is what one-sublayer-per-tile is _for_, and it runs at the vsync
ceiling. The other two pay a draw call per tile for a handful of points each.

This is not a bug in `AnimatedPointLayer` — it renders one sublayer per tile on
purpose (zero-copy Arrow-backed attributes, additive streaming, no re-upload on
tile arrival), and the docstring records what the previous consolidating design
cost. It is a bad fit for a **sparse** resident set, and nothing currently
detects that case.

**Two things that look like fixes and are not** — both checked, both dead ends:

- _Temporal culling_ (skip sublayers whose features cannot intersect the render
  window). Ruled out on both: `earthquakes-v2` buckets at 1 day against a
  **30-day** render window, and `av-synthetic` sets `timeWindow: 2000` against
  ~0.1 s LIDAR sweeps. In both cases every resident tile is genuinely inside
  the window. Nothing to cull.
- _A wider load window than render window._ Not the case here; the two match.

### 5.1 The fix that does follow: cross-tile consolidation

Two forms, and the measurement says which is worth it where. `offsets` on the
probe is the count of distinct `timeOffset` values in the resident set — i.e.
the floor on how few sublayers the set can collapse to **without rebasing any
times**:

| surface               | sublayers now | grouped by shared `timeOffset` | fully consolidated |
| --------------------- | ------------: | -----------------------------: | -----------------: |
| `/drive` LIDAR        |           145 |                **20** (7.3× ↓) |                 ~1 |
| `earthquake-activity` |           248 |                  160 (1.55× ↓) |                 ~1 |

**Grouping by shared `timeOffset` is the safe form and it is nearly free to
build.** Tiles sharing an offset need no time rebasing at all: `absorbTile`'s
`delta = built.timeOffset - slabBaseOffset` is exactly `0` for such a group, so
the existing slab packer becomes a lossless copy and every attribute value and
uniform stays bit-identical to what ships today. It buys 7.3× on the worst
surface and only 1.55× on `earthquake-activity`.

**Full consolidation** (one buffer regardless of offset) needs times rebased
onto a common base, which is where the f32 precision contract bites. The
existing cumulative slab path already does this and rebases against
`timeRange.start` — acceptable there because "the reveal steps by days". A
windowed demo must instead rebase against the **first resident tile's** offset,
which bounds the packed span by the load window and therefore keeps the
quantization a constant fraction (~2⁻²⁴) of the window, whatever the window is.
That reasoning needs to be written down and tested before it ships.

Not attempted in this pass: the packer must also carry picking provenance
across a group (`SlabProvenance` / `findSlabProvenance` already exist for the
cumulative path and are reusable), and `buildSlabLayer` reads
`this.slabBaseOffset` for its `timeOffset` prop, so a per-group offset has to be
threaded rather than read off shared state.

Two non-FE alternatives remain open for `earthquake-activity` specifically:
coarsen the archive's temporal bucket (a 7-day bucket cuts resident tiles ~7×,
but that is a rebuild), or serve z2 from the summary tier
(`earthquakes-summary` (h3) exists but is excluded from the build).

---

## 6. Method

Chromium via Playwright, 1440×900, real GPU (`--use-gl=angle`). Each demo is
opened at `/demo/<id>`, given a fixed warm-up for tiles to stream and the
governor's start gate to open, set playing, and only then are counters reset —
so the figures describe steady-state playback, not startup.

Captured per run:

- **frame deltas** from a `requestAnimationFrame` chain (fps, p50/p95/p99)
- **a CDP CPU profile** at a 200 µs sampling interval, folded to self time by
  function and by source file
- **GL call counts**, by wrapping `WebGL2RenderingContext.prototype` —
  `drawElements*`/`drawArrays*`, `bufferSubData`, `bufferData`, `useProgram`,
  `bindVertexArray`
- **the `__sttProbe` channels** the layers already publish (`renderLayers`,
  `tilePrepare`, `consolidations`) and the `tileset.stats` snapshot
- **a screenshot**, so a "fast" reading cannot come from a blank canvas

---

## 7. Caveats

1. **Dev server, not a production build.** The showcase's `build` script runs
   `tsc --noEmit` first and the working tree does not currently typecheck
   (two pre-existing errors in `buildDemoLayers.ts` traced to in-flight
   `animated-path-layer.ts` edits), so a production bundle could not be
   profiled. This inflates the React share specifically: `jsxDEV` and
   React's development-mode work do not ship. It does **not** affect the luma
   findings — deck.gl and luma.gl are consumed pre-built and identical either
   way, and the GL call counts are measured at the browser boundary.

2. **One machine, one GPU, one display.** The ~117 fps ceiling is this
   display's refresh rate. Absolute fps is not portable; the draw-call and
   `bufferSubData` counts are.

3. **Composite demos vary run to run** depending on how much of the scene has
   loaded — see the `severe-weather-2024` note in §4. Any single reading of a
   composite should be checked against its resident draw count before it is
   quoted.

4. **`archive.stats` reports a 0 % hit rate on every demo measured** (e.g.
   `ocean-drifters`: 0 hits / 1155 misses / 655 evictions, holding 79 MB
   against a 512 MB byte budget while capped at 500 entries). This is not a
   frame-cost problem — the tileset's own decoded-tile cache sits above it at
   ~99.8 % and absorbs the repeats — but a second-level cache that never hits
   is holding tens to hundreds of MB for nothing. Worth a look; not
   investigated here.

5. **`/worlds` and `/drive` are unmeasured.** They are two of the six
   home-grid demos and they render through different surfaces.

---

## 8. The Phase 0 instrument inventory (P0-1)

**What this section is.** Everything in the optimization program
([problems](./optimization-problems-2026-08.md) →
[informed design](./optimization-informed-design-2026-08.md) →
[implementation plan](./optimization-implementation-plan-2026-08.md)) is
accepted or rejected against a number, so before any controller or encoder
changes, the instruments themselves get audited. This is that audit: per
harness, does it exist, how is it invoked, what does it emit, and which phase
owns it. §10's evaluation matrix resolves every acceptance criterion to a row
here, and a matrix cell whose instrument is missing from this table is a defect
in the matrix, not a gap in the tree.

**How it was verified.** Every row below was checked on **2026-08-10** against
the working tree as it then stood, not against the plan's transcription: the
file was opened, the invocation was parsed (`node --check`) and — where it
could run without a browser, a dev server or the live fleet — actually run.
Rows the plan got wrong are corrected in §8.2 and say so. Symbol citations are
`file:line` as of that date; the tree carries ~379 uncommitted files of
in-flight work, so locate symbols by name if a number has drifted.

### 8.1 Harness inventory

| Harness                                | Exists?                                               | Invocation                                                                                                                                                                                                                       | Output                                                                                                            | Owner phase                                |
| -------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Frame cost                             | YES                                                   | `node tools/bench/src/frame-cost.mjs <demo-id> [seconds] [port]`; `WARMUP_MS=`, `ROUTE=`, `OUT_DIR=`; `pnpm --filter @poopdeck.gl/bench bench:frame-cost`                                                                        | JSON + PNG in `OUT_DIR` (default `tools/bench/out/`): fps, p50/p95/p99, GL counters, CPU profile, probe channels  | Phase 1 acceptance (O1)                    |
| Cold start                             | YES — **cannot run on the working tree**, see §8.4 R1 | `pnpm --filter @poopdeck.gl/bench bench:cold-start -- [dataset ...] [--json] [--verbose] [--repeat N] [--base URL] [--cache-bust]`                                                                                               | stdout table or `--json`: requests / bytes to first frame, per-object breakdown, `cf-cache-status`                | P0-4 (K10), then M4/§7 pricing             |
| Playback QoE counters                  | YES                                                   | in-page: `governor.getQoeStats()`, `getScrubQoeStats()`, `getSourceRunways()`; also pushed on the `playback` probe channel                                                                                                       | `PlaybackQoeStats`, `ScrubQoeStats`, `SourceRunway[]`                                                             | Phase 1 (O1)                               |
| Tileset / archive cache counters       | YES (extended by P0-2)                                | in-page: `tileset.getCacheStats()`, `archive.getCacheStats()`; `tileset.stats` snapshot is captured by frame-cost                                                                                                                | `TilesetCacheStats` incl. `runwayEvictions`, `evictionsByTier`, `bytesEvicted`                                    | Phase 1 (O1)                               |
| Core probe channels                    | YES (extended by P0-2)                                | in-page: `__sttProbe`, channels `decode` / `tilePrepare` / `requests` / `evict` / `scrub`, snapshot `decodeQueue`                                                                                                                | 4096-sample rings; `DecodeQueueSnapshot { p50WaitMs, p95WaitMs, pending }`                                        | Phase 1 (O1), P0-3 trace format            |
| Trace recorder                         | YES (new, P0-3)                                       | `node tools/bench/src/policy-record.mjs <demo-id> [seconds] [port] [--out <path>]`; `ROUTE=/drive …`                                                                                                                             | JSON-lines trace, default `tools/bench/out/traces/<route>-<date>.jsonl`                                           | Phase 1 (O1)                               |
| Trace replayer                         | YES (new, P0-3)                                       | `node tools/bench/src/policy-replay.mjs <trace.jsonl> [--archive …] [--variant …] [--all] [--json]`; `--list-variants`                                                                                                           | deterministic JSON report: blended cost, refetch cycles, eviction by tier, decode-queue waits, invariant checks   | Phase 1 (O1)                               |
| Scrub cost                             | YES (new, P0-5) — see §8.4 R4                         | `node tools/bench/src/scrub-cost.mjs <demo-id> [port] [--variants a,b] [--velocities a,b] [--zoom-drop N] [--repeat N] [--settle-ms N] [--quiesce-ms N] [--keep-playing] [--out p] [--json]`; `ROUTE=`, `WARMUP_MS=`, `OUT_DIR=` | JSON + per-variant PNG in `OUT_DIR`: the five §11.6 metrics per (variant, velocity); exit 4 on a G7 violation     | P0-5 / §11.6 keep-vs-delete                |
| Ordering simulator                     | YES                                                   | library only: `crates/stt-core/src/ordering_sim.rs`, reached via `stt-build --blob-ordering measured` and `stt-optimize order-audit`                                                                                             | simulated blended range-read cost per candidate ordering                                                          | M4 (Phase 2)                               |
| `stt-optimize inspect`                 | YES                                                   | `stt-optimize inspect --archive <dir\|manifest.json> [--sample N] [--format text\|json] [-o out]`                                                                                                                                | per-zoom directory stats, dedup + compression ratios, per-column compressed cost                                  | M1 (Phase 2)                               |
| `stt-optimize diff`                    | YES                                                   | `stt-optimize diff --before <A> --after <B> [--sample N] [--format …] [--fail-on-growth PCT]`                                                                                                                                    | totals / per-zoom / per-column deltas; non-zero exit past the growth gate                                         | M1 (Phase 2), R1 (Phase 4)                 |
| `stt-optimize order-audit`             | YES                                                   | `stt-optimize order-audit --archive <dir> [--format …] [--strict]`                                                                                                                                                               | per-ordering measured cost + recommended `--blob-ordering`; `--strict` is the CI gate shape                       | M4 (Phase 2) — O2                          |
| `stt-optimize recommend --target-size` | **NO** — the flag does not exist                      | n/a (`recommend` today: `-i --time-field --time-format -o --show-command --explain`)                                                                                                                                             | n/a                                                                                                               | M3 (Phase 3) builds it — O3                |
| `stt-validate`                         | YES                                                   | `stt-validate <archive> [--json] [--fail-fast] [--skip-decode] [--sample N]`                                                                                                                                                     | cheap-tier + decode-tier findings; warnings never affect exit code                                                | M7 (Phase 4) — O4                          |
| Pitch×bearing selection matrix         | YES                                                   | `pnpm --filter @poopdeck.gl/layers test test/chassis-viewport-bounds.test.ts`                                                                                                                                                    | vitest pass/fail over 24×18 real `WebMercatorViewport` cameras                                                    | O5 coverage-correctness gate               |
| Bench regression baseline              | **RETIRED 2026-08-10** — §8.6                         | ~~`node tools/bench/src/index.mjs …/earthquakes-ci.stt --check …/earthquakes-ci.json --tolerance 0.15`~~ — job deleted, fixture deleted                                                                                          | none. `pnpm bench` itself is INOPERABLE against every archive this repo produces (§8.6)                           | closed; revival owned by `tools/bench/src` |
| Bench harness self-tests               | YES (new, P0-3) — now CI-wired                        | `pnpm --filter '@poopdeck.gl/bench' test`                                                                                                                                                                                        | 27 node:test cases: replay determinism, six conservation invariants, the request-count-is-not-a-ranking-key guard | standing gate (added §8.6)                 |
| Showcase probe                         | YES                                                   | `pnpm --filter @poopdeck.gl/render-test probe` against a running showcase dev server                                                                                                                                             | per-demo load verdict; fail-closed                                                                                | standing gate (not aesthetics)             |
| Determinism lane                       | YES (extended by P0-7)                                | `cargo test -p stt-core --test reproducible_build --test v2_golden`; `cargo test -p stt-build --test reproducible_pipeline`; `cargo test -p spatiotemporal-tiles --features cli --test build_cli_reproducible`                   | test pass/fail                                                                                                    | P5 spine — O2                              |
| Golden-pin gate                        | YES (new, P0-6)                                       | `node .github/scripts/check-golden-pins.mjs [--base <ref>] [--working-tree]`; self-test `node --test .github/scripts/check-golden-pins.test.mjs`                                                                                 | pass/fail + the §13.1 rationale on failure                                                                        | guards M2/R1 (Phase 4)                     |
| Roadmap-citation gate                  | YES                                                   | `node .github/scripts/check-roadmap-citations.mjs`                                                                                                                                                                               | count checked + any unresolved doc/§section                                                                       | standing gate                              |

**Runs actually executed during this audit** (the rest are browser-, server- or
fleet-dependent and were verified by reading and `node --check` only):

| Command                                                                           | Result                                                                      |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `node src/policy-replay.mjs --list-variants`                                      | 4 variants: `incumbent`, `lru`, `loop-aware`, `belady`                      |
| `node src/policy-replay.mjs test/fixtures/micro-loop-boundary.jsonl --all --json` | 4 reports, all six conservation invariants `ok`                             |
| `node --test "tools/bench/test/**/*.test.mjs"`                                    | 27 pass, 0 fail                                                             |
| `node .github/scripts/check-golden-pins.mjs`                                      | pass — "0 commit(s) checked in `origin/main..HEAD`"                         |
| `node --test .github/scripts/check-golden-pins.test.mjs`                          | 34 pass, 0 fail                                                             |
| `node .github/scripts/check-roadmap-citations.mjs`                                | pass — 272 citations checked, 107 with a §section                           |
| `stt-optimize inspect --archive …/v2-golden/single --sample 0`                    | directory-only pass, 6 tiles / 22 features, decode skipped                  |
| `cargo test -p stt-core --test reproducible_build --test v2_golden`               | 7 pass + 2 pass, 1 ignored                                                  |
| `cargo test -p stt-build --test reproducible_pipeline`                            | 2 pass                                                                      |
| `cargo test -p spatiotemporal-tiles --features cli --test build_cli_reproducible` | 2 pass, 4.43 s                                                              |
| `pnpm --filter @poopdeck.gl/layers` → `chassis-viewport-bounds`                   | 32 pass                                                                     |
| `pnpm --filter @poopdeck.gl/bench bench:cold-start -- earthquakes-v2`             | **FAILS** — `unsupported formatVersion 2 (expected 3)`                      |
| `node tools/bench/src/index.mjs …/earthquakes-ci.stt --check …`                   | **FAILS** — `STT manifest: invalid JSON (Unexpected token 'S', "STTqZ* "…)` |
| `node --check tools/bench/src/scrub-cost.mjs`                                     | first pass **FAILED**, re-run passes after the R4 fix (§8.4)                |
| `node src/scrub-cost.mjs --help`                                                  | usage printed, exit 0                                                       |

### 8.2 Where the tree differs from the plan's transcription

The implementation plan's P0-1 block records what the planning pass believed.
Six of its claims no longer describe the tree; reality is written down here so
the next reader does not chase a stale line number.

1. **`ci.yml` is 406 lines, not 389.** P0-6 added three steps to the
   `typescript` job (the golden-pin gate, its self-test, and the `fetch-depth: 0`
   checkout the gate's merge-base needs).

2. **Governor symbol lines all moved.** P0-2's telemetry work shifted them.
   Current: `PlaybackQoeStats` at
   [playback-governor.ts:260](../../packages/playback/src/playback-governor.ts),
   `ScrubQoeStats` at :299 (new), `SourceRunway` at :351,
   `getSourceRunways()` at :1250, `getQoeStats()` at :1275 (plan said :1067),
   `getScrubQoeStats()` at :1302 (new); the `playback` probe pushes are at
   :1671, :1749, :1875 (plan said :1407, :1485, :1611).

3. **`ScrubQoeStats` landed in `playback`, not in `core`.** The plan filed it
   under P0-2 item 3 as a core telemetry addition; it is implemented on the
   governor, which is where the `scrubstart` / `scrubend` bracket already
   lives. The `scrub` probe channel _is_ in
   [core telemetry.ts:57–62](../../packages/core/src/telemetry.ts) as planned —
   the governor emits onto it. Both halves exist; only the file assignment
   differs.

4. **The tileset eviction counters moved and grew.** `runwayEvictions++` is at
   [spatiotemporal-tileset.ts:4053](../../packages/core/src/spatiotemporal-tileset.ts)
   (plan said :3970), with `bytesEvicted` at :4104 and `evictionsByTier` at
   :4106; the public `getCacheStats()` getter is at :4538 and its return type
   `TilesetCacheStats` at :932.

5. **`cold-start-bench.mjs`'s dataset table is at :67, and it is hard-coded to
   three entries.** The K10 set is eight. See §8.4 R2.

6. **`recommend` has no `--auto` flag either.** The design doc's M3 discussion
   references `--auto` / `--auto=encode` behavior; the shipped `recommend`
   surface is `-i / --time-field / --time-format / -o / --show-command /
--explain` and nothing else. Only `--explain` surfaces lossy levers, and it
   never applies them — which is the no-thinning contract holding, and is worth
   knowing before M3 designs on top of it.

Two plan claims **confirmed exactly as written**: frame-cost's `ROUTE` support
(at [frame-cost.mjs:128](../../tools/bench/src/frame-cost.mjs), GL counters at
:85–114) needs no repair, and `stt-optimize diff`'s `--fail-on-growth` reads
the exact directory metric — per design M1 that gate is do-not-touch and this
audit did not touch it.

### 8.3 CI and test gates, read from `.github/workflows/ci.yml`

Thirteen jobs, read from the file rather than from the plan (**twelve since
`bench-regression` was retired later the same day — §8.6**). Triggers: `push`
to `main`/`master`, and every `pull_request`. Line numbers below are as first
read; `bench-regression`'s removal and the new bench-test step shift everything
after line ~316.

| Job                    | Line | What it runs                                                                                                                                                                                                 |
| ---------------------- | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rust`                 |    9 | `cargo test --workspace --locked` (default features — what `cargo install` users get)                                                                                                                        |
| `rust-all-features`    |   20 | `cargo test --workspace --all-features --locked`, debuginfo off to survive the runner's linker                                                                                                               |
| `rust-lint`            |   42 | `cargo fmt --all -- --check` + the curated clippy deny set (14 lints; `-D warnings` deliberately not used)                                                                                                   |
| `rust-feature-lanes`   |   89 | six `cargo check` lanes: lib-only, serve (both backends), serve-postgres, serve-duckdb, full cli, stt-build no-geoparquet                                                                                    |
| `rust-package`         |  112 | `cargo package --workspace --exclude stt-generate --locked`                                                                                                                                                  |
| `rust-msrv`            |  127 | `cargo check` on 1.87 over the four published crates                                                                                                                                                         |
| `rust-duckdb`          |  144 | `cargo test -p stt-build --features duckdb`, plus the `--lib -- --include-ignored` spatial-SQL test                                                                                                          |
| `rust-postgres-parity` |  176 | `cargo test -p stt-build --features postgres --test source_parity -- --ignored` against a PostGIS service                                                                                                    |
| `python`               |  205 | three data-generation tests (AV palette parity, av_common worldbuild/tracks, LOD home-zoom)                                                                                                                  |
| `typescript-lint`      |  226 | `pnpm lint` (oxlint, correctness category) + `pnpm format:check` (oxfmt, **docs included**)                                                                                                                  |
| `typescript`           |  252 | sync-versions → **roadmap-citation gate** → **golden-pin gate** → **golden-pin self-test** → install → build → capabilities-doc gate → 8 typechecks → 9 vitest suites → **bench harness tests** → smoke-pack |
| ~~`bench-regression`~~ |    — | **RETIRED 2026-08-10, §8.6.** Never able to pass; its 27-test replacement now runs inside `typescript`                                                                                                       |
| `showcase-probe`       |  357 | dev server + `pnpm --filter @poopdeck.gl/render-test probe`, `VITE_DATA_BASE_URL=https://tiles.poopdeck.gl`                                                                                                  |

Four of these are gates this program depends on directly, so their order inside
`typescript` matters: sync-versions, roadmap citations, golden pins and the
golden-pin self-test all run **before** `pnpm install`, so drift fails in
seconds rather than behind a full build. Two of them are new this wave (the
golden-pin pair, P0-6) and the backlog's green definition
([README.md:124](./README.md)) already names the golden-pin gate.

**Golden-pin gate scope, stated precisely.** `PINNED_ROOTS`
([check-golden-pins.mjs](../../.github/scripts/check-golden-pins.mjs)) watches
`crates/stt-core/tests/fixtures/v2-golden/**` plus any file named
`expected-hashes.json` anywhere. As first read it did **not** watch
`packages/core/test/fixtures/**` (six TS-side read fixtures:
`legacy-shape`, `packed-golden`, `paged-golden`, `paged-golden-single`,
`v2-golden`, `v2-golden-tracks`), and this section recorded that as a deliberate
scoping — the Rust tree is the encoder's oracle and the TS fixtures are
read-side.

> **SUPERSEDED the same day.** That scoping does not survive the numbers: the
> unwatched tree carries 121 churning objects to the watched tree's 11, produced
> by the same Rust writer and pinned byte-for-byte by four TS suites. It joined
> `PINNED_ROOTS` on 2026-08-10 — see **§8.6**, which also explains why the
> read-side was the _more_ dangerous half to leave open.

### 8.4 The T2 honesty note, and the repair list

> **T2 — GitHub Actions has never executed in this repository.** Every gate in
> §8.3 is _config that has only ever been run by hand._ Zero bot commits across
> the repo's history, no release PR
> ([README.md:222–234](./README.md)). Until T2's accept — one green run on
> GitHub's own runners — lands, **"CI-enforced" in this program means
> "enforced by local discipline"**, which is exactly what the rest of the
> project's green definition already means. This is not a hedge: running every
> job locally on 2026-07-31 found **four red jobs invisible to a plain
> `cargo test --workspace`** (`rust-feature-lanes` 3-of-6, `rust-all-features`,
> `rust-lint`, `ts-lint`). Any later item in this program that says its rule is
> "CI-enforced" — P0-6's golden-pin gate and P0-7's determinism lane in
> particular — inherits this caveat verbatim, and inherits the discipline that
> substitutes for it: run the gate before you claim it.

The repair list, in priority order. **R1 and R2 were found by P0-4; R3 and R4
were found by this audit — R4 is already fixed, R3 is not.**

**R1 — `cold-start.mjs` cannot run on the working tree.**
`packages/core/src/archive.ts:96` carries an uncommitted bump of
`PACKED_FORMAT_VERSION` from `2` (at HEAD `5bc30e3`) to `3`, and the manifest
check at :1397 is strict equality, so a working-tree reader cannot open the
live `formatVersion: 2` fleet at all. Reproduced first-hand during this audit:

```
Error: STT manifest: unsupported formatVersion 2 (expected 3)
    at STTArchive.fetchManifest (packages/core/dist/archive.js:1029)
    at measure (tools/bench/src/cold-start-bench.mjs:223)
```

Documented workaround, and the one §9 used: run against a **HEAD-committed**
(v2) build of `@poopdeck.gl/core`. Never "fix" this by changing
`PACKED_FORMAT_VERSION` in either direction — the v3 break is in flight and
rides rebuild window R1. **The repair is a harness one:** the reader has no
version-negotiation path and no useful error for a client/fleet version skew,
and Phase 4 re-runs the K10 capture after R1, so it hits this same wall again
unless the capture is sequenced _after_ the republish or run against a pinned
reader. Owner: whoever executes the Phase 4 K10 re-run.

**R2 — `cold-start-bench.mjs`'s `DATASETS` table covers 3 of the 8 K10
datasets.** Hard-coded at
[cold-start-bench.mjs:67](../../tools/bench/src/cold-start-bench.mjs). The five
formerly-404 datasets (`gtfs-ch`, `rainfall-2019`, `storm4d-isolines`,
`wpc-fronts`, `wpc-fronts-pips`) cannot be measured through the shipped CLI.
§9 measured them via a scratchpad copy with five rows appended to `DATASETS`
and **no change to any measurement code**; folding those rows into the real
harness is a one-file, byte-neutral follow-up. The rows are recorded in §9.6.

**R3 — the `bench-regression` CI job is dead, and has been since the
single-file container was removed.** **CLOSED 2026-08-10 by retiring the job —
see §8.6, which also found a second, decisive cause this entry missed (the
harness cannot read packed archives either, so re-cutting the fixture would not
have revived it).** Found by running the job's exact command during this audit:

```
node tools/bench/src/index.mjs tools/bench/baselines/earthquakes-ci.stt \
  --check tools/bench/baselines/earthquakes-ci.json --tolerance 0.15

Benchmark failed:
Error: STT manifest: invalid JSON (Unexpected token 'S', "STTqZ* "... is not valid JSON)
    at STTArchive.fetchManifest
```

The committed fixture `tools/bench/baselines/earthquakes-ci.stt` is a **legacy
single-file `.stt` container** (first bytes `53 54 54 04 04 02 71 5a` —
`STT`+version+`q`), and `@poopdeck.gl/core` no longer has a single-file reader
path: `STTArchive` treats its `url` as a packed `manifest.json` and tries to
JSON-parse the container. This is **not** a symptom of the v3 bump — it fails
before the version gate, and HEAD's `archive.ts` says so in as many words
("the legacy single-file `version` is gone"). So the job has been failing at
step 1 since the transcode-removal campaign, and nobody saw it _because of T2_:
the job has never run anywhere but by hand. Repair: either rebuild the fixture
as a packed archive and re-bless `earthquakes-ci.json`, or retire the job.
~~Not Phase 0's to fix~~ — Phase 0 fixed it: **retired**, §8.6. Note the
second-order consequence for this program: **`bench-regression` cannot be cited
as a guard by any later item**, and that now holds permanently rather than
pending repair.

**R4 — `scrub-cost.mjs` did not parse: a `*/` inside a docstring closed it
early. FIXED by its owner before this section was finalized; recorded because
the failure mode is cheap to reintroduce.** The harness landed mid-audit and,
as first written, could not run at all:

```
$ node --check tools/bench/src/scrub-cost.mjs
tools/bench/src/scrub-cost.mjs:24
 * plus the rollback drill (`scrubLod` off is byte- and behavior-identical).
                             ^^^^^^^^
SyntaxError: Unexpected identifier 'scrubLod'
```

The reported line is not the cause. The cause is **line 8**, inside the opening
`/** … */` block:

```
 * `examples/*/src` passes it, across all three renderers. The roadmap calls it
```

The `*/` in the glob `examples/*/src` terminated the block comment at line 8,
so lines 9–23 were parsed as code and the parser gave up at line 24. **Backticks
do not protect a glob inside a block comment** — and the repo's own gates would
not have caught it: `oxlint` and `oxfmt` do not run over `tools/bench/`, and no
test imports the driver. The fix was to write the path in prose ("nothing
anywhere under the `examples` tree"). Verified after the fix:
`node --check` passes and `node src/scrub-cost.mjs --help` prints usage and
exits 0.

The generalisation is worth carrying: **every `node --check`-only file in
`tools/` is outside the lint and test gates, so a syntax error in one is
invisible until someone runs it.** The three drivers in that position today are
`frame-cost.mjs`, `policy-record.mjs` and `scrub-cost.mjs` — all browser-driven,
all therefore rarely executed. `node --check` on each is a two-second habit and
is the only thing standing between them and this failure mode.

**No repair needed:** frame-cost (`ROUTE` support already landed), the QoE
counter set (P0-2 extended it), the ordering simulator, `stt-optimize`
inspect/diff/order-audit, `stt-validate`, the pitch×bearing matrix, the
showcase probe, the determinism lane, and both `.github/scripts` gates. Each
was exercised or read this pass; see the run table in §8.1.

### 8.5 The determinism rule, bound forward (P0-7)

> **Every solver or encoder change in Phases 1–4 lands with a byte-identical
> re-run test.**

That sentence is what O2's _"zero nondeterminism (byte-identical re-runs)"_
resolves to, and it is a review gate, not an aspiration. It binds, by name:
M1's stratified sampler (deterministic sampling is contractual, problems
§12.1), M4's workload simulator (pack-name churn otherwise —
`ordering_sim.rs`'s own header says so), M3's `--target-size` sweep, and
P0-3's replayer (already carrying its own determinism test). No RNG, no wall
clock, no arrival-order or `HashMap`-iteration dependence in any
output-affecting path; stable sorts with total tiebreaks.

The lane it plugs into already has five members and all five were run green on
2026-08-10:

| Member                                                   | Where                                                                                                      | Covers                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `same_tile_encodes_byte_identically`                     | [reproducible_build.rs:180](../../crates/stt-core/tests/reproducible_build.rs)                             | per-tile encode, 200 repetitions                                       |
| `v2_dataset_rebuild_is_byte_identical_including_schemas` | reproducible_build.rs:202                                                                                  | whole dataset, order-independent (two add-orders)                      |
| `full_pipeline_is_byte_reproducible`                     | [reproducible_pipeline.rs:124](../../crates/stt-build/tests/reproducible_pipeline.rs)                      | parse → clip → bucket → encode → pack, twice                           |
| `stt_build_cli_double_build_is_byte_identical`           | [build_cli_reproducible.rs](../../crates/spatiotemporal-tiles/tests/build_cli_reproducible.rs) (new, P0-7) | the **CLI seam**: arg parsing → readers → parallel parse → output tree |
| `v2_build_is_byte_identical_to_golden`                   | [v2_golden.rs:325](../../crates/stt-core/tests/v2_golden.rs)                                               | the byte pin itself                                                    |

Two of these carry a negative guard so the comparator cannot rot into a
tautology — `byte_comparison_reports_a_single_flipped_pack_byte`
(reproducible_pipeline.rs:236) and `comparison_reports_a_single_flipped_byte`
(build_cli_reproducible.rs) each flip one byte and assert the comparison
reports it.

**One honest note about the pin's current state.** `regenerate_v2_golden`
(v2_golden.rs:475) now reports as ignored with the reason _"fixture
regeneration replaces the formatVersion-3 byte-stability pin"_ — i.e. the
fixture tree in the working tree is already at the in-flight v3 shape. The
golden-pin gate starts enforcing from the commit that lands it, and that
landing commit carries the `Rebuild-Window: R1` trailer for the in-flight
change; the gate is not retroactive and does not claim to be.

### 8.6 R3 closed — `bench-regression` retired, and the gate's watched set widened

**Appended 2026-08-10, after §8.1–§8.5 were written.** Two defects the plan did
not know about, both found by executing Phase 0 rather than reading it, both
**byte-neutral**. This subsection records what was believed, what is true, and
what was done.

#### R3 — the `bench-regression` job was dead, and is now retired

**What was believed.** §8.3's job table lists `bench-regression` as a running
gate — `tools/bench` against a committed fixture, ±15% tolerance, no network —
and the implementation plan (P0-1) cites it as an instrument, calling the
fixture "the committed 733 KB `earthquakes-ci.stt`". `.gitignore` carries a
deliberate `!tools/bench/baselines/earthquakes-ci.stt` exception whose comment
says the fixture is "checked in so CI can run regression checks without
generating data over the network". (One belief worth **not** repeating: the
backlog's green definition at [README.md:124](./README.md) does **not** name
this job — it names the roadmap-citation and golden-pin gates, the lint and
format gates, the Rust targets and the package/showcase test counts. So the
dead gate was never load-bearing for the project's own definition of green,
which is a small mercy.)

**What is true.** The job could not have passed since the single-file container
was removed. Verbatim, before:

```
$ node tools/bench/src/index.mjs tools/bench/baselines/earthquakes-ci.stt
  Archive file                 tools/bench/baselines/earthquakes-ci.stt
  Archive size                 2.73 MB
=== 1. Archive open / index parse ===============================
Benchmark failed:
Error: STT manifest: invalid JSON (Unexpected token 'S', "STTqZ*"... is not valid JSON)
    at STTArchive.fetchManifest (packages/core/dist/archive.js:1029)
    at main (tools/bench/src/bench.mjs:318)
```

Verbatim, after — the command no longer exists, because the fixture it names is
gone and the job that ran it is gone:

```
$ node tools/bench/src/index.mjs tools/bench/baselines/earthquakes-ci.stt
ERROR: could not read .stt file at: …/tools/bench/baselines/earthquakes-ci.stt
  ENOENT: no such file or directory, open '…/earthquakes-ci.stt'
Usage: node src/index.mjs [path-to.stt]
```

§8.4 R3 diagnosed one cause. There are **three**, and any one of them alone is
fatal — which is why "re-cut the fixture" was never going to be the repair:

1. **The fixture was the retired container.** First bytes `53 54 54 04` —
   `STT` + version 4, single-file. Confirmed that no reader path survives:
   `ArchiveWriter` / `ArchiveReader` appear in this tree only inside comments
   (`crates/stt-core/src/pack/mod.rs`, `packages/core/src/index.ts`), there is
   no `struct`/`class` definition for either, and the Rust CLI agrees —
   `stt-optimize inspect --archive …/earthquakes-ci.stt` answers
   `Invalid archive format: manifest JSON decode failed`. This is **not** the
   v3 bump: it fails before the version gate.

2. **The harness cannot read packed archives at all.** This is the decisive one,
   and it was not previously known. `bench.mjs`'s `createFileFetch` serves every
   Range request out of **one** in-memory buffer, and a packed archive is three
   object classes at three URLs. Pointing the bench at a genuine packed manifest
   proves it:

   ```
   $ node tools/bench/src/index.mjs crates/stt-core/tests/fixtures/v2-golden/single/manifest.json
     Archive size                 4.91 KB
   Benchmark failed:
   Error: STT directory truncated: got 5024 bytes, expected 156
   ```

   The manifest parsed; the directory read got the manifest buffer back. The
   word `manifest` does not occur anywhere in `bench.mjs`.

3. **The baseline described a different archive.** `earthquakes-ci.json` records
   `archive_size_bytes: 750205`. The committed `earthquakes-ci.stt` was
   **2,865,735 bytes** — so the plan's "733 KB" is stale for the file, and the
   `--check` comparison would have been against numbers taken from some other
   archive even if (1) and (2) were fixed.

**Decision: RETIRED, not regenerated.** Regeneration was preferred by the brief
and was rejected on three grounds, in order of weight:

- **It would not have worked.** Cause (2) is in `tools/bench/src/bench.mjs`,
  which this item does not own. A packed fixture committed today would still be
  unreadable by `pnpm bench`.
- **Anything minted now is `formatVersion: 3`.** Both writers in this tree are
  at 3 (`crates/stt-core/src/pack/mod.rs`, `packages/core/src/archive.ts`);
  HEAD `5bc30e3`'s reader is at 2 and gates on strict equality. A fixture minted
  mid-break is openable only from the working tree and breaks the moment
  someone checks out HEAD — the failure this defect _is_, re-committed.
- **Determinism could not have been proven.** A fixture whose generator is not
  committed beside it cannot be re-derived, and an unreproducible fixture makes
  a ±15% tolerance a measurement of the generator's noise.

So: the job is deleted from `ci.yml`, replaced in place by a comment block
carrying the diagnosis and the restoration recipe; the 2.73 MB unreadable
binary is deleted (recoverable at
`git show 5bc30e3:tools/bench/baselines/earthquakes-ci.stt`); the three baseline
JSONs are kept and relabelled as historical records rather than live targets;
and `tools/bench/README.md` marks `pnpm bench` **INOPERABLE** with both verbatim
errors, so nobody spends an afternoon rebuilding a fixture for a harness that
cannot read it. A gate that cannot run is worse than an absent one, because it
launders confidence — that is the whole argument, and it is why the honest
retirement beat a plausible-looking half-repair.

**Restoration is two prerequisites, in order:** (a) a URL-aware local fetch in
`bench.mjs` — resolve the request URL against the archive directory and read
that file, ~20 lines, exactly what `policy-replay.mjs` already does; (b) mint
the fixture **after** rebuild window R1 settles, from a committed generator, and
prove byte-identical re-runs. Owner: whoever owns `tools/bench/src`.

**Two loose ends left deliberately untouched, both outside this item's file
ownership.** `.gitignore:78` still carries the
`!tools/bench/baselines/earthquakes-ci.stt` exception and the line-109 comment
naming that fixture; harmless (it un-ignores a path that no longer exists) but
it should go with the next `.gitignore` edit. And the green definition's package
test count at [README.md:124](./README.md) does not yet mention the bench
harness's 27 node:test cases now running in `typescript`.

**Consequences to carry forward.** `bench-regression` may not be cited as a
guard by any item (§8.4 R3 already said this; it now holds permanently rather
than pending repair). And the plan's other citations of this fixture as a
_corpus_ are dead too, for the same reason: §10.1's **O2** row names
"`earthquakes-ci.stt` fixture" as the archive `stt-optimize inspect --sample n`
would sample, and no Rust reader can open it either. O2 needs a packed corpus;
`earthquakes-v2` (live fleet) and the golden trees are what exist today.

#### `tools/bench` was in no `pnpm --filter` line

Separately: `tools/bench` is a workspace package (`pnpm-workspace.yaml` globs
`tools/*`) but appeared in **no** filter line in `ci.yml`, so P0-3's 27
policy-replay tests — determinism, the six conservation invariants, and the
guard that request count is never a ranking key on its own — ran only when
someone remembered to. Fixed: `pnpm --filter '@poopdeck.gl/bench' test` now sits
with the nine other suites in the `typescript` job. It needs no build (the
replayer imports `@poopdeck.gl/core` lazily, only under `--archive`, and these
tests replay the committed micro-trace). 27 pass, 0 fail.

#### The golden-pin gate now watches the reader-side fixtures

**What was believed.** §8.3 above records the scope as deliberate: the gate
watches `crates/stt-core/tests/fixtures/v2-golden/**` plus any
`expected-hashes.json`, and _not_ `packages/core/test/fixtures/**`, "because
the Rust tree is the encoder's oracle and the TS fixtures are read-side."

**What is true.** That distinction does not survive contact with the numbers.
`packages/core/test/fixtures/` holds six datasets and **121 objects currently
churning** — manifests, `.sttp` packs and `.sttd` directory pages produced by
the _same_ Rust writer (`packages/core/scripts/make-v2-golden.sh` drives
`stt-build`), pinned byte-for-byte by `packed-v2-golden.test.ts`,
`packed-golden.test.ts`, `paged-directory.test.ts` and
`legacy-shape-backcompat.test.ts`. That is the same regression-oracle role, on
eleven times as many objects as the watched tree. Worse, the unwatched half is
the _more_ dangerous one to leave open: a reader fixture re-blessed on its own
hides an encoder change behind a reader taught to accept it, while the writer's
oracle stays green.

**What was done.** `packages/core/test/fixtures` joins `PINNED_ROOTS`. Because
the two trees have different oracles and different regenerators, `oracle` and
`regen` moved onto each root and the failure message now renders them from the
watched set, so a future root cannot ship with the message pointing at the wrong
regenerator. The self-test grew from 34 to **41 tests**, covering the new root's
positives, its near-miss negatives (`packages/core/test/fixtures-scratch/`,
`packages/layers/test/fixtures/`, and the helper/oracle/generator _files_, which
are code and not pins), a both-trees-in-one-commit case, the flagged-passes
case, and an assertion that the two regenerators are distinct.

Verified: default mode still passes —
`golden pins: 0 commit(s) checked in origin/main..HEAD, none touch the pins.`

**⚠️ Expected and correct: `--working-tree` now reports 132 entries, not 11.**
The 121 new ones are the reader-side half of the same in-flight v2→v3 break
already recorded in §8.5. They are **not** cleaned, and the gate is **not**
narrowed to hide them. The gate enforces from its landing commit forward and is
not retroactive; the commit that lands this churn carries the
`Rebuild-Window: R1` trailer, which is precisely the mechanism working. The
comment on `workingTreeChanges()` now says so in the file, so the next person to
run `--working-tree` and see 132 lines does not "fix" it by shrinking the gate.

---

## 9. K10 — the cold-start re-capture against the republished fleet (P0-4)

**Status: MEASURED.** Captured **2026-08-10** against the live fleet at
`https://tiles.poopdeck.gl/data`, `--repeat 5`, warm-edge
(`cf-cache-status: HIT`) and cold-edge (`--cache-bust`, `MISS`) passes, over
all eight datasets K10 names: the original three plus the five URLs that
returned **404** during the 2026-07-24 capture
([measurements-2026-07.md](./measurements-2026-07.md) §8) and are live post-B2.

Every number in §9.1–§9.4 is measured. Nothing is inferred from the 2026-07
figures; the stale figures appear only in the ratio column, labelled as such.
§9.5 lists what is **UNAVAILABLE** — not measured, and not guessed at.

**The harness could not run as specified.** See §8.4 R1 (version skew) and R2
(three-dataset table). The capture was run against a scratchpad build of the
**HEAD-committed** `packages/core` (`PACKED_FORMAT_VERSION = 2`), driving the
**byte-identical HEAD copy** of `cold-start-bench.mjs` (`git status
tools/bench/src/` reports the harness unmodified). HEAD is `5bc30e3`, level
with `origin/main`, and is the commit titled "republish the fleet" — i.e. this
is exactly the reader the deployed frontend runs against the archives measured.

### 9.1 The headline — restated (supersedes measurements-2026-07.md §1)

Every archive opened from a cold client — no manifest, no directory, no tiles —
taken to the point where the first frame is drawable at the demo's own default
camera and playhead.

| dataset              | shape                      | archive    | features   | **requests** | **bytes to first frame**   | % of archive |
| -------------------- | -------------------------- | ---------- | ---------- | ------------ | -------------------------- | ------------ |
| `earthquakes-v2`     | sparse global events       | 44.95 MiB  | 522,982    | **5**        | **348.1 KiB** (356,445 B)  | 0.756 %      |
| `flights`            | dense trajectories         | 807.81 MiB | 43,535,844 | **4**        | **2.68 MiB** (2,808,928 B) | 0.332 %      |
| `goes-glm-lightning` | summary tier (h3)          | 135.87 MiB | 14,401,199 | **4**        | **250.9 KiB** (256,888 B)  | 0.180 %      |
| `gtfs-ch`            | dense trajectories (heads) | 459.65 MiB | 5,777,483  | **4**        | **1.19 MiB** (1,253,043 B) | 0.260 %      |
| `rainfall-2019`      | polygon field (isobands)   | 575.75 MiB | 5,228,002  | **4**        | **461.6 KiB** (472,677 B)  | 0.078 %      |
| `storm4d-isolines`   | volumetric line sheets     | 69.64 MiB  | 300,387    | **5**        | **2.02 MiB** (2,120,459 B) | 2.904 %      |
| `wpc-fronts`         | sparse analyzed lines      | 6.10 MiB   | 61,473     | **3**        | **89.1 KiB** (91,241 B)    | 1.426 %      |
| `wpc-fronts-pips`    | sparse oriented polygons   | 2.29 MiB   | 19,655     | **3**        | **60.6 KiB** (62,075 B)    | 2.583 %      |

**Three to five HTTP requests, in every case, from a 2.3 MiB archive to an
808 MiB one.** The property the format was built for still holds on the
republished fleet, and now holds across eight datasets rather than three.

### 9.2 Alarm check against the stale baselines — no alarms

Threshold (K10's own): flag any dataset above **6 requests** or above **1.5×**
its stale byte figure.

| dataset              | stale (2026-07-24/26) | measured (2026-08-10) | Δ requests | byte ratio | verdict             |
| -------------------- | --------------------- | --------------------- | ---------- | ---------- | ------------------- |
| `earthquakes-v2`     | 5 req / 343,492 B     | 5 req / 356,445 B     | 0          | **1.038×** | ok                  |
| `flights`            | 5 req / 5,967,269 B   | 4 req / 2,808,928 B   | **−1**     | **0.471×** | ok — improved       |
| `goes-glm-lightning` | 4 req / 256,888 B     | 4 req / 256,888 B     | 0          | **1.000×** | ok — byte-identical |

- **`flights` roughly halved its cold start while its archive grew** (features
  40,342,819 → 43,535,844, +7.9 %; tiles 223,239 → 242,195; on disk
  846,538,213 → 847,048,005 B). First-frame pack traffic went from **2
  coalesced range GETs / 5,889,533 B** to **1 GET / 2,737,309 B**, drawing
  essentially the same aircraft (155,992 → 155,966). That is the republished
  blob layout doing real work, not a lighter viewport.
- **`goes-glm-lightning` is byte-for-byte unchanged, at rest and on the wire** —
  same 142,466,505 B archive, same 4 requests, same 4,902 / 138,994 / 112,992 B
  split. It is the useful control in this set.
- **`earthquakes-v2` moved +3.8 %** (343,492 → 356,445 B) on an archive that
  itself got _smaller_ (45.6 → 44.95 MiB). The growth is entirely in the
  directory leaf range (235,637 → 238,340 B) and the pack blobs
  (104,973 → 115,076 B); page count is unchanged at 25.

### 9.3 Where the bytes go — the number M4 prices against

**The directory-leaf share of cold-start bytes.** Every §7 page-breakpoint and
descriptor decision is priced against this. `problems §13.4` records
**54.1–68.6 % on sparse datasets**; the re-capture **confirms that band and
widens it upward to 92.0 %**.

| dataset              | manifest       | directory (root + leaves)      | tile blobs                  | **leaf share of cold start** |
| -------------------- | -------------- | ------------------------------ | --------------------------- | ---------------------------- |
| `earthquakes-v2`     | 1 req, 3,029 B | 2 req, 238,340 B               | 2 req, 115,076 B            | **66.9 %**                   |
| `flights`            | 1 req, 5,110 B | 2 req, 66,509 B                | 1 req, 2,737,309 B (97.5 %) | **2.4 %**                    |
| `goes-glm-lightning` | 1 req, 4,902 B | 2 req, 138,994 B               | 1 req, 112,992 B            | **54.1 %**                   |
| `gtfs-ch`            | 1 req, 3,660 B | 2 req, 57,453 B                | 1 req, 1,191,930 B (95.1 %) | **4.6 %**                    |
| `rainfall-2019`      | 1 req, 4,875 B | 2 req, 434,630 B               | 1 req, 33,172 B             | **92.0 %** ← new worst       |
| `storm4d-isolines`   | 1 req, 3,145 B | 1 req, 7,652 B (whole object)  | 3 req, 2,109,662 B (99.5 %) | **0.4 %**                    |
| `wpc-fronts`         | 1 req, 3,048 B | 1 req, 52,550 B (whole object) | 1 req, 35,643 B             | **57.6 %**                   |
| `wpc-fronts-pips`    | 1 req, 2,972 B | 1 req, 26,889 B (whole object) | 1 req, 32,214 B             | **43.3 %**                   |

**Measured band on sparse datasets: 43.3 % – 92.0 %** (was 54.1 % – 68.6 %).
On dense ones it stays negligible (0.4 % – 4.6 %).

Pruning efficiency — how much of the directory is ever touched:

| dataset              | directory at rest | fetched   | **fetched share of directory** | pages |
| -------------------- | ----------------- | --------- | ------------------------------ | ----- |
| `earthquakes-v2`     | 2,067,415 B       | 238,340 B | 11.5 %                         | 25    |
| `flights`            | 4,013,018 B       | 66,509 B  | 1.7 %                          | 60    |
| `goes-glm-lightning` | 478,702 B         | 138,994 B | 29.0 %                         | 6     |
| `gtfs-ch`            | 8,153,959 B       | 57,453 B  | **0.7 %**                      | 138   |
| `rainfall-2019`      | 3,841,763 B       | 434,630 B | 11.3 %                         | 74    |
| `storm4d-isolines`   | 7,652 B           | 7,652 B   | **100 %**                      | 1     |
| `wpc-fronts`         | 52,550 B          | 52,550 B  | **100 %**                      | 1     |
| `wpc-fronts-pips`    | 26,889 B          | 26,889 B  | **100 %**                      | 1     |

**Two structural findings the 2026-07 capture could not see, because all three
of its datasets were multi-page:**

1. **Single-page directories are fetched whole, as a `200` GET, not a range.**
   `storm4d-isolines`, `wpc-fronts` and `wpc-fronts-pips` all carry a 1-page
   directory (`root 73 B`), and the reader pulls the entire object — one
   request instead of two, but 100 % of the directory. On the two small sparse
   sets that whole-object pull is **43–58 % of the cold start**. A
   page-breakpoint model that assumes root-then-prune does not describe these
   three; the §7.2 DP must price the 1-page case explicitly.
2. **Leaf-page granularity, not directory size, is the dominant term.**
   `gtfs-ch` has the largest directory in the set (7.78 MiB, 138 pages) and the
   _smallest_ leaf share (4.6 %) — its z7 viewport prunes to 0.7 % of the
   directory. `rainfall-2019` has half that directory (3.66 MiB, 74 pages) and
   the _worst_ leaf share (92.0 %), because its z4 CONUS viewport keeps 11.3 %
   of the pages to draw **246 features**: 434,630 directory bytes to deliver
   33,172 bytes of tile data, a **13.1× overhead**. Halving `pageEntries`
   remains the untried lever, and `rainfall-2019` is now the sharpest test case
   for it.

Exact warm-edge traces:

```
earthquakes-v2
  200  manifest      3.0 KiB   HIT
  206  directory       506 B   HIT   bytes=0-505              <- root page
  206  directory   232.3 KiB   HIT   bytes=149454-387287      <- surviving leaves
  206  pack         48.9 KiB   HIT   bytes=4262559-4312584
  206  pack         63.5 KiB   HIT   bytes=11384345-11449394

flights
  200  manifest      5.0 KiB   HIT
  206  directory     1.0 KiB   HIT   bytes=0-1032
  206  directory    63.9 KiB   HIT   bytes=1033-66508
  206  pack         2.61 MiB   HIT   bytes=30583683-33320991

goes-glm-lightning
  200  manifest      4.8 KiB   HIT
  206  directory       219 B   HIT   bytes=0-218
  206  directory   135.5 KiB   HIT   bytes=219-138993
  206  pack        110.3 KiB   HIT   bytes=57496930-57609921

gtfs-ch
  200  manifest      3.6 KiB   HIT
  206  directory     2.8 KiB   HIT   bytes=0-2909
  206  directory    53.3 KiB   HIT   bytes=2910-57452
  206  pack         1.14 MiB   HIT   bytes=15701506-16893435

rainfall-2019
  200  manifest      4.8 KiB   HIT
  206  directory     1.1 KiB   HIT   bytes=0-1092
  206  directory   423.4 KiB   HIT   bytes=423087-856623
  206  pack         32.4 KiB   HIT   bytes=25627969-25661140

storm4d-isolines
  200  manifest      3.1 KiB   HIT
  200  directory     7.5 KiB   HIT                            <- whole 1-page directory
  206  pack         1.21 MiB   HIT   bytes=8-1272898
  206  pack        263.8 KiB   HIT   bytes=66382404-66652548
  206  pack        553.3 KiB   HIT   bytes=56696614-57263239

wpc-fronts
  200  manifest      3.0 KiB   HIT
  200  directory    51.3 KiB   HIT                            <- whole 1-page directory
  206  pack         34.8 KiB   HIT   bytes=2758799-2794441

wpc-fronts-pips
  200  manifest      2.9 KiB   HIT
  200  directory    26.3 KiB   HIT                            <- whole 1-page directory
  206  pack         31.5 KiB   HIT   bytes=979417-1011630
```

### 9.4 Wall time, warm edge vs cold edge — and the capture context

Median of 5 cold opens per pass, same machine, same session. **Request and byte
counts are identical in both columns** — verified for all eight datasets; the
protocol does not change, only the latency of each hop.

| dataset              | warm edge (`HIT`) | cold edge (`--cache-bust`, `MISS`) | ratio |
| -------------------- | ----------------- | ---------------------------------- | ----- |
| `earthquakes-v2`     | 210 ms            | 774 ms                             | 3.7×  |
| `flights`            | 898 ms            | 1,536 ms                           | 1.7×  |
| `goes-glm-lightning` | 154 ms            | 1,422 ms                           | 9.2×  |
| `gtfs-ch`            | 455 ms            | 975 ms                             | 2.1×  |
| `rainfall-2019`      | 251 ms            | 885 ms                             | 3.5×  |
| `storm4d-isolines`   | 602 ms            | 1,400 ms                           | 2.3×  |
| `wpc-fronts`         | 105 ms            | 452 ms                             | 4.3×  |
| `wpc-fronts-pips`    | 94 ms             | 284 ms                             | 3.0×  |

Warm-edge times run **1.6–2.1×** the 2026-07 numbers on the original three
(128→210 ms, 431→898 ms, 90→154 ms) even though `flights` now moves _fewer_
bytes — so this is session/link variance and decode cost, not a protocol
regression. Wall time includes zstd decompression and Arrow decode and is the
least portable figure here; the request and byte counts are the durable ones.

|            |                                                                               |
| ---------- | ----------------------------------------------------------------------------- |
| Date       | 2026-08-10                                                                    |
| Machine    | Apple M3 Pro, macOS 14.1 (23B2073), arm64                                     |
| Runtime    | Node v22.20.0 (`fetch` / undici), HTTP/2                                      |
| Reader     | `@poopdeck.gl/core` built from HEAD `5bc30e3` (`PACKED_FORMAT_VERSION 2`)     |
| Deployment | Cloudflare R2 behind `tiles.poopdeck.gl`                                      |
| Edge PoP   | `BOS` (`cf-ray: …-BOS`) — same PoP as the 2026-07 capture                     |
| Link       | DNS 4.3 ms · TCP connect 22.6 ms · TLS 40.3 ms · TTFB 61.0 ms (warm manifest) |
| Viewport   | 1280 × 800 px, cameras from `examples/showcase/src/datasets.ts`               |

**Fleet state — the five 404s are closed.** Probed 2026-08-10; all eight
measured manifests returned **200** and opened under a strict
`formatVersion === 2` reader, which is positive proof of their format version.

| URL stem           | 2026-07-24 | 2026-08-10 | showcase demo id                |
| ------------------ | ---------- | ---------- | ------------------------------- |
| `gtfs-ch`          | 404        | **200**    | `gtfs-ch`                       |
| `rainfall-2019`    | 404        | **200**    | `rain-flood-2019`               |
| `storm4d-isolines` | 404        | **200**    | `storm-4d-isolines`             |
| `wpc-fronts`       | 404        | **200**    | (`severe-weather-2024` overlay) |
| `wpc-fronts-pips`  | 404        | **200**    | (`severe-weather-2024` overlay) |

Two of the five have a **URL stem that differs from the demo id**
(`rain-flood-2019` → `/data/rainfall-2019`, `storm-4d-isolines` →
`/data/storm4d-isolines`). The backlog's discharged-L1 line quotes the _demo_
ids; probing those verbatim returns 404 and would read as a regression.
Separately and unrelated to this capture:
`/data/storm-3d-conus/manifest.json` → 404 is expected — that demo's primary
URL is `/data/mrms-storm3d-volume/manifest.json` and the four `mrms-storm3d-*`
overlays are the un-synced ones. Noted so nobody re-discovers it.

### 9.5 UNAVAILABLE — what this capture does not measure

Each of these is _not measured_, and no figure below is guessed at.

- **Browser-side first-frame traffic.** Everything above is the Node critical
  path: `getTilesInBounds` at the primary zoom. `SpatiotemporalTileset`'s
  prefetch lookahead, parent-fallback levels and overview storyboard tier are
  **not counted**, unchanged from 2026-07. A real tab's first second is higher.
- **Pitched cameras are measured flat.** `cold-start-bench.mjs`'s
  `viewportBounds` derives its box from two opposite screen corners at pitch 0 /
  bearing 0 — it does **not** use `packages/core/src/geo/viewport-bounds.ts`,
  so the L0
  3D-selection fix is absent from the bench harness. `storm4d-isolines`'s real
  camera is **pitch 55 / bearing 25**, so its 5 req / 2.02 MiB is a **lower
  bound**; per the L0 finding a flat box misses 20–44 % of on-screen tiles. Do
  not quote that row as the demo's true cold start. (`gtfs-ch`,
  `rainfall-2019`, `wpc-fronts*` are all pitch 0 and unaffected;
  `severe-weather-2024`'s own camera is pitch 32, but the fronts rows are
  measured at its lon/lat/zoom with pitch 0 for the same reason.)
- **Seek cost** (as opposed to cold open) — still unmeasured, still the
  next-most-valuable number.
- **`pageEntries` sensitivity** — still untried. §9.3 now names
  `rainfall-2019` as the sharpest test case for it.
- **The other 60 fleet datasets** — out of scope for K10, which names the
  original three plus the five that 404'd.

### 9.6 Reproducing it, and the five harness rows to fold in

```sh
# NOTE: fails on the current working tree with
#   Error: STT manifest: unsupported formatVersion 2 (expected 3)
# See §8.4 R1. Run against a HEAD (5bc30e3) build of @poopdeck.gl/core until
# the fleet is republished at v3.
pnpm --filter @poopdeck.gl/bench bench:cold-start -- --verbose --repeat 5
pnpm --filter @poopdeck.gl/bench bench:cold-start -- --cache-bust --repeat 5
```

The five rows to append to `DATASETS` in `tools/bench/src/cold-start-bench.mjs`
(§8.4 R2) so the shipped CLI covers the whole K10 set. Ids are R2 **URL
stems**; cameras and windows read from the showcase registry entry that owns
each URL.

```js
  {
    id: 'gtfs-ch',
    shape: 'dense trajectories (trip heads)',
    note: 'Swiss national GTFS, one Monday. The /demo/gtfs-ch camera (z7.4).',
    view: { longitude: 8.23, latitude: 46.8, zoom: 7.4 },
    timeWindow: 20_000,
    playheadFraction: 0.5,
  },
  {
    id: 'rainfall-2019',
    shape: 'polygon field (isobands)',
    note: 'CMORPH 2-hourly precip isobands, 2019. The /demo/rain-flood-2019 camera.',
    view: { longitude: -96, latitude: 38.5, zoom: 4.3 },
    timeWindow: 7_200_000,
    playheadFraction: 0.5,
  },
  {
    id: 'storm4d-isolines',
    shape: 'volumetric line sheets',
    note: 'KDMX CAPPI iso-line sheets. /demo/storm-4d-isolines camera (pitch 55/bearing 25 NOT modeled here).',
    view: { longitude: -94.46, latitude: 41.4, zoom: 8 },
    timeWindow: 360_000,
    playheadFraction: 0.5,
  },
  {
    id: 'wpc-fronts',
    shape: 'sparse analyzed lines',
    note: 'WPC 3-hourly surface fronts; severe-weather-2024 overlay camera.',
    view: { longitude: -93, latitude: 39.5, zoom: 4.2 },
    timeWindow: 900_000,
    playheadFraction: 0.5,
  },
  {
    id: 'wpc-fronts-pips',
    shape: 'sparse oriented polygons',
    note: 'WPC front pips (triangles/semicircles); same overlay camera.',
    view: { longitude: -93, latitude: 39.5, zoom: 4.2 },
    timeWindow: 900_000,
    playheadFraction: 0.5,
  },
```

---

## 10. The evaluation matrix (P0-8)

**What this section is.** The binding table. Every work item in the
implementation plan must name its acceptance row here, or add one in the same
shape; an Evaluation block that cannot resolve against a row is a defect in
that item, not a missing row. Every harness cell resolves to a verified path
and invocation in §8.1.

**How to read a baseline cell.** A cell is one of three things and never
anything else:

- a **measured** figure with its source,
- **NEEDS-BASELINE** plus a one-line reason it could not be measured,
- **n/a** where the criterion has no numeric baseline (a spec review).

A cell is never a guess, never an estimate, and never a figure carried over
from a different route or a different build.

### 10.1 The matrix

| #     | Acceptance criterion                              | Harness                                                                | Metric                                                    | Units                    | Baseline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Threshold                                                                                                                  | Dataset / route                                                                   |
| ----- | ------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| O1    | Horizon feasibility kills eviction thrash (§9.1)  | P0-3 replay + `tileset.getCacheStats()`                                | `runwayEvictions` per looped-playback session             | count                    | **MEASURED 2026-08-11 (§10.5)** on `/demo/storm-radar`, 3×90 s looped sessions, replayed at the route's own cache limits (666 tiles / 682.7 MiB): **0, 0, 0** — corroborated by the live `tileset.stats` (**0** evictions of any kind). At the replayer's DEFAULT 6-tile limit the same traces give **201–305**. Prior side-readings stand: `/drive` **2,150 per 8 s**, `ocean-drifters` **0**                                                                                                                                                                                         | **0** under looped playback                                                                                                | `severe-weather` composite, `storm-4d-greenfield`, `/drive`                       |
| O1    | Byte-metered budgets / fairness (§9.2 §9.3 §11.3) | P0-3 replay                                                            | bytes fetched + refetch cycles at equal runway            | MiB, count               | **MEASURED 2026-08-11 (§10.5)** on `/demo/storm-radar` at the route's own limits: **6.31–9.31 MiB** fetched over **83–84** reads, blended **172.3–177.3 MiB** (`bytes + 2 MiB·reads`), refetch cycles **0, 0, 0**, runway violations **0**. At the 6-tile default: **19.59–26.98 MiB** / **211–314** reads / blended **441.6–648.8 MiB** / **128–231** refetch cycles. Live wire during the same windows: **12.88 MiB over 135 responses**, all three runs                                                                                                                             | bytes ↓, refetch cycles → 0, no runway loss                                                                                | same three routes                                                                 |
| O1    | Cadence-derived runway tolerance (§11.2)          | `getQoeStats()` via the frame-cost page probe                          | `stallCount`, `totalStallMs` per 60 s                     | count, ms                | **MEASURED 2026-08-11 (§10.5)** — the governor's `playback` channel is now in both capture sets. On `/demo/storm-radar`, 3×90 s: `stallCount` **0**, `totalStallMs` **0**, `creepMs` **0**, `degradedResumeCount` **0**, `startupMs` **1.5–2.0 ms**, across a loop wrap in every run. LOCALHOST transport — a zero here is a floor, not a CDN result                                                                                                                                                                                                                                   | `stallCount` ↓ vs baseline; 0 regression on single-source demos                                                            | radar+fronts composite (`severe-weather`)                                         |
| O1    | Decode priority continuity (§10.2)                | `decode` channel + `decodeQueue` snapshot via P0-3                     | p95 queue-wait; priority inversions observed              | ms, count                | **MEASURED 2026-08-11 (§10.5)** on `/demo/storm-radar`: replay p95 queue-wait **191–294 ms** (p50 2–4 ms, max 261–338 ms) at the route's own limits, **294–499 ms** at the 6-tile default; the live in-page `decodeQueue` snapshot agrees at p50 **9.3–9.8 ms** / p95 **298.3–552.7 ms**. **Priority inversions: NO INSTRUMENT** — `policy-replay`'s report has no inversion counter (only priority/prefetch hit-miss-read counts), so that half of the row is unmeasured                                                                                                              | p95 ↓; inversions → 0                                                                                                      | `/drive`, `storm-4d-greenfield`                                                   |
| O1    | No frame-cost regression                          | `frame-cost.mjs`                                                       | fps, p95 frame time                                       | fps, ms                  | MEASURED: storm-4d **86.8 fps / p95 24.8 ms** (§1, §4); `/drive` **28.5–32.1 fps / p95 43.3–58.3 ms** (a run-to-run BAND, see §10.3); `ocean-drifters` **113.5–116.0 fps / p95 9.2–10.2 ms**                                                                                                                                                                                                                                                                                                                                                                                           | no regression beyond the recorded band; `/drive` gains ride the separate draw-call item                                    | `storm-4d-greenfield`, `ROUTE=/drive`, `ocean-drifters` (vsync control)           |
| O2    | Stratified sampling + dispersion (M1)             | `stt-optimize inspect --sample n` vs exhaustive decode                 | max per-column share error at fixed n                     | percentage points        | **NEEDS-BASELINE** — singleton-proxy error is unquantified (problems §12.1 Incumbent) and quantifying it is M1's own exhaustive-vs-sampled run                                                                                                                                                                                                                                                                                                                                                                                                                                         | error ≤ half of systematic-stride error at equal n; dispersion published                                                   | ~~`earthquakes-ci` fixture~~ (unreadable by any reader — §8.6) + `earthquakes-v2` |
| O2    | `measured` ordering default (M4)                  | `stt-optimize order-audit` (ordering_sim)                              | archives whose pick changes; blended read cost            | count; bytes + reads×gap | MEASURED (design M4): **12/36 mis-picked** by the fixed heuristic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | re-audit shows ≥ the 12/36 correction; cost never ranked by request count                                                  | 36-archive fleet audit set                                                        |
| O2    | Zero solver nondeterminism                        | P0-7 lane + double-run of `recommend`                                  | byte diff of re-runs                                      | bytes                    | MEASURED: **0** — all five lane members re-run green 2026-08-10 (§8.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **0** (byte-identical)                                                                                                     | fixture datasets                                                                  |
| O3    | `--target-size B` hits budget in one build        | `stt-optimize recommend --target-size` (new, M3) + `stt-optimize diff` | \|final − B\|/B; human iterations                         | %; count                 | MEASURED-as-absent: `recommend` has **no** `--target-size` and no `--auto` (§8.2 item 6); today's path is ~10 hand-tuned knobs over multiple iterations                                                                                                                                                                                                                                                                                                                                                                                                                                | within 5 % (proposed — set by Phase 3, not here) on first build; iterations → 1; lossy levers appear only as shadow prices | three showcase datasets incl. one categorical-heavy                               |
| O3    | No-thinning demonstrably intact                   | M3 acceptance run                                                      | behavior at infeasible B                                  | —                        | n/a — a behavioral guard, not a measurement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | reports the lexicographic floor, drops nothing (guard test)                                                                | synthetic infeasible-budget fixture                                               |
| O4    | Semantic fingerprints green fleet-wide (M7)       | `stt-validate` (extended)                                              | fingerprint mismatches                                    | count                    | MEASURED-as-blind: the scrambled-coords class is invisible today — **106 archives passed** `stt-validate` while corrupted (problems §13.2)                                                                                                                                                                                                                                                                                                                                                                                                                                             | **0** across the 68-archive fleet; the seeded-corruption fixture must FAIL                                                 | full fleet                                                                        |
| O4    | K2 noise → 0 (M2 global pin)                      | `stt-validate --sample 300`                                            | benign width-drift warnings                               | count                    | benign warnings fleet-wide (backlog K2); `wildfires` carries 163 _real_-drift errors and is excluded (backlog K9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | benign warnings **0** post-R1; real-drift errors unaffected                                                                | full fleet minus `wildfires`                                                      |
| O4    | R1 pack-byte win (M2 hoist)                       | `stt-optimize diff --before --after --fail-on-growth 0`                | compressed pack bytes                                     | %                        | MEASURED bound on the prize (design M2): dictionary share **43.9 %** (earthquakes-v2) / **33.6 %** (hurricanes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | packed-v2-magnitude reduction on categorical-heavy; growth gate 0 % everywhere else                                        | earthquakes-v2, hurricanes, + 3 controls                                          |
| O4    | K10 re-captured post-republish                    | `cold-start.mjs` (P0-4 procedure)                                      | requests / bytes to first frame                           | count / KiB              | MEASURED 2026-08-10 (§9.1), all eight: 5/348.1 KiB, 4/2.68 MiB, 4/250.9 KiB, 4/1.19 MiB, 4/461.6 KiB, 5/2.02 MiB, 3/89.1 KiB, 3/60.6 KiB                                                                                                                                                                                                                                                                                                                                                                                                                                               | ≤ the §9.1 request counts; bytes explained by content change only                                                          | the eight-dataset capture set (§9.1)                                              |
| O5    | Pitched-camera fetch ~10× down (§8.1)             | pitch×bearing matrix + P0-3 byte capture at pitched cameras            | fetched tiles & bytes at pitch ≥ 60° at verified coverage | count, MiB               | MEASURED for tiles (problems §8.1): **754 vs 47** at equal coverage. Bytes: **NEEDS-BASELINE** — no pitched byte capture exists; §9.5 records that cold-start models pitch 0 only                                                                                                                                                                                                                                                                                                                                                                                                      | ≥ 10× tile/byte reduction; 0 coverage misses across the 24×18 matrix                                                       | storm / BIXI volumetric routes                                                    |
| O5    | One reviewed tier-declaration mechanism (M8)      | spec review (not a harness)                                            | —                                                         | —                        | n/a — four divergent planned mechanisms today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | one declaration design, reviewed once                                                                                      | —                                                                                 |
| §11.6 | Scrub keep-vs-delete                              | `scrub-cost.mjs` (P0-5)                                                | TTFP; fresh-frame %; bytes-during-scrub; settle ms; pops  | ms; %; MiB; ms; count    | **MEASURED 2026-08-11 (§10.6)**, one route only (`/demo/storm-radar`, not a named heavy route). Off-state baseline / motion tier on, 3 independent runs × 2 drags at `medium`: bytes-during-scrub **0.30 / 1.88 / 2.15 MiB → 0 B (×0)**; TTFP **0 ms / 0 ms**; fresh-frame **37.5 % / 37.5 %**; settle **0 ms / 0 ms**; pops **2 / 2**. Rollback drill BEHAVIOR-IDENTICAL; preview-never-gates and the restore invariant HELD ×27. Harness verdict **KEEP-CANDIDATE on this route** — the §11.6 clause needs all three heavy routes and they are unrunnable in this tree (v2 archives) | TTFP < 16.7 ms from a resident tile; pops 1–2; bytes ≤ baseline (hard)                                                     | NYC taxi, `/drive`, BIXI                                                          |

### 10.2 What got measured this wave, and what it does and does not license

**The P0-3 micro-trace fixture** (`tools/bench/test/fixtures/micro-loop-boundary.jsonl`,
20 events across a loop boundary) replayed under all four variants. These are
**fixture** figures, not route figures: they pin the _incumbent's_ behavior so
Phase 1 has a before, and they demonstrate the §9.4 "inverse of Belady"
pathology in miniature. They are not a substitute for the route baselines.

| variant      | bytes fetched | reads | blended cost (`bytes + 2 MiB·reads`) | refetch cycles | `runwayEvictions` | evictions | p95 decode wait |
| ------------ | ------------: | ----: | -----------------------------------: | -------------: | ----------------: | --------: | --------------: |
| `incumbent`  |       129,000 |    10 |                           21,100,520 |          **2** |             **2** |         4 |            6 ms |
| `lru`        |       142,000 |    11 |                           23,210,672 |              3 |                 0 |         5 |            6 ms |
| `loop-aware` |       121,000 |     9 |                           18,995,368 |              1 |                 0 |         3 |            6 ms |
| `belady`     |       121,000 |     9 |                           18,995,368 |              1 |                 1 |         3 |            6 ms |

The reference `loop-aware` model reaches the offline `belady` optimum on this
trace, at **6.2 % fewer bytes**, one fewer read, and **10.0 % lower blended
cost** than the incumbent, and it halves the incumbent's refetch cycles (2 → 1)
while taking `runwayEvictions` from 2 to 0. Note that plain `lru` is _worse_
than the incumbent on every column except `runwayEvictions` — which is exactly
why that counter alone is not the acceptance criterion, and why the row beside
it in §10.1 measures bytes and refetch cycles at equal runway. Cost is reported
blended (`bytes + g·reads`, `g` = the reader's
own `DEFAULT_RANGE_COALESCE_GAP`) and **never ranked by request count** — the
do-not-touch register's 669 MiB incident is exactly why.

**Two real `runwayEvictions` readings, from the shipped instrument, not from
replay.** `frame-cost.mjs` snapshots `tileset.stats` at the end of each run,
and the two artifacts in `tools/bench/out/` from the 2026-08-03 capture carry
it:

| route            | window | `runwayEvictions` | evictions | hits / misses | visible tiles | tileset hit rate |
| ---------------- | ------ | ----------------: | --------: | ------------- | ------------: | ---------------: |
| `/drive`         | 8 s    |         **2,150** |     8,272 | 79,398 / 312  |           260 |          99.61 % |
| `ocean-drifters` | 8 s    |             **0** |         0 | 6,099 / 15    |            30 |          99.75 % |

That contrast is worth stating plainly: **the O1 target counter is already
observable, already non-zero, and already enormous on `/drive`** — 2,150
over-limit evictions in eight seconds of steady-state playback on a route whose
tileset is otherwise hitting 99.6 % — while an under-budget single-source demo
sits at exactly zero. It does **not** discharge the O1 baseline cell: a
frame-cost snapshot is a live browser session against a real network, which is
precisely the non-reproducible measurement P0-3 exists to replace, and it is
not per-_looped-playback-session_. Treat it as evidence the pathology is real
and the counter works, and pin the actual before/after with the replayer.

**The determinism row is fully discharged.** All five lane members ran green on
2026-08-10 (§8.5), including the new CLI-seam double-build (4.43 s). O2's
"zero nondeterminism" therefore has a live, currently-passing oracle rather
than an assumption.

### 10.3 The NEEDS-BASELINE burn-down

Seven cells remain unfilled — four of them O1. Each carries the reason it could
not be measured this wave; none is a guess, and the plan's own rule stands —
**all O1 cells must be filled before the first Phase 1 merge.** Note the shape
of the list: four of the seven close with a single artifact, one recorded trace
per composite route, which is therefore the highest-leverage thing left in
Phase 0.

> **Burn-down update, 2026-08-11.** That prediction held: **one recording pass
> closed all four O1 cells at once**, and the same session closed the §11.6
> metrics as far as one route can. Seven open → **two** (O2 sampling error, O5
> pitched bytes) plus a scoped remainder on §11.6. The strikethrough rows below
> record what closed them; the method, the caveats and the two harness defects
> the pass uncovered are in **§10.5** (O1) and **§10.6** (§11.6). Read those
> before quoting any figure: every number came from **locally rebuilt
> `formatVersion: 3` archives over localhost**, not from the published fleet.

| Cell                                 | Why it is still open                                                                                                                                                         | What closes it                                                                     |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ~~O1 `runwayEvictions` (routes)~~    | **CLOSED 2026-08-11 (§10.5)** — recorded on `/demo/storm-radar`; **0** per looped session at the route's own cache limits, **201–305** at the replayer's 6-tile default      | Done: 3 traces in `tools/bench/out/traces/`, replayed `--variant incumbent`        |
| ~~O1 bytes + refetch cycles~~        | **CLOSED 2026-08-11 (§10.5)** — **6.31–9.31 MiB** / **83–84** reads / **0** refetch cycles at the route's limits; **19.59–26.98 MiB** / **128–231** cycles at the default    | Same recording pass                                                                |
| ~~O1 `stallCount` / `totalStallMs`~~ | **CLOSED 2026-08-11 (§10.5)** — `playback` is in the capture set now, and the trace carries the governor's QoE counters directly: **0 / 0 ms** over 3×90 s incl. a loop wrap | Done: read off the `playback` channel in the recorded trace                        |
| ~~O1 decode p95 queue-wait~~         | **CLOSED 2026-08-11 (§10.5)** — replay p95 **191–294 ms**, live `decodeQueue` p95 **298.3–552.7 ms**. The row's second half (priority inversions) has **no instrument**      | Same recording pass; an inversion counter would need a `policy-replay` change      |
| O2 sampling error at fixed n         | Requires an exhaustive-decode comparison run — that run is M1's own deliverable, not Phase 0's                                                                               | M1's Phase 2 measurement                                                           |
| O5 pitched-camera **bytes**          | No harness captures bytes at a pitched camera. `cold-start-bench.mjs` models pitch 0 / bearing 0 only (§9.5), so it under-counts by the L0 20–44 %                           | P0-3 byte capture at a pitched camera, or teaching cold-start the real bounds      |
| §11.6 scrub metrics                  | **PARTLY CLOSED 2026-08-11 (§10.6)** — all five metrics now measured off-state and on-state, but on `/demo/storm-radar`, which is none of the three named heavy routes       | The three heavy routes (NYC taxi, `/drive`, BIXI), which need v3 archives to exist |

**One threshold sharpened by measurement rather than by argument.** O1's
frame-cost row said "no regression beyond run noise". The `/drive` route's own
run-to-run spread is now known and it is wide: the §4.1 table records
**28.5 fps / p95 58.3 ms**, and `tools/bench/out/frame-cost-drive.json` from
the same 2026-08-03 session records **32.1 fps / p95 43.3 ms** — a 12.6 % fps
spread and a 35 % p95 spread on the _same_ build and machine. `ocean-drifters`
spreads too (116.0 vs 113.5 fps). So the threshold is written as a **band**,
not a point, and a single `/drive` reading inside 28.5–32.1 fps is not evidence
of anything in either direction. Composite routes need the resident draw count
checked before their figure is quoted at all (§7 caveat 3).

### 10.4 Coverage check against design §7

Each of O1–O5 from
[optimization-informed-design-2026-08.md §7](./optimization-informed-design-2026-08.md)
appears in §10.1, and no criterion appears twice:

- **O1** — five rows (horizon feasibility, byte-metered budgets, cadence
  tolerance, decode priority, no frame-cost regression), covering §9.1, §9.2,
  §9.3, §9.4, §10.2, §11.2, §11.3.
- **O2** — three rows (stratified sampling, `measured` ordering, zero solver
  nondeterminism).
- **O3** — two rows (`--target-size` hits budget; no-thinning intact).
- **O4** — four rows (semantic fingerprints, K2 noise, R1 pack-byte win, K10
  re-capture).
- **O5** — two rows (pitched-camera fetch, one reviewed tier declaration).
- Plus the **§11.6** scrub keep-vs-delete row, which is a recorded decision the
  design doc's Phase 0 clause (c) requires evidence for, not an O-line.

**The browser-verify boundary still holds.** Everything in this matrix reads
counters, bytes, requests or frame timings. None of it signs off appearance:
whether a demo _looks_ right is the user's own in-browser pass, a mandatory
manual gate on this project, and no row here claims otherwise. When a change
could alter pixels, its acceptance row covers the counters and its item adds a
line to the browser-verify queue.

### 10.5 The O1 route capture (2026-08-11) — four cells, one recording pass

**What was run.** Three 90-second recordings of `/demo/storm-radar` against a
local showcase dev server, then an offline `policy-replay --variant incumbent`
of each. The route is a **three-source composite** — `storm-field` primary plus
`storm-cells` and `storm-tracks` overlays (`examples/showcase/src/datasets.ts`)
— which is the multi-source playback shape the O1 rows are about. Artifacts:

```
tools/bench/out/traces/demo-storm-radar-2026-08-10-run{1,2,3}.jsonl
  digests 2f01d2bc206e8549 / 2a99184dc9fb8194 / 3056d6fe5dacf65d
  361 viewport steps, 137–138 request events, 932–936 decode events,
  4 playback events, 0 console errors per run
```

**Read the provenance before the numbers.** These are **not fleet figures**:

- The three archives were **rebuilt locally at `formatVersion: 3`** with the
  working tree's own `stt-build`, because the working-tree reader gates on
  strict equality and, before this pass, every one of the 64 packed archives
  under `examples/showcase/public/data` — and the whole fleet — was
  `formatVersion: 2` (that tree is gitignored and untracked, so rebuilding
  three of them in place dirties nothing; the v2 originals were moved aside
  first and are regenerable with `stt-generate storms`). The
  rebuild matched the originals' shape — `--min-zoom 4 --max-zoom 9
--temporal-bucket 5m --blob-ordering time-major --publish`, plus
  `--quantize-coords 0.1 --pre-tessellate` on `storm-field` — and reproduced
  their tile counts (cells **1,471** and tracks **1,042**, both exact;
  field **5,981** vs the original **5,450**). Pack bytes: field 65.6 MB, cells
  336.6 KB, tracks 265.0 KB.
- Transport is **localhost**, not the CDN. Latency-sensitive readings (stalls,
  queue-wait) are therefore **floors**.
- `/demo/storm-radar` is a **substitute** for the three routes the row names.
  `severe-weather`, `storm-4d-greenfield` and `/drive` all resolve to v2
  archives that this tree's reader cannot open, and only the storm trio had
  local `.parquet` sources cheap enough to rebuild.

**Replay at the route's own cache limits.** The showcase gives each tileset in
a 3-archive composite `maxCacheSize = max(600, ⌊2000/3⌋) = 666` and
`maxCacheByteSize = max(512 MiB, ⌊2 GiB/3⌋) = 682.7 MiB`
(`examples/showcase/src/components/demo/buildDemoLayers.ts`). Replayed there:

| run | `runwayEvictions` | evictions | bytes fetched | reads | blended cost (`bytes + 2 MiB·reads`) | refetch cycles | runway violations | decode p50 / p95 / max |
| --- | ----------------: | --------: | ------------: | ----: | -----------------------------------: | -------------: | ----------------: | ---------------------: |
| 1   |             **0** |         0 |      7.98 MiB |    83 |                            174.0 MiB |          **0** |                 0 |   2 / **294** / 325 ms |
| 2   |             **0** |         0 |      9.31 MiB |    84 |                            177.3 MiB |          **0** |                 0 |   4 / **281** / 338 ms |
| 3   |             **0** |         0 |      6.31 MiB |    83 |                            172.3 MiB |          **0** |                 0 |   3 / **191** / 261 ms |

**The same three traces at the replayer's DEFAULT limits (6 tiles / 1 GB).**
`DEFAULT_CONFIG.maxResidentTiles` is a fixture-scale number, and on a route
whose viewport alone holds 12–17 visible tiles it manufactures the pathology:

| run | `runwayEvictions` | evictions | bytes fetched | reads | blended cost | refetch cycles | decode p50 / p95 |
| --- | ----------------: | --------: | ------------: | ----: | -----------: | -------------: | ---------------: |
| 1   |               201 |       204 |     19.59 MiB |   211 |    441.6 MiB |            128 |       2 / 328 ms |
| 2   |               221 |       229 |     26.98 MiB |   237 |    501.0 MiB |            153 |     113 / 499 ms |
| 3   |               305 |       308 |     20.85 MiB |   314 |    648.8 MiB |            231 |      50 / 294 ms |

Both tables are reported because **the pair is the finding**. A replay figure
is only meaningful next to the resident budget it assumed, and a `runwayEviction`
count quoted without one says nothing. Costs are blended (`bytes + g·reads`,
`g` = the reader's `DEFAULT_RANGE_COALESCE_GAP` = 2 MiB) and never ranked by
request count.

**Two live instruments corroborate the replay, independently.** Each trace
header carries the end-of-window in-page snapshots:

| run | `tileset.stats` `runwayEvictions` / evictions | tiles / visible | hit rate | live `decodeQueue` p50 / p95 | wire during the 90 s window |
| --- | --------------------------------------------: | --------------: | -------: | ---------------------------: | --------------------------: |
| 1   |                                     **0 / 0** |        638 / 17 | 99.869 % |           9.6 / **552.7 ms** |   12.88 MiB / 135 responses |
| 2   |                                     **0 / 0** |        382 / 12 | 99.895 % |           9.3 / **298.3 ms** |   12.88 MiB / 135 responses |
| 3   |                                     **0 / 0** |        382 / 12 | 99.897 % |           9.8 / **378.4 ms** |   12.88 MiB / 135 responses |

The live tileset agrees with the replay at the route's real limits — **zero**
over-limit evictions in every run — and the live decode p95 (298–553 ms)
brackets the replayed p95 (191–294 ms) from above, which is what one expects
when the model omits transport. Note the caveat on that column: `tileset.stats`
is a **single-slot snapshot** in a 3-tileset composite, so the last publisher
wins; run 1 captured the `storm-field` tileset (195.8 MiB resident), runs 2–3
an overlay (1.1 MiB). Zero held in every slot captured, but no single run
proves all three tilesets were at zero simultaneously. Separately, the
**archive-level** LRU (500 entries) did evict — 138 times in run 1 — which is a
different cache from the tileset's and is not what O1 counts.

**Cadence / QoE.** The governor's `playback` channel rides the trace, so the
stall row needs no separate instrument: `stallCount` **0**, `totalStallMs`
**0**, `creepMs` **0**, `degradedResumeCount` **0**, `startupMs`
**1.5 / 1.9 / 2.0 ms**, with a `seeking → waiting → playing → ready` loop wrap
observed in each run at ≈73 s. Per 90 s and therefore per 60 s: zero. On
localhost, against a 63 MB dataset that fits the budget several times over,
that is the floor the row should be read as.

**The route was verified non-blank, and only non-blank.** Per the project's
browser-verify boundary this section judges no pixels — but a counter capture
over a dead canvas would be worthless, so one screenshot proves the rebuilt v3
archives actually feed the layers: `tools/bench/out/storm-radar-v3-render-check.png`
shows the reflectivity field, the cell centroids and the transport bar all live
mid-playback. Whether it _looks_ right remains the user's own in-browser pass.

**Report these as bands, with n.** Following the §10.3 rule set by `/drive`'s
own 12.6 % / 35 % run-to-run spread: n = 3 repeats, same build, same machine,
same 90 s window. Nothing here licenses a claimed delta smaller than the spread
in the tables above (e.g. bytes at the route's limits span 6.31–9.31 MiB, a
**47 %** spread run-to-run, so a 20 % byte improvement on this route would be
indistinguishable from noise at n = 3).

**Two harness defects the pass uncovered.** Neither is fixed here — both files
are owned by other items — and both are worked around, not papered over:

1. **`policy-record.mjs` cannot run at all.** Line 213 calls
   `page.addInitScript(installSampler, sampleMs, PROBE_CHANNELS)`, but
   Playwright's `addInitScript` takes **one** argument after the function
   (`scrub-cost.mjs:1343` passes a single options object and is correct). So
   `channels` arrives `undefined` in the page and the first drain tick throws
   `TypeError: channels is not iterable`, killing the driver before any capture.
   The traces above were produced by a scratch driver that reuses the recorder's
   **exact** page-side `installSampler` (injected via `Function#toString`) and
   re-implements only the driver half, writing the same `TRACE_VERSION` /
   `serializeTrace()` format. **Fix is a one-line arity change** in
   `policy-record.mjs`; until it lands, that harness row in §8.1 is aspirational.
2. **The replay universe collides the sources of a composite.**
   `buildUniverseFromTrace` keys on the tile key alone, and the three archives
   share a `z/x/y/t` key space, so `storm-field`'s and `storm-cells`' tile at the
   same address become **one** universe entry (first byte size wins). The
   replayer reports the collision honestly rather than averaging it —
   `byteSizeConflicts: 45` against `universeTiles: 92–93` in every run — but the
   consequence is that a composite's replayed byte figures are a **lower bound**.
   The trace already carries a `source` field per event; keying the universe on
   `(source, key)` would close it.

**Also worth recording: what did NOT block this.** Playwright, the dev server
and the browser were all fine. The only real obstacle was the in-flight v2→v3
reader break, and it is walkable in about a minute per dataset — the Rust
builder already emits v3 (`PACKED_FORMAT_VERSION = 3`,
`crates/stt-core/src/pack/mod.rs`), so any dataset with a local `.parquet`
source can be rebuilt into a reader-compatible archive today. Anyone reproducing
this should expect to do that first, and should say so in their report.

### 10.6 The §11.6 scrub run (2026-08-11) — the off-state baseline, and the on-state pass

**`scrub-cost.mjs` has now touched real data.** The P0-5 review's objection —
"the harness is NEEDS-HARNESS-closed; the DECISION is not" — is half discharged:
all five metrics exist, on one route, with the invariants observed rather than
assumed. Artifacts in `tools/bench/out/`:
`scrub-cost-storm-radar.json` (warm, 20 s warmup, 3 velocities × 3 variants ×
3 drags), `scrub-cost-storm-radar-cold.json` (6 s warmup, same matrix), and
`scrub-cost-storm-radar-coldwarmup{,-b,-c}.json` (the discriminating condition).

**The first result is a methodological one: a warm route cannot decide this.**
With the default 20 s warmup, or with a 6 s warmup once an earlier velocity has
already walked the timeline, every previewed instant is already buffered and the
matrix reads **0 ms TTFP, 100 % fresh, 0 B during scrub, 0 ms settle, 2 pops**
on _both_ variants, at all three velocities. Every criterion "passes" and
nothing has been tested: `bytes ≤ baseline` is `0 ≤ 0`. That state is recorded
in `scrub-cost-storm-radar.json` and it is **not** the §11.6 evidence.

**The discriminating condition, and the numbers that matter.** A 6 s warmup with
a single velocity (`--velocities medium --repeat 2 --quiesce-ms 500`) leaves the
timeline genuinely unbuffered when the thumb goes down. Three independent runs:

| run | variant                    | bytes during scrub | TTFP | fresh-frame | settle | pops | drag fps |
| --- | -------------------------- | -----------------: | ---: | ----------: | -----: | ---: | -------: |
| a   | baseline (motion tier OFF) |          306.3 KiB | 0 ms |      37.5 % |   0 ms |    2 |    103.2 |
| a   | `scrubLod` ON              |            **0 B** | 0 ms |      37.5 % |   0 ms |    2 |    114.3 |
| b   | baseline                   |        1,924.9 KiB | 0 ms |      37.5 % |   0 ms |    2 |     97.3 |
| b   | `scrubLod` ON              |            **0 B** | 0 ms |      37.5 % |   0 ms |    2 |    114.5 |
| c   | baseline                   |        2,198.9 KiB | 0 ms |      37.5 % |   0 ms |    2 |    100.7 |
| c   | `scrubLod` ON              |            **0 B** | 0 ms |      37.5 % |   0 ms |    2 |    113.9 |

- **The hard byte criterion passes, and not trivially.** Bytes-during-scrub goes
  **0.30–2.15 MiB → 0 B** (`×0`) in three independent runs. A motion tier that
  fetched _more_ than full detail would be worse than nothing; this one fetches
  nothing at all under the held thumb.
- **Fresh-frame is not the price.** 37.5 % in both variants, identical in all
  three runs — the tier costs no freshness on this route.
- **TTFP 0 ms** in both variants (the governor's data-readiness proxy; the
  render-side companion `firstFrameAfterGrabMs` ran 5.5–36.5 ms and does not
  separate the variants).
- **Pops = 2** in both, which per the harness's own note is the interactive-bit
  broadcast, not visible popping.
- **Rollback drill: BEHAVIOR-IDENTICAL**, from the two full matrices (which
  include the `baseline-after` variant the drill needs): `preview-never-gates`
  HELD ×27 and the restore invariant HELD ×27 in each, 0 violations, 0 errors,
  `scrubLod` back to `null` and the interactive bit clear. The three
  discriminating runs above are 2 variants × 2 drags each (HELD ×4 apiece) and
  carry no rollback verdict of their own.
- Drag fps is **+11 to +17 fps** under the tier, consistently. Treat that as a
  side observation, not an acceptance metric: this harness is not `frame-cost`.

**What this does and does not license.** Harness verdict on this route:
**KEEP-CANDIDATE**. It is **one route, and not one of the three the clause
names** — §11.6 slates the wiring for deletion only on failure across NYC taxi,
`/drive` and BIXI together, and all three are unopenable in this tree (v2
archives; no cheap local `.parquet` for a v3 rebuild). So **DT-4 and the §11.6
keep-vs-delete decision are NOT discharged** — they are now blocked on archives
rather than on a missing measurement, which is a materially better place to be.
`scrubLod` stays **DEFAULT OFF with zero showcase call sites** regardless: this
harness applies it in-page through the live tileset's own `setOptions` and
reverts on browser close, exactly as designed.

**One environment trap, because it will bite the next person.** The first
`scrub-cost` run reported `governor NO` and a HOLLOW RUN with all five metrics
absent — and it was **not** the v3 archive break (the three tilesets opened
fine). Vite's dep-optimizer pre-bundles `@poopdeck.gl/playback` and
`@poopdeck.gl/react` (`examples/showcase/vite.config.ts`), and that cache is
**not invalidated when a workspace package's `dist` is rebuilt** — the warning
already written at `examples/showcase/src/pages/DemoPageImpl.tsx:34-38`. The
cached chunk was 8 days old and predated `getScrubQoeStats` entirely, so the
harness's governor duck-type could never match. Clearing
`examples/showcase/node_modules/.vite/deps` and restarting the dev server took
the run from `governor NO` to `governor yes, motion tier applied: yes`. **Any
measurement of working-tree package code through the showcase must clear that
cache first**, or it silently measures whatever was bundled last. The O1 traces
in §10.5 were re-recorded after the clear for exactly this reason.

### 10.7 DT-4 — the scrub keep-vs-delete decision, run against §10.6

DT-4 is not a mechanism; it is a **recorded decision procedure** over the §11.6
measurements. Those measurements now exist (§10.6), so the tree can be walked.
The wiring under decision is fully implemented, DEFAULT OFF, with zero showcase
call sites.

**Branch 1 — "spatial axis already at target with `scrubLod` off, so delete."**
**REJECTED, on evidence.** The clause fires only if parents resident via
best-available already make previews free. They do not: the off-state baseline
fetches **306.3 KiB / 1,924.9 KiB / 2,198.9 KiB** during the drag across three
independent runs. The motion tier is doing real work, so the deletion clause
does not apply and `scrub-lod.test.ts` does not retire.

**Branch 2 — "spatial axis wins measurably, so wire it as a chassis default."**
**INDICATED BUT NOT DISCHARGED.** On the measured route every criterion passes:

| §11.6 criterion                            | Threshold                          | Measured (3 runs)        |              |
| ------------------------------------------ | ---------------------------------- | ------------------------ | ------------ |
| bytes-during-scrub (hard)                  | ≤ baseline                         | 0.30–2.15 MiB → **0 B**  | ✅           |
| time-to-first-pixel                        | < 16.7 ms from a resident tile     | **0 ms** both variants   | ✅           |
| pop / oscillation count                    | ~1–2 per drag                      | **2** both variants      | ✅           |
| fresh-frame fraction                       | no regression                      | **37.5 % both variants** | ✅ (no cost) |
| rollback drill                             | off = byte- and behavior-identical | **BEHAVIOR-IDENTICAL**   | ✅           |
| G7 preview-never-gates + restore invariant | must hold                          | **HELD ×27**             | ✅           |

**Why it is not discharged: one route, and the wrong one.** §11.6 names NYC
taxi, `/drive` and BIXI — three _heavy_ routes. The run covers
`/demo/storm-radar`, a locally rebuilt v3 archive, because the three named
routes resolve to `formatVersion: 2` archives the working-tree reader cannot
open (§8.4 R1). A motion tier's value is a function of how much detail it drops,
so a light route is the least informative place to measure it: the fresh-frame
figure in particular (37.5 %, identical in both variants) is a property of this
route's bucket cadence, not evidence about a 10 M-vertex one.

**Verdict: KEEP, do not wire.** The deletion clause is answered — the wiring
stays. Promoting it to a showcase chassis default is _not_ authorized on
single-route evidence, and no call site was added.

**What closes it:** rebuild NYC taxi, `/drive` and BIXI at v3 (or run the
harness against a HEAD-committed v2 reader) and re-run `scrub-cost.mjs`. If the
byte criterion holds on all three, branch 2 discharges and the chassis default
lands. The temporal axis (G5) stays counted out regardless until DT-3's reduced
tier exists — today's coarse aggregator re-buckets without reducing, so a
temporal drop fetches _fatter_ tiles, which violates the byte-discipline
constraint outright.

### 10.8 DT-5 — the interval read-amplification trigger, built and evaluated

DT-5 has two deliverables and the plan is explicit that only the first is
unconditional: build the trigger instrumentation now, and draft the erratum
**only if** the condition holds. "No number, no erratum."

**Instrument (built).** `stt-optimize inspect --read-amp <window>` — a
directory-only walk in the fast `--sample 0` class: no decode, integer
arithmetic, order-independent (every term is a sum over entries, pinned by a
reversal test). From each entry's `(time_start, time_end, cover_t_min, length)`
it computes, over a sliding window:

- **fetched bytes** — expected bytes fetched across the sweep;
- **long-lived bytes** — of those, the bytes attributable to tiles the window
  reaches _only_ because a trailing `time_end` extends past the entry's own
  start bucket. That is the §2.2 pathology stated as a quantity;
- **amplification share** = long-lived ÷ fetched, the trigger number;
- a **residual-lifetime histogram** in whole windows past the entry's own
  bucket, with a saturating top bin.

**Condition: NOT TRIGGERED on the archive available to measure.** Run against a
locally rebuilt `storm-tracks` (a storm-cell dataset, i.e. the right _shape_ of
heavy-tailed interval data the condition names):

```
window            3600000 ms      windows swept     5
fetched bytes     2212860         long-lived bytes  0
amplification     0.0%  (trigger: 25%)
verdict           not triggered — no erratum is drafted
residual lifetime:  0 : 4705      ← every entry confined to its own bucket
```

All 4,705 entries land in residual bin 0: not one interval outlives its start
bucket, so there is nothing for segregation to fix here.

**So no erratum is drafted, and that is the correct outcome** — the plan's
Phase 5 deliverable for a condition-gated item is the reviewed design plus the
instrumentation, and both exist.

⚠️ **Honest limit on this evaluation.** `storm-tracks` is small (186 source
features) and the fleet's genuinely heavy-tailed candidates — long trips, the
multi-day storm-cell archives — are `formatVersion: 2` and unreadable by this
tree (§8.4 R1). The instrument is the durable deliverable; re-run it on those
datasets after R1 and the condition may yet fire. The 25 % threshold itself is
proposed and explicitly **not fit** (P1) — it should be fit before any adoption.
