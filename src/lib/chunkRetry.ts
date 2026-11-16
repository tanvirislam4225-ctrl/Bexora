import React from 'react';

const CHUNK_RELOAD_STORAGE_KEY = 'bx_chunk_reload_at';
const CHUNK_RELOAD_COOLDOWN_MS = 15_000;

export function isChunkLoadError(error: unknown): boolean {
  const msg =
    error instanceof Error
      ? `${error.name} ${error.message}`
      : typeof error === 'string'
        ? error
        : String(error || '');
  const lower = msg.toLowerCase();
  return (
    lower.includes('failed to fetch dynamically imported module') ||
    lower.includes('error loading dynamically imported module') ||
    lower.includes('importing a module script failed') ||
    lower.includes('loading chunk') ||
    lower.includes('loading css chunk') ||
    lower.includes('unable to preload css')
  );
}

export function canAttemptChunkAutoReload(
  lastReloadAtRaw: string | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!lastReloadAtRaw) return true;
  const parsed = Number(lastReloadAtRaw);
  if (!Number.isFinite(parsed) || parsed <= 0) return true;
  return nowMs - parsed >= CHUNK_RELOAD_COOLDOWN_MS;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function tryClaimChunkReloadWindow(
  storage: StorageLike | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!storage) return false;
  try {
    const lastRaw = storage.getItem(CHUNK_RELOAD_STORAGE_KEY);
    if (!canAttemptChunkAutoReload(lastRaw, nowMs)) {
      return false;
    }
    storage.setItem(CHUNK_RELOAD_STORAGE_KEY, String(nowMs));
    return true;
  } catch {
    return false;
  }
}

let reloadTriggeredInThisPage = false;

export async function clearRuntimeCachesAndReload(): Promise<void> {
  if (typeof window === 'undefined') return;
  try {
    if ('caches' in window) {
      const keys = await window.caches.keys();
      await Promise.all(keys.map((k) => window.caches.delete(k).catch(() => false)));
    }
  } catch {
    // Non-fatal
  }
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.update().catch(() => {})));
    }
  } catch {
    // Non-fatal
  }
  window.location.reload();
}

export function attemptGuardedChunkReload(): boolean {
  if (typeof window === 'undefined' || reloadTriggeredInThisPage) return false;
  const claimed = tryClaimChunkReloadWindow(window.sessionStorage);
  if (!claimed) return false;
  reloadTriggeredInThisPage = true;
  void clearRuntimeCachesAndReload();
  return true;
}

export function lazyWithRetry<T extends React.ComponentType<any>>(
  importer: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> {
  return React.lazy(async () => {
    try {
      return await importer();
    } catch (firstErr) {
      if (!isChunkLoadError(firstErr)) {
        throw firstErr;
      }
      // Retry once after a brief delay for transient network hiccups
      await new Promise((resolve) => setTimeout(resolve, 250));
      try {
        return await importer();
      } catch (secondErr) {
        if (typeof window !== 'undefined' && isChunkLoadError(secondErr)) {
          if (attemptGuardedChunkReload()) {
            return new Promise<{ default: T }>(() => {
              // Keep Suspense fallback mounted while the page reloads cleanly
            });
          }
        }
        throw secondErr;
      }
    }
  });
}
