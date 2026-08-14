# Bench baselines

> **None of the files here is a live gate.** They are _historical records_ of
> what `tools/bench/src/index.mjs` once measured. The CI job that compared
> against them — `bench-regression` — was **retired on 2026-08-10**, and the
> archive it compared against has been deleted. Read
> [§ Why there is no gate](#why-there-is-no-gate) before citing a number from
> this directory as evidence of anything.

## What is committed

| File                                           | Recorded against                                                                   | Captured   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ---------- |
| [`earthquakes-v2.json`](./earthquakes-v2.json) | `examples/showcase/public/data/earthquakes-v2.stt` (~83 MB, USGS M4.5+ 2020-24)    | 2026-05-24 |
| [`ais-all-us.json`](./ais-all-us.json)         | `examples/showcase/public/data/ais-all-us.stt` (~1.16 GB, 38.5M AIS pings 2023-01) | 2026-05-24 |
| [`earthquakes-ci.json`](./earthquakes-ci.json) | a 750,205-byte `earthquakes-ci.stt` that is **not** the file later committed       | 2026-05-24 |

All three predate the packed format. The archives they name were single-file
`.stt` containers; no reader in this repo opens that shape any more, so none of
these numbers can be re-measured as recorded. They are kept as evidence of what
the pipeline once did, not as a target.

## Why there is no gate

`bench-regression` re-ran the bench against `earthquakes-ci.stt` and failed if
any metric drifted past ±15%. Running its exact command on 2026-08-10 produced:

```
Error: STT manifest: invalid JSON (Unexpected token 'S', "STTqZ*"... is not valid JSON)
```

Three independent breakages, each on its own fatal:

1. **The fixture was the wrong format.** `earthquakes-ci.stt` began
   `53 54 54 04` — `STT` + version byte 4, the retired single-file container.
   The packed migration removed every reader for it (`ArchiveWriter` and
   `ArchiveReader` survive only in comments), so `STTArchive` treated the
   container as a packed `manifest.json` and JSON-parsed its header. The Rust
   side is no better: `stt-optimize inspect --archive …/earthquakes-ci.stt`
   answers `Invalid archive format: manifest JSON decode failed`. This is
   **not** a symptom of the in-flight v2→v3 bump — it fails before the version
   gate is reached.

2. **The harness cannot read packed archives at all.** `bench.mjs`'s
   `createFileFetch` serves every Range request out of one in-memory buffer, so
   there is nowhere for `index/<hash>.sttd` and `packs/<hash>.sttp` to come
   from. Pointing it at a genuine packed manifest gets you
   `STT directory truncated: got 5024 bytes, expected 156`. **Re-cutting the
   fixture would not have revived the job.**

3. **The baseline described a different archive.** `earthquakes-ci.json` records
   `archive_size_bytes: 750205`; the `earthquakes-ci.stt` that was later
   committed alongside it was 2,865,735 bytes. Even with (1) and (2) fixed,
   `--check` would have compared this run against numbers taken from some other
   file.

Nobody noticed because of backlog T2: GitHub Actions has never executed in this
repository, so every CI job here is enforced by local discipline, and this one
was never run by hand. A gate that cannot run is worse than an absent one —
it launders confidence — so it was retired rather than left in place with a
`|| true` or a skip.

The deleted archive is still in git history if it is ever wanted for
forensics:

```bash
git show 5bc30e3:tools/bench/baselines/earthquakes-ci.stt > /tmp/earthquakes-ci.stt
```

## Bringing the gate back

Two prerequisites, in this order. Neither is a baselines-directory change, which
is why this file cannot fix it on its own.

1. **Teach `tools/bench/src/bench.mjs` to read a packed archive.** It needs a
   URL-aware local fetch — resolve the request URL against the archive
   directory and read that file, the way
   [`policy-replay.mjs`](../src/policy-replay.mjs) already does (it accepts a
   directory and appends `manifest.json`). Roughly twenty lines, replacing
   `createFileFetch`'s single-buffer assumption. Keep the single-buffer path for
   nothing: no reader in the repo produces its input any more.

2. **Mint the fixture AFTER the v2→v3 format break settles.** Anything built
   from this tree today lands at `formatVersion: 3`
   (`crates/stt-core/src/pack/mod.rs`, `packages/core/src/archive.ts`), which a
   HEAD checkout's reader rejects with
   `unsupported formatVersion 2 (expected 3)` in reverse. A fixture minted
   mid-break breaks again the moment someone checks out HEAD. The rebuild
   window is R1; sequence the fixture after it.

Then the fixture must be **deterministic** — byte-identical on re-run — or the
tolerance comparison is measuring the generator's noise rather than the
reader's performance. Build it the way the reader-side goldens are built, from
a generator committed next to it and synthetic SQL rather than a network fetch:
see [`packages/core/scripts/make-v2-golden.sh`](../../../packages/core/scripts/make-v2-golden.sh),
which drives `stt-build` off DuckDB `:memory:` `VALUES` and re-runs to a no-op
diff. Prove the determinism by building twice into different directories and
diffing, and say so in the commit.

Full finding and its history:
[`docs/roadmap/measurements-2026-08.md` §8.6](../../../docs/roadmap/measurements-2026-08.md).

## Recording and checking a baseline (for when the above is done)

```bash
# Capture the numbers against an archive the bench can actually open.
node tools/bench/src/index.mjs path/to/archive \
  --baseline tools/bench/baselines/<name>.json

# Compare a later run against it.
node tools/bench/src/index.mjs path/to/archive \
  --check tools/bench/baselines/<name>.json --tolerance 0.10
```

Lower-is-better metrics (`open_ms`, `decode_p95_ms`) fail when the new value
exceeds baseline by more than the tolerance. Higher-is-better metrics
(`decode_tiles_per_s`, `decode_mb_per_s`, `coalesce_ratio`,
`compression_ratio`) fail when the new value falls below baseline by more than
the tolerance.

Commit the `.json`. Committing the archive is what produced the `earthquakes-ci`
mess: the binary silently outlived the format that could read it, and its
presence is what made the dead job look alive. If a committed fixture is
genuinely needed, commit its **generator** too, so the bytes can be re-derived
rather than trusted.
