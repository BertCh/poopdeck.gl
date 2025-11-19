/**
 * STT Loader for loaders.gl integration
 * Handles parsing and decompression of spatiotemporal tiles
 */
import type { Tile, TileId, Compression } from './types';
export declare const STTLoader: {
    name: string;
    id: string;
    module: string;
    version: string;
    extensions: string[];
    mimeTypes: string[];
    worker: boolean;
    category: string;
    options: {
        stt: {
            tileId: TileId | null;
            compression: Compression;
        };
    };
    parse: (arrayBuffer: ArrayBuffer, options?: any) => Promise<Tile>;
    parseSync: (arrayBuffer: ArrayBuffer, options?: any) => Tile;
};
//# sourceMappingURL=stt-loader.d.ts.map