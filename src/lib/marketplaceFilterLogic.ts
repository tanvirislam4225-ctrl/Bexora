import type { CurrencyCode, PlatformId } from '../types';
import {
  getCategoryMetricLabel,
  getMonetizationLabel,
  PLATFORM_CATALOG,
} from './marketplaceLogic';
import { EMPTY_FILTERS, type MarketplaceFilterState } from '../components/FilterPanel';

export interface ActiveFilterChip {
  id: string;
  label: string;
}

function formatRangeValue(minStr: string, maxStr: string, suffix = ''): string {
  const minClean = String(minStr || '').trim();
  const maxClean = String(maxStr || '').trim();
  const fmtNum = (raw: string) => {
    const n = Number(raw);
    return Number.isFinite(n) ? n.toLocaleString('en-US') : raw;
  };
  const sfx = suffix ? ` ${suffix}` : '';
  if (minClean && maxClean) {
    return `${fmtNum(minClean)} – ${fmtNum(maxClean)}${sfx}`;
  }
  if (minClean) {
    return `≥ ${fmtNum(minClean)}${sfx}`;
  }
  if (maxClean) {
    return `≤ ${fmtNum(maxClean)}${sfx}`;
  }
  return '';
}

function formatSortLabel(sort: MarketplaceFilterState['sort']): string {
  switch (sort) {
    case 'oldest':
      return 'Oldest First';
    case 'price-asc':
      return 'Price: Low to High';
    case 'price-desc':
      return 'Price: High to Low';
    case 'popular':
      return 'Most Viewed';
    default:
      return 'Newest First';
  }
}

function formatMonetizationStatusLabel(
  status: MarketplaceFilterState['monetization']
): string {
  switch (status) {
    case 'verified-only':
      return 'Verified Monetization';
    case 'monetized':
      return 'Monetized';
    case 'non-monetized':
      return 'Non-Monetized';
    default:
      return 'All Statuses';
  }
}

/**
 * Derives a deduplicated, ordered list of active marketplace filter chips from
 * applied filters and search query.
 */
export function buildActiveFilterChips(
  filters: MarketplaceFilterState,
  searchQuery: string,
  currency: CurrencyCode
): ActiveFilterChip[] {
  const chips: ActiveFilterChip[] = [];
  const seenIds = new Set<string>();

  const addChip = (id: string, label: string) => {
    if (!id || !label || seenIds.has(id)) return;
    seenIds.add(id);
    chips.push({ id, label });
  };

  const trimmedQuery = String(searchQuery || '').trim();
  if (trimmedQuery) {
    addChip('search', `Search: "${trimmedQuery}"`);
  }

  if (filters.platform !== 'all') {
    const platName = PLATFORM_CATALOG[filters.platform as PlatformId]?.name || filters.platform;
    addChip('platform', `Platform: ${platName}`);
  }

  if (filters.subcategory && filters.subcategory !== 'all') {
    addChip('subcategory', `Type: ${filters.subcategory}`);
  }

  if (filters.platform === 'gaming') {
    if (filters.gameName && filters.gameName !== 'all') {
      addChip('gameName', `Game: ${filters.gameName}`);
    }
    const uidQ = String(filters.gameUidQuery || '').trim();
    if (uidQ) {
      addChip('gameUidQuery', `Game UID: ${uidQ}`);
    }
    const lvlRange = formatRangeValue(filters.minLevel, filters.maxLevel);
    if (lvlRange) {
      addChip('levelRange', `Level: ${lvlRange}`);
    }
  } else {
    if (filters.platform !== 'domain' && filters.monetization !== 'all') {
      addChip('monetization', formatMonetizationStatusLabel(filters.monetization));
    }
    if (
      filters.platform !== 'domain' &&
      filters.monetization !== 'non-monetized' &&
      Array.isArray(filters.methods)
    ) {
      for (const methodId of filters.methods) {
        const cleanMethod = String(methodId || '').trim();
        if (!cleanMethod) continue;
        addChip(`method:${cleanMethod}`, getMonetizationLabel(cleanMethod));
      }
    }
    if (filters.platform !== 'all') {
      const metricRange = formatRangeValue(filters.minMetric, filters.maxMetric);
      if (metricRange) {
        const metricLabel = getCategoryMetricLabel(
          filters.platform,
          filters.subcategory !== 'all' ? filters.subcategory : undefined
        );
        addChip('metricRange', `${metricLabel}: ${metricRange}`);
      }
    }
    if (
      filters.platform !== 'domain' &&
      filters.monetization !== 'non-monetized'
    ) {
      const revRange = formatRangeValue(filters.minRevenue, filters.maxRevenue, currency);
      if (revRange) {
        addChip('revenueRange', `Monthly Revenue: ${revRange}`);
      }
    }
  }

  const priceRange = formatRangeValue(filters.minPrice, filters.maxPrice, currency);
  if (priceRange) {
    addChip('priceRange', `Price: ${priceRange}`);
  }

  if (filters.verifiedSeller) {
    addChip('verifiedSeller', 'Verified Sellers Only');
  }

  if (filters.sort && filters.sort !== 'newest') {
    addChip('sort', `Sort: ${formatSortLabel(filters.sort)}`);
  }

  return chips;
}

/**
 * Immutably removes a single filter chip while preserving all sibling filters.
 */
export function removeFilterChipFromState(
  filters: MarketplaceFilterState,
  searchQuery: string,
  chipId: string
): { nextFilters: MarketplaceFilterState; nextSearchQuery: string } {
  if (chipId === 'search') {
    return { nextFilters: filters, nextSearchQuery: '' };
  }

  if (chipId === 'platform') {
    return {
      nextFilters: {
        ...filters,
        platform: 'all',
        subcategory: 'all',
        methods: [],
        minMetric: '',
        maxMetric: '',
        gameName: 'all',
        gameUidQuery: '',
        minLevel: '',
        maxLevel: '',
      },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'subcategory') {
    return {
      nextFilters: { ...filters, subcategory: 'all' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'monetization') {
    return {
      nextFilters: { ...filters, monetization: 'all' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId.startsWith('method:')) {
    const methodId = chipId.slice('method:'.length);
    return {
      nextFilters: {
        ...filters,
        methods: filters.methods.filter((m) => m !== methodId),
      },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'priceRange') {
    return {
      nextFilters: { ...filters, minPrice: '', maxPrice: '' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'metricRange') {
    return {
      nextFilters: { ...filters, minMetric: '', maxMetric: '' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'revenueRange') {
    return {
      nextFilters: { ...filters, minRevenue: '', maxRevenue: '' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'gameName') {
    return {
      nextFilters: { ...filters, gameName: 'all' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'gameUidQuery') {
    return {
      nextFilters: { ...filters, gameUidQuery: '' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'levelRange') {
    return {
      nextFilters: { ...filters, minLevel: '', maxLevel: '' },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'verifiedSeller') {
    return {
      nextFilters: { ...filters, verifiedSeller: false },
      nextSearchQuery: searchQuery,
    };
  }

  if (chipId === 'sort') {
    return {
      nextFilters: { ...filters, sort: 'newest' },
      nextSearchQuery: searchQuery,
    };
  }

  return { nextFilters: filters, nextSearchQuery: searchQuery };
}

export function clearAllMarketplaceFiltersAndSearch(): {
  nextFilters: MarketplaceFilterState;
  nextSearchQuery: string;
} {
  return {
    nextFilters: { ...EMPTY_FILTERS, methods: [] },
    nextSearchQuery: '',
  };
}
