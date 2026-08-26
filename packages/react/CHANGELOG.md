# @poopdeck.gl/react

## 0.7.0

### Minor Changes

- [`2ec0e4d`](https://github.com/BertCh/spatiotemporal-tiles/commit/2ec0e4ddf23c7eaa66a5fb060ccc508a95d45d77) Thanks [@BertCh](https://github.com/BertCh)! - **Onboarding fixes: a column inventory that is actually populated, a transport
  bar that works on a dark map, a precision warning that stops crying wolf, and a
  Node floor the browser packages do not need.**

  From a walk of the documented install-to-first-map path against the published
  packages and the hosted datasets.

  ### `@poopdeck.gl/core`
  - **`ArchiveMetadata.layers[].properties` is populated.** It is a typed, public,
    documented field that was hard-coded to `[]` on every archive ever opened, so a
    browser client's only route to its own column names was hand-decoding
    `manifest.schemas[].data` (base64 Arrow IPC) or installing the Rust CLIs. It is
    now derived at open from the manifest's own embedded schema templates — no tile
    fetch, no extra request — with each column classified as a string, a number or
    a boolean, plus `geometryTypes` off the CORE template's `stt:geometry` tag and
    measured `minValue`/`maxValue` when the builder recorded style hints. Fails
    soft in every direction: an unparseable template or an exotic column type drops
    that one item and leaves the rest of the metadata intact.
  - **The Float32 precision guard is scaled to the window being animated.**
    `assertRelTimeInRange` warned on a fixed 2^24 ms magnitude — an absolute
    constant of ~4.7 hours — so a dataset with a wider `timeWindow` tripped it by
    construction. The quickstart printed it on its first render, and so did the
    live showcase, both telling the reader to check a time offset that was correct.
    It now measures the actual f32 quantization step at the resolved magnitude
    against two floors: one 60 fps frame, and a fraction of the animated span. A
    genuinely mismatched `timeOffset` still reports. `assertRelTimeInRange` takes an
    optional trailing `spanMs`; `f32QuantumAt` and `RESERVED_TILE_COLUMNS` are newly
    exported.
  - `engines.node` relaxed from `>=24.0.0` to `>=20` (see below).

  ### `@poopdeck.gl/layers`
  - **`onMetadataLoad` is available on every layer**, not just the two summary
    layers. It fires once per archive init with the decoded metadata — the shortest
    path to "which column names does this dataset accept?":
    `onMetadataLoad: (meta) => console.table(meta.layers[0].properties)`.
    `H3SummaryLayer` and `QuadbinSummaryLayer` inherit it and no longer declare
    their own; behaviour there is unchanged.

  ### `@poopdeck.gl/react`
  - **The stylesheet ships a dark palette.** `styles.css` defined one light "paper"
    palette on bare `:root` with no dark variant, so the transport bar rendered
    near-black labels and a white scrubber track over the dark map every consumer
    floats it on. The same eight tokens now switch under
    `prefers-color-scheme: dark`, and `data-stt-theme="light" | "dark"` on any
    ancestor pins a mode — the case a dark map inside a light page needs. Setting
    the tokens yourself still wins over both.
  - **`PlaybackControlsProps.timeRange` is optional.** `usePlayback` echoes its
    `timeRange` option back so that `<PlaybackControls {...playback} />` "just
    works"; it worked at runtime and did not typecheck, because the echo is
    optional and the prop was required. Omitted, the bar falls back to the
    degenerate `[currentTime, currentTime]` range.

  ### All six browser packages

  `engines.node` moves from `>=24.0.0` back to `>=20`. The repository's own dev
  toolchain genuinely needs Node 24, but these packages' `dist` never executes
  under Node at all — and a floor above both the maintenance and active LTS lines
  hard-fails any consumer or CI running `engine-strict=true`, for nothing.
  `@poopdeck.gl/mcp`, which ships a `bin` and really does run under Node, stays at
  `>=24`.

### Patch Changes

- Updated dependencies [[`2ec0e4d`](https://github.com/BertCh/spatiotemporal-tiles/commit/2ec0e4ddf23c7eaa66a5fb060ccc508a95d45d77), [`4f4cd71`](https://github.com/BertCh/spatiotemporal-tiles/commit/4f4cd713a2866d4d58b68d95c2133366fa1152f4), [`bfba49c`](https://github.com/BertCh/spatiotemporal-tiles/commit/bfba49c9e5abcd4d1ab301c61fe18b4788d7f18c)]:
  - @poopdeck.gl/core@0.7.0
  - @poopdeck.gl/playback@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [d5163aa]
- Updated dependencies [2c020da]
- Updated dependencies [d5163aa]
- Updated dependencies [a7b57dc]
- Updated dependencies [d5163aa]
- Updated dependencies [2a58eb4]
  - @poopdeck.gl/core@0.6.0
  - @poopdeck.gl/playback@0.6.0

## 0.4.0

### Minor Changes

- Version alignment with @poopdeck.gl/core 0.4.0 (packed formatVersion 2
  reader, CRC-32C verification, capabilities gate).

## 0.3.0

### Patch Changes

- Updated dependencies
  - @poopdeck.gl/core@0.3.0
  - @poopdeck.gl/playback@0.3.0

## 0.2.0

### Minor Changes

- [`b6b74a0`](https://github.com/BertCh/spatiotemporal-tiles/commit/b6b74a07d12b5d6737243f5e19b7735a26cdd211) Thanks [@BertCh](https://github.com/BertCh)! - Onboarding fixes from the second published-package field test (AIS × hurricanes demo).
  - `@poopdeck.gl/react` now ships a stylesheet: `import "@poopdeck.gl/react/styles.css"` renders `PlaybackControls`/`HoverPreview` fully styled with no Tailwind in the host app — the file carries the compiled utility classes (no preflight, so it can't touch host styles) plus defaults for the theme tokens (`--accent`, `--surface`, `--ink-900/500/400`, `--hairline`, `--accent-soft`, `--page-bg`), all overridable from your own CSS. Tailwind v4 apps can instead register the package for scanning (`@source "../node_modules/@poopdeck.gl/react/src"`), now documented.
  - `usePlayback({ initialTime, timeRange })` honours `initialTime` — the mount-time range effect used to reset the playhead to the range start, making deep-linked `?t=` views impossible without a workaround. `initialTime` is clamped into the range and applies at mount only; a later `timeRange` change still resets to the new range start.
  - `<PlaybackControls {...pb} />` now spreads straight from the hook: the hook return echoes `timeRange` and exposes the speed under `currentSpeedMultiplier`, and the `targetPlaybackSeconds` prop is optional (default 60).
  - `@poopdeck.gl/layers` re-exports the governor-wiring callback parameter types (`SpatiotemporalTileset`, `BufferSource`, `BufferedRunway`) so `onTilesetReady`/`onBufferChange` handlers can be typed without depending on `@poopdeck.gl/core`/`playback` directly.

### Patch Changes

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
