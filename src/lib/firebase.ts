import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  initializeAuth,
  PopupRedirectResolver,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  User,
} from 'firebase/auth';
import {
  doc,
  enableNetwork,
  getDoc,
  getDocFromServer,
  getFirestore,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  classifyEmailPasswordProbe,
  classifyGoogleProviderProbe,
  extractTokenServiceActivationUrl,
  isTokenServiceDisabledMessage,
  parseStagedRecoverableSession,
  sanitizeCustomerAuthMessage,
  shouldUpdatePersistedTokenServiceFlag,
  StagedRecoverableAuthSession,
  validateImageMagicBytes,
} from './marketplaceLogic';
import {
  classifySessionErrorDisposition,
  resolveEffectiveFirebaseAuthDomain,
  shouldKeepProactiveTokenRefreshEnabled,
} from './authDomainAndPersistenceLogic';
import { buildNotificationId, classifyTokenServiceProbe } from './notificationLogic';
import type { AuthProviderStatus, TokenServiceStatus } from '../types';

const TOKEN_SERVICE_VERIFIED_STORAGE_KEY = 'bx_token_service_verified';
const RECOVERABLE_SESSION_STORAGE_KEY = 'bx_recoverable_session_v1';
const INTENTIONAL_LOGOUT_TS_KEY = 'bx_intentional_logout_at';

let staleTokenClearedNotice: string | null = null;
let lastExpiredSessionProvider = '';
let lastExpiredSessionEmail = '';

function readStagedRecoverableSession(): StagedRecoverableAuthSession | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(RECOVERABLE_SESSION_STORAGE_KEY);
    const parsed = parseStagedRecoverableSession(raw, Date.now());
    if (!parsed && raw) {
      window.localStorage.removeItem(RECOVERABLE_SESSION_STORAGE_KEY);
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStagedRecoverableSession(session: StagedRecoverableAuthSession | null): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (!session) {
      window.localStorage.removeItem(RECOVERABLE_SESSION_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(RECOVERABLE_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Non-fatal if storage access is restricted
  }
}

/**
 * Preserves persisted `firebase:authUser:<apiKey>:[DEFAULT]` (`browserLocalPersistence`) across reloads,
 * browser restarts, and multi-hour/multi-day inactivity so Firebase Auth automatically exchanges its
 * long-lived `refreshToken` for a fresh ID token without ever logging the user out.
 * Cleans up any legacy `bx_recoverable_session_v1` banner metadata when a persisted user record is present.
 */
function initializePersistentAuthStorageCleanly(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const keyPrefix = `firebase:authUser:${String(firebaseConfig.apiKey || '')}:`;
    let hasPersistedUser = false;
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(keyPrefix)) {
        const raw = window.localStorage.getItem(k);
        if (raw && raw.includes('"uid"')) {
          hasPersistedUser = true;
          break;
        }
      }
    }
    if (hasPersistedUser) {
      writeStagedRecoverableSession(null);
    } else {
      const existingStaged = readStagedRecoverableSession();
      if (existingStaged) {
        lastExpiredSessionProvider = existingStaged.providerId || lastExpiredSessionProvider;
        lastExpiredSessionEmail = existingStaged.email || lastExpiredSessionEmail;
      }
    }
  } catch {
    // Non-fatal if storage access is restricted
  }
}

initializePersistentAuthStorageCleanly();

const envCustomAuthDomain =
  typeof import.meta !== 'undefined' &&
  typeof (import.meta as unknown as { env?: Record<string, string> }).env === 'object'
    ? (import.meta as unknown as { env?: Record<string, string> }).env
        ?.VITE_FIREBASE_CUSTOM_AUTH_DOMAIN
    : undefined;

export const EFFECTIVE_FIREBASE_AUTH_DOMAIN = resolveEffectiveFirebaseAuthDomain({
  configuredAuthDomain: String(firebaseConfig.authDomain || ''),
  windowHostname: typeof window !== 'undefined' ? window.location?.hostname : null,
  windowProtocol: typeof window !== 'undefined' ? window.location?.protocol : null,
  envCustomAuthDomain,
});

export const app = initializeApp({
  ...firebaseConfig,
  authDomain: EFFECTIVE_FIREBASE_AUTH_DOMAIN,
});
export default app;
export const auth =
  typeof window !== 'undefined'
    ? initializeAuth(app, {
        persistence: browserLocalPersistence,
        popupRedirectResolver: browserPopupRedirectResolver,
      })
    : getAuth(app);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();
export { signInWithRedirect };

/**
 * Dynamically promotes `auth.config.authDomain` to the highest-priority live-verified BEXORA brand domain
 * (`auth.bexora.com` -> `bexora.com` -> `bexora.ai.studio`) when the backend confirms its `/__/auth/iframe`
 * relay allows cross-origin framing and the current HTTPS origin is authorized.
 */
export function applyPreferredFirebaseAuthDomain(preferredDomain?: string | null): string {
  const resolved = resolveEffectiveFirebaseAuthDomain({
    configuredAuthDomain: EFFECTIVE_FIREBASE_AUTH_DOMAIN,
    windowHostname: typeof window !== 'undefined' ? window.location?.hostname : null,
    windowProtocol: typeof window !== 'undefined' ? window.location?.protocol : null,
    envCustomAuthDomain,
    verifiedBrandAuthDomain: preferredDomain || null,
  });
  if (resolved && typeof auth === 'object' && auth && 'config' in auth) {
    const cfg = (auth as unknown as { config?: { authDomain?: string } }).config;
    if (cfg && cfg.authDomain !== resolved) {
      cfg.authDomain = resolved;
    }
  }
  return resolved;
}

/**
 * Executes Google Sign-In via the verified BEXORA authentication domain (`auth.bexora.com`, `bexora.com`,
 * or `bexora.ai.studio`). If a cross-origin brand relay has not yet been redeployed with updated headers
 * and triggers `auth/network-request-failed`, transparently falls back to same-origin `EFFECTIVE_FIREBASE_AUTH_DOMAIN`
 * so Google Sign-In succeeds immediately without ever exposing `responsive-dragon-tmn89.firebaseapp.com`.
 */
export async function signInWithGoogleResilient(customProvider?: GoogleAuthProvider) {
  const providerToUse = customProvider || googleProvider;
  try {
    return await signInWithPopup(auth, providerToUse);
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as { code?: unknown }).code || '')
        : '';
    const cfg = (auth as unknown as { config?: { authDomain?: string } }).config;
    if (
      code === 'auth/network-request-failed' &&
      cfg?.authDomain &&
      cfg.authDomain !== EFFECTIVE_FIREBASE_AUTH_DOMAIN
    ) {
      cfg.authDomain = EFFECTIVE_FIREBASE_AUTH_DOMAIN;
      return signInWithPopup(auth, providerToUse);
    }
    throw err;
  }
}

export const BOOTSTRAPPED_SUPERADMIN_EMAIL = 'tanvirislam7574@gmail.com';
export const DEFAULT_TOKEN_SERVICE_ACTIVATION_URL = extractTokenServiceActivationUrl(
  '',
  String(firebaseConfig.messagingSenderId || '448578956301'),
  String(firebaseConfig.projectId || '')
);
export const DEFAULT_FIREBASE_AUTH_PROVIDERS_URL = firebaseConfig.projectId
  ? `https://console.firebase.google.com/project/${encodeURIComponent(
      String(firebaseConfig.projectId)
    )}/authentication/providers`
  : 'https://console.firebase.google.com/';
