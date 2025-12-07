/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 * 
 * Supports:
 * - Worker-based decoding for main thread performance
 * - Binary columnar output for GPU-efficient rendering
 * - Standard object output for compatibility
 */

import { decodeTile } from './tile';
import { decompress } from './compression';
import { tileToBinaryTile } from './binary-features';
import type { Tile, TileId, Compression } from './types';
import type { BinaryTile } from './binary-features';
import type { LoaderWithParser, LoaderOptions, LoaderContext } from '@loaders.gl/loader-utils';

// Version is injected during build, fallback for development
// @ts-ignore TS2304: Cannot find name '__VERSION__'.
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '1.0.0';

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

// Worker pool for parallel decoding
let workerPool: Worker[] = [];
let workerIndex = 0;
let pendingRequests: Map<number, { resolve: Function; reject: Function }> = new Map();
let requestIdCounter = 0;

// Detect if workers are supported
const WORKERS_SUPPORTED = typeof Worker !== 'undefined';

/**
 * Initialize worker pool
 */
function initWorkerPool(poolSize: number = navigator?.hardwareConcurrency || 4): void {
  if (workerPool.length > 0) return;
  
  // Only create workers in browser environment with worker support
  if (!WORKERS_SUPPORTED) return;
  
  try {
    for (let i = 0; i < Math.min(poolSize, 4); i++) {
      // Create worker from the bundled worker file
      // In production, this should be the built worker URL
      const workerUrl = new URL('./workers/stt-decoder.worker.js', import.meta.url);
      const worker = new Worker(workerUrl, { type: 'module' });
      
      worker.onmessage = (event) => {
        const { type, id, tile, error } = event.data;
        const pending = pendingRequests.get(id);
        
        if (!pending) return;
        pendingRequests.delete(id);
        
        if (type === 'error') {
          pending.reject(new Error(error));
        } else {
          pending.resolve(tile);
        }
      };
      
      worker.onerror = (error) => {
        console.error('[STTLoader] Worker error:', error);
      };
      
      workerPool.push(worker);
    }
  } catch (error) {
    // Worker creation failed - fall back to main thread
    console.warn('[STTLoader] Worker creation failed, using main thread:', error);
  }
}

/**
 * Decode tile using worker pool
 */
async function decodeWithWorker(
  arrayBuffer: ArrayBuffer,
  tileId: TileId,
  compression: Compression,
  outputFormat: STTOutputFormat
): Promise<Tile | BinaryTile> {
  if (workerPool.length === 0) {
    initWorkerPool();
  }
  
  if (workerPool.length === 0) {
    // Workers not available, fall back to main thread
    return decodeMainThread(arrayBuffer, tileId, compression, outputFormat);
  }
  
  return new Promise((resolve, reject) => {
    const id = requestIdCounter++;
    pendingRequests.set(id, { resolve, reject });
    
    // Round-robin worker selection
    const worker = workerPool[workerIndex % workerPool.length];
    workerIndex++;
    
    worker.postMessage({
      type: 'decode',
      id,
      data: arrayBuffer,
      tileId,
      compression,
      outputFormat,
    }, [arrayBuffer]); // Transfer buffer to worker
  });
}

/**
 * Decode tile on main thread
 */
async function decodeMainThread(
  arrayBuffer: ArrayBuffer,
  tileId: TileId,
  compression: Compression,
  outputFormat: STTOutputFormat
): Promise<Tile | BinaryTile> {
  const compressed = new Uint8Array(arrayBuffer);
  const data = await decompress(compressed, compression);
  const tile = decodeTile(data, tileId);
  
  if (outputFormat === 'binary') {
    return tileToBinaryTile(tile);
  }
  
  return tile;
}

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
export const STTLoader = {
  // Type markers for TypeScript inference
  dataType: null as unknown as Tile | BinaryTile,
  batchType: null as never, // No batch support

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
      outputFormat: 'object' as STTOutputFormat,
      disableWorker: false,
    }
  },

  // Parse functions
  parse,
  parseSync,
} as const satisfies LoaderWithParser<Tile | BinaryTile, never, STTLoaderOptions>;

/**
 * Parse compressed tile data asynchronously
 */
async function parse(
  arrayBuffer: ArrayBuffer,
  options?: STTLoaderOptions,
  _context?: LoaderContext
): Promise<Tile | BinaryTile> {
  const tileId = options?.stt?.tileId;
  const compression = options?.stt?.compression ?? 0;
  const outputFormat = options?.stt?.outputFormat ?? 'object';
  const disableWorker = options?.stt?.disableWorker ?? false;
  
  if (!tileId) {
    throw new Error('STTLoader: tileId is required in options.stt.tileId');
  }
  
  // Use worker unless disabled or not supported
  if (!disableWorker && WORKERS_SUPPORTED) {
    try {
      return await decodeWithWorker(arrayBuffer, tileId, compression, outputFormat);
    } catch (error) {
      // Fall back to main thread on worker error
      console.warn('[STTLoader] Worker decode failed, falling back to main thread:', error);
    }
  }
  
  return decodeMainThread(arrayBuffer, tileId, compression, outputFormat);
}

/**
 * Parse tile data synchronously (assumes already decompressed)
 * Note: Always uses main thread and object output format
 */
function parseSync(
  arrayBuffer: ArrayBuffer,
  options?: STTLoaderOptions,
  _context?: LoaderContext
): Tile {
  const tileId = options?.stt?.tileId;
  
  if (!tileId) {
    throw new Error('STTLoader: tileId is required in options.stt.tileId');
  }
  
  // Assume already decompressed for sync parsing
  const data = new Uint8Array(arrayBuffer);
  const tile = decodeTile(data, tileId);
  
  return tile;
}

/**
 * Terminate all workers in the pool
 * Call this when cleaning up the application
 */
export function terminateWorkerPool(): void {
  for (const worker of workerPool) {
    worker.terminate();
  }
  workerPool = [];
  pendingRequests.clear();
}

/**
 * Get worker pool status for debugging
 */
export function getWorkerPoolStatus(): { 
  workerCount: number; 
  pendingRequests: number;
  supported: boolean;
} {
  return {
    workerCount: workerPool.length,
    pendingRequests: pendingRequests.size,
    supported: WORKERS_SUPPORTED,
  };
}
