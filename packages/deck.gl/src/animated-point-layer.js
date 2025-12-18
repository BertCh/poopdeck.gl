/**
 * AnimatedPointLayer - GPU-efficient point rendering with time filtering
 *
 * Uses deck.gl's binary data interface for maximum performance:
 * - Passes typed arrays directly to GPU (no accessor function calls)
 * - Time filtering happens entirely in the shader via TimeFilterExtension
 * - Sub-layer caching prevents buffer regeneration
 * - Layer props reused with same ID - deck.gl diffing preserves GPU state
 * - TimeFilterExtension.draw() updates time uniforms each frame (no clone overhead)
 *
 * Performance: Targets 120fps by eliminating layer.clone() allocations
 */
import { ScatterplotLayer } from '@deck.gl/layers';
import { COORDINATE_SYSTEM } from '@deck.gl/core';
import { SpatioTemporalLayer } from './spatiotemporal-layer';
import { TimeFilterExtension } from './time-filter-extension';
// Debug flag
const DEBUG = false;
// Singleton TimeFilterExtension instance - reused across all layers
const TIME_FILTER_EXTENSION = new TimeFilterExtension();
// Cache for color attributes per tile (keyed by binary + property + palette)
const colorAttrCache = new WeakMap();
// Cache for binary data objects - deck.gl uses reference equality to detect data changes
// If the data object is the same reference, deck.gl skips expensive buffer re-uploads
// Key includes props that affect the data object (fillColor property name, radius property name)
const binaryDataCache = new WeakMap();
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
 * Performance optimizations:
 * - Typed arrays passed directly to GPU (zero accessor calls)
 * - TimeFilterExtension handles temporal filtering in shaders
 * - Layer caching prevents unnecessary buffer recreation
 * - Only time-varying props are updated on animation frames
 * - Cached accessor functions and updateTriggers for stable references
 */
