import type {
  DealRecord,
  NotificationCategory,
  NotificationRecord,
  NotificationRefType,
  NotificationSeverity,
  TokenServiceStatus,
} from '../types';

export interface SafeInternalDestination {
  raw: string;
  kind: 'view' | 'wallet' | 'profile_tab' | 'listing' | 'deal' | 'chat';
  view?: 'home' | 'market' | 'sellers' | 'chat' | 'deals' | 'profile' | 'admin';
  profileTab?: 'settings' | 'nid';
  targetId?: string;
  ctaLabel: string;
}

const VALID_ID_REGEX = /^[a-zA-Z0-9_-]{1,120}$/;

const STATIC_VIEW_DESTINATIONS: Record<
  string,
  { kind: 'view' | 'wallet' | 'profile_tab'; view?: SafeInternalDestination['view']; profileTab?: 'settings' | 'nid'; ctaLabel: string }
> = {
  home: { kind: 'view', view: 'home', ctaLabel: 'Go to Home' },
  market: { kind: 'view', view: 'market', ctaLabel: 'Browse Marketplace' },
  sellers: { kind: 'view', view: 'sellers', ctaLabel: 'View Sellers' },
  chat: { kind: 'view', view: 'chat', ctaLabel: 'Open Messages' },
  deals: { kind: 'view', view: 'deals', ctaLabel: 'Open Escrow Deals' },
  profile: { kind: 'view', view: 'profile', ctaLabel: 'Open My Profile' },
  admin: { kind: 'view', view: 'admin', ctaLabel: 'Open Admin Panel' },
  wallet: { kind: 'wallet', ctaLabel: 'Open Wallet' },
  'profile:settings': { kind: 'profile_tab', view: 'profile', profileTab: 'settings', ctaLabel: 'Open Account Security' },
  'profile:nid': { kind: 'profile_tab', view: 'profile', profileTab: 'nid', ctaLabel: 'Open Verification Settings' },
};

/**
 * Dual 32-bit FNV-1a deterministic hash for idempotent Firestore document IDs.
 * Pure, synchronous, and works identically in Node unit tests and browsers.
 */
export function deterministicHashHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= code ^ ((i & 0xff) + 17);
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

/**
 * Produces a deterministic, Firestore-safe notification ID (`^[a-zA-Z0-9_-]{1,120}$`).
 * Re-emitting the same logical event for the same recipient yields the exact same ID,
 * preventing duplicate notifications across retries, listeners, or page reloads.
 */
export function buildNotificationId(recipientId: string, eventKey: string): string {
  const cleanRecipient = String(recipientId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 28);
  const cleanEventPrefix = String(eventKey || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40);
  const digest = deterministicHashHex(`${recipientId.trim()}::${eventKey.trim()}`);
  const candidate = `ntf_${cleanRecipient || 'usr'}_${cleanEventPrefix || 'evt'}_${digest}`.slice(0, 112);
  return VALID_ID_REGEX.test(candidate) ? candidate : `ntf_${digest}`;
}

export function isValidFirestoreDocId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 120 && VALID_ID_REGEX.test(id);
}

/**
 * Strictly validates notification navigation targets against an internal allowlist.
 * Blocks external URLs, protocol handlers (`javascript:`, `data:`, `http:`, `https:`),
 * protocol-relative paths (`//`), path traversal, and malformed entity IDs.
 */
export function sanitizeNotificationDestination(dest?: string | null): SafeInternalDestination | null {
  if (typeof dest !== 'string') return null;
  const trimmed = dest.trim();
  if (!trimmed || trimmed.length > 160) return null;

  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('http:') ||
    lower.startsWith('https:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('file:') ||
    lower.startsWith('blob:') ||
    lower.startsWith('//') ||
    trimmed.includes('\\') ||
    trimmed.includes('<') ||
    trimmed.includes('>') ||
    trimmed.includes('..')
  ) {
    return null;
  }

  const staticMatch = STATIC_VIEW_DESTINATIONS[trimmed];
  if (staticMatch) {
    return {
      raw: trimmed,
      kind: staticMatch.kind,
      view: staticMatch.view,
      profileTab: staticMatch.profileTab,
      ctaLabel: staticMatch.ctaLabel,
    };
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0) return null;
  const prefix = trimmed.slice(0, colonIdx);
  const entityId = trimmed.slice(colonIdx + 1);
  if (!isValidFirestoreDocId(entityId)) return null;

  if (prefix === 'listing') {
    return { raw: trimmed, kind: 'listing', targetId: entityId, ctaLabel: 'View Listing' };
  }
  if (prefix === 'deal') {
    return { raw: trimmed, kind: 'deal', view: 'deals', targetId: entityId, ctaLabel: 'Open Deal Room' };
  }
  if (prefix === 'admindeal') {
    return { raw: trimmed, kind: 'view', view: 'admin', targetId: entityId, ctaLabel: 'Review Deal in Admin' };
  }
  if (prefix === 'chat') {
    return { raw: trimmed, kind: 'chat', view: 'chat', targetId: entityId, ctaLabel: 'Open Conversation' };
  }

  return null;
}

