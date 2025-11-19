/**
 * Simple LRU cache for tiles
 */
export class LRUCache {
    constructor(maxSize) {
        this.cache = new Map();
        this.currentSize = 0;
        this.maxSize = maxSize;
    }
    get(key) {
        const entry = this.cache.get(key);
        if (entry) {
            entry.lastAccess = Date.now();
            return entry.value;
        }
        return undefined;
    }
    set(key, value, size) {
        // Evict if necessary
        while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
            this.evictLRU();
        }
        // Add new entry
        this.cache.set(key, {
            value,
            size,
            lastAccess: Date.now(),
        });
        this.currentSize += size;
    }
    has(key) {
        return this.cache.has(key);
    }
    clear() {
        this.cache.clear();
        this.currentSize = 0;
    }
    size() {
        return this.cache.size;
    }
    evictLRU() {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastAccess < oldestTime) {
                oldestTime = entry.lastAccess;
                oldestKey = key;
            }
        }
        if (oldestKey) {
            const entry = this.cache.get(oldestKey);
            this.currentSize -= entry.size;
            this.cache.delete(oldestKey);
        }
    }
}
//# sourceMappingURL=cache.js.map