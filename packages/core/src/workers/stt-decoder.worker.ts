/**
 * STT Decoder Worker
 * 
 * Offloads protobuf decoding and decompression from the main thread.
 * This worker is used by the STTLoader when worker support is enabled.
 * 
 * Output is always in binary format (BinaryFeatures) for GPU-efficient rendering.
 */

import { decodeTile } from '../tile';
import { decompress } from '../compression';
import type { TileId, Compression, Tile, BinaryFeatures } from '../types';

export interface STTWorkerMessage {
  type: 'decode';
  id: number;
  data: ArrayBuffer;
  tileId: TileId;
  compression: Compression;
}

export interface STTWorkerResult {
  type: 'result';
  id: number;
  tile: Tile;
  transferables?: ArrayBuffer[];
}

export interface STTWorkerError {
  type: 'error';
  id: number;
  error: string;
}

// Worker global scope (using globalThis for type safety)
const workerSelf = globalThis as unknown as {
  onmessage: ((event: MessageEvent<STTWorkerMessage>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

/**
 * Handle incoming messages from the main thread
 */
workerSelf.onmessage = async (event: MessageEvent<STTWorkerMessage>) => {
  const { type, id, data, tileId, compression } = event.data;
  
  if (type !== 'decode') {
    return;
  }
  
  try {
    // Decompress the data
    const compressed = new Uint8Array(data);
    const decompressed = await decompress(compressed, compression);
    
    // Decode the tile (directly produces binary format)
    const tile = decodeTile(decompressed, tileId);
    
    // Collect transferable buffers for zero-copy transfer
    const transferables: ArrayBuffer[] = [];
    for (const layer of tile.layers) {
      const features: BinaryFeatures = layer.features;
      transferables.push(features.positions.buffer as ArrayBuffer);
      transferables.push(features.featureIds.buffer as ArrayBuffer);
      transferables.push(features.startTimes.buffer as ArrayBuffer);
      transferables.push(features.endTimes.buffer as ArrayBuffer);
      
      if (features.startIndices) {
        transferables.push(features.startIndices.buffer as ArrayBuffer);
      }
      
      for (const arr of Object.values(features.numericProps)) {
        transferables.push(arr.buffer as ArrayBuffer);
      }
      
      for (const { indices } of Object.values(features.categoricalProps)) {
        transferables.push(indices.buffer as ArrayBuffer);
      }
    }
    
    const result: STTWorkerResult = {
      type: 'result',
      id,
      tile,
      transferables,
    };
    
    // Transfer buffers to main thread (zero-copy)
    workerSelf.postMessage(result, transferables);
  } catch (error) {
    const errorResult: STTWorkerError = {
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    
    workerSelf.postMessage(errorResult);
  }
};
