/**
 * STT Archive reader using HTTP Range Requests
 *
 * Performance optimizations (120fps target):
 * - LRU cache eviction with device-aware limits
 * - Reduced grace period (60s instead of 5min) for faster eviction
 * - Memory pressure detection via navigator.deviceMemory
 */
import { ArchiveMetadata, ArchiveIndex, ArchiveOptions, Tile, TileId, BoundingBox, TimeRange, TileRequestOptions } from './types';
/** STT Archive reader */
export declare class STTArchive {
    url: string;
    private fetchFn;
    private headerCache?;
    private metadataCache?;
    private indexCache?;
    private loadOptions?;
    private tileCache;
    private maxCacheSize;
    private currentCacheBytes;
    private maxCacheBytes;
    private tileEntryIndex;
    private cacheStats;
    constructor(options: ArchiveOptions | string);
    /** Get archive metadata */
    getMetadata(): Promise<ArchiveMetadata>;
    /** Get archive index */
    getIndex(): Promise<ArchiveIndex>;
    /** Get a specific tile */
    getTile(id: TileId, options?: TileRequestOptions): Promise<Tile | null>;
    /**
     * Evict tiles using LRU policy when cache exceeds limits
     */
    private evictIfNeeded;
    /** Get an iterator for tiles in a bounding box and time range */
    getTilesIterator(bounds: BoundingBox, zoom: number, timeRange: TimeRange, options?: TileRequestOptions): AsyncIterable<Tile>;
    /** Get all tiles in a bounding box and time range */
    getTilesInBounds(bounds: BoundingBox, zoom: number, timeRange: TimeRange, options?: TileRequestOptions): Promise<Tile[]>;
    /** Get available tile IDs in a bounding box and time range (without fetching tile data) */
    getTileIdsInBounds(bounds: BoundingBox, zoom: number, timeRange: TimeRange): Promise<TileId[]>;
    /** Prefetch tiles for smooth animation */
    prefetch(bounds: BoundingBox, zoom: number, times: number[], options?: TileRequestOptions): Promise<void>;
    /** Clear tile cache */
    clearCache(): void;
    /** Get cache statistics */
    getCacheStats(): {
        size: number;
        maxSize: number;
        bytes: number;
        maxBytes: number;
        hits: number;
        misses: number;
        evictions: number;
        hitRate: number;
    };
    /** Get header */
    private getHeader;
    private tileIdToKey;
}
//# sourceMappingURL=archive.d.ts.map