import type { PublicProfile } from '../types';

export interface CachedUser {
  uid: string;
  displayName: string;
  username: string;
  avatarUrl: string;
}

const CACHED_USER_STORAGE_KEY = 'bx_last_user';
const PENDING_OAUTH_REDIRECT_KEY = 'bx_pending_oauth_redirect';

/**
 * Synchronously checks whether Firebase Auth has a persisted `firebase:authUser:*` entry
 * in localStorage (written by `browserLocalPersistence`).
 */
export function hasFirebaseAuthUserKey(): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('firebase:authUser:')) {
        const raw = window.localStorage.getItem(k);
        if (raw && raw !== 'null' && raw.includes('"uid"')) {
          return true;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Synchronously reads cached user display info from localStorage (`bx_last_user`).
 * Returns a CachedUser ONLY if a `firebase:authUser:` key also exists in localStorage.
 */
export function readCachedUser(): CachedUser | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    if (!hasFirebaseAuthUserKey()) {
      return null;
    }
    const raw = window.localStorage.getItem(CACHED_USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedUser> | null;
    if (!parsed || typeof parsed.uid !== 'string' || !parsed.uid.trim()) {
      return null;
    }
    return {
      uid: parsed.uid.trim(),
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName : '',
      username: typeof parsed.username === 'string' ? parsed.username : '',
      avatarUrl: typeof parsed.avatarUrl === 'string' ? parsed.avatarUrl : '',
    };
  } catch {
    return null;
  }
}

/**
 * Persists minimal safe display fields of the signed-in user for zero-flicker initial render.
 */
export function writeCachedUser(
  profile: Pick<PublicProfile, 'uid' | 'displayName' | 'username' | 'avatarUrl'> | CachedUser | null
): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (!profile || !profile.uid) return;
    const payload: CachedUser = {
      uid: String(profile.uid),
      displayName: String(profile.displayName || ''),
      username: String(profile.username || ''),
      avatarUrl: String(profile.avatarUrl || ''),
    };
    window.localStorage.setItem(CACHED_USER_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Non-fatal if storage is restricted
  }
}

/**
 * Clears cached user display info on explicit logout or confirmed signed-out state.
 */
export function clearCachedUser(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.removeItem(CACHED_USER_STORAGE_KEY);
  } catch {
    // Non-fatal
  }
}

/**
 * Marks that an OAuth redirect flow was intentionally initiated via `signInWithRedirect`.
 */
export function markPendingOAuthRedirect(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(PENDING_OAUTH_REDIRECT_KEY, String(Date.now()));
  } catch {
    // Non-fatal
  }
}

/**
 * Checks whether the current page load is returning from an OAuth redirect
 * (either via URL parameters or a localStorage flag set prior to `signInWithRedirect`).
 */
export function shouldCheckAuthRedirectResult(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (
      params.has('code') ||
      params.has('state') ||
      params.has('apiKey') ||
      params.has('mode')
    ) {
      return true;
    }
    if (window.localStorage) {
      const flag = window.localStorage.getItem(PENDING_OAUTH_REDIRECT_KEY);
      if (flag) {
        window.localStorage.removeItem(PENDING_OAUTH_REDIRECT_KEY);
        return true;
      }
    }
  } catch {
    // Non-fatal
  }
  return false;
}
