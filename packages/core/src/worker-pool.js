/**
 * Web Worker Pool for parallel tile decoding
 *
 * Manages a pool of workers to decode tiles off the main thread.
 * Provides automatic load balancing and error handling.
 */
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
export class WorkerPool {
    constructor(options = {}) {
        this.workers = [];
        // Round-robin worker assignment
        this.nextWorkerIndex = 0;
        // Track pending requests by ID
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
        // Performance tracking
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            averageDecodeTime: 0,
        };
        this.workerCount = options.workerCount ?? Math.min(navigator.hardwareConcurrency || 4, 8);
        this.debug = options.debug ?? false;
        this.initializeWorkers();
        if (this.debug) {
            console.log(`[WorkerPool] Initialized with ${this.workerCount} workers`);
        }
    }
    /**
     * Initialize worker pool
     */
    initializeWorkers() {
        for (let i = 0; i < this.workerCount; i++) {
            const worker = new Worker(new URL('./workers/tile-decoder.worker.js', import.meta.url), { type: 'module' });
            worker.onmessage = this.handleWorkerMessage.bind(this);
            worker.onerror = this.handleWorkerError.bind(this);
            this.workers.push(worker);
        }
    }
    /**
     * Decode a tile using the worker pool
     */
    async decodeTile(tileId, compressedData, compression) {
        const startTime = performance.now();
        this.stats.totalRequests++;
        return new Promise((resolve, reject) => {
            // Generate unique request ID
            const requestId = `req-${this.requestIdCounter++}`;
            // Store pending request
            this.pendingRequests.set(requestId, {
                tileId,
                compressedData,
                compression,
                resolve: (tile) => {
                    const decodeTime = performance.now() - startTime;
                    this.stats.successfulRequests++;
                    this.stats.averageDecodeTime =
                        (this.stats.averageDecodeTime * (this.stats.successfulRequests - 1) + decodeTime) /
                            this.stats.successfulRequests;
                    if (this.debug) {
                        console.log(`[WorkerPool] Decoded tile in ${decodeTime.toFixed(2)}ms`);
                    }
                    resolve(tile);
                },
                reject: (error) => {
                    this.stats.failedRequests++;
                    reject(error);
                },
            });
            // Select worker (round-robin)
            const worker = this.workers[this.nextWorkerIndex];
            this.nextWorkerIndex = (this.nextWorkerIndex + 1) % this.workerCount;
            // Send decode request
            const request = {
                type: 'decode',
                id: requestId,
                tileId,
                compressedData,
                compression,
            };
            // Use transferable objects for zero-copy transfer
            worker.postMessage(request, [compressedData.buffer]);
        });
    }
    /**
     * Handle message from worker
     */
    handleWorkerMessage(event) {
        const response = event.data;
        if (response.type === 'success') {
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
                pending.resolve(response.tile);
                this.pendingRequests.delete(response.id);
            }
        }
        else if (response.type === 'error') {
            const pending = this.pendingRequests.get(response.id);
            if (pending) {
                pending.reject(new Error(response.error));
                this.pendingRequests.delete(response.id);
            }
        }
    }
    /**
     * Handle worker error
     */
    handleWorkerError(error) {
        console.error('[WorkerPool] Worker error:', error);
        // Note: We could implement worker recovery/restart here
    }
    /**
     * Clear all worker caches
     */
    clearCaches() {
        for (const worker of this.workers) {
            worker.postMessage({ type: 'clear-cache' });
        }
    }
    /**
     * Get performance statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeWorkers: this.workerCount,
            pendingRequests: this.pendingRequests.size,
            successRate: this.stats.totalRequests > 0
                ? (this.stats.successfulRequests / this.stats.totalRequests) * 100
                : 0,
        };
    }
    /**
     * Terminate all workers
     */
    terminate() {
        for (const worker of this.workers) {
            worker.terminate();
        }
        this.workers = [];
        this.pendingRequests.clear();
        if (this.debug) {
            console.log('[WorkerPool] Terminated all workers');
            console.log('[WorkerPool] Final stats:', this.getStats());
        }
    }
}
// Singleton instance for convenience
let globalWorkerPool = null;
/**
 * Get or create the global worker pool
 */
export function getWorkerPool(options) {
    if (!globalWorkerPool) {
        globalWorkerPool = new WorkerPool(options);
    }
    return globalWorkerPool;
}
/**
 * Terminate the global worker pool
 */
export function terminateWorkerPool() {
    if (globalWorkerPool) {
        globalWorkerPool.terminate();
        globalWorkerPool = null;
    }
}
//# sourceMappingURL=worker-pool.js.map