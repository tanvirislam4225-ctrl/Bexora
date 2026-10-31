import {
  AuthProviderStatus,
  CurrencyCode,
  DealReportCategory,
  DealStatus,
  ListingStatus,
  PlatformId,
  PublicSettings,
} from '../types';

export interface PlatformDefinition {
  id: PlatformId;
  name: string;
  subcategories: string[];
  metricLabel: string;
  supportsMonetization: boolean;
  requiresUrl: boolean;
  requiresAge: boolean;
  urlHint: string;
  monetizationOptions: { id: string; name: string }[];
}

export const DEFAULT_GAMING_TITLES: string[] = [
  'Free Fire',
  'PUBG Mobile',
  'Mobile Legends: Bang Bang',
  'Call of Duty: Mobile',
  'Roblox',
];

export const PLATFORM_CATALOG: Record<PlatformId, PlatformDefinition> = {
  youtube: {
    id: 'youtube',
    name: 'YouTube',
    subcategories: ['YouTube Channel'],
    metricLabel: 'Subscribers',
    supportsMonetization: true,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://youtube.com/@yourchannel',
    monetizationOptions: [
      { id: 'yt-ypp', name: 'YouTube Partner Program' },
      { id: 'yt-ads', name: 'Advertising Revenue' },
      { id: 'yt-premium', name: 'YouTube Premium Revenue' },
      { id: 'yt-members', name: 'Channel Memberships' },
      { id: 'yt-supers', name: 'Supers (Super Chat / Thanks)' },
      { id: 'yt-shopping', name: 'Shopping' },
    ],
  },
  facebook: {
    id: 'facebook',
    name: 'Facebook',
    subcategories: ['Facebook Page', 'Facebook Group'],
    metricLabel: 'Followers / Members',
    supportsMonetization: true,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://facebook.com/yourpage',
    monetizationOptions: [
      { id: 'fb-content', name: 'Content Monetization' },
      { id: 'fb-reels', name: 'Ads on Reels' },
      { id: 'fb-stars', name: 'Stars' },
      { id: 'fb-subs', name: 'Subscriptions' },
      { id: 'fb-instream', name: 'In-Stream Ads' },
    ],
  },
  instagram: {
    id: 'instagram',
    name: 'Instagram',
    subcategories: ['Instagram Account'],
    metricLabel: 'Followers',
    supportsMonetization: true,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://instagram.com/youraccount',
    monetizationOptions: [
      { id: 'ig-subs', name: 'Subscriptions' },
      { id: 'ig-gifts', name: 'Gifts' },
      { id: 'ig-bonus', name: 'Bonuses' },
    ],
  },
  tiktok: {
    id: 'tiktok',
    name: 'TikTok',
    subcategories: ['TikTok Account'],
    metricLabel: 'Followers',
    supportsMonetization: true,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://tiktok.com/@youraccount',
    monetizationOptions: [
      { id: 'tt-rewards', name: 'Creator Rewards' },
      { id: 'tt-live', name: 'LIVE Gifts' },
      { id: 'tt-subs', name: 'Subscriptions' },
      { id: 'tt-shop', name: 'TikTok Shop' },
    ],
  },
  telegram: {
    id: 'telegram',
    name: 'Telegram',
    subcategories: ['Telegram Channel', 'Telegram Group'],
    metricLabel: 'Members',
    supportsMonetization: true,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://t.me/yourchannel',
    monetizationOptions: [
      { id: 'tg-stars', name: 'Telegram Stars' },
      { id: 'tg-ads', name: 'Channel Ads' },
    ],
  },
  website: {
    id: 'website',
    name: 'Websites',
    subcategories: ['Website', 'SaaS / Online Business'],
    metricLabel: 'Monthly Visitors',
    supportsMonetization: true,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://yourwebsite.com',
    monetizationOptions: [
      { id: 'wb-adsense', name: 'Google AdSense' },
      { id: 'wb-affiliate', name: 'Affiliate Income' },
      { id: 'wb-sponsor', name: 'Direct Sponsorships' },
    ],
  },
  domain: {
    id: 'domain',
    name: 'Domains',
    subcategories: ['Domain Name'],
    metricLabel: 'Monthly Type-In Visits',
    supportsMonetization: false,
    requiresUrl: true,
    requiresAge: true,
    urlHint: 'https://yourdomain.com',
    monetizationOptions: [],
  },
  gaming: {
    id: 'gaming',
    name: 'Gaming',
    subcategories: ['Gaming Account'],
    metricLabel: 'Account Level',
    supportsMonetization: false,
    requiresUrl: false,
    requiresAge: true,
    urlHint: '',
    monetizationOptions: [],
  },
};

export const PLATFORM_LIST: PlatformId[] = [
  'youtube',
  'facebook',
  'instagram',
  'tiktok',
  'telegram',
  'website',
  'domain',
  'gaming',
];

export const DEFAULT_PUBLIC_SETTINGS: PublicSettings = {
  buyerFeeEnabled: true,
  buyerFeePct: 5,
  sellerFeeEnabled: false,
  sellerFeePct: 0,
  usdToBdtRate: 120,
  supportWhatsapp: '',
  supportTelegram: '',
  supportEmail: '',
  bkashNumber: '',
  nagadNumber: '',
  rocketNumber: '',
  aiEmergencyStop: false,
  disabledMonetizationIds: [],
  gamingTitles: DEFAULT_GAMING_TITLES,
  protectionHoursYoutube: 168, // 7 days (168 hours)
  protectionHoursFacebook: 40, // 40 hours
  protectionHoursDefault: 40, // 40 hours for other standard-transfer assets
  customProtectionWindowsEnabled: false,
  fcmVapidPublicKey: '',
  wordpressPaymentEnabled: false,
  wordpressSiteUrl: '',
  wordpressBridgeEndpoint: '/wp-json/bexora/v1',
  siteName: 'BEXORA',
  brandTagline: 'Escrow-Protected Digital Asset Marketplace',
  logoUrl: '',
  noticeBannerEnabled: false,
  noticeBannerText: '',
  enabledLanguages: ['en', 'bn', 'hi', 'ar', 'ur'],
};

export function getMonetizationLabel(optionId: string): string {
  for (const p of PLATFORM_LIST) {
    const found = PLATFORM_CATALOG[p].monetizationOptions.find((o) => o.id === optionId);
    if (found) return found.name;
  }
  return optionId;
}

export function getCategoryMetricLabel(platform: PlatformId, subcategory?: string): string {
  if (platform === 'facebook') {
    if (subcategory === 'Facebook Group') return 'Group Members';
    if (subcategory === 'Facebook Page') return 'Page Followers';
    return 'Followers / Members';
  }
  return PLATFORM_CATALOG[platform].metricLabel;
}

/**
 * Returns the asset-specific security countdown duration in hours:
 * - YouTube assets: 168 hours (7 days)
 * - Facebook and other eligible standard-transfer assets: 40 hours
 * Explicit admin overrides apply only when `settings.customProtectionWindowsEnabled === true`.
 */
