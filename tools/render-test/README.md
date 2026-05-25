# `@stt/render-test`

Browser-rendered evaluation for the STT showcase: real Chromium + WebGL,
exercising every demo end-to-end and reporting perf + visual fidelity.

## Quick start

```bash
pnpm --filter @stt/render-test sweep             # run against committed baselines
pnpm --filter @stt/render-test sweep:update      # re-bless baselines after a deliberate render change
```

Open `tools/render-test/output/report.html` for the per-dataset card view
(perf metrics, baseline vs current vs diff thumbnails, long-task counts,
probe-channel timings). `output/report.json` is the same data in machine-
readable form.

## What the sweep does, per dataset

1. Loads `/demo/<id>` in a fresh page; tracks every response to the dataset's
   `.stt` URL.
2. Waits for the deck.gl canvas to produce non-blank pixels (`ttffMs`). If
   the archive request returned a 4xx _or_ Vite's HTML SPA fallback (200 OK,
   `text/html` — what you get when the .stt file is missing), the dataset
   is marked `data-missing`. Without the content-type check the base-map
   alone would fool the live-canvas heuristic.
3. Records a warmup perf sample while caches populate.
4. Scrubs the time slider to 25% and 75% of the dataset's range. At each
   anchor:
   - captures a screenshot of the static frame and diffs it against
     `baselines/<id>/<anchor>.png` via `pixelmatch`,
   - then starts playback and samples 5s of frame-times, JS heap,
     `measureUserAgentSpecificMemory` (where available), long-tasks, and
     the `__sttProbe` channels from `@stt/deck.gl` (`tilePrepare`, `decode`,
     `consolidations`, `renderLayers`).

The fidelity capture happens _before_ play starts so the baselines remain
reproducible across runs — playback would advance sim-time and every PNG
would land at a different frame.

## Status states

| status              | meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `ok`                | live canvas + perf samples + fidelity diff completed                     |
| `data-missing`      | the `.stt` archive request 4xx'd or returned the HTML SPA fallback       |
| `render-failed`     | archive bytes loaded but the canvas stayed blank within the 60s timeout |
| `webgl-unavailable` | Chromium could not create a WebGL context (CI without SwiftShader)       |

`render-failed` is real signal — under SwiftShader, datasets such as the
500K-trip NYC paths at zoom 14 do not produce a frame within a minute.
That's the cost of swapping a GPU for software rendering, and the report
surfaces it rather than masking it.

## Knobs

Environment variables read by `tests/sweep.spec.ts`:

| var                       | default | purpose                                                    |
| ------------------------- | ------- | ---------------------------------------------------------- |
| `STT_BLESS_BASELINES=1`   | unset   | overwrite every baseline this run produces                 |
| `STT_SWEEP_FILTER=<sub>`  | unset   | only run datasets whose id contains `<sub>`                |
| `STT_SWEEP_SAMPLE_MS`     | 5000    | length of each perf sample window in ms                    |
| `STT_SWEEP_WARMUP_MS`     | 8000    | settle time before the warmup sample, in ms                |

## Updating baselines

When you make an intentional rendering change, the suite goes red on the
affected datasets. To accept the new look:

```bash
pnpm --filter @stt/render-test sweep:update
git add tools/render-test/baselines
```

Baselines are committed; `output/` is gitignored.

## Per-dataset render budget

The showcase is heavy under SwiftShader. The runner's 60s "first live
frame" cutoff is enough for every dataset that fits in software rendering
but the two zoomed-in 500K-trip paths demos (`nyc-taxi-paths`,
`nyc-taxi-points`) cannot meet it. Both are correctly flagged
`render-failed` — they're fine on real GPUs but out of budget for the
headless suite. Consider running them in a dedicated GPU-backed Playwright
project if you want fidelity baselines for them.
