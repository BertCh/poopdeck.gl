# MapLibre/Mapbox native-backend parity campaign (2026-07-22)

**Status: RATIFIED, IN EXECUTION.** Waves run one at a time with the user in
the loop between them.

- **M0 + M1 — LANDED** (commit `3a56756`): host dispatch v3/v4/v5/v6 + mapbox,
  native globe via the injected prelude, per-`variantName` program cache, globe
  subdivision kit, styledata/context-loss hardening, `SharedTilesetSource`.
- **M2 — LANDED, uncommitted** (2026-07-23): all four time-filter modes, GPU
  DataFilter, metric sizing, the D10 elevation reconciliation (BREAKING —
  `STTPolygonLayer.altitudeScale` is now a dimensionless exaggeration, see the
  package CHANGELOG), id-FBO picking on point/line/polygon/trips, and the
  descriptor feature matrix. Package suite 516/516, `tsc` clean, dist rebuilt.
  **Open:** user browser verify (globe + the five kinds on a v5 host), and
  `packages/mcp/docs/api/stt-maplibre.md` still documents the pre-M0 backend
  (claims v5 unsupported / no picking / `altitudeScale` default `1e-7`) — the
  docs pass is Wave M5 item 5, so that page misinforms until then.
- **M3–M5 — not started.**

**Goal.** Make `@poopdeck.gl/maplibre` a first-class rendering backend: an app
with an existing MapLibre (or Mapbox) map should be able to drop STT layers in
as native custom layers and get the same feature surface the deck backend
gives — all relevant layer kinds, all four time-filter modes, DataFilter,
stable color mapping, motion glide, picking, governor-gated playback, and
(new) globe. Today the backend is a deliberate 5-of-23 subset pinned to
maplibre-gl v3/v4 with no globe, no wake/cumulative, no filtering, and
points-only picking.

**Posture reversal (ratify explicitly).** `docs/roadmap/renderer-architecture.md`
§1.2 declares "maplibre stays a declared 5-of-19 subset with typed fallbacks"
as an intentional decision, and §5.4 counts out the v5/globe port "until
actually attempted". This campaign reverses both. The deck backend remains the
flagship/richest path; the maplibre backend's value is *thinness* — native
custom layers with no deck/luma dependency for the (large) population of apps
that already have a maplibre map and will never adopt deck.

**Provenance.** Three-agent parallel survey (2026-07-22): (1) MapLibre/Mapbox
custom-layer API research from docs + source across maplibre v3.6.2 → v6.0.0
and mapbox-gl v3 main; (2) deck.gl 9.3.2 `@deck.gl/mapbox` + luma.gl 9.3.3
source study + ecosystem patterns (threebox, maplibre-three-plugin,
webgl-wind, WeatherLayers, maplibre-contour); (3) whole-repo backend audit
(descriptors, core kernels, maplibre/three/cesium backends, showcase wiring).
Key anchors cited inline; re-verify line numbers before editing.

---

## 1. Findings baseline

### 1.1 Platform facts (external, load-bearing)

- **MapLibre v6.0.0 released 2026-07-22** (today). Version matrix of
  custom-layer signatures:
  - v3/v4: `render(gl, matrix)` — mercator-0..1 MVP positional matrix
    (v4.6+ adds a third `{farZ, nearZ, fov, ...}` options arg).
  - v5: `render(gl, args: CustomRenderMethodInput)` — matrix param **removed**;
    args carry `farZ/nearZ/fov`, `defaultProjectionData` (`mainMatrix`,
    `tileMercatorCoords`, `clippingPlane`, `projectionTransition`,
    `fallbackMatrix`) and `shaderData` (`variantName`,
    `vertexShaderPrelude`, `define`).
  - v6: adds `args.getProjectionData({tileID, ...})` (per-tile matrices),
    f64-backed matrix types, ESM-only packaging, WebGL2 mandatory again.
- **Globe is handed to native custom layers almost for free on v5+**: inject
  `args.shaderData.vertexShaderPrelude` + `define` into the vertex shader and
  call `projectTile(vec2)` / `projectTileFor3D(vec2, elevMeters)`; cache one
  program per `shaderData.variantName`. This is precisely the port our own
  comment at `packages/maplibre/src/base-layer.ts:575-583` predicted. deck
  needed a whole GlobeView-matching campaign (9.1) for the same result.
