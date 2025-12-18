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
import { decodeTile } from './tile';
import { decompress } from './compression';
// Version is injected during build, fallback for development
// @ts-ignore TS2304: Cannot find name '__VERSION__'.
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';
// Worker pool for parallel decoding
let workerPool = [];
let workerIndex = 0;
let pendingRequests = new Map();
let requestIdCounter = 0;
let workerInitAttempted = false;
let inlineWorkerUrl = null;
// Detect if workers are supported
const WORKERS_SUPPORTED = typeof Worker !== 'undefined';
/**
 * Create a worker URL from inline code (fallback for production deployments)
 * This uses the bundled worker code embedded as base64
 */
async function getInlineWorkerUrl() {
    if (inlineWorkerUrl)
        return inlineWorkerUrl;
    try {
        // Dynamically import the inline worker module
        // This is generated during the build process
        const { createWorkerURL } = await import('./workers/inline-worker');
        inlineWorkerUrl = createWorkerURL();
        return inlineWorkerUrl;
    }
    catch (error) {
        console.warn('[STTLoader] Inline worker not available:', error);
        return null;
    }
}
/**
 * Try to create a worker from a URL, with error handling
 */
function tryCreateWorker(url) {
    try {
        const worker = new Worker(url, { type: 'module' });
        return worker;
    }
    catch (_error) {
        return null;
    }
}
/**
 * Set up worker message handlers
 */
function setupWorkerHandlers(worker) {
    worker.onmessage = (event) => {
        const { type, id, tile, error } = event.data;
        const pending = pendingRequests.get(id);
        if (!pending)
            return;
        pendingRequests.delete(id);
        if (type === 'error') {
            pending.reject(new Error(error));
        }
        else {
            pending.resolve(tile);
        }
    };
    worker.onerror = (error) => {
        console.error('[STTLoader] Worker error:', error);
        // Reject all pending requests for this worker
        // The next decode attempt will recreate workers
        for (const [_id, pending] of pendingRequests) {
            pending.reject(new Error('Worker error'));
        }
        pendingRequests.clear();
        // Clear worker pool to trigger recreation
        terminateWorkerPool();
    };
}
/**
 * Initialize worker pool with fallback strategies
 *
 * PERFORMANCE: Pool size increased to 8 (from 4) to better utilize modern CPUs
 * and parallelize tile decompression + protobuf decoding.
 */
async function initWorkerPool(poolSize = navigator?.hardwareConcurrency || 4) {
    if (workerPool.length > 0)
        return;
    if (workerInitAttempted)
        return;
    workerInitAttempted = true;
    // Only create workers in browser environment with worker support
    if (!WORKERS_SUPPORTED)
        return;
    // Allow up to 8 workers to maximize parallelism for tile decoding
    const targetPoolSize = Math.min(poolSize, 8);
    // Strategy 1: Try the bundled worker file
    try {
        const bundledWorkerUrl = new URL('./workers/stt-decoder.worker.bundled.js', import.meta.url);
        const testWorker = tryCreateWorker(bundledWorkerUrl);
        if (testWorker) {
            setupWorkerHandlers(testWorker);
            workerPool.push(testWorker);
            // Create remaining workers
            for (let i = 1; i < targetPoolSize; i++) {
                const worker = tryCreateWorker(bundledWorkerUrl);
                if (worker) {
                    setupWorkerHandlers(worker);
                    workerPool.push(worker);
                }
            }
            if (workerPool.length > 0) {
                console.log(`[STTLoader] Initialized ${workerPool.length} workers (bundled)`);
                return;
            }
        }
    }
    catch (error) {
        // Bundled worker failed, try fallback
    }
    // Strategy 2: Try inline worker (blob URL from embedded code)
    try {
        const inlineUrl = await getInlineWorkerUrl();
        if (inlineUrl) {
            for (let i = 0; i < targetPoolSize; i++) {
                const worker = tryCreateWorker(inlineUrl);
                if (worker) {
                    setupWorkerHandlers(worker);
                    workerPool.push(worker);
                }
            }
            if (workerPool.length > 0) {
                console.log(`[STTLoader] Initialized ${workerPool.length} workers (inline)`);
                return;
            }
        }
    }
    catch (error) {
        // Inline worker failed
    }
    // Strategy 3: Main thread fallback (no workers)
    console.warn('[STTLoader] Worker initialization failed, using main thread decoding');
}
/**
 * Decode tile using worker pool
 */