export function truncateNotificationField(value: string, maxLen: number): string {
  const normalized = String(value || '').trim();
  if (normalized.length <= maxLen) return normalized;
  if (maxLen <= 3) return normalized.slice(0, maxLen);
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}

export function sortNotificationsNewestFirst<T extends { createdAtMs: number; id: string }>(
  items: ReadonlyArray<T>
): T[] {
  return [...items].sort((a, b) => {
    const diff = (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0);
    if (diff !== 0) return diff;
    return String(b.id).localeCompare(String(a.id));
  });
}

export function computeUnreadNotificationCount(items: ReadonlyArray<{ read: boolean }>): number {
  let count = 0;
  for (const item of items) {
    if (item && item.read === false) count += 1;
  }
  return count;
}

export function formatUnreadBadgeCount(unreadCount: number): string {
  const safe = Math.max(0, Math.floor(Number(unreadCount) || 0));
  if (safe === 0) return '';
  if (safe > 99) return '99+';
  return String(safe);
}

/**
 * Splits items into chunks well below Firestore's 500-operation `writeBatch` limit.
 */
export function chunkForFirestoreBatch<T>(items: ReadonlyArray<T>, maxChunkSize = 450): T[][] {
  const safeLimit = Math.max(1, Math.min(450, Math.floor(maxChunkSize) || 450));
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += safeLimit) {
    chunks.push(items.slice(i, i + safeLimit));
  }
  return chunks;
}

