# Roadmap — decision records

A decision record here holds **rationale, measured baselines, negative results,
and counted-out items with revival triggers**. It is deliberately _not_ a
description of current behavior — the spec (`docs/spec/`) and the API reference
(`docs/api/`) own that, and a record that restates them goes stale the moment
the code moves. Nor is it a campaign diary: how the work was sequenced is in git
history, not here.

**These are not part of the published docs site.** The showcase `/docs` viewer
bundles only `docs/{intro,architecture,spec,api,guides}`.

> **Current-state rule (2026-08-24).** This directory preserves dated evidence
> and decision history; it is not the source of truth for versions, supported
> features, or release commands. Use the workspace manifests for versions and
> toolchain floors, `CONTRIBUTING.md` for the release procedure, and `docs/spec/`
> plus `docs/api/` for shipped behavior. An older claim below remains historical
> unless its item has an explicit later status line.

Three house rules:

- **Every measurement keeps its units and its source.** If a number cannot be
  traced to the run that produced it, the claim is dropped rather than restated.
- **Open work lives in exactly one place — the backlog below.** Unbuilt or
  declined work is _not_ listed there; it lives as a counted-out bullet with a
  revival trigger inside the record that owns it. A record that is not indexed
  below is not findable, so a new record earns its index line in the same pass
  that creates it.
- **A closed item leaves one line, not its history.** When a backlog item is
  done it collapses to a single line in the discharged ledger, and any durable
  lesson it produced moves into the record that owns the subject. The story of
  how it closed is in git history.

## Records

- [**launch-readiness-2026-08.md**](./launch-readiness-2026-08.md) — the short,
  active launch contract and gate list; use this instead of mining historical
  records for current launch status.
- [**shipping.md**](./shipping.md) — versioning and registries, the naming
  rationale, the feature/install matrix, publish auth, the two release systems,
  the R2 fleet-publish ordering rule, and the explicit non-goals.
- [**stt-packed-format-decisions.md**](./stt-packed-format-decisions.md) —
  format, build and optimizer decisions: the measured baselines, the paged
  directory, the frozen wire-token invariants, the two byte-break events
  (packed-v2 and the 2026-07-26 payload break), and the negative results
  (lightweight encodings, coordinate transforms, inter-timestep delta chains).
- [**db-input-adaptors.md**](./db-input-adaptors.md) — PostGIS/DuckDB as
  `stt-build` inputs and `stt-serve` backends: the seven encoder-seam lessons,
  the ingest/serve benchmarks, and the static-vs-DB verdict.
- [**renderer-architecture.md**](./renderer-architecture.md) — the no-shared-
  chassis kernel thesis, backend tiering and the routing rule, the delivered
  capability matrix (CI-generated, not hand-counted), and the wire/naming
  invariants.
- [**playback-and-loading.md**](./playback-and-loading.md) — clock↔buffer
  coupling and where a data player deliberately differs from a video player,
  multi-source scheduling and eviction, prefetch, and the scrub-time motion tier.
- [**tile-loading-3d-2026-07.md**](./tile-loading-3d-2026-07.md) — the **binding
  bounds contract** (§4, normative: 35 source and test files cite it) for
  selecting tiles under pitch, bearing and altitude; the measured 20–44% miss it
  replaced; the verified-correct list that closes off re-investigation.
- [**demos-and-datasets.md**](./demos-and-datasets.md) — the dataset licence
  register, the BLOCKED list, the operational time-bombs, and the per-demo build
  gotchas.
- [**av-cockpit.md**](./av-cockpit.md) — the `/drive` AV **data contract**
  (normative: the extractors and the box layer cite its numbered sections),
  the georeferencing gotchas, the palette-lockstep rule, and the measured LiDAR
  compression story.
- [**storm-4d-greenfield-2026-07.md**](./storm-4d-greenfield-2026-07.md) — the
  storm-4d **archive/field contract** (§9.1, normative: eight generators cite
  it), the no-thinning verdict, the Py-ART-not-Rust rationale, and the
  LOD-grids-must-key-time finding.
- [**ai-suite.md**](./ai-suite.md) — the MCP-vs-Skills complementarity verdict
  that shaped the product, the security model, and the as-built tool/skill
  inventory.
- [**neural-atlas-2026-07.md**](./neural-atlas-2026-07.md) — a transformer's
  internal state as an atlas: the four 2026 interpretability findings that move
  the design, the **scale gate** that decides whether the format is load-bearing
  at all, the abstract-plane→lon/lat mapping, and the zero-new-packages /
  zero-new-layers verdict. **Built 2026-07-27** (§14) on a substituted ungated
  pin (`gpt2-small` + res-jb SAEs), four archives at 294,912 nodes, plus the
  geometry rebuild (§15) and the findings both passes produced — the SAE
  context-length cliff, why Leiden alone cannot carry the cluster tree, and why
  attribution read identically zero.
- [**optimization-problems-2026-08.md**](./optimization-problems-2026-08.md) —
  STT as a family of optimization problems: 66 formal statements across 13
  subsystems with the shipped code framed as the incumbent solution, the
  cross-cutting constraint spine (determinism, no-thinning, random access,
  bounded client memory), and the rejected-design register each incumbent
  leans on.
- [**optimization-informed-design-2026-08.md**](./optimization-informed-design-2026-08.md) —
  the treatment plan for the 66 problems: the six systemic defects they
  collapse into, eight shared mechanisms (measurement oracle, two-pass build,
  `--target-size`, workload model, client cost oracles, byte-honest budgets,
  semantic conformance, declared tiers), the consolidated do-not-touch
  register, and the phased plan with rebuild-window batching.