- Globe correctness rules: long edges must be subdivided to
  `map.style.projection.subdivisionGranularity` (chords get horizon-clipped);
  skip `wrap !== 0` tiles on globe; `projectTile` **overwrites z** for horizon
  clipping — real 3D must use `projectTileFor3D`; poles use sentinel-Y or
  `maplibregl.createTileMesh(..., extendToNorth/SouthPole)`.
- Painter contract (both libs, verified in source): custom layers render in
  the **translucent pass** with blend preset to premultiplied
  `(ONE, ONE_MINUS_SRC_ALPHA)`, stencil disabled, depth =
  `renderingMode:'3d'` ? LEQUAL ReadWrite over `[0, ~0.998]` (shared with
  fill-extrusion/terrain) : constant-per-layer read-only slab (vertex z
  irrelevant for '2d'). After the layer returns the map calls
  `context.setDirty()` — **we never need to restore state**, but each custom
  layer costs the map a full lazy state re-apply per frame.
- `prerender` runs in the offscreen pass — the sanctioned place for FBO work
  (picking passes, particle sim, MSAA blit); must bind its own framebuffer.
- Lifecycle traps: `setStyle` diff **preserves** custom layers only when the
  diff succeeds; fallback rebuild destroys them silently → idempotent re-add
  on `style.load`/`styledata` is mandatory. MapLibre explicitly warns it
  "cannot restore custom layers after WebGL context loss" — we must
  invalidate/rebuild the tile GPU cache ourselves. `antialias` defaults to
  false → no MSAA for custom layers unless the app opts in.
- **Mapbox gl-js v3**: same painter heritage; still `render(gl, matrix,
  ...globeParams)` positional style; **no injected shader prelude** — globe
  requires hand-implementing ECEF from the passed params
  (`projectionToMercatorMatrix`, `transition`, `centerInMercator`,
  `pixelsPerMeterRatio`); `slot: 'bottom'|'middle'|'top'` ordering in the
  Standard style; custom layers rejected on all adapted projections
  (mercator + globe only); floor peer at **≥3.9.1** (queryRenderedFeatures
  crash with custom layers below that); terrain draping needs `renderToTile`
  + `shouldRerenderTiles` (animated layers would redrape every frame —
  unattractive); **proprietary license** — never vendor, token-gate any CI
  use, maplibre stays the default target.
