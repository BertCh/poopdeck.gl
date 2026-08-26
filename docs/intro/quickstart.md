# Quickstart

An animated, streaming map of half a million earthquakes in about five
minutes — no
account, no tile server, and nothing to build. You point a layer at a hosted
dataset's `manifest.json`, give it a clock, and press play.

Every code sample below comes in **React** and **vanilla JS**. Pick one; the
choice follows you across the docs.

> Already have data you want to animate? Skip to
> [4. Use your own data](#4-use-your-own-data) — the render code is identical,
> only the URL changes.

## 1. Install

`@poopdeck.gl/*` packages peer-depend on deck.gl. They are **not** installed for
you, and a missing or out-of-range peer is the most common cause of a build
error or a silently blank map. Install the poopdeck package plus the peers in
one go:

<!--tabs-->

**React**

```bash
npm install @poopdeck.gl/layers @poopdeck.gl/react \
  @deck.gl/core@^9.3 @deck.gl/layers@^9.3 @deck.gl/geo-layers@^9.3 \
  @deck.gl/mesh-layers@^9.3 @deck.gl/aggregation-layers@^9.3 \
  @deck.gl/extensions@^9.3 @deck.gl/react@^9.3 \
  @luma.gl/core@^9.3 @luma.gl/engine@^9.3
```

**Vanilla JS**

```bash
npm install @poopdeck.gl/layers @poopdeck.gl/playback \
  @deck.gl/core@^9.3 @deck.gl/layers@^9.3 @deck.gl/geo-layers@^9.3 \
  @deck.gl/mesh-layers@^9.3 @deck.gl/aggregation-layers@^9.3 \
  @deck.gl/extensions@^9.3 \
  @luma.gl/core@^9.3 @luma.gl/engine@^9.3
```

<!--/tabs-->

Budget for about **1.2 MB / 350 KB gzipped** of JavaScript for a points-only
map, and ~1.26 MB / 363 KB with playback and the React transport bar. Most of
that is deck.gl, not this project. The tile decoder is a further ~477 KB and
loads as its own Web Worker chunk, off the critical path and off the main
thread.

Two rules that save an afternoon:

- **Pin the whole deck.gl + luma.gl graph to one 9.3.x minor.** Mixing
  `@deck.gl/core@9.3` with `@deck.gl/layers@9.2` breaks at runtime, not at
  install time.
- In a monorepo, install the deck.gl set in the **app** package — peers resolve
  from there, not from a shared library.

You do not need the `stt-*` CLIs to render an existing dataset. They are for
[building one](#4-use-your-own-data).

## 2. Put a dataset on screen

A dataset is a static directory behind a `manifest.json`. This one is public,
CORS-enabled, and serves HTTP range requests, so it works straight from
`localhost`:

```
https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json
```

> USGS global M4.0+ events, 2020-01-01 → 2024-12-30, zoom 0–10, 522,982
> features, 47 MB of packed tiles. The layer reads the manifest, then fetches
> only the tiles your viewport and time window actually need.

Two props do the work: `currentTime` (where the playhead is, in Unix ms) and
`timeWindow` (how much time is visible around it). **`currentTime` must fall
inside the dataset's time range or nothing draws** — the single most common
first-render mistake.

<!--tabs-->

**React**

```tsx
import DeckGL from '@deck.gl/react';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';

const DATA = 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json';
const DAY = 24 * 60 * 60 * 1000;

export default function App() {
  return (
    <DeckGL
      initialViewState={{ longitude: 0, latitude: 20, zoom: 1.2 }}
      controller
      style={{ position: 'fixed', inset: '0', background: '#0b0d12' }}
      layers={[
        new AnimatedPointLayer({
          id: 'quakes',
          data: DATA,
          currentTime: Date.parse('2024-01-01T00:00:00Z'), // inside the range
          timeWindow: 30 * DAY, // 30 days visible around the playhead
          radius: 'magnitude', // numeric column → per-feature radius
          radiusMinPixels: 2,
          radiusMaxPixels: 16,
          fillColor: [255, 140, 60, 220],
        }),
      ]}
    />
  );
}
```

**Vanilla JS**

```js
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';

const DATA = 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json';
const DAY = 24 * 60 * 60 * 1000;

new Deck({
  parent: document.getElementById('app'),
  initialViewState: { longitude: 0, latitude: 20, zoom: 1.2 },
  controller: true,
  style: { background: '#0b0d12' },
  layers: [
    new AnimatedPointLayer({
      id: 'quakes',
      data: DATA,
      currentTime: Date.parse('2024-01-01T00:00:00Z'), // inside the range
      timeWindow: 30 * DAY, // 30 days visible around the playhead
      radius: 'magnitude', // numeric column → per-feature radius
      radiusMinPixels: 2,
      radiusMaxPixels: 16,
      fillColor: [255, 140, 60, 220],
    }),
  ],
});
```

<!--/tabs-->

You should now see a month of global seismicity — the Ring of Fire, the
mid-Atlantic ridge — as a static frame. Nothing moves yet; that is next.

Any prop that takes a constant also takes a **column name**, resolved on the
GPU: `radius: 'magnitude'` above sizes each quake by its magnitude, and
`fillColor: 'mag_band'` would color it by the archive's magnitude-band category
(add `colorMapping` to choose the colors per category). See
[AnimatedPointLayer](../api/animated-point-layer.md) for the full prop set.

### Which columns does a dataset have?

`onMetadataLoad` fires once, as soon as the manifest lands and before any tile
is fetched. `meta.layers[].properties` is the dataset's column inventory:

```ts
new AnimatedPointLayer({
  // …
  onMetadataLoad: (meta) => console.table(meta.layers[0].properties),
});
```

For the earthquakes archive above that prints `magnitude` and `depth` as
numbers and `mag_band`, `place`, `title`, `type` as strings — every name you
can hand to `radius`, `fillColor`, `elevationProperty` and friends. `meta` also
carries the dataset's `timeRange`, `bounds`, zoom range and temporal bucket, so
you can drive the whole setup off the archive instead of hard-coding it.

### Want an actual basemap?

Earthquakes draw their own coastline, so the samples here render on a flat dark
background. For anything else, a raster basemap is four lines of pure deck.gl —
no map library, no token:

```ts
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';

new TileLayer({
  id: 'basemap',
  data: 'https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
  maxZoom: 18,
  tileSize: 256,
  // `data: undefined` matters — without it BitmapLayer inherits the tile's
  // `data` from the spread props and throws "count(): argument not a container".
  renderSubLayers: (props) =>
    new BitmapLayer(props, {
      data: undefined,
      image: props.data,
      bounds: [
        props.tile.boundingBox[0][0],
        props.tile.boundingBox[0][1],
        props.tile.boundingBox[1][0],
        props.tile.boundingBox[1][1],
      ],
    } as any),
});
```

Put it FIRST in `layers` so the data draws on top. If you would rather use
MapLibre or Mapbox as the basemap, the archives also render through
[MapLibre custom layers](../api/stt-maplibre.md) directly.

## 3. Make it play

Time advances on a clock the layers read directly, so the playhead runs at
frame rate without re-rendering your app 60 times a second. A buffering
governor sits in front of that clock and refuses to start playing until there
is enough loaded data ahead of the playhead — the same contract as a video
player, which is why the API is shaped like one.

<!--tabs-->

**React**

```tsx
import DeckGL from '@deck.gl/react';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import {
  usePlayback,
  useDeckClock,
  PlaybackControls,
} from '@poopdeck.gl/react';
import '@poopdeck.gl/react/styles.css';

const DATA = 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json';
const DAY = 24 * 60 * 60 * 1000;

// The archive's own span — manifest.json → metadata.time_range.
const TIME_RANGE = {
  start: Date.parse('2020-01-01T00:00:00Z'),
  end: Date.parse('2024-12-30T23:56:29Z'),
};

export default function App() {
  const playback = usePlayback({
    timeRange: TIME_RANGE,
    baseSpeed: (TIME_RANGE.end - TIME_RANGE.start) / 60_000, // 5 years in ~60 s
  });
  // Drives the clock from deck's own render loop and publishes it to layers.
  const deckClock = useDeckClock(playback.timeController, playback.isPlaying);

  const layers = [
    new AnimatedPointLayer({
      id: 'quakes',
      data: DATA,
      // No currentTime prop — the layer reads the shared clock from deckClock.
      timeWindow: 30 * DAY,
      radius: 'magnitude',
      radiusMinPixels: 2,
      radiusMaxPixels: 16,
      fillColor: [255, 140, 60, 220],
      // Let the governor gate playback on THIS layer's buffered runway.
      onTilesetReady: (tileset) =>
        playback.registry.registerSource('quakes', tileset, {
          required: true,
        }),
      onBufferChange: (runway) =>
        playback.registry.onBufferChange('quakes', runway),
    }),
  ];

  return (
    <>
      <DeckGL
        {...deckClock}
        initialViewState={{ longitude: 0, latitude: 20, zoom: 1.2 }}
        controller
        style={{ position: 'fixed', inset: '0', background: '#0b0d12' }}
        layers={layers}
      />
      {/* The deck canvas is fixed and full-viewport, so it paints OVER
          anything in normal flow: give the bar its own positioned box or the
          play button is not clickable. `data-stt-theme="dark"` swaps the bar's
          eight theme tokens for the dark set, which is what you want floating
          over the near-black map above. */}
      <div
        data-stt-theme="dark"
        style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 1 }}
      >
        <PlaybackControls {...playback} />
      </div>
    </>
  );
}
```

`PlaybackControls` is the full transport bar — scrubber with a buffered bar,
play/pause, loop, speed presets and Auto. `usePlayback`'s return spreads
straight into it.

Two things about placing it, both visible in the snippet above:

- **Give it a positioned box.** A full-viewport `position: fixed` canvas paints
  over every later sibling in normal flow, so the bar renders but the play
  button cannot be clicked — the canvas is the hit target and the map pans
  under your cursor.
- **Tell it which palette to use.** The bar ships light and dark token sets and
  follows `prefers-color-scheme` by default. A dark map inside an otherwise
  light page is exactly the case that needs `data-stt-theme="dark"` pinned on
  an ancestor. See [theming](../api/stt-react.md#light-and-dark) for the token
  list if you want your own colors.

**Vanilla JS**

```js
import { Deck } from '@deck.gl/core';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import { SttPlayer } from '@poopdeck.gl/playback';

const DATA = 'https://tiles.poopdeck.gl/data/earthquakes-v2/manifest.json';
const DAY = 24 * 60 * 60 * 1000;

// The archive's own span — manifest.json → metadata.time_range.
const TIME_RANGE = {
  start: Date.parse('2020-01-01T00:00:00Z'),
  end: Date.parse('2024-12-30T23:56:29Z'),
};

const player = new SttPlayer({
  timeRange: TIME_RANGE,
  baseRate: (TIME_RANGE.end - TIME_RANGE.start) / 60_000, // 5 years in ~60 s
  loop: true,
});

new Deck({
  parent: document.getElementById('app'),
  initialViewState: { longitude: 0, latitude: 20, zoom: 1.2 },
  controller: true,
  style: { background: '#0b0d12' },
  layers: [
    new AnimatedPointLayer({
      id: 'quakes',
      data: DATA,
      // The layer reads the clock and redraws itself as it ticks.
      timeController: player.timeController,
      timeWindow: 30 * DAY,
      radius: 'magnitude',
      radiusMinPixels: 2,
      radiusMaxPixels: 16,
      fillColor: [255, 140, 60, 220],
      // Let the governor gate playback on THIS layer's buffered runway.
      onTilesetReady: (tileset) => player.setSource(tileset),
      onBufferChange: (runway) => player.notifyBufferChange(runway),
    }),
  ],
});

player.play();
```

`SttPlayer` is shaped like an `HTMLMediaElement` — `play()`, `pause()`,
`currentTime`, `playbackRate`, `buffered`, and `'timeupdate'` / `'waiting'` /
`'ready'` events — so wiring your own transport bar is the same work as wiring
one for `<video>`:

```js
playButton.onclick = () => (player.paused ? player.play() : player.pause());
player.on('timeupdate', (t) => (slider.value = t)); // ~4 Hz, not 60
player.on('waiting', () => spinner.show());
player.on('ready', () => spinner.hide());
```

<!--/tabs-->

Press play and five years of earthquakes run in about a minute.

## 4. Use your own data

The render code above does not change — only the URL does. To produce a
`manifest.json` of your own, install the Rust CLIs:

```bash
cargo install spatiotemporal-tiles
```

That gives you `stt-build`, `stt-optimize`, `stt-validate`, `stt-bundle`, and
`stt-serve`. Then build an archive from GeoParquet (or plain Parquet with
`lon`/`lat` columns):

```bash
stt-build \
  --input input.parquet \
  --output public/tiles/my-dataset \
  --time-field timestamp \
  --time-format unix-ms \
  --auto \
  --name "My dataset"

stt-validate public/tiles/my-dataset
```

`--auto` analyzes the data first and picks a zoom range and temporal bucket to
fit it; any flag you pass explicitly still wins. The output is a directory —
`manifest.json` + `index/*.sttd` + `packs/*.sttp`.

Drop it under `public/` and point `data` at
`/tiles/my-dataset/manifest.json`. Any static host with range-request support
serves it, Vite's dev server included; no tile server is involved.

- Starting from a CSV, or a database? [From CSV to an Animated
  Map](../guides/csv-quickstart.md) covers the DuckDB bridge, timestamp
  formats and the type gotchas.
- Building from Python? [GeoPandas / DuckDB /
  pyarrow](../guides/python.md).
- Ready to publish? [Deploying a Dataset](../guides/deploying.md) and [Tuning
  Your Tiles](../guides/tuning-tiles.md).

## Troubleshooting

- **Map came up blank.** Two suspects account for most first renders: a
  `currentTime` outside the dataset's time range, and a deck.gl or luma.gl peer
  that resolved to a different 9.x minor — check with
  `npm ls @deck.gl/core @luma.gl/core`. For the full failure taxonomy, the
  [AI suite](../guides/ai-suite.md) ships a `debugging-blank-renders` skill that
  walks it with your dataset in hand.
- **The play button does nothing, and the map pans instead.** The transport bar
  is under the deck canvas. A full-viewport `position: fixed` canvas paints over
  every later sibling in normal flow — give the bar its own positioned box, as
  [step 3](#3-make-it-play) does.
- **The transport bar is unreadable on the map.** Pin the palette with
  `data-stt-theme="dark"` on any ancestor of `<PlaybackControls>`; see
  [theming](../api/stt-react.md#light-and-dark).
- **Blank page and `__exportAll is not a function` on a MULTI-ENTRY Vite 8
  build.** Known issue, and not one you can fix in your own source: rolldown
  (Vite 8's bundler) mis-handles a re-export barrel across several HTML entries,
  React never mounts, and the root element stays empty. Single-entry Vite 8 is
  fine, `React.lazy` routes are fine, and Vite 7 is fine — so the workarounds
  are to build one entry, or to pin `vite@^7` until it is fixed upstream.
- **A `[stt/time-filter]` precision warning.** It only fires now when the
  Float32 quantization step is actually large enough to move something you can
  see, which almost always means a `timeOffset` that does not match the tile
  data. It is no longer emitted for an ordinary wide `timeWindow`.

## Next steps

- **Other geometry.** Points are one of a family — paths, polygons, trips, OD
  flows, icons, columns, meshes, point clouds, and server-aggregated H3 /
  Quadbin summary tiers all ride the same chassis. See
  [SpatioTemporalLayer](../api/spatiotemporal-layer.md) and pick a layer from
  [choosing an approach](./choosing.md).
- **Not using deck.gl?** The same archives render through
  [Three.js / WebGPU](../api/stt-three.md),
  [MapLibre](../api/stt-maplibre.md), and [Cesium](../api/stt-cesium.md).
- **How it works.** [Core concepts](./concepts.md) explains space×time tiling,
  temporal LOD and the streaming render model; the [packed format
  spec](../spec/stt-packed-format.md) is the normative container.
