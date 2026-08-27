# From CSV to an Animated Map

The fastest end-to-end path onto published packages: a CSV of timestamped
points → a packed STT dataset → an animated deck.gl map in a Vite + React
app. No tile server anywhere — the dataset is a static directory read over
HTTP range requests.

This guide was distilled from a real onboarding run (NOAA Marine Cadastre
AIS vessel positions); every step below is something that run needed.

## 1. Install the CLIs

```bash
cargo install spatiotemporal-tiles
```

That installs five binaries: `stt-build`, `stt-optimize`, `stt-validate`,
`stt-bundle`, and `stt-serve`.

## 2. CSV → GeoParquet (one DuckDB command)

`stt-build` reads GeoParquet (or plain Parquet with `lon`/`lat` columns).
For CSV input, DuckDB is the shortest bridge — it auto-detects the CSV
schema and writes Parquet in one statement:

```bash
duckdb -c "
  COPY (
    SELECT
      LON::DOUBLE                          AS lon,
      LAT::DOUBLE                          AS lat,
      epoch_ms(BaseDateTime::TIMESTAMPTZ)  AS timestamp,  -- int64 unix-ms (UTC)
      MMSI::BIGINT                         AS mmsi,
      TRY_CAST(SOG AS DOUBLE)              AS sog,
      VesselType::INTEGER                  AS class
    FROM read_csv_auto('input.csv', header=true, ignore_errors=true)
    WHERE lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90
  ) TO 'input.parquet' (FORMAT parquet);
"
```

Notes that save real time:

- **Timestamps:** `epoch_ms(...)` + `--time-format unix-ms` below is the
  most robust route. `--time-format` is read only for Int64 columns: a String
  column is always parsed as ISO 8601 (zone-less values like
  `2024-09-28T12:00:00` are read as UTC), and an Arrow Timestamp column is
  self-describing — so leaving the DuckDB column as `TIMESTAMPTZ` instead of
  `epoch_ms(...)` lets you drop the flag entirely.
- **Types come from the Parquet schema.** Cast each column to what you mean
  (`DOUBLE` for numbers you'll style by, `VARCHAR` for categories). Columns
  with nulls are fine — the tile schema follows the file's schema, not the
  values.
- Column names `lon`/`lat` (also `longitude`/`latitude`, `x`/`y`) are
  auto-detected as the geometry. A WKB `geometry` column (what
  `ogr2ogr -f Parquet` or GeoPandas writes) works too.

## 3. Build + validate the tiles

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

`--auto` runs the analyzer first and picks a zoom range and temporal bucket
to fit the data; any flag you pass explicitly still wins. (Bare `--auto` tunes
only those two — compression stays at the default, and the packed format is
zstd-only; set the level with `--zstd-level` or `--publish`, or use
`--auto encode` to let the advisor pick it.)

**Mind the zoom range** if you set it yourself: the default is `0–14`, and
dense point data at z14 can explode into 100k+ tiles and a long build. For
regional overview animation, something like `--min-zoom 3 --max-zoom 10
--temporal-bucket 1h` is plenty; deeper zooms only pay off when users will
actually zoom in that far. Add `--publish` for a deploy build (bumps zstd to
19 — smaller wire size, same decode cost).

The output is a directory: `manifest.json` + `index/*.sttd` + `packs/*.sttp`.

## 4. Serve it statically

Any static host with HTTP range support works — which is nearly all of them,
including Vite's dev server. Drop the directory under `public/` and the app
reads `/tiles/my-dataset/manifest.json` directly. For production, sync to
R2 / S3 / GCS / nginx ([deploying guide](./deploying.md)).

`stt-serve` exists for the _database_ workflow (tiles generated per-request
from PostGIS or DuckDB — the default install ships the PostGIS backend only,
and `cargo install spatiotemporal-tiles --features serve-duckdb` adds the
embedded-DuckDB one, a heavy bundled C++ compile); a prebuilt dataset never
needs it.

## 5. Render it

```bash
npm install deck.gl @deck.gl/react @poopdeck.gl/layers @poopdeck.gl/react
```

```tsx
import DeckGL from '@deck.gl/react';
import { TileLayer } from '@deck.gl/geo-layers';
import { BitmapLayer } from '@deck.gl/layers';
import { AnimatedPointLayer } from '@poopdeck.gl/layers';
import {
  usePlayback,
  useDeckClock,
  PlaybackControls,
} from '@poopdeck.gl/react';
import '@poopdeck.gl/react/styles.css';

const TIME_RANGE = {
  start: Date.parse('2022-09-26'),
  end: Date.parse('2022-10-01'),
};

export default function App() {
  const pb = usePlayback({
    timeRange: TIME_RANGE,
    baseSpeed: (TIME_RANGE.end - TIME_RANGE.start) / 120, // full range in ~2 min at 1×
  });
  const deckClock = useDeckClock(pb.timeController, pb.isPlaying);

  const layers = [
    // Raster basemap in pure deck.gl (no map library). The explicit
    // `data: undefined` matters: without it BitmapLayer inherits the tile's
    // `data` from the spread props and throws
    // "count(): argument not a container".
    new TileLayer({
      id: 'basemap',
      data: 'https://a.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png',
      maxZoom: 18,
      tileSize: 256,
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
    }),

    // The animated data — reads the packed dataset over range requests.
    new AnimatedPointLayer({
      id: 'points',
      data: '/tiles/my-dataset/manifest.json',
      currentTime: pb.currentTime,
      timeController: pb.timeController,
      timeRange: TIME_RANGE,
      timeWindow: 20 * 60 * 1000, // show ±20 min around the playhead
      radius: 2,
      radiusUnits: 'pixels',
      // Gate the clock on buffered data so playback never outruns loading:
      onTilesetReady: (ts) =>
        pb.registry.registerSource('points', ts, { required: true }),
      onBufferChange: (runway) => pb.registry.onBufferChange('points', runway),
    }),
  ];

  return (
    <>
      <DeckGL
        {...deckClock}
        initialViewState={{ longitude: -82.8, latitude: 26.7, zoom: 7 }}
        controller
        layers={layers}
        style={{ position: 'absolute', width: '100%', height: '100%' }}
      />
      <div style={{ position: 'absolute', left: 16, right: 16, bottom: 16 }}>
        <PlaybackControls {...pb} />
      </div>
    </>
  );
}
```

Already using MapLibre GL? Skip the deck basemap and add the dataset as a
native MapLibre layer with
[`@poopdeck.gl/maplibre`](../api/stt-maplibre.md), or keep deck.gl on top of
your map via `@deck.gl/mapbox`'s `MapboxOverlay`.

## Where to go next

- Style by data: `getFillColor: "class"` + `colorMapping` on any layer
  ([AnimatedPointLayer reference](../api/animated-point-layer.md)).
- Trajectories instead of points: sort the Parquet by trip and build
  LineStrings — see [Building from Python](./python.md).
- Deploy with proper cache headers: [Deploying a Dataset](./deploying.md).
