/**
 * STT Decoder Worker
 *
 * Offloads protobuf decoding and decompression from the main thread.
 * This worker is used by the STTLoader when worker support is enabled.
 */
import { decodeTile } from '../tile';
import { decompress } from '../compression';
import { tileToBinaryTile } from '../binary-features';
// Worker global scope (using globalThis for type safety)
const workerSelf = globalThis;
/**
 * Handle incoming messages from the main thread
 */
workerSelf.onmessage = async (event) => {
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
            const transferables = [];
            for (const layer of binaryTile.layers) {
                transferables.push(layer.features.positions.buffer);
                transferables.push(layer.features.featureIds.buffer);
                transferables.push(layer.features.startTimes.buffer);
                transferables.push(layer.features.endTimes.buffer);
                if (layer.features.positionOffsets) {
                    transferables.push(layer.features.positionOffsets.buffer);
                }
                for (const arr of Object.values(layer.features.numericProperties)) {
                    transferables.push(arr.buffer);
                }
                for (const { indices } of Object.values(layer.features.categoricalProperties)) {
                    transferables.push(indices.buffer);
                }
            }
            const result = {
                type: 'result',
                id,
                tile: binaryTile,
                transferables,
            };
            // Transfer buffers to main thread (zero-copy)
            workerSelf.postMessage(result, transferables);
        }
        else {
            // Return standard object format
            const result = {
                type: 'result',
                id,
                tile,
            };
            workerSelf.postMessage(result);
        }
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