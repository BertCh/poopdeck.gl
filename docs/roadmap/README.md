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
- **Open work lives in exactly one place — the register below.** Unbuilt or
  declined work is _not_ listed here; it lives as a counted-out bullet with a
  revival trigger inside the record that owns it. A record that is not indexed
  below is not findable, so a new record earns its index line in the same pass
  that creates it.

## Records

- [**shipping.md**](./shipping.md) — versioning and registries, the naming
  rationale, the feature/install matrix, publish auth, the three release systems
  (one of which should be deleted), and the explicit non-goals.
- [**stt-packed-format-decisions.md**](./stt-packed-format-decisions.md) —
  format, build and optimizer decisions: the measured baselines, the paged
  directory, the frozen wire-token invariants, and the negative results
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

### Not a record

- [**release-plan-2026-07.md**](./release-plan-2026-07.md) — **temporary.** The
  sequenced execution plan (waves 0–4) for the work in the register below, plus
  the positioning and the presentation risks. Its durable residue is the
  register; **delete it once the waves are discharged.**

## The open register

The single source. Every item was re-verified against the tree, the registries,
or the live deployment on **2026-07-24**; each carries the evidence needed to
re-check it in under a minute. Nothing here is aspirational work — these are
things that are broken, dead, or false today.

**1. Cloudflare is not caching the packs.** _Highest priority: this one
falsifies the project's central claim with a single `curl -I`._ The origin side
is correct — `scripts/r2-sync.sh` uploads two Cache-Control regimes in separate
passes — but the edge never considered the objects cacheable:

```
data/earthquakes-v2/manifest.json   cache-control: public, max-age=60, must-revalidate     cf-cache-status: DYNAMIC
data/earthquakes-v2/packs/*.sttp    cache-control: public, max-age=31536000, immutable     cf-cache-status: DYNAMIC
```

A repeated `Range: bytes=0-1023` request on the pack still returns `206` with
`cf-cache-status: DYNAMIC`. `.sttp`/`.sttd` are not in Cloudflare's default
cacheable-extension set and a custom R2 domain will not cache non-standard
extensions without an explicit **Cache Rule**. Fix: add a Cache Rule for
`tiles.poopdeck.gl/*`, then re-probe until `cf-cache-status: HIT`, and add that
probe to `docs/guides/deploying.md` as a post-sync step — nothing in the repo
currently verifies cache status. **Accept:** a repeated ranged request on a
`.sttp` returns `HIT`.

**2. The published repository URL 404s.** `https://github.com/BertCh/spatiotemporal-tiles`
returns **404** (the repo is private). It is the `repository`/`homepage`/`bugs`
on all four published crates and all eight published npm packages, the
`GITHUB_BLOB_BASE` in `examples/showcase/src/docs/manifest.ts:38` (so
source links from the _published_ docs site 404), the releases page both READMEs
send `cargo install` users to, and a precondition for npm provenance and the
OIDC publish both workflows assume. Flipping it to public also publishes this
directory and the commit history, so it is one switch with an ordering
constraint, not a trivial one.

**3. crates.io is a release behind, and 0.5.0 was never tagged.** crates.io
`max_version` is **0.4.0** (versions `0.1.0, 0.1.1, 0.3.0, 0.4.0` — 0.2.0 never
existed); npm is at **0.5.0** across all eight packages; the workspace is
`0.5.0` (`Cargo.toml:12`). Origin tags stop at `v0.4.0`, and cargo-dist builds
binaries **on tag push**, so the prebuilt binaries and installer script the
crate README advertises do not exist for 0.5.0. Publishing has an operational
constraint recorded in [shipping.md](./shipping.md): `cargo publish` stalls on
HTTP/2 upload from the author's network — publish from another one.