- [**optimization-implementation-plan-2026-08.md**](./optimization-implementation-plan-2026-08.md) —
  the execution spec beneath the treatment plan: 68 work items across the eight
  mechanisms, each with verified-in-tree code changes, enumerated tests
  (determinism and rejected-design guards included), and an acceptance row in
  the P0-8 evaluation matrix that resolves every O1–O5 criterion to an
  instrument, metric, baseline, and threshold. Owns the **how**; the backlog
  still owns the schedule.
- [**optimization-conformance-2026-08.md**](./optimization-conformance-2026-08.md) —
  what the implementation pass actually built, audited against the two records
  above: 52 of 68 items landed with zero regressions, the five problems
  deliberately left uncovered and why, the open defects in what did land (the
  39× client-memory regression the dictionary hoist traded a 12 % wire win for,
  and TB-5 shipping inert), the four-round R1 gate verdict with what it does
  **not** cover, and three defects found in the source documents themselves —
  including a floor mis-described as a disable threshold that propagated into
  code.
- [**formal-semantics-2026-08.md**](./formal-semantics-2026-08.md) — the
  fourth document of the formalization family: a six-track review of the
  geospatial/spatiotemporal logic (ten domains, their current rigor, the 84
  laws tests already enforce, the one-author-oracle map), the layered formal
  model (spaces → address algebra → time algebra → archive semantics →
  delivery → control → presentation kernels) that the 66 optimization
  problems quantify over, the ~90-entry adjudication register of divergences
  awaiting bless/fix/document verdicts, and the FM-0..FM-6 plan. Supplies the
  semantic-fingerprint definitions M7/SH needs; proposes work, does not edit
  the backlog.
- [**openusd-integration-2026-07.md**](./openusd-integration-2026-07.md) — the
  STT↔OpenUSD isomorphism (spatial tile → payload, temporal bucket → value clip,
  directory → clip manifest), the case for `.stt` as a **native USD layer**
  rather than an export target, the five tracks, the `nanousd` assessment
  (§8.6), and the cross-origin-isolation and standardisation-window gates.
  **Plan only — nothing built.**

### Measurements

- [**measurements-2026-07.md**](./measurements-2026-07.md) — cold start:
  requests and bytes to first frame across three archive shapes, with the
  harness, the hardware, and the caveats. Four to five requests whether the
  archive is 46 MB or 807 MB.

---

## The backlog

The single source of open work at the time of each dated update. The baseline was
re-verified against the tree, registries and live deployment on **2026-08-03**;
later status lines supersede it. Items carry the check that proves them and the
condition that closes them. Ordered by what blocks what, not by size.

**Where this actually stands.** The B1 → B2 → B3 chain that dominated the last
four registers is **discharged**. The payload byte break landed and is pushed;
the fleet was republished at 68/68 `formatVersion: 2`; and **0.6.0 shipped on
2026-08-13** — crates.io and npm both show it, `v0.6.0` is tagged and pushed,
and the emitter decision the cut was holding open was resolved by removal.

The proposed **fleet rebuild at `formatVersion: 3`** became B4. B4 was then
discharged on 2026-08-14 by a container-only v2→v3 migration; its investigation
is retained below because it explains why rebuilding was rejected.

The last whole-repo green baseline recorded here (2026-07-31) was: **45 Rust
test targets at `--all-features`
(1,264 tests), the six feature lanes, the curated clippy set, `cargo fmt
--check`, the MSRV check, 35 Python tests, oxlint, `oxfmt --check`, the
version-sync gate, the roadmap-citation gate, the golden-pin gate and its own
41 tests, `smoke-pack`, and 6,240 package + showcase tests.** The 2026-07-31
lesson behind that phrasing — that `cargo test --workspace` alone was hiding
four red jobs — is recorded in T2 and in
[db-input-adaptors.md §5](./db-input-adaptors.md).

The remaining queue is dominated by **manual verification and data**, not
library code: browser sign-off has been accumulating since 2026-07-22 (L2), the
repository the whole published surface points at is still private (T1), and the
five summary-tier archives listed in B4 remain v2 by design.

### B — Blocking (retained discharge record)

**B4 (discharged 2026-08-14). Historical premise: the published fleet was still
`formatVersion: 2`, and rebuilding it was a program, not a batch job.** 0.6.0's
writer emits v3 only; its reader opens v2
and v3, so the live fleet keeps working untouched and this is an upgrade rather
than an outage. 54 of the 60 referenced archives are v2 (~18 GB, ~380 M
features); `storm-cells`, `storm-field` and `storm-tracks` are already v3.

**A rebuild is not automatically a replacement, and the checks that existed did
not say so.** The first run produced a `wildfires` archive holding 175 features
against the live 4,600 — and it passed both gates, because the manifest really
did say `formatVersion: 3` and `stt-validate` really did exit 0 on a flawless
encoding of almost no data. NIFC now returns 15 source perimeters for 2020–2023
where it once returned hundreds; `tools/stt-generate/src/datasets/wildfires.rs`
has carried a warning about exactly this since 2026-07-29. `scripts/rebuild-fleet-v3.sh`
therefore compares `feature_count` against the archive currently serving and
fails a dataset on a material shortfall, and reports anything above 1.5× for
review rather than passing it silently.

**The API tier, measured (2026-08-14).** Eight datasets, and only three were the
boring case:

| dataset          | wall   | features vs live         | verdict                              |
| ---------------- | ------ | ------------------------ | ------------------------------------ |
| `earthquakes-v2` | 231 s  | 522,978 / 522,982 1.000× | accepted                             |
| `hurricanes`     | 370 s  | 200,074 / 193,020 1.037× | accepted (fresh IBTrACS storms)      |
| `animals`        | 1227 s | 11.19 M / 10.58 M 1.058× | accepted                             |
| `drifters`       | 3006 s | 9.64 M / 9.05 M 1.066×   | accepted                             |
| `ais-all-us`     | 1916 s | 124.8 M / 19.3 M 6.453×  | **REVIEW** — recipe drift, see below |
| `satellites`     | 66 s   | 8.28 M / 24.2 M 0.342×   | **refused** — bucket drift, not loss |
| `wildfires`      | 2 s    | 175 / 4,600 0.038×       | **refused** — genuine upstream loss  |
| `flights`        | 27 min | 257.9 M / 43.5 M 5.925×  | **REVIEW** — needed `--streaming`    |

