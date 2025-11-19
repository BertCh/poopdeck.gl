/**
 * Automated Dataset Configuration from STT Archive Metadata
 *
 * Eliminates manual configuration by automatically discovering and configuring
 * datasets from archive metadata.
 */
/**
 * Calculate optimal animation speed for a dataset
 * Goal: Make the entire dataset play through in a comfortable viewing time (3-10 minutes)
 */
function calculateAnimationSpeed(timeRangeMs, targetPlaybackSeconds = 360) {
    const speedMs = timeRangeMs / targetPlaybackSeconds;
    // Round to nice intervals
    if (speedMs < 1000) {
        return Math.max(100, Math.round(speedMs / 100) * 100);
    }
    else if (speedMs < 60000) {
        return Math.round(speedMs / 1000) * 1000;
    }
    else if (speedMs < 3600000) {
        return Math.round(speedMs / 60000) * 60000;
    }
    else if (speedMs < 86400000) {
        return Math.round(speedMs / 3600000) * 3600000;
    }
    else {
        return Math.round(speedMs / 86400000) * 86400000;
    }
}
/**
 * Calculate optimal time window based on temporal density
 */
function calculateTimeWindow(metadata) {
    const totalTime = metadata.timeRange.end - metadata.timeRange.start;
    const totalFeatures = metadata.statistics?.totalFeatures || 1000;
    // Estimate temporal density (features per time unit)
    const density = totalFeatures / totalTime;
    // Adjust window based on density
    if (density > 0.001) {
        // High density - short window (hours)
        return 3600000;
    }
    else if (density > 0.00001) {
        // Medium density - medium window (days)
        return 86400000;
    }
    else {
        // Low density - large window (weeks)
        return 7 * 86400000;
    }
}
/**
 * Calculate optimal prefetch settings based on data characteristics
 */
function calculatePrefetchSettings(metadata, timeWindow) {
    const totalTime = metadata.timeRange.end - metadata.timeRange.start;
    // For short datasets (< 7 days), prefetch more aggressively
    if (totalTime < 7 * 86400000) {
        return {
            enabled: true,
            timeSteps: 120,
            timeIncrement: Math.max(60000, timeWindow / 2), // At least 1 minute
        };
    }
    // For medium datasets (7 days - 1 year), moderate prefetch
    if (totalTime < 365 * 86400000) {
        return {
            enabled: true,
            timeSteps: 60,
            timeIncrement: Math.max(3600000, timeWindow), // At least 1 hour
        };
    }
    // For long datasets (> 1 year), conservative prefetch
    return {
        enabled: true,
        timeSteps: 50,
        timeIncrement: Math.max(86400000, timeWindow), // At least 1 day
    };
}
/**
 * Generate color scale for numeric properties
 */
function generateColorScale(prop) {
    const min = prop.minValue || 0;
    const max = prop.maxValue || 100;
    // Diverging color scale (yellow -> orange -> red -> dark red)
    return (value) => {
        const normalized = (value - min) / (max - min);
        if (normalized < 0.25) {
            return [255, 237, 160, 200]; // Yellow
        }
        else if (normalized < 0.5) {
            return [254, 178, 76, 200]; // Orange
        }
        else if (normalized < 0.75) {
            return [252, 78, 42, 200]; // Red-Orange
        }
        else if (normalized < 0.9) {
            return [227, 26, 28, 200]; // Red
        }
        else {
            return [177, 0, 38, 200]; // Dark Red
        }
    };
}
/**
 * Generate size scale for numeric properties
 */
function generateSizeScale(prop) {
    const min = prop.minValue || 0;
    const max = prop.maxValue || 100;
    // Logarithmic scale for better visual distribution
    return (value) => {
        const normalized = Math.max(0, (value - min) / (max - min));
        return Math.pow(2, normalized * 6) * 1000; // 1km to 64km range
    };
}
/**
 * Automatically generate dataset configuration from archive metadata
 */
