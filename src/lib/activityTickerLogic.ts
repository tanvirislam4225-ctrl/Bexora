import {
  CurrencyCode,
  DealRecord,
  PlatformId,
  PublicActivityItem,
  WithdrawalRequestRecord,
} from '../types';
import { PLATFORM_CATALOG } from './marketplaceLogic';

const VALID_PLATFORMS = new Set<string>([
  'youtube',
  'facebook',
  'instagram',
  'tiktok',
  'telegram',
  'website',
  'domain',
  'gaming',
]);

const VALID_CURRENCIES = new Set<string>(['BDT', 'USD']);

/**
 * Generates an opaque, collision-resistant public activity document ID
 * that NEVER embeds internal dealId, withdrawalId, or userId values.
 */
export function generateOpaquePublicActivityId(nowMs = Date.now()): string {
  const randPart = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  const cleanRand = randPart.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'x9a7b3c1';
  return `act_${Math.max(1, Math.floor(nowMs))}_${cleanRand}`;
}

/**
 * Defense-in-depth PII scrubber & user privacy opt-out resolver.
 * - If `hidePublicActivityName` is true, returns `'Verified Seller'` (when `nidVerified` is true)
 *   or `'BEXORA User'` (otherwise).
 * - Strips email addresses, phone/account digit runs (>= 6 digits), and URLs so PII never leaks
 *   even if a user typed an email or phone number into their display name.
 */
export function resolvePublicActivityActorName(opts: {
  displayName?: string | null;
  nidVerified?: boolean;
  hidePublicActivityName?: boolean;
}): string {
  const fallback = opts.nidVerified ? 'Verified Seller' : 'BEXORA User';
  if (opts.hidePublicActivityName) {
    return fallback;
  }

  let raw = String(opts.displayName || '').trim();
  if (!raw) return fallback;

  // Strip email patterns, URLs, and long digit sequences (phone / wallet numbers)
  if (raw.includes('@') || /https?:\/\//i.test(raw) || /\d[\d\s\-()+]{5,}\d/.test(raw)) {
    raw = raw
      .replace(/\S+@\S+\.\S+/g, '')
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\+?\d[\d\s\-()]{5,}\d/g, '')
      .trim();
  }

  // Collapse whitespace & strip control characters
  const cleaned = raw.replace(/[\u0000-\u001F\u007F<>]/g, '').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 2) {
    return fallback;
  }
  return cleaned.slice(0, 48);
}

/**
 * Sanitizes an asset title for public Recent Sold display:
 * - Removes URLs, emails, and long account/phone numbers
 * - Truncates cleanly to 64 characters, falling back to the platform category name.
 */
export function sanitizePublicAssetLabel(
  rawTitle: string | null | undefined,
  platform?: PlatformId | string | null
): string {
  const platKey = String(platform || '').toLowerCase() as PlatformId;
  const categoryFallback = PLATFORM_CATALOG[platKey]?.name || 'Digital Asset';

  const cleaned = String(rawTitle || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\S+@\S+\.\S+/g, '')
    .replace(/\+?\d[\d\s\-()]{6,}\d/g, '')
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 3) {
    return categoryFallback;
  }
  if (cleaned.length <= 58) {
    return cleaned;
  }
  return `${cleaned.slice(0, 55).trimEnd()}…`;
}

/**
 * Strictly checks whether a DealRecord qualifies for the public RECENT SOLD ticker.
 * Excludes unpaid, pending, in-progress, disputed, rejected, cancelled, and refunded deals.
 */
