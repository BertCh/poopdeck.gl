# Roadmap — decision records

A decision record here holds **rationale, measured baselines, negative results,
and counted-out items with revival triggers**. It is deliberately _not_ a
description of current behavior — the spec (`docs/spec/`) and the API reference
(`docs/api/`) own that, and a record that restates them goes stale the moment
the code moves. Nor is it a campaign diary: how the work was sequenced is in git
history, not here.

**These are not part of the published docs site.** The showcase `/docs` viewer
bundles only `docs/{intro,architecture,spec,api,guides}`.

> **Two registers since 2026-08-26.** The repository split
> ([repo-split-2026-08.md](./repo-split-2026-08.md)) gave the format and the
> tiler their own home. This register is complete **for the renderer**; open
> work on the archive format, the tiler, the optimizer, and dataset production
> lives in the STT repository's
> [own register](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/README.md).
> Records that moved are linked below by URL rather than repeated, and source
> comments that cite them carry an explicit `stt:` prefix so the citation gate
> can tell a declared cross-repo pointer from drift.

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

- [**repo-split-2026-08.md**](./repo-split-2026-08.md) — the **two-repository
  contract**: what stayed with STT and what moved here, why `@poopdeck.gl/core`
  was not split in half, the three vendored seam artifacts (docs, conformance
  vectors, AV palettes) and their drift gates, and the costs accepted.
- [**launch-readiness-2026-08.md**](./launch-readiness-2026-08.md) — the short,
  active launch contract and gate list; use this instead of mining historical
  records for current launch status.
- [**shipping.md**](./shipping.md) — versioning and the npm registry, the naming
  rationale, publish auth, changesets, and the explicit non-goals. The cargo
  half moved upstream with the crates.
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
- [**tile-loading-audit-2026-08.md**](./tile-loading-audit-2026-08.md) and its
  [evidence appendix](./tile-loading-audit-2026-08-evidence.md) — the
  whole-pipeline loader audit: the five reproduced stall mechanisms, the A/B
  record for all five implemented waves, and the QoE gate that keeps them shut.
- [**ai-suite.md**](./ai-suite.md) — the MCP-vs-Skills complementarity verdict
  and the surface the `poopdeck-ai` plugin ships.
- [**openusd-integration-2026-07.md**](./openusd-integration-2026-07.md) — the
  OpenUSD evaluation and its verdict.

**Moved to the STT repository** (linked, not repeated): the packed-format
decision record, the DB input adaptors, the four optimization records, the
formal-semantics record, the dataset licence register, the AV cockpit data
contract, the storm-4d field contract, and the neural-atlas campaign. Source
comments here cite them as `stt:docs/roadmap/<file>.md §N`.

### Measurements

- [**measurements-2026-07.md**](./measurements-2026-07.md) — cold start:
  requests and bytes to first frame across three archive shapes, with the
  harness, the hardware, and the caveats. Four to five requests whether the
  archive is 46 MB or 807 MB.

---

## The backlog

The single source of open work **for this repository** at the time of each dated
update. Items carry the check that proves them and the condition that closes
them. Ordered by what blocks what, not by size.

**Where this actually stands.** The register that ran from 2026-07-26 to
2026-08-26 covered both stacks; on 2026-08-26 it was split along with the
repositories. What stayed here is the renderer's queue, and it is dominated by
**manual verification** rather than library code: browser sign-off has been
accumulating since 2026-07-22 (L2), and the two ecosystem claims (T1, T2) are
unchanged by the split except that there are now two repositories making them.
Items about the archive format, the tiler, the optimizer, the published data
fleet and the generation scripts moved upstream — including the whole B4 fleet
rebuild record, K2, K9, K11, K12, L1 and DX2/DX3.

The last whole-repo green baseline recorded here (2026-07-31) covered both
stacks: **45 Rust test targets at `--all-features` (1,264 tests), the six
feature lanes, the curated clippy set, `cargo fmt --check`, the MSRV check, 35
Python tests, oxlint, `oxfmt --check`, the version-sync gate, the
roadmap-citation gate, the golden-pin gate and its own 41 tests, `smoke-pack`,
and 6,240 package + showcase tests.** Everything from `oxlint` onward is this
repository's half; the Rust and Python halves are now upstream's. The 2026-07-31
lesson behind that phrasing — that `cargo test --workspace` alone was hiding
four red jobs — is recorded in T2 and in
[db-input-adaptors.md §5](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/db-input-adaptors.md).