export class AnimatedPointLayer extends SpatioTemporalLayer {
    constructor() {
        super(...arguments);
        // ========== CACHED PROPERTIES FOR PERFORMANCE ==========
        // These provide stable references so deck.gl can use fast reference equality
        // instead of expensive deep comparison during layer diffing.
        // Cached updateTriggers object - only recreated when relevant props change
        Object.defineProperty(this, "cachedUpdateTriggers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: {}
        });
        // Track last prop values to detect changes
        Object.defineProperty(this, "lastFillColor", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: undefined
        });
        Object.defineProperty(this, "lastRadius", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: undefined
        });
        Object.defineProperty(this, "lastColorPalette", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: undefined
        });
        // Cached color/radius props object - only recreated when props change
        Object.defineProperty(this, "cachedColorRadiusProps", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: null
        });
        Object.defineProperty(this, "lastFillColorForProps", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: undefined
        });
        Object.defineProperty(this, "lastRadiusForProps", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: undefined
        });
    }
    renderLayers() {
        const { tiles, currentTime } = this.state;
        if (!tiles || tiles.length === 0) {
            if (DEBUG)
                console.log('AnimatedPointLayer: No tiles loaded');
            return [];
        }
        if (DEBUG) {
            const totalFeatures = tiles.reduce((sum, t) => sum + t.layers.reduce((ls, l) => ls + l.features.featureCount, 0), 0);
            console.log(`AnimatedPointLayer: ${tiles.length} tiles, ${totalFeatures} total features`);
        }
        const timeWindow = this.props.timeWindow || 86400000;
        // ========== UPDATE CACHED OBJECTS ONLY WHEN PROPS CHANGE ==========
        // This ensures deck.gl sees stable references and can use fast equality checks
        // Update cached updateTriggers only when relevant props change
        if (this.props.fillColor !== this.lastFillColor ||
            this.props.radius !== this.lastRadius ||
            this.props.colorPalette !== this.lastColorPalette) {
            this.lastFillColor = this.props.fillColor;
            this.lastRadius = this.props.radius;
            this.lastColorPalette = this.props.colorPalette;
            this.cachedUpdateTriggers = {
                getFillColor: [this.props.fillColor, this.props.colorPalette],
                getRadius: [this.props.radius],
            };
        }
        const layers = tiles.flatMap((tile) => {
            return tile.layers.map((layer, layerIndex) => {
                const binary = layer.features;
                if (binary.featureCount === 0) {
                    return null;
                }
                const layerId = `${this.props.id}-${tile.id.z}-${tile.id.x}-${tile.id.y}-${tile.id.t}-${layerIndex}`;
                // Use the tile's timeOffset for time calculations
                // Feature times (startTimes, endTimes) are stored relative to this offset
                const tileTimeOffset = binary.timeOffset;
                return this.createLayer(binary, layerId, currentTime, tileTimeOffset, timeWindow);
            });
        }).filter(Boolean);
        return layers;
    }
    /**
     * Create a ScatterplotLayer for the given binary data.
     *
     * PERFORMANCE OPTIMIZATION:
     * - Caches the `data` object per BinaryFeatures + props combo so deck.gl recognizes
     *   unchanged data and skips GPU buffer re-uploads
     * - Creates new layer instances with updated time props each frame
     *   (this is lightweight - deck.gl efficiently diffs and updates uniforms)
     * - NO MUTATION: data objects are built complete upfront, never mutated after caching
     */
    createLayer(binary, layerId, currentTime, timeOffset, timeWindow) {
        // Get or create cached data object for this binary + props combination
        // This ensures deck.gl sees the same data reference and skips buffer uploads
        const data = this.getOrCreateDataObject(binary);
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
            extensions: [TIME_FILTER_EXTENSION],
            currentTime: currentTime - timeOffset,
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
     * Get or create a complete data object for the given binary features.
     *
     * The cache key includes the property names used for color/radius so that
     * when props change, we create a new data object rather than mutating.
     */
    getOrCreateDataObject(binary) {
        // Get cache for this binary
        let propsCache = binaryDataCache.get(binary);
        if (!propsCache) {
            propsCache = new Map();
            binaryDataCache.set(binary, propsCache);
        }
        // Create cache key from props that affect data structure
        const fillColorProp = typeof this.props.fillColor === 'string' ? this.props.fillColor : '';
        const radiusProp = typeof this.props.radius === 'string' ? this.props.radius : '';
        const cacheKey = `${fillColorProp}|${radiusProp}`;
        // Return cached data if available
        let data = propsCache.get(cacheKey);
        if (data) {
            return data;
        }
        // Build complete data object upfront (no mutation after this)
        data = this.buildDataObject(binary);
        propsCache.set(cacheKey, data);
        return data;
    }
    /**
     * Build the complete binary data object for deck.gl.
     * Includes all attributes based on current props - no mutation after creation.
     */
    buildDataObject(binary) {
        const dims = binary.positionDimensions ?? 2;
        const attributes = {
            getPosition: {
                value: binary.positions,
                size: dims,
            },
            getInstanceStartTime: {
                value: binary.startTimes,
                size: 1,
            },
            getInstanceEndTime: {
                value: binary.endTimes,
                size: 1,
            },
        };
        // Add radius attribute if using a property name
        if (typeof this.props.radius === 'string') {
            const radiusAttr = this.getRadiusAttribute(binary);
            if (radiusAttr) {
                attributes.getRadius = radiusAttr;
            }
        }
        // Add color attribute if using a property name
        if (typeof this.props.fillColor === 'string') {
            const colorAttr = this.getFillColorAttribute(binary);
            if (colorAttr) {
                attributes.getFillColor = colorAttr;
            }
        }
        return {
            length: binary.featureCount,
            attributes,
        };
    }
    /**
     * Get color and radius props for constant values only.
     * Property-based values are handled in buildDataObject as attributes.
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
    /**
     * Get radius attribute from numeric property if specified
     */
    getRadiusAttribute(binary) {
        const radius = this.props.radius;
        if (typeof radius === 'string') {
            const values = binary.numericProps[radius];
            if (values) {
                return { value: values, size: 1 };
            }
        }
        return null;
    }
    /**
     * Get fill color attribute from categorical property if specified.
     * Cached per BinaryFeatures + property + palette combination.
     */
    getFillColorAttribute(binary) {
        const fillColor = this.props.fillColor;
        if (typeof fillColor === 'string') {
            const prop = binary.categoricalProps[fillColor];
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
                const cacheKey = `${fillColor}:${paletteKey}`;
                let colors = binaryCache.get(cacheKey);
                if (!colors) {
                    colors = new Uint8Array(binary.featureCount * 4);
                    for (let i = 0; i < binary.featureCount; i++) {
                        const categoryIndex = prop.indices[i];
                        const color = palette[categoryIndex % palette.length];
                        colors[i * 4] = color[0];
                        colors[i * 4 + 1] = color[1];
                        colors[i * 4 + 2] = color[2];
                        colors[i * 4 + 3] = color[3] ?? 255;
                    }
                    binaryCache.set(cacheKey, colors);
                }
                return { value: colors, size: 4, normalized: true };
            }
        }
        return null;
    }
}
Object.defineProperty(AnimatedPointLayer, "layerName", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: 'AnimatedPointLayer'
});
Object.defineProperty(AnimatedPointLayer, "defaultProps", {
    enumerable: true,
    configurable: true,
    writable: true,
    value: {
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
    }
});
