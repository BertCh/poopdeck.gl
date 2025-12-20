/**
 * AnimatedPathLayer - GPU-efficient path/trajectory rendering with time filtering
 *
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU (no accessor function calls)
 * - Uses startIndices for variable-length paths
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Layer instances are cached and cloned to avoid recreation overhead
 */
import { PathLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();
// Cache for color attributes per tile (keyed by binary + property + palette)
const colorAttrCache = new WeakMap();
// Default color palette for categorical data
const DEFAULT_PALETTE = [
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
/**
 * Animated path layer using deck.gl binary interface
 *
 * Performance optimizations:
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - Uses startIndices for variable-length path geometries
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Layer caching prevents unnecessary buffer recreation
 */
export class AnimatedPathLayer extends SpatioTemporalLayer {
    constructor() {
        super(...arguments);
        // Cache of layer instances keyed by tile+layer ID
        this.layerCache = new Map();
        // Set of layer IDs that are currently visible
        this.activeLayerIds = new Set();
    }
    finalizeState(context) {
        super.finalizeState(context);
        this.layerCache.clear();
        this.activeLayerIds.clear();
    }
    renderLayers() {
        const { tiles } = this.state;
        if (!tiles || tiles.length === 0) {
            this.cleanupCache(new Set());
            return [];
        }
        const newActiveIds = new Set();
        const layers = tiles.flatMap((tile) => {
            return tile.layers.map((layer, layerIndex) => {
                const binary = layer.features;
                if (binary.featureCount === 0 || !binary.startIndices) {
                    return null;
                }
                const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
                newActiveIds.add(layerId);
                const tileTimeOffset = binary.timeOffset;
                return this.getOrCreateLayer(binary, layerId, tileTimeOffset);
            });
        }).filter(Boolean);
        this.cleanupCache(newActiveIds);
        this.activeLayerIds = newActiveIds;
        return layers;
    }
    /**
     * Get a cached layer or create a new one.
     * PERFORMANCE: Uses getTime() getter so layers can be memoized.
     */
    getOrCreateLayer(binary, layerId, timeOffset) {
        const cached = this.layerCache.get(layerId);
        // Return cached layer if binary hasn't changed
        // Time updates happen via getTime() getter in TimeFilterExtension.draw()
        if (cached && cached.binary === binary) {
            return cached.layer;
        }
        // Create new layer with getTime getter
        const layer = this.createBinaryPathLayer(binary, layerId, timeOffset);
        this.layerCache.set(layerId, {
            layer,
            binary,
            timeOffset,
        });
        return layer;
    }
    /**
     * Remove cached layers that are no longer active
     */
    cleanupCache(activeIds) {
        for (const id of this.layerCache.keys()) {
            if (!activeIds.has(id)) {
                this.layerCache.delete(id);
            }
        }
    }
    /**
     * Create a PathLayer using deck.gl's binary data interface.
     * PERFORMANCE: Uses getTime() getter for dynamic time updates.
     */
    createBinaryPathLayer(binary, layerId, timeOffset) {
        const dims = binary.positionDimensions ?? 2;
        const timeWindow = this.props.timeWindow || 86400000;
        // Capture self for getTime closure
        const self = this;
        // Build the binary data object for deck.gl
        // For paths, we need startIndices to tell deck.gl where each path starts
        const data = {
            length: binary.featureCount,
            startIndices: binary.startIndices,
            attributes: {
                // Path positions - the full interleaved array
                getPath: {
                    value: binary.positions,
                    size: dims,
                },
                // Time attributes for TimeFilterExtension (per-path, not per-vertex)
                instanceStartTime: {
                    value: binary.startTimes,
                    size: 1,
                },
                instanceEndTime: {
                    value: binary.endTimes,
                    size: 1,
                },
            },
        };
        // Add width attribute if using a property
        const widthAttr = this.getWidthAttribute(binary);
        if (widthAttr) {
            data.attributes.getWidth = widthAttr;
        }
        // Add color attribute if using a property
        const colorAttr = this.getColorAttribute(binary);
        if (colorAttr) {
            data.attributes.getColor = colorAttr;
        }
        return new PathLayer({
            id: layerId,
            data,
            // Tell PathLayer this is pre-formatted path data
            _pathType: 'open',
            widthScale: this.props.widthScale,
            widthUnits: this.props.widthUnits,
            opacity: this.props.opacity,
            visible: this.props.visible,
            pickable: this.props.pickable ?? false,
            // Time Filtering via extension
            // PERFORMANCE: Use getTime() getter for dynamic time updates (allows layer memoization)
            extensions: [TIME_FILTER_EXTENSION],
            getTime: () => self.getCurrentTime() - timeOffset,
            timeWindow,
            fadeInDuration: this.props.fadeInDuration,
            fadeOutDuration: this.props.fadeOutDuration,
            // Use constant values if not using property-based attributes
            ...(widthAttr ? {} : { getWidth: this.props.pathWidth }),
            ...(colorAttr ? {} : { getColor: this.props.pathColor }),
            updateTriggers: {
                getColor: [this.props.pathColor, this.props.colorPalette],
                getWidth: [this.props.pathWidth],
            },
        });
    }
    /**
     * Get width attribute from numeric property if specified
     */
    getWidthAttribute(binary) {
        const width = this.props.pathWidth;
        if (typeof width === 'string') {
            const values = binary.numericProps[width];
            if (values) {
                return { value: values, size: 1 };
            }
        }
        return null;
    }
    /**
     * Get color attribute from categorical property if specified.
     * Cached per BinaryFeatures + property + palette combination.
     */
    getColorAttribute(binary) {
        const color = this.props.pathColor;
        if (typeof color === 'string') {
            const prop = binary.categoricalProps[color];
            if (prop) {
                const palette = this.props.colorPalette || DEFAULT_PALETTE;
                // Check cache
                let binaryCache = colorAttrCache.get(binary);
                if (!binaryCache) {
                    binaryCache = new Map();
                    colorAttrCache.set(binary, binaryCache);
                }
                // Create cache key from property name and palette
                const paletteKey = palette.map(c => c.join(',')).join('|');
                const cacheKey = `${color}:${paletteKey}`;
                let colors = binaryCache.get(cacheKey);
                if (!colors) {
                    colors = new Uint8Array(binary.featureCount * 4);
                    for (let i = 0; i < binary.featureCount; i++) {
                        const categoryIndex = prop.indices[i];
                        const c = palette[categoryIndex % palette.length];
                        colors[i * 4] = c[0];
                        colors[i * 4 + 1] = c[1];
                        colors[i * 4 + 2] = c[2];
                        colors[i * 4 + 3] = c[3] ?? 255;
                    }
                    binaryCache.set(cacheKey, colors);
                }
                return { value: colors, size: 4, normalized: true };
            }
        }
        return null;
    }
}
AnimatedPathLayer.layerName = 'AnimatedPathLayer';
AnimatedPathLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // PathLayer props
    widthScale: { type: 'number', value: 1, min: 0 },
    widthUnits: 'pixels',
    pathColor: { type: 'color', value: [0, 150, 255, 255] },
    pathWidth: { type: 'number', value: 3 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    // Trail props
    trail: true,
    trailLength: { type: 'number', value: 5000, min: 0 }, // 5 seconds
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
};
//# sourceMappingURL=animated-path-layer.js.map