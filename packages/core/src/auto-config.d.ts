/**
 * Automated Dataset Configuration from STT Archive Metadata
 *
 * Eliminates manual configuration by automatically discovering and configuring
 * datasets from archive metadata.
 */
import type { STTArchive } from './archive';
export interface AutoDatasetConfig {
    id: string;
    name: string;
    description: string;
    url: string;
    type: 'point' | 'path' | 'heatmap';
    timeRange: {
        start: number;
        end: number;
    };
    timeWindow: number;
    animationSpeed: number;
    initialViewState: {
        longitude: number;
        latitude: number;
        zoom: number;
        pitch?: number;
        bearing?: number;
    };
    prefetch: {
        enabled: boolean;
        timeSteps: number;
        timeIncrement: number;
    };
    legend?: {
        title: string;
        items: Array<{
            color: string;
            label: string;
        }>;
    };
    style: DatasetStyle;
}
export interface DatasetStyle {
    /** Color accessor function based on properties */
    getColor: (properties: Record<string, any>) => [number, number, number, number];
    /** Size/radius accessor function */
    getSize: (properties: Record<string, any>) => number;
    /** Width accessor for paths */
    getWidth: (properties: Record<string, any>) => number;
}
/**
 * Automatically generate dataset configuration from archive metadata
 */
export declare function createAutoDatasetConfig(url: string, archive: STTArchive): Promise<AutoDatasetConfig>;
/**
 * Discover all .stt files in a directory and create configs
 *
 * Note: Browser environment requires explicit URL list.
 * Server-side implementation would scan filesystem.
 */
export declare function discoverDatasets(_baseUrl: string, _archiveFactory: (url: string) => STTArchive): Promise<AutoDatasetConfig[]>;
//# sourceMappingURL=auto-config.d.ts.map