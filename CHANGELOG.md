# Changelog

This file summarizes changes that affect poopdeck.gl as a whole. Package-level
details remain in each `packages/*/CHANGELOG.md`; release tags and published
release notes are the historical record for individual artifacts. Changes to the
**archive format itself** are recorded upstream, in the
[SpatioTemporal Tiles changelog](https://github.com/BertCh/spatiotemporal-tiles/blob/main/CHANGELOG.md).

## 0.8.0 — 2026-08-26

### Repository split

- poopdeck.gl moved out of the `spatiotemporal-tiles` monorepo into its own
  repository. Nothing about the published packages changed: same names, same
  entry points, same peer ranges, and the full commit history for every package
  came along.
- **npm and crates.io versions are no longer in lockstep.** They read 0.8.0 on
  both sides at this release, by history and not by promise; from here each
  stack releases on its own cadence. What relates them is the archive's
  `formatVersion`, declared in `project-status.json` on both sides. The
  `sync-versions` gate that used to police the two registries now covers only
  the Claude Code plugin surface.
- The Rust CLIs (`stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`,
  `stt-serve`) are unchanged and install exactly as before with
  `cargo install spatiotemporal-tiles`. `@poopdeck.gl/mcp` still drives them off
  `PATH`, which is how it always resolved them.
- Twenty-five files under `docs/` — twenty Markdown pages plus five
  machine-readable contracts (the manifest and scene JSON Schemas, the
  tile-matrix-set, the AV palettes, and the `stt-generate` dataset inventory) —
  and the six conformance golden-fixture trees are now **vendored** from the STT
  repository and byte-gated by `pnpm stt:check`. Published doc URLs are
  unchanged.
- Rationale, the full inventory, and the costs accepted:
  [repo-split-2026-08.md](docs/roadmap/repo-split-2026-08.md).

## 0.7.0 — 2026-08-26

### Added

- **`ArchiveMetadata.layers[].properties` is populated.** The column inventory
  is derived at open from the manifest's own embedded schema templates — no tile
  fetch, no extra request — with each column typed as a string, a number or a
  boolean, plus `geometryTypes` and, where the builder recorded style hints,
  measured `minValue`/`maxValue`. It had been hard-coded to `[]`.
- **`onMetadataLoad` on every layer**, not just the two summary layers. It is
  the shortest path to "which column names does this dataset accept?".
- `@poopdeck.gl/playback` gained the optional `BufferSource.isInert?()` member:
  a finalized `SpatioTemporalTileset` now reports itself inert and the governor
  drops it, instead of gating the clock at zero for the rest of the session.
- The three non-deck backends render every frozen `LayerKind` — 23 each, two
  more than deck. `@poopdeck.gl/react`'s stylesheet gained a dark palette.

### Changed

- **`engines.node` relaxed from `>=24.0.0` to `>=20`** on the six browser
  packages; their `dist` never executes under Node. `@poopdeck.gl/mcp`, which
  ships a `bin`, stays at `>=24`.
- The Float32 precision warning is scaled to the window being animated rather
  than a fixed 2^24 ms magnitude, so an honest wide `timeWindow` no longer trips
  it. A genuinely mismatched `timeOffset` still reports.
- **`@poopdeck.gl/three`: `STTPointCloudLayer` is renamed `STTPointLayer`**, and
  the old name now belongs to a different layer. No alias.

## 0.6.0 — 2026-08-13

### Format and compatibility

- Writers moved to packed v3 / directory v6 — see the
  [STT changelog](https://github.com/BertCh/spatiotemporal-tiles/blob/main/CHANGELOG.md).
- Readers retain a read-only compatibility window for packed v2/directory v5.
  Format v1 remains unsupported.

### Packages

- Seven public `@poopdeck.gl/*` packages are aligned on 0.6.0. The Cesium
  backend remains experimental and private in the workspace after its last npm
  release at 0.5.0.
- Public Three.js renderer exports use `STT*` names to avoid collisions with
  deck.gl classes.

### Upgrade notes

- Tile cache keys include the variant axis; the first browser load after an
  upgrade can be cold.
- Review the package changelog for any public API used directly:
  [`core`](packages/core/CHANGELOG.md),
  [`layers`](packages/layers/CHANGELOG.md),
  [`playback`](packages/playback/CHANGELOG.md),
  [`react`](packages/react/CHANGELOG.md),
  [`three`](packages/three/CHANGELOG.md),
  [`maplibre`](packages/maplibre/CHANGELOG.md), and
  [`mcp`](packages/mcp/CHANGELOG.md).

## Earlier releases

Earlier package histories are recorded in the package changelogs and Git tags.
The project is pre-1.0; read the
[status and compatibility policy](docs/intro/status-and-support.md) before
upgrading across a minor release.
