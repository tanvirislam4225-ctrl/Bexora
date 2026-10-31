import type {
  NotificationAlertKind,
  NotificationCategory,
  NotificationRecord,
  NotificationSoundId,
  UserNotificationPreferences,
  VibrationStrength,
} from '../types';
import { sanitizeNotificationDestination, truncateNotificationField } from './notificationLogic';

export interface NotificationSoundOption {
  id: NotificationSoundId;
  label: string;
  description: string;
  path: string;
  recommendedFor: 'normal' | 'deal';
}

export const NOTIFICATION_SOUND_CATALOG: ReadonlyArray<NotificationSoundOption> = [
  {
    id: '01_soft_normal',
    label: 'Sample 1 — Soft Normal',
    description: 'Gentle two-note warm chime for everyday marketplace updates',
    path: '/sounds/01_soft_normal.wav',
    recommendedFor: 'normal',
  },
  {
    id: '02_crisp_normal',
    label: 'Sample 2 — Crisp Modern',
    description: 'Clean bright glass chime for bids, messages, and status updates',
    path: '/sounds/02_crisp_normal.wav',
    recommendedFor: 'normal',
  },
  {
    id: '03_premium_deal',
    label: 'Sample 3 — Premium Deal Chime',
    description: 'Elevated 4-note harmonic chime when a funded 3-party Deal Room opens',
    path: '/sounds/03_premium_deal.wav',
    recommendedFor: 'deal',
  },
  {
    id: '04_urgent_deal',
    label: 'Sample 4 — Stronger Deal Alert',
    description: 'Distinct double-cadence chime for urgent escrow or admin alerts',
    path: '/sounds/04_urgent_deal.wav',
    recommendedFor: 'deal',
  },
] as const;

export const VALID_SOUND_IDS: ReadonlySet<NotificationSoundId> = new Set([
  '01_soft_normal',
  '02_crisp_normal',
  '03_premium_deal',
  '04_urgent_deal',
]);

export const DEFAULT_NOTIFICATION_PREFERENCES: UserNotificationPreferences = {
  inAppSoundEnabled: true,
  dealAlertSoundEnabled: true,
  adminAlertSoundEnabled: true,
  vibrationEnabled: true,
  vibrationStrength: 'strong',
  lockScreenPrivacyMode: 'minimal',
  normalSoundId: '02_crisp_normal',
  dealAlertSoundId: '04_urgent_deal',
  adminAlertSoundId: '04_urgent_deal',
  followedSellerListingsEnabled: true,
  bidUpdatesEnabled: true,
};

export const STANDARD_DEAL_VIBRATION_PATTERN: number[] = [180, 90, 240];
export const STRONG_DEAL_VIBRATION_PATTERN: number[] = [260, 90, 320, 90, 260];

/**
 * Default tactile vibration pattern (Strong, in ms) reserved strictly for
 * Paid 3-Party Deal-Room creation / high-priority deal room activation.
 */
export const DEAL_ROOM_VIBRATION_PATTERN: number[] = STRONG_DEAL_VIBRATION_PATTERN;

export function getDealRoomVibrationPattern(strength?: VibrationStrength): number[] {
  return strength === 'standard'
    ? STANDARD_DEAL_VIBRATION_PATTERN
    : STRONG_DEAL_VIBRATION_PATTERN;
}

/**
 * Official Google-managed default Web Push VAPID public key built into `@firebase/messaging` (`DEFAULT_VAPID_KEY`).
 * Used automatically by Firebase Cloud Messaging for Web Push subscriptions on projects that have not uploaded
 * a custom self-managed Web Push certificate in Firebase Console. (Public 65-byte uncompressed P-256 point.)
 */
export const FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY =
  'BDOU99-h67HcA6JeFXHbSNMu7e2yNNu3RzoMj8TM4W88jITfq7ZmPvIM1Iv-4_l2LxQcYwhqby2xGpWwzjfAnG4';

