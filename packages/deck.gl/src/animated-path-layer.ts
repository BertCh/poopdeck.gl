/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering.
 *
 * Operates in WINDOW MODE: each feature is shown (with optional fade) when
 * its `[startTime, endTime]` overlaps the current time window. Whole paths
 * render at once. For a "vehicle moving along the route" effect with a
 * trailing fade, use AnimatedTripsLayer instead.
 *
 * ARCHITECTURE (v3 - Per-tile binary sublayers):
 * - One PathLayer per (tile, layer) pair. No cross-tile consolidation.
 * - Each sublayer uses deck.gl's binary `data: { length, startIndices,
 *   attributes }` interface, with attribute typed arrays referenced
 *   directly from the tile's BinaryFeatures (zero-copy from the Arrow buffer).
 * - Per-tile `timeOffset` — each sublayer rebases time independently in its
 *   own TimeFilterExtension instance.
 * - `getTime` callback drives the window uniform per draw without layer
 *   recreation.
 *
 * Streaming is additive: a new tile creates one sublayer and one GPU upload.
 * Existing tiles' GPU buffers are untouched.
 */

import { PathLayer } from '@deck.gl/layers';
import type { Color, Layer, LayerContext } from '@deck.gl/core';
import { SpatioTemporalLayer, SpatioTemporalLayerProps } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
import type { Tile, Layer as TileLayer } from '@stt/core';

const DEBUG = false;

export interface AnimatedPathLayerProps extends SpatioTemporalLayerProps {
  widthScale?: number;
  widthUnits?: 'pixels' | 'meters';
  /** Path color - constant Color, or property name for categorical coloring */
  pathColor?: Color | string;
  /** Path width - constant number, or property name for per-feature width */
  pathWidth?: number | string;
  colorPalette?: Color[];
  fadeInDuration?: number;
  fadeOutDuration?: number;
}

const DEFAULT_PALETTE: Color[] = [
  [0, 150, 255, 255],
  [255, 127, 14, 255],
  [44, 160, 44, 255],
  [214, 39, 40, 255],
  [148, 103, 189, 255],
  [140, 86, 75, 255],
  [227, 119, 194, 255],
  [127, 127, 127, 255],
  [188, 189, 34, 255],
  [23, 190, 207, 255],
];

/** See AnimatedTripsLayer for the rationale; same cache shape, window-mode attrs. */
interface PreparedTile {
  tileKey: string;
  styleKey: string;
  data: {
    length: number;
    startIndices: Uint32Array;
    attributes: Record<string, { value: any; size: number; normalized?: boolean }>;
  };
  timeOffset: number;
  dims: number;
}

function makeTileKey(tile: Tile, layer: TileLayer): string {
  const { z, x, y, t } = tile.id;
  return `${z}/${x}/${y}/${t}:${layer.name}`;
}

function expandPaletteColors(
  indices: Uint16Array,
  categoryCount: number,
  palette: Color[],
): Uint8Array {
  const out = new Uint8Array(categoryCount * 4);
  for (let i = 0; i < categoryCount; i++) {
    const color = palette[indices[i] % palette.length];
    const o = i * 4;
    out[o] = color[0];
    out[o + 1] = color[1];
    out[o + 2] = color[2];
    out[o + 3] = color[3] ?? 255;
  }
  return out;
}

export class AnimatedPathLayer extends SpatioTemporalLayer<AnimatedPathLayerProps> {
  static layerName = 'AnimatedPathLayer';

  static defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    pathColor: { type: 'color', value: [0, 150, 255, 255] as Color },
    pathWidth: { type: 'number', value: 3 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
  };

  private preparedTileCache = new Map<string, PreparedTile>();
  /**
   * Per-tile sublayer-instance cache — see the matching field on
   * AnimatedTripsLayer for the rationale. Returning the SAME PathLayer
   * reference across renderLayers() calls lets deck.gl short-circuit prop
   * diff for unchanged tiles.
   */
  private sublayerCache = new Map<
    string,
    { layer: PathLayer; preparedKey: PreparedTile; layerPropsKey: string }
  >();
  private lastLayerPropsKey: string = '';
  private readonly timeFilterExtension = new TimeFilterExtension();
  private readonly boundGetTime: () => number = () => this.getCurrentTime();

  finalizeState(context: LayerContext): void {
    super.finalizeState(context);
    this.preparedTileCache.clear();
    this.sublayerCache.clear();
  }

  private computeLayerPropsKey(): string {
    return [
      this.props.widthScale,
      this.props.widthUnits,
      (this.props as any).widthMinPixels,
      (this.props as any).widthMaxPixels,
      (this.props as any).capRounded,
      (this.props as any).jointRounded,
      this.props.fadeInDuration,
      this.props.fadeOutDuration,
      this.props.opacity,
      this.props.visible,
      this.props.pickable,
      this.props.timeWindow,
      Array.isArray(this.props.pathColor)
        ? this.props.pathColor.join(',')
        : '',
      typeof this.props.pathWidth === 'number' ? this.props.pathWidth : 0,
    ].join('|');
  }

  renderLayers(): Layer[] {
    const { tiles } = this.state;
    if (!tiles || tiles.length === 0) return [];

    const live = new Set<string>();
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) live.add(makeTileKey(tile, tileLayer));
    }
    for (const key of this.preparedTileCache.keys()) {
      if (!live.has(key)) this.preparedTileCache.delete(key);
    }
    for (const key of this.sublayerCache.keys()) {
      if (!live.has(key)) this.sublayerCache.delete(key);
    }

    const layerPropsKey = this.computeLayerPropsKey();
    if (layerPropsKey !== this.lastLayerPropsKey) {
      this.lastLayerPropsKey = layerPropsKey;
      this.sublayerCache.clear();
    }

    const sublayers: Layer[] = [];
    for (const tile of tiles) {
      for (const tileLayer of tile.layers) {
        const prepared = this.prepareTile(tile, tileLayer);
        if (!prepared) continue;
        const cached = this.sublayerCache.get(prepared.tileKey);
        if (
          cached &&
          cached.preparedKey === prepared &&
          cached.layerPropsKey === layerPropsKey
        ) {
          sublayers.push(cached.layer);
          continue;
        }
        const layer = this.buildSublayer(prepared);
        this.sublayerCache.set(prepared.tileKey, {
          layer,
          preparedKey: prepared,
          layerPropsKey,
        });
        sublayers.push(layer);
      }
    }

    if (DEBUG) {
      // eslint-disable-next-line no-console
      console.log(`AnimatedPathLayer: ${tiles.length} tiles → ${sublayers.length} sublayers`);
    }
    return sublayers;
  }

  private prepareTile(tile: Tile, tileLayer: TileLayer): PreparedTile | null {
    const binary = tileLayer.features;
    if (binary.featureCount === 0 || !binary.startIndices) return null;

    const colorProp = typeof this.props.pathColor === 'string' ? this.props.pathColor : '';
    const widthProp = typeof this.props.pathWidth === 'string' ? this.props.pathWidth : '';
    const styleKey = `${colorProp}|${widthProp}|${
      colorProp ? (this.props.colorPalette ?? DEFAULT_PALETTE).length : 0
    }`;

    const tileKey = makeTileKey(tile, tileLayer);
    const cached = this.preparedTileCache.get(tileKey);
    if (cached && cached.styleKey === styleKey) return cached;

    const dims = binary.positionDimensions ?? 2;

    const attributes: PreparedTile['data']['attributes'] = {
      // Accessor-name key for PathLayer's own attribute.
      getPath: { value: binary.positions, size: dims },
      // Extension-registered attribute names: must match
      // TimeFilterExtension.initializeState exactly.
      instanceStartTime: { value: binary.startTimes, size: 1 },
      instanceEndTime: { value: binary.endTimes, size: 1 },
    };

    if (colorProp) {
      const cat = binary.categoricalProps[colorProp];
      if (cat) {
        const palette = this.props.colorPalette ?? DEFAULT_PALETTE;
        attributes.getColor = {
          value: expandPaletteColors(cat.indices, binary.featureCount, palette),
          size: 4,
          normalized: true,
        };
      }
    }

    if (widthProp) {
      const values = binary.numericProps[widthProp];
      if (values) {
        attributes.getWidth = { value: values, size: 1 };
      }
    }

    const prepared: PreparedTile = {
      tileKey,
      styleKey,
      data: {
        length: binary.featureCount,
        startIndices: binary.startIndices,
        attributes,
      },
      timeOffset: binary.timeOffset,
      dims,
    };
    this.preparedTileCache.set(tileKey, prepared);
    return prepared;
  }

  private buildSublayer(prepared: PreparedTile): PathLayer {
    const sublayerId = `${this.props.id}-${prepared.tileKey}`;

    const constColor = (Array.isArray(this.props.pathColor)
      ? this.props.pathColor
      : [0, 150, 255, 255]) as Color;
    const constWidth = typeof this.props.pathWidth === 'number' ? this.props.pathWidth : 2;
    const timeWindow = this.props.timeWindow || 86400000;

    return new PathLayer({
      id: sublayerId,
      data: prepared.data,
      _pathType: 'open',
      positionFormat: prepared.dims === 3 ? 'XYZ' : 'XY',
      widthUnits: this.props.widthUnits ?? 'pixels',
      widthScale: this.props.widthScale ?? 1,
      widthMinPixels: (this.props as any).widthMinPixels,
      widthMaxPixels: (this.props as any).widthMaxPixels,
      capRounded: (this.props as any).capRounded,
      jointRounded: (this.props as any).jointRounded,
      opacity: this.props.opacity,
      visible: this.props.visible,
      pickable: this.props.pickable ?? false,

      getColor: constColor,
      getWidth: constWidth,

      extensions: [this.timeFilterExtension],
      getTime: this.boundGetTime,
      timeOffset: prepared.timeOffset,
      timeWindow,
      fadeInDuration: this.props.fadeInDuration,
      fadeOutDuration: this.props.fadeOutDuration,
    });
  }
}