Three distinct failure modes, none of which is "the format migration went
wrong":

- **`wildfires` — the data is gone upstream.** Unfixable here; it stays v2.
- **`satellites` — the shipped archive used a 5-minute temporal bucket and
  today's builder auto-picks 1 hour**, so the same 16,087 satellites (MORE than
  the live archive's ~12,700) land in 2,125 tiles instead of 24,480. The
  generator does not expose `--temporal-bucket`, so reproducing it needs
  `--skip-build` plus a direct `stt-build`, AND a pinned `--start-time` with a
  matching `datasets.ts` `timeRange` — propagation runs from _now_, and a
  mismatched range renders the demo empty.
- **`ais-all-us` — the opposite drift.** Today's default `--sample-minutes 0`
  preserves every usable row, which is this document's own no-thinning ground
  rule; the shipped archive was built thinned. 6.45× the features and 2.2 GB
  against 0.51 GB. The rebuild is arguably the more correct artifact and the
  size is the reason it is a decision rather than a detail.

**Both of the two biggest archives come back 5–6× larger, and that is the
finding that decides this item's scope.** `ais-all-us` 6.45× / 2.2 GB vs
0.51 GB; `flights` 5.93× / 4.2 GB vs 0.81 GB. Neither is a defect — today's
defaults preserve every usable row at every zoom, which is this document's own
no-thinning ground rule, while the shipped archives were built when thinning was
applied at the source. The rebuilds are the more honest artifacts. They are also
**~5× the bytes** against a fleet that is ~18 GB today, so a wholesale rebuild at
current defaults plausibly lands near 60–90 GB of R2 storage, with a
correspondingly heavier client load on those demos. Decide the density per
dataset BEFORE uploading; the gate prints the ratio precisely so that choice is
explicit rather than discovered on the bill.

**Peak RAM, not disk, is what kills a large build.** `flights` (23.4 M features)
was SIGKILLed at zoom 8 twice — first with 19 GB free, then again with 28 GB
free, which is what disproved the disk theory the first failure suggested.
`--streaming` (write each zoom as it completes, at some parallelism cost) cleared
zooms 8/9/10 on the first attempt and finished in 27 minutes. Carry the trade the
conformance record notes: `--streaming` builds emit no content fingerprint.
`stt-build` separately spills pack payloads past `--pack-memory-budget` to a temp
file in the OUTPUT dir, so a large build still needs far more transient disk than
its finished archive implies; the driver refuses below 25 GB rather than dying
mid-build.

Three tiers, and they are not equally tractable:

- **API-sourced** (`stt-generate`, no staged input) — reproducible from a clean
  checkout. Rebuild times scale with tiles, not bytes: 231 s for 523 K
  earthquake points, 370 s for the hurricane tracks.
- **Staged-source** — the weather / storm / AV families come from the Python
  generators in `scripts/data-generation` over ~26 GB of staged inputs, not from
  `stt-generate`. A separate pass with its own toolchain.
- **No rebuild path at all** — `lines-v2` (synthetic, no recipe anywhere),
  `nyc-taxi-od-summary` (no generator), `osm-nyc-nodes` (needs a login-gated
  Geofabrik full-history extract), and now `wildfires` (upstream coverage
  collapsed). These stay v2. That is not a gap in the plan; it is the case the
  reader's v2 read window was kept for, and the argument for keeping it is
  written into [the packed spec §9.1](../spec/stt-packed-format.md).

**Ordering, which is load-bearing.** Packs are content-addressed, so uploading
them is invisible to the live site; only `manifest.json` is the switch. Upload
immutable objects → deploy the reader → flip manifests. The reverse order hands
a v3 manifest to a deployed reader that knows only v2. A rebuilt polygon archive
additionally declares `triangles-partial`, which a client without the decoder
backfill refuses at open — loud by design, and another reason the client ships
first.

**DISCHARGED 2026-08-14, by not rebuilding.** The rebuild framing above was
wrong, and the table that proves it is the reason: v2 → v3 is **container-only**,
so an archive can be promoted without re-deriving anything. `stt-core`'s
`migrate_dataset_v2_to_v3` re-encodes the directory under codec v6 and rewrites
the manifest, and **touches no pack** — legal because a reader accepts object
magic `2..=3` on every `.sttp` independently of `formatVersion` (packed spec
§9.4, written in the same pass).

Result: **59 of 64 local datasets migrated, 76 MB of new directory objects, zero
packs rewritten**, versus days of compute and a ~5× larger fleet. It also reached
two archives a rebuild never could — `lines-v2` (synthetic, no recipe) and
`osm-nyc-nodes` (login-gated source). Verification was decode-based, not
parse-based: every dataset reopened and decoded entry-by-entry against its
pre-migration content, the run aborting on the first difference.

Live as of 2026-08-14: client deployed first (it reads v2 AND v3, so there was
no exposure window), then 59/59 datasets synced and probed — all serving
`formatVersion: 3` + directory v6 + a variants registry, with pack objects still
answering `STTP\x02`, which is the migration's whole thesis visible on the wire.
The 12-demo render probe passes against live R2.

**What remains open, and it is small:**