export function getProtectionDurationHours(platform: PlatformId, settings?: PublicSettings): number {
  if (settings?.customProtectionWindowsEnabled === true) {
    if (platform === 'youtube') return Math.max(1, Math.min(720, Math.round(settings.protectionHoursYoutube || 168)));
    if (platform === 'facebook') return Math.max(1, Math.min(720, Math.round(settings.protectionHoursFacebook || 40)));
    return Math.max(1, Math.min(720, Math.round(settings.protectionHoursDefault || 40)));
  }
  if (platform === 'youtube') return 168;
  return 40;
}

export interface CommissionBreakdown {
  baseAmountMinor: number;
  buyerFeePct: number;
  sellerFeePct: number;
  buyerFeeMinor: number;
  sellerFeeMinor: number;
  buyerTotalMinor: number;
  sellerPayoutMinor: number;
  platformCommissionMinor: number;
}

/**
 * Calculates buyer and seller commissions independently from the accepted base deal price (in integer minor units).
 * Satisfies invariants:
 *   BuyerTotal = P + BuyerFee
 *   SellerPayout = P - SellerFee
 *   PlatformRevenue = BuyerFee + SellerFee
 */
export function calculateCommission(
  baseAmountMinor: number,
  buyerFeePct: number,
  sellerFeePct: number,
  buyerFeeEnabled = true,
  sellerFeeEnabled = true
): CommissionBreakdown {
  if (!Number.isInteger(baseAmountMinor) || baseAmountMinor <= 0) {
    throw new Error('Accepted deal amount must be a positive integer in minor units.');
  }
  if (!Number.isFinite(buyerFeePct) || buyerFeePct < 0 || buyerFeePct > 50) {
    throw new Error('Buyer fee percentage must be between 0% and 50%.');
  }
  if (!Number.isFinite(sellerFeePct) || sellerFeePct < 0 || sellerFeePct > 50) {
    throw new Error('Seller fee percentage must be between 0% and 50%.');
  }

  const effectiveBuyerPct = buyerFeeEnabled ? buyerFeePct : 0;
  const effectiveSellerPct = sellerFeeEnabled ? sellerFeePct : 0;

  const buyerFeeMinor = Math.round((baseAmountMinor * effectiveBuyerPct) / 100);
  const sellerFeeMinor = Math.round((baseAmountMinor * effectiveSellerPct) / 100);
  const buyerTotalMinor = baseAmountMinor + buyerFeeMinor;
  const sellerPayoutMinor = baseAmountMinor - sellerFeeMinor;
  const platformCommissionMinor = buyerFeeMinor + sellerFeeMinor;

  return {
    baseAmountMinor,
    buyerFeePct: effectiveBuyerPct,
    sellerFeePct: effectiveSellerPct,
    buyerFeeMinor,
    sellerFeeMinor,
    buyerTotalMinor,
    sellerPayoutMinor,
    platformCommissionMinor,
  };
}