/**
 * Strictly validates that a candidate string is a genuine Web Push VAPID P-256
 * uncompressed *public* key (65 bytes starting with 0x04, encoded as 87–88 base64url chars).
 * Mathematically rejects 32-byte private keys, PEM strings, JSON blobs, or placeholder text.
 */
export function isValidVapidPublicKey(rawKey: string | null | undefined): boolean {
  if (typeof rawKey !== 'string') return false;
  const trimmed = rawKey.trim();
  if (!trimmed || trimmed.length < 84 || trimmed.length > 92) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false;

  try {
    const base64 = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    let bytes: Uint8Array;
    if (typeof Buffer !== 'undefined') {
      bytes = Uint8Array.from(Buffer.from(padded, 'base64'));
    } else if (typeof atob === 'function') {
      const bin = atob(padded);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      return false;
    }
    // Uncompressed NIST P-256 public point is always 65 bytes and starts with 0x04
    return bytes.length === 65 && bytes[0] === 0x04;
  } catch {
    return false;
  }
}

export function normalizeNotificationPreferences(
  raw?: Partial<UserNotificationPreferences> | null
): UserNotificationPreferences {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
  return {
    inAppSoundEnabled:
      typeof raw.inAppSoundEnabled === 'boolean'
        ? raw.inAppSoundEnabled
        : DEFAULT_NOTIFICATION_PREFERENCES.inAppSoundEnabled,
    dealAlertSoundEnabled:
      typeof raw.dealAlertSoundEnabled === 'boolean'
        ? raw.dealAlertSoundEnabled
        : DEFAULT_NOTIFICATION_PREFERENCES.dealAlertSoundEnabled,
    adminAlertSoundEnabled:
      typeof raw.adminAlertSoundEnabled === 'boolean'
        ? raw.adminAlertSoundEnabled
        : DEFAULT_NOTIFICATION_PREFERENCES.adminAlertSoundEnabled,
    vibrationEnabled:
      typeof raw.vibrationEnabled === 'boolean'
        ? raw.vibrationEnabled
        : DEFAULT_NOTIFICATION_PREFERENCES.vibrationEnabled,
    vibrationStrength:
      raw.vibrationStrength === 'standard' ? 'standard' : 'strong',
    lockScreenPrivacyMode:
      raw.lockScreenPrivacyMode === 'standard' ? 'standard' : 'minimal',
    normalSoundId: VALID_SOUND_IDS.has(raw.normalSoundId as NotificationSoundId)
      ? (raw.normalSoundId as NotificationSoundId)
      : DEFAULT_NOTIFICATION_PREFERENCES.normalSoundId,
    dealAlertSoundId: VALID_SOUND_IDS.has(raw.dealAlertSoundId as NotificationSoundId)
      ? (raw.dealAlertSoundId as NotificationSoundId)
      : DEFAULT_NOTIFICATION_PREFERENCES.dealAlertSoundId,
    adminAlertSoundId: VALID_SOUND_IDS.has(raw.adminAlertSoundId as NotificationSoundId)
      ? (raw.adminAlertSoundId as NotificationSoundId)
      : DEFAULT_NOTIFICATION_PREFERENCES.adminAlertSoundId,
    followedSellerListingsEnabled:
      typeof raw.followedSellerListingsEnabled === 'boolean'
        ? raw.followedSellerListingsEnabled
        : true,
    bidUpdatesEnabled:
      typeof raw.bidUpdatesEnabled === 'boolean'
        ? raw.bidUpdatesEnabled
        : true,
  };
}

const LOCAL_PREFS_PREFIX = 'bx_notif_prefs_v2:';

export function loadLocalNotificationPreferences(uid: string | null): UserNotificationPreferences {
  const scope = uid || 'guest';
  try {
    if (typeof localStorage === 'undefined') return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    const raw = localStorage.getItem(`${LOCAL_PREFS_PREFIX}${scope}`);
    if (!raw) return { ...DEFAULT_NOTIFICATION_PREFERENCES };
    return normalizeNotificationPreferences(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES };
  }
}

