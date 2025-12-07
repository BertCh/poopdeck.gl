/**
 * Binary Columnar Format for GPU-ready spatiotemporal data
 *
 * This format aligns with @loaders.gl/schema BinaryFeatureCollection patterns
 * and enables zero-copy GPU upload for deck.gl layers.
 */
/**
 * Convert standard Tile to BinaryTile for GPU-efficient rendering
 */
export function tileToBinaryTile(tile) {
    return {
        id: tile.id,
        timeRange: tile.timeRange,
        layers: tile.layers.map(layerToBinaryLayer),
    };
}
/**
 * Convert standard Layer to BinaryLayer
 */
export function layerToBinaryLayer(layer) {
    return {
        name: layer.name,
        extent: layer.extent,
        features: featuresToBinaryFeatures(layer.features),
    };
}
/**
 * Convert array of Feature objects to BinaryFeatures
 * This is the main conversion function for GPU-ready data
 */
export function featuresToBinaryFeatures(features) {
    const featureCount = features.length;
    if (featureCount === 0) {
        return createEmptyBinaryFeatures();
    }
    // Determine geometry type from first feature
    const geometryType = features[0].type;
    const isPoint = geometryType === 0; // GeometryType.Point
    // Calculate total positions needed
    let totalPositions = 0;
    for (const feature of features) {
        totalPositions += feature.positions.length;
    }
    // Allocate typed arrays
    const positions = new Float64Array(totalPositions * 2);
    const positionOffsets = isPoint ? undefined : new Uint32Array(featureCount + 1);
    const featureIds = new Uint32Array(featureCount);
    const startTimes = new Float32Array(featureCount);
    const endTimes = new Float32Array(featureCount);
    // Find time offset for precision (use minimum start time)
    let minTime = Infinity;
    for (const feature of features) {
        if (feature.timeRange?.start !== undefined && feature.timeRange.start < minTime) {
            minTime = feature.timeRange.start;
        }
    }
    const timeOffset = isFinite(minTime) ? minTime : 0;
    // Collect numeric and categorical properties
    const numericProps = {};
    const categoricalProps = {};
    // First pass: identify property types from first feature
    if (features[0].properties) {
        for (const [key, value] of Object.entries(features[0].properties)) {
            if (typeof value === 'number') {
                numericProps[key] = [];
            }
            else if (typeof value === 'string') {
                categoricalProps[key] = { values: [], indexMap: new Map() };
            }
        }
    }
    // Fill arrays
    let positionIndex = 0;
    for (let i = 0; i < featureCount; i++) {
        const feature = features[i];
        // Feature ID
        featureIds[i] = feature.id;
        // Times (relative to offset)
        startTimes[i] = feature.timeRange?.start !== undefined
            ? feature.timeRange.start - timeOffset
            : -Infinity;
        endTimes[i] = feature.timeRange?.end !== undefined
            ? feature.timeRange.end - timeOffset
            : Infinity;
        // Position offset for non-point geometries
        if (positionOffsets) {
            positionOffsets[i] = positionIndex / 2;
        }
        // Positions
        for (const [lon, lat] of feature.positions) {
            positions[positionIndex++] = lon;
            positions[positionIndex++] = lat;
        }
        // Properties
        if (feature.properties) {
            for (const [key, value] of Object.entries(feature.properties)) {
                if (typeof value === 'number' && numericProps[key]) {
                    numericProps[key].push(value);
                }
                else if (typeof value === 'string' && categoricalProps[key]) {
                    const cat = categoricalProps[key];
                    if (!cat.indexMap.has(value)) {
                        cat.indexMap.set(value, cat.values.length);
                        cat.values.push(value);
                    }
                }
            }
        }
    }
    // Final position offset
    if (positionOffsets) {
        positionOffsets[featureCount] = positionIndex / 2;
    }
    // Convert numeric properties to typed arrays
    const numericProperties = {};
    for (const [key, values] of Object.entries(numericProps)) {
        numericProperties[key] = new Float32Array(values);
    }
    // Convert categorical properties
    const categoricalProperties = {};
    for (const [key, cat] of Object.entries(categoricalProps)) {
        const indices = new Uint8Array(featureCount);
        for (let i = 0; i < featureCount; i++) {
            const value = features[i].properties?.[key];
            if (typeof value === 'string') {
                indices[i] = cat.indexMap.get(value) ?? 0;
            }
        }
        categoricalProperties[key] = {
            indices,
            categories: cat.values,
        };
    }
    return {
        featureCount,
        geometryType,
        positions,
        positionOffsets,
        featureIds,
        startTimes,
        endTimes,
        timeOffset,
        numericProperties,
        categoricalProperties,
    };
}
/**
 * Create empty binary features structure
 */
function createEmptyBinaryFeatures() {
    return {
        featureCount: 0,
        geometryType: 0,
        positions: new Float64Array(0),
        featureIds: new Uint32Array(0),
        startTimes: new Float32Array(0),
        endTimes: new Float32Array(0),
        timeOffset: 0,
        numericProperties: {},
        categoricalProperties: {},
    };
}
/**
 * Get position for a point feature from binary data
 */
export function getBinaryPosition(binary, featureIndex) {
    const offset = featureIndex * 2;
    return [binary.positions[offset], binary.positions[offset + 1]];
}
/**
 * Get path positions for a line/polygon feature from binary data
 */
export function getBinaryPath(binary, featureIndex) {
    if (!binary.positionOffsets) {
        // Point geometry - single position
        return [getBinaryPosition(binary, featureIndex)];
    }
    const startOffset = binary.positionOffsets[featureIndex] * 2;
    const endOffset = binary.positionOffsets[featureIndex + 1] * 2;
    const path = [];
    for (let i = startOffset; i < endOffset; i += 2) {
        path.push([binary.positions[i], binary.positions[i + 1]]);
    }
    return path;
}
/**
 * Calculate memory size of binary features (for cache management)
 */
export function getBinaryFeaturesSize(binary) {
    let size = binary.positions.byteLength;
    size += binary.featureIds.byteLength;
    size += binary.startTimes.byteLength;
    size += binary.endTimes.byteLength;
    if (binary.positionOffsets) {
        size += binary.positionOffsets.byteLength;
    }
    for (const arr of Object.values(binary.numericProperties)) {
        size += arr.byteLength;
    }
    for (const { indices } of Object.values(binary.categoricalProperties)) {
        size += indices.byteLength;
    }
    return size;
}
//# sourceMappingURL=binary-features.js.map