**4. The JSON Schemas do not resolve at their own `$id`.**
`docs/spec/manifest.schema.json` and `docs/spec/scene.schema.json` declare
`$id: https://poopdeck.gl/spec/<name>.json`; both URLs return **200
`text/html`** — the SPA shell. Any validator that resolves `$id` gets HTML.
`examples/showcase/public/spec/` does not exist. Fix: publish the schemas at
that path with an `application/schema+json` `_headers` rule.

**5. Two registered demos 404 on the CDN.** `rainfall-2019` and `gtfs-ch`
return **404** on `tiles.poopdeck.gl` while neither is in `LOCAL_ONLY_DATASETS`
(`examples/showcase/src/datasets.ts`, which gates only `storm-4d-isolines`), so
the gate built to hide unsynced stems does not cover them and the live catalog
links them. Sync them or gate them.

**5b. `storm4d-isolines` is built but unsynced.** The CAPPI contour-sheet cut of
the Greenfield composite (demo `storm-4d-isolines`, 73 MB, built 2026-07-24 —
[storm-4d-greenfield-2026-07.md §10](./storm-4d-greenfield-2026-07.md)) exists
only in `examples/showcase/public/data/`. It is gated, so the deploy is correct
today; the open work is the r2-sync + un-gate. Its nine context overlays are
already on R2 (they are the `storm-4d-greenfield` archives, unchanged).

**6. `packages/core`'s `clean` script leaves a stale build stamp.**
`packages/core/package.json:73` is `rm -rf dist`; all seven siblings also remove
`tsconfig.tsbuildinfo`, which lives _outside_ `dist/` under `composite: true`.
So `clean` + `build` exits **0 with an empty `dist/`** — for the package every
other package depends on. One word.

**7. The shipped Claude plugin config disarms the MCP security posture.**
`poopdeck-ai/.mcp.json` passes `--allow-cli` (documented in
`packages/mcp/src/config.ts` as enabling browser-driven arbitrary file
read/write and subprocess execution, and correctly defaulting **off**) and
points at two gitignored paths — `packages/mcp/dist/bin.js` (`.gitignore:9`) and
`STT_DATA_ROOT=examples/showcase/public/data` (`.gitignore:83`). It is inert
only because the paths are broken. **The fix is to drop `--allow-cli` _and_
point at `npx -y @poopdeck.gl/mcp`** — repairing the path alone would ship a
marketplace plugin that enables arbitrary subprocess execution by default for
every installer.

**8. The maplibre backend claims a globe the showcase cannot render.**
`packages/maplibre/src/backend-descriptor.ts:162` declares `globe: true` and the
generated capability matrix therefore asserts it, but
`examples/showcase/package.json:38` pins `maplibre-gl: ^3.6.0`, where
`setProjection` does not exist — `MaplibreRenderer.tsx:169,265` optional-chain
it into a silent no-op. This is the one place the honesty discipline breaks, and
it breaks inside the capability gate that _is_ the enforcement story. Ruling:
bump the showcase to maplibre-gl **v5** (not v6 — ESM-only, WebGL2-only,
restructures Map/Camera); fallback is to flip `globe: false` and regenerate the
matrix.

**9. GitHub Actions has not been running; the CI gates are unverified config.**
Four workflows exist (`ci.yml`, `release.yml`, `release-npm.yml`,
`release-plz.yml`). All 183 commits are the author's — no bot commit, no
`chore: release` PR, no `crates/*/CHANGELOG.md` despite
`release-plz.toml` setting `changelog_update = true`. The `showcase-probe` job
starts the showcase in **dev** mode, so `.env.production` never loads,
`VITE_DATA_BASE_URL` is unset, every dataset resolves to gitignored
`public/data/`, and the probe fail-closes — that job cannot pass as written.
Corollary: **do not add new CI gates until Actions actually executes.** Gates on
a CI that never runs are theater, and several records cite dead Actions as a
blocker on their own behalf.

## Consolidation ledger

