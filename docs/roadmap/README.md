# Roadmap & decision records

Internal design and decision docs. **These are not part of the published docs
site** — the showcase `/docs` viewer bundles only `docs/{intro,architecture,spec,api,guides}`.
Once a design ships, its user-facing documentation moves to `docs/api/` and
`docs/spec/`; the doc here is kept as a decision record for the rationale, not
as a description of current behavior.

## Shipped — decision records (kept for rationale)

These describe work that is **already implemented**. Read them for the "why",
not the "what's planned" — the current state lives in the spec and API docs.

- [**stt-packed.md**](./stt-packed.md) — the packed container (manifest +
  content-addressed packs). Format shipped 2026-06-07; the live spec is
  [`docs/spec/stt-packed-format.md`](../spec/stt-packed-format.md). The doc now
  tracks only deferred follow-ups (global pack store, streaming writer); its
  paged-directory section is superseded by the entry below + spec §4.1.
- [**paged-directory.md**](./paged-directory.md) — paged `.sttd` directory with
  per-page geo + temporal bounds. Shipped 2026-06-11; folded into spec §4.1.
- [**player-buffering.md**](./player-buffering.md) — coupling the playback clock
  to data loading (PlaybackGovernor). Shipped 2026-06-09; live docs are
  [`stt-player`](../api/stt-player.md), [`playback-governor`](../api/playback-governor.md),
  [`time-controller`](../api/time-controller.md).
- [**av-cockpit.md**](./av-cockpit.md) — AV telemetry cockpit demo + the
  cross-workstream build contract. Built; see the showcase AV cockpit and
  [`AnimatedBoundingBoxLayer`](../api/animated-bounding-box-layer.md). The data
  contract it defines (scene bundle + sidecars + local-frame georeferencing) is
  now formalized in [`docs/spec/sidecar-assets.md`](../spec/sidecar-assets.md).
- [**av-refinement.md**](./av-refinement.md) — fidelity refinement of the cockpit
  against the canonical viewers (streetscape.gl / nuScenes / AV2 devkits). Round 1
  (code-only) shipped; Round 2 (re-gen + richer CAN/HD-map data) is the still-open
  part.
- [**three-tsl-renderer.md**](./three-tsl-renderer.md) — a second GPU renderer on
  Three.js + TSL (WebGPU, WebGL2 fallback) with react-three-fiber bindings
  (`@poopdeck.gl/three`), parallel to the deck.gl renderer. AV LIDAR cockpit on
  oriented Gaussian surfels + point splats + boxes/maps/ego in a local ENU metric
  frame; a deck↔TSL toggle in `/drive`. Code-complete + unit-tested; in-browser
  aesthetic verification is the open part.
- [**multi-source-coordination.md**](./multi-source-coordination.md) — coordinate
  loading *and* timing across N heavy STT datasets on one shared playhead
  (combined min-gate + a shared request scheduler). Shipped 2026-06-19 in
  `86bbb0f` (governor N-source registry + `SharedRequestScheduler` in
  `@poopdeck.gl/core`, behind the `configureSharedScheduler({enabled})` kill-switch).
- [**rust-audit-2026-06.md**](./rust-audit-2026-06.md) — Rust toolchain audit vs.
  tippecanoe / PMTiles / COPC / MLT. Wave 0 shipped; Waves 1–3 list the still-open
  items (full measure-correct loop, per-feature bbox covering, `stt-tools` crate).

## Forward-looking design (not built)

Genuine future work — nothing implemented yet.

- [**preprocessing-framework.md**](./preprocessing-framework.md) — bake analytics
  (clustering / aggregation / space-time cube / trend) into tiles at build time
  via a Plan-IR operator DAG + declarative Recipes. Design synthesis only. The
  `vertex_value_matrix` payload it builds on is specified in
  [`docs/architecture/data-format.md` §Space-time cube](../architecture/data-format.md#space-time-cube-payload-vertex_value_matrix).