export function saveLocalNotificationPreferences(
  uid: string | null,
  prefs: UserNotificationPreferences
): UserNotificationPreferences {
  const normalized = normalizeNotificationPreferences(prefs);
  const scope = uid || 'guest';
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(`${LOCAL_PREFS_PREFIX}${scope}`, JSON.stringify(normalized));
    }
  } catch {
    // Ignore storage quota limits
  }
  return normalized;
}

export function clearLocalNotificationSessionData(uid: string | null): void {
  if (!uid) return;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(`bx_active_fcm_token:${uid}`);
    }
  } catch {
    // Ignore restricted storage contexts
  }
}

export function getSoundPathById(soundId: NotificationSoundId): string {
  const found = NOTIFICATION_SOUND_CATALOG.find((s) => s.id === soundId);
  return found ? found.path : '/sounds/02_crisp_normal.wav';
}

export function resolveNotificationAlertKind(
  item: Pick<NotificationRecord, 'alertKind' | 'category' | 'severity' | 'actorRole' | 'title'>
): NotificationAlertKind {
  if (item.alertKind === 'deal_room_created') return 'deal_room_created';
  if (item.alertKind === 'admin_alert') return 'admin_alert';
  if (item.title === 'New Deal Room Created') return 'deal_room_created';
  if (
    item.actorRole === 'admin' &&
    (item.severity === 'critical' || item.severity === 'warning' || item.category === 'dispute' || item.category === 'security')
  ) {
    return 'admin_alert';
  }
  return 'normal';
}

export function selectSoundForAlertKind(
  kind: NotificationAlertKind,
  prefs: UserNotificationPreferences
): { enabled: boolean; soundId: NotificationSoundId; path: string; shouldVibrate: boolean } {
  const normalized = normalizeNotificationPreferences(prefs);
  if (kind === 'deal_room_created') {
    return {
      enabled: normalized.dealAlertSoundEnabled,
      soundId: normalized.dealAlertSoundId,
      path: getSoundPathById(normalized.dealAlertSoundId),
      shouldVibrate: normalized.vibrationEnabled,
    };
  }
  if (kind === 'admin_alert') {
    return {
      enabled: normalized.adminAlertSoundEnabled && normalized.inAppSoundEnabled,
      soundId: normalized.adminAlertSoundId,
      path: getSoundPathById(normalized.adminAlertSoundId),
      shouldVibrate: false,
    };
  }
  return {
    enabled: normalized.inAppSoundEnabled,
    soundId: normalized.normalSoundId,
    path: getSoundPathById(normalized.normalSoundId),
    shouldVibrate: false,
  };
}

/**
 * Pure deduplication state machine ensuring:
 * 1. Initial Firestore snapshot load NEVER triggers sounds or vibrations for historical unread items.
 * 2. Re-snapshots, read-status updates, or listener reconnects NEVER replay an already-seen notification ID.
 * 3. If multiple new unread notifications arrive in a single snapshot tick, only ONE alert fires,
 *    strictly prioritizing `deal_room_created` > `admin_alert` > `normal`.
 */
export class NotificationArrivalTracker {
  private initializedForUid: string | null = null;
  private seenIds = new Set<string>();

  public reset(): void {
    this.initializedForUid = null;
    this.seenIds.clear();
  }

