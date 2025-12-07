/**
 * STT Archive reader using HTTP Range Requests
 */
import { ArchiveMetadata, ArchiveIndex, ArchiveOptions, Tile, TileId, BoundingBox, TimeRange, TileRequestOptions } from './types';
/** STT Archive reader */
export declare class STTArchive {
    url: string;
    private fetchFn;
    private headerCache?;
    private metadataCache?;
    private indexCache?;
    private tileCache;
    private loadOptions?;
    constructor(options: ArchiveOptions | string);
    /** Get archive metadata */
    getMetadata(): Promise<ArchiveMetadata>;
    /** Get archive index */
    getIndex(): Promise<ArchiveIndex>;
    /** Get a specific tile */
    getTile(id: TileId, options?: TileRequestOptions): Promise<Tile | null>;
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
    /** Get header */
    private getHeader;
    private tileIdToKey;
}
//# sourceMappingURL=archive.d.ts.map