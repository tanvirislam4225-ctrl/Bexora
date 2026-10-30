import { deleteDoc, doc, getDoc, getDocs, collection, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore';
import { deleteToken, getMessaging, getToken, isSupported, onMessage, type MessagePayload } from 'firebase/messaging';
import app, { auth, db } from './firebase';
import { deterministicHashHex } from './notificationLogic';
import {
  clearLocalNotificationSessionData,
  detectBrowserPushEnvironment,
  isValidVapidPublicKey,
  loadLocalNotificationPreferences,
} from './soundAndPushConfig';
import type { NotificationAlertKind, NotificationCategory } from '../types';

export type WebPushStatus =
  | 'unsupported'
  | 'insecure_context'
  | 'ios_install_required'
  | 'signed_out'
  | 'permission_denied'
  | 'vapid_key_missing'
  | 'invalid_vapid_key'
  | 'fcm_api_disabled'
  | 'ready_to_enable'
  | 'enabled';

export interface ServerFcmDiagnosticStatus {
  ok: boolean;
  projectId: string;
  projectNumber: string;
  appId: string;
  envVapidConfigured: boolean;
  envVapidValid: boolean;
  fcmV1ApiStatus: 'enabled_verified' | 'disabled' | 'unable_to_verify';
  fcmRegistrationsApiStatus: 'enabled_verified' | 'disabled' | 'unable_to_verify';
  firebaseInstallationsApiStatus: 'enabled_verified' | 'disabled' | 'unable_to_verify';
  fcmSendApiStatus: 'enabled_verified' | 'permission_denied' | 'disabled' | 'no_credentials' | 'unable_to_verify';
  sandboxServiceAccountEmail: string;
  requiredRoles: string[];
  firebaseCloudMessagingConsoleUrl: string;
  fcmRegistrationsActivationUrl: string;
  fcmV1ActivationUrl: string;
  firebaseInstallationsActivationUrl: string;
  iamConsoleUrl: string;
  vapidConsoleErrorDiagnosis: string;
  detailMessage: string;
}

export interface WebPushStateSnapshot {
  status: WebPushStatus;
  permission: NotificationPermission | 'unsupported';
  vapidConfigured: boolean;
  vapidSource: 'env' | 'public_settings' | 'none';
  activeTokenCount: number;
  iosRequiresHomeScreenInstall: boolean;
  deviceLabel: string;
  serverDiagnostics: ServerFcmDiagnosticStatus | null;
  detailMessage: string;
}

/**
 * Dedicated FCM Service Worker scope so `/firebase-messaging-sw.js` coexists cleanly
 * alongside Workbox PWA `/sw.js` (registered at `/`) without ever evicting each other.
 */
const PUSH_SW_PATH = '/firebase-messaging-sw.js';
const PUSH_SW_SCOPE = '/firebase-cloud-messaging-push-scope';
const LOCAL_DEVICE_TOKEN_ID_KEY = 'bx_device_push_token_id:';
const LOCAL_PUSH_OPTIN_KEY = 'bx_push_optin:';

let cachedRuntimePublicVapidKey = '';

export function setRuntimeFallbackVapidPublicKey(candidateKey?: string | null): void {
  const clean = String(candidateKey || '').trim();
  cachedRuntimePublicVapidKey = isValidVapidPublicKey(clean) ? clean : '';
}

function isPlaceholderVapidEnvValue(raw: string): boolean {
  if (!raw) return true;
  return (
    raw === 'YOUR_FIREBASE_VAPID_KEY' ||
    raw === 'MY_FIREBASE_VAPID_KEY' ||
    raw === 'PASTE_YOUR_VAPID_KEY_HERE'
  );
}

export function resolveConfiguredVapidPublicKey(explicitFallback?: string | null): {
  key: string;
  source: 'env' | 'public_settings' | 'none';
  hasMalformedEnvValue: boolean;
} {
  const rawEnv = String(import.meta.env.VITE_FIREBASE_VAPID_KEY || '').trim();
  const hasNonPlaceholderEnv = !isPlaceholderVapidEnvValue(rawEnv);
  if (hasNonPlaceholderEnv && isValidVapidPublicKey(rawEnv)) {
    return { key: rawEnv, source: 'env', hasMalformedEnvValue: false };
  }
  const candidate = String(explicitFallback ?? cachedRuntimePublicVapidKey ?? '').trim();
  if (isValidVapidPublicKey(candidate)) {
    return { key: candidate, source: 'public_settings', hasMalformedEnvValue: hasNonPlaceholderEnv };
  }
  return { key: '', source: 'none', hasMalformedEnvValue: hasNonPlaceholderEnv };
}

/**
 * Classifies browser PushManager / Firebase `getToken()` errors into deterministic statuses
 * and actionable user-safe diagnostic explanations.
 */
export function classifyWebPushRegistrationError(err: unknown): {
  status: WebPushStatus;
  message: string;
} {
  const code =
    err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code || '') : '';
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name || '') : '';
  const detail = err instanceof Error ? err.message : String(err);
  const combined = `${code} ${name} ${detail}`.toLowerCase();

  if (
    combined.includes('invalid-vapid-key') ||
    combined.includes('invalidaccesserror') ||
    combined.includes('applicationserverkey')
  ) {
    return {
      status: 'invalid_vapid_key',
      message:
        'Configured VAPID public key is invalid. Use only the genuine 87–88 character base64url P-256 public certificate from Firebase Console > Project Settings > Cloud Messaging > Web Push certificates.',
    };
  }

  if (combined.includes('permission-blocked') || combined.includes('notallowederror')) {
    return {
      status: 'permission_denied',
      message:
        'Browser notification permission is blocked. Allow notifications in site settings to enable background alerts.',
    };
  }

  if (
    combined.includes('fcmregistrations') ||
    combined.includes('service_disabled') ||
    combined.includes('token-subscribe-failed') ||
    combined.includes('missing required authentication credential')
  ) {
    return {
      status: 'fcm_api_disabled',
      message:
        'FCM Registration API (fcmregistrations.googleapis.com) must be enabled in Google Cloud Console for project responsive-dragon-tmn89 before browser push tokens can be issued.',
    };
  }

  if (combined.includes('aborterror') || combined.includes('push service error')) {
    return {
      status: 'ready_to_enable',
      message:
        'Browser push service could not complete registration (check browser push settings or Brave/privacy shields and retry).',
    };
  }

  return {
    status: 'ready_to_enable',
    message: `Unable to register Web Push token: ${detail.slice(0, 160)}`,
  };
}

