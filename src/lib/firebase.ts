import { initializeApp } from 'firebase/app';
import {
  browserLocalPersistence,
  browserPopupRedirectResolver,
  getAuth,
  GoogleAuthProvider,
  initializeAuth,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithPopup,
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
  inspectStoredFirebaseAuthToken,
  isTokenServiceDisabledMessage,
  sanitizeCustomerAuthMessage,
} from './marketplaceLogic';
import { buildNotificationId, classifyTokenServiceProbe } from './notificationLogic';
import type { AuthProviderStatus, TokenServiceStatus } from '../types';

const TOKEN_SERVICE_VERIFIED_STORAGE_KEY = 'bx_token_service_verified';
let staleTokenClearedNotice: string | null = null;
let lastExpiredSessionProvider = '';
let lastExpiredSessionEmail = '';

/**
 * Synchronously inspects `window.localStorage` (`browserLocalPersistence`) BEFORE `initializeAuth`
 * and `getFirestore` initialize. If a cached Firebase Auth JWT expired while the tab was closed
 * and `securetoken.googleapis.com` is not verified enabled, clearing only that expired token prevents
 * Firestore's `FirebaseAuthCredentialsProvider` from hitting a 403 error and dropping offline on boot.
 */
function sanitizeExpiredLocalAuthBeforeInit(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const tokenServiceVerified =
      window.localStorage.getItem(TOKEN_SERVICE_VERIFIED_STORAGE_KEY) === '1';
    const keyPrefix = `firebase:authUser:${String(firebaseConfig.apiKey || '')}:`;
    const keysToInspect: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(keyPrefix)) {
        keysToInspect.push(k);
      }
    }
    const now = Date.now();
    for (const key of keysToInspect) {
      const raw = window.localStorage.getItem(key);
      const inspection = inspectStoredFirebaseAuthToken(raw, now, tokenServiceVerified, 60_000);
      if (inspection.shouldPurgeBeforeBoot) {
        window.localStorage.removeItem(key);
        if (inspection.hasSession) {
          lastExpiredSessionProvider = inspection.providerId;
          lastExpiredSessionEmail = inspection.email;
          staleTokenClearedNotice = inspection.email
            ? `Your previous session (${inspection.email}) expired while away. Reconnect with one click to continue.`
            : 'Your previous session expired while away. Reconnect with one click to continue.';
        }
      }
    }
  } catch {
    // Non-fatal if storage access is restricted
  }
}

sanitizeExpiredLocalAuthBeforeInit();

export const app = initializeApp(firebaseConfig);
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

let sessionPrepPromise: Promise<void> | null = null;
let recoveryInflight: Promise<void> | null = null;

function persistTokenServiceVerifiedFlag(verified: boolean): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    if (verified) {
      window.localStorage.setItem(TOKEN_SERVICE_VERIFIED_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(TOKEN_SERVICE_VERIFIED_STORAGE_KEY);
    }
  } catch {
    // Ignore storage quota / privacy mode restrictions
  }
}

/**
 * Prevents `@firebase/auth`'s internal 5-minute `ProactiveRefresh` timer from firing a doomed
 * `getIdToken(true)` request against `securetoken.googleapis.com` when the API is disabled,
 * and restores native `ProactiveRefresh` immediately whenever `securetoken.googleapis.com` is enabled.
 */
export function syncProactiveRefreshWithCapabilities(
  user: User | null,
  tokenServiceEnabled: boolean
): void {
  if (!user) return;
  const internalUser = user as unknown as {
    _stopProactiveRefresh?: () => void;
    _startProactiveRefresh?: () => void;
  };
  if (tokenServiceEnabled) {
    internalUser._startProactiveRefresh?.();
  } else {
    internalUser._stopProactiveRefresh?.();
  }
}

/**
 * Safely clears an expired unrefreshable Auth session when securetoken.googleapis.com is disabled
 * and explicitly re-enables Firestore's network transport so public marketplace listeners never stay stuck offline.
 */
