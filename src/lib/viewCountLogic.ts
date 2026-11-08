/**
 * Deterministic 64-bit pure-JS hash function for browser and Node.js portability.
 * Zero native module dependencies.
 */
function hashStringSafe(str: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c64e6d;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const part1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const part2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `${part1}${part2}`;
}

/**
 * YouTube-style view deduplication window:
 * One qualifying view per viewer per asset within 30 minutes.
 */
export const VIEW_DEDUPLICATION_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export interface ViewerIdentityInput {
  callerUid?: string | null;
  viewerToken?: string | null;
  clientIp?: string | null;
}

/**
 * Derives a privacy-safe, non-PII unique identifier key for deduplication.
 * Authenticated users are keyed by `usr:<uid>`.
 * Anonymous guests are keyed by `anon:<hashed_token_or_ip>`.
 */
export function normalizeViewerKey(input: ViewerIdentityInput): string {
  const cleanUid = String(input.callerUid || '').trim();
  if (cleanUid && /^[a-zA-Z0-9_-]{1,128}$/.test(cleanUid)) {
    return `usr:${cleanUid}`;
  }

  const cleanToken = String(input.viewerToken || '').trim();
  if (cleanToken && cleanToken.length >= 8 && cleanToken.length <= 128) {
    const hash = hashStringSafe(`bexora:view:${cleanToken}`);
    return `anon:${hash}`;
  }

  const cleanIp = String(input.clientIp || '').trim();
  if (cleanIp) {
    const hash = hashStringSafe(`bexora:ip:${cleanIp}`);
    return `ip:${hash}`;
  }

  return 'anon:unknown';
}

/**
 * Checks whether a view event falls inside the deduplication cooldown window.
 */
export function isViewDeduplicated(
  lastViewAtMs: number | undefined | null,
  nowMs: number = Date.now(),
  windowMs: number = VIEW_DEDUPLICATION_WINDOW_MS
): boolean {
  if (typeof lastViewAtMs !== 'number' || !Number.isFinite(lastViewAtMs) || lastViewAtMs <= 0) {
    return false;
  }
  return nowMs - lastViewAtMs < windowMs;
}

/**
 * Evaluates whether an incoming view request qualifies for incrementing the permanent counter.
 */
export function evaluateViewQualification(params: {
  listingId: string;
  sellerId?: string | null;
  viewerKey: string;
  callerUid?: string | null;
  lastViewAtMs?: number | null;
  listingStatus: string;
  nowMs?: number;
  windowMs?: number;
}): {
  qualifies: boolean;
  reason: 'qualified' | 'seller_self_view' | 'deduplicated' | 'inactive_listing' | 'invalid_id';
} {
  const {
    listingId,
    sellerId,
    viewerKey,
    callerUid,
    lastViewAtMs,
    listingStatus,
    nowMs = Date.now(),
    windowMs = VIEW_DEDUPLICATION_WINDOW_MS,
  } = params;

  if (!listingId || !/^[a-zA-Z0-9_-]{1,128}$/.test(listingId)) {
    return { qualifies: false, reason: 'invalid_id' };
  }

  // Only active or reserved public marketplace listings track public views
  if (listingStatus !== 'active' && listingStatus !== 'reserved') {
    return { qualifies: false, reason: 'inactive_listing' };
  }

  // Seller viewing their own listing is excluded from inflating their own counter
  if (callerUid && sellerId && callerUid === sellerId) {
    return { qualifies: false, reason: 'seller_self_view' };
  }

  if (isViewDeduplicated(lastViewAtMs, nowMs, windowMs)) {
    return { qualifies: false, reason: 'deduplicated' };
  }

  return { qualifies: true, reason: 'qualified' };
}

/**
 * Server-side in-memory Sliding Window deduplication cache.
 */
export class ViewDeduplicationCache {
  private cache = new Map<string, number>();
  private readonly windowMs: number;

  constructor(windowMs: number = VIEW_DEDUPLICATION_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  private buildKey(listingId: string, viewerKey: string): string {
    return `${listingId}::${viewerKey}`;
  }

  public hasRecentView(listingId: string, viewerKey: string, nowMs: number = Date.now()): boolean {
    const key = this.buildKey(listingId, viewerKey);
    const last = this.cache.get(key);
    return isViewDeduplicated(last, nowMs, this.windowMs);
  }

  public recordView(listingId: string, viewerKey: string, nowMs: number = Date.now()): void {
    const key = this.buildKey(listingId, viewerKey);
    this.cache.set(key, nowMs);
    // Periodically prune when cache grows large
    if (this.cache.size > 20000) {
      this.pruneExpired(nowMs);
    }
  }

  public pruneExpired(nowMs: number = Date.now()): void {
    for (const [key, timestamp] of this.cache.entries()) {
      if (nowMs - timestamp >= this.windowMs) {
        this.cache.delete(key);
      }
    }
  }

  public size(): number {
    return this.cache.size;
  }

  public clear(): void {
    this.cache.clear();
  }
}

/**
 * Formats a view count number cleanly (e.g. 1 view, 1,420 views).
 */
export function formatViewCount(views: number | undefined | null): string {
  const count = typeof views === 'number' && Number.isFinite(views) ? Math.max(0, Math.floor(views)) : 0;
  return count === 1 ? '1 view' : `${count.toLocaleString('en-US')} views`;
}

/**
 * Formats relative publication time for an asset listing.
 */
export function formatListingPublishedTime(
  createdAtMs: number | undefined | null,
  nowMs: number = Date.now()
): string {
  if (typeof createdAtMs !== 'number' || !Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    return 'Recently';
  }
  const diffMs = Math.max(0, nowMs - createdAtMs);
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  const diffYears = Math.floor(diffDays / 365);
  return `${diffYears}y ago`;
}

