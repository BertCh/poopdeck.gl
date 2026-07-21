# Geometry-kind & layer parity campaign (2026-07-21)

**Status: PLAN ONLY — nothing implemented.** Execution is designed for agent
teams/workflows run wave-by-wave, with the user in the loop between waves.

**Goal.** Make the "general tool" claim true: points, lines, polygons, and the
special animated layers should be _evenly_ supported across the whole pipeline
(build → format/runtime → render → demos → AI surface). Today investment is
demo-driven and lumpy: lines/trips are excellent, points very good, polygons
weakest end-to-end, and the special-layer shelf is bimodal (flow/AV families
deep; icon/hexagon/text/mesh/line/point-cloud shallow or orphaned).

**Provenance.** Four-agent parallel survey (2026-07-21) over `packages/layers`,
the Rust crates, `packages/{core,playback,three,mcp}`, and the showcase demo
registry. Key factual anchors are cited inline below; re-verify line numbers
before editing (tree moves fast).

---

## 1. Findings baseline (what we're fixing)

Maturity by kind:

| Kind           | Build (Rust)                                                                   | Runtime                | Render layers                              | Catalog demos |
| -------------- | ------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------ | ------------- |
| Points         | solid, thin                                                                    | strong (summary tiers) | richest (wake/cumulative/splat/filters)    | 7+            |
| Lines/trips    | deepest (antimeridian split, DP/VW + TD-TR simplify, vertex time/value/matrix) | uniform                | trips family = flagship; plain paths basic | 12+           |
| Polygons       | weakest (no antimeridian, no standard-path simplify)                           | uniform                | window on/off only; seam overdraw          | 2             |
| Special layers | n/a (render-side views)                                                        | n/a                    | flow + AV deep; 6+ orphans                 | bimodal       |

The seven gaps, ranked:

1. **Polygons under-served at every stage** — antimeridian single-tile fallback
   (`crates/stt-build/src/tiler.rs:79-81`, counter at `:832-837`, pinned test
   `:3027`); no per-zoom simplification on the standard clip path
   (`tiler.rs:918-922`; `stt-core` has an unused `simplify_polygon`); render
   layer lacks DataFilter/timeHeightScale/cumulative; tile-seam overdraw.
