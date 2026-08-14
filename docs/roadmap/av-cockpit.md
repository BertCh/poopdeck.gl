# AV Telemetry Cockpit — shipped historical record

> **Status: SHIPPED** (committed `86bbb0f` … `17789f7`). The internal decision
> record for the `/drive` AV cockpit — build contract, two fidelity-refinement
> rounds, and the LiDAR tile-compression pass, all landed. Rationale + open
> follow-ups, not a forward plan. Live/canonical docs carry the normative detail:
>
> - Scene-bundle + sidecar format → [`../spec/sidecar-assets.md`](../spec/sidecar-assets.md)
> - Object cuboid layer → [`../api/animated-bounding-box-layer.md`](../api/animated-bounding-box-layer.md)
> - LiDAR point layer → [`../api/animated-point-layer.md`](../api/animated-point-layer.md)
> - Compression flags → [`../api/cli-reference.md`](../api/cli-reference.md) (`--quantize-attr`, `--quantize-attrs-auto`)

A poopdeck.gl visualization inspired by **avs.auto / streetscape.gl** (Aurora/Uber's XVIZ
viewer): real AV sensor logs — LIDAR, tracked-object 3D boxes, ego trajectory, CAN telemetry —
served as **spatiotemporal tiles** on a real basemap, with streetscape.gl-style cockpit
chrome (streams, timeline, gauges/charts, camera inset, inspector).

Shipped surface: `pages/AvCockpit.tsx` + `components/av/*` (showcase, `/drive/:sceneId?`),
`AnimatedBoundingBoxLayer` (packages/layers), and the `scripts/data-generation/*` adapters
(§1.4). Datasets live: synthetic + nuScenes v1.0-mini (10 scenes) + Argoverse 2 (6 cities)

- comma; Waymo is local-only (license). Render-mode / Three+TSL work that grew on top of
  this cockpit lives in [`renderer-architecture.md`](./renderer-architecture.md).

---

## 1. Build contract (shipped)

### 1.1 Why AV logs fit STT — georeferencing

AV ego poses live in a _local map frame_ (meters from a map origin), but the source maps
have **documented lat/lon origins**, so the whole scene georeferences onto a real basemap —
ego pose, object boxes, LIDAR returns → global map frame → lon/lat (comma.ai ships GPS directly).

nuScenes map **SW-corner** origins (byte-exact to the devkit `export_poses.py::REFERENCE_COORDINATES`):

| nuScenes map             | origin (lat, lon)                      |
| ------------------------ | -------------------------------------- |
| boston-seaport           | 42.336849169438615, -71.05785369873047 |
| singapore-onenorth       | 1.2882100868743724, 103.78475189208984 |
| singapore-hollandvillage | 1.2993652317780957, 103.78217697143555 |
| singapore-queenstown     | 1.2782562240223188, 103.76741409301758 |

**Georef conventions (the load-bearing gotchas):**

- **nuScenes coords are TRUE GROUND METERS in a local frame** anchored at the SW corner —
  NOT EPSG:3857 web-mercator meters. `av_common.local_to_lonlat(x, y, originLat, originLon)`
  is equirectangular about the origin (`lat = originLat + y/111320`,
  `lon = originLon + x/(111320·cos originLat)`) and matches the devkit's bearing+distance
  `derive_latlon` to ~5 m over a ~1 km scene. An earlier `mercator=True` mode (deflate by
  `1/cos(originLat)`) was a **misdiagnosis** — it shifted Boston ~450 m off-basemap and shrank
  scenes ~26%; it has been **removed**. The origins are approximate visualization anchors
  (nuScenes ships no GNSS ground truth).
- **Argoverse 2 city frames are UTM meters**, and the scene is ~6.9 km from the city origin, so
  equirectangular is ~75 m off. `av_common.utm_to_lonlat(E, N, epsg)` (pyproj) with the per-city
  UTM origins is used instead — e.g. PIT `EPSG:32617`, E0 583710.007, N0 4477259.9999 (MIA/ATX/
  DTW/PAO/WDC documented in `argoverse_extract.py`).

License: nuScenes & Argoverse 2 are **CC BY-NC-SA 4.0** (non-commercial; attribute the
source); comma.ai permissive; Waymo non-commercial + **no-redistribution** — the lesson:
Waymo bundles stay local-only, never pushed to R2. The cockpit renders attribution from `scene.json`.

### 1.2 The AV scene bundle

Every adapter emits the SAME bundle layout (lidar / ego / objects / map_poly / map_line
packed STT archives + telemetry.json + cameras.json + scene.json); streams are optional —
the cockpit shows only those present. Column schemas, sidecar JSON shapes, and the
manifest are formalized in [`../spec/sidecar-assets.md`](../spec/sidecar-assets.md), the
source of truth. Two conventions worth restating:

