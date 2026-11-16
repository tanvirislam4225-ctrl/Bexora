export function normalizeApiBaseUrl(raw?: string | null): string {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return '';
  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');
  try {
    const parsed = new URL(withoutTrailingSlash);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return '';
    }
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${cleanPath === '/' ? '' : cleanPath}`;
  } catch {
    return '';
  }
}

export function getApiBaseUrl(override?: string | null): string {
  if (override !== undefined) {
    return normalizeApiBaseUrl(override);
  }
  try {
    const envObj = (import.meta as unknown as { env?: Record<string, string | undefined> })?.env;
    return normalizeApiBaseUrl(envObj?.VITE_API_BASE_URL);
  } catch {
    return '';
  }
}

export function buildApiUrl(path: string, baseOverride?: string | null): string {
  const trimmed = String(path || '').trim();
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  const normalizedPath = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const base = getApiBaseUrl(baseOverride);
  if (!base) {
    return normalizedPath;
  }
  return `${base}${normalizedPath}`;
}

export function isCrossOriginApiConfigured(baseOverride?: string | null): boolean {
  return Boolean(getApiBaseUrl(baseOverride));
}

const inFlightGetRequests = new Map<string, Promise<unknown>>();
const clientResponseCache = new Map<string, { expiresAtMs: number; value: unknown }>();
const DEFAULT_CLIENT_CACHE_MAX_ENTRIES = 64;

export function createIdempotencyKey(scope = 'req'): string {
  const safeScope = scope.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'req';
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${safeScope}_${crypto.randomUUID()}`;
    }
  } catch {
    // Fallback below
  }
  return `${safeScope}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function dedupedRequest<T>(
  requestKey: string,
  executor: () => Promise<T>
): Promise<T> {
  const existing = inFlightGetRequests.get(requestKey) as Promise<T> | undefined;
  if (existing) {
    return existing;
  }
  let task: Promise<T> | undefined;
  task = (async () => {
    try {
      return await executor();
    } finally {
      if (task && inFlightGetRequests.get(requestKey) === task) {
        inFlightGetRequests.delete(requestKey);
      }
    }
  })();
  inFlightGetRequests.set(requestKey, task);
  return task;
}

export async function cachedApiGetJson<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
  options?: {
    ttlMs?: number;
    forceRefresh?: boolean;
    shouldCache?: (value: T) => boolean;
  }
): Promise<T> {
  const ttlMs = Math.max(0, options?.ttlMs ?? 12_000);
  const nowMs = Date.now();
  if (!options?.forceRefresh && ttlMs > 0) {
    const cached = clientResponseCache.get(cacheKey);
    if (cached && nowMs < cached.expiresAtMs) {
      return cached.value as T;
    }
    if (cached) {
      clientResponseCache.delete(cacheKey);
    }
  }

  return dedupedRequest<T>(cacheKey, async () => {
    const fresh = await fetcher();
    const allowCache = ttlMs > 0 && (options?.shouldCache ? options.shouldCache(fresh) : true);
    if (allowCache) {
      if (clientResponseCache.size >= DEFAULT_CLIENT_CACHE_MAX_ENTRIES && !clientResponseCache.has(cacheKey)) {
        const oldestKey = clientResponseCache.keys().next().value;
        if (oldestKey !== undefined) {
          clientResponseCache.delete(oldestKey);
        }
      }
      clientResponseCache.set(cacheKey, {
        expiresAtMs: Date.now() + ttlMs,
        value: fresh,
      });
    }
    return fresh;
  });
}

export function invalidateClientApiCache(prefix?: string): void {
  if (!prefix) {
    clientResponseCache.clear();
    return;
  }
  for (const key of Array.from(clientResponseCache.keys())) {
    if (key.startsWith(prefix)) {
      clientResponseCache.delete(key);
    }
  }
}

export function resetClientApiCachesForTests(): void {
  inFlightGetRequests.clear();
  clientResponseCache.clear();
}
