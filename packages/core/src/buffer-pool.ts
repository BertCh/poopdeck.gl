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
const MAX_BUFFER_SIZE = 10_000_000; // Don't pool buffers larger than 10M elements

/**
 * Generic typed array buffer pool
 */
class TypedArrayPool<T extends Float32Array | Float64Array | Uint8Array | Uint32Array | Int32Array> {
  private pools: Map<number, T[]> = new Map();
  private createFn: (size: number) => T;
  
  constructor(createFn: (size: number) => T) {
    this.createFn = createFn;
  }
  
  /**
   * Get a buffer of the specified size.
   * Returns a pooled buffer if available, otherwise creates a new one.
   */
  get(size: number): T {
    // Don't pool very large buffers - they're rare and we don't want to hog memory
    if (size > MAX_BUFFER_SIZE) {
      return this.createFn(size);
    }
    
    const pool = this.pools.get(size);
    if (pool && pool.length > 0) {
      return pool.pop()!;
    }
    
    return this.createFn(size);
  }
  
  /**
   * Return a buffer to the pool for reuse.
   * The buffer should not be used after calling release().
   */
  release(buffer: T): void {
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
  clear(): void {
    this.pools.clear();
  }
  
  /**
   * Get pool statistics for debugging
   */
  getStats(): { bucketCount: number; totalBuffers: number; sizes: number[] } {
    let totalBuffers = 0;
    const sizes: number[] = [];
    
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
const float32Pool = new TypedArrayPool((size: number) => new Float32Array(size));
const float64Pool = new TypedArrayPool((size: number) => new Float64Array(size));
const uint8Pool = new TypedArrayPool((size: number) => new Uint8Array(size));
const uint32Pool = new TypedArrayPool((size: number) => new Uint32Array(size));
const int32Pool = new TypedArrayPool((size: number) => new Int32Array(size));

/**
 * Global buffer pool interface
 */
export const BufferPool = {
  /**
   * Get a Float32Array buffer of the specified size
   */
  getFloat32Array(size: number): Float32Array {
    return float32Pool.get(size);
  },
  
  /**
   * Get a Float64Array buffer of the specified size
   */
  getFloat64Array(size: number): Float64Array {
    return float64Pool.get(size);
  },
  
  /**
   * Get a Uint8Array buffer of the specified size
   */
  getUint8Array(size: number): Uint8Array {
    return uint8Pool.get(size);
  },
  
  /**
   * Get a Uint32Array buffer of the specified size
   */
  getUint32Array(size: number): Uint32Array {
    return uint32Pool.get(size);
  },
  
  /**
   * Get an Int32Array buffer of the specified size
   */
  getInt32Array(size: number): Int32Array {
    return int32Pool.get(size);
  },
  
  /**
   * Release a Float32Array buffer back to the pool
   */
  releaseFloat32Array(buffer: Float32Array): void {
    float32Pool.release(buffer as any);
  },
  
  /**
   * Release a Float64Array buffer back to the pool
   */
  releaseFloat64Array(buffer: Float64Array): void {
    float64Pool.release(buffer as any);
  },
  
  /**
   * Release a Uint8Array buffer back to the pool
   */
  releaseUint8Array(buffer: Uint8Array): void {
    uint8Pool.release(buffer as any);
  },
  
  /**
   * Release a Uint32Array buffer back to the pool
   */
  releaseUint32Array(buffer: Uint32Array): void {
    uint32Pool.release(buffer as any);
  },
  
  /**
   * Release an Int32Array buffer back to the pool
   */
  releaseInt32Array(buffer: Int32Array): void {
    int32Pool.release(buffer as any);
  },
  
  /**
   * Clear all pooled buffers (for cleanup or memory pressure)
   */
  clear(): void {
    float32Pool.clear();
    float64Pool.clear();
    uint8Pool.clear();
    uint32Pool.clear();
    int32Pool.clear();
  },
  
  /**
   * Get pool statistics for debugging
   */
  getStats(): {
    float32: ReturnType<TypedArrayPool<Float32Array>['getStats']>;
    float64: ReturnType<TypedArrayPool<Float64Array>['getStats']>;
    uint8: ReturnType<TypedArrayPool<Uint8Array>['getStats']>;
    uint32: ReturnType<TypedArrayPool<Uint32Array>['getStats']>;
    int32: ReturnType<TypedArrayPool<Int32Array>['getStats']>;
  } {
    return {
      float32: float32Pool.getStats(),
      float64: float64Pool.getStats(),
      uint8: uint8Pool.getStats(),
      uint32: uint32Pool.getStats(),
      int32: int32Pool.getStats(),
    };
  },
};