export async function createAutoDatasetConfig(url, archive) {
    const metadata = await archive.getMetadata();
    // Extract ID from URL (filename without extension)
    const filename = url.split('/').pop() || 'dataset';
    const id = filename.replace(/\.stt$/, '');
    // Determine layer type from geometry types
    const geometryTypes = metadata.layers[0]?.geometryTypes || [];
    let type = 'point';
    if (geometryTypes.includes(1)) { // LineString
        type = 'path';
    }
    // Calculate optimal settings
    const timeWindow = calculateTimeWindow(metadata);
    const animationSpeed = calculateAnimationSpeed(metadata.timeRange.end - metadata.timeRange.start);
    const prefetch = calculatePrefetchSettings(metadata, timeWindow);
    // Calculate initial view from bounds
    const { bounds } = metadata;
    const initialViewState = {
        longitude: (bounds.minLon + bounds.maxLon) / 2,
        latitude: (bounds.minLat + bounds.maxLat) / 2,
        zoom: calculateZoomFromBounds(bounds),
        pitch: type === 'path' ? 45 : 0,
        bearing: 0,
    };
    // Generate style from property schemas
    const style = generateStyle(metadata);
    // Generate legend from primary numeric property
    const legend = generateLegend(metadata);
    return {
        id,
        name: metadata.name || id,
        description: metadata.description || `Spatiotemporal dataset: ${id}`,
        url,
        type,
        timeRange: metadata.timeRange,
        timeWindow,
        animationSpeed,
        initialViewState,
        prefetch,
        legend,
        style,
    };
}
/**
 * Calculate appropriate zoom level from bounding box
 */
function calculateZoomFromBounds(bounds) {
    const lonRange = bounds.maxLon - bounds.minLon;
    const latRange = bounds.maxLat - bounds.minLat;
    const maxRange = Math.max(lonRange, latRange);
    // Approximate zoom level
    if (maxRange > 180)
        return 1;
    if (maxRange > 90)
        return 2;
    if (maxRange > 45)
        return 3;
    if (maxRange > 20)
        return 4;
    if (maxRange > 10)
        return 5;
    if (maxRange > 5)
        return 6;
    if (maxRange > 2)
        return 7;
    if (maxRange > 1)
        return 8;
    if (maxRange > 0.5)
        return 9;
    if (maxRange > 0.25)
        return 10;
    if (maxRange > 0.125)
        return 11;
    return 12;
}
/**
 * Generate styling functions from metadata
 */
function generateStyle(metadata) {
    // Find primary numeric property for styling
    const numericProps = metadata.layers[0]?.properties.filter(p => p.type === 'number') || [];
    const primaryProp = numericProps[0];
    let getColor;
    let getSize;
    if (primaryProp) {
        const colorScale = generateColorScale(primaryProp);
        const sizeScale = generateSizeScale(primaryProp);
        getColor = (properties) => {
            const value = properties[primaryProp.name];
            return typeof value === 'number' ? colorScale(value) : [128, 128, 128, 200];
        };
        getSize = (properties) => {
            const value = properties[primaryProp.name];
            return typeof value === 'number' ? sizeScale(value) : 5000;
        };
    }
    else {
        // Default styling
        getColor = () => [74, 144, 226, 200]; // Blue
        getSize = () => 5000; // 5km
    }
    return {
        getColor,
        getSize,
        getWidth: () => 3, // Default width for paths
    };
}
/**
 * Generate legend from metadata
 */
function generateLegend(metadata) {
    const numericProps = metadata.layers[0]?.properties.filter(p => p.type === 'number') || [];
    const primaryProp = numericProps[0];
    if (!primaryProp || primaryProp.minValue === undefined || primaryProp.maxValue === undefined) {
        return undefined;
    }
    const min = primaryProp.minValue;
    const max = primaryProp.maxValue;
    const range = max - min;
    return {
        title: primaryProp.name,
        items: [
            { color: '#FFEDA0', label: `< ${(min + range * 0.25).toFixed(1)}` },
            { color: '#FEB24C', label: `${(min + range * 0.25).toFixed(1)} - ${(min + range * 0.5).toFixed(1)}` },
            { color: '#FC4E2A', label: `${(min + range * 0.5).toFixed(1)} - ${(min + range * 0.75).toFixed(1)}` },
            { color: '#E31A1C', label: `${(min + range * 0.75).toFixed(1)} - ${(min + range * 0.9).toFixed(1)}` },
            { color: '#B10026', label: `≥ ${(min + range * 0.9).toFixed(1)}` },
        ],
    };
}
/**
 * Discover all .stt files in a directory and create configs
 *
 * Note: Browser environment requires explicit URL list.
 * Server-side implementation would scan filesystem.
 */
export async function discoverDatasets(_baseUrl, _archiveFactory) {
    // Note: In browser, you'd need to provide a list of URLs
    // or fetch from an index.json file
    // This is a placeholder for server-side discovery
    throw new Error('Dataset discovery requires explicit URL list in browser environment');
}
//# sourceMappingURL=auto-config.js.map