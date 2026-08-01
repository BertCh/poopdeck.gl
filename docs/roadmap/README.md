# Roadmap — decision records

A decision record here holds **rationale, measured baselines, negative results,
and counted-out items with revival triggers**. It is deliberately _not_ a
description of current behavior — the spec (`docs/spec/`) and the API reference
(`docs/api/`) own that, and a record that restates them goes stale the moment
the code moves. Nor is it a campaign diary: how the work was sequenced is in git
history, not here.

**These are not part of the published docs site.** The showcase `/docs` viewer
bundles only `docs/{intro,architecture,spec,api,guides}`.

Two house rules:

- **Every measurement keeps its units and its source.** If a number cannot be
  traced to the run that produced it, the claim is dropped rather than restated.
- **Open work lives in exactly one place — the backlog below.** Unbuilt or
  declined work is _not_ listed there; it lives as a counted-out bullet with a
  revival trigger inside the record that owns it. A record that is not indexed
  below is not findable, so a new record earns its index line in the same pass
  that creates it.

## Records

- [**shipping.md**](./shipping.md) — versioning and registries, the naming
  rationale, the feature/install matrix, publish auth, the two release systems,
  and the explicit non-goals.
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
- [**demos-and-datasets.md**](./demos-and-datasets.md) — the dataset licence
  register, the BLOCKED list, the operational time-bombs, and the per-demo build
  gotchas.
- [**av-cockpit.md**](./av-cockpit.md) — the `/drive` AV **data contract**
  (normative: the extractors and the box layer cite its numbered sections),
  the georeferencing gotchas, the palette-lockstep rule, and the measured LiDAR
  compression story.
- [**storm-4d-greenfield-2026-07.md**](./storm-4d-greenfield-2026-07.md) — the
  storm-4d **archive/field contract** (§9.1, normative: eight generators cite
  it), the no-thinning verdict, and the Py-ART-not-Rust rationale.
- [**ai-suite.md**](./ai-suite.md) — the MCP-vs-Skills complementarity verdict
  that shaped the product, the security model, and the as-built tool/skill
  inventory.
- [**openusd-integration-2026-07.md**](./openusd-integration-2026-07.md) — the
  STT↔OpenUSD isomorphism (spatial tile → payload, temporal bucket → value clip,
  directory → clip manifest), why tiling makes USD's float32-only geometry a
  non-issue, the case for `.stt` as a **native USD layer** rather than an export
  target, the scene-description-vs-streaming-path seam, the five tracks, the
  `nanousd` assessment (§8.6 — what it changes for ingest and the browser, and why
  it does nothing for the plugin track), and the cross-origin-isolation and
  2026-standardisation-window gates. **Plan only — nothing built.**
- [**neural-atlas-2026-07.md**](./neural-atlas-2026-07.md) — a transformer's
  internal state as an atlas: the four 2026 interpretability findings that move
  the design (seed-unstable features vs reproducible subspaces, manifold
  shattering, the transcoder/circuit-tracer convergence, the SAE downstream
  negatives), the **scale gate** that decides whether the format is load-bearing
  at all, the abstract-plane→lon/lat mapping, the zero-new-packages and
  zero-new-layers verdict, the `gemma-2-2b` pin and its three licence positions,
  and the framing contract as a typed enum rather than a disclaimer.
  **Built 2026-07-27** (§14): Milestones 1–5 on a substituted ungated pin
  (`gpt2-small` + the res-jb SAEs — the `gemma-2-2b` pin is Hub-gated and 15.7 GB
  of SAE weights), four archives at 294,912 nodes and ~3.1 M trace events, plus
  the two measured findings that came out of the build — the SAE
  **context-length cliff** and why Leiden alone cannot carry the cluster tree.
  Archives are LOCAL-ONLY pending B2.

### Measurements

- [**measurements-2026-07.md**](./measurements-2026-07.md) — cold start:
  requests and bytes to first frame across three archive shapes, with the
  harness, the hardware, and the caveats. Four to five requests whether the
  archive is 46 MB or 807 MB.

---

## The backlog

The single source of open work. Every item below was re-verified against the
tree, the registries and the live deployment on **2026-07-26** and again on
**2026-07-31**, carries the check that proves it, and states the condition that
closes it. Ordered by what blocks what, not by size.

