/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 */
import { decodeTile } from './tile';
import { decompress } from './compression';
export const STTLoader = {
    name: 'STT',
    id: 'stt',
    module: 'stt',
    version: '1.0.0',
    extensions: ['stt'],
    mimeTypes: ['application/vnd.stt'],
    // Worker support (optional, for heavy decompression)
    worker: false,
    category: 'geometry',
    options: {
        stt: {
            // Tile metadata for decoding
            tileId: null,
            compression: 0,
        }
    },
    // Parse compressed tile data
    parse: async (arrayBuffer, options) => {
        const tileId = options?.stt?.tileId;
        const compression = options?.stt?.compression ?? 0;
        if (!tileId) {
            throw new Error('STTLoader: tileId is required in options.stt.tileId');
        }
        // Decompress
        const compressed = new Uint8Array(arrayBuffer);
        const data = await decompress(compressed, compression);
        // Decode tile
        const tile = decodeTile(data, tileId);
        return tile;
    },
    // Parse from ArrayBuffer (already decompressed)
    parseSync: (arrayBuffer, options) => {
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
//# sourceMappingURL=stt-loader.js.map