export async function fetchServerFcmStatus(): Promise<ServerFcmDiagnosticStatus | null> {
  try {
    const res = await fetch('/api/fcm/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return (await res.json()) as ServerFcmDiagnosticStatus;
  } catch {
    return null;
  }
}

async function getOrRegisterFcmServiceWorker(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration(PUSH_SW_SCOPE).catch(() => undefined);
  const reg =
    existing ||
    (await navigator.serviceWorker.register(PUSH_SW_PATH, {
      scope: PUSH_SW_SCOPE,
      updateViaCache: 'none',
    }));

  if (existing) {
    void existing.update().catch(() => {});
  }

  if (reg.active?.state === 'activated') {
    return reg;
  }

  const candidateWorker = reg.installing || reg.waiting;
  if (candidateWorker) {
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => resolve(), 4000);
      const onStateChange = () => {
        if (candidateWorker.state === 'activated' || candidateWorker.state === 'redundant') {
          window.clearTimeout(timeout);
          candidateWorker.removeEventListener('statechange', onStateChange);
          resolve();
        }
      };
      candidateWorker.addEventListener('statechange', onStateChange);
    });
  }
  return reg;
}

async function upsertUserPushTokenDoc(input: {
  uid: string;
  tokenId: string;
  token: string;
  userAgent: string;
  platform: 'web' | 'ios_pwa';
  deviceLabel: string;
}): Promise<void> {
  const tokenRef = doc(db, 'privateUsers', input.uid, 'pushTokens', input.tokenId);
  const nowMs = Date.now();
  const existingSnap = await getDoc(tokenRef);
  if (existingSnap.exists()) {
    await updateDoc(tokenRef, {
      token: input.token,
      userAgent: input.userAgent,
      platform: input.platform,
      deviceLabel: input.deviceLabel,
      enabled: true,
      lastRefreshedAtMs: nowMs,
      updatedAt: serverTimestamp(),
    });
    return;
  }
  await setDoc(tokenRef, {
    uid: input.uid,
    token: input.token,
    userAgent: input.userAgent,
    platform: input.platform,
    deviceLabel: input.deviceLabel,
    enabled: true,
    createdAtMs: nowMs,
    lastRefreshedAtMs: nowMs,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function inspectWebPushState(
  uid: string | null,
  fallbackVapidKey?: string | null
): Promise<WebPushStateSnapshot> {
  const envInfo = detectBrowserPushEnvironment();
  const resolvedVapid = resolveConfiguredVapidPublicKey(fallbackVapidKey);
  const serverDiag = await fetchServerFcmStatus();

  if (!envInfo.isSecureContext) {
    return {
      status: 'insecure_context',
      permission: envInfo.supportsNotificationApi ? Notification.permission : 'unsupported',
      vapidConfigured: Boolean(resolvedVapid.key),
      vapidSource: resolvedVapid.source,
      activeTokenCount: 0,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'Browser Web Push requires a secure HTTPS origin (or localhost during development). Real-time in-app notifications remain active.',
    };
  }

  if (envInfo.iosRequiresHomeScreenInstall) {
    return {
      status: 'ios_install_required',
      permission: envInfo.supportsNotificationApi ? Notification.permission : 'unsupported',
      vapidConfigured: Boolean(resolvedVapid.key),
      vapidSource: resolvedVapid.source,
      activeTokenCount: 0,
      iosRequiresHomeScreenInstall: true,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'On iPhone/iPad (iOS 16.4+), tap Share -> "Add to Home Screen" and open BEXORA from your Home Screen to enable background Web Push.',
    };
  }

  if (!envInfo.supportsNotificationApi || !envInfo.supportsServiceWorker) {
    return {
      status: 'unsupported',
      permission: 'unsupported',
      vapidConfigured: Boolean(resolvedVapid.key),
      vapidSource: resolvedVapid.source,
      activeTokenCount: 0,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'Browser Web Push APIs are unavailable in this browser or embedded frame. Real-time in-app notifications remain active.',
    };
  }

  const messagingSupported = await isSupported().catch(() => false);
  if (!messagingSupported) {
    return {
      status: 'unsupported',
      permission: Notification.permission,
      vapidConfigured: Boolean(resolvedVapid.key),
      vapidSource: resolvedVapid.source,
      activeTokenCount: 0,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'Firebase Cloud Messaging Web Push is unsupported in this browser context. Real-time in-app notifications remain active.',
    };
  }

  const permission = Notification.permission;

  if (!uid) {
    return {
      status: 'signed_out',
      permission,
      vapidConfigured: Boolean(resolvedVapid.key),
      vapidSource: resolvedVapid.source,
      activeTokenCount: 0,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage: 'Sign in to enable background push notifications for your BEXORA account.',
    };
  }

  if (permission === 'denied') {
    return {
      status: 'permission_denied',
      permission,
      vapidConfigured: Boolean(resolvedVapid.key),
      vapidSource: resolvedVapid.source,
      activeTokenCount: 0,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'Browser notification permission is blocked. Allow notifications in your browser site settings to receive background alerts. In-app notifications remain active.',
    };
  }

  let activeTokenCount = 0;
  try {
    const snap = await getDocs(collection(db, 'privateUsers', uid, 'pushTokens'));
    activeTokenCount = snap.docs.filter((d) => d.data()?.enabled === true).length;
  } catch {
    activeTokenCount = 0;
  }

  if (!resolvedVapid.key && resolvedVapid.hasMalformedEnvValue) {
    return {
      status: 'invalid_vapid_key',
      permission,
      vapidConfigured: false,
      vapidSource: 'none',
      activeTokenCount,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'VITE_FIREBASE_VAPID_KEY contains an invalid format. Provide only the 87–88 char base64url P-256 public certificate from Firebase Console > Cloud Messaging > Web Push certificates.',
    };
  }

  if (!resolvedVapid.key) {
    const regDisabledHint =
      serverDiag?.fcmRegistrationsApiStatus === 'disabled'
        ? ' Note: Enable fcmregistrations.googleapis.com in Google Cloud Console on responsive-dragon-tmn89 first if "Generate key pair" fails in Firebase Console.'
        : '';
    return {
      status: 'vapid_key_missing',
      permission,
      vapidConfigured: false,
      vapidSource: 'none',
      activeTokenCount,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage: `In-app notifications & chimes are active. Background Web Push awaits VITE_FIREBASE_VAPID_KEY from Project Settings > Cloud Messaging.${regDisabledHint}`,
    };
  }

  if (serverDiag && serverDiag.fcmRegistrationsApiStatus === 'disabled') {
    return {
      status: 'fcm_api_disabled',
      permission,
      vapidConfigured: true,
      vapidSource: resolvedVapid.source,
      activeTokenCount,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        'FCM Registration API (fcmregistrations.googleapis.com) is currently disabled in Google Cloud project responsive-dragon-tmn89. Enable it in Cloud Console to issue browser tokens.',
    };
  }

  if (permission === 'granted' && activeTokenCount > 0) {
    return {
      status: 'enabled',
      permission,
      vapidConfigured: true,
      vapidSource: resolvedVapid.source,
      activeTokenCount,
      iosRequiresHomeScreenInstall: false,
      deviceLabel: envInfo.deviceLabel,
      serverDiagnostics: serverDiag,
      detailMessage:
        serverDiag?.fcmSendApiStatus === 'permission_denied'
          ? `Registered on ${activeTokenCount} device(s). Grant roles/firebasecloudmessaging.admin on responsive-dragon-tmn89 for server-dispatched closed-tab push.`
          : `Background push notifications are active for ${activeTokenCount} device(s).`,
    };
  }

  return {
    status: 'ready_to_enable',
    permission,
    vapidConfigured: true,
    vapidSource: resolvedVapid.source,
    activeTokenCount,
    iosRequiresHomeScreenInstall: false,
    deviceLabel: envInfo.deviceLabel,
    serverDiagnostics: serverDiag,
    detailMessage:
      'Enable background push alerts for funded Deal Rooms, bids, escrow milestones, and security updates.',
  };
}

/**
 * Explicitly triggered ONLY by a direct user click inside the Notification Center.
 * Never requests browser permission automatically on page load.
 */
export async function enableWebPushForCurrentUser(
  fallbackVapidKey?: string | null
): Promise<{
  ok: boolean;
  status: WebPushStatus;
  message: string;
}> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return { ok: false, status: 'signed_out', message: 'Sign in first to enable push notifications.' };
  }

  const envInfo = detectBrowserPushEnvironment();
  if (!envInfo.isSecureContext) {
    return {
      ok: false,
      status: 'insecure_context',
      message: 'Web Push requires HTTPS or localhost. Real-time in-app notifications continue working.',
    };
  }

  if (envInfo.iosRequiresHomeScreenInstall) {
    return {
      ok: false,
      status: 'ios_install_required',
      message:
        'On iPhone/iPad (iOS 16.4+), tap Share -> "Add to Home Screen" and launch BEXORA from your Home Screen before enabling Web Push.',
    };
  }

  if (!envInfo.supportsNotificationApi || !envInfo.supportsServiceWorker) {
    return {
      ok: false,
      status: 'unsupported',
      message:
        'This browser does not support Web Push notifications. Real-time in-app notifications remain active.',
    };
  }

  const supported = await isSupported().catch(() => false);
  if (!supported) {
    return {
      ok: false,
      status: 'unsupported',
      message: 'Firebase Cloud Messaging is unsupported in this browser environment.',
    };
  }

  const resolvedVapid = resolveConfiguredVapidPublicKey(fallbackVapidKey);
  if (!resolvedVapid.key) {
    if (resolvedVapid.hasMalformedEnvValue) {
      return {
        ok: false,
        status: 'invalid_vapid_key',
        message:
          'VITE_FIREBASE_VAPID_KEY is malformed. Provide only the genuine 87–88 character base64url P-256 public certificate from Firebase Console > Cloud Messaging.',
      };
    }
    return {
      ok: false,
      status: 'vapid_key_missing',
      message:
        'VITE_FIREBASE_VAPID_KEY is not configured yet. Enable fcmregistrations.googleapis.com on responsive-dragon-tmn89, generate the Web Push public certificate in Firebase Console > Project Settings > Cloud Messaging, and set VITE_FIREBASE_VAPID_KEY.',
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      status: 'permission_denied',
      message:
        'Notification permission was not granted. In-app notifications and chimes continue working normally.',
    };
  }

  try {
    const swReg = await getOrRegisterFcmServiceWorker();
    const messaging = getMessaging(app);
    const fcmToken = await getToken(messaging, {
      vapidKey: resolvedVapid.key,
      serviceWorkerRegistration: swReg,
    });

    if (!fcmToken) {
      return {
        ok: false,
        status: 'ready_to_enable',
        message: 'Could not retrieve an FCM registration token at this time. Please retry shortly.',
      };
    }

    const tokenId = `fcm_${deterministicHashHex(fcmToken)}`;
    const prevDeviceTokenId = localStorage.getItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${currentUser.uid}`);
    if (prevDeviceTokenId && prevDeviceTokenId !== tokenId) {
      await deleteDoc(doc(db, 'privateUsers', currentUser.uid, 'pushTokens', prevDeviceTokenId)).catch(() => {});
    }

    await upsertUserPushTokenDoc({
      uid: currentUser.uid,
      tokenId,
      token: fcmToken,
      userAgent: String(navigator.userAgent || 'Browser').slice(0, 240),
      platform: envInfo.isIOS ? 'ios_pwa' : 'web',
      deviceLabel: envInfo.deviceLabel.slice(0, 80),
    });

    try {
      localStorage.setItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${currentUser.uid}`, tokenId);
      localStorage.setItem(`${LOCAL_PUSH_OPTIN_KEY}${currentUser.uid}`, '1');
    } catch {
      // Ignore storage limits
    }

    return {
      ok: true,
      status: 'enabled',
      message: `Background push notifications enabled on ${envInfo.deviceLabel}.`,
    };
  } catch (err) {
    const classified = classifyWebPushRegistrationError(err);
    return {
      ok: false,
      status: classified.status,
      message: classified.message,
    };
  }
}

