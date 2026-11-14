import type { UserPresence, UserPresenceSession, UserPresenceState } from '../types';

export const PRESENCE_HEARTBEAT_INTERVAL_MS = 25_000;
export const PRESENCE_STALE_THRESHOLD_MS = 65_000;

export interface PresenceDisplayStatus {
  isOnline: boolean;
  label: string;
  shortLabel: string;
}

/**
 * Returns whether a presence session heartbeat has expired (stale).
 */
export function isSessionStale(
  lastHeartbeatAtMs: number,
  nowMs: number = Date.now(),
  staleThresholdMs: number = PRESENCE_STALE_THRESHOLD_MS
): boolean {
  if (!lastHeartbeatAtMs || lastHeartbeatAtMs <= 0) return true;
  return nowMs - lastHeartbeatAtMs > staleThresholdMs;
}

/**
 * Evaluates whether an aggregate user presence record is currently active.
 */
export function isUserCurrentlyOnline(
  presence: { state?: UserPresenceState; lastSeenMs?: number } | null | undefined,
  nowMs: number = Date.now(),
  staleThresholdMs: number = PRESENCE_STALE_THRESHOLD_MS
): boolean {
  if (!presence || presence.state !== 'online') return false;
  if (!presence.lastSeenMs || presence.lastSeenMs <= 0) return false;
  return nowMs - presence.lastSeenMs <= staleThresholdMs;
}

/**
 * Aggregates multiple concurrent sessions (tabs/devices) into a single user presence state.
 * A user remains Online as long as at least one session is active and not stale.
 */
export function computeAggregatePresence(
  sessions: Array<{ state?: string; lastHeartbeatAtMs?: number }>,
  nowMs: number = Date.now(),
  staleThresholdMs: number = PRESENCE_STALE_THRESHOLD_MS
): { isOnline: boolean; activeSessions: number; latestActivityMs: number } {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return { isOnline: false, activeSessions: 0, latestActivityMs: nowMs };
  }

  let activeCount = 0;
  let latestActivityMs = 0;

  for (const s of sessions) {
    const hb = typeof s.lastHeartbeatAtMs === 'number' ? s.lastHeartbeatAtMs : 0;
    if (hb > latestActivityMs) {
      latestActivityMs = hb;
    }
    const isSessionActive = s.state === 'online' && !isSessionStale(hb, nowMs, staleThresholdMs);
    if (isSessionActive) {
      activeCount++;
    }
  }

  return {
    isOnline: activeCount > 0,
    activeSessions: activeCount,
    latestActivityMs: latestActivityMs > 0 ? latestActivityMs : nowMs,
  };
}

/**
 * Formats a user's real-time online status and last-seen activity in standard WhatsApp/Messenger style:
 * - "Online"
 * - "Last seen just now"
 * - "Last seen 5 minutes ago"
 * - "Last seen 15 minutes ago"
 * - "Last seen 1 hour ago"
 * - "Last seen yesterday"
 * - Older: "Last seen 3 days ago" / "Last seen Nov 8"
 */
export function formatUserPresenceStatus(
  presence: { state?: UserPresenceState; lastSeenMs?: number } | null | undefined,
  nowMs: number = Date.now(),
  staleThresholdMs: number = PRESENCE_STALE_THRESHOLD_MS
): PresenceDisplayStatus {
  if (!presence) {
    return { isOnline: false, label: 'Offline', shortLabel: 'Offline' };
  }

  if (isUserCurrentlyOnline(presence, nowMs, staleThresholdMs)) {
    return { isOnline: true, label: 'Online', shortLabel: 'Online' };
  }

  const lastSeenMs = typeof presence.lastSeenMs === 'number' ? presence.lastSeenMs : 0;
  if (lastSeenMs <= 0) {
    return { isOnline: false, label: 'Offline', shortLabel: 'Offline' };
  }

  const diffMs = Math.max(0, nowMs - lastSeenMs);
  const diffMinutes = Math.floor(diffMs / 60_000);

  // Less than 1 minute ago
  if (diffMinutes < 1) {
    return { isOnline: false, label: 'Last seen just now', shortLabel: 'Just now' };
  }

  // Under 60 minutes
  if (diffMinutes < 60) {
    const minText = diffMinutes === 1 ? '1 minute' : `${diffMinutes} minutes`;
    return {
      isOnline: false,
      label: `Last seen ${minText} ago`,
      shortLabel: `${diffMinutes}m ago`,
    };
  }

  const diffHours = Math.floor(diffMs / 3_600_000);

  // Calendar day boundary check
  const nowDate = new Date(nowMs);
  const lastDate = new Date(lastSeenMs);

  const isSameCalendarDay =
    nowDate.getFullYear() === lastDate.getFullYear() &&
    nowDate.getMonth() === lastDate.getMonth() &&
    nowDate.getDate() === lastDate.getDate();

  // If today but >= 1 hour ago
  if (isSameCalendarDay && diffHours < 24) {
    const hrText = diffHours === 1 ? '1 hour' : `${diffHours} hours`;
    return {
      isOnline: false,
      label: `Last seen ${hrText} ago`,
      shortLabel: `${diffHours}h ago`,
    };
  }

  // Check if yesterday (difference of 1 calendar day)
  const yesterdayDate = new Date(nowMs);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const isYesterday =
    yesterdayDate.getFullYear() === lastDate.getFullYear() &&
    yesterdayDate.getMonth() === lastDate.getMonth() &&
    yesterdayDate.getDate() === lastDate.getDate();

  if (isYesterday || (diffHours >= 20 && diffHours < 48)) {
    return {
      isOnline: false,
      label: 'Last seen yesterday',
      shortLabel: 'Yesterday',
    };
  }

  const diffDays = Math.floor(diffMs / 86_400_000);

  // 2 to 6 days ago
  if (diffDays >= 2 && diffDays < 7) {
    return {
      isOnline: false,
      label: `Last seen ${diffDays} days ago`,
      shortLabel: `${diffDays}d ago`,
    };
  }

  // Older activity: format Month Day (e.g. "Nov 8")
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[lastDate.getMonth()] || '';
  const day = lastDate.getDate();
  const dateStr = `${month} ${day}`;

  return {
    isOnline: false,
    label: `Last seen ${dateStr}`,
    shortLabel: dateStr,
  };
}

/**
 * Detects current device classification.
 */
export function resolveDeviceType(userAgent?: string): 'desktop' | 'mobile' | 'tablet' {
  const ua =
    userAgent ||
    (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
  const lower = ua.toLowerCase();

  if (/ipad|tablet|(android(?!.*mobile))/i.test(lower)) {
    return 'tablet';
  }
  if (/mobile|iphone|ipod|android|blackberry|iemobile|opera mini/i.test(lower)) {
    return 'mobile';
  }
  return 'desktop';
}

/**
 * Generates or retrieves a unique persistent session ID for the current browser tab.
 */
export function getOrCreateTabSessionId(): string {
  if (typeof window === 'undefined') return 'srv_session';
  const STORAGE_KEY = 'bx_presence_tab_session_id';
  try {
    let existing = window.sessionStorage.getItem(STORAGE_KEY);
    if (!existing || existing.length < 8) {
      existing = 'tab_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now().toString(36);
      window.sessionStorage.setItem(STORAGE_KEY, existing);
    }
    return existing;
  } catch {
    return 'tab_' + Math.random().toString(36).substring(2, 11);
  }
}
