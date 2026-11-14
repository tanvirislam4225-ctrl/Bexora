/**
 * Pure, decoupled business logic for BEXORA Real-Time "Active Status" (Presence).
 * Implements exact WhatsApp / IMO status formatting rules, server-time adjustment,
 * idle detection, and privacy enforcement.
 */

export type PresenceState = 'online' | 'offline';

export interface PresenceRecord {
  state: PresenceState;
  lastActiveAt: number;
  showStatus?: boolean;
}

export interface ActiveStatusResult {
  visible: boolean;
  isOnline: boolean;
  dotColor: 'green' | 'grey';
  text: string;
  ariaLabel: string;
  minutesAgo: number;
}

export const STALE_ONLINE_THRESHOLD_MS = 90_000; // 90 seconds stale protection
export const IDLE_TIMEOUT_MS = 120_000; // 2 minutes idle threshold
export const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds heartbeat

/**
 * Calculates human-readable status text according to strict formatting rules:
 * Let diff = (current server-adjusted time) − lastActiveAt.
 * - Effective state is online → green dot + "Active now"
 * - diff < 1 minute → "Active just now"
 * - 1 to 59 minutes → "Active N min ago" (N = exact whole minutes rounded down)
 * - 1 to 23 hours → "Active N hr ago" (exact whole hours rounded down)
 * - 1 to 2 days (< 72 hours) → "Active N day ago" / "Active N days ago" (singular for 1)
 * - 72 hours or more → grey dot + "Offline"
 * - No presence data exists → "Offline"
 */
export function calculateActiveStatusText(
  presence: PresenceRecord | null | undefined,
  currentServerTimeMs: number,
  viewerUserId?: string | null,
  targetUserId?: string | null
): ActiveStatusResult {
  // If no presence record exists at all
  if (!presence || typeof presence.lastActiveAt !== 'number') {
    return {
      visible: true,
      isOnline: false,
      dotColor: 'grey',
      text: 'Offline',
      ariaLabel: 'User is offline',
      minutesAgo: Infinity,
    };
  }

  // Privacy rule: If showStatus is explicitly false and viewer is not the target user
  const isSelf = Boolean(
    viewerUserId && targetUserId && String(viewerUserId) === String(targetUserId)
  );
  const showStatus = presence.showStatus !== false; // defaults to true

  if (!showStatus && !isSelf) {
    return {
      visible: false,
      isOnline: false,
      dotColor: 'grey',
      text: '',
      ariaLabel: '',
      minutesAgo: Infinity,
    };
  }

  const rawDiff = currentServerTimeMs - presence.lastActiveAt;
  const diff = Math.max(0, rawDiff);
  const minutesAgo = Math.floor(diff / 60_000);

  // Stale protection: if state is "online" but lastActiveAt is older than 90s, treat as offline
  const isStale = presence.state === 'online' && diff > STALE_ONLINE_THRESHOLD_MS;
  const effectiveState: PresenceState = isStale ? 'offline' : presence.state;

  if (effectiveState === 'online') {
    return {
      visible: true,
      isOnline: true,
      dotColor: 'green',
      text: 'Active now',
      ariaLabel: 'User is active now',
      minutesAgo: 0,
    };
  }

  // Offline / Inactive calculations
  // 1. diff < 1 minute (< 60,000ms)
  if (diff < 60_000) {
    return {
      visible: true,
      isOnline: false,
      dotColor: 'grey',
      text: 'Active just now',
      ariaLabel: 'User was active just now',
      minutesAgo: 0,
    };
  }

  // 2. 1 to 59 minutes (60,000ms to < 3,600,000ms)
  if (diff < 3_600_000) {
    const n = Math.floor(diff / 60_000);
    return {
      visible: true,
      isOnline: false,
      dotColor: 'grey',
      text: `Active ${n} min ago`,
      ariaLabel: `User was active ${n} minute${n === 1 ? '' : 's'} ago`,
      minutesAgo: n,
    };
  }

  // 3. 1 to 23 hours (3,600,000ms to < 86,400,000ms)
  if (diff < 86_400_000) {
    const n = Math.floor(diff / 3_600_000);
    return {
      visible: true,
      isOnline: false,
      dotColor: 'grey',
      text: `Active ${n} hr ago`,
      ariaLabel: `User was active ${n} hour${n === 1 ? '' : 's'} ago`,
      minutesAgo: n * 60,
    };
  }

  // 4. 1 to 2 days (< 72 hours, < 259,200,000ms)
  if (diff < 259_200_000) {
    const n = Math.floor(diff / 86_400_000);
    const dayUnit = n === 1 ? 'day' : 'days';
    return {
      visible: true,
      isOnline: false,
      dotColor: 'grey',
      text: `Active ${n} ${dayUnit} ago`,
      ariaLabel: `User was active ${n} ${dayUnit} ago`,
      minutesAgo: n * 1440,
    };
  }

  // 5. 72 hours or more → "Offline"
  return {
    visible: true,
    isOnline: false,
    dotColor: 'grey',
    text: 'Offline',
    ariaLabel: 'User is offline',
    minutesAgo: Math.floor(diff / 60_000),
  };
}

/**
 * Validates a presence write payload.
 */
export function validatePresencePayload(data: unknown): {
  valid: boolean;
  error?: string;
} {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Presence payload must be an object' };
  }
  const obj = data as Record<string, unknown>;
  if (obj.state !== 'online' && obj.state !== 'offline') {
    return { valid: false, error: 'state must be online or offline' };
  }
  if (typeof obj.lastActiveAt !== 'number' || !Number.isFinite(obj.lastActiveAt)) {
    return { valid: false, error: 'lastActiveAt must be a valid number' };
  }
  if (obj.showStatus !== undefined && typeof obj.showStatus !== 'boolean') {
    return { valid: false, error: 'showStatus must be a boolean when provided' };
  }
  return { valid: true };
}

/**
 * Generates a stable random connection ID for multi-tab/device tracking.
 */
export function generateConnectionId(): string {
  const rand = Math.random().toString(36).substring(2, 10);
  const ts = Date.now().toString(36);
  return `conn_${ts}_${rand}`;
}
