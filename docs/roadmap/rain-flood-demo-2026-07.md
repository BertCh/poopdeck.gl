# Rain → Flood 2019 — combined weather-drives-water demo

**Status:** built + wired locally (2026-07-07), uncommitted. Browser-verify of
the look is the user's call; R2 push of the new `rainfall-2019` archive is open.

## Concept

One demo, one continental daily clock, two public datasets stacked so the map
reads as cause → effect:

- **Rain (primary field).** NOAA CPC daily precipitation, contoured into filled
  isoband polygons — storm systems sweeping the country day by day.
- **Flood (overlay).** The National Water Model river discharge (the existing
  _Year-of-Flow_ archive, reused verbatim) painted on top as a flow-matrix
  network that brightens downstream in the rain's wake.

This **replaces the standalone March-2019 flood demo** (`nwm-rivers-flood-2019-03`),
whose "flood" role is now told at continental annual scale alongside the rain
that drives it. The standalone _Year-of-Flow_ demo (`nwm-rivers-2019`) stays.

## Data

| layer  | source                              | access                                                                                                                                 | resolution                                |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| rain   | NOAA CMORPH CDR hourly precip       | anonymous NCEI, `ncei.noaa.gov/data/cmorph-high-resolution-global-precipitation-estimates/access/hourly/0.25deg/` (1 netCDF/hr, mm/hr) | 0.25° global→CONUS, **6-hourly** (summed) |
| rivers | NWM v3.0 retrospective on NHDPlusV2 | reuses `nwm-rivers-2019` archive                                                                                                       | order-4+ reaches, daily                   |

Both are US public domain, both over full 2019 CONUS. Each archive carries its
OWN baked temporal bucket (rain 6-hourly, rivers daily) — the flow-matrix bucket
size lives in the manifest (`packages/core/src/archive.ts`), so the two cadences
coexist on one clock and a single scrub drives both, re-fetching no geometry.

### Temporal resolution

Started daily (CPC US Unified gauge precip, `precip_isobands.py`, 365 frames,
~44 MB). Bumped to **6-hourly** per user: CPC is daily by source, so the finer
cadence required switching to **CMORPH hourly** (the reachable-anonymous finer
product) and summing every six hours → 1,460 frames. Hourly (8,760 frames) was
rejected as a firehose at year scale. `precip_isobands.py` (daily/CPC) is kept
as the lighter alternative.

## Rainfall pipeline (`scripts/data-generation/cmorph_isobands.py`)

Deliberately **light** — isobands, not grid cells:

1. Resumable parallel fetch of CMORPH hourly netCDFs → `data/cmorph/<Y>/<M>/<D>/`
   (skips files already on disk). `cmorph` is a rate in mm/hr.
2. Per 00/06/12/18 UTC window: clip to CONUS, sum 6 hourly grids (mm/6h), fold
   lon 0–360 → −180..180.
3. `contourpy` filled contours at **1 / 2 / 5 / 10 / 25 / 50 mm** bands (tuned
   down from the daily bands for a quarter-day of rain). Bands are annular
   (non-overlapping), so per-band alpha composites cleanly.
4. Simplify (Douglas–Peucker ~3 km), drop slivers, fix invalid rings.
5. Emit WKB GeoParquet: `geometry`, `timestamp` (window start ms),
   `end_timestamp` (+6 h), `precip_band` — a **non-numeric RANGE label**
   (`"1-2"` … `"50+"`) so stt-build keeps it categorical (the `dbz_band`
   rule; a bare integer would be promoted to Numeric and defeat the per-band
   `colorMapping`).

Build (fetch is ~8,760 small files, ~1.5 GB cached, resumable):

```
python scripts/data-generation/cmorph_isobands.py \
  --year 2019 --out data/cmorph/rainfall-2019-6h.parquet
stt-build --input data/cmorph/rainfall-2019-6h.parquet \
  --output examples/showcase/public/data/rainfall-2019 \
  --time-field timestamp --time-format unix-ms --end-time-field end_timestamp \
  --min-zoom 0 --max-zoom 6 --temporal-bucket 6h --publish \
  --quantize-coords 100 --quantize-attrs-auto
```

Archive z2–6 (0.25° grid has no detail past z6): **108,882 tiles, 229,514
polygons, ~189 MB** (1,460 six-hour frames; ~5.9× the daily build — 6-hour
windows resolve more distinct storm cells). Deps added to the data-gen venv:
`contourpy`.

## Rendering (`buildDemoLayers.ts`, `case 'polygon'`)

No new demo `type`. The `polygon` case now appends a **FlowCorridorLayer**
overlay when the dataset carries a `riversUrl` + `riversConfig` — mirroring how
`trips` appends `headsOverlayUrl` and `radar` appends its overlays:

- rain `AnimatedPolygonLayer` — primary, **required** governor source (the
  lighter stream gates the clock);
- rivers `FlowCorridorLayer` — **optional** governor source (heavy archive
  streams continue-and-degrade), shares the primary's `timeRange`/`timeWindow`.

New `Dataset` fields (`types.ts`): `riversUrl?`, `riversConfig?` (gradient +
width). `riversUrl` is rewritten through `resolveDataUrl` in `datasets.ts` for
R2. Rain fill = categorical `precip_band` (blue→violet→white); rivers =
self-scaled cyan→white so they read over the violet wash.

### Storyboard preload (⚠ min-zoom 0 is load-bearing)

The overview/storyboard preload tier (`preloadOverviewTier`, `spatiotemporal-
tileset.ts`) enumerates zooms `max(0, minZoom) … min(overviewMaxZoom=1, maxZoom)`
across the FULL time range and pins them so a scrub always renders via
parent-fallback. If the archive's `min_zoom > 1` that range is EMPTY → the tier
reports `no-tiles` and preloading silently does nothing. So the rain archive
MUST build with `--min-zoom 0`. For the composite the rain layer overrides the
default to `overviewPreload: { maxZoom: 0, budgetBytes: 64 MiB }` — pin only the
z0 tier (one whole-CONUS tile per 6-hour bucket = the ideal scrub thumbnail);
z1 would double the always-resident cost, and 1,460 buckets can exceed the
default 20 MiB budget, so it's raised. z0/z1 = 1,460 tiles each (CONUS fits one
tile at both). Measured (`stt-optimize inspect --sample 0`): **z0 = 30.37 MB**
(avg 20.8 KB/tile) — over the default 20 MiB (would be rejected) but under the
raised 64 MiB, so it pins; z0+z1 would be 60.7 MB, hence z0-only.

## Open

- Browser-verify the look (rain opacity vs river legibility; band thresholds).
- R2 push of `rainfall-2019` (r2-sync must carry the new stem); the rivers
  overlay reuses the already-(to-be)-published `nwm-rivers-2019` archive.
- Orphaned gitignored artifacts from the retired flood demo remain on disk
  (`public/data/nwm-rivers-flood-2019-03{,.parquet}`, `public/density/…json`) —
  safe to delete; kept pending user say-so.
- Consider adding `rain-flood-2019` to `SHIPPED_DATASET_IDS` if it should appear
  in the curated nav grid (currently deep-link-only, like its NWM siblings).
