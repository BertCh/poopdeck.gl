/**
 * Showcase-side fixes from the tile-loading audit 2026-08, each pinned by the
 * finding it closes. The layer trees are built for real (`buildDemoLayers` in
 * node — deck layers construct without a GL context) so the assertions read
 * the props the loader will actually see, not a config object.
 *
 *   E6 / F6 — the scrubber hover preview gets its own tile-loading recipe
 *            (`PREVIEW_TILE_PROPS`) and differs from the live tree in EXACTLY
 *            those keys, on every chassis layer of every demo type.
 *   E4 / F7 — the GLM lightning overlays of the weather / storm4d composites
 *            pin `tier: 'raw'`; the standalone lightning demo keeps its tier.
 *   F2 / F11 — composites split the BYTE budget by archive count, never the
 *            tile count (3 KB tiles made the count split the wrong limiter).
 *   A2 / F1–F3 — the four demos whose shipped speed made the runway
 *            unsatisfiable now author speeds inside the loader's arithmetic
 *            (the measured gate lives in dataset-archive-reconcile (h); this
 *            pins the authored numbers so a stray edit is caught in CI too).
 */
import { describe, it, expect } from 'vitest';
import type { Layer } from '@deck.gl/core';
import { TimeController } from '@poopdeck.gl/playback';
import { buildDemoLayers } from '../src/components/demo/buildDemoLayers';
import {
  PREVIEW_TILE_PROPS,
  PREVIEW_TILE_PROP_KEYS,
  isTileChassisLayer,
  withPreviewTileProps,
} from '../src/components/demo/previewTileProps';
import {
  COMPOSITE_MIN_CACHE_BYTES,
  LAYER_DEFAULT_MAX_CACHE_BYTES,
  LAYER_DEFAULT_MAX_CACHE_SIZE,
  compositeCacheProps,
  perArchiveTileCap,
} from '../src/components/demo/compositeCacheBudget';
import { getDatasetById } from '../src/datasets';
import type { Dataset } from '../src/types';

function dataset(id: string): Dataset {
  const d = getDatasetById(id);
  if (!d) throw new Error(`dataset ${id} not registered`);
  return d;
}

/** The frozen clock the hover preview hands its layer tree. */
function frozenClock(d: Dataset): TimeController {
  return new TimeController({
    initialTime: d.timeRange.start,
    speed: 0,
    timeRange: d.timeRange,
  });
}

function build(d: Dataset, timeController: TimeController): Layer[] {
  return buildDemoLayers({
    dataset: d,
    timeController,
    useGlobe: d.useGlobe ?? false,
    timeHeightScale: 0,
    reducedMotion: false,
  }) as Layer[];
}

/** Own (user-supplied) prop keys whose values differ between two layers. */
function differingKeys(a: Layer, b: Layer): string[] {
  const keys = new Set([...Object.keys(a.props), ...Object.keys(b.props)]);
  const out: string[] = [];
  for (const k of keys) {
    if (
      (a.props as Record<string, unknown>)[k] !==
      (b.props as Record<string, unknown>)[k]
    )
      out.push(k);
  }
  return out.sort();
}

// One demo per layer family the preview can mount: a single-archive trips
// demo on the globe, a two-archive composite with a per-overlay override
// (`refinementStrategy: 'no-overlap'` on the heads layer), and the two
// composite families that carry the lightning overlay.
const PREVIEW_FIXTURES = [
  'satellites',
  'nyc-flow-and-riders',
  'severe-weather-2024',
  'storm-4d-greenfield',
];

describe('E6: hover preview tile-loading recipe', () => {
  for (const id of PREVIEW_FIXTURES) {
    it(`${id}: preview layers differ from live in exactly the preview keys`, () => {
      const d = dataset(id);
      const clock = frozenClock(d);
      // ONE build, then the preview recipe on top — so any key that differs
      // is the recipe's doing, not a fresh accessor/array identity per call.
      const live = build(d, clock);
      const preview = withPreviewTileProps(live);
      expect(preview.length).toBe(live.length);
      let chassis = 0;
      live.forEach((liveLayer, i) => {
        const previewLayer = preview[i];
        expect(previewLayer.id).toBe(liveLayer.id);
        if (!isTileChassisLayer(liveLayer)) {
          // Non-tile overlays are passed through by identity.
          expect(previewLayer).toBe(liveLayer);
          return;
        }
        chassis += 1;
        const diff = differingKeys(liveLayer, previewLayer);
        // Every differing key is a preview key…
        for (const k of diff) {
          expect(
            PREVIEW_TILE_PROP_KEYS,
            `${liveLayer.id}: ${k} changed`,
          ).toContain(k);
        }
        // …and every preview key holds the preview value (a composite override
        // that already matches, e.g. the heads overlay's 'no-overlap', simply
        // drops out of the diff).
        for (const k of PREVIEW_TILE_PROP_KEYS) {
          expect(
            (previewLayer.props as Record<string, unknown>)[k],
            `${liveLayer.id}: preview ${k}`,
          ).toBe(PREVIEW_TILE_PROPS[k]);
        }
        expect(
          diff.length,
          `${liveLayer.id}: preview must differ`,
        ).toBeGreaterThan(0);
        // The frozen controller, id and data ride through the clone untouched.
        expect(previewLayer.props.timeController).toBe(clock);
        expect(previewLayer.props.data).toBe(liveLayer.props.data);
      });
      expect(chassis, 'fixture mounts no tile chassis layer').toBeGreaterThan(
        0,
      );
    });
  }

  it('the preview recipe is bounded: no prefetch, no overview pin, a scratch cache, a sliver of the request slots', () => {
    expect(PREVIEW_TILE_PROPS.enablePrefetch).toBe(false);
    expect(PREVIEW_TILE_PROPS.overviewPreload).toBe(false);
    expect(PREVIEW_TILE_PROPS.refinementStrategy).toBe('no-overlap');
    expect(PREVIEW_TILE_PROPS.maxCacheSize).toBeLessThanOrEqual(200);
    expect(PREVIEW_TILE_PROPS.maxCacheByteSize).toBeLessThanOrEqual(
      128 * 2 ** 20,
    );
    expect(PREVIEW_TILE_PROPS.maxRequests).toBeLessThan(12);
  });
});