- **Do not route through deck interleaved for this backend**: deck 9.3
  interleaved attaches luma to the shared context and **monkey-patches every
  GL state setter** (taxes the basemap's own calls), plus per-pass push/pop,
  plus the map's own per-custom-layer setDirty. Our hand-written layer pays
  only the last item. (deck's `MapboxLayerGroup` bucketing — N deck layers
  behind ≤ buckets custom layers — is still the right *grouping* idea.)
- MapLibre WebGPU: roadmap ("Graphics Modernization") is real but unshipped;
  the WebGL2 `CustomLayerInterface` remains the contract. Keying programs by
  `variantName` is the forward-compatible posture.

### 1.2 Parity gap (deck → maplibre), condensed from the audit

| Axis | deck | maplibre today |
| --- | --- | --- |
| Layer kinds | all 23 except isoLines(→path), ego | **5**: point, line, polygon, trips, heatmap |
| Time modes | window, wake, cumulative, trail | **window, trail only** |
| Picking | gpu-id, all kinds | id-FBO scaffold complete, **points only**, descriptor says `none` |
| DataFilter / timeHeightScale / pathReveal / motion-glide / iconWake | yes | **none** |
| colorMapping | keyed + GPU palette texture | keyed CPU (point/line/polygon) — roadmap concept-map stale |
| Globe / v5 / v6 | deck 9.1+ globe | **no** — peer pinned `^3 || ^4` (`base-layer.ts:575`) |
| metricSizing | yes | no (pixel sizing only) |
| Tileset ownership | shared | **per-layer archive** (N archives for N layers) |
| Governor | wired in showcase | **API exists** (`onTilesetReady`/`onBufferChange`) but showcase never wires it |
| Feature matrix in descriptor | `deckLayerFeatures` + (d) gate | **not declared** — gaps invisible to conformance |
| Elevation scale | correct | `DEFAULT_ALTITUDE_SCALE = 1e-7` ~4× too tall (`lib/projection.ts:59`) |

What is already *right* and must be preserved: CPU f64 pre-projection +
per-tile uint16 quantization (strongest precision pattern in the ecosystem
survey — matches maplibre's own Int16/EXTENT internals), `autoRepaint` →
`triggerRepaint` discipline, premultiplied-alpha-aware blending, VAO caching +
instanced draws, hard/soft fade via core `resolveTimeFilterParams`, and the
core-kernel reuse (`makeTilesetCallbacks`, `tessellateFeature`,
`expandCategoricalColors`, `encodePickId`, time-filter oracle).

### 1.3 Showcase reality

`MaplibreRenderer.tsx` mounts one layer per demo for 5 dataset types, wires no
governor (no `addSource`/`notifyBufferChange`), no picking, drops
`colorMapping`/`colorMappingDefault`, and its globe toggle reprojects only the
basemap (STT stays flat). Deck runs ~30 dataset types via `buildDemoLayers.ts`.

---

## 2. Campaign constraints (binding on every agent)

All constraints from the kind-parity campaign §2 apply verbatim (no thinning;
git safety; worktrees need committed HEAD; aesthetics user-verified in
browser; reduced motion; showcase consumes package dist — **rebuild
`packages/maplibre` dist after source edits**; defaultProps/undefined gotcha;
blob-ordering rule; conformance is part of done). Additions:

- **Descriptor honesty.** Never flip a capability
  (`globe`/`picking`/`metricSizing`/…) ahead of working evidence; the
  conformance gate checks class existence, not behavior — capability flips
  ride with tests that exercise the behavior.
- **Shader math is oracle-tested.** New GLSL (wake, cumulative, arcs, glide)
  is authored against `packages/core/src/render/time-filter.ts` +
  `shader-codegen.ts`'s `evalExpr` oracle with JS reference impls (the
  existing `time-window.glsl.ts` pattern). The full `emitGLSL100` codegen
  rewire stays counted-out (renderer-architecture §5.1) until a GPU CI runner
  exists — do not couple this campaign to it.
- **Mapbox hygiene.** No mapbox-gl code vendored or forked; mapbox test/e2e
  paths token-gated and skipped by default; maplibre is the documented and
  CI-tested target.
- **No freewheeling rAF.** All animation flows through
  `triggerRepaint`/`autoRepaint`; any particle/steady-motion work decouples
  sim tick from paint rate (webgl-wind / deck.gl-particle pattern).

---

## 3. Design decisions (D1–D12)

- **D1 — Stay native.** No deck/luma dependency in `@poopdeck.gl/maplibre`.
  Evidence: luma's shared-context state-tracker tax + map's setDirty +
  singleton machinery vs. our layer's near-zero overhead (§1.1). The deck
  backend already serves users who want deck.
- **D2 — Version strategy.** Runtime signature dispatch in `STTBaseLayer`:
  second render arg is matrix-like ⇒ ≤v4 path; `args.defaultProjectionData`
  ⇒ v5 path; `args.getProjectionData` ⇒ v6 extras. Widen peer to
  `^3 || ^4 || ^5 || ^6`. Development/showcase target **v5.24** now (v6 is
  0 days old; adopt v6 in showcase only after the ecosystem settles — the
  code path is already v6-ready via shape detection). ESM-only v6 affects
  packaging tests, not the layer contract.
- **D3 — Projection via injected prelude on v5+.** Vertex shaders switch from
  `uMatrix * sttDecodeMercatorPos(...)` to
  `projectTileWithElevation(sttDecodeMercatorPos(...), elev)` /
  `projectTileFor3D` with the map-supplied prelude + define prepended;
  program cache keyed by `shaderData.variantName`. Quantization stage is
  preserved unchanged (decode target stays mercator-0..1). The ≤v4/mapbox
  path keeps the current uMatrix shader as the `'legacy'` variant. This one
  change unlocks v5, v6, **and globe**.
- **D4 — Globe correctness kit.** A shared `lib/globe.ts`: subdivision of
  line/polygon geometry to projection granularity (build once per
  granularity, cached per tile), wrap-skip on globe, `projectTileFor3D` for
  extruded/3D content, transition handled by the prelude (no extra work).
  Heatmap (screen-space FBO passes) needs only its splat-position projection
  updated.
- **D5 — Mapbox = secondary target, mercator-first.** A thin host adapter
  (`lib/host-adapter.ts`) normalizes maplibre-≤v4 / maplibre-v5+ / mapbox-v3
  into one internal render input. Mapbox ships mercator + `slot` support,
  peer `>=3.9.1`, docs + example behind user-supplied token. Mapbox globe
  (hand-rolled ECEF from render params) is **deferred** — descriptor
  declares it honestly; mapbox users at globe zooms see the basemap's own
  globe→mercator transition cover most practical zooms. No `renderToTile`
  draping (animated redrape every frame is a lose). Ratify this scope.
- **D6 — Shared tileset + (later) layer-group host.** Refactor from
  per-layer archive to a shared `SpatiotemporalTileset` handed to N layers
  (template: `packages/three/src/scene/streaming-tile-source.ts`), giving one
  honest `BufferSource` per archive and fixing N-archive duplication +
  governor fairness distortion. Separately, a `STTLayerGroup` custom layer
  hosting multiple STT sublayers behind one map layer (deck
  `MapboxLayerGroup` precedent, bucketed by `beforeId`) cuts the
  per-custom-layer setDirty cost for composites — implemented in Wave M5,
  optional before then.
- **D7 — Hoist `track-kernel.ts` to core.** `packages/layers/src/lib/track-kernel.ts`
  is runtime-decoupled from deck except a type-only `Color` import; hoist to
  `@poopdeck.gl/core` (deck package re-exports for compat). Prerequisite for
  maplibre motion-glide (`motionInterpolation`) and tripHeads.
- **D8 — Wake + cumulative shaders** join `time-window.glsl.ts` with JS
  reference impls parity-tested against the core oracle; descriptor
  `timeFilterModes` extends to all four; `resolveTimeFilterParams` vocabulary
  already covers them.
- **D9 — Feature-matrix honesty.** Add `maplibreLayerFeatures` mirroring
  `deckLayerFeatures` vocabulary (motionInterpolation, iconWake, dataFilter,
  timeHeightScale, stableColorMapping, pathReveal) with a deck-style (d)
  conformance gate proving claims against real exported defaults/props. Start
  all-false-with-fallback (three's pattern), flip per-feature as waves land.
- **D10 — Elevation reconciliation.** Replace `DEFAULT_ALTITUDE_SCALE = 1e-7`
  with latitude-correct meters→mercator (`mercatorZfromAltitude(1, lat)`
  math via core `geo`), honoring the conformal-z contract ("a box with equal
  x/y/z mercator lengths renders as a cube"). Fixes the ~4×-too-tall
  extrusions before column/timeHeightScale parity builds on them.
- **D11 — Picking parity.** Implement `drawPickTile` on line, polygon, trips
  (+ every new kind as it lands); flip descriptor `pickMechanism`
  `none → 'id-fbo'` and `picking: true` when ≥ the deck-showcase-used kinds
  are pickable. Keep synchronous on-demand readback now; async PBO+fence
  readback is a later perf option. Terrain-pitched picking compensates via
  `queryTerrainElevation`.
- **D12 — Lifecycle hardening.** Idempotent re-add on `styledata` (deck's
  `resolveLayerGroups` idempotence as template); `webglcontextlost/restored`
  listeners invalidating `TileGpuCache` + programs; read `fov` from render
  args (v4.6+/v5+) instead of assuming 36.87° for any CPU matrix math
  (billboards, picking rays); document `antialias`/`canvasContextAttributes`
  guidance for embedders.

---

## 4. Parity scope tiers (ratify the cut line)

- **P0 — platform + existing-5 completion** (Waves M0–M2): v5/v6/globe,
  lifecycle, shared tileset, governor wiring, wake/cumulative, DataFilter,
  metricSizing, elevation fix, trail-semantics fixes (`trailFade` numeric,
  `trailLength<=0`), colorMapping completion, picking on all 5 kinds,
  feature matrix + gates.
- **P1 — new kinds, showcase-driven** (Wave M3): icon (atlas, heading,
  wake, glide), column (prism + timeHeightScale), arc (real 3D arc), 
  tripHeads (via D7), path upgrade (joins/dashes/pathReveal on the line
  layer family).
- **P2 — summary + flow families** (Wave M4): h3Summary, quadbinSummary,
  hexbin (real, not fallback), flowmap, flowCorridor, flowStroke.
  `liveBundling` (GPU KDEEB) explicitly **stays a declared fallback** —
  porting the bundler off luma transform-feedback is not worth it (ratify).
- **P3 — long tail, deliberate fallbacks OK** (negotiable): text (→icon),
  boundingBox, mesh, pointCloud, surfel/splat, isoLines (→path, same as
  deck), ego (unsupported, same as deck). Proposal: implement boundingBox +
  pointCloud (AV demos reach), keep text/mesh/surfel/splat as typed
  fallbacks. **Ratify which of P3 is in.**

"Parity" definition = every deck-supported kind/feature is either implemented
or a *deliberately declared, conformance-tested fallback* — the same standard
the three backend meets — with the P0–P2 set implemented for real.

---

## 5. Waves

Agent archetypes and workflow shapes per kind-parity campaign §3 (designer
panel / implementer / adversarial verifier / demo builder / integrator gate /
reviewer sweep).

### Wave M0 — quick wins + preconditions (small, sequential)
1. Commit current uncommitted tree (worktree precondition — big multi-session
   work in tree).
2. Showcase: wire governor into `MaplibreRenderer` (`getTileset()` →
   `governor.addSource`, `onBufferChange` → `notifyBufferChange`,
   `unregister` on teardown) — the layer API already supports it; forward
   `colorMapping`/`colorMappingDefault`; honor `overlayGatesPlayback`.
3. Fix stale renderer-architecture concept-map line (maplibre has keyed
   colorMapping) + record this campaign in the roadmap README register.
- **DoD:** maplibre demos gate playback like deck demos; suites green.

### Wave M1 — platform: v5/v6, globe, lifecycle, shared tileset
1. Host adapter + signature dispatch (D2, D5 skeleton); peer widen; showcase
   maplibre-gl 3.6 → 5.24.
2. Prelude-injection shader path + `variantName` program cache (D3); globe
   kit (D4); heatmap splat projection.
3. Lifecycle hardening (D12): styledata re-add, context-loss invalidation,
   fov plumb-through.
4. Shared-tileset refactor (D6a): `StreamingTileSource`-style wrapper in
   maplibre backend; N layers ↔ 1 archive; single BufferSource; per-layer
   ownership kept as compat path for single-layer embeds.
5. Descriptor: `globe: true`, `basemapProjection` stays `'mercator'` for ≤v4
   hosts — capability resolution becomes host-aware (`hostApiRange` idea from
   renderer-architecture §5.4 L506, now triggered).
- **DoD:** all existing 5 layers render correctly on maplibre v5 mercator
  AND globe (browser-verified by user), on v3/v4 via legacy path
  (unit-tested), styledata/context-loss survived in tests; conformance +
  full suites green; dist rebuilt.
- Workflow shape: design panel for the host adapter + prelude integration
  (the one genuinely open design), then implement pipeline with adversarial
  verify; integrator gate.

### Wave M2 — feature parity on the existing five kinds
1. Wake + cumulative GLSL + JS refs + oracle parity tests (D8); descriptor
   timeFilterModes → all four.
2. DataFilter (`filterProperty/filterRange/filterSoftRange/filterEnabled`)
   as a shared vertex-shader include across the 5 kinds.
3. metricSizing (meters-at-latitude sizing for point radius / line width);
   elevation fix (D10); trail semantics fixes.
4. Picking: `drawPickTile` for line/polygon/trips; descriptor flip (D11).
5. `maplibreLayerFeatures` matrix + (d) conformance gate (D9); flip
   dataFilter/stableColorMapping bits here.
- **DoD:** earthquakes (DataFilter slider), bixi (trips), polygon demos run
  on maplibre with feature parity vs deck side-by-side; suites + new gates
  green; user browser verify.

### Wave M3 — new kinds tier 1 (icon, column, arc, tripHeads, path)
1. D7 track-kernel hoist to core first (deck re-export; deck + three suites
   must stay green — this touches the flagship, adversarial verify).
2. Icon layer: rotated billboard atlas, heading, `iconWake`, glide via
   track-kernel, colorMapping, DataFilter, pick.
3. Column layer: instanced prisms, `timeHeightScale` (space-time cube),
   extrusion via fixed D10 scaling.
4. Arc layer: real great-arc strip (replace arc→line fallback).
5. TripHeads layer (CPU head interpolation via hoisted kernel).
6. Path upgrade: `revealTrail`/`revealDuration` + dash/joint quality pass on
   the line family (`pathReveal` bit flips).
- **DoD:** flights (icon glide), taxi (columns), OD arcs, trip-heads demos
  runnable on maplibre; descriptor kinds + features updated; suites green;
  user browser verify.

### Wave M4 — summary + flow families
1. h3Summary / quadbinSummary: instanced cell geometry (H3 boundary CPU-side
   via existing core/h3 usage), time-bucketed values, ramp/palette parity;
   hexbin real implementation.
2. flowCorridor + flowStroke (rain-flood/NWM parity — value-matrix texture
   or attribute stream, ref-stable data discipline per the perf root-cause
   memory), then flowmap (static bundles; liveBundling stays fallback).
- **DoD:** weather composite substrate layers, rain-flood, earthquakes-summary
  on maplibre; suites green; user browser verify.

### Wave M5 — mapbox target, layer-group host, polish
1. Mapbox v3 adapter (mercator + slot), token-gated example + docs; peer
   `>=3.9.1`; license-clean packaging.
2. `STTLayerGroup` composite host (D6b) + showcase composite wiring
   (weather/AV-substrate class demos on maplibre where kinds allow).
3. P3 decisions implemented (boundingBox/pointCloud if ratified in).
4. Golden-image correctness fixtures (Playwright: window clip, quantization
   decode, globe seam, DataFilter) — correctness only, aesthetics stay
   human-verified; mock-map lifecycle suite (deck's `mapbox-gl-mock` as
   template).
5. Docs: how-it-works §renderers update, README embed guide (maplibre-first,
   mapbox appendix), MCP `view_map`/docs surface mention of the maplibre
   embed path (follow-on hook, not a blocker).
6. Reviewer sweep (find → adversarial verify) over the whole campaign diff;
   fix confirmed findings; final descriptor truth pass.
- **DoD:** full-campaign review clean; all suites green; version-matrix unit
  tests (v3/v4/v5 sigs) green; user browser verify checkpoint list cleared.

---

## 6. Testing strategy

- **Unit/logic:** existing `mock-gl` + new mock-map (style._loaded,
  add/move/getLayer, triggerRepaint counter, styledata/contextlost emitters)
  for lifecycle, ordering, repaint gating, signature dispatch.
- **Shader math:** JS reference impl per GLSL module, parity-tested against
  core `time-filter.ts`/`evalExpr` oracle (existing pattern; extends to
  wake/cumulative/glide/arc).
- **Conformance:** descriptor gates (a)–(c) + new (d) feature-matrix gate;
  `assertDescriptorConsistent` stays the over-claim backstop.
- **Pixel correctness:** small Playwright golden suite, correctness fixtures
  only (no aesthetics), consistent with browser-verify tooling memory.
- **Version matrix:** signature-dispatch tests against recorded v3/v4/v5/v6
  render-arg shapes (no need to install four maplibre versions; shapes are
  data).
- **Mapbox:** unit-level with mocks only in CI; live token runs manual.

## 7. Risks & open questions (ratification checklist)

1. **Posture reversal** of renderer-architecture §1.2 — confirm parity is now
   the goal (this whole campaign).
2. **P3 cut line** (§4): boundingBox + pointCloud in, text/mesh/surfel/splat
   as fallbacks? liveBundling permanently fallback?
3. **Mapbox globe deferred** (D5) — acceptable? (Implementing ECEF from
   mapbox's params is a contained but real chunk if wanted later.)
4. **maplibre-gl v6 timing** — code supports it day one via dispatch; showcase
   stays on v5.24 until v6 ecosystem settles. OK?
5. **Track-kernel hoist** touches the deck flagship (type re-export only, but
   ratify the package move).
6. **Effort honesty:** M4 (flow/summary families) is the largest render-code
   wave — hand-written GLSL per family, non-unifiable per renderer-architecture
   §1.2's original rationale. If budget pressure appears, M4 can ship after
   M0–M3 independently; every wave is separately shippable.
7. **GPU-conformance CI still dead** — shader parity stays oracle/JS-ref-based;
   the §5.1 codegen rewire remains out of scope.
8. Uncommitted-tree precondition: M0.1 commit must land before any
   worktree fan-out.
