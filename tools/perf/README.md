# @poopdeck.gl/perf

Real-WebGL perf harness for the STT showcase. Drives the same demos a user
opens in their browser, but with structured scenarios, frame-time histograms,
long-task tracking, and baseline regression checks.

## Why this exists

The pre-existing `tools/render-test/probe-*.mjs` scripts all launch Chromium
with `--use-gl=swiftshader` (software WebGL). For GPU-heavy layers — heatmaps
in particular — SwiftShader numbers are not representative of what users
see. This harness defaults to a real GPU backend (ANGLE → Metal on macOS,
Vulkan on Linux, via `--headless=new`), with SwiftShader as an opt-in for CI
machines without a GPU.

## Quick start

```bash
# Make sure the showcase dev server is up (in another terminal):
pnpm --filter @poopdeck.gl/showcase dev

# Run the harness against a demo:
pnpm --filter @poopdeck.gl/perf perf -- nyc-taxi-od-heatmap

# Save the current numbers as a baseline:
pnpm --filter @poopdeck.gl/perf perf -- nyc-taxi-trips --baseline write

# Check current numbers against the saved baseline:
pnpm --filter @poopdeck.gl/perf perf -- nyc-taxi-trips --baseline check
```

## What it measures

Per scenario, recorded in a labeled bucket:

| Metric                                         | What it tells you                                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `fps_p50` / `fps_p5`                           | Median + 5th percentile FPS — p5 catches the worst hitches users feel                                            |
| `frame_p95_ms`, `frame_p99_ms`, `frame_max_ms` | Frame-time tail; large p95 means stutter                                                                         |
| `longTaskCount` / `longTaskMaxMs`              | Main-thread tasks ≥ 50 ms (Long Tasks API). Zero with a huge `frame_p95` means GPU-bound; nonzero means JS-bound |
| `networkMb` / `networkCount`                   | `.stt` range-request bytes pulled during the scenario                                                            |
| `heapDeltaMb`                                  | JS heap growth across the whole run                                                                              |
| `workerCount`                                  | Workers created (sanity check: 4 = WorkerTileDecoder pool spun up)                                               |

## Built-in scenarios

- `playback` — click play, sample 6 s. Stresses the consolidation cache, GPU
  upload cadence, and decode pipeline under steady animation.
- `paused-idle` — pause and idle 4 s. A well-behaved scene should sit at the
  vsync rate with zero CPU work. Jank here means some per-frame work is
  firing even when nothing changes.
- `zoom` — pause, then mouse-wheel zoom in N times and back out N times.
  Stresses the tileset's request-cancel + prefetch path. Janky zoom usually
  points to a tile-churn / consolidation rebuild storm, not GPU cost.

## Backends

```bash
--backend gpu          # default — ANGLE-Metal (macOS) / Vulkan (Linux), via --headless=new
--backend swiftshader  # software WebGL, for CI without a GPU
```

The GPU backend uses `--headless=new` deliberately. The legacy `--headless`
flag silently falls back to SwiftShader regardless of the other GPU flags.

## Baseline + regression check

`--baseline write` snapshots the current run to
`tools/perf/baselines/<demo>-<backend>.json`. `--baseline check` compares a
fresh run against that file, with `--tolerance` (default 0.15) controlling
the regression threshold. Lower-is-better metrics: frame_p95_ms,
longTaskCount, longTaskMaxMs. Higher-is-better: fps_p50, fps_p5.

A non-zero exit code on regression makes this CI-friendly.

## Reading the output

```
================================================================================================
nyc-taxi-od-heatmap [gpu]   3 scenarios   workers=11   heap=+28.6MB
================================================================================================
  scenario          fps_p50   fps_p5   frame_p95   longTasks    maxLT    netMB
  ----------------------------------------------------------------------------------------------
  playback              119      3.8     266.6ms           0      0ms     0.81  <- jank
  zoom                120.5     95.2      10.5ms           0      0ms     3.03
  paused-idle         120.5    107.5       9.3ms           0      0ms        0
```

- `fps_p50` 119 + `fps_p5` 3.8: median is at the display refresh rate (120Hz on this
  machine) but one frame in twenty drops to ~4 fps. Animation feels mostly smooth
  with occasional hitches.
- `frame_p95` 266 ms with `longTasks` 0: the stall is on the GPU, not the JS main
  thread. Heatmap aggregation rebuilds are the suspect.
- `zoom` and `paused-idle` are clean — the issue is animation-specific.

## Known limitations

- **Single-run variance is high** for large datasets (cold tile cache, GPU
  process warm/cold, etc.). For trustworthy regression detection, run the
  same demo 3–5 times and look at the trend; one-shot numbers carry ±10–30%
  noise on heavy demos.
- **No CDP integration yet** — would let us pull actual paint times, GPU
  memory, and per-render-pass timings. Planned follow-up.
- **No in-app instrumentation hooks** — the harness reads from
  `window.__sttPerf` (a probe it installs) but does not yet wrap
  `WorkerTileDecoder`, `consolidatePoints`, or per-tile loads with timings.
  When we want decode/consolidate p95 numbers, the next step is to publish
  those from inside `@poopdeck.gl/core` + `@poopdeck.gl/layers` behind a `?perf=1` query
  flag and read them via the snapshot.

## Files

```
tools/perf/
├── src/
│   ├── cli.mjs              # CLI entry point + scenario sequencing
│   ├── browser-profile.mjs  # Chromium launch args for gpu / swiftshader backends
│   ├── page-probe.mjs       # in-page rAF + longtask + resource-timing probe
│   ├── scenarios.mjs        # playback / paused-idle / zoom
│   └── report.mjs           # percentiles, console summary, baseline diff
├── baselines/               # checked-in baselines (one per demo+backend)
└── output/                  # per-run JSON reports (gitignored)
```