export function formatMoneyFromMinor(
  amountMinor: number,
  displayCurrency: CurrencyCode = 'BDT',
  storedCurrency: CurrencyCode = 'BDT',
  usdToBdtRate = 120
): string {
  let major = amountMinor / 100;
  if (storedCurrency !== displayCurrency && usdToBdtRate > 0) {
    if (storedCurrency === 'BDT' && displayCurrency === 'USD') {
      major = major / usdToBdtRate;
    } else if (storedCurrency === 'USD' && displayCurrency === 'BDT') {
      major = major * usdToBdtRate;
    }
  }
  if (displayCurrency === 'USD') {
    return `$${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  const hasFraction = Math.abs(major - Math.round(major)) > 0.001;
  return `৳${major.toLocaleString('en-US', {
    minimumFractionDigits: hasFraction ? 2 : 0,
    maximumFractionDigits: 2,
  })}`;
}

export function calculateProtectionDeadline(confirmedAtMs: number, durationHours: number): number {
  if (!Number.isFinite(confirmedAtMs) || confirmedAtMs <= 0) {
    throw new Error('Invalid buyer confirmation timestamp.');
  }
  if (!Number.isInteger(durationHours) || durationHours < 1) {
    throw new Error('Protection duration must be at least 1 hour.');
  }
  return confirmedAtMs + durationHours * 3_600_000;
}

export function computeRemainingProtectionMs(originalDeadlineMs: number, nowMs: number): number {
  if (!originalDeadlineMs || originalDeadlineMs <= 0) return 0;
  return Math.max(0, originalDeadlineMs - nowMs);
}

export function canAutoReleaseEscrow(
  deal: {
    status: string;
    originalDeadlineMs: number;
    unresolvedReportCount: number;
  },
  nowMs: number
): boolean {
  if (
    deal.status !== 'protection_active' &&
    deal.status !== 'security_period_active' &&
    deal.status !== 'protection_expired'
  ) {
    return false;
  }
  if (deal.unresolvedReportCount > 0) return false;
  if (deal.originalDeadlineMs <= 0) return false;
  return nowMs >= deal.originalDeadlineMs;
}

export function validateAccountAge(
  yearsRaw: string | number,
  monthsRaw: string | number,
  required = true
): { valid: boolean; years: number; months: number; error?: string } {
  const yStr = String(yearsRaw ?? '').trim();
  const mStr = String(monthsRaw ?? '').trim();

  if (required && (yStr === '' || mStr === '')) {
    return { valid: false, years: 0, months: 0, error: 'Both Years and Months are required for account age.' };
  }

  const years = yStr === '' ? 0 : Number(yStr);
  const months = mStr === '' ? 0 : Number(mStr);

  if (!Number.isInteger(years) || years < 0 || years > 50) {
    return { valid: false, years: 0, months: 0, error: 'Years must be a whole number between 0 and 50.' };
  }
  if (!Number.isInteger(months) || months < 0 || months > 11) {
    return { valid: false, years: 0, months: 0, error: 'Months must be an integer between 0 and 11.' };
  }
  if (required && years === 0 && months === 0) {
    return { valid: false, years: 0, months: 0, error: 'Account age must be at least 1 month.' };
  }

  return { valid: true, years, months };
}

export function formatAccountAge(years?: number, months?: number): string {
  const y = Number(years) || 0;
  const m = Number(months) || 0;
  if (y <= 0 && m <= 0) return 'Not specified';
  const parts: string[] = [];
  if (y > 0) parts.push(`${y} ${y === 1 ? 'Year' : 'Years'}`);
  if (m > 0) parts.push(`${m} ${m === 1 ? 'Month' : 'Months'}`);
  return parts.join(', ');
}

const PLATFORM_DOMAIN_RULES: Record<Exclude<PlatformId, 'gaming' | 'website' | 'domain'>, string[]> = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  facebook: ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com'],
  telegram: ['t.me', 'telegram.me', 'www.t.me'],
};

export function validatePlatformAssetUrl(
  platform: PlatformId,
  rawUrl: string
): { valid: boolean; normalizedUrl: string; status: 'domain_matched' | 'not_applicable'; error?: string } {
  const trimmed = (rawUrl || '').trim();
  if (platform === 'gaming') {
    if (!trimmed) {
      return { valid: true, normalizedUrl: '', status: 'not_applicable' };
    }
  } else if (!trimmed) {
    return {
      valid: false,
      normalizedUrl: '',
      status: 'not_applicable',
      error: `Official ${PLATFORM_CATALOG[platform].name} HTTPS link is required.`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedUrl: '',
      status: 'not_applicable',
      error: 'Enter a valid full URL starting with https://',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      normalizedUrl: '',
      status: 'not_applicable',
      error: 'Only secure https:// links are permitted.',
    };
  }

  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalizedUrl: '',
      status: 'not_applicable',
      error: 'Never include credentials or tokens inside a public URL.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.') || host === 'localhost') {
    return {
      valid: false,
      normalizedUrl: '',
      status: 'not_applicable',
      error: 'URL must contain a valid public domain.',
    };
  }

  if (platform in PLATFORM_DOMAIN_RULES) {
    const allowed = PLATFORM_DOMAIN_RULES[platform as keyof typeof PLATFORM_DOMAIN_RULES];
    const matched = allowed.some((d) => host === d || host.endsWith(`.${d}`));
    if (!matched) {
      return {
        valid: false,
        normalizedUrl: '',
        status: 'not_applicable',
        error: `Link domain (${host}) does not match ${PLATFORM_CATALOG[platform].name}. Expected ${allowed[0]}.`,
      };
    }
    if (parsed.pathname === '/' || parsed.pathname.trim() === '') {
      return {
        valid: false,
        normalizedUrl: '',
        status: 'not_applicable',
        error: `Include the specific ${PLATFORM_CATALOG[platform].name} channel, page, or profile path.`,
      };
    }
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    status: 'domain_matched',
  };
}

export function validateGamingFields(
  gameName: string,
  gameUid: string,
  levelRaw: string | number,
  allowedGames: string[] = DEFAULT_GAMING_TITLES
): { valid: boolean; level: number; uid: string; error?: string } {
  const cleanGame = (gameName || '').trim();
  if (!cleanGame || !allowedGames.includes(cleanGame)) {
    return { valid: false, level: 0, uid: '', error: 'Select one of the supported games.' };
  }

  const cleanUid = (gameUid || '').trim();
  if (cleanUid.length < 4 || cleanUid.length > 40 || !/^[a-zA-Z0-9_\-#]+$/.test(cleanUid)) {
    return {
      valid: false,
      level: 0,
      uid: '',
      error: 'Enter a valid Game UID / Player ID (4–40 letters, digits, hyphens, or #).',
    };
  }

  const lvl = Number(String(levelRaw ?? '').trim());
  if (!Number.isInteger(lvl) || lvl < 1 || lvl > 9999) {
    return { valid: false, level: 0, uid: '', error: 'Account Level must be a whole number of at least 1.' };
  }

  return { valid: true, level: lvl, uid: cleanUid };
}

export function detectSensitiveOrOffPlatformContent(text: string): {
  blocked: boolean;
  reason?: string;
} {
  const sample = (text || '').trim();
  if (!sample) return { blocked: false };

  if (/\b(?:password|passcode|recovery\s*code|backup\s*code|2fa\s*code|otp\s*(?:is|:))\b/i.test(sample)) {
    return {
      blocked: true,
      reason: 'Never share passwords, OTPs, or recovery codes in messages or descriptions.',
    };
  }

  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(sample)) {
    return {
      blocked: true,
      reason: 'Email addresses are blocked to protect against off-platform scams.',
    };
  }

  // Detect phone numbers (e.g. +8801XXXXXXXXX, 017XXXXXXXX, or 10-15 contiguous digits not preceded by UID/ID)
  if (/(?:\+?8801[3-9]\d{8}|\b01[3-9]\d{8}\b|\b\d{11,15}\b)/.test(sample)) {
    return {
      blocked: true,
      reason: 'Phone numbers are not allowed. Keep all communication inside BEXORA.',
    };
  }

  if (/\b(?:wa\.me\/|whatsapp\s*(?:me|at|number)|telegram\s*@)\b/i.test(sample)) {
    return {
      blocked: true,
      reason: 'Off-platform contact links (WhatsApp/Telegram) are prohibited.',
    };
  }

  return { blocked: false };
}

export function normalizeUsername(raw: string): string {
  return (raw || '').trim().toLowerCase();
}

export function validateUsername(raw: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = normalizeUsername(raw);
  if (normalized.length < 3 || normalized.length > 24) {
    return { valid: false, normalized, error: 'Username must be between 3 and 24 characters.' };
  }
  if (!/^[a-z0-9_]+$/.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: 'Username may contain only lowercase letters, numbers, and underscores.',
    };
  }
  if (normalized === 'admin' || normalized === 'superadmin' || normalized === 'bexora') {
    return { valid: false, normalized, error: 'This username is reserved.' };
  }
  return { valid: true, normalized };
}

export function calculateAverageRating(scores: number[]): {
  average: number | null;
  count: number;
  label: string;
} {
  const validScores = scores.filter((s) => Number.isInteger(s) && s >= 1 && s <= 5);
  if (validScores.length === 0) {
    return { average: null, count: 0, label: 'No ratings yet' };
  }
  const sum = validScores.reduce((acc, v) => acc + v, 0);
  const avg = Number((sum / validScores.length).toFixed(1));
  return {
    average: avg,
    count: validScores.length,
    label: `${avg.toFixed(1)} (${validScores.length})`,
  };
}

export function isBidAcceptedAwaitingPaymentStatus(status: string): boolean {
  return status === 'accepted_pending_payment' || status === 'accepted';
}

export function isBidAcceptedStatus(status: string): boolean {
  return isBidAcceptedAwaitingPaymentStatus(status) || status === 'paid';
}

export function isDealPaidOrBeyond(status: string): boolean {
  return ![
    'accepted_pending_payment',
    'awaiting_payment',
    'payment_pending_verification',
    'cancelled',
  ].includes(status);
}

export function isBidActive(status: string): boolean {
  return status === 'pending' || isBidAcceptedStatus(status);
}

export function getActiveBids<
  T extends { amountMinor: number; status: string; createdAtMs?: number }
>(bids: T[]): T[] {
  return bids
    .filter((b) => isBidActive(b.status))
    .slice()
    .sort((a, b) => {
      if (b.amountMinor !== a.amountMinor) {
        return b.amountMinor - a.amountMinor;
      }
      return (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0);
    });
}

export function getHighestActiveBidMinor(
  bids: { amountMinor: number; status: string }[]
): number {
  const active = getActiveBids(bids);
  return active.reduce((max, b) => Math.max(max, b.amountMinor), 0);
}

export function validateBidSubmission(
  amountMinor: number,
  existingBids: { amountMinor: number; status: string; buyerId?: string }[],
  buyerId?: string | null
): { valid: boolean; highestMinor: number; error?: string } {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    return { valid: false, highestMinor: 0, error: 'Enter a valid positive bid amount.' };
  }

  const activeBids = getActiveBids(existingBids);
  const highestMinor = getHighestActiveBidMinor(activeBids);

  if (activeBids.some((b) => isBidAcceptedStatus(b.status))) {
    return { valid: false, highestMinor, error: 'A bid has already been accepted on this listing.' };
  }

  if (buyerId && activeBids.some((b) => b.status === 'pending' && b.buyerId === buyerId)) {
    return {
      valid: false,
      highestMinor,
      error:
        'You already have an active pending bid on this listing. Withdraw your current bid first before placing a new one.',
    };
  }

  if (highestMinor > 0 && amountMinor <= highestMinor) {
    return {
      valid: false,
      highestMinor,
      error: `Your bid must be strictly greater than the current highest bid (${formatMoneyFromMinor(highestMinor)}).`,
    };
  }

  return { valid: true, highestMinor };
}

export function isTokenServiceDisabledMessage(raw: string): boolean {
  if (!raw) return false;
  const lower = raw.toLowerCase();
  return (
    lower.includes('token-service-api-has-not-been-used') ||
    lower.includes('securetoken.googleapis.com') ||
    (lower.includes('token service api') &&
      (lower.includes('disabled') || lower.includes('has not been used')))
  );
}

export function extractTokenServiceActivationUrl(
  raw: string,
  fallbackProjectNumber = '448578956301',
  preferredProjectId?: string
): string {
  const cleanProjectId = (preferredProjectId || '').trim();
  if (cleanProjectId && /^[a-z][a-z0-9-]{4,29}$/.test(cleanProjectId) && cleanProjectId !== 'remixed-project-id') {
    return `https://console.cloud.google.com/apis/library/securetoken.googleapis.com?project=${encodeURIComponent(
      cleanProjectId
    )}`;
  }
  const match = (raw || '').match(
    /https:\/\/console\.developers\.google\.com\/apis\/api\/securetoken\.googleapis\.com\/overview\?project=[0-9]+/i
  );
  if (match && match[0]) {
    return match[0];
  }
  const cleanProject = /^[0-9]+$/.test(fallbackProjectNumber)
    ? fallbackProjectNumber
    : '448578956301';
  return `https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=${cleanProject}`;
}

export function validateStrongPassword(password: string): {
  valid: boolean;
  error?: string;
} {
  if (typeof password !== 'string' || password.length < 8) {
    return {
      valid: false,
      error: 'Password must be at least 8 characters long and include both letters and numbers.',
    };
  }
  if (password.length > 128) {
    return {
      valid: false,
      error: 'Password must be 128 characters or fewer.',
    };
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return {
      valid: false,
      error: 'Password must include at least one letter and at least one number.',
    };
  }
  return { valid: true };
}

export function isPrivacySafeResetError(raw: string): boolean {
  if (!raw) return false;
  return raw.includes('auth/user-not-found') || raw.includes('EMAIL_NOT_FOUND');
}

/**
 * Computes milliseconds remaining before a Firebase ID token reaches the safe pre-expiry window
 * (default 90 seconds before hard 60-minute expiry) so the app can gracefully re-check
 * securetoken.googleapis.com or sign out before Firestore's CredentialsProvider fails and drops offline.
 */
export function computeMsUntilSafeSessionExpiry(
  expirationTimeMs: number,
  nowMs: number,
  safetyBufferMs = 90_000
): number {
  if (!Number.isFinite(expirationTimeMs) || !Number.isFinite(nowMs) || expirationTimeMs <= 0) {
    return 0;
  }
  const buffer = Math.max(0, safetyBufferMs);
  return Math.max(0, expirationTimeMs - buffer - nowMs);
}

export interface StoredFirebaseAuthInspection {
  hasSession: boolean;
  uid: string;
  email: string;
  displayName: string;
  providerId: string;
  expirationTimeMs: number;
  shouldPurgeBeforeBoot: boolean;
}

/**
 * Inspects a serialized Firebase Auth `browserLocalPersistence` user JSON record BEFORE `initializeAuth`
 * and `getFirestore` boot. When `securetoken.googleapis.com` is not verified enabled, purging only already-expired
 * tokens (remaining TTL <= `minRemainingMs`, above Firebase's 30s `StsTokenManager.isExpired` threshold) prevents
 * Firestore's `FirebaseAuthCredentialsProvider` from hitting a 403 refresh error and dropping offline, while keeping
 * valid active sessions intact across reloads.
 */
export function inspectStoredFirebaseAuthToken(
  rawJson: string | null | undefined,
  nowMs: number,
  tokenServiceVerified: boolean,
  minRemainingMs = 60_000
): StoredFirebaseAuthInspection {
  const empty: StoredFirebaseAuthInspection = {
    hasSession: false,
    uid: '',
    email: '',
    displayName: '',
    providerId: '',
    expirationTimeMs: 0,
    shouldPurgeBeforeBoot: false,
  };
  if (!rawJson || typeof rawJson !== 'string') {
    return empty;
  }

  try {
    const parsed = JSON.parse(rawJson) as {
      uid?: unknown;
      email?: unknown;
      displayName?: unknown;
      providerData?: Array<{ providerId?: unknown }>;
      stsTokenManager?: {
        accessToken?: unknown;
        expirationTime?: unknown;
      };
    };
    const uid = typeof parsed?.uid === 'string' ? parsed.uid : '';
    if (!uid) {
      return empty;
    }
    const email = typeof parsed?.email === 'string' ? parsed.email : '';
    const displayName = typeof parsed?.displayName === 'string' ? parsed.displayName : '';
    const providerId =
      Array.isArray(parsed?.providerData) && typeof parsed.providerData[0]?.providerId === 'string'
        ? parsed.providerData[0].providerId
        : '';
    const accessToken =
      typeof parsed?.stsTokenManager?.accessToken === 'string'
        ? parsed.stsTokenManager.accessToken
        : '';
    const expRaw = Number(parsed?.stsTokenManager?.expirationTime ?? 0);
    const expirationTimeMs = Number.isFinite(expRaw) && expRaw > 0 ? expRaw : 0;

    if (tokenServiceVerified) {
      return {
        hasSession: true,
        uid,
        email,
        displayName,
        providerId,
        expirationTimeMs,
        shouldPurgeBeforeBoot: false,
      };
    }

    const safeThreshold = Math.max(35_000, minRemainingMs);
    const isExpiredOrNearThreshold =
      !accessToken || expirationTimeMs <= 0 || expirationTimeMs - nowMs <= safeThreshold;

    return {
      hasSession: true,
      uid,
      email,
      displayName,
      providerId,
      expirationTimeMs,
      shouldPurgeBeforeBoot: isExpiredOrNearThreshold,
    };
  } catch {
    return {
      ...empty,
      shouldPurgeBeforeBoot: !tokenServiceVerified,
    };
  }
}

export interface SessionRenewalSchedule {
  silentIdpRefreshDelayMs: number;
  promptExtendDelayMs: number;
  safePreExpiryGuardDelayMs: number;
}

/**
 * Computes the 3-stage session continuity schedule for a 60-minute Firebase ID token:
 * 1. `silentIdpRefreshDelayMs`: 8m before expiry (minute 52, ahead of Firebase's 5m ProactiveRefresh)
 *    to silently renew via Google Identity Services + Identity Toolkit (`accounts:signInWithIdp`).
 * 2. `promptExtendDelayMs`: 2.5m before expiry (minute 57.5) for 1-click user session extension if silent GIS wasn't available.
 * 3. `safePreExpiryGuardDelayMs`: 45s before expiry (minute 59:15, strictly ahead of Firebase's 30s `StsTokenManager.isExpired` buffer)
 *    so Firestore never attempts a failing `securetoken.googleapis.com` fetch or drops offline.
 */
export function computeSessionRenewalSchedule(
  expirationTimeMs: number,
  nowMs: number
): SessionRenewalSchedule {
  return {
    silentIdpRefreshDelayMs: computeMsUntilSafeSessionExpiry(expirationTimeMs, nowMs, 480_000),
    promptExtendDelayMs: computeMsUntilSafeSessionExpiry(expirationTimeMs, nowMs, 150_000),
    safePreExpiryGuardDelayMs: computeMsUntilSafeSessionExpiry(expirationTimeMs, nowMs, 45_000),
  };
}

/**
 * Classifies Identity Toolkit `accounts:signInWithPassword` probe responses into three distinct states:
 * - `'disabled'`: Confirmed disabled in Firebase Console (`PASSWORD_LOGIN_DISABLED` or `OPERATION_NOT_ALLOWED`).
 * - `'enabled'`: Confirmed enabled (`200` or `400` credential/user lookup responses such as `EMAIL_NOT_FOUND` / `INVALID_LOGIN_CREDENTIALS`).
 * - `'unable_to_verify'`: Network failure, timeout, HTTP 5xx, rate limit (429), or unrecognized response.
 * Never collapses network or server failures into `'disabled'`.
 */
export function classifyEmailPasswordProbe(
  httpStatus: number | null,
  responseBody: string
): AuthProviderStatus {
  if (httpStatus === null || httpStatus === 0 || httpStatus >= 500 || httpStatus === 429) {
    return 'unable_to_verify';
  }
  const body = String(responseBody || '');
  if (body.includes('PASSWORD_LOGIN_DISABLED') || body.includes('OPERATION_NOT_ALLOWED')) {
    return 'disabled';
  }
  if (
    httpStatus === 200 ||
    (httpStatus === 400 &&
      (body.includes('EMAIL_NOT_FOUND') ||
        body.includes('INVALID_LOGIN_CREDENTIALS') ||
        body.includes('INVALID_PASSWORD') ||
        body.includes('INVALID_EMAIL') ||
        body.includes('USER_DISABLED') ||
        body.includes('TOO_MANY_ATTEMPTS_TRY_LATER')))
  ) {
    return 'enabled';
  }
  return 'unable_to_verify';
}

/**
 * Classifies Identity Toolkit `accounts:createAuthUri` (`providerId: "google.com"`) probe responses,
 * separating Google provider availability from domain authorization (`UNAUTHORIZED_DOMAIN`).
 */
export function classifyGoogleProviderProbe(
  httpStatus: number | null,
  responseBody: string
): { providerStatus: AuthProviderStatus; domainAuthorized: boolean | null } {
  if (httpStatus === null || httpStatus === 0 || httpStatus >= 500 || httpStatus === 429) {
    return { providerStatus: 'unable_to_verify', domainAuthorized: null };
  }
  const body = String(responseBody || '');
  if (body.includes('OPERATION_NOT_ALLOWED')) {
    return { providerStatus: 'disabled', domainAuthorized: true };
  }
  if (body.includes('UNAUTHORIZED_DOMAIN')) {
    return { providerStatus: 'enabled', domainAuthorized: false };
  }
  if (httpStatus === 200) {
    return { providerStatus: 'enabled', domainAuthorized: true };
  }
  return { providerStatus: 'unable_to_verify', domainAuthorized: null };
}

const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateLoginInput(
  emailRaw: string,
  passwordRaw: string
): { valid: boolean; cleanEmail: string; error?: string } {
  const cleanEmail = String(emailRaw || '').trim().toLowerCase();
  if (!cleanEmail || !SIMPLE_EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 160) {
    return {
      valid: false,
      cleanEmail,
      error: 'Enter a valid registered email address.',
    };
  }
  if (typeof passwordRaw !== 'string' || passwordRaw.length === 0) {
    return {
      valid: false,
      cleanEmail,
      error: 'Enter your account password.',
    };
  }
  return { valid: true, cleanEmail };
}

export interface RegistrationValidationInput {
  fullName: string;
  username: string;
  phone: string;
  email: string;
  password: string;
  confirmPassword: string;
}

export interface RegistrationValidationResult {
  valid: boolean;
  cleanName: string;
  normalizedUsername: string;
  normalizedPhone: string;
  cleanEmail: string;
  error?: string;
}

export function validateRegistrationInput(
  input: RegistrationValidationInput
): RegistrationValidationResult {
  const cleanName = String(input.fullName || '').trim();
  const unameCheck = validateUsername(input.username || '');
  const normalizedPhone = String(input.phone || '').trim().replace(/[\s-]/g, '');
  const cleanEmail = String(input.email || '').trim().toLowerCase();

  if (cleanName.length < 2 || cleanName.length > 80) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      cleanEmail,
      error: 'Full name must be between 2 and 80 characters.',
    };
  }

  if (!unameCheck.valid) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      cleanEmail,
      error: unameCheck.error || 'Invalid username.',
    };
  }

  if (!/^\+?[0-9]{8,16}$/.test(normalizedPhone) || normalizedPhone.length > 32) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      cleanEmail,
      error: 'Enter a valid phone number (8–16 digits, optional country code +880).',
    };
  }

  if (!cleanEmail || !SIMPLE_EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 160) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      cleanEmail,
      error: 'Enter a valid email address.',
    };
  }

  const pwdCheck = validateStrongPassword(input.password || '');
  if (!pwdCheck.valid) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      cleanEmail,
      error:
        pwdCheck.error ||
        'Password must be at least 8 characters long and include both letters and numbers.',
    };
  }

  if (input.password !== input.confirmPassword) {
    return {
      valid: false,
      cleanName,
      normalizedUsername: unameCheck.normalized,
      normalizedPhone,
      cleanEmail,
      error: 'Password and Confirm Password do not match.',
    };
  }

  return {
    valid: true,
    cleanName,
    normalizedUsername: unameCheck.normalized,
    normalizedPhone,
    cleanEmail,
  };
}

export function validatePasswordResetInput(emailRaw: string): {
  valid: boolean;
  cleanEmail: string;
  error?: string;
} {
  const cleanEmail = String(emailRaw || '').trim().toLowerCase();
  if (!cleanEmail || !SIMPLE_EMAIL_REGEX.test(cleanEmail) || cleanEmail.length > 160) {
    return {
      valid: false,
      cleanEmail,
      error: 'Enter your registered email address (e.g. you@gmail.com).',
    };
  }
  return { valid: true, cleanEmail };
}

// ============================================================================
// ACCEPTED-BID DEAL PAYMENT, REFUND POLICY (102% / 3%), TRANSFER EVIDENCE & STATE MACHINE
// ============================================================================

export interface DisputeRefundBreakdown {
  baseAmountMinor: number;
  buyerFeeMinor: number;
  originalBuyerPaymentMinor: number;
  buyerRefundMinor: number;
  platformRetainedCommissionMinor: number;
  sellerPayoutMinor: 0;
}

/**
 * Computes the exact BEXORA Dispute Rejection Refund Policy in integer minor units:
 * - Original buyer payment = accepted deal price (P) + buyer fee (e.g. 100 BDT + 5 BDT = 105 BDT)
 * - Buyer refund = 100% of accepted deal price + 2% of accepted deal price (capped at total paid if fee < 2%)
 *   e.g. for 100 BDT (10,000 minor) + 5% fee (500 minor) = 105 BDT (10,500 minor):
 *     buyerRefundMinor = 10,200 (102 BDT)
 *     platformRetainedCommissionMinor = 300 (3 BDT)
 * - Seller payout = 0
 */
export function calculateDisputeRefundBreakdown(deal: {
  baseAmountMinor: number;
  buyerFeeMinor: number;
  buyerTotalMinor: number;
}): DisputeRefundBreakdown {
  const base = Number(deal.baseAmountMinor);
  const fee = Number(deal.buyerFeeMinor);
  const total = Number(deal.buyerTotalMinor);

  if (!Number.isInteger(base) || base <= 0) {
    throw new Error('Deal baseAmountMinor must be a positive integer.');
  }
  if (!Number.isInteger(fee) || fee < 0) {
    throw new Error('Deal buyerFeeMinor must be a non-negative integer.');
  }
  if (!Number.isInteger(total) || total !== base + fee) {
    throw new Error('Deal buyerTotalMinor must equal baseAmountMinor + buyerFeeMinor.');
  }

  const twoPctBonusMinor = Math.round((base * 2) / 100);
  const buyerRefundMinor = Math.min(total, base + twoPctBonusMinor);
  const platformRetainedCommissionMinor = total - buyerRefundMinor;

  return {
    baseAmountMinor: base,
    buyerFeeMinor: fee,
    originalBuyerPaymentMinor: total,
    buyerRefundMinor,
    platformRetainedCommissionMinor,
    sellerPayoutMinor: 0,
  };
}

export interface AcceptedBidDealSnapshot extends CommissionBreakdown {
  originalListingPriceMinor: number;
  refundBuyerMinor: number;
  refundPlatformRetainedMinor: number;
}

/**
 * Calculates the immutable financial snapshot for an accepted-bid deal.
 * Strictly uses `acceptedBidAmountMinor` (NEVER `originalListingPriceMinor`) as the agreed deal base price.
 */
export function calculateAcceptedBidDealFinancials(
  acceptedBidAmountMinor: number,
  settings: Pick<PublicSettings, 'buyerFeeEnabled' | 'buyerFeePct' | 'sellerFeeEnabled' | 'sellerFeePct'>,
  originalListingPriceMinor = acceptedBidAmountMinor
): AcceptedBidDealSnapshot {
  const commission = calculateCommission(
    acceptedBidAmountMinor,
    settings.buyerFeePct ?? 5,
    settings.sellerFeePct ?? 0,
    settings.buyerFeeEnabled !== false,
    Boolean(settings.sellerFeeEnabled)
  );
  const refund = calculateDisputeRefundBreakdown({
    baseAmountMinor: commission.baseAmountMinor,
    buyerFeeMinor: commission.buyerFeeMinor,
    buyerTotalMinor: commission.buyerTotalMinor,
  });

  return {
    ...commission,
    originalListingPriceMinor:
      Number.isInteger(originalListingPriceMinor) && originalListingPriceMinor > 0
        ? originalListingPriceMinor
        : acceptedBidAmountMinor,
    refundBuyerMinor: refund.buyerRefundMinor,
    refundPlatformRetainedMinor: refund.platformRetainedCommissionMinor,
  };
}

export function isDealUnpaidStatus(status: string): boolean {
  return status === 'accepted_pending_payment' || status === 'awaiting_payment';
}

export function isDealAwaitingSellerTransferStatus(status: string): boolean {
  return (
    status === 'paid_deal_room_active' ||
    status === 'paid' ||
    status === 'transfer_in_progress' ||
    status === 'transfer_rejected'
  );
}

export function isDealTransferSubmittedStatus(status: string): boolean {
  return status === 'transfer_submitted' || status === 'awaiting_buyer_confirmation';
}

export function isDealSecurityTimerActiveStatus(status: string): boolean {
  return status === 'security_period_active' || status === 'protection_active';
}

export function isDealTerminalStatus(status: string): boolean {
  return status === 'settled' || status === 'refunded' || status === 'cancelled';
}

export function isDealReportableStatus(status: string): boolean {
  return (
    isDealAwaitingSellerTransferStatus(status) ||
    isDealTransferSubmittedStatus(status) ||
    isDealSecurityTimerActiveStatus(status) ||
    status === 'reported_under_review' ||
    status === 'protection_expired'
  );
}

export function getDealStatusLabel(status: DealStatus | string): string {
  switch (status) {
    case 'accepted_pending_payment':
    case 'awaiting_payment':
      return 'Accepted — Pending Buyer Payment';
    case 'payment_pending_verification':
      return 'Payment Pending Verification';
    case 'paid_deal_room_active':
    case 'paid':
    case 'transfer_in_progress':
      return 'Paid — Deal Room Active (Awaiting Seller Transfer)';
    case 'transfer_submitted':
    case 'awaiting_buyer_confirmation':
      return 'Transfer Evidence Submitted — Awaiting Buyer Review';
    case 'transfer_rejected':
      return 'Transfer Rejected — Seller Correction Required';
    case 'security_period_active':
    case 'protection_active':
      return 'Security Protection Period Active';
    case 'reported_under_review':
      return 'Reported — Paused Under Admin Review';
    case 'protection_expired':
      return 'Security Period Complete — Ready for Settlement';
    case 'settled':
      return 'Completed — Seller Payout Released';
    case 'refunded':
      return 'Rejected & Refunded to Buyer';
    case 'cancelled':
      return 'Cancelled (Unpaid Reservation Released)';
    default:
      return String(status || '').replace(/_/g, ' ');
  }
}

export function getBidStatusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return 'Pending Review';
    case 'accepted_pending_payment':
    case 'accepted':
      return 'Accepted — Pending Payment';
    case 'paid':
      return 'Accepted — Escrow Funded';
    case 'rejected':
      return 'Declined';
    case 'withdrawn':
      return 'Withdrawn';
    case 'expired':
    case 'cancelled':
      return 'Expired (Unpaid)';
    default:
      return status;
  }
}

/**
 * Validates state-machine transitions for BEXORA deals across buyer, seller, and admin roles.
 * Prevents skipping payment, seller self-approval, buyer payout release, or double finalization.
 */
export function canTransitionDealStatus(
  fromStatus: DealStatus,
  toStatus: DealStatus,
  actorRole: 'buyer' | 'seller' | 'admin'
): boolean {
  if (isDealTerminalStatus(fromStatus)) {
    return false;
  }

  if (actorRole === 'buyer') {
    if (isDealUnpaidStatus(fromStatus) && toStatus === 'paid_deal_room_active') return true;
    if (isDealUnpaidStatus(fromStatus) && toStatus === 'cancelled') return true;
    if (
      isDealTransferSubmittedStatus(fromStatus) &&
      (toStatus === 'security_period_active' || toStatus === 'protection_active' || toStatus === 'transfer_rejected')
    ) {
      return true;
    }
    if (isDealReportableStatus(fromStatus) && toStatus === 'reported_under_review') return true;
    return false;
  }

  if (actorRole === 'seller') {
    if (isDealUnpaidStatus(fromStatus) && toStatus === 'cancelled') return true;
    if (isDealAwaitingSellerTransferStatus(fromStatus) && toStatus === 'transfer_submitted') return true;
    if (isDealReportableStatus(fromStatus) && toStatus === 'reported_under_review') return true;
    return false;
  }

  if (actorRole === 'admin') {
    if (isDealUnpaidStatus(fromStatus) && toStatus === 'cancelled') return true;
    if (isDealUnpaidStatus(fromStatus)) {
      // Unpaid deals have no escrow funds to refund or settle!
      return false;
    }
    if (
      toStatus === 'settled' ||
      toStatus === 'refunded' ||
      toStatus === 'security_period_active' ||
      toStatus === 'protection_active' ||
      toStatus === 'protection_expired' ||
      toStatus === 'paid_deal_room_active' ||
      toStatus === 'transfer_submitted' ||
      toStatus === 'transfer_rejected' ||
      toStatus === 'reported_under_review'
    ) {
      return true;
    }
  }

  return false;
}

export function getPlatformTransferChecklist(platform: PlatformId): string[] {
  switch (platform) {
    case 'youtube':
      return [
        'Invited buyer Google account as Primary Owner / Manager in YouTube Studio / Brand Account',
        'Verified AdSense / monetization link transfer instructions in Deal Room',
        'Removed third-party manager access and confirmed channel URL matches listing',
      ];
    case 'facebook':
      return [
        'Sent Full Control Admin / Business Portfolio access invite to buyer account',
        'Verified Page / Group monetization payout settings readiness',
        'Confirmed no scheduled admin-removal or policy restrictions are pending',
      ];
    case 'website':
    case 'domain':
      return [
        'Initiated domain registrar push or provided EPP authorization transfer lock release',
        'Transferred CMS / hosting repository access to buyer account',
        'Verified analytics / AdSense ownership verification readiness',
      ];
    case 'gaming':
      return [
        'Linked buyer recovery bind inside official game security settings',
        'Removed seller secondary social binds and logged out active devices',
        'Confirmed Game UID and Account Level match the verified listing',
      ];
    default:
      return [
        'Updated primary account ownership / admin role to buyer inside official platform settings',
        'Confirmed 2FA / recovery handover steps inside the Deal Room',
        'Verified follower count and monetization status match the listing',
      ];
  }
}

export function validateTransferSubmissionInput(input: {
  screenshots: string[];
  transferNote: string;
  completedSteps: string[];
}): { valid: boolean; cleanNote: string; cleanSteps: string[]; error?: string } {
  const screenshots = Array.isArray(input.screenshots) ? input.screenshots.filter(Boolean) : [];
  if (screenshots.length < 2 || screenshots.length > 3) {
    return {
      valid: false,
      cleanNote: '',
      cleanSteps: [],
      error: 'Upload 2 to 3 clear transfer-proof screenshots before submitting.',
    };
  }

  for (let i = 0; i < screenshots.length; i++) {
    const img = screenshots[i];
    if (
      typeof img !== 'string' ||
      img.length < 30 ||
      img.length > 260_000 ||
      (!img.startsWith('data:image/') && !img.startsWith('https://'))
    ) {
      return {
        valid: false,
        cleanNote: '',
        cleanSteps: [],
        error: `Screenshot #${i + 1} is invalid or exceeds the safe document size limit.`,
      };
    }
  }

  const cleanNote = String(input.transferNote || '').trim();
  if (cleanNote.length < 5 || cleanNote.length > 1500) {
    return {
      valid: false,
      cleanNote,
      cleanSteps: [],
      error: 'Include a clear transfer note (5–1,500 characters) explaining the completed handover steps.',
    };
  }

  const safety = detectSensitiveOrOffPlatformContent(cleanNote);
  if (safety.blocked) {
    return {
      valid: false,
      cleanNote,
      cleanSteps: [],
      error: safety.reason || 'Do not include raw passwords, OTPs, phone numbers, or off-platform links in transfer notes.',
    };
  }

  const cleanSteps = (Array.isArray(input.completedSteps) ? input.completedSteps : [])
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 3 && s.length <= 160)
    .slice(0, 10);

  if (cleanSteps.length === 0) {
    return {
      valid: false,
      cleanNote,
      cleanSteps,
      error: 'Confirm at least one completed transfer checklist step before submitting.',
    };
  }

  return {
    valid: true,
    cleanNote,
    cleanSteps,
  };
}

