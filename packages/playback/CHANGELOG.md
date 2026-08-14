# @poopdeck.gl/playback

## 0.6.0

### Minor Changes

- d5163aa: Size targets, dataset-global encoding decisions, and a client that prices its own work

  The optimizer treated each tile as its own universe and the client guessed at
  what it could afford. Both are now answered from evidence. Full record:
  `docs/roadmap/optimization-conformance-2026-08.md`.

  **`stt-build --target-size <SIZE>`.** Ask for an archive size and the builder
  solves for the knobs that reach it — zoom clamp, temporal bucket, quantization
  — reporting what it chose and why. It never reaches a target by thinning:
  the no-default-thinning rule is a constraint on the solver, not a suggestion,
  so a target that can only be met by dropping features is refused with the
  shortfall stated rather than silently met.

  **Two-pass builds decide from the dataset, not from one tile's rows.** Numeric
  affines and the dictionary-vs-`Utf8` verdict are now pinned across the whole
  dataset, so a column cannot ship `UInt16` in one tile and `Float64` in the next
  — the drift that made `stt-validate` report structural churn on correct
  archives. The dictionary hoist that follows moves a shared category list out of
  every tile's tail and into the manifest schema template (measured −12.2% wire
  on a 380,007-feature build), and the reader shares one array instance across
  tiles that resolve to the same template rather than rebuilding it per tile.
  Hoisting is capped (1,024 categories / 4,096 category-bytes) so a
  high-cardinality free-text column stays `Utf8` instead of pinning a large list
  into every resident tile.

  **Tile selection is frustum-based.** Under pitch the old bounds-rectangle
  selection asked for tiles no camera could see. Measured across a 432-camera
  pitch × bearing matrix, the reduction is 16.9–21.6× at pitch 70 and 32.9–41.4×
  at pitch 85. Below pitch ~65 the two agree closely (1.3–3.1×), which is the
  honest shape of the win — it is a steep-camera lever.

  **The client prices its own work.** A cost oracle estimates decode and upload
  cost per tile so budgets are spent against measured bytes and measured time
  instead of tile counts, and the playback governor's scheduling is fair across
  sources rather than first-come.

  **Archives can now prove their own content.** `stt-build --content-fingerprint`
  folds a fingerprint over decoded features; `stt-validate --expect-fingerprint`
  checks a rebuild against it. This is what catches the failure structural
  validation cannot see — 106 archives once passed validation with silently
  scrambled coordinates. Note the boundary: the fingerprint is folded by the same
  binary that writes the tiles, so it is a tiler check, not a source-parse check;
  only `--expect-fingerprint` against a previously-built archive crosses that
  line.

  Also new: `--bounds-mode` (attest `metadata.bounds` over real vertices instead
  of centroids) and `--feature-id-scope`.

## 0.4.0

### Minor Changes

- `PlaybackGovernor.isScrubbing` + `scrubstart`/`scrubend` events, and the
  optional `BufferSource.setInteractive(bool)` broadcast (drives scrub-LOD
  in the tileset). The interactive bit is asserted on source add and cleared
  on remove/replace/dispose.

## 0.3.0

## 0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
