export interface TtlCacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  size: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, { expiresAtMs: number; value: T }>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private hits = 0;
  private misses = 0;
  private coalesced = 0;

  constructor(private readonly defaultTtlMs = 15_000, private readonly maxEntries = 200) {}

  get(key: string, nowMs = Date.now()): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (nowMs >= entry.expiresAtMs) {
      this.store.delete(key);
      return undefined;
    }
    this.hits += 1;
    return entry.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, nowMs = Date.now()): void {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      expiresAtMs: nowMs + Math.max(1, ttlMs),
      value,
    });
  }

  async getOrCompute(
    key: string,
    compute: () => Promise<T>,
    options?: {
      ttlMs?: number;
      forceRefresh?: boolean;
      shouldCache?: (value: T) => boolean;
      nowMs?: number;
    }
  ): Promise<T> {
    const nowMs = options?.nowMs ?? Date.now();
    if (!options?.forceRefresh) {
      const cached = this.get(key, nowMs);
      if (cached !== undefined) {
        return cached;
      }
      const existingPromise = this.inFlight.get(key);
      if (existingPromise) {
        this.coalesced += 1;
        return existingPromise;
      }
    }

    this.misses += 1;
    let task: Promise<T> | undefined;
    task = (async () => {
      try {
        const result = await compute();
        const allowCache = options?.shouldCache ? options.shouldCache(result) : true;
        if (allowCache) {
          this.set(
            key,
            result,
            options?.ttlMs ?? this.defaultTtlMs,
            options?.nowMs ?? Date.now()
          );
        }
        return result;
      } finally {
        if (task && this.inFlight.get(key) === task) {
          this.inFlight.delete(key);
        }
      }
    })();

    this.inFlight.set(key, task);
    return task;
  }

  invalidate(keyPrefix?: string): void {
    if (!keyPrefix) {
      this.store.clear();
      return;
    }
    for (const k of Array.from(this.store.keys())) {
      if (k.startsWith(keyPrefix)) {
        this.store.delete(k);
      }
    }
  }

  getStats(): TtlCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      size: this.store.size,
    };
  }
}
