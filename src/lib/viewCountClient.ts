import { doc, getDoc, increment, updateDoc } from 'firebase/firestore';
import { auth, db } from './firebase';

const VIEWER_TOKEN_STORAGE_KEY = 'bx_viewer_token_v1';
const VIEW_SESSION_PREFIX = 'bx_last_view_';
const CLIENT_DEDUP_WINDOW_MS = 30 * 60 * 1000;

/**
 * Returns or generates a persistent anonymous browser visitor token.
 * Never stores or transmits PII.
 */
export function getOrCreateAnonymousViewerToken(): string {
  if (typeof window === 'undefined' || !window.localStorage) {
    return 'fallback_server_token';
  }

  try {
    const existing = window.localStorage.getItem(VIEWER_TOKEN_STORAGE_KEY);
    if (existing && /^[a-zA-Z0-9_-]{16,64}$/.test(existing)) {
      return existing;
    }

    const randomBytes = new Uint8Array(16);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(randomBytes);
    } else {
      for (let i = 0; i < 16; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }

    const generated = Array.from(randomBytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    window.localStorage.setItem(VIEWER_TOKEN_STORAGE_KEY, generated);
    return generated;
  } catch {
    return 'ephemeral_guest_token';
  }
}

/**
 * Client-side check to determine if the viewer viewed this listing within the last 30 minutes.
 */
export function hasClientRecentlyViewed(listingId: string, nowMs: number = Date.now()): boolean {
  if (typeof window === 'undefined' || !window.sessionStorage) return false;
  try {
    const raw = window.sessionStorage.getItem(`${VIEW_SESSION_PREFIX}${listingId}`);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && nowMs - ts < CLIENT_DEDUP_WINDOW_MS;
  } catch {
    return false;
  }
}

export function markClientViewed(listingId: string, nowMs: number = Date.now()): void {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    window.sessionStorage.setItem(`${VIEW_SESSION_PREFIX}${listingId}`, String(nowMs));
  } catch {
    // Ignore storage quota
  }
}

export interface RecordViewResponse {
  ok: boolean;
  counted: boolean;
  views?: number;
  reason?: string;
}

/**
 * Registers a genuine asset detail page view.
 * Only triggers when an asset's actual detail page is opened.
 * Deduplicates per viewer per 30 minutes. Excludes seller self-views.
 */
export async function recordAssetDetailView(params: {
  listingId: string;
  sellerId?: string | null;
  userUid?: string | null;
}): Promise<RecordViewResponse> {
  const { listingId, sellerId, userUid } = params;
  if (!listingId || !/^[a-zA-Z0-9_-]{1,128}$/.test(listingId)) {
    return { ok: false, counted: false, reason: 'invalid_id' };
  }

  // Prevent seller from counting their own asset
  if (userUid && sellerId && userUid === sellerId) {
    return { ok: true, counted: false, reason: 'seller_self_view' };
  }

  const now = Date.now();
  if (hasClientRecentlyViewed(listingId, now)) {
    return { ok: true, counted: false, reason: 'deduplicated' };
  }

  markClientViewed(listingId, now);

  // 1. Attempt atomic direct Firestore increment (+1 view allowed by firestore.rules)
  try {
    const listingRef = doc(db, 'listings', listingId);
    await updateDoc(listingRef, {
      views: increment(1),
    });
    const snap = await getDoc(listingRef).catch(() => null);
    const updatedViews = snap && snap.exists() ? Number(snap.data()?.views) || 0 : undefined;
    return {
      ok: true,
      counted: true,
      views: updatedViews,
    };
  } catch {
    // 2. Fall back to server endpoint if direct client write fails
    try {
      const viewerToken = getOrCreateAnonymousViewerToken();
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      if (auth.currentUser) {
        const idToken = await auth.currentUser.getIdToken(false).catch(() => null);
        if (idToken) headers.Authorization = `Bearer ${idToken}`;
      }

      const res = await fetch(`/api/listings/${encodeURIComponent(listingId)}/view`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ viewerToken }),
      });

      if (res.ok) {
        const data = (await res.json()) as RecordViewResponse;
        if (data.ok) return data;
      }
    } catch {
      // Ignore network errors
    }
    return { ok: false, counted: false, reason: 'increment_unavailable' };
  }
}