- `height_band` ships as a **string** label (e.g. `"0-2"`) — a bare numeric string would be
  promoted to Numeric and the categorical color map would no-op.
- Elevation ships as the numeric **`z` column** the spec table names, and the client lifts
  it into the position through the layer's `elevationProperty` / `elevationScale`. It is
  NOT folded into the geometry's 3rd coordinate. Between 2026-06 and 2026-07-27 the
  extractors passed `--point-elevation-column z`, which CONSUMES the column — so those
  bundles shipped with no `z` at all, silently off-spec, and a re-encoder that assumed the
  2-wide `xy` leaf destroyed 106 of them (see §3). Nothing enforces this at build time yet;
  the guard is the block comment in `av_common.run_stt_build`.

### 1.3 Frontend + layer

Showcase: `type:'av'` composite in `buildDemoLayers` (painter order map → lidar → ego →
objects; ego/objects/map ride the `overlayBase` no-governor pattern, LIDAR carries the
governor plumbing); route `/drive/:sceneId?`; chrome under `components/av/*`. Object
cuboids render via `AnimatedBoundingBoxLayer` (packages/layers) — API doc in the header.

### 1.4 Adapters (scripts/data-generation/)

`av_common.py` is the shared library (georef transforms, GeoParquet + sidecar writers,
`run_stt_build` helper, canonical category map); extractors `nuscenes_extract.py`,
`comma_extract.py`, `argoverse_extract.py`, `waymo_extract.py` (Perception v2.0.1 Parquet,
pure-numpy), and the no-deps `av_synthetic.py` bootstrap all emit byte-identical bundles.

---

## 2. Fidelity refinement — Round 1 + Round 2 (shipped)

Two rounds refined the cockpit to match/exceed the canonical viewers (streetscape.gl /
XVIZ, nuScenes & av2 devkits, Cabana/openpilot); both committed in HEAD. **Round 1
(code-only):** object labels + velocity arrows on `AnimatedBoundingBoxLayer`, telemetry
strip-charts, object inspector, ego footprint + predicted-path ribbon. **Round 2 (re-gen +
data):** the §1.1 georef corrections; the HD-map substrate (static `map_poly`/`map_line`
streams for nuScenes + AV2 — Waymo has no HD map and correctly excludes it); real AV2
velocity finite-differenced per `track_uuid` (replacing a hardcoded 0.0); richer CAN
channels (wheel speeds, gyro, yaw-rate, turn signals) the strip-charts auto-render.

### Object-class palette — canonical copy + provenance

The rendered palette is the **nuScenes `get_colormap()` projection** (RGBA, alpha ~235;
vehicles warm — car `[255,158,0]` — pedestrians blue, cyclists crimson; the full table
lives in `datasets.ts AV_OBJECT_COLORS`, guarded by the parity test below).

Provenance: the first cut invented an arbitrary palette (car = blue) that baked into
`scene.json.objectColors` (legend/inspector) while the boxes used a different `datasets.ts`
palette (car = orange) — a legend↔box mismatch; both were reconciled to the devkit
`color_map.py` projection above.

**Rule — three copies MUST stay in lockstep:** `av_common.OBJECT_COLORS` (→ `scene.json`,
Python side) ⇄ `datasets.ts AV_OBJECT_COLORS` (box render) ⇄ the map palette `AV_MAP_COLORS`.
Parity is guarded by `scripts/data-generation/test_av_palette_parity.py`. Map-layer RGBA
lives only on the TS side; Python keeps just the `MAP_LAYERS` key set — no dead Python color
copy to drift.

**Deliberate divergences (not bugs):** LIDAR is colored by **height band**, not the devkit's
default depth/distance (height reads better on a georeferenced 3D scene — ground vs façades).

---

## 3. LiDAR tile compression (shipped)

Waymo LIDAR was the size bottleneck. A measurement-driven pass cut a point's on-the-wire cost
~4.5× (whole `waymo-sf-day` bundle 3.84 GB → 633 MB, **6.07×**). The compression **flags are
documented in [`../api/cli-reference.md`](../api/cli-reference.md)**; kept here is the _why_.

**Measure first** — before porting the research's headline lever (uint16-RTC coordinate
quantization), we attributed a real z14 Waymo tile's bytes per column
(`crates/stt-core/examples/point_column_stats.rs`, per-column zstd):

```
z14 baseline, 20.0 B/pt:
  id          8.04 B/pt   40.2%   <- UInt64 hash of (time,lon,lat): incompressible
  z           7.58 B/pt   37.9%   <- raw Float64 elevation: barely compresses
  geometry    2.53 B/pt   12.7%   <- already i32-quantized (--quantize-coords)
  intensity   1.66 B/pt    8.3%   <- DEAD: nothing in the render path reads it
  height_band 0.12 B/pt    0.6%
  start/end   0.06 B/pt    0.2%   <- constant per 100ms frame -> ~free already
```

