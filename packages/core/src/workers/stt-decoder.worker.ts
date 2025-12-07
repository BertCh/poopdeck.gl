/**
 * STT Decoder Worker
 * 
 * Offloads protobuf decoding and decompression from the main thread.
 * This worker is used by the STTLoader when worker support is enabled.
 */

import { decodeTile } from '../tile';
import { decompress } from '../compression';
import { tileToBinaryTile } from '../binary-features';
import type { TileId, Compression } from '../types';

export interface STTWorkerMessage {
  type: 'decode';
  id: number;
  data: ArrayBuffer;
  tileId: TileId;
  compression: Compression;
  outputFormat: 'object' | 'binary';
}

export interface STTWorkerResult {
  type: 'result';
  id: number;
  tile: unknown;
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
  const { type, id, data, tileId, compression, outputFormat } = event.data;
  
  if (type !== 'decode') {
    return;
  }
  
  try {
    // Decompress the data
    const compressed = new Uint8Array(data);
    const decompressed = await decompress(compressed, compression);
    
    // Decode the tile
    const tile = decodeTile(decompressed, tileId);
    
    // Convert to binary format if requested
    if (outputFormat === 'binary') {
      const binaryTile = tileToBinaryTile(tile);
      
      // Collect transferable buffers for zero-copy transfer
      const transferables: ArrayBuffer[] = [];
      for (const layer of binaryTile.layers) {
        transferables.push(layer.features.positions.buffer as ArrayBuffer);
        transferables.push(layer.features.featureIds.buffer as ArrayBuffer);
        transferables.push(layer.features.startTimes.buffer as ArrayBuffer);
        transferables.push(layer.features.endTimes.buffer as ArrayBuffer);
        
        if (layer.features.positionOffsets) {
          transferables.push(layer.features.positionOffsets.buffer as ArrayBuffer);
        }
        
        for (const arr of Object.values(layer.features.numericProperties)) {
          transferables.push(arr.buffer as ArrayBuffer);
        }
        
        for (const { indices } of Object.values(layer.features.categoricalProperties)) {
          transferables.push(indices.buffer as ArrayBuffer);
        }
      }
      
      const result: STTWorkerResult = {
        type: 'result',
        id,
        tile: binaryTile,
        transferables,
      };
      
      // Transfer buffers to main thread (zero-copy)
      workerSelf.postMessage(result, transferables);
    } else {
      // Return standard object format
      const result: STTWorkerResult = {
        type: 'result',
        id,
        tile,
      };
      
      workerSelf.postMessage(result);
    }
  } catch (error) {
    const errorResult: STTWorkerError = {
      type: 'error',
      id,
      error: error instanceof Error ? error.message : String(error),
    };
    
    workerSelf.postMessage(errorResult);
  }
};