describe('E4 / F7: lightning overlays pin the raw tier', () => {
  for (const id of ['severe-weather-2024', 'storm-4d-greenfield']) {
    it(`${id}-lightning is tier 'raw' (no H3 summary cells at the z4 opening camera, no flip at z5)`, () => {
      const d = dataset(id);
      expect(d.lightningUrl, 'fixture lost its lightning overlay').toBeTruthy();
      const layers = build(d, frozenClock(d));
      const lightning = layers.find((l) => l.id === `${id}-lightning`);
      expect(lightning, 'lightning overlay not mounted').toBeTruthy();
      expect(lightning!.props.tier).toBe('raw');
    });
  }

  it('the standalone goes-glm-lightning demo keeps its own tier (summary by design)', () => {
    const d = dataset('goes-glm-lightning');
    const layers = build(d, frozenClock(d));
    const primary = layers.find((l) => isTileChassisLayer(l));
    expect(primary).toBeTruthy();
    // The registry leaves `tier` unset and the layer default is 'auto' — the
    // H3 summary tier at the opening camera is that demo's point.
    expect(d.tier).toBeUndefined();
    expect(primary!.props.tier).toBe('auto');
  });
});

describe('F2 / F11: composite cache split is by bytes, not tile count', () => {
  it('single-archive demos get no override; composites split bytes with a 512 MiB floor', () => {
    expect(compositeCacheProps(1)).toBeUndefined();
    expect(compositeCacheProps(0)).toBeUndefined();
    expect(compositeCacheProps(2)).toEqual({
      maxCacheByteSize: LAYER_DEFAULT_MAX_CACHE_BYTES / 2,
    });
    expect(compositeCacheProps(10)).toEqual({
      maxCacheByteSize: COMPOSITE_MIN_CACHE_BYTES,
    });
    // Never a tile-count key: that is the F2 starvation mechanism.
    expect(Object.keys(compositeCacheProps(3)!)).toEqual(['maxCacheByteSize']);
  });

  it('the per-archive tile cap is the layer default whatever the archive count', () => {
    for (const n of [1, 2, 3, 7, 10]) {
      expect(perArchiveTileCap(n)).toBe(LAYER_DEFAULT_MAX_CACHE_SIZE);
    }
    // rain-flood-2019 (N=2) planned 1,079 resident 3 KB tiles; the old split
    // `max(600, ⌊2000/2⌋)` = 1,000 starved it. mrms-precip (N=3): 696 vs 666.
    expect(perArchiveTileCap(2)).toBeGreaterThanOrEqual(1079);
    expect(perArchiveTileCap(3)).toBeGreaterThanOrEqual(696);
  });

  it('a built composite carries the byte split and NO per-archive tile cap', () => {
    const d = dataset('rain-flood-2019');
    const layers = build(d, frozenClock(d)).filter(isTileChassisLayer);
    expect(layers.length).toBeGreaterThan(1);
    for (const l of layers) {
      // Own props only — the layer default (2000) must be what applies.
      expect(
        Object.hasOwn(l.props, 'maxCacheSize'),
        `${l.id} sets maxCacheSize`,
      ).toBe(false);
      expect(l.props.maxCacheSize).toBe(LAYER_DEFAULT_MAX_CACHE_SIZE);
      expect(l.props.maxCacheByteSize).toBe(LAYER_DEFAULT_MAX_CACHE_BYTES / 2);
    }
  });
});

describe('A2 / F1–F3: authored speeds sit inside the loader arithmetic', () => {
  // `speed × 5 s` is the gate floor no shrink path may cut below
  // (prefetch-policy.ts:722-726); at the measured residency of each demo's
  // shipped camera these are the minimum targets that keep the planned
  // horizon under PREFETCH_CACHE_FRACTION × the 2,000-tile cap and the
  // steady-state link under 4 MB/s
  // (dataset-archive-reconcile (h) measures the real directory locally; this
  // pins the numbers so CI, which has no packed dirs, still guards them).
  const MIN_TARGET_S: Record<string, number> = {
    'nyc-taxi-paths': 900, // 36 z14 tiles / 60 s bucket; 60 s ⇒ 3,600 resident, 11.4 MB/s; 600 s still 1,188 (64-bucket cap binds)
    'rain-flood-2019': 300, // 11 z4 tiles / 2 h bucket; 120 s ⇒ 1,079 resident
    satellites: 180, // 1 new 1.26 MB z0 tile / 5 min bucket; 60 s ⇒ 6.0 MB/s steady
    'ocean-drifters': 300, // 2.2 / 3.9 / 6.0 MB/s by decade at 120 s
  };
  for (const [id, min] of Object.entries(MIN_TARGET_S)) {
    it(`${id}: targetPlaybackSeconds ≥ ${min}`, () => {
      expect(dataset(id).targetPlaybackSeconds).toBeGreaterThanOrEqual(min);
    });
  }
});