This **redirected the plan**: the cost was `id` and `z`, not `geometry` (already 2.5 B/pt), and
the expected "per-point time tax" was already free (zstd crushes the constant-per-frame times).

**What shipped** (all decode-free, inside the existing Arrow-columnar format):

1. **Sequential point ids** (`columnar.rs`) — a point is never split across tiles, so the
   incompressible u64 hash fallback becomes the per-tile row index (unique → picking works;
   monotonic → zstd crushes it; explicit source ids preserved). **8.04 → 1.07 B/pt.**
2. **Drop dead `intensity`** (`av_common.py write_lidar_points`) — decoded from Waymo but
   nothing reads it (cloud colors by `height_band`/`seg_class`/camera RGB). **−1.66 B/pt.**
3. **Numeric-attribute quantization** — `--quantize-attr name=prec` stores a named Float64
   as the smallest int leaf + a per-column affine (`stt:qa`); reader reconstructs `o + q·s`;
   Waymo opts `z` in at 0.05 m; deterministic min-offset keeps content-addressed dedup.
   **7.58 → 0.69 B/pt.**

**Born-optimized generation (default):** the same levers are now the generation pipeline's
default (`common.rs::run_stt_build_with_full_options`): coord quantization
(`DEFAULT_QUANTIZE_COORDS_M = 0.1`, world-grid so dedup survives) + `--quantize-attrs-auto`
(every Float64 scalar → range-adaptive UInt16, same type per column so schema never drifts)

- sequential ids, ON for every dataset; `STT_GEN_NO_QUANTIZE=1` opts out wholesale. Measured
  −28% on an OD-line double-build; win is dataset-shaped (large on geometry/numeric, modest on
  text-heavy). The slower fallback for the ~50 GB of already-built archives used to be a
  `reoptimize` example (decode → re-encode through the production encoder → re-pack). That
  example was DELETED on 2026-07-28: it walked point coordinates at a hardcoded 2-wide stride,
  so a 3D-folded `xyz` leaf was read at the wrong offset — it flattened and scrambled 106 AV
  archives before anyone noticed. Re-optimizing now means a from-source rebuild, full stop.
  Every variant that shipped elevation as a numeric COLUMN (`-surfel`, `-world`, `-stage`,
  `-iso`, `-iso3d`, all nuScenes, all Cosmos) came through the same sweep untouched — the
  measured case for the standing rule that depth is a renderer prop over a column, never
  baked into geometry.

⚠️ **How to verify a re-encode, cheaply.** `stt-validate` **passes on scrambled coordinates**
— it never checks coords-in-tile — so it is the wrong tool. The bbox from `stt-optimize export`
works but needs a decode. The cheap positive proof is the directory alone
(`stt-optimize inspect --sample 0`): in a correct single-scene AV archive the **z14 entry count
exactly equals its temporal-bucket count**, i.e. one z14 tile for the whole scene. Scrambled
coordinates cannot produce that — points thrown to ±180/±90 scatter z14 tiles across the planet
— so a single coarse tile is positive proof of spatial coherence, with no decode.

**Deferred levers (measured, declined — revisit only on a concrete trigger):**

- **uint16-RTC geometry** — would halve `geometry` (~1 B/pt) but a per-tile/node origin breaks
  cross-tile blob dedup (why `--quantize-coords` uses a world grid). Not worth it unless
  geometry becomes the dominant column.
- **Pyramid replication** — the cloud is re-tiled at every zoom with no thinning. Collapsing to
  one/two data zooms is the biggest remaining total-archive lever but changes LOD behaviour;
  partly attacked since by the scrub-LOD track
  ([playback-and-loading.md §7](./playback-and-loading.md#7-scrub-time-lod--a-motion-tier-that-no-application-enables)).
- **Additive octree + screen-space-error LOD** (Potree/COPC) — the "proper" fix, but a large
  architectural change to a 2D-mercator-keyed engine. Out of scope.
- **Browser point codecs** (Draco / G-PCC / range-image) — only Draco is WASM-portable and
  it isn't rate-distortion optimal; strong codecs decode 1–3 orders of magnitude too slowly
  for interactive playback. Quantization captured most of the win decode-free.

---

## 4. Remaining work

The republish and R2 sync halves of the shared ops gate landed on 2026-07-31, including the
rebuilt argoverse/waymo bundles. What is left for `/drive` is **in-browser verify** (the
re-linked route, and `AnimatedBoundingBoxLayer` boxes now actually rotating to heading and
scaling to dimensions where they were silently identity), tracked once as **L2** in the
[roadmap README](./README.md) rather than restated per-doc. The one structural defect this
doc owns is **K6** — the render-mode set declared in four-plus drifting places. The §3
deferred levers stay counted out unless their triggers fire.