export function validateBuyerTransferRejection(reasonRaw: string): {
  valid: boolean;
  cleanReason: string;
  error?: string;
} {
  const cleanReason = String(reasonRaw || '').trim();
  if (cleanReason.length < 5 || cleanReason.length > 1000) {
    return {
      valid: false,
      cleanReason,
      error: 'Provide a clear rejection reason (5–1,000 characters) so the seller or admin can review what is missing.',
    };
  }
  return { valid: true, cleanReason };
}

export const DEAL_REPORT_CATEGORIES: { id: DealReportCategory; label: string }[] = [
  { id: 'ownership_not_transferred', label: 'Ownership / Admin Access Not Transferred' },
  { id: 'credentials_invalid', label: 'Invalid Access or Incomplete Handover' },
  { id: 'monetization_mismatch', label: 'Asset Metrics or Monetization Mismatch' },
  { id: 'account_recovered_by_seller', label: 'Unauthorized Recovery / Access Revoked During Security Period' },
  { id: 'buyer_unresponsive', label: 'Counterparty Unresponsive / Stalling Transfer' },
  { id: 'other', label: 'Other Escrow or Policy Issue' },
];

export function getDealReportCategoryLabel(cat?: DealReportCategory | string): string {
  const found = DEAL_REPORT_CATEGORIES.find((c) => c.id === cat);
  return found ? found.label : 'General Dispute Report';
}

