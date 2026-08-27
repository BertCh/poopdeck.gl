# Status, support, and compatibility

The npm packages are on **0.8.0** and the Rust crate `spatiotemporal-tiles` is
on **0.8.0**; since the 2026-08-26 repository split the two version numbers move
independently and agree only by history. What relates them is the archive's
`formatVersion`, declared in `project-status.json` on both sides. Both stacks
are pre-1.0: production use is possible, but public APIs can still change
between minor releases. Read package changelogs and release notes before
upgrading.

## What is current

| Surface                   | Current state                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Packed archive writer     | `formatVersion: 3`, directory codec v6                                                                                    |
| Packed archive reader     | Format v3/v6 plus read-only compatibility for published format v2/v5 archives                                             |
| Layer frame               | v2 — the tile payload's own version, independent of the container `formatVersion`                                         |
| Rust distribution         | `spatiotemporal-tiles` 0.8.0; five installed CLIs                                                                         |
| Public npm packages       | Seven packages at 0.8.0: `core`, `layers`, `playback`, `react`, `three`, `maplibre`, `mcp`                                |
| Primary renderer          | `@poopdeck.gl/layers` on the repository-pinned deck.gl 9.3.x line                                                         |
| Cesium renderer           | Private workspace package, version-frozen at 0.5.0, source-only and experimental                                          |
| Showcase generator        | STT-repository-only `stt:tools/stt-generate` workspace; not installed with the public Rust crate                          |
| Local JS toolchain        | Node 24+ and pnpm 11.23.0 (building THIS repository)                                                                      |
| Published package runtime | Node 20+ — the browser packages' `dist` never executes under Node; `@poopdeck.gl/mcp` is the exception and needs Node 24+ |

The machine-readable [`project-status.json`](../../project-status.json),
workspace manifests, and format specification are authoritative if this page
ever disagrees with executable code. Version-consistency checks protect the
published package set; the
[conformance specification](../spec/conformance.md) protects the wire contract.

## Stability levels

**Stable, pre-1.0** means the normal adoption path and the surface receiving the
broadest integration coverage. “Stable” here does not promise 1.0 API
compatibility: minor 0.x releases can still include documented breaking
changes.

- packed format, manifest schema, and conformance fixtures;
- `stt-build`, `stt-optimize`, and `stt-validate`;
- `@poopdeck.gl/core`, `@poopdeck.gl/layers`, and
  `@poopdeck.gl/playback`;
- `@poopdeck.gl/react`; and
- the minimal deck.gl example and quickstart path.

**Preview** surfaces are published and tested, but their APIs or operational
contracts can change more readily: `stt-serve`, `stt-bundle`,
`@poopdeck.gl/three`, `@poopdeck.gl/maplibre`, and `@poopdeck.gl/mcp`. Consult
their API pages and, for renderers, the generated
[backend capability matrix](../spec/backend-capabilities.md).

**Experimental or workspace-only** code can change or remain unpublished
without a compatibility expectation. `@poopdeck.gl/cesium`, `stt-wasm`,
`stt-generate`, and specialized showcase surfaces are in this category.

## Format compatibility

Format, directory, and layer-frame versions are independent axes. Current
writers create packed format v3, directory v6, and layer frame v2. Reference
readers accept v3 and the published v2 compatibility window; v2 uses directory
v5 and is opened read-only. Unknown or unsupported format and directory versions
fail loudly. Note that `stt-serve`'s `/metadata.json` reports
`formatVersion: 2` — that is the layer-frame version, not the container
version; a live server has no container.

Packs and directories are immutable and content-addressed. A publisher must
write new objects under their new hashes and update `manifest.json` last; it
must never rewrite an existing pack in place. See the
[packed-format specification](../spec/stt-packed-format.md) for normative rules
and the [deployment guide](../guides/deploying.md) for publication order.

## API and dependency compatibility

- The 0.x Rust and TypeScript APIs follow semantic-versioning intent, but a
  minor release can contain breaking changes while the project is pre-1.0.
- The deck.gl integration is developed and tested against the pinned 9.3.x
  dependency line. Do not infer compatibility with deck.gl 10.
- A renderer's presence in the workspace does not imply feature parity. Use the
  generated capability matrix.
- The canonical minimum Rust version is `workspace.package.rust-version` in
  `stt:Cargo.toml`; it reaches this repository as `stt.toolchain.rust` in
  `project-status.json`, byte-gated by `pnpm stt:check`. `.node-version`,
  root/package engines, and the root `packageManager` define the JavaScript
  toolchain and are checked against `project-status.json` in CI.

## Getting help

Use GitHub issues for reproducible defects and focused feature requests. Include
the manifest's format version, the relevant package or CLI version, a minimal
reproduction, and validation output where possible. Follow
[`SECURITY.md`](../../SECURITY.md) for private vulnerability reports rather than
opening a public issue.

Support is community and maintainer best-effort; no response-time or long-term
maintenance window is promised. The license terms remain authoritative.