export const DEFAULT_FIREBASE_AUTH_DOMAINS_URL = firebaseConfig.projectId
  ? `https://console.firebase.google.com/project/${encodeURIComponent(
      String(firebaseConfig.projectId)
    )}/authentication/settings`
  : 'https://console.firebase.google.com/';

export function isTokenServiceDisabledError(err: unknown): boolean {
  const raw = err instanceof Error ? err.message : String(err || '');
  return isTokenServiceDisabledMessage(raw);
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId ?? null,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export function extractUserFacingFirestoreError(
  err: unknown,
  fallback = 'Operation could not be completed. Please try again.'
): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (!raw) return fallback;

  let inner = raw;
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<FirestoreErrorInfo>;
      if (typeof parsed.error === 'string' && parsed.error.trim()) {
        inner = parsed.error.trim();
      }
    } catch {
      // Not a JSON-wrapped error
    }
  }

  if (isTokenServiceDisabledMessage(inner)) {
    return 'Your session needs a quick security refresh. Click Reconnect Session or sign in with Google to continue.';
  }
  if (inner.includes('Missing or insufficient permissions')) {
    return 'Permission denied by security rules. Make sure you are signed in with a verified session and have access to this resource.';
  }
  if (inner.includes('Quota exceeded')) {
    return 'Service capacity is temporarily busy. Please wait a moment and retry.';
  }
  if (inner.includes('offline') || inner.includes('unavailable')) {
    return 'Network connection is temporarily unavailable. Check your internet connection and retry.';
  }
  return sanitizeCustomerAuthMessage(inner);
}

let firestoreBootPromise: Promise<void> | null = null;
let sessionPrepPromise: Promise<void> | null = null;
let recoveryInflight: Promise<void> | null = null;
let silentRestoreInflight: Promise<boolean> | null = null;
const activeSilentIframes = new Set<HTMLIFrameElement>();

function cleanupAllSilentIframes(): void {
  activeSilentIframes.forEach((frame) => {
    try {
      frame.remove();
    } catch {
      // Ignore DOM cleanup errors
    }
  });
  activeSilentIframes.clear();
}

function syncPersistedTokenServiceStatus(status: TokenServiceStatus): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const action = shouldUpdatePersistedTokenServiceFlag(status);
  if (action === 'preserve_existing') return;
  try {
    if (action === 'set_verified') {
      window.localStorage.setItem(TOKEN_SERVICE_VERIFIED_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(TOKEN_SERVICE_VERIFIED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode restrictions
  }
}

export function hasPendingRecoverableSession(): boolean {
  return Boolean(readStagedRecoverableSession());
}

/**
 * Marks a live authenticated Firebase session active, clearing any stale logout markers or staged recovery prompts.
 */
export function markAuthenticatedSessionActive(user: User): void {
  staleTokenClearedNotice = null;
  lastExpiredSessionEmail = user.email || '';
  lastExpiredSessionProvider = user.providerData[0]?.providerId || '';
  writeStagedRecoverableSession(null);
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(INTENTIONAL_LOGOUT_TS_KEY);
    } catch {
      // Ignore storage restrictions
    }
  }
}

/**
 * Explicitly clears recoverable session state on intentional user Logout so revisiting or refreshing
 * never auto-signs the user back in after they chose to sign out.
 */
export function clearRecoverableSessionOnLogout(): void {
  staleTokenClearedNotice = null;
  lastExpiredSessionEmail = '';
  lastExpiredSessionProvider = '';
  writeStagedRecoverableSession(null);
  cleanupAllSilentIframes();
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(INTENTIONAL_LOGOUT_TS_KEY, String(Date.now()));
    } catch {
      // Ignore storage restrictions
    }
    try {
      const win = window as unknown as {
        google?: { accounts?: { id?: { disableAutoSelect?: () => void; cancel?: () => void } } };
      };
      win.google?.accounts?.id?.cancel?.();
      win.google?.accounts?.id?.disableAutoSelect?.();
    } catch {
      // Ignore GSI cleanup errors
    }
  }
}

/**
 * Clears the staged continuation banner when the user explicitly dismisses it.
 */
export function dismissRecoverableSessionPrompt(): void {
  staleTokenClearedNotice = null;
  writeStagedRecoverableSession(null);
}

/**
 * Keeps `@firebase/auth`'s native 5-minute `ProactiveRefresh` active by default across all sessions,
 * stopping it ONLY if Google Cloud Token Service (`securetoken.googleapis.com`) is conclusively confirmed `'disabled'`.
 * Never disables `ProactiveRefresh` during startup, offline wake, or `'unable_to_verify'` capability probes.
 */
export function syncProactiveRefreshWithCapabilities(
  user: User | null,
  tokenServiceEnabledOrStatus?: boolean | TokenServiceStatus | null
): void {
  if (!user) return;
  const internalUser = user as unknown as {
    _stopProactiveRefresh?: () => void;
    _startProactiveRefresh?: () => void;
  };
  let keepEnabled = true;
  if (typeof tokenServiceEnabledOrStatus === 'string') {
    keepEnabled = shouldKeepProactiveTokenRefreshEnabled(tokenServiceEnabledOrStatus);
  } else if (tokenServiceEnabledOrStatus === false) {
    keepEnabled = cachedAuthCapabilities?.tokenServiceStatus !== 'disabled';
  }
  if (keepEnabled) {
    internalUser._startProactiveRefresh?.();
  } else {
    internalUser._stopProactiveRefresh?.();
  }
}

interface InternalPopupHandle {
  window: { closed: boolean };
  associatedEvent: string | null;
  close: () => void;
}

interface InternalAuthResolver {
  _initialize(authObj: unknown): Promise<unknown>;
  _originValidation(authObj: unknown): Promise<void>;
  _isIframeWebStorageSupported(authObj: unknown, cb: (supported: boolean) => void): void;
}

/**
 * Official `@firebase/auth` `PopupRedirectResolver`-compatible class that executes silent `prompt=none` OIDC
 * session renewal inside an offscreen `1px × 1px` iframe via `https://${authDomain}/__/auth/handler`
 * and relays the freshly minted Google OIDC token through Firebase's `__/auth/iframe` `AuthRelay`
 * to `identitytoolkit.googleapis.com/v1/accounts:signInWithIdp` — zero popups, zero user clicks,
 * Node/SSR-safe, and zero dependency on `securetoken.googleapis.com`.
 */
class SilentIframePopupRedirectResolver implements InternalAuthResolver {
  private fallbackBrowserResolver: InternalAuthResolver | null = null;

  private getDelegate(authObj: unknown): InternalAuthResolver {
    const existing = (authObj as { _popupRedirectResolver?: InternalAuthResolver })
      ?._popupRedirectResolver;
    if (existing) {
      return existing;
    }
    if (!this.fallbackBrowserResolver && typeof browserPopupRedirectResolver === 'function') {
      const Ctor = browserPopupRedirectResolver as unknown as { new (): InternalAuthResolver };
      this.fallbackBrowserResolver = new Ctor();
    }
    if (!this.fallbackBrowserResolver) {
      throw new Error('auth/operation-not-supported-in-this-environment');
    }
    return this.fallbackBrowserResolver;
  }

  _initialize(authObj: unknown): Promise<unknown> {
    return this.getDelegate(authObj)._initialize(authObj);
  }

  _originValidation(authObj: unknown): Promise<void> {
    return this.getDelegate(authObj)._originValidation(authObj);
  }

  _isIframeWebStorageSupported(
    authObj: unknown,
    cb: (supported: boolean) => void
  ): void {
    this.getDelegate(authObj)._isIframeWebStorageSupported(authObj, cb);
  }