export function recoverFirestoreFromTokenServiceError(customNotice?: string): Promise<void> {
  if (recoveryInflight) return recoveryInflight;
  recoveryInflight = (async () => {
    if (auth.currentUser) {
      lastExpiredSessionEmail = auth.currentUser.email || lastExpiredSessionEmail;
      lastExpiredSessionProvider =
        auth.currentUser.providerData[0]?.providerId || lastExpiredSessionProvider;
    }
    staleTokenClearedNotice =
      customNotice ||
      (lastExpiredSessionEmail
        ? `Session for ${lastExpiredSessionEmail} reached its 60-minute security window. Reconnect with one click to continue.`
        : 'Your 60-minute session reached expiration. Reconnect with one click to continue.');
    if (auth.currentUser) {
      await signOut(auth).catch(() => {});
    }
    await enableNetwork(db).catch(() => {});
  })().finally(() => {
    recoveryInflight = null;
  });
  return recoveryInflight;
}

/**
 * Ensures any expired cached Auth session is validated before Firestore opens listeners.
 */
export function prepareFirestoreAuthSession(): Promise<void> {
  if (sessionPrepPromise) return sessionPrepPromise;
  sessionPrepPromise = (async () => {
    try {
      if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady();
      }
      if (auth.currentUser) {
        try {
          await auth.currentUser.getIdToken(false);
        } catch (tokenErr) {
          if (isTokenServiceDisabledError(tokenErr)) {
            await recoverFirestoreFromTokenServiceError();
          }
        }
      }
    } catch {
      // Non-fatal; allow Firestore to initialize normally
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

let gsiScriptPromise: Promise<boolean> | null = null;
function loadGoogleIdentityServicesScript(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.resolve(false);
  }
  const win = window as unknown as { google?: { accounts?: { id?: unknown } } };
  if (win.google?.accounts?.id) {
    return Promise.resolve(true);
  }
  if (gsiScriptPromise) return gsiScriptPromise;

  gsiScriptPromise = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    const timeoutId = window.setTimeout(() => resolve(false), 5000);
    script.onload = () => {
      window.clearTimeout(timeoutId);
      resolve(Boolean(win.google?.accounts?.id));
    };
    script.onerror = () => {
      window.clearTimeout(timeoutId);
      gsiScriptPromise = null;
      resolve(false);
    };
    document.head.appendChild(script);
  });
  return gsiScriptPromise;
}

/**
 * Attempts a zero-popup, silent 60-minute Firebase ID token renewal via Google Identity Services
 * + Identity Toolkit (`accounts:signInWithIdp`) BEFORE Firebase's 5-minute ProactiveRefresh window.
 * Works even when `securetoken.googleapis.com` is disabled because `identitytoolkit.googleapis.com` is enabled.
 */
