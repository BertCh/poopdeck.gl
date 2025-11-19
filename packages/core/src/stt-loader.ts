/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 */

import { decodeTile } from './tile';
import { decompress } from './compression';
import type { Tile, TileId, Compression } from './types';
import type { LoaderWithParser } from '@loaders.gl/loader-utils';
import { getWorkerPool } from './worker-pool';

/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 */
export const STTLoader: LoaderWithParser = {
  name: 'STT',
  id: 'stt',
  module: 'stt',
  version: '1.0.0',
  extensions: ['stt'],
  mimeTypes: ['application/vnd.stt'],
  
  // We implement worker logic via getWorkerPool inside parse, 
  // effectively running the decode on a worker thread if available.
  worker: false,
  
  category: 'geometry',
  
  options: {
    stt: {
      // Tile metadata for decoding
      tileId: null as TileId | null,
      compression: 0 as Compression,
      // Force main thread decoding if true
      disableWorker: false,
    }
  },
  
  // Parse compressed tile data
  parse: async (arrayBuffer: ArrayBuffer, options?: any): Promise<Tile> => {
    const tileId = options?.stt?.tileId;
    const compression = options?.stt?.compression ?? 0;
    const disableWorker = options?.stt?.disableWorker ?? false;
    
    if (!tileId) {
      throw new Error('STTLoader: tileId is required in options.stt.tileId');
    }
    
    // Decompress
    const compressed = new Uint8Array(arrayBuffer);

    if (!disableWorker) {
        // Use worker pool for decoding
        const pool = getWorkerPool();
        try {
            return await pool.decodeTile(tileId, compressed, compression);
        } catch (error) {
            console.warn('STTLoader: Worker decode failed, falling back to main thread', error);
            // Fallback to main thread if worker fails
        }
    }

    const data = await decompress(compressed, compression);
    
    // Decode tile
    const tile = decodeTile(data, tileId);
    
    return tile;
  },
  
  // Parse from ArrayBuffer (already decompressed)
  parseSync: (arrayBuffer: ArrayBuffer, options?: any): Tile => {
    const tileId = options?.stt?.tileId;
    
    if (!tileId) {
      throw new Error('STTLoader: tileId is required in options.stt.tileId');
    }
    
    // Assume already decompressed
    const data = new Uint8Array(arrayBuffer);
    const tile = decodeTile(data, tileId);
    
    return tile;
  }
};





