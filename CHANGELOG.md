# Changelog

This file summarizes changes that affect the STT format and project as a whole.
Package-level details remain in each `packages/*/CHANGELOG.md`; release tags and
published release notes are the historical record for individual artifacts.

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