/**
 * Silently refreshes and synchronizes an opted-in browser's FCM token across sessions,
 * cleaning up any superseded token ID on this browser. Never prompts for permission.
 */
export async function syncActiveWebPushTokenForSession(
  uid: string,
  fallbackVapidKey?: string | null
): Promise<void> {
  if (typeof window === 'undefined' || !uid) return;
  const envInfo = detectBrowserPushEnvironment();
  if (
    !envInfo.isSecureContext ||
    !envInfo.supportsNotificationApi ||
    Notification.permission !== 'granted' ||
    !envInfo.supportsServiceWorker
  ) {
    return;
  }
  try {
    if (localStorage.getItem(`${LOCAL_PUSH_OPTIN_KEY}${uid}`) !== '1') {
      return;
    }
  } catch {
    return;
  }

  const resolvedVapid = resolveConfiguredVapidPublicKey(fallbackVapidKey);
  if (!resolvedVapid.key) return;

  try {
    const supported = await isSupported().catch(() => false);
    if (!supported) return;
    const swReg = await getOrRegisterFcmServiceWorker();
    const messaging = getMessaging(app);
    const fcmToken = await getToken(messaging, {
      vapidKey: resolvedVapid.key,
      serviceWorkerRegistration: swReg,
    });
    if (!fcmToken || auth.currentUser?.uid !== uid) return;

    const tokenId = `fcm_${deterministicHashHex(fcmToken)}`;
    const prevDeviceTokenId = localStorage.getItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${uid}`);
    if (prevDeviceTokenId && prevDeviceTokenId !== tokenId) {
      await deleteDoc(doc(db, 'privateUsers', uid, 'pushTokens', prevDeviceTokenId)).catch(() => {});
    }

    await upsertUserPushTokenDoc({
      uid,
      tokenId,
      token: fcmToken,
      userAgent: String(navigator.userAgent || 'Browser').slice(0, 240),
      platform: envInfo.isIOS ? 'ios_pwa' : 'web',
      deviceLabel: envInfo.deviceLabel.slice(0, 80),
    });
    localStorage.setItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${uid}`, tokenId);
  } catch {
    // Non-fatal silent refresh skip
  }
}