  async _openPopup(
    authObj: {
      config?: { apiKey?: string; authDomain?: string; sdkClientVersion?: string };
      name?: string;
      tenantId?: string | null;
    },
    provider: {
      providerId?: string;
      getCustomParameters?: () => Record<string, string>;
      getScopes?: () => string[];
    },
    authType: string,
    eventId: string
  ): Promise<InternalPopupHandle> {
    const authDomain = String(
      authObj?.config?.authDomain || EFFECTIVE_FIREBASE_AUTH_DOMAIN || firebaseConfig.authDomain || ''
    ).trim();
    const apiKey = String(authObj?.config?.apiKey || firebaseConfig.apiKey || '').trim();
    const params = new URLSearchParams();
    params.set('apiKey', apiKey);
    params.set('appName', String(authObj?.name || '[DEFAULT]'));
    params.set('authType', String(authType));
    params.set('redirectUrl', window.location.href);
    params.set('v', String(authObj?.config?.sdkClientVersion || '11.1.0'));
    params.set('eventId', String(eventId));
    params.set('providerId', String(provider?.providerId || 'google.com'));

    const customParams = provider?.getCustomParameters?.() || {};
    if (Object.keys(customParams).length > 0) {
      params.set('customParameters', JSON.stringify(customParams));
    }
    const scopes = (provider?.getScopes?.() || []).filter((s) => Boolean(s));
    if (scopes.length > 0) {
      params.set('scopes', scopes.join(','));
    }
    if (authObj?.tenantId) {
      params.set('tid', String(authObj.tenantId));
    }

    const handlerUrl = `https://${authDomain}/__/auth/handler?${params.toString()}`;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.style.position = 'fixed';
    iframe.style.left = '-9999px';
    iframe.style.top = '-9999px';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    iframe.style.border = '0';

    const winState = { closed: false };
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      winState.closed = true;
      window.clearTimeout(safetyTimer);
      activeSilentIframes.delete(iframe);
      try {
        iframe.remove();
      } catch {
        // Ignore removal errors
      }
    };

    const safetyTimer = window.setTimeout(cleanup, 5200);
    activeSilentIframes.add(iframe);
    iframe.src = handlerUrl;
    document.body.appendChild(iframe);

    return {
      window: winState,
      associatedEvent: eventId,
      close: cleanup,
    };
  }
}

const silentPopupResolver = SilentIframePopupRedirectResolver as unknown as PopupRedirectResolver;

