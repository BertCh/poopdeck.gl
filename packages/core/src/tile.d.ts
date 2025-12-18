/**
 * Tile decoding utilities
 *
 * Decodes directly to BinaryFeatures format for GPU-efficient rendering.
 * No intermediate Feature objects are created - data goes straight to typed arrays.
 */
import { Tile, TileId } from './types';
/**
 * Decode a tile from Protocol Buffer bytes directly to binary format
 */
export declare function decodeTile(data: Uint8Array, id: TileId): Tile;
//# sourceMappingURL=tile.d.ts.map