/**
 * /drive LIDAR render-mode switching (Points ⇄ Splat ⇄ Surfel ⇄ Iso ⇄ …).
 *
 * A mode pill swaps the ACTIVE dataset to a separately-built bundle of the SAME
 * drive, so every layer is re-ided (`<id>` → `<id>-surfel`). Two things follow,
 * and both were broken:
 *
 *   (1) PLAYBACK. The variants share the base's time range verbatim, so
 *       `usePlayback`'s range-change reset — the one path that clears the
 *       governor's source registry — correctly does NOT fire. deck finalizes
 *       the outgoing tilesets, but a finalized tileset keeps its coverage index
 *       while its tile registry is cleared, so it reports "runway 0, never
 *       complete" for the rest of the session; the gate is min(runway) over the
 *       REQUIRED set, so one stale entry holds the clock forever (measured on
 *       waymo-sf-day: 2 → 4 → 6 → 8 sources over three switches, the first one
 *       gating). `AvDeck` therefore unregisters the retiring scene's sources in
 *       an effect cleanup keyed on `dataset.id`, and `allSourceIds` is the
 *       inverse of what `buildDemoLayers` registers — pinned here so the two
 *       cannot drift.
 *
 *   (2) CHROME. A mode switch is not a scene switch: the cockpit must not blank
 *       its sidecars (which unmounted the stream rail, the density picker, the
 *       CAN gauges and the camera inset behind a full-screen "Loading scene…"
 *       card) and must not re-snap the camera to the scene framing (which threw
 *       away the user's pan / zoom / bearing). Both are pinned at the source
 *       level — the showcase test env is node with no DOM renderer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TimeController } from '@poopdeck.gl/playback';
import { buildDemoLayers } from '../src/components/demo/buildDemoLayers';
import { allSourceIds } from '../src/components/av/sourceIds';
import { datasets, getDatasetById } from '../src/datasets';
import type { AvDataset, Dataset } from '../src/types';

const avDatasets = datasets.filter(
  (d): d is AvDataset => d.type === 'av',
) as AvDataset[];

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const cockpit = read('../src/pages/AvCockpitImpl.tsx');
const avDeck = read('../src/components/av/AvDeck.tsx');

/** The `<base>` a render-variant id was derived from, or null if it IS a base. */
function baseIdOf(id: string): string | null {
  const m = id.match(/^(.*)-(splat|surfel|iso3d|iso|world|stage|scan|lod)$/);
  return m && getDatasetById(m[1])?.type === 'av' ? m[1] : null;
}

/** Every governor source id the built layer tree actually registers. */
function registeredSourceIds(d: Dataset): string[] {
  const seen: string[] = [];
  const layers = buildDemoLayers({
    dataset: d,
    timeController: new TimeController({
      initialTime: d.timeRange.start,
      speed: 1000,
      timeRange: d.timeRange,
    }),
    useGlobe: false,
    timeHeightScale: d.avCube ? 1e-5 : 0,
    plumbing: {
      registry: {
        registerSource: (id: string) => seen.push(id),
        unregisterSource: () => {},
        onBufferChange: () => {},
      },
    },
  }) as Array<{ props: Record<string, unknown> }>;
  // `onTilesetReady` is what calls into the registry; deck fires it once the
  // archive resolves, which is exactly what we simulate here.
  for (const l of layers) {
    (l.props.onTilesetReady as ((t: unknown) => void) | undefined)?.(
      {} as never,
    );
  }
  return seen;
}

describe('(1) AvDeck retires every governor source the scene registered', () => {
  it('allSourceIds covers what buildDemoLayers registers, for every AV scene', () => {
    expect(avDatasets.length).toBeGreaterThan(10); // the sweep is not empty
    for (const d of avDatasets) {
      const covered = new Set(allSourceIds(d.id));
      const registered = registeredSourceIds(d);
      // Every scene with a tiled stream registers at least one source.
      // (comma-280-1641 is the one exception in the fleet: camera + CAN + a GPS
      // ego polyline drawn from scene.json, no tile archive on the deck path.)
      if (d.avLidarUrl || d.avObjectsUrl || d.avMapPolyUrl || d.avDynamicUrl) {
        expect(registered.length, `${d.id} registers nothing`).toBeGreaterThan(
          0,
        );
      }
      for (const id of registered) {
        expect(
          covered.has(id),
          `${d.id}: layer tree registers "${id}", which the render-mode teardown would leak`,
        ).toBe(true);
      }
    }
  });

  it('covers the render-only Spacetime cube clone too (bare id, no -cube bundle)', () => {
    const base = getDatasetById('waymo-sf-day') as AvDataset;
    const cube = { ...base, avCube: true } as Dataset;
    const covered = new Set(allSourceIds(base.id));
    for (const id of registeredSourceIds(cube)) {
      expect(covered.has(id), `cube mode registers "${id}"`).toBe(true);
    }
  });

  it('is wired as a cleanup keyed on the RETIRING dataset id', () => {
    expect(avDeck).toMatch(
      /const retiringId = dataset\.id;[\s\S]{0,240}allSourceIds\(retiringId\)[\s\S]{0,80}unregisterSource/,
    );
  });
});

