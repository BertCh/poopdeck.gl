---
'@poopdeck.gl/playback': minor
'@poopdeck.gl/core': minor
---

**`BufferSource.isInert()`: a torn-down source can leave the governor instead of
deadlocking playback.**

`PlaybackGovernor` gates the clock on `min(runway)` over its REQUIRED sources.
A `SpatioTemporalTileset` that has been `finalize()`d clears its tile registry
but keeps its coverage index, so it keeps answering "nothing buffered, never
complete" for the rest of the session — which the min-gate reads as a laggard
that will catch up eventually. One stale entry pins the clock at zero forever.

That is not hypothetical: a renderer that swaps datasets under a layer whose id
changes with them (`<id>` → `<id>-surfel`) finalizes the old tileset with no
callback the app can hang an `unregisterSource` off, and because the variants
share one time range, the range-change reset that would have cleared the
registry correctly never fires. Measured on the AV cockpit's LIDAR render-mode
switch: 2 → 4 → 6 → 8 registered sources, the first one gating, playback dead
after the first switch.

- **`@poopdeck.gl/core`** — `SpatioTemporalTileset.isInert()` returns `true`
  once finalized. One-way; a finalized tileset is never revived.
- **`@poopdeck.gl/playback`** — `BufferSource.isInert?()` is a new OPTIONAL
  member of the readiness contract, and `PlaybackGovernor` drops every source
  reporting it at the top of each evaluation (and on gate entry, which
  evaluates once directly). Sources without the method are never inert, so
  existing implementations are unaffected.

This is a safety net for the registration contract, not a replacement: a
renderer swapping datasets should still unregister the ids it retires.
