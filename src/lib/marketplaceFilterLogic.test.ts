import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActiveFilterChips,
  clearAllMarketplaceFiltersAndSearch,
  removeFilterChipFromState,
} from './marketplaceFilterLogic';
import { EMPTY_FILTERS, type MarketplaceFilterState } from '../components/FilterPanel';

test('buildActiveFilterChips generates readable deduplicated chips for applied filters and search', () => {
  const filters: MarketplaceFilterState = {
    ...EMPTY_FILTERS,
    platform: 'youtube',
    subcategory: 'Gaming',
    monetization: 'monetized',
    methods: ['youtube_adsense', 'youtube_adsense', 'youtube_sponsorship'],
    minPrice: '5000',
    maxPrice: '20000',
    minMetric: '10000',
    minRevenue: '500',
    verifiedSeller: true,
    sort: 'price-asc',
  };

  const chips = buildActiveFilterChips(filters, '  tech channel  ', 'BDT');
  const ids = chips.map((c) => c.id);

  assert.equal(ids.length, new Set(ids).size, 'Duplicate chips must not appear');
  assert.ok(chips.some((c) => c.id === 'search' && c.label.includes('tech channel')));
  assert.ok(chips.some((c) => c.id === 'platform' && c.label.includes('YouTube')));
  assert.ok(chips.some((c) => c.id === 'subcategory' && c.label.includes('Gaming')));
  assert.ok(chips.some((c) => c.id === 'method:youtube_adsense'));
  assert.ok(chips.some((c) => c.id === 'method:youtube_sponsorship'));
  assert.ok(chips.some((c) => c.id === 'priceRange' && c.label.includes('BDT')));
  assert.ok(chips.some((c) => c.id === 'metricRange'));
  assert.ok(chips.some((c) => c.id === 'revenueRange'));
  assert.ok(chips.some((c) => c.id === 'verifiedSeller'));
  assert.ok(chips.some((c) => c.id === 'sort'));
});

test('removing a single filter chip updates only that filter while preserving sibling filters and search', () => {
  const initial: MarketplaceFilterState = {
    ...EMPTY_FILTERS,
    platform: 'youtube',
    methods: ['youtube_adsense', 'youtube_sponsorship'],
    minPrice: '1000',
    maxPrice: '5000',
    verifiedSeller: true,
    sort: 'popular',
  };

  const step1 = removeFilterChipFromState(initial, 'gaming', 'verifiedSeller');
  assert.equal(step1.nextFilters.verifiedSeller, false);
  assert.equal(step1.nextFilters.platform, 'youtube');
  assert.equal(step1.nextFilters.minPrice, '1000');
  assert.equal(step1.nextSearchQuery, 'gaming');

  const step2 = removeFilterChipFromState(step1.nextFilters, step1.nextSearchQuery, 'method:youtube_adsense');
  assert.deepEqual(step2.nextFilters.methods, ['youtube_sponsorship']);
  assert.equal(step2.nextFilters.sort, 'popular');

  const step3 = removeFilterChipFromState(step2.nextFilters, step2.nextSearchQuery, 'search');
  assert.equal(step3.nextSearchQuery, '');
  assert.equal(step3.nextFilters.platform, 'youtube');

  const step4 = removeFilterChipFromState(step3.nextFilters, step3.nextSearchQuery, 'priceRange');
  assert.equal(step4.nextFilters.minPrice, '');
  assert.equal(step4.nextFilters.maxPrice, '');
  assert.equal(step4.nextFilters.platform, 'youtube');
});

test('removing platform resets platform-dependent fields cleanly while preserving price and search', () => {
  const gamingFilters: MarketplaceFilterState = {
    ...EMPTY_FILTERS,
    platform: 'gaming',
    gameName: 'Free Fire',
    gameUidQuery: '123456',
    minLevel: '60',
    minPrice: '2000',
  };

  const res = removeFilterChipFromState(gamingFilters, 'booyah', 'platform');
  assert.equal(res.nextFilters.platform, 'all');
  assert.equal(res.nextFilters.gameName, 'all');
  assert.equal(res.nextFilters.gameUidQuery, '');
  assert.equal(res.nextFilters.minLevel, '');
  assert.equal(res.nextFilters.minPrice, '2000');
  assert.equal(res.nextSearchQuery, 'booyah');
});

test('clearAllMarketplaceFiltersAndSearch resets all filters and search query cleanly', () => {
  const cleared = clearAllMarketplaceFiltersAndSearch();
  assert.deepEqual(cleared.nextFilters, EMPTY_FILTERS);
  assert.equal(cleared.nextSearchQuery, '');
  assert.deepEqual(buildActiveFilterChips(cleared.nextFilters, cleared.nextSearchQuery, 'BDT'), []);
});
