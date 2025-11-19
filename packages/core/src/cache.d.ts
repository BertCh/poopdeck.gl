/**
 * Simple LRU cache for tiles
 */
export interface CacheEntry<T> {
    value: T;
    size: number;
    lastAccess: number;
}
export declare class LRUCache<T> {
    private cache;
    private maxSize;
    private currentSize;
    constructor(maxSize: number);
    get(key: string): T | undefined;
    set(key: string, value: T, size: number): void;
    has(key: string): boolean;
    clear(): void;
    size(): number;
    private evictLRU;
}
//# sourceMappingURL=cache.d.ts.map