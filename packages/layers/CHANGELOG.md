# @poopdeck.gl/layers

## 0.4.0

### Minor Changes

- `scrubLod` prop: degrade tile selection while the user scrubs the
  timeline (spatial zoom-drop / temporal-LOD routing), preview-only and
  default off.
- `onTileError` now passes `tileId: undefined` for dataset-level failures
  instead of a sentinel tile.
- Version alignment with @poopdeck.gl/core 0.4.0 (packed v2 reader).

## 0.3.0

### Minor Changes

- deck.gl parity superset. New layers on the SpatioTemporalLayer chassis:
  `AnimatedHexagonLayer` (discrete, pickable hexbin — the analog of
  `AnimatedHeatmapLayer`), `AnimatedMeshLayer` (one interpolated glTF/OBJ instance
  per tracked object), `AnimatedPointCloudLayer` (lit, time-windowed 3D points),
  and `AnimatedTextLayer` (time-filtered map labels). Two ported extensions:
  `DataFilterExtension` (GPU range-filter by a baked numeric column) and
  `CollisionFilterExtension` (de-clutter overlapping icons/labels), each with a
  spreadable `*Props` helper; deck's constant-config extensions pass through
  unchanged. Box and mesh layers now share one factored-out track kernel
  (pooling, binary-search + lerp, shortest-arc heading, appear/disappear fade).

### Patch Changes

- Updated dependencies
  - @poopdeck.gl/core@0.3.0
  - @poopdeck.gl/playback@0.3.0

## 0.2.0

### Patch Changes

- [`b6b74a0`](https://github.com/BertCh/spatiotemporal-tiles/commit/b6b74a07d12b5d6737243f5e19b7735a26cdd211) Thanks [@BertCh](https://github.com/BertCh)! - Onboarding fixes from the second published-package field test (AIS × hurricanes demo).
  - `@poopdeck.gl/react` now ships a stylesheet: `import "@poopdeck.gl/react/styles.css"` renders `PlaybackControls`/`HoverPreview` fully styled with no Tailwind in the host app — the file carries the compiled utility classes (no preflight, so it can't touch host styles) plus defaults for the theme tokens (`--accent`, `--surface`, `--ink-900/500/400`, `--hairline`, `--accent-soft`, `--page-bg`), all overridable from your own CSS. Tailwind v4 apps can instead register the package for scanning (`@source "../node_modules/@poopdeck.gl/react/src"`), now documented.
  - `usePlayback({ initialTime, timeRange })` honours `initialTime` — the mount-time range effect used to reset the playhead to the range start, making deep-linked `?t=` views impossible without a workaround. `initialTime` is clamped into the range and applies at mount only; a later `timeRange` change still resets to the new range start.
  - `<PlaybackControls {...pb} />` now spreads straight from the hook: the hook return echoes `timeRange` and exposes the speed under `currentSpeedMultiplier`, and the `targetPlaybackSeconds` prop is optional (default 60).
  - `@poopdeck.gl/layers` re-exports the governor-wiring callback parameter types (`SpatiotemporalTileset`, `BufferSource`, `BufferedRunway`) so `onTilesetReady`/`onBufferChange` handlers can be typed without depending on `@poopdeck.gl/core`/`playback` directly.

- Updated dependencies []:
  - @poopdeck.gl/core@0.2.0
  - @poopdeck.gl/playback@0.2.0

## 0.1.1

### Patch Changes

- Correct the published READMEs: the 0.1.0 tarballs still carried the
  pre-release "Not yet published to npm — consume it from the monorepo"
  banners. Install sections now lead with the real `npm install` commands.
- Updated dependencies []:
  - @poopdeck.gl/core@0.1.1
  - @poopdeck.gl/playback@0.1.1