**Where this actually stands.** The code is still not the bottleneck, but the
2026-07-26 reading of "green" was too narrow. Running _every_ CI job by hand on
2026-07-31 — not just `cargo test --workspace` — found four red, all of them
invisible to the default-feature suite this register had been quoting; see T2,
which now carries the finding and the lesson. They are fixed, and the honest
statement of green is: **34 Rust test targets at `--all-features` (680 tests),
the six feature lanes, the curated clippy set, `cargo fmt --check`, oxlint,
`oxfmt --check`, the roadmap-citation gate, 1,456 package tests and 639
showcase tests.**

What is _not_ done is unchanged and remains the whole story: landing,
publishing and verifying the accumulated waves. The crate registry is two
releases behind the tree, **24 of the reachable archives on the CDN are in a
format the current reader no longer opens** (plus nine that 404), and the
browser-verify queue has been accumulating since 2026-07-22. B1 → B2 → B3 is
one causal chain, and almost everything else waits behind it.

### B — Blocking: the tree is mid-flight

**B1. Land the 2026-07-26 payload byte break.** The working tree on
`chore/release-hardening-2026-07` carries **229 tracked files changed
(+23,718 / −4,003) plus 90 untracked** — the six wire changes recorded in
[stt-packed-format-decisions.md §10](./stt-packed-format-decisions.md#10-decision-record--2026-07-26-payload-byte-break),
the `packages/layers` review fixes, and the regenerated `docs/api` +
`docs/spec` pages. `pnpm -r --filter "./packages/*" test` is green
(`packages/layers` alone: 77 files / 1,310 tests). `cargo test --workspace`
fails **two targets**, both the same gap: `--compact-times` is missing from the
`stt-serve` section of [`cli-reference.md`](../api/cli-reference.md), which
trips `spatiotemporal-tiles --bin stt-serve` and the `cli_reference_doc`
integration test — the documentation gate working as designed on a flag added in
this batch. **Accept:** the flag is documented, `cargo test --workspace` is
green, and the batch is committed as one change (it is one churn event; splitting
it re-churns content addresses twice).

_Closed 2026-07-28._ **Landed as `a7b57dc`** (`feat!: the 2026-07-26 payload byte
break, 3D tile selection, and the layer-catalog review`) — one commit, as the
accept condition required. `--compact-times` is documented in the `stt-serve`
section of [`cli-reference.md`](../api/cli-reference.md), and `cargo fmt`, the
curated clippy deny set and `cargo test --workspace` are all green, as are the
16 TypeScript suites. What B1 no longer covers but B3 still needs: HEAD is **13
commits ahead of `origin/main`** (`c74f394`), so nothing here has been pushed and
the deployed site still runs the pre-break reader against the pre-break fleet.

**B2. Republish the whole fleet, then re-measure.** Not optional and not a
follow-up — a correctness gate on the reader that B1 ships. `refactor!: expunge
the transitional v1 format` (`e084ccd`) withdrew v1 read support, and probing all
64 manifest URLs registered in `examples/showcase/src/datasets.ts` on 2026-07-26
returns **35 v2, 24 v1, 5 404**. The 24 v1 archives are unopenable by the current
reader: the whole BIXI family (8), `av-synthetic` (5), `cosmos-drive-dreams` (5),
`storm-cells` / `storm-field` / `storm-tracks`, `gtfs-nl`, `nwm-rivers-2019`, and
`comma-280-1641/ego`. The B1 payload break then churns **every** content address,
including the archives already on v2, so this is a full re-upload of the fleet —
use `--no-prune` (prune grace does not cover a republish that shares nothing with
the previous manifest) and let the retention window pass. Rollback = re-upload
the previous manifest **and** pin the previous reader. Fold in the three gated
archives and L1 while the credentials are out. **Accept:** every registered
dataset returns `formatVersion: 2` with its `capabilities` block and loads in the
showcase; then re-run the cold-start capture
([measurements-2026-07.md](./measurements-2026-07.md)) — measuring before the flip
would only measure the old layout. Needs R2 credentials, so it is maintainer-only.

_Amended 2026-07-28._ **What B2 uploads for the AV fleet changed.** A local
v1→v2 migration sweep on 2026-07-27 re-encoded the whole `public/data` tree
through a `reoptimize` example whose point-geometry reader walked coordinates at
a hardcoded 2-wide stride. Archives built with `--point-elevation-column` carry a
**3-wide `xyz`** leaf, so 106 of them — the argoverse and waymo base / `-lod` /
`-scan` / `-splat` bundles — lost their elevation _and_ had roughly two of every
three points thrown to ±180/±90. Every variant that shipped elevation as a
numeric COLUMN (`-surfel`, `-world`, `-stage`, `-iso`, `-iso3d`, all nuScenes,
all Cosmos) came through the same sweep untouched, which is the measured case for
the "depth is a renderer prop over a column, never baked into geometry" rule. The
`reoptimize` example is deleted, the six generator call sites no longer fold, and
the affected bundles are being rebuilt from raw — so B2 uploads the REBUILT AV
archives, not the local tree as the sweep left it. **The live CDN fleet was never
affected** (it still serves the pre-sweep archives; only the local tree was
rewritten). Two scenes registered in `datasets.ts` turned out never to have been
built at all — `argoverse-02a00399-scan` and `waymo-sf-day-world` — hidden for as
long as `HELD_BACK_AV_MODES` filtered their modes out of the registry outright;
both are in the rebuild. Verify a re-encode with `stt-optimize export`'s bbox
against `metadata.bounds`, **not** `stt-validate`, which passes on scrambled
coordinates because it never checks coords-in-tile.

_Closed 2026-07-31._ **The fleet is republished and verified.** 29.3 GiB of
content-addressed packs and index objects (1,324 of them) went up first, then
the manifests flipped. Re-probing all 68 registered manifest URLs afterwards
returns **68/68 at `formatVersion: 2`** — from 35 v2 / 24 v1 / 9 × 404 that
morning. Seventeen archives were additionally decoded end-to-end through the
current reader: features return and every timestamp lands inside the archive's
declared range. The remote went 3,123 → 4,447 objects, 35.3 → 64.6 GiB, exactly
the dry run's prediction. `--no-prune`, so the previous generation is still
resident and rollback is re-uploading the previous manifests; a later default
sync GCs once the retention window passes.

**The ordering is the part worth keeping.** Both naive orders break the live
site, because the two halves are versioned against each other:

- Push the frontend first and the new reader meets the 24 v1 manifests →
  `unsupported formatVersion 1`.
- Flip the manifests first and the DEPLOYED pre-break reader meets manifests
  declaring `time-delta` → `requires capabilities this reader does not
implement`. Measured: **424 of 474** local manifests declare a post-break
  capability, so this order is far the worse of the two.

The resolution is that packs are content-addressed, so the immutable pass
writes them under names nothing references yet and is invisible to the live
site. Only `manifest.json` is the switch. Uploading packs first, then pushing,
then flipping manifests the moment the Pages deploy went live, put the whole
exposure inside the manifest pass: **15 seconds**, affecting only the 24 v1
archives. Do it in that order next time.

⚠️ **Do not probe a URL before uploading it.** Probing the not-yet-uploaded
atlas `.bin` sidecars cached a negative response at the edge with
`cache-control: max-age=14400` — a **4-hour** 404 on an object that is present
and correct in the bucket. `HEAD` bypasses it and returns 200, which makes the
symptom look inconsistent; `cf-cache-status: HIT` on the GET is the tell.
Neither token in `.env` carries the Cache Purge permission.

_Amended 2026-07-31._ **The AV rebuild is done and spot-verified; what B2 has
left is purely the upload.** 37 of the 82 argoverse/waymo bundles carry rebuild
timestamps of 2026-07-28/29 and the other 45 are the variants the sweep never
damaged — the split the amendment above predicts. Six were checked directly with
`stt-optimize inspect`, covering all three damaged variants (`-lod`, `-splat`,
`-scan`), an undamaged control (`-surfel`), and both scenes that had never been
built at all (`argoverse-02a00399-scan`, `waymo-sf-day-world` — both now
present). **A cheaper check than the bbox export, and a sharper one:** in every
archive the z14 entry count exactly equals its temporal-bucket count, i.e. one
z14 tile for the whole scene. Scrambled coordinates cannot produce that — points
thrown to ±180/±90 scatter z14 tiles across the planet, so a single coarse tile
is positive proof of spatial coherence and needs only the directory, not a
decode (`--sample 0`).

**B3. Cut 0.6.0 across both registries.** crates.io `spatiotemporal-tiles`
max_version is **0.4.0** (it has 0.1.0, 0.1.1, 0.3.0, 0.4.0 — never a 0.2.0 or
0.5.0); all eight `@poopdeck.gl` packages are at **0.5.0**; the workspace is
**0.5.0**; origin tags stop at **v0.4.0**. cargo-dist builds binaries on tag
push, so the prebuilt binaries and shell installer that
`crates/spatiotemporal-tiles/README.md` sends users to **do not exist for 0.5.0**
— an advertised install path that dead-ends. Two breaking changes are queued as
changesets (`drop-packed-format-v1`, `stt-layer-name-prefix`), and B1 adds the
payload break, so the next number is **0.6.0**, not 0.5.1. _(2026-07-31: there
are now **four** changesets — `payload-byte-break` was written up, and
`animated-scenegraph-layer` adds a `minor` on `@poopdeck.gl/layers` for a new
layer. The number is unchanged; a minor rides along inside a major.)_ Budget for the
operational constraint recorded in [shipping.md](./shipping.md): `cargo publish`
stalls on HTTP/2 upload from the author's network — publish from a different one.
**Accept:** `v0.6.0` tagged and pushed, crates.io and npm both showing 0.6.0, and
a releases page whose binaries exist.

### L — Live defects on poopdeck.gl today

**L0. Tile selection is broken on every 3D demo on the live site.** The deck
chassis derived its viewport lon/lat box from **two opposite screen corners** and
treated them as the axis-aligned min/max, which is only true at `bearing = 0`;
there was also no horizon guard, so `pitch > 71.57°` returned a point behind the
camera. Measured against a real `WebMercatorViewport` and the real core tile math,
the **shipped cameras miss 20–44% of on-screen tiles** — `storm-4d-isolines`
(pitch 62 / bearing 20) misses 44%, `earthquake-columns` 33%, the storm and BIXI
families 20–25%, flat 2D demos 0%. Past `bearing > atan2(h, w)` (≈32°) the box
**inverts** and `boundsToTiles` selects **zero tiles** while `getBufferedRunway`
reports `complete: true`. The visible symptom is content that paints and then
disappears, because `getVisibleTiles` pass 2 drops the coarse parent using the same
shrunken box. Full analysis, root causes RC1–RC9, and the fix waves are in
[tile-loading-3d-2026-07.md](./tile-loading-3d-2026-07.md); the audit also
**verified as correct** (do not re-investigate) the antimeridian algebra, all
eviction branches, and the temporal window/bucket math. No format change and no
republish are required for the flashing. **Accept:** Waves 1+2 landed, the
pitch×bearing matrix test green in `packages/layers`, and the four volumetric
demos browser-verified at their shipped cameras.

**L1. `wpc-fronts` and `wpc-fronts-pips` 404 while un-gated.** Both return 404 on
`tiles.poopdeck.gl` (verified 2026-07-26) and both are referenced by
`severe-weather-2024` (`datasets.ts:3058-3059`), which sits in the **un-gated**
list — so the composite's fronts overlay 404-stalls on the public site. This is
the exact failure `LOCAL_ONLY_DATASETS` exists to prevent, and the gate is not
holding them because the gate keys on demo ids while these are overlay stems
inside an otherwise-live demo. **Accept:** either the two stems are r2-synced
(fold into B2) or the composite is gated until they are. The three properly gated
archives — `storm-4d-isolines`, `rain-flood-2019`, `gtfs-ch` — are correctly
held back and are not a defect; they are B2's tail.

_Amended 2026-07-31._ **The class recurred, and the un-synced tail grew from 5
stems to 9.** Re-probing all **68** registered manifest URLs (up from 64) on
2026-07-31 returns **35 v2 / 24 v1 / 9 × 404** — the v2-vs-v1 split is unchanged
and its membership matches B2 exactly, but four new 404s appeared:
`mrms-storm3d-{cloudtop,outages,warnings,reports}`, the context overlays of
`storm-3d-conus`. That demo's PRIMARY (`mrms-storm3d-volume`) is 200, which is
the worst shape of this failure: the demo mounts, the governor starts, and then
playback stalls behind overlays that never arrive. Unlike `wpc-fronts` the id is
a demo id, so the gate can reach it — `storm-3d-conus` is now in
`LOCAL_ONLY_DATASETS`, and `storm-4d-greenfield`'s prose link to it was removed
(the demo-meta contract test fails a prose link into a gated demo, and caught
this). All nine 404 stems exist locally at `formatVersion: 2`, ~1.5 GB total, so
every one of them is a sync gap and not a build gap — they are B2's tail, not
new work. **`wpc-fronts` / `wpc-fronts-pips` remain the open half of L1**: they
are overlay stems of the un-gated `severe-weather-2024`, so only the sync
closes them.

_Closed 2026-07-31._ **The sync closed all of it.** `wpc-fronts` and
`wpc-fronts-pips` both return 200 and decode (172 features on the first fronts
tile, times in range), so `severe-weather-2024`'s overlay no longer 404-stalls.
L1b's rebuilt LOD pyramid is up. `LOCAL_ONLY_DATASETS` is now **empty** —
`storm-4d-isolines`, `rain-flood-2019`, `gtfs-ch` and `storm-3d-conus` are all
un-gated and verified, and `storm-4d-greenfield`'s prose link to the
continental cut is restored. The gate mechanism stays for the next pre-sync
dataset.

**Still gated: the Neural-State Atlas** (`ATLAS_ARCHIVES_SYNCED = false`). Its
three archives are live, but the two root-level `.bin` sidecars exposed a real
hole in `r2-sync.sh` — no pass matched `*.bin` / `*.meta.json` at the data
root, because they sit outside `packs/`, `index/` and every bundle directory,
so each filter list rejected them at its trailing `- **`. A `[sidecar]` pass
now covers them and the files are uploaded, but the 4-hour negative cache above
is still serving 404 for the two `.bin` URLs. Un-gate once that expires or a
purge lands, and re-verify with a plain GET (**not** `HEAD` — it bypasses the
cache and will lie to you).

**L1b. The storm-4d radar LOD pyramid on R2 has no time axis.** `lod_min_zoom`
thinned the gate cloud on a 3D **space** grid over the whole 9.5-hour window, so
one gate claimed its cell for every scan and the coarse tiers hold a temporally
incoherent scatter rather than a thinned copy of each scan. The renderer draws
one temporal bucket at a time, so the tier that matters — z8, the demo's own
`initialViewState.zoom` — showed a **median 13% of the visible bucket's gates,
and 0% in the worst buckets**, with the full 18.3 M only at z9. That is the
"you have to zoom in too far to get high resolution" report. Fixed in both
generators (the cell is now 4D, keyed on `--temporal-bucket`; cells re-sized to
screen resolution) and **rebuilt locally** — z8 now shows a median 65% — but
`tiles.poopdeck.gl` still serves the old pyramid. Measurements and the new
ladder are in
[storm-4d-greenfield-2026-07.md §11.4](./storm-4d-greenfield-2026-07.md).
**Accept:** the rebuilt `storm4d-volume` (~360 MB, up from 217 MB) is r2-synced
— fold into **B2**. `mrms-storm3d-volume` carries the same defect and its cells
still need re-tuning on its next rebuild.

**L2. The browser-verify queue now spans three campaigns.** Browser verification is a
**mandatory manual gate** in this project (renderer-architecture §2.9: tiers 1–4
cannot prove compiled-shader pixels), and the queue has grown across three
campaigns. Test-green, aesthetically unverified, in rough priority order: the
maplibre **v5 globe** (the showcase pin moved to `^5.24.0`, so the backend's
`globe: true` is exercised for the first time); **polygon seam-wall masking** and
the new **per-ring outline** path (holed polygons should stop drawing the bridge
segment); the shipped **pixel-behavior changes** (`AnimatedBoundingBoxLayer` boxes
now actually rotate to heading and scale to dimensions — they were silently
identity; the flights comet-wake → glide-dots change); first live drive-through of
`AnimatedMeshLayer` / `AnimatedHexagonLayer` / `AnimatedTextLayer`; the re-linked
`/drive` and `/worlds` routes; `storm-4d-isolines` aesthetics (sheet density,
whether the cloud-top canopy fights the thin lines, fade timing at 288×); the
**storm-4d style + LOD pass** (outline-only outage counties, wireframe-only
warning cages, and whether z8 now reads as the storm rather than a sample —
[storm-4d-greenfield-2026-07.md §11.5](./storm-4d-greenfield-2026-07.md)); the
multi-source composite gating drill from
[playback-and-loading.md §8](./playback-and-loading.md); and the three geo viewer.
**Accept:** each line seen and either signed off or turned into a defect.

### T — Claims the repo makes that the world does not back

**T1. The published repository URL 404s.** `https://github.com/BertCh/spatiotemporal-tiles`
returns **404** (verified 2026-07-26; the repo is private). It is the
`repository`/`homepage`/`bugs` on all four published crates and all eight
published npm packages, the `GITHUB_BLOB_BASE` the docs site uses for source
links, the releases page both READMEs send `cargo install` users to, and a
precondition for npm provenance (which requires a public repo). The ordering
constraints that once made this awkward are discharged — the roadmap is
consolidated, the scratch files are gone, the false install claims are corrected —
so this is now a straight switch, and it wants to happen **before** B3 so 0.6.0
ships pointing at something real.

**T2. GitHub Actions has never run; the CI gates are unverified config.** Zero
bot commits across the repo's history, no release PR, and no `crates/*/CHANGELOG.md`
despite release-plz having claimed to write them (that config is now deleted —
see the discharge list). The workflows were repaired in the hardening waves (the
`showcase-probe` job could not pass as written) and a roadmap-citation gate was
added, but none of it has executed. _(Not re-verified 2026-07-26 or 2026-07-31:
no `gh` CLI in this environment. Last verified 2026-07-24.)_

_Amended 2026-07-31._ **The gates are no longer absent, and running them by hand
found four red jobs.** `ci.yml` now carries `cargo fmt --check`, the curated
clippy deny set, `oxlint` and `oxfmt --check` — so this entry's old claim that
they were "deliberately absent" no longer describes the file. Running every job
locally against the pre-commit tree, four were red, and each had been invisible
to `cargo test --workspace`, the gate the rest of this register quotes:

- **`rust-feature-lanes` (3 of 6 lanes) and `rust-all-features`.** The columnar
  property refactor ported `postgres_input.rs` to `FeatureProperties` and never
  touched its DuckDB twin, which still called `props.keys()` and passed the old
  `shared_properties` shape. DuckDB is not a default feature, so the default
  test suite compiled and passed around it. The `cli` lane is the full-CLI build,
  so `cargo install --features cli` could not have compiled — a 0.6.0 blocker.
- **`rust-lint`** on two files from the same batch, and **`ts-lint`** on eleven,
  six of them the atlas components.

Fixing the lanes then exposed a real behavioural divergence that no default-
feature run could reach: `source_parity::duckdb_matches_file_parsed_features`.
`FeatureProperties::to_map()` cloned the owned map verbatim while every other
accessor (`get`, `iter`, `len`) treats a null as absent, so a feature read
through the DB path compared unequal to the identical feature read columnar —
the exact comparison `to_map` exists to make. The DB readers really do produce
them, mapping a non-finite float to `Value::Null` via `json_number_or_null`.
`to_map` now drops nulls in both arms. **The durable lesson: this workspace has
two DB input adaptors behind non-default features, and the default suite will
never tell you when a shared type changes under one of them.**

### K — Known defects with a named fix

Each is small, real, and has its analysis written down where it belongs. None
blocks B1–B3.

**K1. `stt-serve` emits compact times with no capability channel.**
`/metadata.json` carries `formatVersion` but has no `capabilities` field, so a
served tile using `st`/`et` declares nothing — safe today only because the client
decoder ships in this repo. Either add the channel or document the lockstep
assumption; `docs/spec/stt-serve-protocol.md` still describes v1 behavior either
way. ([format §10.4](./stt-packed-format-decisions.md))

_Closed 2026-07-31._ **The channel was added and this entry outlived it.**
`/metadata.json` carries a `capabilities` array derived from the same
`EncoderSettings::required_capabilities()` the offline build declares with, and
`docs/spec/stt-serve-protocol.md` documents it — including the detail that
earns the design: it is **always present**, empty when the server encodes the
capability-free shape, so its ABSENCE unambiguously means "server predates this
key" rather than "declares nothing".

**K2. `stt-validate` reports structural drift on correct archives.** The
per-tile exact-integer quantizer refuses a column on outlier-inflated inputs,
which changes the column _set_ tile to tile; `part_offsets` adds
`<absent> vs List<UInt32>` entries for the same reason. The archive is right and
the report is a false positive. The proper fix is the dataset-global
attribute-range pin, which shares the two-pass-build prerequisite with the
dictionary hoist. ([format §10.3–§10.4](./stt-packed-format-decisions.md))

_Amended 2026-07-29._ **Not every drift report is this false positive — six were
real.** Validating all 64 local archives at `--sample 300` found drift in
`wildfires` (163), `ais-all-us` (82), `animals` (66), `flights` (13),
`drifters` (3) and `osm-nyc-changesets` (2): property columns present in some
tiles and absent in others, plus `animals.organism` typed
`Dictionary(UInt16,Utf8)` in some tiles and `UInt16` in others. All six predate
the property-kind fixes (`2c020da`, `c13970a`). Rebuilding each with the current
builder cleared the report while reproducing the archive — `ais-all-us` came back
byte-for-byte identical in shape (559,809 tiles / 19,347,885 features) from a
fresh NOAA fetch, and `animals` to within 77 features. What survives a rebuild is
the benign `adaptive encoding width varies by tile` **warning**, which is what
K2's "expected" case actually looks like. So: treat a drift **error** as real
until a rebuild says otherwise; K2 covers the warning, not the error.

Five of the six are rebuilt and installed (old copies kept as
`examples/showcase/public/data/.<name>.bak-drift`). `wildfires` is NOT — see K9.

**K9. Two dataset recipes no longer reproduce their archives.**

- **`stt-generate` drove `stt-build` 0.1.0.** `find_stt_build_binary()` probed
  for a sibling of its own exe — impossible, since `tools/stt-generate` is its
  own workspace — then fell through to a bare `"stt-build"` PATH lookup that hit
  the released `~/.cargo/bin` binary while the tree was at 0.5.0. The archives it
  produced carry no `schemas`, no `capabilities` and `tile_count: 0`: plausible
  on disk, broken at read time. Fixed 2026-07-29 (`STT_BUILD_BIN` → sibling →
  workspace `target/release` → PATH, and it now prints the resolved binary and
  warns on version mismatch) — silence was the defect, not the fallback.
- **`wildfires` cannot be regenerated: the upstream data is gone.** The shipped
  archive holds ~460 fires. The NIFC service on 2026-07-29 returns 98,168 records
  overall but only 297 for 2020–2023, of which **10** clear `--min-acres 1000` as
  wildfires. Two real query bugs were fixed in the same pass (`FIRE_YEAR` is an
  `esriFieldTypeString`, so the year range was a string comparison — the typed
  field is `FIRE_YEAR_INT`; and `FEATURE_CA = 'Wildfire'` matched one of five
  values, dropping `Wildfire Final Fire Perimeter` and `Wildfire for Resource
Benefit`), which took the match count 1 → 10 and confirms the filter was also
  wrong — but the data is not there to recover. The archive keeps its 163-error
  drift because regenerating would destroy it. Re-source before touching it.

**K3. Cesium declares three fallbacks it cannot render.** `mesh → boundingBox`,
`text → icon` and `hexbin → h3Summary` were copied from the three descriptor, so
`degradeRequest` hands the caller a second unrenderable answer instead of the
honest "skip, go to deck". maplibre's conformance suite already has the gate that
catches this — port gate (c) to the cesium and three suites, then fix the three
entries. Same section: the generated capability matrix lets three auditors read
three different coverage numbers for the same descriptor; the generator should
render native / declared-with-fallback / bare-referral as distinct columns.
([renderer §4.1](./renderer-architecture.md))

**K4. Capability resolution is not host-aware.** maplibre declares
`capabilities.globe: true`, which is true only on a v5+ host. The showcase pin has
since moved to `^5.24.0`, so the deployment half of this defect is fixed — but a
boolean still cannot express "true on v5+", and `hostApiRange` remains absent from
the tree (grep, 2026-07-26). Either descriptors gain a host-range qualifier or
`globe` is declared `false` with the v5 capability documented separately. The
over-claim gate structurally cannot see this class: it checks claims against
evidence inside the package, and the package tests run against a mock.
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

**K7. Roadmap citations resolve by filename but not by anchor.**
`.github/scripts/check-roadmap-citations.mjs` passes (94 citations checked,
2026-07-26) because it validates that the _file_ exists. It does not validate
sections, and `animated-bounding-box-layer.ts` still cites `av-cockpit.md §3c`
and `§2c`, neither of which exists in that document (its §2 is fidelity
refinement, §3 is LiDAR compression). Fix the anchors and extend the gate to
check them — this drift class has now recurred twice.

_Closed 2026-07-31._ **Both halves landed.** The gate parses numbered headings
per document and validates the `§` anchor, not just the filename:
**270 citations checked, 105 of them anchored, all resolve** (up from 94
filename-only). The two stranded citations in `animated-bounding-box-layer.ts`
now read `§1.3` and `§2`, both of which exist.

_Amended 2026-07-31._ **The gate had a false-positive half nobody had hit yet.**
Its citation regex captured a lettered anchor (`[a-z]?`) but its HEADING parser
did not, so a real `#### 8.5a` registered only as `8.5` and a correct `§8.5a`
was reported as missing. Harmless while every lettered anchor in the tree was
drift — which is what the asymmetry was built for — and wrong the moment
`openusd-integration-2026-07.md` grew genuine `8.5a` / `8.5b` subsections. The
heading parser now registers a lettered leaf as itself AND its numeric parent.
Worth noting how it surfaced: both the doc and its citing file were UNTRACKED,
and the gate walks `git grep`, so the drift was invisible until they were
committed. **A gate over `git grep` cannot see untracked work** — the first
commit of a new doc is exactly when to re-run it. Now 273 citations, 107
anchored.

**K8. AI-suite tail.** No evals exist for any skill (the intended bar was ≥3 per
skill, without-skill baseline vs with-skill); remote hosting still wants an OAuth
2.1 Resource Server in front of the HTTP transport; the MCP revision target is
`2025-11-25` against a `2026-07-28` revision that adds Tasks for async builds;
and the 13-tool surface has never had its token budget measured.
([ai-suite.md](./ai-suite.md))

### Discharged since the 2026-07-24 register

Kept as one line each so the ledger is auditable, not to imply they are still
open.

- **Cloudflare _is_ caching the packs.** The previous register carried "not
  caching" as its highest-priority item on the strength of a `cf-cache-status:
DYNAMIC` reading. Re-measured 2026-07-24 and again 2026-07-26: a ranged pack
  request returns `MISS` then `HIT`, with `cache-control: public, max-age=31536000,
immutable` and a two-day `age`. The claim was wrong, the immutable-CDN economics
  hold, and the cold-start figures are edge figures.
  ([measurements §7.2](./measurements-2026-07.md))
- **The shipped plugin config is fixed.** `poopdeck-ai/.mcp.json` now launches
  `npx -y @poopdeck.gl/mcp` with no `--allow-cli` and no gitignored paths. (The
  repo-root `.mcp.json` still passes `--allow-cli` — that one is the maintainer's
  dev config, not the marketplace artifact.)
- **Three release systems became two.** `release-plz.toml` and
  `release-plz.yml` are gone; changesets owns npm, cargo-dist owns Rust binaries
  on a hand-pushed `v{version}` tag.
- **The showcase runs maplibre-gl v5** (`^5.24.0`), so the globe path the backend
  implements is actually reachable; what remains is the structural half (K4).
- **The polygon outline draws per-ring.** `buildOutlineSublayer` now feeds
  `ringIndices` (falling back to `startIndices` on older archives), so holed and
  multi-ring polygons stop drawing the spurious bridge segment — the render half
  of the seam work that the last register listed as unshipped.
- **`rain-flood-2019` and `gtfs-ch` are gated, not dead.** Both are in
  `LOCAL_ONLY_DATASETS` alongside `storm-4d-isolines`, so the deploy is honest and
  no demo 404s on them.
- Earlier waves: JSON Schemas resolve at their own `$id`; `packages/core`'s
  `clean` no longer leaves a stale build stamp; the Mercator limit is one constant
  across both tiers; v2 has a byte golden; `stt-validate` and `stt-serve` have real
  tests; cold start is measured.

---

## Consolidation ledger

Two consolidations have run: 2026-07-24 (26 records → 10) and 2026-07-26 (this
pass, which re-verified every open claim and rewrote the register as the backlog
above). **Git history preserves every retired file verbatim** — nothing was lost,
only de-duplicated, re-verified, and stripped of wave logs, agent-process
narration, and dated external SoTA surveys.

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

Two per-demo docs survived consolidation because they are **not campaign logs —
they are live contracts that source code cites as normative**, with section
anchors:

- **`av-cockpit.md`** — 44 section-anchored citations across
  `scripts/data-generation/*.py`, `packages/layers/src/layers/core/animated-bounding-box-layer.ts`,
  and `examples/showcase/src/components/av/*`. `scripts/data-generation/av_common.py:8`
  instructs extractor authors **not to deviate from** its §2 data contract.
- **`storm-4d-greenfield-2026-07.md`** — its §9.1 per-archive layer/field schema
  is called "the binding contract" by eight generators (`nexrad_volume.py`,
  `goes_cloudtop.py`, `storm4d_outages.py`, `storm4d_sounding.py`,
  `storm4d_wind3d.py`, …) and by `examples/showcase/src/datasets.ts:3122`.

**The rule going forward:** before retiring a record, `git grep` its filename. If
source code cites it as binding, it is a contract — move the contract to a spec
page or keep the record; do not delete it. Both of these were initially slated for
deletion and the citation graph caught it. The filename half of that check is now
automated (`.github/scripts/check-roadmap-citations.mjs`); the anchor half is
K7.
