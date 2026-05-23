# Bench baselines

Recorded outputs of `tools/bench/src/index.mjs` for fixed sample archives.
The CI job `bench-regression` re-runs the bench against the same archive
and fails if any metric drifts outside the tolerance (default ±15%).

## Recording a new baseline

```bash
# Build a sample archive (small, deterministic).
./target/release/stt-generate earthquakes --cached \
  --output tools/bench/baselines/earthquakes.stt

# Capture the numbers.
node tools/bench/src/index.mjs tools/bench/baselines/earthquakes.stt \
  --baseline tools/bench/baselines/earthquakes.json
```

Commit `earthquakes.json` (NOT `earthquakes.stt` — `*.stt` is gitignored).

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