describe('(1b) the render variants share the base time range', () => {
  it('so usePlayback never resets the clock — and never clears the registry', () => {
    const variants = avDatasets.filter((d) => baseIdOf(d.id) !== null);
    expect(variants.length).toBeGreaterThan(10);
    for (const v of variants) {
      const base = getDatasetById(baseIdOf(v.id)!) as AvDataset;
      expect(
        v.timeRange,
        `${v.id} must span the same drive as ${base.id}`,
      ).toEqual(base.timeRange);
    }
  });
});

describe('(2) a mode switch is not a scene switch', () => {
  it('blanks the sidecars on the BASE scene only, never on the active dataset', () => {
    // The blanking effect keys on `baseId`; the fetch effect keys on the urls
    // and only ever REPLACES, so the chrome stays mounted across a mode switch.
    expect(cockpit).toMatch(/setScene\(null\);[\s\S]{0,160}\}, \[baseId\]\);/);
    expect(cockpit).toMatch(
      /\}, \[avSceneUrl, avTelemetryUrl, avCamerasUrl\]\);/,
    );
  });

  it('hands AvDeck a VALUE-stable sceneView so the camera is not re-snapped', () => {
    expect(cockpit).toMatch(
      /\[iv\?\.longitude, iv\?\.latitude, iv\?\.zoom, iv\?\.pitch, iv\?\.bearing\]/,
    );
    expect(cockpit).not.toMatch(/sceneView=\{scene\?\.initialView \?\? null\}/);
  });

  it('re-frames on the framing VALUES, not on a changed dataset id', () => {
    expect(avDeck).toMatch(/const framedKeyRef = useRef\(framingKey\)/);
    expect(avDeck).not.toMatch(/framedSceneIdRef/);
  });

  it('keeps visibleStreams off the whole searchParams object', () => {
    // A new URLSearchParams per query write gave the Set a fresh identity on
    // every unrelated toggle, rebuilding the entire layer tree each time.
    expect(cockpit).toMatch(/\}, \[presentStreams, streamsParam\]\);/);
  });
});

describe('(3) a density tier stays the PRIMARY archive', () => {
  it('buildDemoLayers demotes the LIDAR layer when url and avLidarUrl diverge', () => {
    const base = getDatasetById('waymo-sf-day') as AvDataset;
    const primaryOf = (d: Dataset) => {
      const layers = buildDemoLayers({
        dataset: d,
        timeController: new TimeController({
          initialTime: d.timeRange.start,
          speed: 1000,
          timeRange: d.timeRange,
        }),
        useGlobe: false,
        timeHeightScale: 0,
        plumbing: { overviewPreload: true, onOverviewPreload: () => {} },
      }) as Array<{ id: string; props: Record<string, unknown> }>;
      return layers.find((l) => l.id === d.id)!.props.overviewPreload;
    };
    const tier = `${base.avLidarUrl!.replace(/\/[^/]*\/manifest\.json$/, '')}/lidar-med/manifest.json`;
    // Swapping ONLY avLidarUrl (the old bug) loses the storyboard tier…
    expect(primaryOf({ ...base, avLidarUrl: tier })).toBe(false);
    // …moving `url` with it keeps the LIDAR stream primary.
    expect(primaryOf({ ...base, url: tier, avLidarUrl: tier })).toBe(true);
  });

  it('the cockpit moves both together', () => {
    expect(cockpit).toMatch(/url: lidarUrl,\s*\n\s*avLidarUrl: lidarUrl,/);
  });
});
