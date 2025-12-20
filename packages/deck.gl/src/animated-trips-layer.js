/**
 * AnimatedTripsLayer - GPU-efficient animated trips/trajectories
 *
 * Provides a "vehicle moving along route" effect where paths are progressively
 * drawn with a trailing fade effect.
 *
 * PERFORMANCE OPTIMIZED:
 * - Uses PathLayer with binary data interface (no per-frame JS object creation)
 * - Trail rendering done entirely in GPU via TimeFilterExtension
 * - Per-vertex progress computed once and cached per tile
 * - Layer instances are cached and cloned to avoid recreation overhead
 */
import { PathLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();
// Cache for per-vertex progress arrays (keyed by BinaryFeatures instance)
const vertexProgressCache = new WeakMap();
// Cache for expanded per-vertex time arrays
const vertexTimesCache = new WeakMap();
// Cache for color attributes (keyed by binary + property + palette hash)
const colorAttrCache = new WeakMap();
// Default color palette
const DEFAULT_PALETTE = [
    [253, 128, 93, 255],
    [0, 150, 255, 255],
    [44, 160, 44, 255],
    [214, 39, 40, 255],
    [148, 103, 189, 255],
];
/**
 * Animated trips layer for trajectory data with progressive drawing
 *
 * Performance optimizations:
 * - Uses PathLayer with deck.gl binary data interface (zero accessor calls)
 * - TimeFilterExtension handles trail rendering entirely in GPU shaders
 * - Per-vertex progress computed once and cached per tile (not per frame)
 * - Layer caching prevents unnecessary buffer recreation
 */
export class AnimatedTripsLayer extends SpatioTemporalLayer {
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
        const { tiles, frameNumber } = this.state;
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
                return this.getOrCreateLayer(binary, layerId, tileTimeOffset, frameNumber || 0);
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
    getOrCreateLayer(binary, layerId, timeOffset, _frameNumber) {
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
     * Create a PathLayer using deck.gl's binary data interface with trail support.
     * PERFORMANCE: Uses getTime() getter for dynamic time updates.
     */
    createBinaryPathLayer(binary, layerId, timeOffset) {
        const dims = binary.positionDimensions ?? 2;
        const timeWindow = this.props.timeWindow || 86400000;
        // Capture self for getTime closure
        const self = this;
        // Get or compute per-vertex progress (0-1 along each path)
        const vertexProgress = this.getVertexProgress(binary);
        // Expand per-feature times to per-vertex for trail rendering
        const { vertexStartTimes, vertexEndTimes } = this.expandTimesToVertices(binary);
        // Build the binary data object for deck.gl
        const data = {
            length: binary.featureCount,
            startIndices: binary.startIndices,
            attributes: {
                // Path positions - the full interleaved array
                getPath: {
                    value: binary.positions,
                    size: dims,
                },
                // Per-vertex time attributes for trail rendering
                instanceStartTime: {
                    value: vertexStartTimes,
                    size: 1,
                },
                instanceEndTime: {
                    value: vertexEndTimes,
                    size: 1,
                },
                // Per-vertex progress (0-1) for interpolating time along path
                // Used when actual per-vertex timestamps are not available
                instanceVertexProgress: {
                    value: vertexProgress,
                    size: 1,
                },
            },
        };
        // Add per-vertex timestamps if available (for accurate animation)
        // This is preferred over linear interpolation when the data includes 
        // actual timestamps for each coordinate (e.g., GPS tracks)
        if (binary.vertexTimestamps) {
            data.attributes.instanceVertexTime = {
                value: binary.vertexTimestamps,
                size: 1,
            };
        }
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
            widthUnits: 'pixels',
            widthMinPixels: this.props.widthMinPixels,
            widthMaxPixels: this.props.widthMaxPixels,
            opacity: this.props.opacity,
            visible: this.props.visible,
            pickable: this.props.pickable ?? false,
            capRounded: this.props.capRounded,
            jointRounded: this.props.jointRounded,
            // Time Filtering via extension with trail support
            // PERFORMANCE: Use getTime() getter for dynamic time updates (allows layer memoization)
            extensions: [TIME_FILTER_EXTENSION],
            getTime: () => self.getCurrentTime() - timeOffset,
            timeWindow,
            trailLength: this.props.trailLength,
            fadeInDuration: 0,
            fadeOutDuration: 0,
            // Use constant values if not using property-based attributes
            ...(widthAttr ? {} : { getWidth: this.props.tripWidth }),
            ...(colorAttr ? {} : { getColor: this.props.tripColor }),
            updateTriggers: {
                getColor: [this.props.tripColor, this.props.colorPalette],
                getWidth: [this.props.tripWidth],
            },
        });
    }
    /**
     * Get or compute per-vertex progress (0-1) for each vertex along its path.
     * Cached per BinaryFeatures instance to avoid recomputation.
     */
    getVertexProgress(binary) {
        // Check cache first
        let cached = vertexProgressCache.get(binary);
        if (cached) {
            return cached;
        }
        // Compute per-vertex progress
        const startIndices = binary.startIndices;
        const totalVertices = startIndices[binary.featureCount];
        const progress = new Float32Array(totalVertices);
        for (let i = 0; i < binary.featureCount; i++) {
            const start = startIndices[i];
            const end = startIndices[i + 1];
            const numVertices = end - start;
            if (numVertices <= 1) {
                progress[start] = 0;
            }
            else {
                for (let j = 0; j < numVertices; j++) {
                    progress[start + j] = j / (numVertices - 1);
                }
            }
        }
        // Cache for reuse
        vertexProgressCache.set(binary, progress);
        return progress;
    }
    /**
     * Expand per-feature start/end times to per-vertex arrays.
     * This is needed because PathLayer processes vertices, not instances.
     * Cached per BinaryFeatures instance to avoid recomputation.
     */
    expandTimesToVertices(binary) {
        // Check cache first
        const cached = vertexTimesCache.get(binary);
        if (cached) {
            return cached;
        }
        const startIndices = binary.startIndices;
        const totalVertices = startIndices[binary.featureCount];
        const vertexStartTimes = new Float32Array(totalVertices);
        const vertexEndTimes = new Float32Array(totalVertices);
        for (let i = 0; i < binary.featureCount; i++) {
            const start = startIndices[i];
            const end = startIndices[i + 1];
            const featureStart = binary.startTimes[i];
            const featureEnd = binary.endTimes[i];
            for (let j = start; j < end; j++) {
                vertexStartTimes[j] = featureStart;
                vertexEndTimes[j] = featureEnd;
            }
        }
        const result = { vertexStartTimes, vertexEndTimes };
        vertexTimesCache.set(binary, result);
        return result;
    }
    /**
     * Get width attribute from numeric property if specified
     */
    getWidthAttribute(binary) {
        const width = this.props.tripWidth;
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
        const color = this.props.tripColor;
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
AnimatedTripsLayer.layerName = 'AnimatedTripsLayer';
AnimatedTripsLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // Path styling props
    widthScale: { type: 'number', value: 1, min: 0 },
    widthMinPixels: { type: 'number', value: 2 },
    widthMaxPixels: { type: 'number', value: 10 },
    tripColor: { type: 'color', value: [253, 128, 93, 255] },
    tripWidth: { type: 'number', value: 3 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    // Trail props
    trailLength: { type: 'number', value: 180000, min: 0 }, // 3 minutes default
    fadeTrail: true,
    capRounded: true,
    jointRounded: true,
};
//# sourceMappingURL=animated-trips-layer.js.map