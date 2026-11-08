import { PlatformId, RecentSearchRecord } from '../types';
import { PLATFORM_CATALOG } from './marketplaceLogic';

export const MAX_RECENT_SEARCHES = 20;
export const GUEST_RECENT_SEARCHES_STORAGE_KEY = 'bx_guest_recent_searches_v1';

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

export interface RecentSearchInput {
  query?: string;
  platform?: PlatformId | '';
  subcategory?: string;
  monetization?: string;
  verifiedOnly?: boolean;
  sortBy?: string;
}

/**
 * Sanitizes a user search string: removes control characters and HTML brackets,
 * collapses spaces, and caps length at 100 chars.
 */
export function sanitizeSearchQueryText(raw: string | null | undefined): string {
  return String(raw || '')
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * Checks whether a search input represents a meaningful user search or filter selection
 * (rejecting completely empty / default searches and 1-char noise without category filters).
 */
export function isMeaningfulSearchInput(input: RecentSearchInput): boolean {
  const cleanQuery = sanitizeSearchQueryText(input.query);
  const hasPlatform = Boolean(input.platform && VALID_PLATFORMS.has(input.platform));
  const hasSubcat = Boolean(input.subcategory && input.subcategory.trim());
  const hasMonetization = Boolean(
    input.monetization && input.monetization !== 'all' && input.monetization.trim()
  );
  const hasVerifiedOnly = Boolean(input.verifiedOnly);

  if (cleanQuery.length >= 2) return true;
  if (hasPlatform || hasSubcat || hasMonetization || hasVerifiedOnly) return true;
  return false;
}

/**
 * Computes a deterministic, Firestore-safe ID (`srch_<hex>`) from normalized search + filter criteria
 * so repeating the same search updates its timestamp instead of creating duplicates.
 */
export function computeRecentSearchId(input: RecentSearchInput): string {
  const normQuery = sanitizeSearchQueryText(input.query).toLowerCase();
  const normPlat = input.platform && VALID_PLATFORMS.has(input.platform) ? input.platform : '';
  const normSub = String(input.subcategory || '').trim().toLowerCase().slice(0, 60);
  const normMon =
    input.monetization && input.monetization !== 'all'
      ? String(input.monetization).trim().toLowerCase().slice(0, 32)
      : '';
  const normVer = input.verifiedOnly ? '1' : '0';

  const canonical = `${normQuery}|${normPlat}|${normSub}|${normMon}|${normVer}`;
  // FNV-1a 32-bit hash (two passes with salt for 64-bit hex fingerprint)
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < canonical.length; i++) {
    const code = canonical.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code ^ (i & 0xff);
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, '0');
  const hex2 = (h2 >>> 0).toString(16).padStart(8, '0');
  return `srch_${hex1}${hex2}`;
}

/**
 * Builds a concise human-readable label for a recent search item.
 */
export function buildRecentSearchSummaryLabel(input: RecentSearchInput): string {
  const parts: string[] = [];
  const cleanQuery = sanitizeSearchQueryText(input.query);
  if (cleanQuery) {
    parts.push(`"${cleanQuery}"`);
  }
  if (input.platform && VALID_PLATFORMS.has(input.platform)) {
    const pName = PLATFORM_CATALOG[input.platform as PlatformId]?.name || input.platform;
    parts.push(pName);
  }
  if (input.subcategory && input.subcategory.trim()) {
    parts.push(input.subcategory.trim().slice(0, 40));
  }
  if (input.monetization === 'monetized') {
    parts.push('Monetized');
  } else if (input.monetization === 'non-monetized') {
    parts.push('Non-Monetized');
  }
  if (input.verifiedOnly) {
    parts.push('Verified Only');
  }
  const joined = parts.join(' · ').trim();
  return (joined || 'Marketplace Search').slice(0, 140);
}

/**
 * Constructs a validated `RecentSearchRecord`, or `null` if the search input is empty/noise.
 */
export function createRecentSearchRecord(
  input: RecentSearchInput,
  nowMs = Date.now()
): RecentSearchRecord | null {
  if (!isMeaningfulSearchInput(input)) return null;

  const cleanQuery = sanitizeSearchQueryText(input.query);
  const platform: PlatformId | '' =
    input.platform && VALID_PLATFORMS.has(input.platform) ? (input.platform as PlatformId) : '';
  const subcategory = String(input.subcategory || '').trim().slice(0, 60);
  const monetization =
    input.monetization === 'monetized' || input.monetization === 'non-monetized'
      ? input.monetization
      : 'all';
  const verifiedOnly = Boolean(input.verifiedOnly);
  const sortBy = String(input.sortBy || 'newest').trim().slice(0, 32);

  return {
    id: computeRecentSearchId({ query: cleanQuery, platform, subcategory, monetization, verifiedOnly }),
    query: cleanQuery,
    platform,
    subcategory,
    monetization,
    verifiedOnly,
    sortBy,
    summaryLabel: buildRecentSearchSummaryLabel({
      query: cleanQuery,
      platform,
      subcategory,
      monetization,
      verifiedOnly,
    }),
    searchedAtMs: Math.max(1, Math.floor(nowMs)),
  };
}

/**
 * Inserts or updates a recent search at the top of an existing list, deduplicating by `id`
 * and enforcing `MAX_RECENT_SEARCHES`.
 */
export function upsertRecentSearchList(
  existing: RecentSearchRecord[],
  nextItem: RecentSearchRecord,
  maxItems = MAX_RECENT_SEARCHES
): RecentSearchRecord[] {
  const filtered = existing.filter((item) => item && item.id !== nextItem.id);
  return [nextItem, ...filtered]
    .sort((a, b) => b.searchedAtMs - a.searchedAtMs)
    .slice(0, Math.max(1, maxItems));
}

export function parseStoredRecentSearches(rawJson: string | null | undefined): RecentSearchRecord[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    const valid: RecentSearchRecord[] = [];
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = createRecentSearchRecord(
        {
          query: typeof entry.query === 'string' ? entry.query : '',
          platform: typeof entry.platform === 'string' ? (entry.platform as PlatformId) : '',
          subcategory: typeof entry.subcategory === 'string' ? entry.subcategory : '',
          monetization: typeof entry.monetization === 'string' ? entry.monetization : 'all',
          verifiedOnly: Boolean(entry.verifiedOnly),
          sortBy: typeof entry.sortBy === 'string' ? entry.sortBy : 'newest',
        },
        Number(entry.searchedAtMs) > 0 ? Number(entry.searchedAtMs) : Date.now()
      );
      if (rec && !seen.has(rec.id)) {
        seen.add(rec.id);
        valid.push(rec);
      }
    }
    return valid
      .sort((a, b) => b.searchedAtMs - a.searchedAtMs)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    return [];
  }
}

export function loadGuestRecentSearches(): RecentSearchRecord[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    return parseStoredRecentSearches(window.localStorage.getItem(GUEST_RECENT_SEARCHES_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveGuestRecentSearches(items: RecentSearchRecord[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const trimmed = items.slice(0, MAX_RECENT_SEARCHES);
    window.localStorage.setItem(GUEST_RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors safely
  }
}
