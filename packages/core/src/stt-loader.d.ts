/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 *
 * Output is always in binary format (BinaryFeatures) for GPU-efficient rendering.
 *
 * Performance optimizations (120fps target):
 * - Worker pool sized to hardware concurrency (up to 8 workers)
 * - Zero-copy buffer transfer to workers via Transferable
 * - Fallback to main thread only on worker failure
 */
import type { Tile, TileId, Compression } from './types';
import type { LoaderOptions, LoaderContext } from '@loaders.gl/loader-utils';
/**
 * Options specific to the STT loader
 */
export interface STTOptions {
    /** Tile ID for decoding delta-encoded coordinates (required) */
    tileId?: TileId | null;
    /** Compression method: 0 = None, 1 = Gzip, 2 = Brotli */
    compression?: Compression;
    /** Force main thread decoding if true (disables worker) */
    disableWorker?: boolean;
}
/**
 * STT Loader options extending loaders.gl LoaderOptions
 */
export type STTLoaderOptions = LoaderOptions & {
    stt?: STTOptions;
};
/**
 * STT Loader for loaders.gl integration
 *
 * Handles parsing and decompression of spatiotemporal tiles in the .stt format.
 * Supports Gzip and Brotli compression.
 *
 * Output is always in binary format with typed arrays for GPU-efficient rendering.
 *
 * @example
 * ```typescript
 * import { load } from '@loaders.gl/core';
 * import { STTLoader } from '@stt/core';
 *
 * const tile = await load(url, STTLoader, {
 *   stt: { tileId: { z: 0, x: 0, y: 0, t: Date.now() } }
 * });
 *
 * // tile.layers[0].features is BinaryFeatures (typed arrays)
 * ```
 */
export declare const STTLoader: {
    readonly dataType: Tile;
    readonly batchType: never;
    readonly name: "STT";
    readonly id: "stt";
    readonly module: "stt";
    readonly version: string;
    readonly extensions: ["stt"];
    readonly mimeTypes: ["application/vnd.stt", "application/octet-stream"];
    readonly binary: true;
    readonly text: false;
    readonly category: "geometry";
    readonly worker: false;
    readonly options: {
        readonly stt: {
            readonly tileId: null;
            readonly compression: 0;
            readonly disableWorker: false;
        };
    };
    readonly parse: typeof parse;
    readonly parseSync: typeof parseSync;
};
/**
 * Parse compressed tile data asynchronously
 *
 * IMPORTANT: Worker decode uses zero-copy transfer, which detaches the ArrayBuffer.
 * If worker fails, we cannot retry with the same buffer - the error will propagate
 * up and the caller should re-fetch the tile.
 */
declare function parse(arrayBuffer: ArrayBuffer, options?: STTLoaderOptions, _context?: LoaderContext): Promise<Tile>;
/**
 * Parse tile data synchronously (assumes already decompressed)
 */
declare function parseSync(arrayBuffer: ArrayBuffer, options?: STTLoaderOptions, _context?: LoaderContext): Tile;
/**
 * Terminate all workers in the pool
 * Call this when cleaning up the application
 */
export declare function terminateWorkerPool(): void;
/**
 * Get worker pool status for debugging
 */
export declare function getWorkerPoolStatus(): {
    workerCount: number;
    pendingRequests: number;
    supported: boolean;
};
export {};
//# sourceMappingURL=stt-loader.d.ts.map