/**
 * Compression utilities for TypeScript
 */

import * as pako from 'pako';
import { Compression } from './types';

/** Decompress data */
export async function decompress(
  data: Uint8Array,
  compression: Compression
): Promise<Uint8Array> {
  switch (compression) {
    case Compression.None:
      return data;
    case Compression.Gzip:
      return pako.ungzip(data);
    case Compression.Brotli:
      throw new Error(
        'Brotli compression is not supported in the browser. ' +
        'Please rebuild your STT files with --compression gzip'
      );
    default:
      throw new Error(`Unknown compression type: ${compression}`);
  }
}