async function runSilentHandlerOAuthAttempt<T>(
  op: () => Promise<T>,
  timeoutMs = 5600
): Promise<T | null> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;

  const caps = await detectFirebaseAuthCapabilities();
  if (caps.currentDomainAuthorized === false) {
    return null;
  }

  let timeoutId: number | undefined;
  try {
    const result = await Promise.race<T | null>([
      op(),
      new Promise<null>((resolve) => {
        timeoutId = window.setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return result;
  } catch {
    return null;
  } finally {
    if (timeoutId !== undefined) {
      window.clearTimeout(timeoutId);
    }
    cleanupAllSilentIframes();
  }
}

/**
 * Attempts a zero-popup, zero-click 60-minute Firebase ID token renewal for an active Google user
 * via Firebase's authorized `__/auth/handler` (`prompt=none` + `login_hint`) -> `accounts:signInWithIdp`.
 */
export async function attemptSilentGoogleSessionRefresh(user: User): Promise<boolean> {
  const isGoogleUser = user.providerData.some((p) => p.providerId === 'google.com');
  if (!isGoogleUser) {
    return false;
  }

  const hintEmail = (user.email || '').trim();
  const silentProvider = new GoogleAuthProvider();
  silentProvider.setCustomParameters({
    prompt: 'none',
    ...(hintEmail ? { login_hint: hintEmail } : {}),
  });

  const handlerRenewed = await runSilentHandlerOAuthAttempt(() =>
    reauthenticateWithPopup(user, silentProvider, silentPopupResolver)
  );
  if (handlerRenewed?.user) {
    markAuthenticatedSessionActive(handlerRenewed.user);
    const caps = await detectFirebaseAuthCapabilities();
    syncProactiveRefreshWithCapabilities(handlerRenewed.user, caps.tokenServiceEnabled);
    return true;
  }

  return false;
}

/**
 * Silently restores a returning user's Firebase Auth session on website revisit or wake
 * when their 60-minute JWT expired while away and `securetoken.googleapis.com` is disabled.
 * Never fakes authentication: succeeds ONLY when Identity Toolkit cryptographically issues a real Firebase ID token.
 */
export function restoreExpiredSessionSilently(): Promise<boolean> {
  if (silentRestoreInflight) return silentRestoreInflight;
  silentRestoreInflight = (async () => {
    if (auth.currentUser) {
      markAuthenticatedSessionActive(auth.currentUser);
      return true;
    }

    const staged = readStagedRecoverableSession();
    if (!staged) {
      return false;
    }

    lastExpiredSessionEmail = staged.email || lastExpiredSessionEmail;
    lastExpiredSessionProvider = staged.providerId || lastExpiredSessionProvider;

    const isGoogleRecoverable = !staged.providerId || staged.providerId === 'google.com';
    if (isGoogleRecoverable) {
      const silentProvider = new GoogleAuthProvider();
      silentProvider.setCustomParameters({
        prompt: 'none',
        ...(staged.email ? { login_hint: staged.email } : {}),
      });

      const handlerRestored = await runSilentHandlerOAuthAttempt(() =>
        signInWithPopup(auth, silentProvider, silentPopupResolver)
      );
      if (handlerRestored?.user) {
        markAuthenticatedSessionActive(handlerRestored.user);
        const caps = await detectFirebaseAuthCapabilities();
        syncProactiveRefreshWithCapabilities(handlerRestored.user, caps.tokenServiceEnabled);
        return true;
      }
    }

    // Silent background OIDC was blocked by browser privacy rules or requires password sign-in:
    // keep auth unauthenticated (never fake auth) and surface a calm 1-click Continue option.
    staleTokenClearedNotice = staged.email
      ? `Welcome back — click Continue Session to resume as ${staged.email}.`
      : 'Welcome back — click Continue Session to resume your account.';
    return false;
  })().finally(() => {
    silentRestoreInflight = null;
  });
  return silentRestoreInflight;
}

/**
 * Safely recovers an active Firebase Auth session without EVER forcing an automatic logout on normal
 * 60-minute ID token expiry, tab sleep/wake, or transient network interruptions:
 * 1) Attempts native Firebase refresh-token renewal (`getIdToken(true)`) first.
 * 2) Signs out ONLY when Firebase Auth / Identity Toolkit explicitly confirms account revocation
 *    (`USER_DISABLED`, `USER_NOT_FOUND`, `TOKEN_EXPIRED` / `INVALID_REFRESH_TOKEN`).
 * 3) Preserves the persisted session across temporary network or service hiccups.
 */
export function recoverFirestoreFromTokenServiceError(customNotice?: string): Promise<void> {
  if (recoveryInflight) return recoveryInflight;
  recoveryInflight = (async () => {
    if (auth.currentUser) {
      try {
        await auth.currentUser.getIdToken(true);
        markAuthenticatedSessionActive(auth.currentUser);
        return;
      } catch (refreshErr) {
        const disposition = classifySessionErrorDisposition(refreshErr);
        if (disposition === 'sign_out_revoked') {
          writeStagedRecoverableSession(null);
          staleTokenClearedNotice = customNotice || formatFirebaseAuthError(refreshErr);
          await signOut(auth).catch(() => {});
          return;
        }

        if (isTokenServiceDisabledError(refreshErr)) {
          const renewedInPlace = await attemptSilentGoogleSessionRefresh(auth.currentUser);
          if (renewedInPlace) {
            return;
          }
        }
        // Transient network / wake error: preserve persisted session in localStorage (NEVER signOut)
        return;
      }
    }
  })().finally(() => {
    recoveryInflight = null;
  });
  return recoveryInflight;
}

let redirectResultPromise: Promise<User | null> | null = null;

/**
 * Consumes any returning OAuth redirect result once per page load (for mobile/in-app browsers that used
 * `signInWithRedirect` when popups were blocked) and ensures the user's marketplace profile is initialized.
 */
export function consumePendingAuthRedirectResult(): Promise<User | null> {
  if (typeof window === 'undefined') return Promise.resolve(null);
  if (redirectResultPromise) return redirectResultPromise;
  redirectResultPromise = (async () => {
    try {
      const cred = await getRedirectResult(auth, browserPopupRedirectResolver);
      if (cred?.user) {
        markAuthenticatedSessionActive(cred.user);
        syncProactiveRefreshWithCapabilities(cred.user, true);
        await ensureUserProfileInitialized(cred.user).catch(() => {});
        return cred.user;
      }
    } catch {
      // Non-fatal if no redirect operation was pending
    }
    return null;
  })();
  return redirectResultPromise;
}

/**
 * Retrieves a valid Firebase ID token for the currently signed-in user, automatically refreshing an
 * expired 60-minute JWT via the persisted refresh token (`browserLocalPersistence`) and signing out
 * ONLY if the account was genuinely disabled, deleted, or revoked.
 */
export async function getValidFirebaseIdToken(forceRefresh = false): Promise<string> {
  const user = auth.currentUser;
  if (!user) return '';
  try {
    return await user.getIdToken(forceRefresh);
  } catch (err) {
    const disposition = classifySessionErrorDisposition(err);
    if (disposition === 'retry_token_refresh' && !forceRefresh && auth.currentUser) {
      try {
        return await auth.currentUser.getIdToken(true);
      } catch (retryErr) {
        if (classifySessionErrorDisposition(retryErr) === 'sign_out_revoked') {
          writeStagedRecoverableSession(null);
          await signOut(auth).catch(() => {});
        }
        return '';
      }
    }
    if (disposition === 'sign_out_revoked') {
      writeStagedRecoverableSession(null);
      await signOut(auth).catch(() => {});
    }
    return '';
  }
}

/**
 * Performs an authenticated `fetch` with a fresh Firebase Bearer ID token, and if the server responds
 * with HTTP 401 (e.g. clock skew or ID token just crossed 60-minute boundary), forces a single
 * `getIdToken(true)` refresh and retries transparently without logging the user out.
 */
export async function fetchWithFreshBearerToken(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const buildHeaders = (token: string): Headers => {
    const h = new Headers(init.headers || {});
    if (token) {
      h.set('Authorization', `Bearer ${token}`);
    }
    return h;
  };

  const initialToken = await getValidFirebaseIdToken(false);
  const firstResp = await fetch(input, {
    ...init,
    headers: buildHeaders(initialToken),
  });

  if (firstResp.status === 401 && auth.currentUser) {
    const refreshedToken = await getValidFirebaseIdToken(true);
    if (refreshedToken && refreshedToken !== initialToken) {
      return fetch(input, {
        ...init,
        headers: buildHeaders(refreshedToken),
      });
    }
  }

  return firstResp;
}

/**
 * Fast pre-listener check ensuring Firebase Auth finishes hydrating its persisted `browserLocalPersistence`
 * state and refreshes any expired 60-minute ID token cleanly before Firestore listeners attach.
 */
export function ensureFirestoreBootReady(): Promise<void> {
  if (firestoreBootPromise) return firestoreBootPromise;
  firestoreBootPromise = (async () => {
    try {
      if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady();
      }
      if (auth.currentUser) {
        markAuthenticatedSessionActive(auth.currentUser);
        await getValidFirebaseIdToken(false);
      }
    } catch {
      // Non-fatal; allow Firestore public listeners to initialize normally
    }
  })();
  return firestoreBootPromise;
}

/**
 * Validates any persisted Auth session and processes any returning OAuth redirect result.
 */
export function prepareFirestoreAuthSession(): Promise<void> {
  if (sessionPrepPromise) return sessionPrepPromise;
  sessionPrepPromise = (async () => {
    await ensureFirestoreBootReady();
    await consumePendingAuthRedirectResult();
    if (auth.currentUser) {
      markAuthenticatedSessionActive(auth.currentUser);
    }
  })();
  return sessionPrepPromise;
}

export function consumeStaleTokenSessionClearedNotice(): string | null {
  const msg = staleTokenClearedNotice;
  staleTokenClearedNotice = null;
  return msg;
}

export function getLastExpiredSessionInfo(): { email: string; providerId: string } {
  return { email: lastExpiredSessionEmail, providerId: lastExpiredSessionProvider };
}

/**
 * 1-click interactive session renewal via Identity Toolkit (`reauthenticateWithPopup` / `signInWithPopup`)
 * with `login_hint` pre-filled so returning Google accounts reconnect in a single click.
 */
export async function extendCurrentUserSessionInteractive(): Promise<'renewed' | 'open_auth_modal'> {
  const current = auth.currentUser;
  if (current) {
    const isGoogle = current.providerData.some((p) => p.providerId === 'google.com');
    if (!isGoogle) {
      return 'open_auth_modal';
    }
    const hintedProvider = new GoogleAuthProvider();
    if (current.email) {
      hintedProvider.setCustomParameters({ login_hint: current.email });
    }
    await reauthenticateWithPopup(current, hintedProvider);
    markAuthenticatedSessionActive(current);
    const caps = await detectFirebaseAuthCapabilities();
    syncProactiveRefreshWithCapabilities(current, caps.tokenServiceEnabled);
    return 'renewed';
  }

  const staged = readStagedRecoverableSession();
  const providerToUse = staged?.providerId || lastExpiredSessionProvider;
  const hintEmail = staged?.email || lastExpiredSessionEmail;

  if (providerToUse === 'google.com' || !providerToUse) {
    const hintedProvider = new GoogleAuthProvider();
    if (hintEmail) {
      hintedProvider.setCustomParameters({ login_hint: hintEmail });
    }
    const cred = await signInWithGoogleResilient(hintedProvider);
    markAuthenticatedSessionActive(cred.user);
    await ensureUserProfileInitialized(cred.user);
    const caps = await detectFirebaseAuthCapabilities();
    syncProactiveRefreshWithCapabilities(cred.user, caps.tokenServiceEnabled);
    return 'renewed';
  }

  return 'open_auth_modal';
}

let connectionTested = false;
export async function testFirestoreConnection(): Promise<void> {
  if (connectionTested) return;
  connectionTested = true;
  try {
    await prepareFirestoreAuthSession();
    await getDocFromServer(doc(db, 'publicConfig', 'settings'));
  } catch (error) {
    if (isTokenServiceDisabledError(error)) {
      await recoverFirestoreFromTokenServiceError();
      return;
    }
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

const ALLOWED_IMAGE_MIMES = [
  'image/jpeg',
  'image/jpg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'image/webp',
];
const ALLOWED_IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024; // 8 MB raw camera photos accepted before canvas downscaling

/**
 * Validates file MIME type and size, then downscales/compresses onto an offscreen canvas
 * so images persist reliably inside Firestore size bounds (<= 185 KB per image, <= 250 KB rule cap,
 * and <= 750 KB total for 4 listing images or Front+Back NID under Firestore's 1 MB document limit).
 */
export async function validateAndProcessImageFile(
  file: File,
  maxDimension = 960,
  quality = 0.74,
  maxChars = 185_000
): Promise<string> {
  const normalizedType = String(file.type || '').trim().toLowerCase();
  const hasAllowedMime = ALLOWED_IMAGE_MIMES.includes(normalizedType);
  const hasAllowedFallbackExt =
    normalizedType === '' && ALLOWED_IMAGE_EXT_RE.test(String(file.name || ''));
  if (!hasAllowedMime && !hasAllowedFallbackExt) {
    throw new Error('Unsupported image format. Please choose a JPEG, JPG, PNG, or WebP image.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('Image exceeds the 8 MB maximum upload limit. Please choose a smaller photo.');
  }
  if (file.size === 0) {
    throw new Error('Selected file is empty.');
  }

  const headerSlice = await file.slice(0, 16).arrayBuffer();
  const magicCheck = validateImageMagicBytes(new Uint8Array(headerSlice));
  if (!magicCheck.valid) {
    throw new Error(
      magicCheck.error || 'Selected file does not match a valid JPEG, PNG, or WebP signature.'
    );
  }

  const rawDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected image file.'));
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Selected file is not a valid readable image.'));
    element.src = rawDataUrl;
  });

  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;
  if (width > maxDimension || height > maxDimension) {
    const ratio = Math.min(maxDimension / width, maxDimension / height);
    width = Math.max(1, Math.round(width * ratio));
    height = Math.max(1, Math.round(height * ratio));
  }

  const renderScaledJpeg = (scale: number, q: number): string | null => {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width * scale));
    c.height = Math.max(1, Math.round(height * scale));
    const context = c.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, c.width, c.height);
    context.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', q);
  };

  let compressed = renderScaledJpeg(1, quality);
  if (!compressed) {
    throw new Error('Browser canvas image sanitizer is unavailable. Please retry in a supported browser.');
  }

  const fallbackStages: Array<[number, number]> = [
    [1, 0.56],
    [1, 0.42],
    [0.75, 0.5],
    [0.58, 0.44],
    [0.45, 0.4],
  ];
  for (const [scale, q] of fallbackStages) {
    if (compressed.length <= maxChars) break;
    const candidate = renderScaledJpeg(scale, q);
    if (candidate) {
      compressed = candidate;
    }
  }

  if (compressed.length > maxChars) {
    throw new Error('Compressed image is still too large. Please crop or select a clearer photo.');
  }
  return compressed;
}