export function validateDealReportInput(input: {
  category: string;
  reason: string;
  evidenceImages?: string[];
}): {
  valid: boolean;
  category: DealReportCategory;
  cleanReason: string;
  cleanEvidence: string[];
  error?: string;
} {
  const allowedCategories = new Set<string>(DEAL_REPORT_CATEGORIES.map((c) => c.id));
  const cat = String(input.category || '').trim() as DealReportCategory;
  if (!allowedCategories.has(cat)) {
    return {
      valid: false,
      category: 'other',
      cleanReason: '',
      cleanEvidence: [],
      error: 'Select a report category.',
    };
  }

  const cleanReason = String(input.reason || '').trim();
  if (cleanReason.length < 10 || cleanReason.length > 1500) {
    return {
      valid: false,
      category: cat,
      cleanReason,
      cleanEvidence: [],
      error: 'Provide a detailed explanation of the issue (10–1,500 characters).',
    };
  }

  const rawEvidence = Array.isArray(input.evidenceImages) ? input.evidenceImages.filter(Boolean) : [];
  if (rawEvidence.length > 3) {
    return {
      valid: false,
      category: cat,
      cleanReason,
      cleanEvidence: [],
      error: 'Attach up to 3 supporting evidence screenshots per report.',
    };
  }

  for (let i = 0; i < rawEvidence.length; i++) {
    const img = rawEvidence[i];
    if (
      typeof img !== 'string' ||
      img.length < 30 ||
      img.length > 250_000 ||
      (!img.startsWith('data:image/') && !img.startsWith('https://'))
    ) {
      return {
        valid: false,
        category: cat,
        cleanReason,
        cleanEvidence: [],
        error: `Evidence image #${i + 1} is invalid or exceeds the maximum size limit.`,
      };
    }
  }

  return {
    valid: true,
    category: cat,
    cleanReason,
    cleanEvidence: rawEvidence,
  };
}

