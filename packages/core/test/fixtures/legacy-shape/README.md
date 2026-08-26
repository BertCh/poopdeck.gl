# `legacy-shape/` — the FROZEN pre-compact-encoding corpus

**Do not regenerate these. No script produces them, and none should.**

Every other vector directory here is rebuilt by a generator
(`conformance/make-vectors.sh`, or
`crates/stt-core/examples/make-golden-fixture.rs` for `packed-golden/`), so it
always reflects *today's* encoder. This one is the opposite: it is a snapshot of what the writer emitted
**before** the 2026-07 payload work added

- `TILE_META.st` / `TILE_META.et` — compact `UInt32` feature times
  (`time-delta` capability), and
- `TILE_META.vq` — quantized per-vertex values (`vertex-value-quant`),

plus the additive `part_offsets` CORE column. Its whole job is to prove the
reader still decodes archives that carry none of them — the shape of every
archive in the published fleet at the time it was cut.

Regenerating it would re-encode the corpus into the new compact shapes and turn
the reader's `legacy-shape-backcompat.test.ts`
(`poopdeck:packages/core/test/`) into a test of the new path instead of the old
one. That test walks the raw frames and asserts the three keys are absent, so it
would fail loudly rather than silently — but the fix is to restore these bytes,
never to relax the assertion.

## Provenance

| dir         | source                                                    |
| ----------- | --------------------------------------------------------- |
| `flows/`    | 6 tiles lifted verbatim out of the shipped `nyc-taxi-flows` archive |
| `currents/` | 6 tiles lifted verbatim out of the shipped `ecco-currents` archive |
| `points/`   | byte-for-byte copy of `fixtures/v2-golden/` as committed at `c13970a` |
| `tracks/`   | byte-for-byte copy of `fixtures/v2-golden-tracks/` as committed at `c13970a` |

`flows/` and `currents/` re-cut real tile blobs into one pack + one whole-load
v5 directory (the technique the reader's `helpers/packed-fixture.ts` uses); the
manifests keep the source `schemas` registry and capability list, and the tile
PAYLOAD bytes are untouched writer output. `points/` is paged and `tracks/`
whole-load, so both container paths are covered.
