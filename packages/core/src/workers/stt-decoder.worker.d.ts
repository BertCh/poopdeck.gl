/**
 * STT Decoder Worker
 *
 * Offloads protobuf decoding and decompression from the main thread.
 * This worker is used by the STTLoader when worker support is enabled.
 *
 * Output is always in binary format (BinaryFeatures) for GPU-efficient rendering.
 */
import type { TileId, Compression, Tile } from '../types';
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
//# sourceMappingURL=stt-decoder.worker.d.ts.map