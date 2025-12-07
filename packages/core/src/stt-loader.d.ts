/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 *
 * Supports:
 * - Worker-based decoding for main thread performance
 * - Binary columnar output for GPU-efficient rendering
 * - Standard object output for compatibility
 */
import type { Tile, TileId, Compression } from './types';
import type { BinaryTile } from './binary-features';
import type { LoaderOptions, LoaderContext } from '@loaders.gl/loader-utils';
/**
 * Output format options
 */
export type STTOutputFormat = 'object' | 'binary';
/**
 * Options specific to the STT loader
 */
export interface STTOptions {
    /** Tile ID for decoding delta-encoded coordinates (required) */
    tileId?: TileId | null;
    /** Compression method: 0 = None, 1 = Gzip, 2 = Brotli */
    compression?: Compression;
    /**
     * Output format:
     * - 'object': Standard Tile object (default, compatible with existing code)
     * - 'binary': BinaryTile with typed arrays (GPU-ready, zero-copy transfer)
     */
    outputFormat?: STTOutputFormat;
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
 * @example
 * ```typescript
 * import { load } from '@loaders.gl/core';
 * import { STTLoader } from '@stt/core';
 *
 * // Standard object output
 * const tile = await load(url, STTLoader, {
 *   stt: { tileId: { z: 0, x: 0, y: 0, t: Date.now() } }
 * });
 *
 * // Binary output for GPU-efficient rendering
 * const binaryTile = await load(url, STTLoader, {
 *   stt: {
 *     tileId: { z: 0, x: 0, y: 0, t: Date.now() },
 *     outputFormat: 'binary'
 *   }
 * });
 * ```
 */
export declare const STTLoader: {
    readonly dataType: Tile | BinaryTile;
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
    readonly worker: true;
    readonly options: {
        readonly stt: {
            readonly tileId: null;
            readonly compression: 0;
            readonly outputFormat: STTOutputFormat;
            readonly disableWorker: false;
        };
    };
    readonly parse: typeof parse;
    readonly parseSync: typeof parseSync;
};
/**
 * Parse compressed tile data asynchronously
 */
declare function parse(arrayBuffer: ArrayBuffer, options?: STTLoaderOptions, _context?: LoaderContext): Promise<Tile | BinaryTile>;
/**
 * Parse tile data synchronously (assumes already decompressed)
 * Note: Always uses main thread and object output format
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