### S — The split's own tail

**S1. The vendored seam is unpinned and unproven end to end.** The split landed
with `.stt-sync.json` at `"ref": "UNPINNED"`: `pnpm stt:check` therefore refuses
to report success without `STT_REPO` set to a local checkout, which is correct
(a gate that cannot verify must not pass) but means the CI half has never
executed. Three vendored artifacts ride on it — the 23 doc pages, the six
conformance vector trees under `packages/core/test/fixtures/`, and the `stt`
block of `project-status.json`. **Accept:** the STT repository's split commit is
pushed, `pnpm stt:sync --ref <sha>` records it, and one CI run of `pnpm
stt:check` passes without a sibling checkout.

**S2. The first post-split release has not been cut.** npm and crates.io both
read 0.7.0, which is now a coincidence rather than a promise. The two stacks
release independently from here and are related by the archive's `formatVersion`
([repo-split-2026-08.md §2.3](./repo-split-2026-08.md)). **Accept:** `0.8.0` is
cut here on its own changeset, with a CHANGELOG entry that states the new
relationship explicitly so a consumer reading two version numbers does not infer
lockstep that no longer exists.

### L — Live defects on poopdeck.gl today

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
  ([storm-4d-greenfield-2026-07.md §11.5](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/storm-4d-greenfield-2026-07.md)).
- The multi-source composite gating drill from
  [playback-and-loading.md §8](./playback-and-loading.md).

**Accept:** each line seen and either signed off or turned into a defect.

> **L1 moved upstream.** The Neural-State Atlas sidecar that `r2-sync.sh`
> structurally cannot upload is a publishing-script defect; it is now L1 in the
> [STT register](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/README.md).

### DX — Onboarding review (2026-08-26)

A walk of the poopdeck.gl onboarding path exactly as a newcomer takes it —
`npm install` from the public registry, the quickstart copied verbatim, rendered
in headless Chromium against `tiles.poopdeck.gl`. Thirteen findings. **Nine are
fixed in the tree**; of the four the fix could not reach, the two below are
this repository's. DX2 and DX3 are manifest-and-fleet defects and moved
upstream with the publishing scripts.

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

**T1. The published repository URL 404s — and the split doubled the problem.**
`https://github.com/BertCh/spatiotemporal-tiles` returns **404** (re-verified
2026-08-24; the repo is private), and it is still the `repository`/`homepage`/
`bugs` on all eight published npm packages plus the `GITHUB_BLOB_BASE` the docs
site uses for source links. Since 2026-08-26 there is a **second** URL in the
same state: this repository's own `https://github.com/BertCh/poopdeck.gl`, which
does not exist on the remote at all yet, and which every package manifest here
now names. npm provenance requires a public repo, so this gates the next
release. **Accept:** both repositories exist and are public, every manifest
names the right one of the two, and `.stt-sync.json`'s fetch path resolves
without credentials.

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
[db-input-adaptors.md §5](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/db-input-adaptors.md). **Accept:** one green run on
GitHub's own runners.

### K — Known defects with a named fix

Each is small, real, and has its analysis written down where it belongs. None
blocked the completed 0.6.0 release. K2, K9, K11 and K12 are archive-format and
tiler defects and moved upstream; the numbering is left alone so existing
references keep resolving.

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
([format §10.4](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/stt-packed-format-decisions.md))

**K6. The AV render-mode set is declared in four-plus drifting places** — the
`renderModes` existence-probe memo in `AvCockpitImpl.tsx`, the `datasets.ts` regex
gates (`HELD_BACK_AV_MODES`, `WAYMO_LOCAL_ONLY`), the route/mode-param handling,
and the deck↔three parity copy. One registry row per mode kills it.
([format §9](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/stt-packed-format-decisions.md))

**K8. AI-suite tail.** No evals exist for any skill (the intended bar was ≥3 per
skill, without-skill baseline vs with-skill); remote hosting still wants an OAuth
2.1 Resource Server in front of the HTTP transport; the MCP revision target is
`2025-11-25` against a `2026-07-28` revision that adds Tasks for async builds;
and the 13-tool surface has never had its token budget measured.
([ai-suite.md](./ai-suite.md))