- **The five summary-tier archives stay v2** (`earthquakes-summary`,
  `goes-glm-lightning`, `nyc-od-quadbin`, `nyc-taxi-od-summary`,
  `osm-nyc-changesets`). Migration refuses them on purpose — a v2 directory has
  no column saying which entries are aggregates, so the raw/summary split v3
  needs cannot be recovered. They serve correctly through the reader's v2
  window; reaching v3 requires a rebuild.
- **Two staged rebuilds await a density decision**, not a technical one:
  `ais-all-us` 6.45× and `flights` 5.93× against what ships, because today's
  defaults honour the no-thinning rule and the shipped archives were built
  thinned. Both are built, validated and NOT published.
- **`wildfires` and `satellites` rebuilds are refused/parked** per the table
  above; both remain live and correct at their migrated v3 container.

### L — Live defects on poopdeck.gl today

**L1. One atlas sidecar is missing from R2, and `r2-sync.sh` structurally cannot
upload it.** The Neural-State Atlas is still gated
(`ATLAS_ARCHIVES_SYNCED = false`) and the reason is now precise. Probing
2026-08-03: all three `neural-atlas-*` archives, all three `<stem>.meta.json`
files and both `neural-atlas-node-{index,series}.bin` blobs return **200** — the
2026-07-31 negative-cache window has expired and the `[sidecar]` pass works. But
**`/data/neural-atlas.json` returns 404**, and that is the file
`NeuralAtlasImpl.tsx:79` fetches _first_ (`SIDECAR_URL` — the generator sidecar
carrying the pin, the framing contract and the two `.bin` URLs). The `[sidecar]`
pass filters on `+ *.meta.json` and `+ *.bin`; a bare root-level `.json` that is
not `manifest.json` matches no pass in the script and is rejected by every
trailing `- **`. This is the same hole that swallowed the `.bin` files, one
extension wider. **Accept:** the `[sidecar]` filter covers the generator sidecar,
`/data/neural-atlas.json` returns 200 on a plain **GET** (not `HEAD` — it bypasses
the edge cache and will lie to you), and `ATLAS_ARCHIVES_SYNCED` flips to `true`.

**L2. The browser-verify queue spans three campaigns.** Browser verification is a
**mandatory manual gate** in this project ([renderer-architecture
§2.9](./renderer-architecture.md) — tiers 1–4 cannot prove compiled-shader
pixels), and it is now the largest single block of open work. Test-green,
aesthetically unverified, in rough priority order:

- **The four volumetric demos at their shipped cameras** — the acceptance half of
  the 3D tile-selection fix (`storm-4d-isolines`, `earthquake-columns` and the
  storm/BIXI families were missing 20–44% of on-screen tiles; the code landed and
  the pitch×bearing matrix test is green, so what remains is looking at it).
- The MapLibre **globe** path on the current v6 host (the showcase now runs
  6.6.x, within the backend's declared `^3 || ^4 || ^5 || ^6` peer range).
- **Polygon seam-wall masking** and the new **per-ring outline** path (holed
  polygons should stop drawing the bridge segment).
- Shipped **pixel-behavior changes**: `AnimatedBoundingBoxLayer` boxes now
  actually rotate to heading and scale to dimensions (they were silently
  identity); the flights comet-wake → glide-dots change.
- First live drive-through of `AnimatedMeshLayer` / `AnimatedHexagonLayer` /
  `AnimatedTextLayer`; the re-linked `/drive` and `/worlds` routes; the three geo
  viewer.
- `storm-4d-isolines` aesthetics (sheet density, whether the cloud-top canopy
  fights the thin lines, fade timing at 288×) and the **storm-4d style + LOD
  pass** — outline-only outage counties, wireframe-only warning cages, and
  whether z8 now reads as the storm rather than a sample
  ([storm-4d-greenfield-2026-07.md §11.5](./storm-4d-greenfield-2026-07.md)).
- The multi-source composite gating drill from
  [playback-and-loading.md §8](./playback-and-loading.md).

**Accept:** each line seen and either signed off or turned into a defect.

### DX — Onboarding review (2026-08-26)

A walk of the poopdeck.gl onboarding path exactly as a newcomer takes it —
`npm install` from the public registry, the quickstart copied verbatim, rendered
in headless Chromium against `tiles.poopdeck.gl`. Thirteen findings. **Nine are
fixed in the tree**; the four below are what the fix could not reach from here.

Fixed and not repeated here: the unclickable play button and the light-only
transport bar in the quickstart's React sample (F1, F6 — the bar now ships a
dark token set and a `data-stt-theme` pin); the two TypeScript errors in
copy-pasteable samples plus a CI gate that typechecks the doc snippets so they
cannot drift again (F3, `scripts/check-doc-snippets.mjs`); the Node-24 engine
floor on six browser packages (F4); the Float32 precision warning that fired on
the canonical path (F5); the root README pointing at the CSV guide instead of
the quickstart (F7); the empty column inventory in `ArchiveMetadata`, now
derived from the manifest's own schema templates and exposed through a base
`onMetadataLoad` (F8); the production console warning on the live showcase
(F10); and the missing basemap and bundle-size notes in the quickstart (F11,
F12).

**DX1. A multi-entry Vite 8 build renders a blank page, and the bug is
upstream.** Three HTML entries, two importing `@poopdeck.gl/react` and one
importing only `@poopdeck.gl/playback`: React never mounts, the root element
stays empty, and the console carries `TypeError: __exportAll is not a function`.
Vite 7 (rollup) is clean on the same tree; single-entry Vite 8 is clean;
`React.lazy` routes are clean. `__exportAll` is a **rolldown** re-export helper,
so the defect is in Vite 8's bundler — but the shape that trips it is these
packages' `export *` barrels, and it is our users who get the blank page and the
unsearchable error. Vite 8 is what `npm create vite` gives someone starting
today, and it is what this repo itself runs. The quickstart's troubleshooting
list now names it, which turns a dead end into a known issue; that is mitigation,
not a fix. **Accept:** a minimal repro filed against rolldown, and the
troubleshooting entry replaced with a version note when it lands.