Retired files → where their durable content lives now. **Git history preserves
every retired file verbatim**; nothing below was lost, only de-duplicated,
re-verified, and stripped of wave logs, agent-process narration, and dated
external SoTA surveys.

| Retired                                                                                                            | Durable content now in                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `space-time-lod-2026-07.md`, `preprocessing-framework.md`, `stt-optimize-intelligence-2026-07.md`                  | [stt-packed-format-decisions.md](./stt-packed-format-decisions.md) — measured baselines, the advisor "measure, don't model" evidence, and both programs as counted-out entries with triggers |
| `naming-types-consistency-2026-06.md`                                                                              | format decisions (frozen wire tokens) + [renderer-architecture.md](./renderer-architecture.md) (codegen CI-diff gate)                                                                        |
| `sedona-integration-2026-07.md`                                                                                    | [db-input-adaptors.md](./db-input-adaptors.md) §8 — counted out, with the arrow-57-vs-59 containment note and a capability-shaped revival trigger                                            |
| `kind-parity-campaign-2026-07.md`, `maplibre-parity-campaign-2026-07.md`, `three-backend-sota-campaign-2026-07.md` | [renderer-architecture.md](./renderer-architecture.md) — backend tiering, the ratified adopt-or-cut verdicts, and the reusable gotchas                                                       |
| `full-ecosystem-audit-2026-07.md`                                                                                  | retired: §1 criticals closed; the backend parity matrix is now CI-generated (renderer-architecture §4); the untriaged backlog was not carried forward                                        |
| `scrub-lod-2026-07.md`                                                                                             | [playback-and-loading.md](./playback-and-loading.md) §7 — the correctness contract, the G5 negative result, and the QoE criteria                                                             |
| `cosmos-drive-dreams.md`, `rain-flood-demo-2026-07.md`, `dataset-candidates-2026-07.md`                            | [demos-and-datasets.md](./demos-and-datasets.md) — licence register, BLOCKED list, time-bombs, per-demo gotchas                                                                              |
| `av-cockpit.md`, `storm-4d-greenfield-2026-07.md`                                                                  | **kept — see the contract rule below**                                                                                                                                                       |

### The contract rule

Two per-demo docs survived the consolidation because they are **not campaign
logs — they are live contracts that source code cites as normative**, with
section anchors:

- **`av-cockpit.md`** — 44 section-anchored citations across
  `scripts/data-generation/*.py`, `packages/layers/src/layers/core/animated-bounding-box-layer.ts`,
  and `examples/showcase/src/components/av/*`. `scripts/data-generation/av_common.py:8`
  instructs extractor authors **not to deviate from** its §2 data contract.
- **`storm-4d-greenfield-2026-07.md`** — its §9.1 per-archive layer/field
  schema is called "the binding contract" by eight generators
  (`nexrad_volume.py`, `goes_cloudtop.py`, `storm4d_outages.py`,
  `storm4d_sounding.py`, `storm4d_wind3d.py`, …) and by
  `examples/showcase/src/datasets.ts:3122`.

**The rule going forward:** before retiring a record, `git grep` its filename.
If source code cites it as binding, it is a contract — move the contract to a
spec page or keep the record; do not delete it. Both of these were initially
slated for deletion and the citation graph caught it.

⚠️ Some inbound anchors were **already stale** before the consolidation — the
`§3c` citations in `animated-bounding-box-layer.ts` do not match `av-cockpit.md`'s
current §3. Fix the anchors, and add a CI check that no source comment cites a
nonexistent `docs/roadmap/*.md` (this drift class has now recurred twice).
| `ai-suite-skills-mcp-2026-07.md` | [ai-suite.md](./ai-suite.md) |
| `shipping-2026-07.md` | [shipping.md](./shipping.md) |
| `evaluations/` (4 files) | deleted — reference-only third-party model reviews from December 2025, written against a tree that predates the `packages/layers` rename, packed v2, and the render-kernel abstraction |
