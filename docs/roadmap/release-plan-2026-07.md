# Release plan — 2026-07

**Temporary execution register.** This file exists to sequence the work between
today and the presentation. Its durable residue is the open register in
[README.md](./README.md); **delete this file once the waves are discharged.**

Written 2026-07-24 from a thirteen-agent audit (Rust architecture, TS package
design, showcase scope, docs IA, three roadmap clusters, external format SoTA,
external rendering SoTA, release/DX/CI, tests, plus a scope editor and an
adversarial verifier). Every claim below was checked against the tree, the
registries, or the live deployment. Claims that turned out to be false are
recorded as such rather than silently dropped.

---

## 0. The one-sentence positioning

> **poopdeck.gl is a cloud-native tile format that makes _time_ a
> tile-addressing axis — so a multi-gigabyte spatiotemporal dataset streams and
> animates from a dumb CDN bucket, with no server, no query engine, and no
> serverless function in front of it.**

Say the hierarchy once, early: **STT is the format. `spatiotemporal-tiles` is
the Rust toolchain. `@poopdeck.gl/*` renders it.** The root README currently
leads with "SpatioTemporal Tiles (STT)" and does not mention poopdeck.gl until
line 25, which inverts it.

### The three defended contributions

Three, not five. The five-contribution list in
[stt-packed-format-decisions.md](./stt-packed-format-decisions.md) §2 dilutes
all five.

**C1 — Time is a first-class tile-addressing axis, in an open spec with a
portable conformance kit.** `(z, x, y, t)` is the address; the directory
delta-codes the temporal axis to ~1 byte/entry; leaf pages carry
`[t_min, t_max]` so a playhead prunes pages without a scan.