**DX2. The flagship dataset's published manifest is patched locally but not
deployed.** `data/earthquakes-v2/manifest.json` — the first file anyone
following the quickstart fetches — served `"name": "earthquakes-v2.new"` with an
empty `description` and an empty `attribution`, uncredited USGS data. The local
manifest now carries a real name, a one-line description and the ComCat
attribution (`scripts/patch-manifest-metadata.mjs`), verified to open through
`STTArchive` unchanged; every content-addressed object is untouched, so
publishing is a one-object manifest pass. **Accept:** `scripts/r2-sync.sh
earthquakes-v2` run with R2 credentials, and a plain GET of the live manifest
shows the three fields.

**DX3. The metadata gap is fleet-wide, not one dataset.** `--scan` over the 70
local packed datasets: **25 carry a build-scratch name** (`ais-all-us-new`,
`hurricanes.new`, `lines v2`, …), **66 have no description**, and **67 have no
attribution** — for datasets whose licences are the reason several of them can be
published at all. The curated copy already exists in
`examples/showcase/src/content/demoMeta.ts` (`tagline` + `dataSources` with name,
url and licence per demo), so this is a mapping job plus a manifest-only
republish, not a rebuild. **Accept:** `patch-manifest-metadata.mjs --scan` shows
no scratch names and no empty attribution across the shipped stems, and the
manifest pass is synced.

**DX4 (unconfirmed). Intermittent deck.gl assertion during playback.** Seen four
times in ONE run — the first against a cold CDN cache — and never again across
~10 subsequent runs in dev and production builds:

```text
deck: initialization of ScatterplotLayer
  ({id: 'quakes-points-1/0/1/1579046400000#0:default'})
  deck.gl: assertion failed
```

The map kept rendering and playback continued, so it degraded rather than broke.
The cold-cache timing suggests a race between a tile finishing and its sublayer
initializing, but that is a guess. Recorded so it is not lost. **Accept:** a
repro, or a second sighting that makes one findable — not worth chasing before
either.

### T — Claims the repo makes that the world does not back

**T1. The published repository URL 404s.** `https://github.com/BertCh/spatiotemporal-tiles`
returns **404** (re-verified 2026-08-24; the repo is private). It is the
`repository`/`homepage`/`bugs` on all four published crates and all eight
published npm packages, the `GITHUB_BLOB_BASE` the docs site uses for source
links, the releases page both READMEs send `cargo install` users to, and a
precondition for npm provenance (which requires a public repo). Every ordering
constraint that once made this awkward is discharged, so it is a straight switch
— and it should happen before the next public release.

**T2. GitHub Actions has never run; the CI gates are config that only ever
executed by hand.** Zero bot commits across the repo's history and no release PR.
_(Not re-verifiable here: no `gh` CLI in this environment. Last verified
2026-07-24.)_ `ci.yml` now carries `cargo fmt --check`, the curated clippy deny
set, `oxlint` and `oxfmt --check` — the older claim that the gates were
"deliberately absent" no longer describes the file. Running every job locally on
2026-07-31 found **four red**, each invisible to `cargo test --workspace`:
`rust-feature-lanes` (3 of 6), `rust-all-features`, `rust-lint` (2 files) and
`ts-lint` (11 files). All are fixed. The durable half of that finding — that two
DB input adaptors sit behind non-default features where the default suite will
never report a shared-type change — lives in
[db-input-adaptors.md §5](./db-input-adaptors.md). **Accept:** one green run on
GitHub's own runners.

### K — Known defects with a named fix

Each is small, real, and has its analysis written down where it belongs. None
blocked the completed 0.6.0 release.

**K2. `stt-validate` reports structural drift on correct archives.** The per-tile
exact-integer quantizer refuses a column on outlier-inflated inputs, which
changes the column _set_ tile to tile; `part_offsets` adds
`<absent> vs List<UInt32>` entries for the same reason. The archive is right and
the report is a false positive. The proper fix is the dataset-global
attribute-range pin, which shares the two-pass-build prerequisite with the
dictionary hoist. ([format §10.3–§10.4](./stt-packed-format-decisions.md))

⚠️ **Not every drift report is this false positive.** Validating all 64 local
archives at `--sample 300` (2026-07-29) found **real** drift in six —
`wildfires` (163), `ais-all-us` (82), `animals` (66), `flights` (13),
`drifters` (3), `osm-nyc-changesets` (2) — all predating the property-kind fixes
(`2c020da`, `c13970a`), and all cleared by a rebuild with the current builder.
So: treat a drift **error** as real until a rebuild says otherwise; K2 covers the
benign `adaptive encoding width varies by tile` **warning**, not the error. Five
of the six are rebuilt and installed (old copies kept as
`.<name>.bak-drift`); `wildfires` is not — see K9.

**K3. The capability matrix cannot distinguish native from fallback.** The
generated matrix lets three auditors read three different coverage numbers for
the same descriptor; `gen-capabilities-doc.mjs` should render native /
declared-with-fallback / bare-referral as distinct columns. _(The other half of
this entry is closed: Cesium no longer declares `mesh → boundingBox`,
`text → icon` or `hexbin → h3Summary`, the three fallbacks it could not render,
and gate (c) keeps the copy from coming back.)_
([renderer §4.1](./renderer-architecture.md))

**K4. Capability resolution is not host-aware.** maplibre declares
`capabilities.globe: true`, which is true only on a v5+ host. The showcase pin has
moved to 6.6.x, so the deployment half is fixed — but a boolean still cannot
express "true on v5+", and `hostApiRange` remains absent from the tree (grep,
2026-08-03). Either descriptors gain a host-range qualifier or `globe` is declared
`false` with the v5 capability documented separately. The over-claim gate
structurally cannot see this class: it checks claims against evidence inside the
package, and the package tests run against a mock.
([renderer §4.2](./renderer-architecture.md))