export interface FirebaseAuthCapabilities {
  projectId?: string;
  projectNumber?: string;
  effectiveAuthDomain?: string;
  preferredBrandAuthDomain?: string;
  customAuthProxyEnabled?: boolean;
  googleEnabled: boolean;
  googleProviderStatus: AuthProviderStatus;
  emailPasswordEnabled: boolean;
  emailPasswordStatus: AuthProviderStatus;
  phoneSmsEnabled: boolean;
  authorizedDomains?: string[];
  currentDomainAuthorized?: boolean | null;
  tokenServiceEnabled: boolean;
  tokenServiceStatus: TokenServiceStatus;
  tokenServiceMessage?: string;
  tokenServiceActivationUrl: string;
  iamConsoleUrl?: string;
  firebaseAuthConsoleUrl?: string;
  firebaseAuthorizedDomainsUrl?: string;
  sandboxServiceAccountEmail?: string;
  requiredRole?: string;
  checkedAtMs: number;
}

export interface EnableTokenServiceResult {
  ok: boolean;
  tokenServiceStatus: TokenServiceStatus;
  tokenServiceEnabled: boolean;
  projectId?: string;
  projectNumber?: string;
  tokenServiceActivationUrl?: string;
  iamConsoleUrl?: string;
  firebaseAuthConsoleUrl?: string;
  sandboxServiceAccountEmail?: string;
  requiredRole?: string;
  message: string;
}

let cachedAuthCapabilities: FirebaseAuthCapabilities | null = null;
let inflightCapabilitiesPromise: Promise<FirebaseAuthCapabilities> | null = null;

function isValidProviderStatus(val: unknown): val is AuthProviderStatus {
  return val === 'enabled' || val === 'disabled' || val === 'unable_to_verify';
}

/**
 * Performs lightweight, zero-mutation Identity Toolkit & Token Service capability probes against the live Firebase project.
 * Strictly distinguishes confirmed `'enabled'`, confirmed `'disabled'`, and `'unable_to_verify'` (network/proxy failure)
 * so login/registration forms are never falsely locked on transient probe errors.
 */