  public processSnapshot(
    uid: string | null,
    items: ReadonlyArray<NotificationRecord>,
    nowMs = Date.now()
  ): {
    shouldAlert: boolean;
    alertKind: NotificationAlertKind;
    triggerItem: NotificationRecord | null;
  } {
    if (!uid) {
      this.reset();
      return { shouldAlert: false, alertKind: 'normal', triggerItem: null };
    }

    if (this.initializedForUid !== uid) {
      this.initializedForUid = uid;
      this.seenIds.clear();
      for (const item of items) {
        if (item?.id) this.seenIds.add(item.id);
      }
      return { shouldAlert: false, alertKind: 'normal', triggerItem: null };
    }

    const freshUnread: NotificationRecord[] = [];
    for (const item of items) {
      if (!item?.id) continue;
      if (this.seenIds.has(item.id)) continue;
      this.seenIds.add(item.id);
      // Only alert on genuinely recent unread notifications (created within last 2 minutes)
      const ageMs = Math.max(0, nowMs - (Number(item.createdAtMs) || 0));
      if (!item.read && ageMs <= 120_000) {
        freshUnread.push(item);
      }
    }

    if (freshUnread.length === 0) {
      return { shouldAlert: false, alertKind: 'normal', triggerItem: null };
    }

    const rank: Record<NotificationAlertKind, number> = {
      deal_room_created: 3,
      admin_alert: 2,
      normal: 1,
    };

    let bestItem = freshUnread[0];
    let bestKind = resolveNotificationAlertKind(bestItem);

    for (let i = 1; i < freshUnread.length; i++) {
      const candidate = freshUnread[i];
      const kind = resolveNotificationAlertKind(candidate);
      if (rank[kind] > rank[bestKind]) {
        bestItem = candidate;
        bestKind = kind;
      }
    }

    return {
      shouldAlert: true,
      alertKind: bestKind,
      triggerItem: bestItem,
    };
  }

  public markSeenExplicitly(notificationId: string): void {
    if (notificationId) {
      this.seenIds.add(notificationId);
    }
  }
}

export interface PrivacySafePushPayloadInput {
  notificationId: string;
  category: NotificationCategory;
  alertKind: NotificationAlertKind;
  title: string;
  preview: string;
  destination: string;
  referenceLabel?: string;
  privacyMode: 'minimal' | 'standard';
}

export interface PrivacySafePushPayloadOutput {
  title: string;
  body: string;
  tag: string;
  alertKind: NotificationAlertKind;
  destination: string;
}

/**
 * Builds lock-screen-safe Web Push notification text.
 * - Never exposes passwords, tokens, NID details, phone numbers, email addresses, or exact wallet balances.
 * - In `minimal` lock-screen privacy mode (default), replaces specific asset titles / monetary amounts
 *   with generic category/deal cues while preserving exact safe internal deep-link routing on click.
 */
export function buildPrivacySafePushPayload(
  input: PrivacySafePushPayloadInput
): PrivacySafePushPayloadOutput {
  const safeDest = sanitizeNotificationDestination(input.destination);
  const destination = safeDest ? safeDest.raw : '';
  const tag = truncateNotificationField(input.notificationId || `bx_${Date.now()}`, 96);

  if (input.alertKind === 'deal_room_created') {
    if (input.privacyMode === 'minimal') {
      return {
        title: 'New Deal Room Created',
        body: 'Payment confirmed in BEXORA Escrow. Tap to open your private 3-party Deal Room.',
        tag,
        alertKind: 'deal_room_created',
        destination,
      };
    }
    const cleanRef = sanitizeSensitiveTokensFromPreview(input.referenceLabel || input.preview);
    return {
      title: 'New Deal Room Created',
      body: truncateNotificationField(
        cleanRef || 'Payment confirmed in BEXORA Escrow. Open your private 3-party Deal Room.',
        160
      ),
      tag,
      alertKind: 'deal_room_created',
      destination,
    };
  }

  if (input.privacyMode === 'minimal') {
    const genericByCategory: Record<NotificationCategory, { title: string; body: string }> = {
      deal: {
        title: 'BEXORA Escrow Update',
        body: 'You have a new update in your Escrow Deal Room. Tap to view safely.',
      },
      bid: {
        title: 'BEXORA Bid Update',
        body: 'New bid activity on BEXORA Marketplace. Tap to review.',
      },
      dispute: {
        title: 'BEXORA Dispute Review Update',
        body: 'An escrow dispute or report requires your attention. Tap to view.',
      },
      wallet: {
        title: 'BEXORA Wallet Update',
        body: 'Your BEXORA Wallet has a new status update. Sign in to view details.',
      },
      verification: {
        title: 'BEXORA Verification Update',
        body: 'Your account verification status was updated.',
      },
      security: {
        title: 'BEXORA Security Notice',
        body: 'Important security activity on your BEXORA account.',
      },
      listing: {
        title: 'BEXORA Listing Update',
        body: 'Your marketplace listing status has changed.',
      },
      announcement: {
        title: truncateNotificationField(input.title || 'BEXORA Announcement', 100),
        body: 'New platform announcement from BEXORA. Tap to read.',
      },
      account: {
        title: 'BEXORA Account Notice',
        body: 'Open BEXORA to view your account notification.',
      },
      system: {
        title: 'BEXORA Notification',
        body: 'You have a new notification on BEXORA.',
      },
    };
    const chosen = genericByCategory[input.category] || genericByCategory.system;
    return {
      title: chosen.title,
      body: chosen.body,
      tag,
      alertKind: input.alertKind,
      destination,
    };
  }

  return {
    title: truncateNotificationField(sanitizeSensitiveTokensFromPreview(input.title) || 'BEXORA Notification', 110),
    body: truncateNotificationField(
      sanitizeSensitiveTokensFromPreview(input.preview) || 'Open BEXORA to view your update.',
      180
    ),
    tag,
    alertKind: input.alertKind,
    destination,
  };
}