**K5. Two reader-side seams the byte break left open.** `toGeoArrowTable()` leaks
the wire shape (a GeoArrow consumer sees a `UInt32` `start_time` and a `UInt16`
`vertex_value`, because the re-inflation lives in `tableToBinaryFeatures` where
the CPU win is); and `partIndices` is published by the TS reader but consumed by
no renderer — `layers`, `three` and `maplibre` still treat every polygon feature
as single-part. Closing the first means materializing the very columns the change
removed, so it needs a decision, not a patch.
([format §10.4](./stt-packed-format-decisions.md))

**K6. The AV render-mode set is declared in four-plus drifting places** — the
`renderModes` existence-probe memo in `AvCockpitImpl.tsx`, the `datasets.ts` regex
gates (`HELD_BACK_AV_MODES`, `WAYMO_LOCAL_ONLY`), the route/mode-param handling,
and the deck↔three parity copy. One registry row per mode kills it.
([format §9](./stt-packed-format-decisions.md))

**K8. AI-suite tail.** No evals exist for any skill (the intended bar was ≥3 per
skill, without-skill baseline vs with-skill); remote hosting still wants an OAuth
2.1 Resource Server in front of the HTTP transport; the MCP revision target is
`2025-11-25` against a `2026-07-28` revision that adds Tasks for async builds;
and the 13-tool surface has never had its token budget measured.
([ai-suite.md](./ai-suite.md))

**K9. `wildfires` cannot be regenerated: the upstream data is gone.** The shipped
archive holds ~460 fires. The NIFC service on 2026-07-29 returns 98,168 records
overall but only 297 for 2020–2023, of which **10** clear `--min-acres 1000` as
wildfires. Two real query bugs were fixed in the same pass (`FIRE_YEAR` is an
`esriFieldTypeString`, so the year range was a string comparison — the typed field
is `FIRE_YEAR_INT`; and `FEATURE_CA = 'Wildfire'` matched one of five values,
dropping `Wildfire Final Fire Perimeter` and `Wildfire for Resource Benefit`),
which took the match count 1 → 10 and confirms the filter was also wrong — but the
data is not there to recover. The archive keeps its 163-error K2 drift because
regenerating would destroy it. **Re-source before touching it.**
_(The sibling half is closed: `stt-generate` no longer silently drives whatever
`stt-build` is on `PATH`.)_

**K10. The cold-start numbers predate the fleet they describe.**
[measurements-2026-07.md](./measurements-2026-07.md) was captured 2026-07-24/26 —
before the payload byte break re-addressed every pack, before the republish, and
with five of the wanted datasets 404 at the time. The method, harness and cameras
are unaffected; only the numbers are stale. This was B2's tail, deliberately kept
open because measuring before the flip would only have measured the old layout.
**Accept:** the capture is re-run against the republished fleet and the §1
headline is restated or confirmed unchanged.

**K11. `metadata.bounds` is a bbox of CENTROIDS and does not bound the data — and
the republish it was meant to ride has now passed.** `stt-build` fills manifest
bounds from `input::calculate_bounds`, which takes min/max of each
`ParsedFeature.lon`/`.lat` — the geometry's **centroid** (verified still true
2026-08-03). The tiler addresses tiles by **vertex**, so on any line / polygon /
multi-point archive the occupied tiles provably extend past the declared extent.
(`calculate_bounds` separately skips the `(0,0)` sentinel, so even a pure-point
archive can hold data outside its bounds.) Blast radius: the showcase frames its
opening camera from these bounds, and `stt-validate` and the MCP
`describe_dataset` both report them as the dataset's bbox — all three understate
the true extent. The sibling item is the same shape: `zRange` exists as a layer
prop but there is **no `z_range` on `Metadata`/`ArchiveMetadata`** and no
`--elevation-column` to populate it, so no consumer can discover that a dataset is
volumetric and altitude-aware selection stays hand-configured per demo. Both were
recorded as "fold into B2 rather than schedule a republish" — B2 shipped without
them, so they now need their own rebuild window. **Accept:** the builder computes
the real geometry bbox, `z_range` lands as an additive
`skip_serializing_if = "Option::is_none"` field (existing manifests round-trip
byte-identically), and both ride the next rebuild rather than a dedicated one.
([tile-loading-3d-2026-07.md §6, §6b](./tile-loading-3d-2026-07.md))

### TL — Tile loading (full audit, 2026-08-24)

**TL1. Four shipped demos are in a permanent fetch → evict → refetch loop, and
five reproduced mechanisms turn a healthy loader into a stall.** The 2026-08-24
whole-pipeline audit ([tile-loading-audit-2026-08.md](./tile-loading-audit-2026-08.md);
raw evidence in [tile-loading-audit-2026-08-evidence.md](./tile-loading-audit-2026-08-evidence.md))
probed 21 demos live and re-verified every critical/high finding. The loops:
the overview pin is byte-budgeted but counts against the 2,000-**tile** cap
(`earthquakes-v2` pins 8,927, `hurricanes` 17,899, `rainfall-2019` 4,380 vs a
1,000 split) so every selection pass evicts the entire non-pinned cache (A1);
at fast playback the runway floor `speed × 5 s` exceeds the cache and the
ladder may not cut below it (`nyc-taxi-paths` 719 MB in 10 s, A2); eviction is
unreachable while the select key is unchanged (A3). The stalls: phantom
coverage-index keys after a sub-⅛-viewport drift (B1), a committed seek that
never reaches the tileset (B2), EDF ranking the playhead's own bucket as
"passed" (B3), DRR arrears letting optional prefetch jump required need-now
(B4), loop wrap = cold seek (B5). Also: the 20 s transfer timeout is a total
deadline, so a 16 MB `gtfs-ch` z6 tile is unloadable below ~6 Mbit/s (C1);
every fleet zstd frame declares an 8 MiB window with no content size, costing
69–92 % of decode time — reader-side fix, no rebuild (D1); the M2 dictionary
hoist is inert in browsers (A5); memory is 2 GiB per tileset with no device
awareness (A4). Small and medium archives measured clean. **Plan:** five
waves in the doc's §6, ~11 days, no format change. **Accept:** the §1 table
re-run reads `runwayEvictions = 0`, `pressure = 1.0` on all five rows; the
proof scripts named in §8 exist as green vitest cases; a real-object loading
QoE gate (G1) runs in CI.