export async function detectFirebaseAuthCapabilities(
  forceRefresh = false
): Promise<FirebaseAuthCapabilities> {
  if (!forceRefresh && cachedAuthCapabilities) {
    return cachedAuthCapabilities;
  }
  if (!forceRefresh && inflightCapabilitiesPromise) {
    return inflightCapabilitiesPromise;
  }

  const currentHostname =
    typeof window !== 'undefined' && window.location?.hostname
      ? window.location.hostname.trim().toLowerCase()
      : '';

  inflightCapabilitiesPromise = (async () => {
    try {
      const endpoint = forceRefresh
        ? `/api/auth/capabilities?refresh=${Date.now()}`
        : '/api/auth/capabilities';
      const reqHeaders: Record<string, string> = { Accept: 'application/json' };
      if (auth.currentUser) {
        const idToken = await auth.currentUser.getIdToken(false).catch(() => '');
        if (idToken) reqHeaders.Authorization = `Bearer ${idToken}`;
      }
      const apiResp = await fetch(endpoint, {
        cache: 'no-store',
        headers: reqHeaders,
      });
      const ct = apiResp.headers.get('content-type') || '';
      if (apiResp.ok && ct.includes('application/json')) {
        const data = (await apiResp.json()) as Partial<FirebaseAuthCapabilities>;
        if (typeof data.tokenServiceStatus === 'string') {
          const status = data.tokenServiceStatus as TokenServiceStatus;
          const emailPasswordStatus: AuthProviderStatus = isValidProviderStatus(
            data.emailPasswordStatus
          )
            ? data.emailPasswordStatus
            : data.emailPasswordEnabled === true
            ? 'enabled'
            : data.emailPasswordEnabled === false
            ? 'disabled'
            : 'unable_to_verify';
          const googleProviderStatus: AuthProviderStatus = isValidProviderStatus(
            data.googleProviderStatus
          )
            ? data.googleProviderStatus
            : data.googleEnabled === false
            ? 'disabled'
            : 'enabled';
          const authorizedDomains = Array.isArray(data.authorizedDomains)
            ? data.authorizedDomains.filter((d): d is string => typeof d === 'string')
            : undefined;
          const currentDomainAuthorized =
            authorizedDomains && authorizedDomains.length > 0 && currentHostname
              ? authorizedDomains.some((d) => d.toLowerCase() === currentHostname)
              : typeof data.currentDomainAuthorized === 'boolean'
              ? data.currentDomainAuthorized
              : null;

          const preferredBrandAuthDomain =
            typeof data.preferredBrandAuthDomain === 'string' &&
            data.preferredBrandAuthDomain.trim()
              ? data.preferredBrandAuthDomain.trim().toLowerCase()
              : undefined;
          const activeAuthDomain =
            currentDomainAuthorized !== false && preferredBrandAuthDomain
              ? applyPreferredFirebaseAuthDomain(preferredBrandAuthDomain)
              : data.effectiveAuthDomain || EFFECTIVE_FIREBASE_AUTH_DOMAIN;

          const serverResult: FirebaseAuthCapabilities = {
            projectId: data.projectId || firebaseConfig.projectId,
            projectNumber:
              data.projectNumber || String(firebaseConfig.messagingSenderId || '448578956301'),
            effectiveAuthDomain: activeAuthDomain,
            preferredBrandAuthDomain,
            customAuthProxyEnabled: Boolean(data.customAuthProxyEnabled ?? true),
            googleEnabled: googleProviderStatus !== 'disabled',
            googleProviderStatus,
            emailPasswordEnabled: emailPasswordStatus === 'enabled',
            emailPasswordStatus,
            phoneSmsEnabled: Boolean(data.phoneSmsEnabled),
            authorizedDomains,
            currentDomainAuthorized,
            tokenServiceEnabled: status !== 'disabled',
            tokenServiceStatus: status,
            tokenServiceMessage: data.tokenServiceMessage || '',
            tokenServiceActivationUrl:
              data.tokenServiceActivationUrl || DEFAULT_TOKEN_SERVICE_ACTIVATION_URL,
            iamConsoleUrl: data.iamConsoleUrl || '',
            firebaseAuthConsoleUrl:
              data.firebaseAuthConsoleUrl || DEFAULT_FIREBASE_AUTH_PROVIDERS_URL,
            firebaseAuthorizedDomainsUrl:
              data.firebaseAuthorizedDomainsUrl || DEFAULT_FIREBASE_AUTH_DOMAINS_URL,
            sandboxServiceAccountEmail: data.sandboxServiceAccountEmail || '',
            requiredRole: data.requiredRole || 'roles/serviceusage.serviceUsageAdmin',
            checkedAtMs: Date.now(),
          };
          syncPersistedTokenServiceStatus(status);
          syncProactiveRefreshWithCapabilities(auth.currentUser, status);
          cachedAuthCapabilities = serverResult;
          inflightCapabilitiesPromise = null;
          return serverResult;
        }
      }
    } catch {
      // Static-hosting fallback below
    }

    const apiKey = String(firebaseConfig.apiKey || '');
    const projectId = String(firebaseConfig.projectId || '');
    const projectNumber = String(firebaseConfig.messagingSenderId || '448578956301');
    let googleProviderStatus: AuthProviderStatus = 'unable_to_verify';
    let emailPasswordStatus: AuthProviderStatus = 'unable_to_verify';
    let phoneSmsEnabled = true;
    let authorizedDomains: string[] | undefined;
    let currentDomainAuthorized: boolean | null = null;
    let tokenServiceStatus: TokenServiceStatus = 'unable_to_verify';

    try {
      const continueOrigin =
        typeof window !== 'undefined' && window.location?.origin
          ? window.location.origin
          : EFFECTIVE_FIREBASE_AUTH_DOMAIN
          ? `https://${EFFECTIVE_FIREBASE_AUTH_DOMAIN}`
          : 'http://localhost';

      const [projSettled, googleSettled, pwdSettled, phoneSettled, tokenSettled] =
        await Promise.allSettled([
          fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${apiKey}`, {
            method: 'GET',
            headers: { Accept: 'application/json' },
          }),
          fetch(`https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              providerId: 'google.com',
              continueUri: continueOrigin,
            }),
          }),
          fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                email: 'capability-probe-nonexistent@bexora.invalid',
                password: 'probe_only_password_check',
                returnSecureToken: false,
              }),
            }
          ),
          fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key=${apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            }
          ),
          fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'refresh_token',
              refresh_token: 'capability_probe_only',
            }),
          }),
        ]);

      if (projSettled.status === 'fulfilled' && projSettled.value.ok) {
        const projJson = await projSettled.value.json().catch(() => ({}));
        if (Array.isArray(projJson?.authorizedDomains)) {
          const domains = projJson.authorizedDomains.filter(
            (d: unknown): d is string => typeof d === 'string'
          );
          authorizedDomains = domains;
          if (domains.length > 0 && currentHostname) {
            currentDomainAuthorized = domains.some(
              (d: string) => d.toLowerCase() === currentHostname
            );
          }
        }
      }

      if (googleSettled.status === 'fulfilled') {
        const googleText = await googleSettled.value.text().catch(() => '');
        const googleProbe = classifyGoogleProviderProbe(googleSettled.value.status, googleText);
        googleProviderStatus = googleProbe.providerStatus;
        if (currentDomainAuthorized === null && googleProbe.domainAuthorized !== null) {
          currentDomainAuthorized = googleProbe.domainAuthorized;
        }
      }

      if (pwdSettled.status === 'fulfilled') {
        const pwdText = await pwdSettled.value.text().catch(() => '');
        emailPasswordStatus = classifyEmailPasswordProbe(pwdSettled.value.status, pwdText);
      }

      if (phoneSettled.status === 'fulfilled') {
        const phoneJson = await phoneSettled.value.json().catch(() => ({}));
        const phoneMsg = String(phoneJson?.error?.message || '');
        if (
          phoneMsg.includes('OPERATION_NOT_ALLOWED') ||
          phoneMsg.includes('BILLING_NOT_ENABLED')
        ) {
          phoneSmsEnabled = false;
        }
      }

      if (tokenSettled.status === 'fulfilled') {
        const tokenText = await tokenSettled.value.text().catch(() => '');
        tokenServiceStatus = classifyTokenServiceProbe({
          configProjectId: projectId,
          configProjectNumber: projectNumber,
          configApiKey: apiKey,
          httpStatus: tokenSettled.value.status,
          responseBody: tokenText,
        });
      }
    } catch {
      tokenServiceStatus = 'unable_to_verify';
    }

    const result: FirebaseAuthCapabilities = {
      projectId,
      projectNumber,
      effectiveAuthDomain: EFFECTIVE_FIREBASE_AUTH_DOMAIN,
      googleEnabled: googleProviderStatus !== 'disabled',
      googleProviderStatus,
      emailPasswordEnabled: emailPasswordStatus === 'enabled',
      emailPasswordStatus,
      phoneSmsEnabled,
      authorizedDomains,
      currentDomainAuthorized,
      tokenServiceEnabled: tokenServiceStatus !== 'disabled',
      tokenServiceStatus,
      tokenServiceActivationUrl: DEFAULT_TOKEN_SERVICE_ACTIVATION_URL,
      firebaseAuthConsoleUrl: DEFAULT_FIREBASE_AUTH_PROVIDERS_URL,
      firebaseAuthorizedDomainsUrl: DEFAULT_FIREBASE_AUTH_DOMAINS_URL,
      checkedAtMs: Date.now(),
    };
    syncPersistedTokenServiceStatus(tokenServiceStatus);
    syncProactiveRefreshWithCapabilities(auth.currentUser, tokenServiceStatus);
    cachedAuthCapabilities = result;
    inflightCapabilitiesPromise = null;
    return result;
  })();

  return inflightCapabilitiesPromise;
}

/**
 * Immediately synchronizes cached capability state when a live Firebase Auth call confirms
 * Email/Password is enabled or disabled, keeping UI guidance accurate without blocking submission.
 */
export function recordLiveEmailPasswordOutcome(
  outcome: 'enabled' | 'disabled'
): FirebaseAuthCapabilities | null {
  if (!cachedAuthCapabilities) return null;
  cachedAuthCapabilities = {
    ...cachedAuthCapabilities,
    emailPasswordStatus: outcome,
    emailPasswordEnabled: outcome === 'enabled',
    checkedAtMs: Date.now(),
  };
  return cachedAuthCapabilities;
}

function isContinueUriRejectedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err || '');
  return (
    msg.includes('auth/unauthorized-continue-uri') ||
    msg.includes('auth/invalid-continue-uri') ||
    msg.includes('auth/missing-continue-uri') ||
    msg.includes('UNAUTHORIZED_DOMAIN') ||
    msg.includes('INVALID_CONTINUE_URI')
  );
}

/**
 * Sends a Firebase password-reset email with an in-app continue URL when the current origin is authorized,
 * and falls back cleanly to Firebase's default hosted action handler if the current origin (e.g. localhost
 * or a newly pointed custom domain) is not yet listed in Authorized Domains.
 */
export async function safeSendPasswordResetEmail(email: string): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  const domainKnownUnauthorized = cachedAuthCapabilities?.currentDomainAuthorized === false;
  if (!domainKnownUnauthorized && typeof window !== 'undefined' && window.location?.origin) {
    try {
      await sendPasswordResetEmail(auth, cleanEmail, { url: window.location.origin });
      return;
    } catch (err) {
      if (!isContinueUriRejectedError(err)) {
        throw err;
      }
    }
  }
  await sendPasswordResetEmail(auth, cleanEmail);
}

/**
 * Sends a Firebase email-verification link with safe automatic fallback when the current origin
 * is not listed in Firebase Authorized Domains.
 */
export async function safeSendEmailVerification(user: User): Promise<void> {
  const domainKnownUnauthorized = cachedAuthCapabilities?.currentDomainAuthorized === false;
  if (!domainKnownUnauthorized && typeof window !== 'undefined' && window.location?.origin) {
    try {
      await sendEmailVerification(user, { url: window.location.origin });
      return;
    } catch (err) {
      if (!isContinueUriRejectedError(err)) {
        throw err;
      }
    }
  }
  await sendEmailVerification(user);
}

/**
 * Reloads the signed-in Firebase user profile from Identity Toolkit (which does NOT require securetoken.googleapis.com)
 * and forces an ID token refresh ONLY when securetoken.googleapis.com is verified enabled, avoiding preventable 403 errors.
 */
export async function safeRefreshCurrentUserToken(): Promise<{
  emailVerified: boolean;
  tokenRefreshed: boolean;
  tokenServiceBlocked: boolean;
}> {
  if (!auth.currentUser) {
    return { emailVerified: false, tokenRefreshed: false, tokenServiceBlocked: false };
  }
  await auth.currentUser.reload();
  const emailVerified = Boolean(auth.currentUser.emailVerified);
  const caps = await detectFirebaseAuthCapabilities();
  if (!caps.tokenServiceEnabled) {
    await auth.currentUser.getIdToken(false).catch(() => {});
    return { emailVerified, tokenRefreshed: false, tokenServiceBlocked: true };
  }
  try {
    await auth.currentUser.getIdToken(true);
    return { emailVerified, tokenRefreshed: true, tokenServiceBlocked: false };
  } catch (err) {
    if (isTokenServiceDisabledError(err)) {
      return { emailVerified, tokenRefreshed: false, tokenServiceBlocked: true };
    }
    throw err;
  }
}

/**
 * Invokes the backend auto-enablement endpoint (`POST /api/auth/enable-token-service`) and refreshes
 * cached auth capabilities so the UI reflects verified live state (`enabled_verified`, `enablement_pending`,
 * `permission_denied`, `unable_to_verify`, or `config_mismatch`).
 */
export async function requestServerEnableTokenService(): Promise<EnableTokenServiceResult> {
  try {
    const idToken = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => '') : '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idToken) {
      headers.Authorization = `Bearer ${idToken}`;
    }
    const resp = await fetch('/api/auth/enable-token-service', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    const ct = resp.headers.get('content-type') || '';
    if (resp.ok && ct.includes('application/json')) {
      const data = (await resp.json()) as EnableTokenServiceResult;
      await detectFirebaseAuthCapabilities(true);
      return data;
    }
  } catch {
    // Fall through to honest unable_to_verify / manual console guidance
  }
  const caps = await detectFirebaseAuthCapabilities(true);
  return {
    ok: caps.tokenServiceStatus === 'enabled_verified',
    tokenServiceStatus: caps.tokenServiceStatus,
    tokenServiceEnabled: caps.tokenServiceStatus === 'enabled_verified',
    projectId: caps.projectId,
    projectNumber: caps.projectNumber,
    tokenServiceActivationUrl: caps.tokenServiceActivationUrl,
    iamConsoleUrl: caps.iamConsoleUrl,
    sandboxServiceAccountEmail: caps.sandboxServiceAccountEmail,
    requiredRole: caps.requiredRole,
    message:
      caps.tokenServiceMessage ||
      'Server-side Service Usage enablement endpoint is unavailable on static hosting. Enable Token Service API in Google Cloud Console and click Re-check Status.',
  };
}

export interface PendingSignupMeta {
  displayName?: string;
  username?: string;
  phone?: string;
  phoneCountryCode?: string;
}

const pendingSignupByEmail = new Map<string, PendingSignupMeta>();
const profileInitInflightByUid = new Map<string, Promise<void>>();

export function registerPendingSignupProfile(email: string, meta: PendingSignupMeta): void {
  const clean = email.trim().toLowerCase();
  if (clean) {
    pendingSignupByEmail.set(clean, meta);
  }
}

export function clearPendingSignupProfile(email: string): void {
  const clean = email.trim().toLowerCase();
  if (clean) {
    pendingSignupByEmail.delete(clean);
  }
}

/**
 * Deduplicated, race-free user profile initializer shared by AuthModal and App.tsx onAuthStateChanged.
 * Guarantees strict compliance with firestore.rules validation (`displayName` 2..80 chars, `username` 3..24 `[a-z0-9_]+`),
 * performs ALL transaction reads before writes, and atomically self-heals partially created profiles.
 */
