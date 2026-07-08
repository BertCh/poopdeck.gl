# Bench baselines

Recorded outputs of `tools/bench/src/index.mjs` for fixed sample archives.
The CI job `bench-regression` re-runs the bench against the same archive
and fails if any metric drifts outside the tolerance (default ±15%).

## Committed baselines

| File                                           | Source archive                                                                     | Captured   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| [`earthquakes-v2.json`](./earthquakes-v2.json) | `examples/showcase/public/data/earthquakes-v2.stt` (~83 MB, USGS M4.5+ 2020-24)    | 2026-05-24 |
| [`ais-all-us.json`](./ais-all-us.json)         | `examples/showcase/public/data/ais-all-us.stt` (~1.16 GB, 38.5M AIS pings 2023-01) | 2026-05-24 |

These two were chosen to anchor the perf-regression CI gate at two scales:
small (300k tiles, 200ms open) and large (560k tiles, 1.27 GB compressed,
340 ms open with the O(n²) TemporalLookup fix in place).

The CI workflow in `.github/workflows/ci.yml` currently invokes
`stt-generate earthquakes --cached` to build an `earthquakes.stt` fixture,
but `--cached` is not a real flag — the step swallows its failure with
`|| true` and the regression check silently skips. Migration plan: replace
that step with a deterministic synthetic-fixture generator (see issue
backlog) and rename `earthquakes-v2.json` → `earthquakes.json` once the
synthetic archive matches its characteristics.

## Recording a new baseline

```bash
# Capture the numbers against any .stt file.
node tools/bench/src/index.mjs path/to.stt \
  --baseline tools/bench/baselines/<name>.json
```

Commit the `.json` only (`*.stt` is gitignored).

## Checking against a baseline

```bash
node tools/bench/src/index.mjs path/to.stt \
  --check tools/bench/baselines/earthquakes.json --tolerance 0.10
```

Lower-is-better metrics (`open_ms`, `decode_p95_ms`) fail when the new value
exceeds baseline by more than the tolerance. Higher-is-better metrics
(`decode_tiles_per_s`, `decode_mb_per_s`, `coalesce_ratio`,
`compression_ratio`) fail when the new value falls below baseline by more
than the tolerance.