async function decodeWithWorker(arrayBuffer, tileId, compression) {
    if (workerPool.length === 0) {
        await initWorkerPool();
    }
    if (workerPool.length === 0) {
        // Workers not available, fall back to main thread
        return decodeMainThread(arrayBuffer, tileId, compression);
    }
    return new Promise((resolve, reject) => {
        const id = requestIdCounter++;
        pendingRequests.set(id, { resolve, reject });
        // Round-robin worker selection
        const worker = workerPool[workerIndex % workerPool.length];
        workerIndex++;
        // PERFORMANCE: Transfer buffer directly without copying
        // This eliminates an O(n) copy operation for each tile.
        // The buffer becomes detached after transfer, but the worker owns it now.
        // If worker decode fails, we'll fetch the tile again rather than keeping a copy.
        worker.postMessage({
            type: 'decode',
            id,
            data: arrayBuffer,
            tileId,
            compression,
        }, [arrayBuffer]); // Zero-copy transfer to worker
    });
}
/**
 * Decode tile on main thread
 */
async function decodeMainThread(arrayBuffer, tileId, compression) {
    const compressed = new Uint8Array(arrayBuffer);
    const data = await decompress(compressed, compression);
    return decodeTile(data, tileId);
}
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
export const STTLoader = {
    // Type markers for TypeScript inference
    dataType: null,
    batchType: null, // No batch support
    // Loader identification
    name: 'STT',
    id: 'stt',
    module: 'stt',
    version: VERSION,
    // File format detection
    extensions: ['stt'],
    mimeTypes: ['application/vnd.stt', 'application/octet-stream'],
    // Format characteristics
    binary: true,
    text: false,
    // Category for standardized output structure
    category: 'geometry',
    // Worker support - disabled for loaders.gl's default worker spawning
    // We use our own worker pool in this module instead (see initWorkerPool)
    worker: false,
    // Default options
    options: {
        stt: {
            tileId: null,
            compression: 0,
            disableWorker: false,
        }
    },
    // Parse functions
    parse,
    parseSync,
};
/**
 * Parse compressed tile data asynchronously
 *
 * IMPORTANT: Worker decode uses zero-copy transfer, which detaches the ArrayBuffer.
 * If worker fails, we cannot retry with the same buffer - the error will propagate
 * up and the caller should re-fetch the tile.
 */
async function parse(arrayBuffer, options, _context) {
    const tileId = options?.stt?.tileId;
    const compression = options?.stt?.compression ?? 0;
    const disableWorker = options?.stt?.disableWorker ?? false;
    if (!tileId) {
        throw new Error('STTLoader: tileId is required in options.stt.tileId');
    }
    // Use worker unless disabled or not supported
    if (!disableWorker && WORKERS_SUPPORTED && workerPool.length > 0) {
        // Worker decode uses zero-copy transfer - buffer becomes detached after this
        // If it fails, the error propagates and caller must re-fetch
        return await decodeWithWorker(arrayBuffer, tileId, compression);
    }
    // Try to initialize workers for future requests
    if (!disableWorker && WORKERS_SUPPORTED && !workerInitAttempted) {
        // Don't await - let this happen in background
        initWorkerPool().catch(() => { });
    }
    return decodeMainThread(arrayBuffer, tileId, compression);
}
/**
 * Parse tile data synchronously (assumes already decompressed)
 */
function parseSync(arrayBuffer, options, _context) {
    const tileId = options?.stt?.tileId;
    if (!tileId) {
        throw new Error('STTLoader: tileId is required in options.stt.tileId');
    }
    // Assume already decompressed for sync parsing
    const data = new Uint8Array(arrayBuffer);
    return decodeTile(data, tileId);
}
/**
 * Terminate all workers in the pool
 * Call this when cleaning up the application
 */
export function terminateWorkerPool() {
    for (const worker of workerPool) {
        worker.terminate();
    }
    workerPool = [];
    pendingRequests.clear();
    workerInitAttempted = false;
    // Clean up inline worker URL if created
    if (inlineWorkerUrl) {
        URL.revokeObjectURL(inlineWorkerUrl);
        inlineWorkerUrl = null;
    }
}
/**
 * Get worker pool status for debugging
 */
export function getWorkerPoolStatus() {
    return {
        workerCount: workerPool.length,
        pendingRequests: pendingRequests.size,
        supported: WORKERS_SUPPORTED,
    };
}
//# sourceMappingURL=stt-loader.js.map