/**
 * Redacts currency figures, emails, phone numbers, and long token-like strings from lock-screen previews.
 */
export function sanitizeSensitiveTokensFromPreview(text: string): string {
  return String(text || '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/(?:\+?\d[\d\s-]{8,16}\d)/g, '[redacted-number]')
    .replace(/(?:৳|\$|BDT\s*|USD\s*)\s*\d[\d,.]*/gi, '[escrow amount]')
    .replace(/\b[A-Za-z0-9_-]{36,}\b/g, '[id]')
    .trim();
}

export interface BrowserPushEnvironmentInfo {
  isIOS: boolean;
  isStandalonePwa: boolean;
  iosRequiresHomeScreenInstall: boolean;
  isSecureContext: boolean;
  supportsVibrationApi: boolean;
  supportsServiceWorker: boolean;
  supportsNotificationApi: boolean;
  deviceLabel: string;
}

export function detectBrowserPushEnvironment(
  uaString?: string,
  isStandaloneOverride?: boolean,
  isSecureContextOverride?: boolean
): BrowserPushEnvironmentInfo {
  const ua =
    typeof uaString === 'string'
      ? uaString
      : typeof navigator !== 'undefined'
      ? navigator.userAgent || ''
      : '';
  const lower = ua.toLowerCase();
  const isIOS =
    /iphone|ipad|ipod/.test(lower) ||
    (/macintosh/.test(lower) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints || 0) > 1);

  const isStandalonePwa =
    typeof isStandaloneOverride === 'boolean'
      ? isStandaloneOverride
      : typeof window !== 'undefined'
      ? Boolean(
          window.matchMedia?.('(display-mode: standalone)')?.matches ||
            (window.navigator as unknown as { standalone?: boolean }).standalone === true
        )
      : false;

  const isSecureContext =
    typeof isSecureContextOverride === 'boolean'
      ? isSecureContextOverride
      : typeof window !== 'undefined'
      ? Boolean(
          window.isSecureContext ||
            window.location?.protocol === 'https:' ||
            window.location?.hostname === 'localhost' ||
            window.location?.hostname === '127.0.0.1'
        )
      : true;

  const supportsServiceWorker = typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
  const supportsNotificationApi = typeof window !== 'undefined' && 'Notification' in window;
  const supportsVibrationApi =
    typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  let deviceLabel = 'Web Browser';
  if (isIOS) {
    deviceLabel = isStandalonePwa ? 'iOS Installed Web App' : 'iOS Safari / Browser';
  } else if (/android/.test(lower)) {
    deviceLabel = isStandalonePwa ? 'Android Installed PWA' : 'Android Browser';
  } else if (/macintosh|mac os x/.test(lower)) {
    deviceLabel = 'macOS Browser';
  } else if (/windows/.test(lower)) {
    deviceLabel = 'Windows Browser';
  } else if (/linux/.test(lower)) {
    deviceLabel = 'Linux Browser';
  }

  return {
    isIOS,
    isStandalonePwa,
    iosRequiresHomeScreenInstall: isIOS && !isStandalonePwa,
    isSecureContext,
    supportsVibrationApi,
    supportsServiceWorker,
    supportsNotificationApi,
    deviceLabel,
  };
}