export async function ensureUserProfileInitialized(
  fbUser: User,
  opts?: PendingSignupMeta
): Promise<void> {
  markAuthenticatedSessionActive(fbUser);
  const existingTask = profileInitInflightByUid.get(fbUser.uid);
  if (existingTask) {
    return existingTask;
  }

  const emailKey = (fbUser.email || '').trim().toLowerCase();
  const mergedOpts: PendingSignupMeta = {
    ...(emailKey ? pendingSignupByEmail.get(emailKey) : undefined),
    ...opts,
  };

  const task = (async () => {
    try {
      const pubRef = doc(db, 'publicProfiles', fbUser.uid);
      const privRef = doc(db, 'privateUsers', fbUser.uid);

      const [existingPub, existingPriv] = await Promise.all([getDoc(pubRef), getDoc(privRef)]);
      if (existingPub.exists() && existingPriv.exists()) {
        if (emailKey) pendingSignupByEmail.delete(emailKey);
        return;
      }

      const rawName = (mergedOpts.displayName || fbUser.displayName || 'BEXORA Member').trim();
      const safeDisplayName = (rawName.length >= 2 ? rawName : 'BEXORA Member').slice(0, 80);

      const uidSuffix =
        fbUser.uid
          .replace(/[^a-zA-Z0-9]/g, '')
          .toLowerCase()
          .slice(0, 5) || 'user1';

      const emailPrefix =
        (fbUser.email?.split('@')[0] || 'member')
          .replace(/[^a-z0-9_]/gi, '')
          .toLowerCase()
          .slice(0, 15) || 'member';

      const rawExplicitUname = mergedOpts.username
        ? mergedOpts.username.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 24)
        : '';

      let baseUname =
        rawExplicitUname.length >= 3
          ? rawExplicitUname
          : `${emailPrefix}_${uidSuffix}`.slice(0, 24);

      if (
        baseUname === 'admin' ||
        baseUname === 'superadmin' ||
        baseUname === 'bexora' ||
        baseUname === 'support' ||
        baseUname === 'escrow' ||
        baseUname === 'system' ||
        baseUname === 'moderator'
      ) {
        baseUname = `member_${uidSuffix}`;
      }

      await runTransaction(db, async (tx) => {
        // 1. Read phase: ALL tx.get calls MUST complete before any tx.set call
        const [pubSnap, privSnap] = await Promise.all([tx.get(pubRef), tx.get(privRef)]);
        if (pubSnap.exists() && privSnap.exists()) return;

        const existingPubData = pubSnap.exists() ? pubSnap.data() : null;
        let candidate =
          existingPubData && typeof existingPubData.username === 'string' && existingPubData.username.length >= 3
            ? existingPubData.username
            : baseUname;

        let finalURef = doc(db, 'usernames', candidate);
        let finalUSnap = await tx.get(finalURef);

        if (finalUSnap.exists() && finalUSnap.data()?.uid !== fbUser.uid) {
          if (mergedOpts.username && !existingPubData) {
            throw new Error('USERNAME_TAKEN');
          }
          candidate = `${emailPrefix.slice(0, 14)}_${uidSuffix}_${Math.floor(10 + Math.random() * 89)}`.slice(
            0,
            24
          );
          finalURef = doc(db, 'usernames', candidate);
          finalUSnap = await tx.get(finalURef);
          if (finalUSnap.exists() && finalUSnap.data()?.uid !== fbUser.uid) {
            throw new Error('USERNAME_TAKEN');
          }
        }

        const welcomeNotifId = buildNotificationId(fbUser.uid, 'welcome_account_registered');
        const welcomeNotifRef = doc(db, 'notifications', welcomeNotifId);
        const welcomeSnap = await tx.get(welcomeNotifRef);

        // 2. Write phase: initialize only missing documents (preserves existing data & never grants admin role)
        if (!finalUSnap.exists()) {
          tx.set(finalURef, {
            uid: fbUser.uid,
            username: candidate,
            updatedAt: serverTimestamp(),
          });
        }

        if (!pubSnap.exists()) {
          tx.set(pubRef, {
            uid: fbUser.uid,
            displayName: safeDisplayName,
            username: candidate,
            bio: '',
            nidVerified: false,
            completedTrader: false,
            completedSales: 0,
            completedPurchases: 0,
            ratingSum: 0,
            ratingCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        if (!privSnap.exists()) {
          const cleanPhone = (mergedOpts.phone || fbUser.phoneNumber || '').trim().slice(0, 32);
          const cleanCountry = (mergedOpts.phoneCountryCode || '').trim().toUpperCase().slice(0, 4);
          tx.set(privRef, {
            uid: fbUser.uid,
            email: (fbUser.email || '').slice(0, 160),
            phone: cleanPhone,
            ...(cleanCountry ? { phoneCountryCode: cleanCountry } : {}),
            phoneFormatValidated: Boolean(cleanPhone),
            emailVerified: Boolean(fbUser.emailVerified),
            phoneVerified: Boolean(fbUser.phoneNumber && fbUser.phoneNumber === cleanPhone),
            nidStatus: 'not_verified',
            walletBalanceMinor: 0,
            reservedBalanceMinor: 0,
            preferredLanguage: 'en',
            preferredCurrency: 'BDT',
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        if (!welcomeSnap.exists()) {
          tx.set(welcomeNotifRef, {
            recipientId: fbUser.uid,
            actorId: fbUser.uid,
            actorRole: 'user',
            category: 'account',
            severity: 'success',
            title: `Welcome to BEXORA, ${safeDisplayName}!`,
            preview: 'Your BEXORA marketplace profile and escrow wallet are ready.',
            body: `Welcome to BEXORA (@${candidate})! Your digital asset marketplace profile and BDT escrow wallet have been initialized. Complete NID verification in your Profile to unlock verified trader trust badges, list assets, or bid with full buyer protection.`,
            refType: 'profile',
            refId: fbUser.uid,
            referenceLabel: `@${candidate}`,
            destination: 'profile',
            read: false,
            createdAtMs: Date.now(),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
      });

      if (emailKey) {
        pendingSignupByEmail.delete(emailKey);
      }
    } finally {
      profileInitInflightByUid.delete(fbUser.uid);
    }
  })();

  profileInitInflightByUid.set(fbUser.uid, task);
  return task;
}

export function formatFirebaseAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (isTokenServiceDisabledMessage(msg)) {
    return 'Your session needs a quick security refresh. Click Connect with Google to sign in and continue.';
  }
  if (
    msg.includes('auth/invalid-credential') ||
    msg.includes('auth/wrong-password') ||
    msg.includes('auth/user-not-found') ||
    msg.includes('INVALID_LOGIN_CREDENTIALS')
  ) {
    return 'Incorrect email or password.';
  }
  if (msg.includes('auth/email-already-in-use') || msg.includes('EMAIL_EXISTS')) {
    return 'An account with this email address already exists. Please sign in instead.';
  }
  if (msg.includes('auth/invalid-email') || msg.includes('INVALID_EMAIL')) {
    return 'Please enter a valid email address.';
  }
  if (msg.includes('auth/weak-password') || msg.includes('WEAK_PASSWORD')) {
    return 'Password is too weak. Use at least 8 characters with both letters and numbers.';
  }
  if (
    msg.includes('PASSWORD_LOGIN_DISABLED') ||
    msg.includes('auth/operation-not-allowed') ||
    msg.includes('OPERATION_NOT_ALLOWED')
  ) {
    return 'Direct Email/Password sign-in is currently unavailable. Please click Connect with Google above to sign in or create your account.';
  }
  if (msg.includes('auth/expired-action-code')) {
    return 'This verification or password-reset link has expired. Please request a fresh link.';
  }
  if (msg.includes('auth/invalid-action-code')) {
    return 'This verification or password-reset link is invalid or has already been used. Please request a new link.';
  }
  if (msg.includes('auth/unauthorized-domain')) {
    return 'Google sign-in is not yet enabled on this domain. Please use the official BEXORA domain or contact support.';
  }
  if (msg.includes('auth/popup-blocked')) {
    return 'Your browser blocked the Google sign-in popup. Allow popups for this site and click Connect with Google again.';
  }
  if (msg.includes('auth/cancelled-popup-request')) {
    return 'Another Google sign-in window is already open. Complete or close that window and try again.';
  }
  if (msg.includes('auth/user-disabled') || msg.includes('USER_DISABLED')) {
    return 'This account has been disabled by an administrator.';
  }
  if (
    msg.includes('auth/too-many-requests') ||
    msg.includes('TOO_MANY_ATTEMPTS_TRY_LATER') ||
    msg.includes('Quota exceeded')
  ) {
    return 'Too many attempts detected. Please wait a few minutes before trying again.';
  }
  if (msg.includes('auth/requires-recent-login')) {
    return 'For security, please verify your current password or sign in again before making this change.';
  }
  if (msg.includes('auth/popup-closed-by-user')) {
    return 'Google sign-in popup was closed before completing authentication.';
  }
  if (msg.includes('auth/network-request-failed')) {
    return 'Network connection error. Check your internet connection and try again.';
  }
  return sanitizeCustomerAuthMessage(msg.replace(/^Firebase:\s*/i, ''));
}
