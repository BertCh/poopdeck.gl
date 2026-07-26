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

### Measurements

- [**measurements-2026-07.md**](./measurements-2026-07.md) — cold start:
  requests and bytes to first frame across three archive shapes, with the
  harness, the hardware, and the caveats. Four to five requests whether the
  archive is 46 MB or 807 MB.

## The open register

The single source. Re-verified against the tree, the registries, and the live
deployment on **2026-07-24**, after the three hardening waves
(`4b6d141`, `dc81451`, `2a58eb4`). Everything below is broken, unverified, or
blocked on an action only the maintainer can take — nothing here is speculative
work.

**Discharged in the hardening waves** (kept as a line each so the ledger is
auditable, not to imply they are still open): the JSON Schemas now resolve at
their own `$id`; `packages/core`'s `clean` no longer leaves a stale build stamp;
the shipped plugin no longer passes `--allow-cli` and no longer points at
gitignored paths; the showcase is on maplibre-gl v5, so the backend's
`globe: true` is backed by the version actually deployed; the Mercator limit is
one constant across both tiers; v2 has a byte golden; `stt-validate` and
`stt-serve` have real tests; and cold-start is measured
([measurements-2026-07.md](./measurements-2026-07.md)).

---

**1. Cloudflare is not caching the packs.** _Highest priority, and the only item
here that falsifies a headline claim._ Verified repeatedly on 2026-07-24: a
`.sttp` returns `cf-cache-status: DYNAMIC` on `bytes=0-1023`, on
`bytes=0-65535`, and on a full-object GET, all repeated. The origin is correct —
`scripts/r2-sync.sh` uploads `public, max-age=31536000, immutable` and that
header survives to the client — but `.sttp`/`.sttd` are not in Cloudflare's
default cacheable-extension set, and a custom R2 domain will not cache unknown
extensions without an explicit **Cache Rule**. Until one exists, every viewport
range request is a full origin round-trip, which is precisely what the
content-addressed-immutable-pack design exists to avoid, and the cold-start
numbers in [measurements-2026-07.md](./measurements-2026-07.md) are
origin-round-trip figures rather than edge figures. Fix and probe are documented
in [deploying.md](../guides/deploying.md). **Accept:** a repeated ranged request
returns `HIT`.

**2. The published repository URL 404s.** `https://github.com/BertCh/spatiotemporal-tiles`
returns **404** (the repo is private). It is the `repository`/`homepage`/`bugs`
on all four published crates and all eight published npm packages, the
`GITHUB_BLOB_BASE` the docs site uses for source links, the releases page both
READMEs send `cargo install` users to, and a precondition for npm provenance.
The ordering constraint that made this non-trivial is now largely discharged —
the roadmap is consolidated, the scratch files are gone, and the false install
claims are corrected — so this is closer to a straight switch than it was.

**3. crates.io is a release behind, and there is now a rename to version.**
crates.io `max_version` is **0.4.0**; npm is at **0.5.0**; the workspace is
`0.5.0`. Origin tags stop at `v0.4.0`, and cargo-dist builds binaries **on tag
push**, so the prebuilt binaries the crate README advertises do not exist for
0.5.0. Separately, the `STT*` layer rename landed as a clean break (the
transitional aliases have since been removed) with a changeset, and wants a
**0.6.0** bump. Operational constraint recorded in
[shipping.md](./shipping.md): `cargo publish` stalls on HTTP/2 upload from the
author's network — publish from another one.

**4. Three archives are built but unsynced, and correctly gated.**
`rain-flood-2019`, `gtfs-ch`, and `storm-4d-isolines` are in
`LOCAL_ONLY_DATASETS`, so the deploy is honest today and no demo 404s. The open
work is the r2-sync and the un-gate, which needs R2 credentials.

**5. GitHub Actions has not been running; the CI gates are unverified config.**
183 commits, no bot commit, no release PR, no `crates/*/CHANGELOG.md` despite
release-plz having claimed to write them (that config is now deleted — one
release system, changesets + cargo-dist). The workflows were repaired in wave 1
(the `showcase-probe` job could not pass as written), and a roadmap-citation
gate was added, but **none of it has executed**. Corollary, and the reason
`cargo fmt --check` and `clippy -D warnings` are deliberately absent: gates on a
CI that does not run are theater. Add them in the same pass that confirms
Actions is alive — the formatting itself is already clean as of `81eea7c`.

**6. Browser verification.** Several things now claim to work that no human has
looked at: the maplibre v5 globe, the re-linked `/drive` and `/worlds` routes,
the 12-card catalog, the markdown-rendered demo prose, and the polygon seam-wall
masking. All are test-green and none is aesthetically verified.

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
