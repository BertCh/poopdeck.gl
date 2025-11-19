/**
 * Web Worker Pool for parallel tile decoding
 *
 * Manages a pool of workers to decode tiles off the main thread.
 * Provides automatic load balancing and error handling.
 */
import type { Tile, TileId, Compression } from './types';
export interface WorkerPoolOptions {
    /** Number of workers in the pool */
    workerCount?: number;
    /** Enable verbose logging */
    debug?: boolean;
}
/**
 * Worker pool for parallel tile decoding
 *
 * Usage:
 * ```ts
 * const pool = new WorkerPool({ workerCount: 4 });
 * const tile = await pool.decodeTile(tileId, compressedData, compression);
 * pool.terminate(); // Clean up when done
 * ```
 */
export declare class WorkerPool {
    private workers;
    private workerCount;
    private debug;
    private nextWorkerIndex;
    private pendingRequests;
    private requestIdCounter;
    private stats;
    constructor(options?: WorkerPoolOptions);
    /**
     * Initialize worker pool
     */
    private initializeWorkers;
    /**
     * Decode a tile using the worker pool
     */
    decodeTile(tileId: TileId, compressedData: Uint8Array, compression: Compression): Promise<Tile>;
    /**
     * Handle message from worker
     */
    private handleWorkerMessage;
    /**
     * Handle worker error
     */
    private handleWorkerError;
    /**
     * Clear all worker caches
     */
    clearCaches(): void;
    /**
     * Get performance statistics
     */
    getStats(): {
        activeWorkers: number;
        pendingRequests: number;
        successRate: number;
        totalRequests: number;
        successfulRequests: number;
        failedRequests: number;
        averageDecodeTime: number;
    };
    /**
     * Terminate all workers
     */
    terminate(): void;
}
/**
 * Get or create the global worker pool
 */
export declare function getWorkerPool(options?: WorkerPoolOptions): WorkerPool;
/**
 * Terminate the global worker pool
 */
export declare function terminateWorkerPool(): void;
//# sourceMappingURL=worker-pool.d.ts.map