import type { DealRecord, GatewayPaymentMethodSetting, MarketplaceListing } from '../types';

export const LISTING_RESERVATION_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MIN_WALLET_TOPUP_BDT = 10;
export const MAX_WALLET_TOPUP_BDT = 500_000;

export const CUSTOMER_GATEWAY_UNAVAILABLE_MESSAGE =
  'Live payment gateway is temporarily unavailable. Please try again shortly.';

export const DEFAULT_GATEWAY_DISPLAY_METHODS: GatewayPaymentMethodSetting[] = [
  {
    id: 'bkash',
    name: 'bKash',
    badge: 'Mobile Wallet',
    color: '#E2136E',
    enabled: true,
    order: 0,
  },
  {
    id: 'nagad',
    name: 'Nagad',
    badge: 'Mobile Wallet',
    color: '#F26522',
    enabled: true,
    order: 1,
  },
  {
    id: 'rocket',
    name: 'Rocket',
    badge: 'DBBL Mobile',
    color: '#8C3494',
    enabled: true,
    order: 2,
  },
  {
    id: 'cards',
    name: 'Visa / Mastercard',
    badge: 'Cards',
    color: '#1A4FA3',
    enabled: true,
    order: 3,
  },
];

const FORBIDDEN_DEV_PHRASES: RegExp[] = [
  /payment\s+plugin\s+not\s+installed/i,
  /you\s+need\s+to\s+add\s+the\s+plugin/i,
  /gateway\s+will\s+be\s+added\s+later/i,
  /wordpress\s+integration\s+is\s+not\s+configured/i,
  /securepay_api_key\s+is\s+not\s+configured/i,
  /manual\s+deposits\s+updating/i,
  /mock_gateway/i,
  /mock_trx_/i,
];

export function hasForbiddenDeveloperCopy(text: string): boolean {
  const input = String(text || '');
  return FORBIDDEN_DEV_PHRASES.some((rx) => rx.test(input));
}

export function sanitizeCustomerGatewayError(rawMessage: unknown): string {
  const msg = String(rawMessage || '').trim();
  if (!msg || hasForbiddenDeveloperCopy(msg)) {
    return CUSTOMER_GATEWAY_UNAVAILABLE_MESSAGE;
  }
  if (/not configured|missing api key|wordpress|plugin|enotfound|econnrefused|fetch failed|502|503|504/i.test(msg)) {
    return CUSTOMER_GATEWAY_UNAVAILABLE_MESSAGE;
  }
  return msg.slice(0, 240);
}

export function normalizeGatewayPaymentMethods(raw: unknown): GatewayPaymentMethodSetting[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_GATEWAY_DISPLAY_METHODS.map((m) => ({ ...m }));
  }

  const seen = new Set<string>();
  const normalized: GatewayPaymentMethodSetting[] = [];

  for (let i = 0; i < raw.length && normalized.length < 12; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawId = String(rec.id || rec.name || `method_${i}`)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '_')
      .slice(0, 32);
    if (!rawId || seen.has(rawId)) continue;
    const name = String(rec.name || '').trim().slice(0, 48);
    if (!name) continue;
    seen.add(rawId);

    const badge = String(rec.badge || 'Instant Pay').trim().slice(0, 28) || 'Instant Pay';
    const rawColor = String(rec.color || '#FF6500').trim();
    const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#FF6500';
    const order =
      typeof rec.order === 'number' && Number.isFinite(rec.order) ? Math.floor(rec.order) : i;

    normalized.push({
      id: rawId,
      name,
      badge,
      color,
      enabled: rec.enabled !== false,
      order,
    });
  }

  if (normalized.length === 0) {
    return DEFAULT_GATEWAY_DISPLAY_METHODS.map((m) => ({ ...m }));
  }

  normalized.sort((a, b) => a.order - b.order);
  return normalized.map((m, idx) => ({ ...m, order: idx }));
}

export function upsertGatewayDisplayMethod(
  list: ReadonlyArray<GatewayPaymentMethodSetting>,
  method: Omit<GatewayPaymentMethodSetting, 'order'> & { order?: number }
): GatewayPaymentMethodSetting[] {
  const cleanId = String(method.id || method.name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 32);
  const cleanName = String(method.name || '').trim().slice(0, 48);
  if (!cleanId || !cleanName) return [...list];

  const cleanBadge = String(method.badge || 'Instant Pay').trim().slice(0, 28) || 'Instant Pay';
  const cleanColor = /^#[0-9a-fA-F]{6}$/.test(String(method.color || '').trim())
    ? String(method.color).trim()
    : '#FF6500';

  const existingIdx = list.findIndex((m) => m.id === cleanId);
  const next = list.map((m) => ({ ...m }));
  if (existingIdx >= 0) {
    next[existingIdx] = {
      id: cleanId,
      name: cleanName,
      badge: cleanBadge,
      color: cleanColor,
      enabled: Boolean(method.enabled),
      order: existingIdx,
    };
  } else {
    next.push({
      id: cleanId,
      name: cleanName,
      badge: cleanBadge,
      color: cleanColor,
      enabled: Boolean(method.enabled),
      order: next.length,
    });
  }
  return next.map((m, idx) => ({ ...m, order: idx }));
}

