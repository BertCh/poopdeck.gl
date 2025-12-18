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
// Pool size limits
const MAX_POOL_SIZE_PER_BUCKET = 16; // Max buffers per size bucket
const MAX_BUFFER_SIZE = 10000000; // Don't pool buffers larger than 10M elements
/**
 * Generic typed array buffer pool
 */
class TypedArrayPool {
    constructor(createFn) {
        this.pools = new Map();
        this.createFn = createFn;
    }
    /**
     * Get a buffer of the specified size.
     * Returns a pooled buffer if available, otherwise creates a new one.
     */
    get(size) {
        // Don't pool very large buffers - they're rare and we don't want to hog memory
        if (size > MAX_BUFFER_SIZE) {
            return this.createFn(size);
        }
        const pool = this.pools.get(size);
        if (pool && pool.length > 0) {
            return pool.pop();
        }
        return this.createFn(size);
    }
    /**
     * Return a buffer to the pool for reuse.
     * The buffer should not be used after calling release().
     */
    release(buffer) {
        const size = buffer.length;
        // Don't pool very large buffers
        if (size > MAX_BUFFER_SIZE) {
            return;
        }
        let pool = this.pools.get(size);
        if (!pool) {
            pool = [];
            this.pools.set(size, pool);
        }
        // Don't exceed max pool size per bucket
        if (pool.length < MAX_POOL_SIZE_PER_BUCKET) {
            pool.push(buffer);
        }
        // Otherwise let GC collect it
    }
    /**
     * Clear all pooled buffers (for cleanup/memory pressure)
     */
    clear() {
        this.pools.clear();
    }
    /**
     * Get pool statistics for debugging
     */
    getStats() {
        let totalBuffers = 0;
        const sizes = [];
        for (const [size, pool] of this.pools) {
            totalBuffers += pool.length;
            sizes.push(size);
        }
        return {
            bucketCount: this.pools.size,
            totalBuffers,
            sizes: sizes.sort((a, b) => a - b),
        };
    }
}
// Singleton pools for each typed array type
const float32Pool = new TypedArrayPool((size) => new Float32Array(size));
const float64Pool = new TypedArrayPool((size) => new Float64Array(size));
const uint8Pool = new TypedArrayPool((size) => new Uint8Array(size));
const uint32Pool = new TypedArrayPool((size) => new Uint32Array(size));
const int32Pool = new TypedArrayPool((size) => new Int32Array(size));
/**
 * Global buffer pool interface
 */
export const BufferPool = {
    /**
     * Get a Float32Array buffer of the specified size
     */
    getFloat32Array(size) {
        return float32Pool.get(size);
    },
    /**
     * Get a Float64Array buffer of the specified size
     */
    getFloat64Array(size) {
        return float64Pool.get(size);
    },
    /**
     * Get a Uint8Array buffer of the specified size
     */
    getUint8Array(size) {
        return uint8Pool.get(size);
    },
    /**
     * Get a Uint32Array buffer of the specified size
     */
    getUint32Array(size) {
        return uint32Pool.get(size);
    },
    /**
     * Get an Int32Array buffer of the specified size
     */
    getInt32Array(size) {
        return int32Pool.get(size);
    },
    /**
     * Release a Float32Array buffer back to the pool
     */
    releaseFloat32Array(buffer) {
        float32Pool.release(buffer);
    },
    /**
     * Release a Float64Array buffer back to the pool
     */
    releaseFloat64Array(buffer) {
        float64Pool.release(buffer);
    },
    /**
     * Release a Uint8Array buffer back to the pool
     */
    releaseUint8Array(buffer) {
        uint8Pool.release(buffer);
    },
    /**
     * Release a Uint32Array buffer back to the pool
     */
    releaseUint32Array(buffer) {
        uint32Pool.release(buffer);
    },
    /**
     * Release an Int32Array buffer back to the pool
     */
    releaseInt32Array(buffer) {
        int32Pool.release(buffer);
    },
    /**
     * Clear all pooled buffers (for cleanup or memory pressure)
     */
    clear() {
        float32Pool.clear();
        float64Pool.clear();
        uint8Pool.clear();
        uint32Pool.clear();
        int32Pool.clear();
    },
    /**
     * Get pool statistics for debugging
     */
    getStats() {
        return {
            float32: float32Pool.getStats(),
            float64: float64Pool.getStats(),
            uint8: uint8Pool.getStats(),
            uint32: uint32Pool.getStats(),
            int32: int32Pool.getStats(),
        };
    },
};
//# sourceMappingURL=buffer-pool.js.map