**Status 2026-08-24 (same day): implemented and measured — see the doc's §9.**
Every wave landed test-first (core 1,358 → 1,455+, playback 308 → 322,
layers 1,592 → 1,673, three/maplibre/cesium/react +27, showcase 645 → 811),
all dists rebuilt, `nwm-rivers-2019` rebuilt time-major. The acceptance re-run
on a quiet machine reads runway evictions **0** and pressure **1.0** on all
five rows (from 8,023 / 7,940 / 4,249 / 25,557 and 0.25), stalls **0** (from
286 / 126 / 176 / 1,123), refetches 0 everywhere, `nyc-taxi-paths` 719 → 22 MB
per 10 s, worker decompress p50 2.3 → 0.1 ms on `earthquakes`. The QoE gate is
in the core suite and pinned three residuals the same day (byte-priced runway
capacity, zero-runway gate release, unbuilt-index cost) — being closed as this
entry is written; the remaining open items are listed in §9.3.5 (A5 and D3 ride
the peer session's BH-7 decoder change; the overview storyboard on the three
long-sparse archives is now rejected `over-count` by design). Not yet:
browser sign-off of the fixed demos (L2), and a re-measure on a low-memory
device for A4.

### Discharged

One line each, so the ledger is auditable — not to imply they are still open.

**Since the 2026-07-26 register.**

- **B3 — 0.6.0 shipped (2026-08-13).** crates.io `stt-core` / `stt-optimize` /
  `stt-build` / `spatiotemporal-tiles` and the seven published `@poopdeck.gl`
  packages all read **0.6.0**, `v0.6.0` is tagged and pushed, and the registries
  are level again (crates.io skips 0.5.0, which was cut on npm but never
  published there). The HTTP/2 publish stall [shipping.md](./shipping.md) budgets
  for did **not** recur; `CARGO_HTTP_TIMEOUT=900` and publishing in dependency
  order was enough. The cut's reserved public-API decision was resolved by
  **removal**: `emitGLSL300` and Cesium's `timeFilterAlphaGlsl` are gone,
  `ALPHA_EXPR`/`evalExpr` stay, and `render-spec.json` now declares an empty
  emitter list with a contract test pinning both names absent. Two gate holes
  surfaced in the process and were closed rather than worked around —
  `sync-versions.mjs` never covered the internal cargo path-dep `version` pins
  (cargo refuses to update a lockfile when they lag, which is how it was found),
  and `smoke-pack` left `@deck.gl/widgets` unpinned, so an upstream 9.3.10
  release could redden the publish gate with nothing in the repo changing.
  ([renderer-architecture §5.1](./renderer-architecture.md))
- **B1 — the 2026-07-26 payload byte break landed** as `a7b57dc`, one commit as
  the accept condition required, and is **pushed**: HEAD is level with
  `origin/main`. ([format §10](./stt-packed-format-decisions.md))
- **B2 — the fleet is republished and verified.** 29.3 GiB of content-addressed
  packs and index objects (1,324) went up, then the manifests flipped; re-probing
  all 68 registered manifest URLs returns **68/68 at `formatVersion: 2`**, from
  35 v2 / 24 v1 / 9 × 404 that morning. Seventeen were additionally decoded
  end-to-end. The ordering rule this produced — packs first, then the frontend,
  then manifests, which put the whole exposure inside a **15-second** window — is
  now a standing procedure in [shipping.md](./shipping.md).
- **The AV rebuild is done.** A `reoptimize` sweep had flattened and scrambled 106
  argoverse/waymo archives by reading a 3-wide `xyz` leaf at a 2-wide stride; the
  example is deleted, six generator call sites no longer fold, the bundles are
  rebuilt, and the cheap positive-proof check (`--sample 0`; one z14 tile per
  temporal bucket) is recorded in [av-cockpit.md §3](./av-cockpit.md). The live
  CDN fleet was never affected.
- **L0 — 3D tile selection is fixed.** The chassis derived its lon/lat box from
  two opposite screen corners and had no horizon guard, so the shipped cameras
  missed 20–44% of on-screen tiles and inverted past bearing ≈32°. Waves 1+2
  landed on the shared `core/geo/viewport-bounds.ts` primitive and the
  pitch×bearing matrix test is green; the browser half is now a line in L2.
  ([tile-loading-3d-2026-07.md](./tile-loading-3d-2026-07.md))
- **L1 (fronts) — `wpc-fronts` and `wpc-fronts-pips` are synced.** Both return 200
  and decode, so `severe-weather-2024`'s overlay no longer 404-stalls.
  `LOCAL_ONLY_DATASETS` is now **empty**: `storm-4d-isolines`, `rain-flood-2019`,
  `gtfs-ch` and `storm-3d-conus` are all un-gated and verified. The gate mechanism
  stays for the next pre-sync dataset.
- **L1b — the storm-4d radar LOD pyramid has a time axis and is live.** The
  thinning grid was space-only over the whole 9.5-hour window, so z8 showed a
  median 13% of the visible bucket (0% at worst); the cell is now keyed on
  `--temporal-bucket` and z8 shows a median 65%.
  ([storm-4d §11.4](./storm-4d-greenfield-2026-07.md))
