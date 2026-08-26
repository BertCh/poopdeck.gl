---
'@poopdeck.gl/cesium': minor
'@poopdeck.gl/maplibre': minor
'@poopdeck.gl/three': minor
'@poopdeck.gl/core': minor
'@poopdeck.gl/layers': patch
---

**The three non-deck backends render every frozen `LayerKind`.** three, maplibre
and cesium each close the last of their gaps in one pass, and now cover all 23
kinds — two more than deck, which still has no `ego` layer and degrades
`isoLines` to `path`.

Before this, "alternate renderer" meant "the movement family, and then you go
back to deck". The gaps were not exotic: cesium had no polygon, no column and no
summary tiers; maplibre could not draw a `path`; three fell back to `point` for
anything heatmap-shaped. Every one of those was a demo that offered a renderer
toggle and then drew nothing recognisable.

### New layers

- **`@poopdeck.gl/cesium`** (+17): `STTPolygonLayer`, `STTColumnLayer`,
  `STTIconLayer`, `STTTextLayer`, `STTMeshLayer`, `STTBoundingBoxLayer`,
  `STTSurfelLayer`, `STTPointCloudLayer`, `STTHeatmapLayer`, `STTHexbinLayer`,
  `STTH3SummaryLayer`, `STTQuadbinSummaryLayer`, `STTFlowmapLayer`,
  `STTFlowCorridorLayer`, `STTFlowStrokeLayer`, `STTIsoLayer`, `STTEgoLayer`.
- **`@poopdeck.gl/maplibre`** (+8): `STTPathLayer`, `STTTextLayer`,
  `STTMeshLayer`, `STTBoundingBoxLayer`, `STTSurfelLayer`,
  `STTPointCloudLayer`, `STTIsoLayer`, `STTEgoLayer`.
- **`@poopdeck.gl/three`** (+6): `STTHeatmapLayer`, `STTHexbinLayer`,
  `STTTextLayer`, `STTMeshLayer`, `STTPointCloudLayer` (the new phong-lit one —
  see the separate breaking-rename entry), `STTFlowStrokeLayer`.

### Capabilities

`liveBundling`, `userExtensions` and `timeAsHeight` are now true on all four
backends; `cameraRoll` on all three non-deck ones (deck's `MapView` has no roll
axis). Two flags stay honestly false and are not gaps to close later:

- **cesium `gpuHeatmap`** — CesiumJS gives a primitive author no
  render-to-texture splat pipeline, so `STTHeatmapLayer` accumulates its density
  field on the CPU and uploads a raster. It renders the same image; it is not a
  GPU heatmap, and claiming the flag would be a lie a consumer could budget
  against.
- **three `interleavedBasemap`** — structural, not unbuilt. TSL compiles to the
  renderer's own node graph; there is no seam to hand a foreign GL context.

### `@poopdeck.gl/core` — `./edge-bundling`

KDEEB edge bundling (Hurter/Ersoy/Telea 2012; CUBu) is hoisted out of
`@poopdeck.gl/layers` into a new `@poopdeck.gl/core/edge-bundling` subpath, so
all four backends run **one** `bundleEdges` rather than four transcriptions of
the same splat → advect → resample → smooth → anneal schedule. A bundle is a
function of the edge SET alone — not the playhead, not the camera — which is
what makes sharing it correct rather than merely convenient. deck keeps its GPU
ping-pong (it already owns a luma `Device`, so the splat is free there) and
agrees with the shared kernel on the schedule and the constants.

`@poopdeck.gl/layers` re-exports the moved symbols from their old path, so
nothing breaks; the copies are gone.