2. **Moving-marker gap** — no position interpolation in point/icon/point-cloud
   layers (entities pop, don't glide); wake exists only on
   `AnimatedPointLayer`. `AnimatedIconLayer` (the natural AIS/flights layer:
   heading rotation exists) has no interpolation, no wake, no stable
   `colorMapping`, single-icon atlas constraint, zero demos.
3. **Orphan layers** — zero catalog demos: icon, hexagon, text, mesh, line,
   point-cloud (dead `type:'point-cloud'` branch in `buildDemoLayers.ts`),
   path (catalog-excluded datasets only). Showcase hand-rolls the AV ego from
   raw `SimpleMeshLayer` (`examples/showcase/src/components/av/egoLayers.ts`)
   instead of `AnimatedMeshLayer`.
4. **No path reveal** — `AnimatedPathLayer` is whole-path on/off; no
   progressive draw for timeless lines despite trail machinery next door.
5. **Cross-layer prop asymmetry** — wake/cumulative/DataFilter/
   `timeHeightScale`/stable `colorMapping`/fade each exist in an arbitrary
   subset of layers (per-demo accretion, not chassis capability).
6. **AI surface reach** — `view_map` inference emits only 6 of 23 layer types
   (`packages/mcp/src/view-map.ts:85-129`); archives without `layer_hint`
   silently fall back to `AnimatedPointLayer` (`view-map.ts:105-128`) — which
   is the entire currently-shipped R2 fleet (new builds bake the hint by
   default; fleet not republished).
7. **Smaller generality edges** — optimizer cost/density modeling is
   centroid-based (approximate for lines/polygons, self-documented in
   `stt-optimize/src/analysis/density.rs:154-158`); summary tiers only ever
   _recommended_ for points (`advisors/budget.rs:122-128`); Multi\* collapse;
   native GeoArrow line/polygon rejected (`input.rs:1031-1044`); `timesSorted`
   partial decode declared, unimplemented.

---

## 2. Campaign constraints (binding on every agent)

- **No thinning.** Features are never dropped. Per-zoom geometric
  simplification (the lines `detail-zoom` lever) is the allowed density lever;
  the max-tiled-zoom tier stays lossless. Summary tiers stay opt-in.
- **Git safety.** No `git checkout -- .` / `reset --hard` / bulk reverts —
  ever. Targeted `git restore <file>` only. Lint = oxlint + oxfmt.
- **Worktrees need a committed HEAD.** Phase 0 commits the current uncommitted
  tree before any worktree-isolated fan-out; until then parallel agents must
  not mutate overlapping files in the main tree.
- **Aesthetics are user-verified in-browser.** Agents wire demos and stop; no
  Playwright screenshot loops to judge look. Every demo change ends in an
  explicit "user visual-verify" checkpoint.
- **Reduced motion.** Every new animated surface gates on `useReducedMotion()`.
- **Showcase consumes package dist.** After editing `packages/{layers,playback,core}`
  source, rebuild their dist or the showcase renders stale code.
- **defaultProps gotcha.** Explicitly-passed `undefined` shadows layer
  defaultProps — prop-plumbing sweeps must not spread optional props blindly.
- **Blob-ordering rule.** Any archive rebuild for a multi-cell playback demo
  uses `--blob-ordering time-major`, never `auto`.
- **Conformance is part of done.** New layer kinds/props update both backend
  descriptors (`packages/layers/src/backend-descriptor.ts`,
  `packages/three/src/backend-descriptor.ts`) and their conformance tests —
  either implement in three or declare a typed fallback deliberately.

---

## 3. The team: agent archetypes & workflow shapes

Recurring archetypes (instantiated per phase; counts are per-workflow):

- **Designer panel** — 3 independent designers with distinct angles
  (minimal-diff, correctness-first, prior-art/SOTA) → 2–3 judges → synthesis
  agent. Output lands as a design section in this doc. Used where the approach
  is genuinely open (A1 antimeridian polygons, B1 interpolation, polygon seam
  overdraw).
- **Implementer** — owns a named file cluster; worktree-isolated only when
  clusters overlap. Writes code + targeted tests together.
- **Adversarial verifier** — per change, prompted to _refute_ (wrong output,
  perf regression, gotcha violation); majority-refute kills the change back to
  the implementer.
- **Demo builder** — dataset recipe (per `stt-showcase-build-recipes` memory) +
  `datasets.ts`/`buildDemoLayers.ts`/`demoMeta.ts` wiring + reduced-motion
  gate; stops before aesthetics.
- **Integrator gate** (sequential, end of each wave) — `cargo test`, vitest
  across packages, oxlint/oxfmt, dist rebuild, conformance suites. A wave is
  not done until this gate is green.
- **Reviewer sweep** (end of each track) — multi-dimension find → adversarial
  verify (the canonical review workflow); confirmed findings are fixed before
  the track closes.

Standard workflow shapes: _design panel_ (judge pattern), _implement pipeline_
(`pipeline(items, implement → test → verify)` — no barriers between stages),
_review_ (find → dedup → adversarial verify), _integrate_ (sequential gate).

---

## 4. Tracks and phases

### Phase 0 — prerequisites (blocks all worktree fan-out)

- **P0.1 Commit the current tree** (AI-recommender campaign + 2026-07-18
  review fixes, all green). **User decision — agents must not commit
  unprompted.**
- **P0.2 Baseline snapshot** — record suite/lint status and per-demo archive
  inventory so regressions are attributable.

### Track A — Polygon parity (Rust + TS)

- **A1 Antimeridian polygon clipping.** Design panel first (candidate shapes:
  normalize-and-split at ±180° mirroring the polyline split at
  `clip.rs:817-844`; or clip in a lon-shifted frame and re-wrap). Then
  implement in `clip.rs`/`tiler.rs`, proptest + golden fixtures (Fiji,
  Chukotka, dateline-crossing storm cells), deliberately retire the pinned
  fallback contract test. **Gate:** `antimeridian_fallbacks == 0` on the test
  corpus; roundtrip/property tests green.
- **A2 Polygon per-zoom simplification** on the standard clip path — parity
  with lines' DP/VW + `simplify_max_zoom`; topology-preserving (rings valid,
  holes intact), max-zoom tier untouched (no-thinning). **Gate:** measured
  byte reduction on wildfires/rain-flood rebuilds; no visible loss at max
  zoom (user visual-verify).