/**
 * Revokes FCM registration token on this browser and removes per-user push token docs.
 */
export async function disableWebPushForCurrentUser(): Promise<{ ok: boolean; message: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    return { ok: false, message: 'Sign in required.' };
  }

  try {
    const supported = await isSupported().catch(() => false);
    if (supported) {
      const messaging = getMessaging(app);
      await deleteToken(messaging).catch(() => false);
    }

    const snap = await getDocs(collection(db, 'privateUsers', currentUser.uid, 'pushTokens'));
    for (const tokenDoc of snap.docs) {
      await deleteDoc(doc(db, 'privateUsers', currentUser.uid, 'pushTokens', tokenDoc.id));
    }

    try {
      localStorage.removeItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${currentUser.uid}`);
      localStorage.removeItem(`${LOCAL_PUSH_OPTIN_KEY}${currentUser.uid}`);
    } catch {
      // Ignore storage limits
    }

    return { ok: true, message: 'Background push notifications disabled for your account.' };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Could not remove push subscription: ${detail.slice(0, 140)}` };
  }
}

/**
 * Shared-Device Sign-Out Guard:
 * Unlinks ONLY the current browser's active FCM push token from the signing-out user's Firestore account
 * and deletes the local browser FCM token BEFORE `signOut(auth)` completes, so private notifications
 * for the previous user never pop up on a shared computer/phone after sign-out.
 */