_Skeptic-proofing:_ OGC 2D TMS 2.0 **Annex J** (n-D tile indexing) is
_informative_ and has no conformance class. PMTiles v3 has no temporal
provisions. MLT 1.0 (SIGSPATIAL '25) is columnar and fast and has no time
dimension. COPC needed a third-party temporal index extension bolted on.
Cesium's time-dynamic 3D Tiles is a roadmap item. The line is: _"the OGC has an
informative annex for this and no conformance class; here is one made
normative, with a published JSON Schema, golden fixtures, and a validator."_

**C2 — Content-addressed immutable packs + a few-KB mutable manifest = additive
deploys onto a bucket, with no compute tier.** This is the strongest moment and
it is currently uncited. The PMTiles maintainer rejects splitting large archives
in **protomaps/PMTiles#465** on exactly two grounds: clients cache byte offsets
that go stale, and _"no static storage platform has transactions across upload
operations."_ Content addressing dissolves both — offsets are per-immutable-
object, and the manifest swap is a single atomic pointer flip. Protomaps' own
deploy docs recommend a **serverless function** in front of the archive.

⚠️ **This claim is currently falsifiable in production — see W0.1.** Fix the
edge before putting it on a slide.

**C3 — GPU-evaluated temporal filtering, proven _identical_ across independent
renderer backends by a machine-checked capability gate.** Five time modes with a
CPU oracle, a frozen expression AST, a 2000-sample conformance sweep, and
`assertDescriptorConsistent`, which fails CI when a backend claims a capability
its tests do not prove. Three independently written GPU implementations (deck
GLSL, three TSL, maplibre GLSL) agree on the pixel-alpha contract.

_Skeptic-proofing:_ deck.gl's own docs say WebGPU support "is not production
ready", picking is **disabled entirely** there, and all extensions are
WebGL-only. STT's three backend does time-correct GPU id-picking on WebGPU
across 10 layer kinds. That fact currently lives only in a roadmap doc.

### Prior art to pre-empt, not wait for

**GeoMesa Z3/XZ3** is the sharpest available prior-art hit and nothing in
`docs/` mentions it. Get ahead of it: GeoMesa's Z3/XZ3 is a distributed
key-value **database index** (Accumulo/HBase) evaluated at query time; STT's
3D-Hilbert ordering is a **build-time byte layout** inside CDN-cacheable
immutable objects, selected against a measured range-read cost model
(`bytes_read + reads × gap`). Cite XZ3's store-extended-geometry-once insight as
the precedent for the open geometry-blob-sharing follow-up, and the hit becomes
a citation.

---

## Wave 0 — Release blockers

Things that are broken, dead, or false. **Every item is parallelizable; the
whole wave is roughly one focused day.** None of it is engineering; it is the
difference between a project that looks finished and one that looks abandoned.

### W0.1 — Cloudflare is not caching the packs ⚠️ HIGHEST PRIORITY

The central claim (C2) is **falsifiable with one `curl -I`** as deployed.
Verified 2026-07-24:

```
data/earthquakes-v2/manifest.json   cache-control: public, max-age=60, must-revalidate    cf-cache-status: DYNAMIC
data/earthquakes-v2/packs/*.sttp    cache-control: public, max-age=31536000, immutable    cf-cache-status: DYNAMIC
```

(Range request `bytes=0-1023`, repeated — still `DYNAMIC`.)

`DYNAMIC` means Cloudflare never considered the asset cacheable and **did not
attempt to cache it**. The origin side is flawless — `scripts/r2-sync.sh`
sets two correct Cache-Control regimes in separate `--header-upload` passes.
The edge is not honoring them because `.sttp`/`.sttd` are not in Cloudflare's
default cacheable-extension set, and a custom R2 domain does not cache
non-standard extensions without an explicit **Cache Rule**.

**Fix:** add a Cache Rule for `tiles.poopdeck.gl/*` (Cloudflare dashboard,
~15 min), re-probe until `cf-cache-status: HIT`, and add the probe to
`docs/guides/deploying.md` as a post-sync verification step —
`grep -n "cf-cache\|BYPASS\|HIT" docs/guides/deploying.md` currently returns
zero hits, and nothing in the repo verifies cache status.

**Accept:** a repeated range request on a `.sttp` returns `cf-cache-status: HIT`.

### W0.2 — Make the repo public, in the right order

`github.com/BertCh/spatiotemporal-tiles` → **404** (verified). It is the
published `repository`/`homepage`/`bugs` on all 4 crates and all 8 npm
packages, the `GITHUB_BLOB_BASE` in `examples/showcase/src/docs/manifest.ts:38`
(so roadmap links from **published** docs 404 on poopdeck.gl/docs), the
"GitHub releases page" both READMEs send `cargo install` users to, and a
precondition for npm provenance and the OIDC publish both workflows assume.

**This is one switch and it is not trivial.** Flipping it publishes the roadmap
directory, the scratch files, and the commit history. **Sequence:** Wave 1 cuts
first → W0.6 doc fixes → _then_ flip. Flipping first turns every finding in this
plan into a public artifact.

### W0.3 — Publish crates 0.5.0 and tag `v0.5.0`

Verified: crates.io `max_version` **0.4.0** (2026-07-06), versions
`[0.1.0, 0.1.1, 0.3.0, 0.4.0]` — 0.2.0 was never published. npm is at **0.5.0**
across all eight packages. Git tags are `v0.1.0, v0.1.1, v0.4.0` — no `v0.5.0`,
so cargo-dist never built the binaries the crate README advertises.

Mitigating: v0.4.0's `DIRECTORY_VERSION=5` / `PACKED_FORMAT_VERSION=V2` are
byte-identical to HEAD, so this is credibility, not breakage.

⚠️ Known constraint: `cargo publish` stalls on HTTP/2 upload from this network
(HTTP/1.1 fine; `multiplexing=false` does not help). **Publish from another
network.** Land W0.5, W0.6, W0.7 and W1.3 first so they ship in the same crate
release. Publish **≥24 h before the talk** — pnpm's new-release quarantine will
otherwise silently install the previous version in any live-typed command.

### W0.4 — Serve the JSON Schemas at their own `$id`

`docs/spec/manifest.schema.json:3` declares
`"$id": "https://poopdeck.gl/spec/manifest.schema.json"`. That URL returns
**200 `text/html`** (the SPA shell) — verified. `examples/showcase/public/spec/`
does not exist, and `public/_headers` covers only `llms.txt`. Any validator
resolving `$id` gets HTML.

**Fix:** copy the four `docs/spec/*.json` into
`examples/showcase/public/spec/` and add a `_headers` rule serving them as
`application/schema+json`. For a project whose central claim is "a published,
independently implementable spec", this is the most embarrassing findable
defect and it is one commit.

### W0.5 — Stop shipping a throwaway diagnostic to crates.io

`crates/stt-optimize/Cargo.toml` has **no `exclude`** (verified; `stt-core` and
`stt-build` both have one), so `cargo package -p stt-optimize --list` ships
`examples/nwm_geom_probe.rs`, whose first line is _"Throwaway diagnostic for the
'over-simplified / weirdly overlapping' report."_ One line.

### W0.6 — Fix the false install/CLI claims

- `crates/spatiotemporal-tiles/README.md:45` says "the four binaries"; there are
  five (omits `stt-bundle`, which is in `default`).
- `docs/api/cli-reference.md:3-16` says `cargo install spatiotemporal-tiles`
  installs **`stt-generate`**, which it cannot (`publish = false`).
- `Cargo.toml:157` says "four CLIs"; `:93` says "five".
- `README.md:6` badge says `rust-1.85+`; `rust-version = "1.88"`.
- `README.md:21` + `src/lib.rs:10` show `PackedReader::open("dataset/")`;
  `pack.rs:1781` documents a **manifest.json path** and `fs::read`s it → EISDIR.
  The lib.rs copy is ` ```ignore ` so nothing catches it — make it `no_run`.

One canonical sentence, repeated verbatim, and `stt-generate` moved into a
marked repo-only section.

### W0.7 — Fix the shipped Claude plugin (security)

`poopdeck-ai/.mcp.json` runs
`node ${CLAUDE_PLUGIN_ROOT}/../packages/mcp/dist/bin.js` with `STT_DATA_ROOT` at
`examples/showcase/public/data` — **both gitignored, zero tracked files**. Broken
for every user but the author.

⚠️ **It also passes `--allow-cli`**, which `packages/mcp/src/config.ts:142`
documents as enabling _"browser-driven arbitrary file read/write and
subprocess"_ and which correctly defaults **off**. Today it is inert only
because the path is broken. **Repairing the path alone would ship a marketplace
plugin that enables arbitrary subprocess execution by default for every
installer.** The fix is to drop `--allow-cli` **and** point at
`npx -y @poopdeck.gl/mcp` (verified working; the package is published at 0.5.0).

### W0.8 — Fix `packages/core`'s `clean` script

`packages/core/package.json:73` is `rm -rf dist`. **All seven siblings** also
remove `tsconfig.tsbuildinfo`, which lives outside `dist/` under
`composite: true`. Reproduced by an auditor: clean + build exits **0 with no
output**, leaving the whole workspace unresolvable — for the package every other
package depends on. One word.

### W0.9 — Sync or gate the two dead demos

`rainfall-2019` and `gtfs-ch` → **404 on tiles.poopdeck.gl** (verified), while
`examples/showcase/src/datasets.ts:4991` has `LOCAL_ONLY_DATASETS = new Set([])`
so nothing hides them. Two dead demos on the site being presented, with no error
surface making the failure visible. Either sync them or gate them.

### W0.10 — Fix the maplibre globe claim

`packages/maplibre/src/backend-descriptor.ts:162` claims `globe: true`, and the
generated capability matrix therefore asserts it. The showcase pins
`maplibre-gl ^3.6.0` (resolved `3.6.2`) where `setProjection` does not exist, so
`MaplibreRenderer.tsx:169,265` optional-chain it into a **silent no-op**.

This is the one place the project's otherwise-excellent honesty discipline
breaks, and it breaks in the exact mechanism (the capability gate) being
presented as the enforcement story.

**Ruling: bump the showcase to maplibre-gl v5**, where globe landed. Not v6 —
it shipped 2026-07-22 and is ESM-only + WebGL2-only and restructures Map/Camera.
**Fallback if v5 is not clean in two hours:** flip `globe: false`, regenerate
the matrix, and drop `|| ^6` from the peer range.

### W0.11 — Run the formatters; do not add CI gates yet

`cargo fmt --all --check` fails on shipped binary source
(`stt-bundle.rs:89,141`); `oxfmt --check` fails on six roadmap markdown files;
there are **151** clippy warnings workspace-wide (**81** in the four published
crates alone — moving `stt-generate` out removes 46%, not "most"). CONTRIBUTING
mandates oxlint+oxfmt in bold and **nothing enforces it**.

⚠️ **Do not add CI gates in this wave.** CI has never run — the repo is
unreachable and every roadmap record cites dead Actions as a blocker. Adding
gates to a CI that does not execute is theater and inflates the config surface
a reviewer reads. Run the formatters **locally, once, now**, commit the result,
and add the job after Actions is alive.

### W0.12 — Literal markdown backticks ship to 46 public demo pages

`DemoDetailPage.tsx:101-109` renders editorial prose as `<p>{p}</p>` — a raw
string, no markdown pipeline. But the prose is written in markdown: **73
backticks** across `src/content/demoMeta.ts`. Verified in the shipped artifact
and live:

```
$ curl -sL https://poopdeck.gl/demos/nuscenes-0103 | grep -o "The cockpit at .\{0,30\}"
The cockpit at `/drive/nuscenes-0103` compose
```

The app already bundles `react-markdown` for `/docs` — render `about[]` through
`src/docs/Markdown.tsx`, or add a 10-line inline-code splitter. Fixing this also
lets `/drive/...` become a real link, which closes W0.13 at the same time.

### W0.13 — The two best surfaces are unreachable from the UI

`/drive` (the AV cockpit) and `/worlds` (the scenario explorer) — roughly **13%
of the app**, and the two most impressive things in the project — have **zero
clickable path from anywhere on the site**. Verified:
`grep -rl 'href="/drive\|href="/worlds' build/client --include="*.html"` returns
nothing. Site nav is four items (`SiteHeader.tsx:12-17`); the homepage links
only `/story/drifters` and `/demos`; and `DemoEmbed.tsx:83` hardcodes
``to={`/demo/${dataset.id}`}``, so `/demos/nuscenes-0103` sends you to the
**flat** deck viewer, never the cockpit. Both routes work and return 200.

**Fix:** in `DemoEmbed.tsx:83`, route `dataset.type === 'av'` → `/drive/${id}`
and `'worlds'` → `/worlds`; add both to `NAV_ITEMS`. **Under an hour, and it is
the highest-leverage change in the entire audit for a presentation.**

### W0.14 — `examples/README.md` says the packages are unpublished

`examples/README.md:65-66` states the `@poopdeck.gl/*` packages are _"**not yet
published to npm** — today, build them from the monorepo and consume them via
`file:` dependencies"_. All eight are live at 0.5.0. The root README gets it
right; the examples README — the file a visitor lands on — contradicts it.

### W0.15 — Two more one-liners

- `packages/mcp/src/server.ts:43` hardcodes `'0.4.0'`; the published 0.5.0
  package tells every client it is 0.4.0. Read it from package.json at build.
- `.github/workflows/ci.yml:233-258` starts the showcase in **dev** mode, so
  `.env.production` never loads, `VITE_DATA_BASE_URL` is unset, and every
  dataset resolves to gitignored `public/data/`. The probe fail-closes, so the
  job **can never pass**. Set `VITE_DATA_BASE_URL=https://tiles.poopdeck.gl` or
  delete the job.
- `docs/spec/conformance.md:284` tells implementers to run
  `cargo test -p stt-validate` — **no such package** (it is a `[[bin]]` in
  `spatiotemporal-tiles`). §2.2/§2.4 describe a **pre-v2** fixture set;
  `grep v2-golden` returns nothing while §1 declares formatVersion 2 the default.

---

## Wave 1 — The cuts

Goal: the repo handed to someone matches the project being described.

| #        | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Accept                                                                             | Effort |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| **W1.1** | **`docs/roadmap` 26 → 8 files** — executed 2026-07-24, see [README.md](./README.md)'s ledger. **Then sweep the citation drift, which is much worse than it looks:** 39 source files already cite roadmap docs deleted in the _previous_ (2026-07-07) consolidation — **31** of them cite `renderer-abstraction-2026-06.md` alone, across `core`, `layers`, `three`, `maplibre` and `cesium` (`packages/core/src/render/capabilities.ts`, `shader-codegen.ts`, `time-filter.ts`, every `backend-descriptor.ts`, …), plus `three-renderer-parity` (2), `stt-packed-v2-design-2026-07` (3), `nwm-rivers-demo-2026-07` (2), `deckgl-parity-audit-2026-07` (1). Re-point each at its consolidation target using the ledger. Also drop `llms.txt:41`, where the public agent index points into a roadmap doc. **Add a CI check that no source comment cites a nonexistent `docs/roadmap/*.md`** — this class of drift has now recurred across two consolidations. | no source file cites a missing roadmap doc; `docs-manifest-contract.test.ts` green | M      |
| **W1.2** | **`stt-generate` → `tools/stt-generate/`**, with its own `[workspace]`, lockfile, and `rust-version`. 20k lines, `publish = false`, coupled only by shelling out to the `stt-build` **binary**. It forces `rust-version = "1.88"` on **every published crate** (via home→osmpbf, delaunator — both reachable only through it) and inflates the lockfile from ~237 to 550 packages with 3 concurrent reqwest versions. Delete its broken `All` subcommand (documented as "generate all"; hardcodes 3 of 16 and prints `✅ complete!` + returns `Ok(())` when children fail).                                                                                                                                                                                                                                                                                                                                                                                 | `cargo tree -i osmpbf` fails from the root; MSRV badge matches reality             | S      |
| **W1.3** | **Delete the dead Rust surface.** The `projection` cargo feature + `proj` optional dep: `#[cfg(feature="projection")]` appears in **one file**, gates two functions with zero non-test callers, and `proj` is never referenced in `stt-build/src` at all — yet it is advertised as public API in three places and makes `cargo test --all-features` vendor libproj via cmake and OOM the runner. Also: `stt-core/src/geometry.rs` (its own module doc is an obituary; its 4 exports have zero callers and it is the **only** reason `stt-core` depends on `geo 0.28`), the pre-Arrow `tile::Feature`/`Position`/`Value` model (`tiler.rs:1600` says the real path never builds one), `encode_layer_with`, and the 6 never-constructed `Error` variants. ⚠️ The two projection fns **do** have tests at `projection.rs:305-315` — delete those with them.                                                                                                    | `cargo build --workspace` green; `geo` gone from `stt-core`                        | S      |
| **W1.4** | **Trim the published TS surface.** `@poopdeck.gl/three` exports **398** symbols; 177 are referenced by nothing — not the showcase, not its own tests, not the docs — and 43 of those are runtime values. At 0.5.0 each is an API you have signed up to keep stable (compare: layers 100, core 112). Delete the dead runtime exports; optionally re-home node builders/geometry factories under `/internal`. **`@poopdeck.gl/cesium` → `private: true`** (2,004 lines, behind a `/cesium/:datasetId` route nothing links to) — keep the code, stop versioning it. Drop the two dead deps (`@takram/three-geospatial`, `earcut`+`@types/earcut` — comment-only references). Delete the **28** `tools/render-test/_*.mjs` one-off debug scripts.                                                                                                                                                                                                               | `tsc` green; `smoke-pack` green                                                    | S      |
| **W1.5** | **Collapse to one release system.** Three are configured and **zero drive releases**: `.changeset/` is empty across five releases, `packages/*/CHANGELOG.md` stop at 0.4.0 while 0.5.0 is live, `crates/*/CHANGELOG.md` **do not exist** despite `changelog_update = true`, and 0.5.0 landed as a hand-edited 14-file commit. Delete `release-plz.toml` + its workflow; add `[workspace.package] version` as a `sync-versions.mjs` target — it currently checks the plugin/marketplace/skills and **not Cargo.toml**, which is exactly why the two registries diverged. Keep changesets + cargo-dist-on-tag.                                                                                                                                                                                                                                                                                                                                                | `sync-versions --check` fails on a deliberate Cargo.toml skew                      | S      |

| **W1.6** | **Cut the demo catalog 46 → 12.** The live `/demos` page serves **46 cards over ~16 distinct source datasets** — NYC-taxi (9) and BIXI (8) alone are 37% of the catalog, and the demos' own taglines declare the redundancy ("The same routed trips as moving head-dots", "The same edge bundling, baked into the tiles"). `severe-weather-2024` is explicitly "five NOAA feeds on one 72-hour clock" and three of those five also ship as their own cards. Category balance is off too: mobility 29, earth-ocean 15, **built-life 3** (all three OSM-NYC). **No data is deleted** — move ~34 ids from `DEMO_META` into `CATALOG_EXCLUDED_IDS` and they stay live at `/demo/:id`; `DemoDetailPage.tsx:35` already redirects non-catalog ids to the viewer, and `test/demo-meta-contract.test.ts:134-145` polices the `related:` arrays for you. Flagship 12 listed below. | `/demos` serves 12 cards; every old URL still resolves | M |
| **W1.7** | **Add `examples/minimal/`.** `examples/` contains _only_ the 36k-line showcase, which depends on deck.gl **and** three.js **and** r3f **and** maplibre **and** mapbox **and** cesium **and** mermaid **and** prism. There is no starter anyone can run in under a minute. One Vite app, ~60 lines, one R2 `.stt`, `AnimatedPointLayer` + `PlaybackControls`. **This is the single highest-value addition in the audit** — it is the artifact that converts a presentation into an install. | `pnpm i && pnpm dev` renders an animated map from a clean clone | S |
| **W1.8** | **Delete the dead showcase surface.** `src/components/CubeControls.tsx` (dead **and** shadowed — `DemoViewer.tsx:568` declares its own local `CubeControls`), `src/components/av/MetricGauges.tsx` (dead), `src/components/Sidebar.tsx` + the `SHOW_SIDEBAR = false` branch (`Layout.tsx:10,26-89`) — a complete second navigation implementation, alive but unrendered, whose comment describes an IA that no longer exists. Plus the **10 stale `nuscenes-*-splat` ids** in `demoMeta.ts:152-161` that resolve to nothing (those bundles were never built) — and add the reverse assertion to `test/demo-meta-contract.test.ts`, which today only checks that excluded ids have no `DEMO_META` entry, never that they exist. Also: `packages/three`'s `StandaloneViewer` is dead public API in a published package. | no unreferenced components; contract test checks both directions | S |

### The flagship 12

Chosen for distinct data, distinct technique, and one-sentence explainability:

`ocean-drifters` + `/story/drifters` · `storm-4d-greenfield` ·
`severe-weather-2024` · `argoverse-02678d04` (via `/drive`) ·
`cosmos-drive-dreams` (via `/worlds`) · `nyc-taxi-trips` · `nyc-taxi-cube` ·
`osm-nyc-draw` · `ecco-currents` · `gtfs-ch` · `ship-traffic` ·
`earthquake-activity`

⚠️ `gtfs-ch` is one of the two demos currently **404 on R2** (W0.9) — sync it or
substitute `gtfs-nl`.

### The AV variants are NOT clutter — do not cut them

An early read of `datasets.ts` suggests 75 of 124 registry entries are
render-mode permutations of three AV datasets. **Verified false as a
criticism.** Those entries are legitimate backing data for the cockpit's
render-mode pills: `AvCockpitImpl.tsx:122-130` filters variants _out_ of the
scene switcher, and `:173-209` probes `getDatasetById(\`${id}-surfel\`)` to
decide which pills to show. Every Argoverse variant was probed live on R2 and
returns 200 (`-lod`, `-iso`, `-iso3d`, `-surfel`, `-splat`, `-stage`). **Nine
render modes over one LiDAR archive is a genuinely strong technical story** —
it is only invisible because of W0.13.

Registry totals for the record: 133 datasets registered at runtime, 101 in
production after the Waymo redistribution gate, 46 in the catalog.

### Cuts explicitly **rejected**

**`@poopdeck.gl/maplibre` — do not cut.** 33,565 lines (larger than `layers`)
of hand-rolled WebGL serving two showcase files is indefensible _as a product_,
but it is the single best **evidence** for C3: an independently written second
GPU implementation agreeing pixel-for-pixel with deck on the time-filter
contract, with only 3 dead exports and a 0.78 test ratio. Deleting 9,794 lines
of green, tested code days before a release is pure risk. **Instead: declare it
feature-complete-as-is, route all future layer-kind work to deck+three, and fix
the globe claim (W0.10).** Say so in the release notes and stop.

**`stt-serve` — do not cut.** It is in the facade's **default** feature set, has
a 436-line published protocol spec, three CI feature lanes, and a PostGIS
service-container parity job. "Cut it" is a bigger change than "test it"
(W2.3). It is also the written answer to _"isn't this just a database?"_, which
will be asked, and the answer is only credible because a live-query path exists
and was measured.

**Do not refactor the load-bearing files.** Three separate auditors proposed
splitting `arrow_tile.rs` (4,828 lines), `pack.rs`, and
`SpatiotemporalTileset` (3,896 lines). All three are well-tested and
load-bearing; `arrow_tile.rs` carries 1,957 lines of inline tests and
byte-reproducibility is the only safety net. A "moves only" commit that is not
moves-only churns every content address in the fleet. **Defer all three to
Wave 4.**

**Not now, on purpose:** SedonaDB input (arrow57↔arrow59 skew, zero code, a
_third_ DB backend when two cover every demo), GPU compute culling, a fifth
backend, and reopening the measured NO-GOs on lightweight column encodings,
rel-times32, narrow-ids, or inter-timestep deltas. **Those negative results are
a presentation asset, not unfinished work.**

---

## Wave 2 — Correctness and honesty gaps

Goal: the claims are backed. All parallelizable.

| #         | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Accept                                                  | Effort |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------ |
| **W2.1**  | **v2 byte-golden.** The structural inversion: the **frozen legacy** v1 has a byte-exact golden pin; **v2 — the default, the thing being released** — has none (`ls crates/stt-core/tests/fixtures/` → `v1-golden` only; `grep v2-golden crates/` → nothing), and its four committed cross-language fixtures are never regenerated or diffed in CI. Port `v1_golden.rs` verbatim + a CI step running `make-v2-golden.sh` then `git diff --exit-code`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | a deliberate pack-layout tweak turns both red           | S      |
| **W2.2**  | **`stt-validate` negative E2E.** All 4 existing tests assert **success**, while `conformance.md:77` calls the binary "the executable specification". Add 5 failures: bad blake3 filename, CRC failure, tile outside `time_range`, summary layer with non-cell `id` (the exact bug that shipped blank archives), `feature_count` disagreement — each asserting non-zero exit **and** a named error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | all 5 red on a fixed binary                             | S      |
| **W2.3**  | **`stt-serve` route tests.** 1,798 LOC, 11 tests, all pure functions; nothing constructs the Router. Extract Router construction, add ~10 `tower::ServiceExt::oneshot` tests pinning the paths/status codes/headers the 436-line spec promises.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | a route rename fails a test                             | M      |
| **W2.4**  | **Finish the encoder-globals migration.** `arrow_tile.rs:984-1115` still exposes 5 process-global cells and 10 public `set_*`, and `stt-build.rs:911` still calls `.apply()` while `stt-serve.rs:1152` uses the clean `.resolve()`. The `EncoderConfig` docstring **names the bug the globals caused**. Point stt-build at `resolve()`, delete `apply()`/`from_globals()`, make the cells `pub(crate)`. Skip the full plumbing refactor — this is a presentation liability, not a correctness one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | reproducibility tests byte-identical; no public `set_*` | S      |
| **W2.5**  | **Unify `MERCATOR_LAT_LIMIT` and `haversine_distance`.** The limit is a bare `85.0511` in 8 places and a named constant with a **different** value in one — so the native tier **drops** a feature at lat 85.05112 that the summary tier **keeps**. `haversine_distance` exists 3× (twice byte-identical inside one crate). Decide clamp-vs-reject once, assert it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | one constant, one function, a boundary test             | S      |
| **W2.6**  | **DuckDB spatial CI.** `spatial_roundtrip_smoke` is the only test exercising the real emitted SQL and is `#[ignore]`d for a network `INSTALL spatial`; the `rust-duckdb` job never passes `--include-ignored`. Postgres gets a full service-container job that does.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | job runs it                                             | T      |
| **W2.7**  | **Doc fixes.** `docs/README.md` silently omits `csv-quickstart` and `tuning-tiles` — the two guides everything else calls the best entry points. `docs/api/stt-react.md:255` shows a `HoverPreview` import that **throws** (it is on the `/hover-preview` subpath). Move `docs/architecture/data-format.md` → `docs/spec/tile-payload.md` (it is normative and filed under Architecture). Replace `README.md:103-117`'s `TimeController` hello-world with the `SttPlayer` one — the docs call SttPlayer the recommended entry point.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | links resolve; imports run                              | S      |
| **W2.9**  | **Stop the showcase from being a second, drifting copy of the layer vocabulary.** `examples/showcase/src/types.ts:3-138` declares a 19-member `DatasetType` union; `packages/core/src/render/capabilities.ts:26-51` already declares `LAYER_KINDS`, a frozen 23-member cross-backend vocabulary annotated _"Frozen — a rename breaks tsc everywhere."_ **They have already drifted** — `trip-heads`↔`tripHeads`, `point-cloud`↔`pointCloud`, `summary`↔`h3Summary`, `quadbin-summary`↔`quadbinSummary` — and the showcase imports neither `LAYER_KINDS` nor `LayerKind`. Backend support is likewise hand-maintained in three parallel lists (`buildCesiumLayer.ts:35-41`, `MaplibreRenderer.tsx:64-79`, `SttThreeGeoViewer.tsx`) despite every package publishing a machine-readable `BackendDescriptor.layerKinds`. **Alias `DatasetType` to `core`'s `LayerKind`** and keep only the five genuinely showcase-local composite types (`radar`/`weather`/`storm4d`/`av`/`worlds`). Do this before release — the drift is visible in public type names. | showcase imports `LayerKind`; no parallel backend lists | M      |
| **W2.10** | **Fix the dev/dist trap.** The showcase typechecks against **built `dist/`**, which is gitignored: no `resolve.alias`, no `resolve.conditions`, no tsconfig `paths`, no `development` export condition, and `turbo.json:29-32` gives `dev` **no** `dependsOn: ["^build"]` (while `typecheck` has one). So `pnpm dev` on a fresh clone resolves against absent or stale `dist`. This has already leaked upstream: `packages/react/src/components/PlaybackControls.tsx:65-69,77-87` declares `GovernorWithCost`/`GovernorWithSources` shims that exist _solely_ because "the showcase typechecks against the BUILT dist, which may be stale." Add a `development` condition (or a dev alias to `src`), then delete the two shims.                                                                                                                                                                                                                                                                                                                        | fresh clone `pnpm dev` renders; shims gone              | S      |
| **W2.8**  | **Emit a STAC Item** from `stt-build`/`stt-optimize`. `spec §10.3` already contains the complete, correct, mechanically-generable JSON and **nothing emits it**. Overture's pattern (GeoParquet + tiles + STAC) is the accepted discovery layer. ~50 lines, disproportionate payoff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `stt-build --stac` writes a valid Item                  | S      |

---

## Wave 3 — Presentation assets

Goal: the talk has numbers and a picture. All parallel, all high impact per hour.

| #        | Work                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                                                                                                                                                                                                                                                                                                    | Effort |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| **W3.1** | **Capture requests-to-first-frame and bytes-to-first-frame** for 2–3 fleet datasets.                                                                                                                                                                                                                                                                                                                                                                                       | `decisions §7` names COPC's "4 reads / ~110 KB on a 5.7 GB, 1.2 B-point file" as _the_ benchmark to track, and §10 has carried it as an open gate for weeks. **This is the one number a skeptic will demand**, the paged directory exists specifically to make it good, and it currently cannot be stated. Every comparable leads with one — Potree "billions of points", MLT "6× compression".                                        | S      |
| **W3.2** | **Light one hero demo.** Derive the sun direction from `currentTime` + dataset centroid so a 24 h demo visibly runs through dawn and dusk.                                                                                                                                                                                                                                                                                                                                 | Zero `LightingEffect`/`PostProcessEffect`/shadows/bloom anywhere in `examples/showcase/src` or `packages/layers/src`. Mapbox GL v3 made 3D lighting + building shadows the **default** basemap; against that bar the flagship reads as 2019 deck.gl. The three backend already has `getSunDirectionECEF`. Highest visual-impact-per-hour item available.                                                                               | S      |
| **W3.3** | **Wire `createStt3DTiles` into one metro demo.**                                                                                                                                                                                                                                                                                                                                                                                                                           | 364 lines of already-written, already-tested Google Photorealistic Tiles integration with correct ECEF co-registration — called **only** from three's own viewer/r3f, never from the showcase (the AV cockpit uses a different deck path). Photoreal buildings + a temporal flow layer is _the_ 2026 hero shot, and this is the only project that can put a real playhead under it. ⚠️ not available in the EEA.                       | S      |
| **W3.4** | **Backend chip + README claims.** Two-line HUD showing `webgpu`/`webgl2` (`CreatedRenderer.backend` already returns it).                                                                                                                                                                                                                                                                                                                                                   | Makes the WebGPU claim verifiable on an audience laptop. Then put C3's headline in the README: _time-correct GPU id-picking on WebGPU across 10 layer kinds, where deck.gl's own docs say picking is disabled entirely._                                                                                                                                                                                                               | T      |
| **W3.5** | **Front-door rewrite.**                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `grep -c "https://poopdeck.gl" README.md` → **0**, and there are no images. All 8 npm `homepage` fields point at GitHub. Add the URL + a linked hero GIF above the fold; set `homepage = "https://poopdeck.gl"` everywhere (keep `repository` on GitHub); add the naming sentence; link `/demos`, `/how-it-works`, `/docs`, `/drive`, `/story/drifters`, `/worlds` — `/how-it-works` and `/worlds` are currently unmentioned anywhere. | S      |
| **W3.7** | **Re-encode the story images.** `examples/showcase/public/story` tracks 12 images totalling **19 MB** — a single 9,055,328-byte JPEG (`franklin-folger-gulfstream-1769.jpg`) and a 6,239,205-byte PNG. The drifters story is the homepage's primary CTA. `parts.tsx:53` does set `loading="lazy"`, so it is not all eager, but any reader who scrolls pulls the lot. WebP/AVIF at ~1600px takes this under 2 MB with no visible loss; add `width`/`height` while in there. | story page < 3 MB of images                                                                                                                                                                                                                                                                                                                                                                                                            | S      |
| **W3.6** | **`SECURITY.md` + one issue template** before the repo goes public. Skip CODEOWNERS/CoC (ceremony for a solo project). Enable dependabot for the Rust side.                                                                                                                                                                                                                                                                                                                |                                                                                                                                                                                                                                                                                                                                                                                                                                        | T      |

---

## Wave 4 — Post-release

Do not start before the talk.

- Split `arrow_tile.rs` (4,828 lines, 77 public items, 8 concerns) and hoist the
  `.sttb` bundle out of `pack.rs` — pure mechanical moves behind re-exports, as
  a standalone no-op commit.
- Collapse the 20 byte-identical r3f wrappers (~500 → ~50 lines).
- **One naming prefix (`STT*`) across backends** — three's bare
  `ArcLayer`/`IconLayer`/`TripsLayer` **collide with deck.gl's own exports** in
  any app using both.
- Hoist `quadbinToTile` into `core/geo` (the maplibre copy's own comment says
  core is "the right long-term home").
- **WASM decoder** — the single highest adoption-per-line move available. MLT
  went paper → five production integrations in twelve months via decoders. It is
  also the cheapest path to the independent implementation that
  `docs/spec/conformance.md` cannot currently detect the absence of.
- **`stt-export --geoparquet`.** Data currently only flows in. Parquet got
  native `GEOMETRY`/`GEOGRAPHY` in Feb 2026 and Iceberg v3 carries them; a
  one-way format reads as a dead end. The tiles are already Arrow with GeoArrow
  geometry, so the export is mostly plumbing — and it turns "a new format you
  must commit to" into "a render tier over your existing lakehouse".
- Write the Cloud-Native Geospatial guide chapter; pitch a Martin source.
- **IANA registration** for `application/vnd.stt.*` — paperwork with a known
  template; PMTiles did it April 2025 and `stt-serve` still emits the deprecated
  `x-` prefix.
- GPU compute culling + indirect draw in three. With the live fraction at any
  playhead often <5% on a 24 h dataset, this is where the order of magnitude
  sits — but **close kind parity first**; building a compute pipeline while
  three sits at 17/23 kinds is scope creep wearing a SoTA badge, and that is
  this project's diagnosed failure mode.

---

## The five presentation risks

**R1 — Something clicked during the talk 404s.** Currently: the GitHub repo
(the "Repository" link on every crates.io and npm page), the schema at its own
`$id`, two live demos, and every roadmap-linked docs page on poopdeck.gl. Plus
`cargo install` gets 0.4.0 while step 3 installs 0.5.0 npm packages.
→ **W0.2–W0.4, W0.9. Then rehearse the quick start on a clean machine, on the
venue network, the day before.**

**R2 — "Isn't this PMTiles with a time dimension?"** The strongest question, and
the answer is currently uncited.
→ **Put protomaps/PMTiles#465 on a slide.** Then note PMTiles v3 has no temporal
provisions at all, and that STT's directory v5 openly credits PMTiles for the
spatial half. Generosity about the borrowed half makes the novel half
unarguable.

**R3 — "That's GeoMesa Z3."** Shipping for years; nothing in `docs/` mentions it.
→ **Pre-empt it** (see §0). Getting it from the floor costs far more.

**R4 — "Why four renderers?"** — and the maplibre globe claim is falsifiable in
ten seconds of devtools.
→ **W0.10, then tier them out loud:** deck.gl is supported (23/23 kinds); three
is the WebGPU/TSL research backend that does something deck cannot; maplibre is
the independence proof, feature-complete at 15 kinds; cesium is **the number** —
_"a fourth backend cost 2,000 lines, which is the point."_ Four co-equal-looking
backends invites the question. Four **tiered** backends **is** contribution C3.

**R5 — "What are the numbers?"** There are measured _format_ numbers (packed v2
−44.8%) and **no render or cold-start numbers at all**.
→ **W3.1 + W3.4.** A format talk that cannot state its cold-start cost is asking
to be doubted about everything else.

---

## What not to touch

The audit was explicit that these are the best things in the repo:

- **Comment quality in `stt-core`.** Comments record the _bug they prevent_, not
  what the line does — `tile.rs:38-45` (the f64-mantissa Hilbert collision),
  `columnar.rs:753-762` (why FNV-1a and not `DefaultHasher`: an unspecified
  algorithm means a toolchain bump churns every content address),
  `ordering_sim.rs:1-19`. 250/255 `stt-core` public items are documented, and
  there are **zero** TODO/FIXME/HACK markers across 75k lines of Rust.
- **The negative results** in `stt-packed-format-decisions.md` §5/§6 —
  byte-shuffle makes coordinates 31–68% _worse_; delta-bitpack loses to
  delta-varint under zstd; _"request count is a broken cost primary"_ (669 MiB
  vs 184 MiB on drifters). Put one on a slide.
- **The render kernel's enforcement**: `assertDescriptorConsistent`, the frozen
  `LAYER_KINDS` union, `kernel-framework-free.test.ts` (a static scan that fails
  the build if core imports any renderer, including dynamic `import()`), and
  `gen-capabilities-doc.mjs --check`. The kernel is thin (~3.3k shared vs ~87k
  backend) and that is honest — the _enforcement_ is what makes "multi-backend"
  a claim rather than an aspiration.
- **`@poopdeck.gl/playback`** — 3,652 lines, **zero runtime dependencies**, 0.99
  test ratio. The most reusable and most finished thing in the repo. Its §2
  argument (why a data player deliberately differs from a video player: cost is
  knowable in advance from the directory, speed multiplies data rate, viewport
  is a second seek axis) is the strongest original argument in the docs.
- **`stt-optimize`** — the cleanest crate: a real advisors/analysis split, a
  written advisor contract, and a principled lossy/`suggestion_only` split. The
  product principle — _quantization is suggested loudly, never auto; thinning is
  never auto-applied_ — belongs on stage.
- **`scripts/smoke-pack.mjs`** (packs real tarballs, installs with real peers,
  imports every `exports` subpath under plain Node), **`cli_reference_doc.rs`**
  (a bidirectional doc↔binary gate driving the real compiled binaries),
  **`v1_golden.rs`**, the **Waymo license gate** in `r2-sync.sh`, and
  **`docs/intro/choosing.md`** (the 18-row "which layer for my data shape" table
  _is_ the layer catalog — this is why 45 API pages are legitimate).
- **The showcase's curation contract.** `demoMeta.ts:5-10` states the invariant
  and `test/demo-meta-contract.test.ts` enforces it in 288 assertions: every
  dataset in exactly one of `DEMO_META`/`CATALOG_EXCLUDED_IDS`, every doc link
  resolves on disk, every `related` id resolves, is a catalog member, and never
  self-references. **Re-including a demo is a reviewed act enforced by CI** —
  demo galleries with a curation invariant at all are rare. W1.6 is executed
  _through_ this machinery, not around it.
- **`test/dataset-archive-reconcile.test.ts`.** It turns comment-only invariants
  ("timeRange MUST bracket the archive") into hard failures by reconciling every
  hand-authored `timeRange`/`timeWindow`/`wakeLength` against git-tracked
  density sidecars. Its "COVERAGE HONESTY" clause (`:25-28`) enumerates every
  _skipped_ dataset with a reason so nothing passes silently, and it
  distinguishes a dead-air hazard (hard fail) from a deliberate editorial
  sub-window (informational). 134 datasets reconciled, 0 inconsistencies; the
  whole showcase suite is 633 tests green in 768 ms.
- **`DemoEmbed`'s playback policy** (`DemoEmbed.tsx:9-23,38-56`):
  IntersectionObserver plays at ≥40% visible and pauses below 10% (stopping
  prefetch traffic while the reader reads), explicit user-pause beats the
  observer, `prefers-reduced-motion` disables autoplay entirely, and a
  coarse-pointer tap-shield stops the map hijacking page scroll. Four distinct
  courtesies most sites get zero of.
- **Prerender/hydrate discipline.** The landing page and all 46 demo pages
  prerender deck-free behind `ClientOnly` + `Suspense` with poster fallbacks;
  route-level splitting is clean (`AvCockpitImpl` 399 KB in its own chunk), and
  the 4 MB Cesium chunk is isolated to a route nobody visits.
- **MCP path-traversal defense** — `packages/mcp/src/docs.ts:146-172` does both
  a lexical `..` check and a canonical realpath check; `manifest.ts:389-411`
  enforces `resolveDatasetDir` containment. Better than most MCP servers ship.
