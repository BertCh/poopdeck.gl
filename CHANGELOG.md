# Changelog

This file summarizes changes that affect poopdeck.gl as a whole. Package-level
details remain in each `packages/*/CHANGELOG.md`; release tags and published
release notes are the historical record for individual artifacts. Changes to the
**archive format itself** are recorded upstream, in the
[SpatioTemporal Tiles changelog](https://github.com/BertCh/poopdeck.gl/blob/main/CHANGELOG.md).

## Unreleased

### Repository split

- poopdeck.gl moved out of the `spatiotemporal-tiles` monorepo into its own
  repository. Nothing about the published packages changed: same names, same
  entry points, same peer ranges, and the full commit history for every package
  came along.
- **npm and crates.io versions are no longer in lockstep.** They read 0.7.0 on
  both sides by history, not by promise; from here each stack releases on its
  own cadence. What relates them is the archive's `formatVersion`, declared in
  `project-status.json` on both sides. The `sync-versions` gate that used to
  police the two registries now covers only the Claude Code plugin surface.
- The Rust CLIs (`stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`,
  `stt-serve`) are unchanged and install exactly as before with
  `cargo install spatiotemporal-tiles`. `@poopdeck.gl/mcp` still drives them off
  `PATH`, which is how it always resolved them.
- Twenty-three documentation pages, the six conformance golden-fixture trees,
  and the AV palette contract are now **vendored** from the STT repository and
  byte-gated by `pnpm stt:check`. Published doc URLs are unchanged.
- Rationale, the full inventory, and the costs accepted:
  [repo-split-2026-08.md](docs/roadmap/repo-split-2026-08.md).

## 0.6.0 — 2026-08-13

### Format and compatibility

- Writers now emit packed `formatVersion: 3` with directory codec v6.
- The manifest carries a required variant registry, and directory entries carry
  `variant_id`, preventing raw and summary tiles at the same space/time address
  from colliding.
- Readers retain a read-only compatibility window for packed v2/directory v5.
  Format v1 remains unsupported.
- Existing raw-only v2 archives can be migrated container-only; summary-tier v2
  archives must be rebuilt because their missing variant identity cannot be
  inferred safely.

### Toolchain and packages

- The Rust workspace and seven public `@poopdeck.gl/*` packages are aligned on
  0.6.0.
- The umbrella Rust crate installs five binaries: `stt-build`, `stt-optimize`,
  `stt-validate`, `stt-bundle`, and `stt-serve`.
- The Cesium backend remains experimental and private in the workspace after its
  last npm release at 0.5.0.
- Public Three.js renderer exports use `STT*` names to avoid collisions with
  deck.gl classes.

### Upgrade notes

- Rebuild new archives with the 0.6 toolchain. Existing packed v2 archives
  continue to open read-only.
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
