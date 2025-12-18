/**
 * Buffer Pool for Typed Arrays
 *
 * Reuses typed array buffers to reduce garbage collection pressure during
 * high-frequency tile decoding. This is particularly important for 120fps
 * rendering where GC pauses can cause frame drops.
 *
 * Usage:
 * - Call getFloat32Array(size) to get a buffer (may be reused)
 * - Call release(buffer) when done to return it to the pool
 * - Buffers are bucketed by size for efficient reuse
 *
 * Performance characteristics:
 * - O(1) get/release operations
 * - Memory bounded by maxPoolSize per bucket
 * - Automatic bucket creation for new sizes
 */
/**
 * Generic typed array buffer pool
 */
declare class TypedArrayPool<T extends Float32Array | Float64Array | Uint8Array | Uint32Array | Int32Array> {
    private pools;
    private createFn;
    constructor(createFn: (size: number) => T);
    /**
     * Get a buffer of the specified size.
     * Returns a pooled buffer if available, otherwise creates a new one.
     */
    get(size: number): T;
    /**
     * Return a buffer to the pool for reuse.
     * The buffer should not be used after calling release().
     */
    release(buffer: T): void;
    /**
     * Clear all pooled buffers (for cleanup/memory pressure)
     */
    clear(): void;
    /**
     * Get pool statistics for debugging
     */
    getStats(): {
        bucketCount: number;
        totalBuffers: number;
        sizes: number[];
    };
}
/**
 * Global buffer pool interface
 */
export declare const BufferPool: {
    /**
     * Get a Float32Array buffer of the specified size
     */
    getFloat32Array(size: number): Float32Array;
    /**
     * Get a Float64Array buffer of the specified size
     */
    getFloat64Array(size: number): Float64Array;
    /**
     * Get a Uint8Array buffer of the specified size
     */
    getUint8Array(size: number): Uint8Array;
    /**
     * Get a Uint32Array buffer of the specified size
     */
    getUint32Array(size: number): Uint32Array;
    /**
     * Get an Int32Array buffer of the specified size
     */
    getInt32Array(size: number): Int32Array;
    /**
     * Release a Float32Array buffer back to the pool
     */
    releaseFloat32Array(buffer: Float32Array): void;
    /**
     * Release a Float64Array buffer back to the pool
     */
    releaseFloat64Array(buffer: Float64Array): void;
    /**
     * Release a Uint8Array buffer back to the pool
     */
    releaseUint8Array(buffer: Uint8Array): void;
    /**
     * Release a Uint32Array buffer back to the pool
     */
    releaseUint32Array(buffer: Uint32Array): void;
    /**
     * Release an Int32Array buffer back to the pool
     */
    releaseInt32Array(buffer: Int32Array): void;
    /**
     * Clear all pooled buffers (for cleanup or memory pressure)
     */
    clear(): void;
    /**
     * Get pool statistics for debugging
     */
    getStats(): {
        float32: ReturnType<TypedArrayPool<Float32Array>["getStats"]>;
        float64: ReturnType<TypedArrayPool<Float64Array>["getStats"]>;
        uint8: ReturnType<TypedArrayPool<Uint8Array>["getStats"]>;
        uint32: ReturnType<TypedArrayPool<Uint32Array>["getStats"]>;
        int32: ReturnType<TypedArrayPool<Int32Array>["getStats"]>;
    };
};
export {};
//# sourceMappingURL=buffer-pool.d.ts.map