export async function attemptSilentGoogleSessionRefresh(user: User): Promise<boolean> {
  const oAuthClientId = String(
    (firebaseConfig as Record<string, unknown>).oAuthClientId || ''
  ).trim();
  const isGoogleUser = user.providerData.some((p) => p.providerId === 'google.com');
  if (!isGoogleUser || !oAuthClientId) {
    return false;
  }

  const loaded = await loadGoogleIdentityServicesScript();
  if (!loaded) return false;

  type GsiPromptNotification = {
    isNotDisplayed?: () => boolean;
    isSkippedMoment?: () => boolean;
    isDismissedMoment?: () => boolean;
  };
  type GsiIdApi = {
    initialize: (cfg: {
      client_id: string;
      auto_select?: boolean;
      login_hint?: string;
      cancel_on_tap_outside?: boolean;
      use_fedcm_for_prompt?: boolean;
      callback: (response: { credential?: string }) => void;
    }) => void;
    prompt: (momentListener?: (n: GsiPromptNotification) => void) => void;
    cancel?: () => void;
  };

  const gsiId = (window as unknown as { google?: { accounts?: { id?: GsiIdApi } } }).google
    ?.accounts?.id;
  if (!gsiId) return false;

  const googleIdToken = await new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (token: string | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(token);
    };
    const timer = window.setTimeout(() => {
      try {
        gsiId.cancel?.();
      } catch {
        // Ignore cancel errors
      }
      finish(null);
    }, 7500);

    try {
      gsiId.initialize({
        client_id: oAuthClientId,
        auto_select: true,
        login_hint: user.email || undefined,
        cancel_on_tap_outside: false,
        callback: (resp) => {
          finish(typeof resp?.credential === 'string' && resp.credential ? resp.credential : null);
        },
      });
      gsiId.prompt((notification) => {
        if (
          notification.isNotDisplayed?.() ||
          notification.isSkippedMoment?.() ||
          notification.isDismissedMoment?.()
        ) {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });

  if (!googleIdToken) return false;

  try {
    await reauthenticateWithCredential(user, GoogleAuthProvider.credential(googleIdToken));
    const caps = await detectFirebaseAuthCapabilities();
    syncProactiveRefreshWithCapabilities(user, caps.tokenServiceEnabled);
    return true;
  } catch {
    return false;
  }
}

/**
 * 1-click interactive session renewal via Identity Toolkit (`reauthenticateWithPopup` / `signInWithPopup`)
 * that mints a fresh 60-minute Firebase session token without requiring `securetoken.googleapis.com`.
 */
export async function extendCurrentUserSessionInteractive(): Promise<'renewed' | 'open_auth_modal'> {
  const current = auth.currentUser;
  if (current) {
    const isGoogle = current.providerData.some((p) => p.providerId === 'google.com');
    if (!isGoogle) {
      return 'open_auth_modal';
    }
    await reauthenticateWithPopup(current, googleProvider);
    const caps = await detectFirebaseAuthCapabilities();
    syncProactiveRefreshWithCapabilities(current, caps.tokenServiceEnabled);
    return 'renewed';
  }

  if (lastExpiredSessionProvider === 'google.com' || !lastExpiredSessionProvider) {
    const cred = await signInWithPopup(auth, googleProvider);
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
    if (rawDataUrl.length > maxChars) {
      throw new Error('Browser canvas unavailable to compress large image. Please choose a smaller screenshot.');
    }
    return rawDataUrl;
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
      const apiResp = await fetch(endpoint, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
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

          const serverResult: FirebaseAuthCapabilities = {
            projectId: data.projectId || firebaseConfig.projectId,
            projectNumber:
              data.projectNumber || String(firebaseConfig.messagingSenderId || '448578956301'),
            googleEnabled: googleProviderStatus !== 'disabled',
            googleProviderStatus,
            emailPasswordEnabled: emailPasswordStatus === 'enabled',
            emailPasswordStatus,
            phoneSmsEnabled: Boolean(data.phoneSmsEnabled),
            authorizedDomains,
            currentDomainAuthorized,
            tokenServiceEnabled: status === 'enabled_verified',
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
          persistTokenServiceVerifiedFlag(status === 'enabled_verified');
          syncProactiveRefreshWithCapabilities(auth.currentUser, status === 'enabled_verified');
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
          : projectId
          ? `https://${projectId}.firebaseapp.com`
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
      googleEnabled: googleProviderStatus !== 'disabled',
      googleProviderStatus,
      emailPasswordEnabled: emailPasswordStatus === 'enabled',
      emailPasswordStatus,
      phoneSmsEnabled,
      authorizedDomains,
      currentDomainAuthorized,
      tokenServiceEnabled: tokenServiceStatus === 'enabled_verified',
      tokenServiceStatus,
      tokenServiceActivationUrl: DEFAULT_TOKEN_SERVICE_ACTIVATION_URL,
      firebaseAuthConsoleUrl: DEFAULT_FIREBASE_AUTH_PROVIDERS_URL,
      firebaseAuthorizedDomainsUrl: DEFAULT_FIREBASE_AUTH_DOMAINS_URL,
      checkedAtMs: Date.now(),
    };
    persistTokenServiceVerifiedFlag(tokenServiceStatus === 'enabled_verified');
    syncProactiveRefreshWithCapabilities(auth.currentUser, tokenServiceStatus === 'enabled_verified');
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
          tx.set(privRef, {
            uid: fbUser.uid,
            email: (fbUser.email || '').slice(0, 160),
            phone: (mergedOpts.phone || fbUser.phoneNumber || '').trim().slice(0, 32),
            emailVerified: Boolean(fbUser.emailVerified),
            phoneVerified: Boolean(fbUser.phoneNumber),
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