export async function unlinkCurrentDevicePushTokenOnLogout(uid: string | null): Promise<void> {
  if (!uid || typeof window === 'undefined') return;
  clearLocalNotificationSessionData(uid);

  try {
    const deviceTokenId = localStorage.getItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${uid}`);
    if (deviceTokenId && auth.currentUser?.uid === uid) {
      await deleteDoc(doc(db, 'privateUsers', uid, 'pushTokens', deviceTokenId)).catch(() => {});
    }
    localStorage.removeItem(`${LOCAL_DEVICE_TOKEN_ID_KEY}${uid}`);
  } catch {
    // Ignore storage errors
  }

  try {
    const supported = await isSupported().catch(() => false);
    if (supported) {
      const messaging = getMessaging(app);
      await deleteToken(messaging).catch(() => false);
    }
  } catch {
    // Non-fatal in unsupported contexts
  }
}

export interface ServerPushDispatchRequest {
  recipientId: string;
  notificationId: string;
  category: NotificationCategory;
  alertKind: NotificationAlertKind;
  title: string;
  preview: string;
  destination: string;
  referenceLabel?: string;
  dealId?: string;
  listingId?: string;
}

/**
 * Requests trusted server-side Web Push delivery via `/api/fcm/send`.
 * Non-blocking & fault-isolated: never throws or interrupts completed wallet/escrow transactions.
 */
export async function dispatchBackgroundWebPush(
  reqPayload: ServerPushDispatchRequest
): Promise<{ ok: boolean; deliveryStatus: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser || !reqPayload.recipientId || !reqPayload.notificationId) {
    return { ok: false, deliveryStatus: 'skipped_unauthenticated' };
  }

  try {
    const idToken = await currentUser.getIdToken();
    const callerPrefs = loadLocalNotificationPreferences(
      reqPayload.recipientId === currentUser.uid ? currentUser.uid : null
    );

    const res = await fetch('/api/fcm/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({
        ...reqPayload,
        privacyMode: callerPrefs.lockScreenPrivacyMode,
        vibrationEnabled: callerPrefs.vibrationEnabled,
        vibrationStrength: callerPrefs.vibrationStrength || 'strong',
      }),
    });

    if (!res.ok) {
      return { ok: false, deliveryStatus: `http_${res.status}` };
    }
    const data = (await res.json()) as { ok?: boolean; deliveryStatus?: string };
    return {
      ok: Boolean(data.ok),
      deliveryStatus: String(data.deliveryStatus || 'unknown'),
    };
  } catch {
    return { ok: false, deliveryStatus: 'network_retryable' };
  }
}

/**
 * Attaches foreground FCM listener when supported and permission is already granted.
 */
export function subscribeForegroundPushMessages(
  onForegroundPayload: (payload: MessagePayload) => void,
  fallbackVapidKey?: string | null
): () => void {
  let unsub: (() => void) | null = null;
  let cancelled = false;

  const envInfo = detectBrowserPushEnvironment();
  if (
    !envInfo.isSecureContext ||
    !envInfo.supportsNotificationApi ||
    Notification.permission !== 'granted'
  ) {
    return () => {};
  }
  const resolved = resolveConfiguredVapidPublicKey(fallbackVapidKey);
  if (!resolved.key) {
    return () => {};
  }

  isSupported()
    .then((supported) => {
      if (!supported || cancelled) return;
      const messaging = getMessaging(app);
      unsub = onMessage(messaging, (payload) => {
        onForegroundPayload(payload);
      });
    })
    .catch(() => {
      // Non-fatal in environments without PushManager
    });

  return () => {
    cancelled = true;
    if (unsub) unsub();
  };
}
