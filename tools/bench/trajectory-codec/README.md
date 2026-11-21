# trajectory-codec bench

Renderer-side half of the trajectory-representation investigation (branch
`trajectory`, 2026-11). The record, the encoder-side harnesses and all the
measurements live upstream, because the format is upstream:
`stt:docs/roadmap/trajectory-codec-2026-11.md`, with harnesses
`stt:crates/stt-core/examples/trajectory-codec.rs` and
`stt:crates/stt-core/examples/trajectory-lossy.rs` (on the STT repo's
`trajectory` branch).

## The findings that touch this repo

- **Lossless, tile-local predictive coding of quantized trajectories pays.** It
  shrinks whole tiles −38 % (AIS) and −48 % (drifters) against today's
  `--quantize-coords` tiles, and −53 % / −65 % against default f64 tiles.
  Per-feature `vertex_time` delta coding alone is −39 % / −78 % on that column
  and needs no quantization. If it ships, it is a new must-understand capability
  decoded in `@poopdeck.gl/core`'s tile decoder. Every backend keeps receiving
  the same `Float64Array` positions and absolute vertex times, so no layer
  changes.
- **The reader cost is small.** `decode-bench.mjs` measures +13 ms (AIS) /
  +7 ms (drifters) per million vertices over today's quantized affine path, with
  an exact round trip. That work lands in the decoder worker pool, not on the
  render thread.
- **Fitted motion curves (Hermite / Bézier, the TRiGS idea) are a NO-GO as a
  storage format.** At equal measured error they tie or lose to linear
  keyframes in bytes. They would add a new interpolation path to deck, three,
  maplibre and cesium, plus the trail-window logic in `AnimatedTripsLayer`, for
  no size win. Their one real gain is lower mean error (smoother shapes), which
  is a rendering choice that needs no new format.
- **A swept-bounds "store each segment once" index is a NO-GO.** It could only
  recover the 14–24 % clip duplication within a zoom, while the 9× cost is
  across zooms. That one is `--additive-lod`, which this reader deliberately
  does not declare yet (`packages/core/src/archive.ts`, the
  `additive-partition` note).

## Files

| file               | what                                                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prep.py`          | Raw AIS / GDP-drifter CSV → trajectory GeoParquet for `stt-build` (runs split at gaps, never bridged); `export` writes the flat binary the lossy harness and the decode bench read. Needs duckdb, pyarrow, numpy. |
| `decode-bench.mjs` | Reader cost of the per-feature predictor + varint decode against the current Int32 world-grid affine. Checks the round trip before timing.                                                                        |

```bash
python prep.py ais      AIS_2023_01_09.csv ais.parquet
python prep.py drifters drifters-hourly-2021-0{1,2,3}.csv drifters.parquet
python prep.py export   ais.parquet ais.bin            # add --underway for the smooth subset
node decode-bench.mjs ais.bin 1                         # quant step in metres
```