// --- Client-Side Audio Autoplay Unlock, Sound Playback & Vibration Dispatcher ---

let audioUnlockedByGesture = false;
let unlockListenersAttached = false;
const audioCache = new Map<NotificationSoundId, HTMLAudioElement>();
let lastSoundPlayedAtMs = 0;

export function attachAudioUnlockListeners(): void {
  if (unlockListenersAttached || typeof window === 'undefined') return;
  unlockListenersAttached = true;

  const markUnlocked = () => {
    audioUnlockedByGesture = true;
    window.removeEventListener('pointerdown', markUnlocked, true);
    window.removeEventListener('keydown', markUnlocked, true);
  };

  window.addEventListener('pointerdown', markUnlocked, true);
  window.addEventListener('keydown', markUnlocked, true);
}

export function isAudioGestureUnlocked(): boolean {
  return audioUnlockedByGesture;
}

export async function playNotificationSoundById(
  soundId: NotificationSoundId,
  options?: { isManualPreview?: boolean }
): Promise<{ played: boolean; reason?: string }> {
  if (typeof window === 'undefined' || typeof Audio === 'undefined') {
    return { played: false, reason: 'audio_unavailable' };
  }

  const isPreview = Boolean(options?.isManualPreview);
  if (isPreview) {
    audioUnlockedByGesture = true;
  }

  // Throttle automatic notifications to at most 1 chime per 900ms to prevent overlap bursts
  const now = Date.now();
  if (!isPreview && now - lastSoundPlayedAtMs < 900) {
    return { played: false, reason: 'throttled' };
  }

  try {
    const path = getSoundPathById(soundId);
    let audioEl = audioCache.get(soundId);
    if (!audioEl) {
      audioEl = new Audio(path);
      audioEl.preload = 'auto';
      audioCache.set(soundId, audioEl);
    }
    audioEl.pause();
    audioEl.currentTime = 0;
    audioEl.volume = soundId === '03_premium_deal' || soundId === '04_urgent_deal' ? 0.88 : 0.72;
    await audioEl.play();
    lastSoundPlayedAtMs = now;
    audioUnlockedByGesture = true;
    return { played: true };
  } catch {
    return {
      played: false,
      reason: audioUnlockedByGesture ? 'playback_failed' : 'autoplay_gesture_required',
    };
  }
}

export function triggerDealRoomVibration(prefs: UserNotificationPreferences): boolean {
  const normalized = normalizeNotificationPreferences(prefs);
  if (!normalized.vibrationEnabled) return false;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return false;
  }
  try {
    return navigator.vibrate(getDealRoomVibrationPattern(normalized.vibrationStrength));
  } catch {
    return false;
  }
}

export async function dispatchForegroundNotificationAlert(
  alertKind: NotificationAlertKind,
  prefs: UserNotificationPreferences
): Promise<{ soundPlayed: boolean; vibrated: boolean }> {
  const selection = selectSoundForAlertKind(alertKind, prefs);
  let vibrated = false;
  if (selection.shouldVibrate && alertKind === 'deal_room_created') {
    vibrated = triggerDealRoomVibration(prefs);
  }
  let soundPlayed = false;
  if (selection.enabled) {
    const res = await playNotificationSoundById(selection.soundId);
    soundPlayed = res.played;
  }
  return { soundPlayed, vibrated };
}
