/**
 * AnimatedPolygonLayer - GPU-efficient polygon rendering with time filtering
 *
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU where possible
 * - Time filtering done in JavaScript (SolidPolygonLayer doesn't support TimeFilterExtension)
 * - Uses startIndices for variable-length polygon geometries
 *
 * PERFORMANCE OPTIMIZED:
 * - Caches extracted geometry per tile/visible set combination
 * - Reuses arrays between frames when visible set unchanged
 * - Color attributes cached per tile
 * - Layer instances are cached and reused when possible
 */
import { SolidPolygonLayer } from '@deck.gl/layers';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
// Debug flag - enable to see tile/feature info
const DEBUG = false;
const geometryCache = new WeakMap();
// Cache for color attributes per tile
const colorCache = new WeakMap();
// Default color palette for categorical data
const DEFAULT_PALETTE = [
    [255, 140, 0, 180],
    [31, 119, 180, 180],
    [44, 160, 44, 180],
    [214, 39, 40, 180],
    [148, 103, 189, 180],
    [140, 86, 75, 180],
    [227, 119, 194, 180],
    [127, 127, 127, 180],
    [188, 189, 34, 180],
    [23, 190, 207, 180],
];
/**
 * Animated polygon layer using deck.gl binary interface
 *
 * Performance optimizations:
 * - Caches extracted geometry per tile when visible set is stable
 * - Reuses typed arrays between frames
 * - Color attributes cached per tile+palette combination
 * - Layer instances cached and reused when visible set unchanged
 */