export function formatNotificationTimestamp(createdAtMs: number, nowMs = Date.now()): string {
  const ts = Number(createdAtMs) || 0;
  if (ts <= 0) return 'Just now';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 45) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatNotificationExactDateTime(createdAtMs: number): string {
  const ts = Number(createdAtMs) || 0;
  if (ts <= 0) return 'Recent';
  return new Date(ts).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getNotificationCategoryLabel(category: NotificationCategory): string {
  switch (category) {
    case 'account':
      return 'Account';
    case 'security':
      return 'Security';
    case 'verification':
      return 'Verification';
    case 'listing':
      return 'Listing';
    case 'bid':
      return 'Bid';
    case 'deal':
      return 'Escrow Deal';
    case 'dispute':
      return 'Dispute & Report';
    case 'wallet':
      return 'Wallet';
    case 'announcement':
      return 'Announcement';
    case 'system':
      return 'System';
  }
}

export interface DealDeadlineReminderSpec {
  eventKey: string;
  recipientIds: string[];
  severity: NotificationSeverity;
  title: string;
  preview: string;
  body: string;
  refType: NotificationRefType;
  refId: string;
  referenceLabel: string;
  destination: string;
}

/**
 * Evaluates whether an active escrow deal has entered its final 6-hour buyer protection window
 * or has passed its security deadline without open disputes.
 */
export function evaluateDealDeadlineNotification(
  deal: Pick<
    DealRecord,
    'id' | 'status' | 'originalDeadlineMs' | 'listingTitle' | 'buyerId' | 'sellerId' | 'unresolvedReportCount'
  >,
  nowMs: number
): DealDeadlineReminderSpec | null {
  if (!deal || (deal.status !== 'protection_active' && deal.status !== 'security_period_active')) {
    return null;
  }
  if ((deal.unresolvedReportCount || 0) > 0) return null;
  const deadline = Number(deal.originalDeadlineMs) || 0;
  if (deadline <= 0) return null;

  const remainingMs = deadline - nowMs;
  const recipients = Array.from(new Set([deal.buyerId, deal.sellerId].filter(Boolean)));
  if (recipients.length === 0) return null;

  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  if (remainingMs <= 0) {
    return {
      eventKey: `deal_protection_expired_${deal.id}_${deadline}`,
      recipientIds: recipients,
      severity: 'info',
      title: 'Security Protection Period Completed',
      preview: `Escrow security timer ended for "${deal.listingTitle}". Ready for final settlement.`,
      body: `The scheduled buyer security period for "${deal.listingTitle}" (Deal #${deal.id.slice(0, 10)}) has elapsed with zero unresolved reports. An administrator can now verify and release the seller payout in Escrow Deals.`,
      refType: 'deal',
      refId: deal.id,
      referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
      destination: `deal:${deal.id}`,
    };
  }

  if (remainingMs <= SIX_HOURS_MS) {
    const hrsLeft = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
    return {
      eventKey: `deal_protection_expiring_6h_${deal.id}_${deadline}`,
      recipientIds: recipients,
      severity: 'warning',
      title: `Security Period Ending Soon (~${hrsLeft}h left)`,
      preview: `Verify transferred credentials for "${deal.listingTitle}" before the security timer ends.`,
      body: `Approximately ${hrsLeft} hour(s) remain in the buyer security protection period for "${deal.listingTitle}" (Deal #${deal.id.slice(0, 10)}). Confirm full account control or submit an issue report before the timer expires.`,
      refType: 'deal',
      refId: deal.id,
      referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
      destination: `deal:${deal.id}`,
    };
  }

  return null;
}

export interface TokenServiceProbeInput {
  configProjectId: string;
  configProjectNumber: string;
  configApiKey: string;
  httpStatus: number | null;
  responseBody: string;
  enablementPending?: boolean;
  permissionDeniedOnEnable?: boolean;
}

/**
 * Classifies live `securetoken.googleapis.com` probe results into 6 unambiguous diagnostic states.
 * Never collapses network failures or unverified states into `enabled_verified`.
 */
export function classifyTokenServiceProbe(input: TokenServiceProbeInput): TokenServiceStatus {
  const projectId = String(input.configProjectId || '').trim();
  const projectNumber = String(input.configProjectNumber || '').trim();
  const apiKey = String(input.configApiKey || '').trim();

  if (!projectId || !projectNumber || !apiKey || projectId === 'remixed-project-id') {
    return 'config_mismatch';
  }

  const body = String(input.responseBody || '');
  if (
    body.includes('API_KEY_INVALID') ||
    body.includes('PROJECT_NOT_FOUND') ||
    (body.includes('projects/') && !body.includes(`projects/${projectNumber}`) && !body.includes(projectId))
  ) {
    return 'config_mismatch';
  }

  // HTTP 400 INVALID_REFRESH_TOKEN / MISSING_REFRESH_TOKEN proves securetoken.googleapis.com
  // is actively enabled and servicing requests for this project & API key.
  if (input.httpStatus === 400 && (body.includes('INVALID_REFRESH_TOKEN') || body.includes('MISSING_REFRESH_TOKEN') || body.includes('INVALID_GRANT_TYPE'))) {
    return 'enabled_verified';
  }
  if (input.httpStatus === 200) {
    return 'enabled_verified';
  }

  if (input.httpStatus === 403) {
    if (
      body.includes('SERVICE_DISABLED') ||
      body.includes('securetoken.googleapis.com') ||
      body.includes('Token Service API') ||
      body.includes('has not been used in project')
    ) {
      if (input.enablementPending) return 'enablement_pending';
      if (input.permissionDeniedOnEnable) return 'permission_denied';
      return 'disabled';
    }
    return 'config_mismatch';
  }

  if (input.httpStatus === null || input.httpStatus >= 500 || input.httpStatus === 0 || input.httpStatus === 429) {
    return 'unable_to_verify';
  }

  return 'unable_to_verify';
}

export type AuthFailureClassification =
  | 'token_service_disabled'
  | 'password_provider_disabled'
  | 'phone_provider_disabled'
  | 'unauthorized_domain'
  | 'popup_closed_or_blocked'
  | 'network_offline'
  | 'invalid_credentials'
  | 'firestore_permission_denied'
  | 'unknown';

/**
 * Separates `securetoken.googleapis.com` errors from unrelated Firebase Auth or Firestore errors
 * so the Token Service API banner is never falsely triggered by unrelated failures.
 */
export function classifyAuthFailureCause(errorInput: unknown): AuthFailureClassification {
  const raw =
    errorInput instanceof Error
      ? `${(errorInput as { code?: string }).code || ''} ${errorInput.message}`
      : String(errorInput || '');
  const lower = raw.toLowerCase();

  if (
    lower.includes('token-service-api-has-not-been-used') ||
    lower.includes('securetoken.googleapis.com') ||
    lower.includes('service_disabled')
  ) {
    return 'token_service_disabled';
  }
  if (lower.includes('password_login_disabled') || lower.includes('auth/operation-not-allowed')) {
    return 'password_provider_disabled';
  }
  if (lower.includes('billing_not_enabled') || lower.includes('auth/quota-exceeded')) {
    return 'phone_provider_disabled';
  }
  if (lower.includes('auth/unauthorized-domain')) {
    return 'unauthorized_domain';
  }
  if (lower.includes('auth/popup-closed-by-user') || lower.includes('auth/popup-blocked') || lower.includes('auth/cancelled-popup-request')) {
    return 'popup_closed_or_blocked';
  }
  if (lower.includes('auth/network-request-failed') || lower.includes('client is offline')) {
    return 'network_offline';
  }
  if (
    lower.includes('auth/invalid-credential') ||
    lower.includes('auth/wrong-password') ||
    lower.includes('auth/user-not-found')
  ) {
    return 'invalid_credentials';
  }
  if (lower.includes('missing or insufficient permissions') || lower.includes('permission-denied')) {
    return 'firestore_permission_denied';
  }
  return 'unknown';
}

export function filterNotificationsForRecipient(
  items: ReadonlyArray<NotificationRecord>,
  uid: string | null | undefined
): NotificationRecord[] {
  if (!uid) return [];
  return sortNotificationsNewestFirst(items.filter((item) => item && item.recipientId === uid));
}
