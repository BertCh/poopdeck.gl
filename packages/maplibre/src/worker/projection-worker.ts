/**
 * Web Worker body for off-main-thread lon/lat → mercator projection.
 *
 * The body is shipped via the worker pool's blob-URL trick (see
 * projection-pool.ts) so users don't have to wire a separate bundler step for
 * a worker entry. Keep this file dependency-free — it must be valid as a
 * stringified function that takes only `self` and standard typed arrays.
 *
 * Message contract:
 *   request:  { id: number, positions: Float64Array, dimensions: 2 | 3 }
 *   reply:    { id: number, projected: Float32Array }            (transferable)
 *   reply (err): { id: number, error: string }
 */

// The worker is loaded via `URL.createObjectURL(new Blob([…]))` with a
// stringified version of this function. Anything outside `workerMain` is
// metadata that the bundler can strip; only `workerMain` ships to the worker
// runtime.

export function workerMain(): void {
  const MAX_LAT = 85.05112877980659;

  function project(
    positions: Float64Array | Float32Array,
    dimensions: 2 | 3,
  ): Float32Array {
    const count = positions.length / dimensions;
    // Always emit stride-3 (mx, my, alt) so the shader layout is uniform; for
    // 2D inputs we set z=0.
    const out = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const lon = positions[i * dimensions];
      const lat = positions[i * dimensions + 1];
      const x = lon / 360 + 0.5;
      const clamped = lat > MAX_LAT ? MAX_LAT : lat < -MAX_LAT ? -MAX_LAT : lat;
      const sin = Math.sin((clamped * Math.PI) / 180);
      const y = 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = dimensions === 3 ? positions[i * dimensions + 2] : 0;
    }
    return out;
  }

  (self as unknown as { onmessage: (e: MessageEvent) => void }).onmessage = (
    e: MessageEvent,
  ) => {
    const msg = e.data as {
      id: number;
      positions: Float64Array | Float32Array;
      dimensions: 2 | 3;
    };
    try {
      const projected = project(msg.positions, msg.dimensions);
      (self as unknown as {
        postMessage: (data: unknown, transfer?: Transferable[]) => void;
      }).postMessage(
        { id: msg.id, projected },
        [projected.buffer],
      );
    } catch (err) {
      (self as unknown as {
        postMessage: (data: unknown) => void;
      }).postMessage({
        id: msg.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
}