- **K1 — `stt-serve` has a capability channel.** `/metadata.json` carries a
  `capabilities` array derived from the same `EncoderSettings::required_capabilities()`
  the offline build declares with. It is **always present**, empty when the server
  encodes the capability-free shape, so its absence unambiguously means "server
  predates this key" rather than "declares nothing".
- **K7 — roadmap citations resolve by anchor, not just filename.** The gate parses
  numbered headings per document: **273 citations, 107 anchored, all resolve**
  (from 94 filename-only). A follow-on false positive is fixed too — the citation
  regex captured a lettered anchor (`§8.5a`) but the heading parser did not, so a
  real subsection read as missing. ⚠️ **A gate over `git grep` cannot see
  untracked work**, which is why the first commit of a new doc is exactly when to
  re-run it.

**Earlier waves.** Cloudflare _is_ caching the packs (`MISS` then `HIT`,
`max-age=31536000, immutable` — the earlier "not caching" claim was wrong and the
cold-start figures are edge figures) · the shipped plugin config launches
`npx -y @poopdeck.gl/mcp` with no `--allow-cli` · three release systems became
two · the showcase runs maplibre-gl v5 · the polygon outline draws per-ring ·
JSON Schemas resolve at their own `$id` · `packages/core`'s `clean` no longer
leaves a stale build stamp · the Mercator limit is one constant across both tiers
· v2 has a byte golden · `stt-validate` and `stt-serve` have real tests · cold
start is measured.

---

## Consolidation ledger

Three consolidations have run: 2026-07-24 (26 records → 10), 2026-07-26 (re-verified
every open claim and rewrote the register as the backlog above), and 2026-08-03
(collapsed the discharged chain to one line each and rehomed its durable lessons).
**Git history preserves every retired file verbatim** — nothing was lost, only
de-duplicated, re-verified, and stripped of wave logs, agent-process narration,
and dated external SoTA surveys.

| Retired                                                                                                            | Durable content now in                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space-time-lod-2026-07.md`, `preprocessing-framework.md`, `stt-optimize-intelligence-2026-07.md`                  | [stt-packed-format-decisions.md](./stt-packed-format-decisions.md) — measured baselines, the advisor "measure, don't model" evidence, and both programs as counted-out entries with triggers |
| `naming-types-consistency-2026-06.md`                                                                              | format decisions (frozen wire tokens) + [renderer-architecture.md](./renderer-architecture.md) (codegen CI-diff gate)                                                                        |
| `sedona-integration-2026-07.md`                                                                                    | [db-input-adaptors.md](./db-input-adaptors.md) §8 — counted out, with the arrow-57-vs-59 containment note and a capability-shaped revival trigger                                            |
| `kind-parity-campaign-2026-07.md`, `maplibre-parity-campaign-2026-07.md`, `three-backend-sota-campaign-2026-07.md` | [renderer-architecture.md](./renderer-architecture.md) — backend tiering, the ratified adopt-or-cut verdicts, and the reusable gotchas                                                       |
| `full-ecosystem-audit-2026-07.md`                                                                                  | retired: §1 criticals closed; the backend parity matrix is now CI-generated (renderer-architecture §4); the untriaged backlog was not carried forward                                        |
| `scrub-lod-2026-07.md`                                                                                             | [playback-and-loading.md](./playback-and-loading.md) §7 — the correctness contract, the G5 negative result, and the QoE criteria                                                             |
| `cosmos-drive-dreams.md`, `rain-flood-demo-2026-07.md`, `dataset-candidates-2026-07.md`                            | [demos-and-datasets.md](./demos-and-datasets.md) — licence register, BLOCKED list, time-bombs, per-demo gotchas                                                                              |
| `ai-suite-skills-mcp-2026-07.md`                                                                                   | [ai-suite.md](./ai-suite.md)                                                                                                                                                                 |
| `shipping-2026-07.md`                                                                                              | [shipping.md](./shipping.md)                                                                                                                                                                 |
| `evaluations/` (4 files)                                                                                           | deleted — reference-only third-party model reviews from December 2025, written against a tree that predates the `packages/layers` rename, packed v2, and the render-kernel abstraction       |

### The contract rule

Three per-demo/per-campaign docs survived consolidation because they are **not
campaign logs — they are live contracts that source code cites as normative**,
with section anchors:

- **`av-cockpit.md`** — 44 section-anchored citations across
  `scripts/data-generation/*.py`, `packages/layers/src/layers/core/animated-bounding-box-layer.ts`,
  and `examples/showcase/src/components/av/*`. `scripts/data-generation/av_common.py:8`
  instructs extractor authors **not to deviate from** its §2 data contract.
- **`storm-4d-greenfield-2026-07.md`** — its §9.1 per-archive layer/field schema
  is called "the binding contract" by eight generators (`nexrad_volume.py`,
  `goes_cloudtop.py`, `storm4d_outages.py`, `storm4d_sounding.py`,
  `storm4d_wind3d.py`, …) and by `examples/showcase/src/datasets.ts:3122`.
- **`tile-loading-3d-2026-07.md`** — its §4 bounds contract and the F/A change
  identifiers in §5 are cited by **35** source and test files across `core`,
  `layers`, `three`, `maplibre`, `cesium` and the showcase.

**The rule going forward:** before retiring a record, `git grep` its filename. If
source code cites it as binding, it is a contract — move the contract to a spec
page or keep the record; do not delete it. The same rule applies to **section
numbers**: renumbering a cited heading breaks the anchor gate, so compact within
a section rather than resequencing it. Both filename and anchor halves of the
check are now automated (`.github/scripts/check-roadmap-citations.mjs`).