export function toggleGatewayDisplayMethod(
  list: ReadonlyArray<GatewayPaymentMethodSetting>,
  methodId: string
): GatewayPaymentMethodSetting[] {
  return list.map((m, idx) =>
    m.id === methodId ? { ...m, enabled: !m.enabled, order: idx } : { ...m, order: idx }
  );
}

export function moveGatewayDisplayMethod(
  list: ReadonlyArray<GatewayPaymentMethodSetting>,
  methodId: string,
  direction: 'up' | 'down'
): GatewayPaymentMethodSetting[] {
  const next = list.map((m) => ({ ...m }));
  const idx = next.findIndex((m) => m.id === methodId);
  if (idx < 0) return next;
  const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= next.length) return next;
  const tmp = next[idx];
  next[idx] = next[targetIdx];
  next[targetIdx] = tmp;
  return next.map((m, order) => ({ ...m, order }));
}

export function validateWalletTopupAmountBdt(rawAmount: unknown): {
  valid: boolean;
  amountBdt: number;
  amountMinor: number;
  error?: string;
} {
  const num = Number(rawAmount);
  if (!Number.isFinite(num) || num <= 0) {
    return {
      valid: false,
      amountBdt: 0,
      amountMinor: 0,
      error: 'Enter a valid BDT top-up amount.',
    };
  }
  const rounded = Math.round(num);
  if (Math.abs(num - rounded) > 1e-6) {
    return {
      valid: false,
      amountBdt: 0,
      amountMinor: 0,
      error: 'Please enter a whole BDT amount (no fractional paisa).',
    };
  }
  if (rounded < MIN_WALLET_TOPUP_BDT) {
    return {
      valid: false,
      amountBdt: 0,
      amountMinor: 0,
      error: `Minimum wallet top-up is ৳${MIN_WALLET_TOPUP_BDT} BDT.`,
    };
  }
  if (rounded > MAX_WALLET_TOPUP_BDT) {
    return {
      valid: false,
      amountBdt: 0,
      amountMinor: 0,
      error: `Maximum single wallet top-up is ৳${MAX_WALLET_TOPUP_BDT.toLocaleString()} BDT.`,
    };
  }
  return {
    valid: true,
    amountBdt: rounded,
    amountMinor: rounded * 100,
  };
}

export function verifyGatewayPaidAmountMatchesSession(params: {
  expectedBdt: number;
  returnedAmountBdt: unknown;
  gatewayStatus: unknown;
}): { verified: boolean; reason?: string } {
  const statusStr = String(params.gatewayStatus || '').trim().toUpperCase();
  if (statusStr !== 'COMPLETED') {
    return {
      verified: false,
      reason: statusStr === 'PENDING' ? 'Payment is still pending confirmation.' : 'Payment has not completed.',
    };
  }
  const expected = Number(params.expectedBdt);
  const returned = Number(params.returnedAmountBdt);
  if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(returned) || returned <= 0) {
    return {
      verified: false,
      reason: 'Payment amount could not be verified.',
    };
  }
  if (Math.abs(returned - expected) >= 0.01) {
    return {
      verified: false,
      reason: `Payment amount mismatch (expected ৳${expected}, verified ৳${returned}).`,
    };
  }
  return { verified: true };
}

