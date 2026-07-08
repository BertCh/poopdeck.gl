---
name: debugging-blank-renders
description: >-
  Diagnose a SpatioTemporal Tiles map that renders blank, empty, or shows nothing
  animating. Use when a user says their STT / SpatioTemporalLayer / deck.gl map is
  blank, tiles aren't showing, the summary/H3/Quadbin layer is empty, nothing moves
  during playback, or features render in the wrong place. Walks the known failure
  classes and drives validate_dataset / describe_dataset / dataset_report to find
  the cause.
license: MIT
metadata:
  version: "0.4.0"
---

# Debugging a blank STT render

A blank map is almost always one of a small set of causes. Work them in order —
most are diagnosable from the archive alone, before touching renderer code.

> **Reading the doc paths below.** Citations like `docs/api/spatiotemporal-layer.md`
> are repo-relative (`<path>` = the part after `docs/`). No repo on disk? Use the
> MCP `get_doc`/`search_docs` tools (or the `stt://docs/<path>` resource), or fetch
> `https://poopdeck.gl/llms/<path>` — full chain in **poopdeck-overview**. Every
> failure class below is inlined, so this checklist works with no doc reachable.

## 1. Is the time window excluding everything? (most common)

`SpatioTemporalLayer` only draws features whose time falls in
`[currentTime - timeWindow, currentTime + timeWindow]`.

- If `currentTime` is `0` (the default) but the data is in 2024, **nothing renders**.
  Set `currentTime` into the dataset's real range.
- Get the range: `describe_dataset` → `timeRange {start, end}` (or the
  `stt://datasets/<name>` resource). Set `currentTime` to `timeRange.start` and a
  `timeWindow` wide enough to include some data (default is 86,400,000 ms = 1 day).
- Nothing *moving* during playback → the `TimeController`/`currentTime` isn't being
  advanced, or the window is so wide everything shows at once. See the
  **adding-playback** skill.

## 2. Is the archive actually valid & decodable?

Run `validate_dataset` (MCP) or `stt-validate <dir> --json`. It checks content
addressing, per-tile CRC, the Arrow schema/column contract, and temporal-bound
tightness. A non-empty `errors[]` (exit 1) means the archive itself is broken —
fix the build, don't debug the renderer.

## 3. Summary (H3/Quadbin) layer empty or cells in the wrong place?

Known, real failure: an archive's summary tier carries a **sequential `id` column
instead of real H3/Quadbin cell indices** — the layer then renders cells at the
wrong positions or nothing at all. Symptoms: a summary demo that's blank while the
raw tier renders fine.

- Confirm the tier exists: `describe_dataset` → `summaryTier {scheme, ...}` and
  `hasSummaryTier: true`.
- If cells are misplaced, the summary cell ids are suspect. The repair is a
  centroid-reconstruction pass (see `crates/stt-build/examples/repair_summary_ids.rs`);
  rebuild the summary tier rather than shipping the defective archive.
- Also check you're asking for the right tier: `SpatioTemporalLayer`'s
  `tier: 'auto' | 'summary' | 'raw'` — forcing `'summary'` on an archive with no
  summary tier renders nothing.

## 4. Capabilities mismatch (reader can't understand the archive)

formatVersion-2 archives declare `capabilities` the reader must understand
(`coord-quant`, `attr-quant`, `elevation-fold`). If the client `@poopdeck.gl/core`
is older than the archive's capabilities, tiles silently fail to decode.

- `describe_dataset` → `capabilities` and `formatVersion`. Compare against the
  installed `@poopdeck.gl/core` version (it exports `KNOWN_MANIFEST_CAPABILITIES`).
  Upgrade the client, or rebuild without the newer lever.

## 5. Wrong `@@type` / layer for the geometry

A points archive rendered with a path/trips layer draws nothing. Check the geometry
kind (`describe_dataset` → `styleHints.layer_hint`, or the summary scheme) and pick
the matching layer — see the **wiring-deckgl-layers** skill, or let `view_map`
infer the `@@type`.

## 6. Data URL / fetch problems

- The `data` prop must resolve to a reachable `manifest.json` URL (an http(s) URL
  for most hosts; a bare filesystem path won't be fetched by a browser). For a
  hosted deployment, set `--public-base-url` on the MCP server so `view_map`'s URLs
  are correct.
- Auth-gated tiles need `loadOptions.fetch` (Bearer) — a 401/403 shows as blank tiles.

## Quick triage checklist

1. `describe_dataset <name>` → note `timeRange`, `formatVersion`, `capabilities`,
   `hasSummaryTier`, `styleHints.layer_hint`.
2. Set `currentTime` inside `timeRange`; widen `timeWindow`.
3. `validate_dataset <name>` → any `errors[]`? Fix the archive.
4. Match the layer `@@type` to the geometry; use `tier: 'raw'` to isolate.
5. Confirm the `data` URL is reachable.

Refs: `docs/api/spatiotemporal-layer.md`, `docs/spec/stt-packed-format.md`,
`docs/spec/time-model.md`, `docs/api/cli-reference.md` (stt-validate).
