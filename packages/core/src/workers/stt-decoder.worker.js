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
// Worker global scope (using globalThis for type safety)
const workerSelf = globalThis;
/**
 * Handle incoming messages from the main thread
 */
workerSelf.onmessage = async (event) => {
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
        const transferables = [];
        for (const layer of tile.layers) {
            const features = layer.features;
            transferables.push(features.positions.buffer);
            transferables.push(features.featureIds.buffer);
            transferables.push(features.startTimes.buffer);
            transferables.push(features.endTimes.buffer);
            if (features.startIndices) {
                transferables.push(features.startIndices.buffer);
            }
            for (const arr of Object.values(features.numericProps)) {
                transferables.push(arr.buffer);
            }
            for (const { indices } of Object.values(features.categoricalProps)) {
                transferables.push(indices.buffer);
            }
        }
        const result = {
            type: 'result',
            id,
            tile,
            transferables,
        };
        // Transfer buffers to main thread (zero-copy)
        workerSelf.postMessage(result, transferables);
    }
    catch (error) {
        const errorResult = {
            type: 'error',
            id,
            error: error instanceof Error ? error.message : String(error),
        };
        workerSelf.postMessage(errorResult);
    }
};
//# sourceMappingURL=stt-decoder.worker.js.map