export class AnimatedPolygonLayer extends SpatioTemporalLayer {
    constructor() {
        super(...arguments);
        // Cache of layer instances keyed by tile+layer ID
        Object.defineProperty(this, "layerCache", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Map()
        });
        // Set of layer IDs that are currently visible
        Object.defineProperty(this, "activeLayerIds", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Set()
        });
    }
    finalizeState(context) {
        super.finalizeState(context);
        this.layerCache.clear();
        this.activeLayerIds.clear();
    }
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (DEBUG) {
            console.log('[AnimatedPolygonLayer] renderLayers called, tiles:', tiles?.length || 0);
        }
        if (!tiles || tiles.length === 0) {
            this.cleanupCache(new Set());
            return [];
        }
        const timeWindow = this.props.timeWindow || 86400000 * 30; // Default 30 days
        const halfWindow = timeWindow / 2;
        const timeStart = currentTime - halfWindow;
        const timeEnd = currentTime + halfWindow;
        const layers = [];
        const newActiveIds = new Set();
        for (const tile of tiles) {
            for (let layerIndex = 0; layerIndex < tile.layers.length; layerIndex++) {
                const tileLayer = tile.layers[layerIndex];
                const binary = tileLayer.features;
                if (binary.featureCount === 0 || !binary.startIndices) {
                    continue;
                }
                // Get visible feature indices and check if they changed
                const { visibleIndices, indicesHash } = this.getVisibleFeatureIndices(binary, timeStart, timeEnd);
                if (DEBUG) {
                    console.log('[AnimatedPolygonLayer] Visible features:', visibleIndices.length, 'of', binary.featureCount);
                }
                if (visibleIndices.length === 0) {
                    continue;
                }
                const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
                newActiveIds.add(layerId);
                const layer = this.getOrCreateLayer(binary, visibleIndices, indicesHash, layerId);
                if (layer) {
                    layers.push(layer);
                }
            }
        }
        this.cleanupCache(newActiveIds);
        this.activeLayerIds = newActiveIds;
        return layers;
    }
    /**
     * Get a cached layer or create a new one.
     */
    getOrCreateLayer(binary, visibleIndices, indicesHash, layerId) {
        const cached = this.layerCache.get(layerId);
        if (cached && cached.indicesHash === indicesHash) {
            // Same visible set - clone with updated props
            return cached.layer.clone({
                opacity: this.props.opacity,
                visible: this.props.visible,
            });
        }
        // Visible set changed or new layer - create new
        const layer = this.createBinaryPolygonLayer(binary, visibleIndices, indicesHash, layerId);
        if (layer) {
            this.layerCache.set(layerId, {
                layer,
                indicesHash,
            });
        }
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
     * Get indices of features visible in the current time window.
     * Returns both the indices and a hash for cache invalidation.
     */
    getVisibleFeatureIndices(binary, timeStart, timeEnd) {
        const visible = [];
        const timeOffset = binary.timeOffset;
        for (let i = 0; i < binary.featureCount; i++) {
            const featureStart = timeOffset + binary.startTimes[i];
            const featureEnd = timeOffset + binary.endTimes[i];
            // Feature is visible if its time range overlaps with the current window
            if (featureEnd >= timeStart && featureStart <= timeEnd) {
                visible.push(i);
            }
        }
        // Create a hash of visible indices for cache key
        // For performance, just use first/last/count as approximate hash
        const indicesHash = visible.length > 0
            ? `${visible.length}:${visible[0]}:${visible[visible.length - 1]}`
            : 'empty';
        return { visibleIndices: visible, indicesHash };
    }
    /**
     * Create a SolidPolygonLayer for visible features using binary data.
     * Uses cached geometry when the visible set hasn't changed.
     */
    createBinaryPolygonLayer(binary, visibleIndices, indicesHash, layerId) {
        const dims = binary.positionDimensions ?? 2;
        // Check if we have cached geometry for this visible set
        let cached = geometryCache.get(binary);
        if (!cached || cached.indicesHash !== indicesHash) {
            // Need to recompute geometry
            const { positions, startIndices } = this.extractVisiblePolygons(binary, visibleIndices, dims);
            if (positions.length === 0) {
                return null;
            }
            cached = {
                positions,
                startIndices,
                visibleCount: visibleIndices.length,
                indicesHash
            };
            geometryCache.set(binary, cached);
        }
        if (cached.positions.length === 0) {
            return null;
        }
        // Build the binary data object for deck.gl
        const data = {
            length: cached.visibleCount,
            startIndices: cached.startIndices,
            attributes: {
                getPolygon: {
                    value: cached.positions,
                    size: dims,
                },
            },
        };
        // Add fill color attribute (cached)
        const fillColorAttr = this.getFillColorAttribute(binary, visibleIndices, indicesHash);
        if (fillColorAttr) {
            data.attributes.getFillColor = fillColorAttr;
        }
        return new SolidPolygonLayer({
            id: layerId,
            data,
            // Tell deck.gl we're providing pre-formatted polygon data
            _normalize: false,
            // Counter-clockwise winding
            _windingOrder: 'CCW',
            filled: this.props.filled,
            extruded: this.props.extruded,
            opacity: this.props.opacity,
            visible: this.props.visible,
            pickable: this.props.pickable ?? false,
            // Use constant fill color if not using property-based
            ...(fillColorAttr ? {} : { getFillColor: this.props.fillColor }),
            // Elevation
            ...(this.props.extruded ? { getElevation: this.props.elevation } : {}),
            updateTriggers: {
                getFillColor: [this.props.fillColor, this.props.colorPalette, indicesHash],
            },
        });
    }
    /**
     * Extract positions for visible polygons only
     */
    extractVisiblePolygons(binary, visibleIndices, dims) {
        // Calculate total positions needed
        let totalPositions = 0;
        for (const idx of visibleIndices) {
            const start = binary.startIndices[idx];
            const end = binary.startIndices[idx + 1];
            totalPositions += end - start;
        }
        const positions = new Float64Array(totalPositions * dims);
        const startIndices = new Uint32Array(visibleIndices.length + 1);
        let posIdx = 0;
        for (let i = 0; i < visibleIndices.length; i++) {
            const featureIdx = visibleIndices[i];
            const srcStart = binary.startIndices[featureIdx] * dims;
            const srcEnd = binary.startIndices[featureIdx + 1] * dims;
            startIndices[i] = posIdx / dims;
            // Copy positions
            for (let j = srcStart; j < srcEnd; j++) {
                positions[posIdx++] = binary.positions[j];
            }
        }
        startIndices[visibleIndices.length] = posIdx / dims;
        return { positions, startIndices };
    }
    /**
     * Get fill color attribute for visible features.
     * Cached per tile + property + palette + visible set combination.
     */
    getFillColorAttribute(binary, visibleIndices, indicesHash) {
        const fillColor = this.props.fillColor;
        if (typeof fillColor === 'string') {
            const prop = binary.categoricalProps[fillColor];
            if (prop) {
                const palette = this.props.colorPalette || DEFAULT_PALETTE;
                // Check cache
                let binaryColorCache = colorCache.get(binary);
                if (!binaryColorCache) {
                    binaryColorCache = new Map();
                    colorCache.set(binary, binaryColorCache);
                }
                // Cache key includes visible indices hash
                const paletteKey = palette.map(c => c.join(',')).join('|');
                const cacheKey = `${fillColor}:${paletteKey}:${indicesHash}`;
                let colors = binaryColorCache.get(cacheKey);
                if (!colors) {
                    colors = new Uint8Array(visibleIndices.length * 4);
                    for (let i = 0; i < visibleIndices.length; i++) {
                        const featureIdx = visibleIndices[i];
                        const categoryIndex = prop.indices[featureIdx];
                        const c = palette[categoryIndex % palette.length];
                        colors[i * 4] = c[0];
                        colors[i * 4 + 1] = c[1];
                        colors[i * 4 + 2] = c[2];
                        colors[i * 4 + 3] = c[3] ?? 255;
                    }
                    binaryColorCache.set(cacheKey, colors);
                }
                return { value: colors, size: 4, normalized: true };
            }
        }
        return null;
    }
}
Object.defineProperty(AnimatedPolygonLayer, "layerName", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 'AnimatedPolygonLayer'
});
Object.defineProperty(AnimatedPolygonLayer, "defaultProps", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: {
        ...SpatioTemporalLayer.defaultProps,
        // Polygon appearance
        stroked: false, // Stroked requires separate PathLayer, disabled for performance
        filled: true,
        lineWidthUnits: 'pixels',
        lineWidth: { type: 'number', value: 1 },
        lineColor: { type: 'color', value: [0, 0, 0, 255] },
        fillColor: { type: 'color', value: [255, 140, 0, 180] },
        colorPalette: { type: 'array', value: DEFAULT_PALETTE },
        elevation: { type: 'number', value: 0 },
        extruded: false,
        // Animation props
        fadeInDuration: { type: 'number', value: 500, min: 0 },
        fadeOutDuration: { type: 'number', value: 500, min: 0 },
    }
});