export function buildTopupLedgerId(sessionId: string): string {
  const clean = String(sessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return `led_topup_${clean}`.slice(0, 120);
}

export function getListingReservationExpiryMs(
  listing: Pick<MarketplaceListing, 'reservedUntilMs' | 'reservationExpiresAtMs'> | Record<string, unknown>
): number {
  const until = Number((listing as Record<string, unknown>).reservedUntilMs || 0);
  const exp = Number((listing as Record<string, unknown>).reservationExpiresAtMs || 0);
  return Math.max(
    Number.isFinite(until) && until > 0 ? until : 0,
    Number.isFinite(exp) && exp > 0 ? exp : 0
  );
}

export function isListingReservationActive(
  listing: Pick<MarketplaceListing, 'status' | 'reservedUntilMs' | 'reservationExpiresAtMs'> | Record<string, unknown>,
  nowMs = Date.now()
): boolean {
  if (String((listing as Record<string, unknown>).status || '') !== 'reserved') return false;
  const expiry = getListingReservationExpiryMs(listing);
  // If an accepted-bid reservation has no timed checkout expiry, it remains reserved until cancelled/paid.
  if (expiry === 0) return true;
  return expiry > nowMs;
}

export function canAcquireListingReservation(
  listing: {
    status?: unknown;
    reservedBuyerId?: unknown;
    activeDealId?: unknown;
    reservedUntilMs?: unknown;
    reservationExpiresAtMs?: unknown;
  },
  buyerId: string,
  nowMs = Date.now()
): { allowed: boolean; reason?: string; shouldExpireExisting: boolean } {
  const status = String(listing.status || '');
  if (status === 'active') {
    return { allowed: true, shouldExpireExisting: false };
  }
  if (status !== 'reserved') {
    return {
      allowed: false,
      reason: 'This listing is no longer available for purchase.',
      shouldExpireExisting: false,
    };
  }

  const expiry = getListingReservationExpiryMs(listing);
  const existingBuyer = String(listing.reservedBuyerId || '').trim();
  const activeDealId = String(listing.activeDealId || '').trim();

  // Accepted-bid reservation without timed checkout expiry cannot be hijacked by another buyer
  if (expiry === 0 && activeDealId) {
    if (existingBuyer === buyerId) {
      return { allowed: true, shouldExpireExisting: false };
    }
    return {
      allowed: false,
      reason: 'This listing is reserved for an accepted-bid deal.',
      shouldExpireExisting: false,
    };
  }

  if (expiry > nowMs) {
    if (existingBuyer === buyerId) {
      return { allowed: true, shouldExpireExisting: false };
    }
    return {
      allowed: false,
      reason:
        'Another buyer currently has this listing reserved in checkout. Please check back in a few minutes.',
      shouldExpireExisting: false,
    };
  }

  // Timed checkout reservation expired -> can lazily reclaim and override
  return { allowed: true, shouldExpireExisting: true };
}

export function computeReservationCountdown(
  reservedUntilMs: number | undefined | null,
  nowMs = Date.now()
): {
  active: boolean;
  expired: boolean;
  remainingMs: number;
  minutes: number;
  seconds: number;
  formatted: string;
} {
  const target = Number(reservedUntilMs || 0);
  if (!Number.isFinite(target) || target <= 0) {
    return {
      active: false,
      expired: false,
      remainingMs: 0,
      minutes: 0,
      seconds: 0,
      formatted: '00:00',
    };
  }
  const remainingMs = Math.max(0, target - nowMs);
  if (remainingMs === 0) {
    return {
      active: false,
      expired: true,
      remainingMs: 0,
      minutes: 0,
      seconds: 0,
      formatted: '00:00',
    };
  }
  const totalSec = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return {
    active: true,
    expired: false,
    remainingMs,
    minutes,
    seconds,
    formatted: `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`,
  };
}

export function shouldRecordLatePaymentReconciliation(params: {
  listingStatus: string;
  reservationSessionId?: string | null;
  sessionId: string;
  reservedBuyerId?: string | null;
  buyerId: string;
}): boolean {
  const st = String(params.listingStatus || '');
  if (st === 'sold') {
    return true;
  }
  if (st === 'reserved') {
    if (params.reservationSessionId && params.reservationSessionId !== params.sessionId) {
      return true;
    }
    if (params.reservedBuyerId && params.reservedBuyerId !== params.buyerId) {
      return true;
    }
  }
  return false;
}

export function generateDealCode(dealId: string, createdAtMs?: number): string {
  const cleanId = String(dealId || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  let hash = 0;
  const seed = `${cleanId}:${createdAtMs || 0}`;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let suffix = '';
  let val = hash;
  for (let i = 0; i < 6; i++) {
    suffix += alphabet[val % alphabet.length];
    val = Math.floor(val / alphabet.length) || (hash >> (i + 1));
  }
  return `BXR-${suffix}`;
}

export function resolveDisplayDealCode(deal: Pick<DealRecord, 'id' | 'dealCode' | 'createdAtMs'>): string {
  const raw = String(deal.dealCode || '').trim().toUpperCase();
  if (raw) return raw;
  return generateDealCode(deal.id, deal.createdAtMs);
}

export function matchesAdminDealQuery(
  deal: Partial<DealRecord> & { id: string },
  queryText: string
): boolean {
  const q = String(queryText || '').trim().toLowerCase();
  if (!q) return true;
  const code = resolveDisplayDealCode({
    id: deal.id,
    dealCode: deal.dealCode,
    createdAtMs: Number(deal.createdAtMs || 0),
  });
  const haystack = [
    code,
    deal.dealCode || '',
    deal.id,
    deal.listingId || '',
    deal.listingTitle || '',
    deal.buyerName || '',
    deal.buyerId || '',
    deal.sellerName || '',
    deal.sellerId || '',
    deal.platform || '',
    deal.status || '',
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(q);
}

export function buildSafeDealDeletionUpdate(params: {
  actorUid: string;
  reason?: string;
  nowMs?: number;
}): {
  isDeleted: true;
  deletedAtMs: number;
  deletedBy: string;
  deletionReason: string;
} {
  const reason = String(params.reason || '')
    .trim()
    .slice(0, 400);
  return {
    isDeleted: true,
    deletedAtMs: params.nowMs ?? Date.now(),
    deletedBy: String(params.actorUid || '').trim(),
    deletionReason: reason || 'Deleted by Administrator from Deal Review panel.',
  };
}