**K10. The cold-start numbers predate the fleet they describe.**
[measurements-2026-07.md](./measurements-2026-07.md) was captured 2026-07-24/26 —
before the payload byte break re-addressed every pack, before the republish, and
with five of the wanted datasets 404 at the time. The method, harness and cameras
are unaffected; only the numbers are stale. This was B2's tail, deliberately kept
open because measuring before the flip would only have measured the old layout.
**Accept:** the capture is re-run against the republished fleet and the §1
headline is restated or confirmed unchanged.

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

### Discharged (pre-split)

One line each, so the ledger is auditable — not to imply they are still open.

> Everything below closed **before** the 2026-08-26 repository split, when one
> register covered both stacks. It is kept verbatim in both repositories rather
> than bisected: the work was done in one tree, and splitting a frozen history
> along a boundary that did not exist at the time would misdescribe it. Post-split
> discharges are recorded only in the register that owns them.

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
  `origin/main`. ([format §10](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/stt-packed-format-decisions.md))
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
  temporal bucket) is recorded in [av-cockpit.md §3](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/av-cockpit.md). The live
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
  ([storm-4d §11.4](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/storm-4d-greenfield-2026-07.md))
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

## Consolidation ledger (pre-split)

> Also kept verbatim in both repositories, for the same reason as the
> discharged ledger above. The retired-doc mapping is what makes an old
> citation recoverable, and an old citation can appear on either side.

Three consolidations have run: 2026-07-24 (26 records → 10), 2026-07-26 (re-verified
every open claim and rewrote the register as the backlog above), and 2026-08-03
(collapsed the discharged chain to one line each and rehomed its durable lessons).
**Git history preserves every retired file verbatim** — nothing was lost, only
de-duplicated, re-verified, and stripped of wave logs, agent-process narration,
and dated external SoTA surveys.

| Retired                                                                                                            | Durable content now in                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space-time-lod-2026-07.md`, `preprocessing-framework.md`, `stt-optimize-intelligence-2026-07.md`                  | [stt-packed-format-decisions.md](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/stt-packed-format-decisions.md) — measured baselines, the advisor "measure, don't model" evidence, and both programs as counted-out entries with triggers |
| `naming-types-consistency-2026-06.md`                                                                              | format decisions (frozen wire tokens) + [renderer-architecture.md](./renderer-architecture.md) (codegen CI-diff gate)                                                                                                                                            |
| `sedona-integration-2026-07.md`                                                                                    | [db-input-adaptors.md](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/db-input-adaptors.md) §8 — counted out, with the arrow-57-vs-59 containment note and a capability-shaped revival trigger                                            |
| `kind-parity-campaign-2026-07.md`, `maplibre-parity-campaign-2026-07.md`, `three-backend-sota-campaign-2026-07.md` | [renderer-architecture.md](./renderer-architecture.md) — backend tiering, the ratified adopt-or-cut verdicts, and the reusable gotchas                                                                                                                           |
| `full-ecosystem-audit-2026-07.md`                                                                                  | retired: §1 criticals closed; the backend parity matrix is now CI-generated (renderer-architecture §4); the untriaged backlog was not carried forward                                                                                                            |
| `scrub-lod-2026-07.md`                                                                                             | [playback-and-loading.md](./playback-and-loading.md) §7 — the correctness contract, the G5 negative result, and the QoE criteria                                                                                                                                 |
| `cosmos-drive-dreams.md`, `rain-flood-demo-2026-07.md`, `dataset-candidates-2026-07.md`                            | [demos-and-datasets.md](https://github.com/BertCh/spatiotemporal-tiles/blob/main/docs/roadmap/demos-and-datasets.md) — licence register, BLOCKED list, time-bombs, per-demo gotchas                                                                              |
| `ai-suite-skills-mcp-2026-07.md`                                                                                   | [ai-suite.md](./ai-suite.md)                                                                                                                                                                                                                                     |
| `shipping-2026-07.md`                                                                                              | [shipping.md](./shipping.md)                                                                                                                                                                                                                                     |
| `evaluations/` (4 files)                                                                                           | deleted — reference-only third-party model reviews from December 2025, written against a tree that predates the `packages/layers` rename, packed v2, and the render-kernel abstraction                                                                           |

### The contract rule

Three per-demo/per-campaign docs survived consolidation because they are **not
campaign logs — they are live contracts that source code cites as normative**,
with section anchors:

- **`av-cockpit.md`** — 44 section-anchored citations across
  `stt:scripts/data-generation/*.py`, `packages/layers/src/layers/core/animated-bounding-box-layer.ts`,
  and `examples/showcase/src/components/av/*`. `stt:scripts/data-generation/av_common.py:8`
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
