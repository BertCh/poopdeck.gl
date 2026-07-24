---
name: tuning-stt-tiles
description: >-
  Optimize, lint, and shrink a built SpatioTemporal Tiles (.stt) archive for
  publishing. Use when a user wants a .stt to be smaller or faster, asks about
  stt-optimize inspect/doctor/diff/order-audit, zstd level, quantization,
  blob-ordering, per-column cost, "why is my tileset so big", or preparing a
  dataset for deploy. Enforces the project rule: shrink via zoom-range clamp,
  temporal bucketing, and non-lossy byte levers — NEVER by thinning features.
license: MIT
metadata:
  version: '0.5.0'
---

# Tuning STT tiles for publishing

The optimize loop over a **built** archive is: **inspect → doctor → (fix) → diff**.
All of `stt-optimize`'s reporting subcommands emit `--format json`.

> **Doc paths** are repo-relative. With no repo on disk, use the MCP
> `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**.
> Everything load-bearing below is inlined.

## The cardinal rule — no thinning

STT's philosophy is _comprehensive data_. **Never drop, sample, or aggregate
features just to hit a byte budget.** Legitimate size levers, in order:

1. **Clamp the zoom range** (`--min-zoom`/`--max-zoom` at build) to what will
   actually be viewed. This is the biggest, safest lever.
2. **Coarsen the temporal bucket** (`--temporal-bucket`) and add a
   **`--temporal-lod`** pyramid so coarse zooms are cheap without losing the fine tier.
3. **Non-lossy byte levers** (below): zstd level, blob-ordering, pack size.
4. **Opt-in coarse tiers**: `--summary-tier h3|quadbin` and raster are _additions_
   for low-zoom density, not replacements for the raw features.

Lossy encoding (`--quantize-coords`, `--quantize-attrs-auto`) is opt-in and only
on evidence — see `stt-optimize doctor`/`recommend`'s LOSSY-marked advice.

## Step 1 — Inspect and lint

- **In an MCP session:** call `dataset_report` (from the `stt` server) — it runs
  `stt-optimize inspect` (per-zoom directory stats, dedup + compression ratios,
  per-column compressed cost) and `doctor` (severity-ranked findings + remediation
  flags), and — with `include: ["order-audit"]` — the blob-ordering cost audit.
  Pass `sample: <N>` for large archives (a full decode of a big showcase dataset
  can be slow).
- **From a shell:** `stt-optimize inspect -a out --format json`,
  `stt-optimize doctor -a out --strict --format json`,
  `stt-optimize order-audit -a out --format json`.

`doctor` finding `code`s and their fixes (closed set):

| code                    | meaning                                         | remediation                                 |
| ----------------------- | ----------------------------------------------- | ------------------------------------------- |
| `raw-f64-column`        | unquantized float column dominates bytes        | `--quantize-attr NAME=PREC` (opt-in, lossy) |
| `expensive-feature-ids` | high-cardinality id column is costly            | drop / dict-encode the id                   |
| `dead-columns`          | columns that never vary                         | `--exclude` them                            |
| `z0-bomb`               | a whole dataset crammed under tiny bounds at z0 | raise `--min-zoom`                          |
| `unpaged-large`         | whole-load directory on a big archive           | rebuild (paged directory is default)        |
| `oversized-blobs`       | individual tiles too large                      | clamp zoom / coarsen bucket                 |
| `missing-summary-tier`  | no coarse-zoom aggregate                        | add `--summary-tier`                        |

## Step 2 — Re-encode for publish

Rebuild with the publish lever and any evidence-backed byte levers:

```
stt-build -i input.parquet -o out-pub \
  -t timestamp --temporal-bucket 1h --min-zoom 0 --max-zoom 12 \
  --publish \                    # zstd level 19
  --blob-ordering measured \     # let order-audit's winner drive layout
  --style-hints
```

`--auto encode` applies the **non-lossy** byte levers (zstd 19, blob-ordering,
pack-size) automatically while logging lossy advice as "suggested, not applied".

## Step 3 — Gate the change with a diff

Never publish a re-encode without confirming it actually shrank and didn't lose data:

- **MCP:** `diff_datasets` with `before` = the old archive, `after` = the new one.
- **Shell:** `stt-optimize diff --before out --after out-pub --format json --fail-on-growth 0`.

Check `compressed_bytes.delta` (should be ≤ 0) and that `feature_count.delta` is
`0` — **a negative feature delta means you dropped data; that's a regression, not a win.**

## Blob ordering

`order-audit` measures scrub + pan range-read cost per ordering and recommends one
(`spatial`/`time-major`/`hilbert3`). Time-heavy scrub workloads usually prefer
`time-major`/`hilbert3`; spatial pans prefer `spatial`. Feed the winner to
`--blob-ordering` (or `--blob-ordering measured` to let the build measure).

Guides: `docs/guides/tuning-tiles.md`, `docs/api/cli-reference.md`,
`docs/spec/stt-packed-format.md`.
