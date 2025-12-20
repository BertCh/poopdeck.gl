/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering
 *
 * PERFORMANCE OPTIMIZED (v2 - Consolidated Rendering):
 * - Consolidates ALL tiles into a SINGLE ScatterplotLayer (1 draw call instead of N)
 * - Uses deck.gl's binary data interface for maximum performance
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Consolidated data cached per tile set - only rebuilt when tiles change
 * - Layer instance memoized to avoid recreation on time-only updates
 *
 * Performance: Targets 200fps by eliminating per-tile layer overhead
 */
import { ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
// Debug flag
const DEBUG = false;
// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();
// Default color palette for categorical data
const DEFAULT_PALETTE = [
    [31, 119, 180, 255],
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
 * Animated point layer using deck.gl binary interface
 *
 * Performance optimizations (v2):
 * - SINGLE draw call: All tiles consolidated into one ScatterplotLayer
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Consolidated data cached - only rebuilt when tiles change (frameNumber)
 * - Layer instance memoized for time-only updates
 */
export class AnimatedPointLayer extends SpatioTemporalLayer {
    constructor() {
        super(...arguments);
        // ========== CONSOLIDATED DATA CACHE ==========
        // Merges all tile data into a single data object for ONE draw call
        this.consolidatedDataCache = { tiles: null, frameNumber: -1, propsKey: '', data: null };
        // ========== MEMOIZED LAYER CACHE ==========
        // Reuse the same layer instance when only time changes (not tiles)
        this.cachedLayer = null;
        this.cachedLayerFrameNumber = -1;
        // ========== CACHED PROPERTIES FOR PERFORMANCE ==========
        // These provide stable references so deck.gl can use fast reference equality
        // instead of expensive deep comparison during layer diffing.
        // Cached updateTriggers object - only recreated when relevant props change
        this.cachedUpdateTriggers = {};
        // Track last prop values to detect changes
        this.lastFillColor = undefined;
        this.lastRadius = undefined;
        this.lastColorPalette = undefined;
        // Cached color/radius props object - only recreated when props change
        this.cachedColorRadiusProps = null;
        this.lastFillColorForProps = undefined;
        this.lastRadiusForProps = undefined;
    }
    finalizeState(context) {
        super.finalizeState(context);
        // Clean up cached data
        this.consolidatedDataCache = { tiles: null, frameNumber: -1, propsKey: '', data: null };
        this.cachedLayer = null;
    }
    /**
     * PERFORMANCE OPTIMIZED renderLayers:
     * - Creates a SINGLE ScatterplotLayer for ALL tiles (1 draw call)
     * - Caches consolidated data - only rebuilds when tiles change
     * - TRULY MEMOIZES layer instance - returns SAME layer for time-only updates
     * - Time updates happen via getTime() getter in TimeFilterExtension.draw()
     */
    renderLayers() {
        const { tiles, frameNumber } = this.state;
        if (!tiles || tiles.length === 0) {
            if (DEBUG)
                console.log('AnimatedPointLayer: No tiles loaded');
            this.cachedLayer = null;
            return [];
        }
        const currentFrameNumber = frameNumber || 0;
        // Get or build consolidated data for all tiles
        const data = this.getConsolidatedData(tiles, currentFrameNumber);
        if (!data || data.length === 0) {
            if (DEBUG)
                console.log('AnimatedPointLayer: No features in tiles');
            return [];
        }
        // ========== LAYER MEMOIZATION ==========
        // Return the SAME layer instance if tiles haven't changed.
        // Time updates are handled by the getTime() getter in TimeFilterExtension.draw()
        if (this.cachedLayer && this.cachedLayerFrameNumber === currentFrameNumber) {
            // Check if props that affect the layer have changed
            const propsUnchanged = this.props.fillColor === this.lastFillColor &&
                this.props.radius === this.lastRadius &&
                this.props.colorPalette === this.lastColorPalette &&
                this.props.opacity === this.cachedLayer.props.opacity &&
                this.props.visible === this.cachedLayer.props.visible;
            if (propsUnchanged) {
                if (DEBUG)
                    console.log('AnimatedPointLayer: Returning memoized layer');
                return [this.cachedLayer];
            }
        }
        if (DEBUG) {
            console.log(`AnimatedPointLayer: ${tiles.length} tiles, ${data.length} total features, creating layer`);
        }
        // ========== UPDATE CACHED OBJECTS ONLY WHEN PROPS CHANGE ==========
        if (this.props.fillColor !== this.lastFillColor ||
            this.props.radius !== this.lastRadius ||
            this.props.colorPalette !== this.lastColorPalette) {
            this.lastFillColor = this.props.fillColor;
            this.lastRadius = this.props.radius;
            this.lastColorPalette = this.props.colorPalette;
            this.cachedUpdateTriggers = {
                getFillColor: [this.props.fillColor, this.props.colorPalette, currentFrameNumber],
                getRadius: [this.props.radius, currentFrameNumber],
            };
        }
        // Create and cache the layer
        const layer = this.createConsolidatedLayer(data);
        this.cachedLayer = layer;
        this.cachedLayerFrameNumber = currentFrameNumber;
        return [layer];
    }
    /**
     * Get or create consolidated data from all tiles.
     * Cached by frameNumber - only rebuilds when tiles actually change.
     */
    getConsolidatedData(tiles, frameNumber) {
        // Generate cache key from props that affect data structure
        const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
        const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : '';
        const propsKey = `${fillColorProp}|${radiusProp}`;
        // Return cached data if still valid
        if (this.consolidatedDataCache.data &&
            this.consolidatedDataCache.frameNumber === frameNumber &&
            this.consolidatedDataCache.propsKey === propsKey) {
            return this.consolidatedDataCache.data;
        }
        // Build new consolidated data
        const data = this.buildConsolidatedData(tiles);
        // Cache it
        this.consolidatedDataCache = {
            tiles,
            frameNumber,
            propsKey,
            data,
        };
        // Invalidate layer cache since data changed
        this.cachedLayer = null;
        this.cachedLayerFrameNumber = -1;
        return data;
    }
    /**
     * Build consolidated data by merging all tile binary data.
     * Converts relative times to absolute times during consolidation.
     */
    buildConsolidatedData(tiles) {
        // First pass: count total features and determine dimensions
        let totalFeatures = 0;
        let dims = 2;
        for (const tile of tiles) {
            for (const layer of tile.layers) {
                const binary = layer.features;
                totalFeatures += binary.featureCount;
                if (binary.positionDimensions && binary.positionDimensions > dims) {
                    dims = binary.positionDimensions;
                }
            }
        }
        if (totalFeatures === 0) {
            return null;
        }
        // Allocate consolidated arrays
        const positions = new Float32Array(totalFeatures * dims);
        const startTimes = new Float32Array(totalFeatures);
        const endTimes = new Float32Array(totalFeatures);
        // For property-based attributes
        const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : null;
        const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : null;
        let colors = fillColorProp ? new Uint8Array(totalFeatures * 4) : null;
        let radii = radiusProp ? new Float32Array(totalFeatures) : null;
        const palette = this.props.colorPalette || DEFAULT_PALETTE;
        // Second pass: copy data from each tile
        let offset = 0;
        for (const tile of tiles) {
            for (const layer of tile.layers) {
                const binary = layer.features;
                const count = binary.featureCount;
                const srcDims = binary.positionDimensions ?? 2;
                const timeOffset = binary.timeOffset;
                // Copy positions (handle dimension mismatch)
                for (let i = 0; i < count; i++) {
                    const srcIdx = i * srcDims;
                    const dstIdx = (offset + i) * dims;
                    positions[dstIdx] = binary.positions[srcIdx];
                    positions[dstIdx + 1] = binary.positions[srcIdx + 1];
                    if (dims === 3) {
                        positions[dstIdx + 2] = srcDims === 3 ? binary.positions[srcIdx + 2] : 0;
                    }
                }
                // Copy times - convert to ABSOLUTE times by adding timeOffset
                for (let i = 0; i < count; i++) {
                    startTimes[offset + i] = timeOffset + binary.startTimes[i];
                    endTimes[offset + i] = timeOffset + binary.endTimes[i];
                }
                // Copy colors if using property-based coloring
                if (colors && fillColorProp) {
                    const prop = binary.categoricalProps[fillColorProp];
                    if (prop) {
                        for (let i = 0; i < count; i++) {
                            const categoryIndex = prop.indices[i];
                            const color = palette[categoryIndex % palette.length];
                            const dstIdx = (offset + i) * 4;
                            colors[dstIdx] = color[0];
                            colors[dstIdx + 1] = color[1];
                            colors[dstIdx + 2] = color[2];
                            colors[dstIdx + 3] = color[3] ?? 255;
                        }
                    }
                }
                // Copy radii if using property-based radius
                if (radii && radiusProp) {
                    const values = binary.numericProps[radiusProp];
                    if (values) {
                        for (let i = 0; i < count; i++) {
                            radii[offset + i] = values[i];
                        }
                    }
                }
                offset += count;
            }
        }
        // Build the consolidated data object
        const attributes = {
            getPosition: { value: positions, size: dims },
            getInstanceStartTime: { value: startTimes, size: 1 },
            getInstanceEndTime: { value: endTimes, size: 1 },
        };
        if (colors) {
            attributes.getFillColor = { value: colors, size: 4, normalized: true };
        }
        if (radii) {
            attributes.getRadius = { value: radii, size: 1 };
        }
        return {
            length: totalFeatures,
            attributes,
        };
    }
    /**
     * Create a single ScatterplotLayer with consolidated data.
     *
     * PERFORMANCE: Uses getTime() getter instead of currentTime prop.
     * This allows the layer to be memoized - time updates happen in
     * TimeFilterExtension.draw() via the getter, not via layer recreation.
     */
    createConsolidatedLayer(data) {
        const layerId = `${this.props.id}-consolidated`;
        const timeWindow = this.props.timeWindow || 86400000;
        // Capture `this` for the getter closure
        const self = this;
        return new ScatterplotLayer({
            id: layerId,
            data,
            coordinateSystem: COORDINATE_SYSTEM.LNGLAT,
            radiusScale: this.props.radiusScale,
            radiusUnits: this.props.radiusUnits,
            opacity: this.props.opacity,
            visible: this.props.visible,
            pickable: this.props.pickable ?? false,
            // Time Filtering via extension
            // PERFORMANCE: Use getTime() getter - allows layer memoization
            // Time is read dynamically in TimeFilterExtension.draw()
            extensions: [TIME_FILTER_EXTENSION],
            getTime: () => self.getCurrentTime(),
            timeWindow,
            fadeInDuration: this.props.fadeInDuration,
            fadeOutDuration: this.props.fadeOutDuration,
            // Use constant values if not using property-based attributes
            ...this.getColorAndRadiusProps(),
            // Use cached updateTriggers - stable reference for deck.gl diffing
            updateTriggers: this.cachedUpdateTriggers,
        });
    }
    /**
     * Get color and radius props for constant values only.
     * Property-based values are handled in buildConsolidatedData as attributes.
     *
     * PERFORMANCE OPTIMIZATION:
     * Returns a cached object when props haven't changed. This ensures deck.gl
     * sees stable references and can skip expensive deep comparisons.
     */
    getColorAndRadiusProps() {
        // Return cached props if nothing changed
        if (this.cachedColorRadiusProps &&
            this.props.fillColor === this.lastFillColorForProps &&
            this.props.radius === this.lastRadiusForProps) {
            return this.cachedColorRadiusProps;
        }
        // Rebuild cached props
        this.lastFillColorForProps = this.props.fillColor;
        this.lastRadiusForProps = this.props.radius;
        const result = {};
        // Add radius value if using a constant (property-based is in data.attributes)
        if (typeof this.props.radius !== 'string') {
            result.getRadius = this.props.radius;
        }
        // Add color value if using a constant (property-based is in data.attributes)
        if (typeof this.props.fillColor !== 'string') {
            result.getFillColor = this.props.fillColor;
        }
        this.cachedColorRadiusProps = result;
        return result;
    }
}
AnimatedPointLayer.layerName = 'AnimatedPointLayer';
AnimatedPointLayer.defaultProps = {
    ...SpatioTemporalLayer.defaultProps,
    // ScatterplotLayer props
    radiusScale: { type: 'number', value: 1, min: 0 },
    radiusUnits: 'pixels',
    fillColor: { type: 'color', value: [255, 128, 0, 255] },
    radius: { type: 'number', value: 5 },
    colorPalette: { type: 'array', value: DEFAULT_PALETTE },
    // 3D support
    use3D: false,
    elevationProperty: null,
    elevationScale: { type: 'number', value: 1, min: 0 },
    // Animation props
    fadeInDuration: { type: 'number', value: 300, min: 0 },
    fadeOutDuration: { type: 'number', value: 300, min: 0 },
};
//# sourceMappingURL=animated-point-layer.js.map