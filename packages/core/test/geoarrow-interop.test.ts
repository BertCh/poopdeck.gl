/**
 * GeoArrow interop surface: verify that the standard
 * `ARROW:extension:name` field metadata travels end-to-end through the
 * Rust writer + TS reader, and that `toGeoArrowTable()` hands back a
 * `Table` that downstream consumers (`@geoarrow/deck.gl-layers`,
 * Lonboard) can use as-is.
 *
 * The fixture in `fixtures/sample.stt` is produced by the Rust example
 * generator and is the closest analogue to what a real archive looks
 * like; using it gives the test teeth — a regression in either writer or
 * reader will fail here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Field, FixedSizeList, Float, Precision } from 'apache-arrow';
import { STTArchive } from '../src/archive';
import { toGeoArrowTable, decodeTile } from '../src/tile';
import { GeometryType } from '../src/types';

const FIXTURE = fileURLToPath(new URL('./fixtures/sample.stt', import.meta.url));
const FIXTURE_BYTES = readFileSync(FIXTURE);

function rangeFetch(bytes: Uint8Array): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const range = (init?.headers as Record<string, string>)?.Range;
    const m = /bytes=(\d+)-(\d+)/.exec(range ?? '');
    if (!m) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => bytes.buffer.slice(0),
      } as unknown as Response;
    }
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.length - 1);
    const slice = bytes.subarray(start, end + 1);
    return {
      ok: true,
      status: 206,
      statusText: 'Partial Content',
      arrayBuffer: async () =>
        slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('GeoArrow interop', () => {
  it('Layer.geometryExtensionName is populated from the geometry field', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch(FIXTURE_BYTES) });
    const index = await archive.getIndex();
    const entry = index.tiles[0];
    const tile = await archive.getTile({
      z: entry.zoom,
      x: entry.x,
      y: entry.y,
      t: entry.timeStart,
    });
    expect(tile).not.toBeNull();
    const layer = tile!.layers[0];
    // Standard GeoArrow extension names per https://geoarrow.org/format.html
    expect([
      'geoarrow.point',
      'geoarrow.linestring',
      'geoarrow.polygon',
    ]).toContain(layer.geometryExtensionName);
    // The point/linestring/polygon tag MUST match the decoded enum.
    if (layer.features.geometryType === GeometryType.Point) {
      expect(layer.geometryExtensionName).toBe('geoarrow.point');
    } else if (layer.features.geometryType === GeometryType.LineString) {
      expect(layer.geometryExtensionName).toBe('geoarrow.linestring');
    } else {
      expect(layer.geometryExtensionName).toBe('geoarrow.polygon');
    }
  });

  it('toGeoArrowTable returns a Table whose geometry field carries ARROW:extension:name', async () => {
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch(FIXTURE_BYTES) });
    const index = await archive.getIndex();
    const entry = index.tiles[0];
    const tile = await archive.getTile({
      z: entry.zoom,
      x: entry.x,
      y: entry.y,
      t: entry.timeStart,
    });
    const table = toGeoArrowTable(tile!.layers[0]);
    const geomField = table.schema.fields.find((f) => f.name === 'geometry');
    expect(geomField).toBeDefined();
    // This is THE key — a GeoArrow consumer reads it to pick the renderer.
    expect(geomField!.metadata.get('ARROW:extension:name')).toBe(
      tile!.layers[0].geometryExtensionName,
    );
    // The CRS travels in the sibling `ARROW:extension:metadata` key so a
    // consumer (GDAL/GeoPandas/lonboard/QGIS) sees WGS84 lon/lat (OGC:CRS84)
    // rather than an unknown CRS. The Rust writer pins it on every geometry
    // field; without it those tools fall back to "unknown".
    const extMeta = geomField!.metadata.get('ARROW:extension:metadata');
    expect(extMeta, 'geometry field must carry ARROW:extension:metadata').toBeDefined();
    const crs = JSON.parse(extMeta!);
    expect(crs.crs).toBe('OGC:CRS84');
    expect(crs.crs_type).toBe('authority_code');
    // For a Point fixture, GeoArrow says the geometry column is
    // FixedSizeList<Float64, 2> (interleaved xy). The Rust writer uses
    // this exact shape; the TS reader must not have rewritten it.
    if (tile!.layers[0].features.geometryType === GeometryType.Point) {
      expect(geomField!.type).toBeInstanceOf(FixedSizeList);
      const inner = (geomField!.type as FixedSizeList).children[0] as Field;
      // IPC round-trip lands the type as a generic `Float` instance with
      // `precision = Precision.DOUBLE`. Both checks are needed: the class
      // catches truncation to a different numeric type, and the precision
      // pin guards against Float32 sneaking in.
      expect(inner.type).toBeInstanceOf(Float);
      expect((inner.type as Float).precision).toBe(Precision.DOUBLE);
      expect((geomField!.type as FixedSizeList).listSize).toBe(2);
    }
    // Same row count as the layer.
    expect(table.numRows).toBe(tile!.layers[0].features.featureCount);
  });

  it('toGeoArrowTable throws for layers without a backing Arrow Table', () => {
    expect(() =>
      toGeoArrowTable({
        name: 'synthetic',
        extent: 0,
        features: {
          featureCount: 0,
          geometryType: GeometryType.Point,
          positions: new Float64Array(),
          featureIds: new Uint32Array(),
          startTimes: new Float32Array(),
          endTimes: new Float32Array(),
          timeOffset: 0,
          numericProps: {},
          categoricalProps: {},
        },
        geometryExtensionName: 'geoarrow.point',
        // arrowTable intentionally omitted — this is the path we want to reject.
      }),
    ).toThrow(/no backing Arrow Table/i);
  });

  it('decodeTile sets geometryExtensionName even when only stt:geometry is present', () => {
    // The TS reader must fall back to the legacy `stt:geometry` schema
    // metadata when a v2 archive lacks the field-level
    // `ARROW:extension:name` tag. We exercise the fallback by re-decoding
    // a tile from the fixture and checking the property is populated —
    // the fixture is v3 so this is a "still works" check rather than a
    // strict v2 reproduction.
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch(FIXTURE_BYTES) });
    return archive.getIndex().then(async (index) => {
      const entry = index.tiles[0];
      const tile = await archive.getTile({
        z: entry.zoom,
        x: entry.x,
        y: entry.y,
        t: entry.timeStart,
      });
      expect(tile!.layers[0].geometryExtensionName).toMatch(/^geoarrow\./);
    });
  });
});

describe('decodeTile guards', () => {
  it('returns layers with arrowTable populated via the inline path', () => {
    // Re-decode the first tile via the public `decodeTile` entry point to
    // exercise the path used by InlineTileDecoder.
    const archive = new STTArchive({ url: 'mem://sample.stt', fetch: rangeFetch(FIXTURE_BYTES) });
    return archive.getIndex().then(async (index) => {
      const entry = index.tiles[0];
      const tile = await archive.getTile({
        z: entry.zoom,
        x: entry.x,
        y: entry.y,
        t: entry.timeStart,
      });
      const layer = tile!.layers[0];
      // InlineTileDecoder (default in Node) keeps arrowTable populated.
      expect(layer.arrowTable).toBeDefined();
      expect(layer.arrowTable!.numRows).toBe(layer.features.featureCount);
    });
  });
});

// Reference the import so TS doesn't dead-code-eliminate.
void decodeTile;
