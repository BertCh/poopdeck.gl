# Tuning Your Tiles

Every real size or speed win in this project came from **measuring** a
dataset, not from a formula — and the wins are dataset-shaped (anywhere from
1.07× to 21×). `stt-optimize` packages that measure → interpret → decide
loop as CLI verbs, so you never have to hand-tune from folklore:

```
 source parquet ──▶ analyze / recommend --explain ──▶ stt-build --auto [encode]
                                                            │
 rebuilt dataset ◀── diff --fail-on-growth ◀── doctor ◀── inspect ◀── packed dataset
```

This guide walks the loop end-to-end. Flag tables live in the
[CLI reference](../api/cli-reference.md#stt-optimize) — this page is about
which verb to reach for and how to read what it tells you.

## 1. Before the build: analyze the source

```bash
stt-optimize analyze --input data.parquet --time-field timestamp \
  --time-format unix-ms
```

The report profiles spatial extent, temporal distribution, geometry mix,
and density — plus a **measured sample encoding**: a deterministic sample
of your features pushed through the real encoder + zstd, which calibrates
the per-zoom size estimates. At the bottom sits the **Advisor** section:
evidence-based suggestions across the wider `stt-build` flag surface
(quantization, temporal LOD, wire layout, per-tile budgets), each with the
dataset-specific rationale, a projection, and a confidence grade.

To see the full evidence table with a copy-pasteable command:

```bash
stt-optimize recommend --input data.parquet --time-field timestamp \
  --time-format unix-ms --show-command --explain
```

```
Advisor evidence:
  FLAG                         VALUE        CONFIDENCE PROJECTED
  --quantize-coords            1            high       -31% sample encode (measured)  [LOSSY - opt-in]
      → geometry is 44% of measured column bytes; at max zoom 14 one pixel covers
        ~8.5 m at lat 27.1°, so 1 m fixed-point coords stay below a quarter-pixel of error
  --blob-ordering              time-major   low        —
      → 2104344 features spread Regional across 5d 2h: playback sweeps time, so
        time-major blob order keeps consecutive time buckets in the same packs
```

Two rules to internalize:

- Suggestions marked `[LOSSY - opt-in]` (quantization, budgets) **never**
  join the suggested command and are never auto-applied. You opt in per
  flag, per dataset.
- Where it matters, projections are *measured* — the advisor trial-encodes
  your sample rather than extrapolating from a formula.

## 2. Build: `--auto` vs `--auto encode`

```bash
stt-build -i data.parquet -o my-dataset --time-field timestamp \
  --time-format unix-ms --auto
```

Bare `--auto` fills in only the basics you didn't set: zoom range and
temporal bucket. `--auto encode` additionally applies the advisors'
**non-lossy byte-level levers** — zstd level, blob ordering, pack size.
Everything else is suggestion-only, logged loudly at build time as
`suggested, not applied: <flag> — <why>`.

The line STT never crosses: **nothing that drops or degrades data is ever
auto-applied**. Quantization is opt-in per flag; the per-tile budgets
(`--maximum-tile-bytes`, `--maximum-tile-features`) stay opt-in forever —
by default a tile carries every feature that belongs in it. An explicitly
passed flag always beats any auto value. Details:
[Auto-tuning](../api/cli-reference.md#auto-tuning).

## 3. After the build: inspect, doctor, diff

### `inspect` — where did the bytes go?

```bash
stt-optimize inspect --archive my-dataset/ --sample 200
```

reports per-zoom directory stats, dedup and compression ratios, and —
the part worth reading closely — **per-column compressed cost**:

```
💾 Per-column cost (standalone IPC+zstd-19; shares, not absolute wire)
  column        dtype                        comp KB    B/feat  share%  note
  geometry      FixedSizeList(Int32, 2)        812.4      4.21   38.2%  quantized coords (stt:quant)
  speed         Float64                        673.1      7.94   31.6%  plain f64 (unquantized)
  id            UInt64                          87.0      1.02    4.1%
  ...
```

How to read a row like `speed`: a raw Float64 column carries full entropy
per row, so zstd can barely touch it — 8 bytes in is ~8 bytes out. Columns
like this are usually the single biggest lever on a dataset. If two decimal
places are enough for styling, `--quantize-attr speed=0.01` re-encodes it
as fixed-point integers, which are both smaller and far more compressible
(measured passes in this repo landed 50–75% shrink on such columns).

### `doctor` — findings with remediation flags

`inspect` tells you where the bytes went; `doctor` tells you which of those
numbers are a problem and what flag fixes each one:

```bash
stt-optimize doctor --archive my-dataset/
```

```
2 finding(s): 0 critical, 1 warning, 1 info

[WARNING] raw-f64-column
  1 property column(s) ship as raw Float64 and together cost 31.6% of this
  tileset's measured column bytes: `speed` (31.6% of column bytes, 7.94 B/feature). ...
  fix: --quantize-attr <name>=<prec> (per column, e.g. --quantize-attr speed=0.01)
  fix: --quantize-attrs-auto (range-adaptive u16 for every remaining raw Float64 property)
  projected: ~19% smaller dataset wire (~4.51 of 23.80 MB) after quantizing the
  flagged columns, assuming ~60% per-column shrink (estimated from measured column costs)

[INFO] dead-columns
  property column `source` is a single constant value across all 8 sampled tiles ...
  fix: --exclude source
```

Every rule keys off numbers measured for *this* tileset and cites them in
its message; the rule catalog (raw f64 columns, expensive feature ids, dead
columns, z0 pyramid bombs, unpaged large directories, oversized tiles,
missing summary tier) is in the
[doctor reference](../api/cli-reference.md#stt-optimize-doctor). In CI, add
`--strict` — it exits non-zero when any Warning-or-worse finding exists, so
a regression fails the pipeline instead of shipping.

### `diff` — gate the rebuild

After acting on a finding, rebuild to a *new* directory and compare:

```bash
stt-optimize diff --before my-dataset/ --after my-dataset-v2/
```

You get totals, per-zoom, and per-column deltas — confirming the projected
win actually landed (or catching a lever that backfired on your data). For
recurring pipelines, `--fail-on-growth 5` turns the same comparison into a
CI size gate: exit non-zero if the rebuild grew more than 5%.

## 4. Bake render defaults: `--style-hints`

Tuning isn't only about bytes — the first render of a fresh dataset usually
needs a color-ramp domain, a playback speed, and a layer choice. Those are
measurable too. Build with:

```bash
stt-build -i data.parquet -o my-dataset --time-field timestamp \
  --time-format unix-ms --auto --style-hints
```

and the archive metadata carries a `style_hints` block: per-numeric-property
percentiles with a `suggested_domain` of `[min, ~p97]` (one outlier must not
dim the whole ramp), categorical cardinalities, a suggested playback
duration, and a layer-type hint. On the JavaScript side it surfaces as
`(await archive.getMetadata()).styleHints`:

```ts
const meta = await archive.getMetadata();
const speed = meta.styleHints?.properties.find((p) => p.name === "speed");
const domain = speed?.suggestedDomain ?? [0, 30]; // baked [min, ~p97]
```

Hints are **defaults, always overridable** — layer props, scene specs, and
user config all win over them. They exist so a third-party build renders
sensibly on the first try instead of after a measure-percentile-hand-edit
loop. Flag details:
[Style hints](../api/cli-reference.md#style-hints-build-time-render-defaults).

## 5. A worked pass, start to finish

A real-shaped session on a 2M-row vessel dataset:

```bash
# 1. What does the advisor see?
stt-optimize recommend -i ais.parquet -t timestamp --time-format unix-ms \
  --show-command --explain
#    → zoom 3–10, 1h bucket; suggests --quantize-coords 5 [LOSSY - opt-in]

# 2. Build with the safe levers + the suggested lossy one, opted into:
stt-build -i ais.parquet -o ais-tiles --time-field timestamp \
  --time-format unix-ms --auto encode --quantize-coords 5 --style-hints

# 3. Where did the bytes go, and is anything wrong?
stt-optimize inspect --archive ais-tiles/ --sample 200
stt-optimize doctor  --archive ais-tiles/
#    → [WARNING] raw-f64-column: `sog` 28% of column bytes
#    → [INFO] dead-columns: `source` constant — verify, then --exclude

# 4. Act on the findings, rebuild alongside, and verify:
stt-build -i ais.parquet -o ais-tiles-v2 --time-field timestamp \
  --time-format unix-ms --auto encode --quantize-coords 5 --style-hints \
  --quantize-attr sog=0.1 --exclude source
stt-optimize diff --before ais-tiles/ --after ais-tiles-v2/
#    → compressed blob bytes: -24.3%; per-column table confirms `sog` shrank

# 5. Keep the gates in CI:
stt-optimize doctor --archive ais-tiles-v2/ --strict
stt-optimize diff --before ais-tiles/ --after ais-tiles-v2/ --fail-on-growth 5
```

The numbers above are illustrative — that's the point. Run the loop on
*your* dataset; the flags that pay are the ones your measurements name.

## Where to go next

- Every flag, with defaults: [CLI reference](../api/cli-reference.md).
- First build from scratch: [From CSV to an Animated Map](./csv-quickstart.md).
- Ship it with proper cache headers: [Deploying a Dataset](./deploying.md).
