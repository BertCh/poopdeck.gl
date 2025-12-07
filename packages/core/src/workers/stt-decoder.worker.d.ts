/**
 * STT Decoder Worker
 *
 * Offloads protobuf decoding and decompression from the main thread.
 * This worker is used by the STTLoader when worker support is enabled.
 */
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
//# sourceMappingURL=stt-decoder.worker.d.ts.map