- **A3 Render parity for `AnimatedPolygonLayer`** — add `DataFilterExtension`
  - `timeHeightScale`; design-spike the tile-seam overdraw (clip-edge flags
    from build vs render-side dedup — panel decides build/render split).
    Descriptors + conformance updated.
- **A4 Third polygon demo** (non-weather; candidates: OSM building footprints
  appearing over time, sea-ice extent) + docs. User visual-verify.

### Track B — Motion parity (TS chassis)

- **B1 Interpolation design spike.** Per-entity position interpolation for
  window-filtered point-family layers. The hard part is sample pairing
  (points are independent rows): load-time id-indexed pairing (generalize
  trip-heads' binary search), build-side baked next-sample offsets, or
  synthetic 2-vertex segments. Also decides whether it rides
  `TimeFilterExtension` or a sibling extension. Design panel; output recorded
  here before any implementation.
- **B2 Implement interpolation** for `AnimatedPointLayer` +
  `AnimatedIconLayer` (point-cloud if cheap). **Gate:** ship-traffic/flights
  glide; frame-time budget unchanged (measured, not eyeballed).
- **B3 Wake exposure sweep.** `TimeFilterExtension` already has
  window/trail/wake/cumulative modes; only the point layer wires wake. Expose
  wake on icon (+ point-cloud optional) with per-layer tail semantics.
- **B4 `AnimatedIconLayer` rebuild** — per-category icon atlas, stable
  `colorMapping`, wake + interpolation from B2/B3; switch ship-traffic or
  flights to icons (AIS `cog` heading exists). User visual-verify.
- **B5 Prop-parity sweep** against the target matrix (§5): DataFilter to
  column/arc/line/trips (+polygon via A3), `timeHeightScale` to
  polygon/column, stable `colorMapping` to icon/arc/line/column. One
  implementer per layer file; shared chassis-driver test harness extended
  once, first. Mind the defaultProps gotcha.

### Track C — Orphan adopt-or-cut

- **C1 Decision pass** (cheap, before any build-out): per orphan
  (hexagon, text, mesh, line, point-cloud, path, unused
  DataFilter/Collision showcase composition) an adopt-or-cut recommendation
  with evidence; **user ratifies the list** before C2+ runs. Icon is
  pre-decided (adopt, B4).
- **C2 Mesh adoption** — productize the showcase ego hand-roll onto
  `AnimatedMeshLayer` (first real consumer; `egoLayers.ts` becomes a thin
  config).
- **C3 Path reveal** — trail/progressive-draw mode for `AnimatedPathLayer`
  (reuse TimeFilterExtension trail mode + synthesized vertex times); promote
  `flight-paths` or `nyc-taxi-paths` into the catalog. Sequenced after B1
  (touches the same extension).
- **C4 Point-cloud** — wire the dead `type:'point-cloud'` branch to a real
  dataset (a lidar variant) or delete the branch and deprecate the export.
- **C5 (stretch)** — productize the space-time-cube overlay (DemoViewer
  lattice + now-plane) and `GroundedTile3DLayer` as package layers.

### Track D — AI surface reach

- **D1 Widen `view_map` inference** — use baked `layer_hint` + recommend
  `dominant_type`; extend `LAYER_HINT_TO_TYPE`; intent promotions to special
  layers (OD→arc, density→heatmap/summary, magnitude→column); never silently
  default to points when geometry is unknown (warn loudly or refuse).
  TS-only, independent of A/B — can run in Wave 1.
- **D2 Fleet republish with baked `layer_hint`** — folds into open-register
  item 1 (rollout/verify ops gate) together with the 5 weather archives and
  the polygon rebuilds from A2. User-run ops gate; blob-ordering rule
  applies.
- **D3 Docs/skills** — update `wiring-deckgl-layers` skill, llms.txt, MCP
  tests for every new mode/layer reachable.

### Track E — counted out (backlog with triggers)

- Optimizer clip-aware cost modeling for lines/polygons — trigger: A2 rebuild
  advice visibly wrong on polygon datasets.
- Summary-tier recommendation for line/polygon sources — trigger: demand.
- Native GeoArrow line/polygon ingestion — trigger: ecosystem/user demand.
- First-class Multi\* identity — trigger: picking/styling needs whole-multi
  identity.
- `timesSorted` partial decode — belongs to
  [space-time-lod-2026-07.md](./space-time-lod-2026-07.md); not duplicated
  here.

---

## 5. Target capability matrix (per-feature binary family)

`Y` = has it · `→Y` = campaign target · `O` = optional/stretch · `–` = n/a by
design. CPU-row family (bbox/mesh/text), summary family, and flow family keep
their own contracts and are out of this matrix.

| Layer       | window+fade | trail/reveal | wake    | cumulative | interp  | DataFilter | timeHeightScale | stable colorMapping |
| ----------- | ----------- | ------------ | ------- | ---------- | ------- | ---------- | --------------- | ------------------- |
| point       | Y           | –            | Y       | Y          | →Y (B2) | Y          | Y               | Y                   |
| path        | Y           | →Y (C3)      | –       | O          | –       | Y          | Y               | Y                   |
| polygon     | Y           | –            | –       | O          | –       | →Y (A3)    | →Y (A3)         | Y                   |
| arc         | Y           | –            | –       | –          | –       | →Y (B5)    | Y               | →Y (B5)             |
| line        | Y           | –            | –       | –          | –       | →Y (B5)    | Y               | →Y (B5)             |
| icon        | Y           | –            | →Y (B3) | –          | →Y (B2) | →Y (B5)    | Y               | →Y (B4)             |
| column      | Y           | –            | –       | –          | –       | →Y (B5)    | →O (B5)         | →Y (B5)             |
| point-cloud | Y           | –            | O       | –          | O       | O          | Y               | Y                   |
| trips       | (trailFade) | Y            | –       | O          | Y       | →Y (B5)    | Y               | Y                   |

The B5 sweep executes against this table; conformance tests pin the end state.

---

## 6. Sequencing (waves ≈ workflow sessions)

Dependencies: A1/A2 (Rust) ⊥ B/C/D (TS). B1 before B2/B3/B4 and before C3.
A3 after A1/A2 land (rebuilt fixtures). D2 last (wants A2's polygon rebuilds
so the fleet republishes once). C2/C4/C5 gated on C1 ratification.

- **Wave 1 — spikes + independents** (~12–15 agents): P0 (user commit) →
  design panels A1 + B1 in parallel; D1 implement; C1 decision pass.
  Checkpoint: user ratifies designs + adopt-or-cut list.
- **Wave 2 — parallel deep tracks** (~15–20 agents): Rust workflow (A1
  implement + A2) ∥ TS workflow (B2 + B3 + B4). Integrator gate each.
- **Wave 3 — convergence** (~15–20 agents): A3 + B5 matrix sweep + C2 + C3 +
  C4; A4 demo build. Integrator gate; user visual-verify batch (all changed
  demos in one browser pass).
- **Wave 4 — close-out** (~10–15 agents): per-track reviewer sweeps
  (find → adversarial verify → fix); D3 docs/skills; D2 republish decision
  with the user; roadmap/README + memory updates.

Rough scale: ~60–70 agents total across four sessions. Each wave ends with the
integrator gate green and a short state update appended to this doc, so any
later session (or workflow) can resume from the doc alone.

## 7. Definition of done

1. Polygon parity: no antimeridian fallbacks; per-zoom simplification on par
   with lines; A3 props shipped; ≥3 catalog polygon demos.
2. Motion parity: point/icon glide + wake; icon layer is the flagship vehicle
   layer with a catalog demo.
3. No orphan exports: every `@poopdeck.gl/layers` export has a catalog demo,
   an AV-cockpit surface, or was deliberately cut/deprecated in C1.
4. §5 matrix fully realized (`→Y` cells become `Y`) and pinned by tests.
5. `view_map` can reach every exported layer via hint/intent; unknown geometry
   is never silently points; fleet republished with baked hints.
6. All suites green (cargo, vitest, conformance), oxlint/oxfmt clean, user
   visual-verify completed per changed demo.