export function isEligibleSoldDealForTicker(
  deal: Partial<DealRecord> | null | undefined
): deal is DealRecord {
  if (!deal || deal.status !== 'settled') return false;
  const amount = Number(deal.baseAmountMinor);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (!VALID_CURRENCIES.has(String(deal.currency || ''))) return false;
  const ts = Number(deal.settledAtMs || deal.createdAtMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return true;
}

/**
 * Strictly checks whether a WithdrawalRequestRecord qualifies for the public RECENT PAYOUT ticker.
 * Excludes pending, failed, cancelled, or rejected withdrawals.
 */
export function isEligiblePaidWithdrawalForTicker(
  withdrawal: Partial<WithdrawalRequestRecord> | null | undefined
): withdrawal is WithdrawalRequestRecord {
  if (!withdrawal || withdrawal.status !== 'paid') return false;
  const amount = Number(withdrawal.amountMinor);
  if (!Number.isFinite(amount) || amount <= 0) return false;
  if (!VALID_CURRENCIES.has(String(withdrawal.currency || ''))) return false;
  const ts = Number(withdrawal.reviewedAtMs || withdrawal.createdAtMs || 0);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return true;
}

/**
 * Builds a strictly sanitized, PII-free PublicActivityItem payload for a settled deal.
 */
export function buildSanitizedSoldTickerPayload(opts: {
  deal: DealRecord;
  sellerDisplayName?: string | null;
  sellerNidVerified?: boolean;
  hidePublicActivityName?: boolean;
  nowMs?: number;
}): Omit<PublicActivityItem, 'id'> | null {
  if (!isEligibleSoldDealForTicker(opts.deal)) return null;

  const actorDisplayName = resolvePublicActivityActorName({
    displayName: opts.sellerDisplayName ?? opts.deal.sellerName,
    nidVerified: Boolean(opts.sellerNidVerified),
    hidePublicActivityName: Boolean(opts.hidePublicActivityName),
  });

  const platform = VALID_PLATFORMS.has(opts.deal.platform) ? opts.deal.platform : 'youtube';
  const assetTitle = sanitizePublicAssetLabel(opts.deal.listingTitle, platform);
  const completedAtMs = Math.max(
    1,
    Math.floor(Number(opts.deal.settledAtMs || opts.nowMs || opts.deal.createdAtMs))
  );

  return {
    kind: 'sold',
    actorDisplayName,
    actorVerified: Boolean(opts.sellerNidVerified),
    assetTitle,
    platform,
    amountMinor: Math.floor(opts.deal.baseAmountMinor),
    currency: opts.deal.currency,
    completedAtMs,
  };
}

/**
 * Builds a strictly sanitized, PII-free PublicActivityItem payload for a paid withdrawal.
 * Never includes payoutAccount, method numbers, referenceId, userId, or withdrawalId.
 */
export function buildSanitizedPayoutTickerPayload(opts: {
  withdrawal: WithdrawalRequestRecord;
  userDisplayName?: string | null;
  userNidVerified?: boolean;
  hidePublicActivityName?: boolean;
  nowMs?: number;
}): Omit<PublicActivityItem, 'id'> | null {
  if (!isEligiblePaidWithdrawalForTicker(opts.withdrawal)) return null;

  const actorDisplayName = resolvePublicActivityActorName({
    displayName: opts.userDisplayName ?? opts.withdrawal.userName,
    nidVerified: Boolean(opts.userNidVerified),
    hidePublicActivityName: Boolean(opts.hidePublicActivityName),
  });

  const completedAtMs = Math.max(
    1,
    Math.floor(Number(opts.withdrawal.reviewedAtMs || opts.nowMs || opts.withdrawal.createdAtMs))
  );

  return {
    kind: 'payout',
    actorDisplayName,
    actorVerified: Boolean(opts.userNidVerified),
    amountMinor: Math.floor(opts.withdrawal.amountMinor),
    currency: opts.withdrawal.currency,
    completedAtMs,
  };
}

/**
 * Validates and normalizes an incoming raw document from Firestore or `/api/public/activity-tickers`
 * into a safe `PublicActivityItem`, dropping malformed or invalid records.
 */
export function parseRawPublicActivityItem(
  id: string,
  raw: Record<string, unknown> | null | undefined
): PublicActivityItem | null {
  if (!id || !raw) return null;
  const kind = raw.kind === 'sold' || raw.kind === 'payout' ? raw.kind : null;
  if (!kind) return null;

  const amountMinor = Math.floor(Number(raw.amountMinor));
  const completedAtMs = Math.floor(Number(raw.completedAtMs));
  const currency = VALID_CURRENCIES.has(String(raw.currency || ''))
    ? (String(raw.currency) as CurrencyCode)
    : null;

  if (!currency || !Number.isFinite(amountMinor) || amountMinor <= 0) return null;
  if (!Number.isFinite(completedAtMs) || completedAtMs <= 0) return null;

  const actorVerified = Boolean(raw.actorVerified);
  const actorDisplayName = resolvePublicActivityActorName({
    displayName: String(raw.actorDisplayName || ''),
    nidVerified: actorVerified,
    hidePublicActivityName: false,
  });

  if (kind === 'sold') {
    const rawPlat = String(raw.platform || '').toLowerCase();
    const platform = VALID_PLATFORMS.has(rawPlat) ? (rawPlat as PlatformId) : undefined;
    const assetTitle = sanitizePublicAssetLabel(String(raw.assetTitle || ''), platform);
    return {
      id,
      kind: 'sold',
      actorDisplayName,
      actorVerified,
      assetTitle,
      platform,
      amountMinor,
      currency,
      completedAtMs,
    };
  }

  return {
    id,
    kind: 'payout',
    actorDisplayName,
    actorVerified,
    amountMinor,
    currency,
    completedAtMs,
  };
}

/**
 * Deduplicates by `id`, sorts newest-first by `completedAtMs`, and bounds list size.
 */
export function mergeAndSortTickerItems(
  items: PublicActivityItem[],
  maxItems = 20
): PublicActivityItem[] {
  const byId = new Map<string, PublicActivityItem>();
  for (const item of items) {
    if (!item || !item.id) continue;
    const prev = byId.get(item.id);
    if (!prev || item.completedAtMs >= prev.completedAtMs) {
      byId.set(item.id, item);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => b.completedAtMs - a.completedAtMs)
    .slice(0, Math.max(1, maxItems));
}

/**
 * Formats exact recorded transaction amount in its original recorded currency (`৳` for BDT, `$` for USD),
 * never inventing cross-currency conversions.
 */
export function formatRecordedTickerAmount(amountMinor: number, currency: CurrencyCode): string {
  const safeMinor = Math.max(0, Math.round(Number(amountMinor) || 0));
  const major = safeMinor / 100;
  const hasCents = safeMinor % 100 !== 0;

  if (currency === 'USD') {
    return `$${major.toLocaleString('en-US', {
      minimumFractionDigits: hasCents ? 2 : 0,
      maximumFractionDigits: 2,
    })}`;
  }

  return `৳${major.toLocaleString('en-US', {
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Formats a verified completion timestamp into a concise, truthful relative time string.
 * Clamps slight clock skew (`completedAtMs > nowMs`) to `"Just now"`.
 */
export function formatActivityRelativeTime(completedAtMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(completedAtMs) || completedAtMs <= 0) {
    return '';
  }
  const diffSec = Math.max(0, Math.floor((nowMs - completedAtMs) / 1000));
  if (diffSec < 45) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d ago`;

  const d = new Date(completedAtMs);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