/**
 * Strips any internal Google Cloud / Firebase Console URLs, project IDs, or developer instructions
 * from customer-facing authentication or database messages so ordinary visitors never see internal
 * cloud console links on the Login/Register UI.
 */
export function sanitizeCustomerAuthMessage(rawMessage: string): string {
  const msg = String(rawMessage || '').trim();
  if (!msg) {
    return 'Authentication could not be completed right now. Please try again or use Connect with Google.';
  }
  const hasInternalCloudConsoleLeak =
    /console\.firebase\.google\.com|console\.cloud\.google\.com|console\.developers\.google\.com|responsive-dragon-tmn89|securetoken\.googleapis\.com|identitytoolkit\.googleapis\.com/i.test(
      msg
    );
  if (!hasInternalCloudConsoleLeak) {
    return msg;
  }
  if (/email\/password|password_login_disabled|operation-not-allowed/i.test(msg)) {
    return 'Email & Password sign-in is temporarily unavailable right now. Please use Connect with Google above to sign in or create your account immediately.';
  }
  if (/unauthorized-domain|authorized domain/i.test(msg)) {
    return 'Google popup sign-in is not yet active on this domain. Please sign in using your email and password or contact BEXORA Support.';
  }
  if (/token-service|securetoken|session expired/i.test(msg)) {
    return 'Your security session expired. Please sign in again to continue right where you left off.';
  }
  return 'Sign-in service encountered a temporary configuration issue. Please try Connect with Google or contact BEXORA Support.';
}

export function getListingStatusBadgeMeta(status: ListingStatus): {
  label: string;
  canSellerEdit: boolean;
  isPubliclyVisible: boolean;
} {
  switch (status) {
    case 'draft':
      return { label: 'Draft (Saved Privately)', canSellerEdit: true, isPubliclyVisible: false };
    case 'pending':
      return { label: 'Pending Admin Review', canSellerEdit: false, isPubliclyVisible: false };
    case 'active':
      return { label: 'Approved & Live', canSellerEdit: false, isPubliclyVisible: true };
    case 'reserved':
      return { label: 'Reserved — Pending Buyer Payment', canSellerEdit: false, isPubliclyVisible: true };
    case 'sold':
      return { label: 'Sold & Completed', canSellerEdit: false, isPubliclyVisible: true };
    case 'rejected':
      return { label: 'Rejected — Needs Revision', canSellerEdit: true, isPubliclyVisible: false };
    case 'suspended':
      return { label: 'Suspended by Admin', canSellerEdit: false, isPubliclyVisible: false };
    case 'archived':
    default:
      return { label: 'Archived', canSellerEdit: false, isPubliclyVisible: false };
  }
}

export function normalizeDraftListingFields(input: {
  platform?: PlatformId;
  subcategory?: string;
  title?: string;
  description?: string;
  priceMajor?: string | number;
  price?: string | number;
  priceBdt?: string | number;
  ageYears?: string | number;
  ageMonths?: string | number;
}): {
  valid: boolean;
  title: string;
  cleanTitle: string;
  description: string;
  cleanDescription: string;
  subcategory: string;
  priceMinor: number;
  ageYears: number;
  ageMonths: number;
  error?: string;
} {
  const defaultSubcat =
    input.platform && PLATFORM_CATALOG[input.platform]?.subcategories?.[0]
      ? PLATFORM_CATALOG[input.platform].subcategories[0]
      : 'General Asset';
  const rawSubcat = String(input.subcategory || '').trim();
  const subcategory = (rawSubcat.length >= 2 ? rawSubcat : defaultSubcat).slice(0, 80);

  const rawTitle = String(input.title || '').trim();
  const cleanTitle =
    rawTitle.length >= 8
      ? rawTitle.slice(0, 120)
      : rawTitle.length > 0
      ? `${rawTitle} (Draft Asset)`.slice(0, 120)
      : 'Untitled Draft Asset Listing';

  const titleSafety = detectSensitiveOrOffPlatformContent(cleanTitle);
  if (titleSafety.blocked) {
    return {
      valid: false,
      title: cleanTitle,
      cleanTitle,
      description: '',
      cleanDescription: '',
      subcategory,
      priceMinor: 100,
      ageYears: 0,
      ageMonths: 1,
      error: `Title: ${titleSafety.reason}`,
    };
  }

  const rawDesc = String(input.description || '').trim();
  const cleanDescription =
    rawDesc.length >= 20
      ? rawDesc.slice(0, 4000)
      : `${rawDesc ? `${rawDesc} — ` : ''}Draft listing saved in progress by seller before submitting for moderation.`.slice(
          0,
          4000
        );

  const descSafety = detectSensitiveOrOffPlatformContent(cleanDescription);
  if (descSafety.blocked) {
    return {
      valid: false,
      title: cleanTitle,
      cleanTitle,
      description: cleanDescription,
      cleanDescription,
      subcategory,
      priceMinor: 100,
      ageYears: 0,
      ageMonths: 1,
      error: `Description: ${descSafety.reason}`,
    };
  }

  const rawPrice = input.priceMajor ?? input.price ?? input.priceBdt ?? '';
  const parsedPrice = Number(rawPrice);
  const priceMinor =
    Number.isFinite(parsedPrice) && parsedPrice > 0 ? Math.max(100, Math.round(parsedPrice * 100)) : 10_000;

  const parsedYears = Math.max(0, Math.min(30, Math.floor(Number(input.ageYears) || 0)));
  const parsedMonthsRaw = Math.max(0, Math.min(11, Math.floor(Number(input.ageMonths) || 0)));
  const ageMonths = parsedYears === 0 && parsedMonthsRaw === 0 ? 1 : parsedMonthsRaw;

  return {
    valid: true,
    title: cleanTitle,
    cleanTitle,
    description: cleanDescription,
    cleanDescription,
    subcategory,
    priceMinor,
    ageYears: parsedYears,
    ageMonths,
  };
}



