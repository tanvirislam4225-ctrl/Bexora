import React from 'react';
import { CurrencyCode, PlatformId } from '../types';
import {
  getCategoryMetricLabel,
  PLATFORM_CATALOG,
  PLATFORM_LIST,
} from '../lib/marketplaceLogic';

export interface MarketplaceFilterState {
  platform: 'all' | PlatformId;
  subcategory: string;
  monetization: 'all' | 'monetized' | 'non-monetized' | 'verified-only';
  methods: string[];
  minPrice: string;
  maxPrice: string;
  minMetric: string;
  maxMetric: string;
  minRevenue: string;
  maxRevenue: string;
  gameName: string;
  gameUidQuery: string;
  minLevel: string;
  maxLevel: string;
  verifiedSeller: boolean;
  sort: 'newest' | 'oldest' | 'price-asc' | 'price-desc' | 'popular';
}

export const EMPTY_FILTERS: MarketplaceFilterState = {
  platform: 'all',
  subcategory: 'all',
  monetization: 'all',
  methods: [],
  minPrice: '',
  maxPrice: '',
  minMetric: '',
  maxMetric: '',
  minRevenue: '',
  maxRevenue: '',
  gameName: 'all',
  gameUidQuery: '',
  minLevel: '',
  maxLevel: '',
  verifiedSeller: false,
  sort: 'newest',
};

interface FilterPanelProps {
  draft: MarketplaceFilterState;
  setDraft: React.Dispatch<React.SetStateAction<MarketplaceFilterState>>;
  onApply: () => void;
  onReset: () => void;
  matchCount: number;
  currency: CurrencyCode;
  gamingTitles: string[];
  disabledMonetizationIds: string[];
}

export const FilterPanel: React.FC<FilterPanelProps> = ({
  draft,
  setDraft,
  onApply,
  onReset,
  matchCount,
  currency,
  gamingTitles,
  disabledMonetizationIds,
}) => {
  const isSpecificPlatform = draft.platform !== 'all';
  const platformDef = isSpecificPlatform ? PLATFORM_CATALOG[draft.platform as PlatformId] : null;
  const availableOptions = platformDef
    ? platformDef.monetizationOptions.filter((o) => !disabledMonetizationIds.includes(o.id))
    : [];

  const rangeInvalid = (minStr: string, maxStr: string) =>
    minStr !== '' && maxStr !== '' && Number(minStr) > Number(maxStr);

  const priceErr = rangeInvalid(draft.minPrice, draft.maxPrice);
  const metricErr = rangeInvalid(draft.minMetric, draft.maxMetric);
  const revErr = rangeInvalid(draft.minRevenue, draft.maxRevenue);
  const lvlErr = rangeInvalid(draft.minLevel, draft.maxLevel);
  const anyRangeErr = priceErr || metricErr || revErr || lvlErr;

  const handlePlatformChange = (nextPlatform: 'all' | PlatformId) => {
    // Revalidate and clear incompatible category-specific filter fields
    setDraft((prev) => ({
      ...EMPTY_FILTERS,
      minPrice: prev.minPrice,
      maxPrice: prev.maxPrice,
      verifiedSeller: prev.verifiedSeller,
      sort: prev.sort,
      platform: nextPlatform,
    }));
  };

  const toggleMethod = (id: string) => {
    setDraft((prev) => ({
      ...prev,
      methods: prev.methods.includes(id)
        ? prev.methods.filter((x) => x !== id)
        : [...prev.methods, id],
    }));
  };

  const allMethodsSelected =
    availableOptions.length > 0 && availableOptions.every((o) => draft.methods.includes(o.id));

  const metricLabel =
    draft.platform !== 'all'
      ? getCategoryMetricLabel(
          draft.platform,
          draft.subcategory !== 'all' ? draft.subcategory : undefined
        )
      : 'Audience Size';

  return (
    <div className="space-y-4">
      {/* 1. Platform Selector */}
      <div>
        <label htmlFor="flt-platform" className="bx-label">
          Platform Category
        </label>
        <select
          id="flt-platform"
          value={draft.platform}
          onChange={(e) => handlePlatformChange(e.target.value as 'all' | PlatformId)}
          className="bx-select"
        >
          <option value="all">All Platforms</option>
          {PLATFORM_LIST.map((p) => (
            <option key={p} value={p}>
              {PLATFORM_CATALOG[p].name}
            </option>
          ))}
        </select>
      </div>

      {/* 2. Subcategory Selector (e.g. Facebook Page vs Facebook Group, Telegram Channel vs Group) */}
      {platformDef && platformDef.subcategories.length > 1 && (
        <div>
          <label htmlFor="flt-subcat" className="bx-label">
            {platformDef.name} Asset Type
          </label>
          <select
            id="flt-subcat"
            value={draft.subcategory}
            onChange={(e) => setDraft((prev) => ({ ...prev, subcategory: e.target.value }))}
            className="bx-select"
          >
            <option value="all">All {platformDef.name} Types</option>
            {platformDef.subcategories.map((sub) => (
              <option key={sub} value={sub}>
                {sub}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 3. Gaming-Specific Filters (Game, UID, Level Range — NO social monetization fields!) */}
      {draft.platform === 'gaming' && (
        <div className="space-y-3.5 p-3.5 rounded-xl bx-soft">
          <div>
            <label htmlFor="flt-game" className="bx-label">
              Game Title
            </label>
            <select
              id="flt-game"
              value={draft.gameName}
              onChange={(e) => setDraft((prev) => ({ ...prev, gameName: e.target.value }))}
              className="bx-select"
            >
              <option value="all">All Supported Games</option>
              {gamingTitles.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="flt-game-uid" className="bx-label">
              Game UID / Player ID
            </label>
            <input
              id="flt-game-uid"
              type="text"
              value={draft.gameUidQuery}
              onChange={(e) => setDraft((prev) => ({ ...prev, gameUidQuery: e.target.value }))}
              placeholder="Search exact or partial UID"
              className="bx-input"
            />
          </div>

          <div>
            <span className="bx-label">Account Level Range</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="0"
                inputMode="numeric"
                aria-label="Minimum account level"
                placeholder="Min lvl"
                value={draft.minLevel}
                onChange={(e) => setDraft((prev) => ({ ...prev, minLevel: e.target.value }))}
                className={`bx-input ${lvlErr ? 'bx-input-err' : ''}`}
              />
              <input
                type="number"
                min="0"
                inputMode="numeric"
                aria-label="Maximum account level"
                placeholder="Max lvl"
                value={draft.maxLevel}
                onChange={(e) => setDraft((prev) => ({ ...prev, maxLevel: e.target.value }))}
                className={`bx-input ${lvlErr ? 'bx-input-err' : ''}`}
              />
            </div>
            {lvlErr && (
              <p className="text-xs font-bold mt-1" style={{ color: 'var(--red)' }}>
                Minimum level cannot exceed maximum level.
              </p>
            )}
          </div>
        </div>
      )}

      {/* 4. Monetization Filters (Shown ONLY where platform supports monetization) */}
      {(draft.platform === 'all' || (platformDef && platformDef.supportsMonetization)) &&
        !(draft.platform === 'facebook' && draft.subcategory === 'Facebook Group') && (
          <div className="space-y-3">
            <div>
              <label htmlFor="flt-mon-status" className="bx-label">
                Monetization Status
              </label>
              <select
                id="flt-mon-status"
                value={draft.monetization}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    monetization: e.target.value as MarketplaceFilterState['monetization'],
                    methods: e.target.value === 'non-monetized' ? [] : prev.methods,
                  }))
                }
                className="bx-select"
              >
                <option value="all">All Statuses</option>
                <option value="verified-only">Active — Verified Only</option>
                <option value="monetized">Monetized (Verified or Claimed)</option>
                <option value="non-monetized">Non-Monetized</option>
              </select>
            </div>

            {platformDef && availableOptions.length > 0 && draft.monetization !== 'non-monetized' && (
              <div>
                <span className="bx-label">{platformDef.name} Monetization Programs</span>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-2.5 p-2 rounded-lg bx-soft cursor-pointer text-xs font-extrabold">
                    <input
                      type="checkbox"
                      checked={allMethodsSelected}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          methods: e.target.checked ? availableOptions.map((o) => o.id) : [],
                        }))
                      }
                      className="w-4 h-4 accent-purple-700"
                    />
                    <span>All Monetization ({availableOptions.length})</span>
                  </label>
                  {availableOptions.map((opt) => (
                    <label
                      key={opt.id}
                      className="flex items-center gap-2.5 p-2 rounded-lg bx-soft cursor-pointer text-xs font-semibold"
                    >
                      <input
                        type="checkbox"
                        checked={draft.methods.includes(opt.id)}
                        onChange={() => toggleMethod(opt.id)}
                        className="w-4 h-4 accent-purple-700"
                      />
                      <span>{opt.name}</span>
                    </label>
                  ))}
                </div>
                <p className="bx-hint mt-1">Matches listings offering any selected program (OR logic).</p>
              </div>
            )}
          </div>
        )}

      {/* 5. Manual Numeric Audience Metric Range (For non-gaming specific platforms) */}
      {platformDef && draft.platform !== 'gaming' && (
        <div>
          <span className="bx-label">{metricLabel} (Manual Range)</span>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              min="0"
              inputMode="numeric"
              aria-label={`Minimum ${metricLabel}`}
              placeholder="Min"
              value={draft.minMetric}
              onChange={(e) => setDraft((prev) => ({ ...prev, minMetric: e.target.value }))}
              className={`bx-input ${metricErr ? 'bx-input-err' : ''}`}
            />
            <input
              type="number"
              min="0"
              inputMode="numeric"
              aria-label={`Maximum ${metricLabel}`}
              placeholder="Max"
              value={draft.maxMetric}
              onChange={(e) => setDraft((prev) => ({ ...prev, maxMetric: e.target.value }))}
              className={`bx-input ${metricErr ? 'bx-input-err' : ''}`}
            />
          </div>
          {metricErr && (
            <p className="text-xs font-bold mt-1" style={{ color: 'var(--red)' }}>
              Minimum cannot exceed maximum.
            </p>
          )}
        </div>
      )}

      {/* 6. Manual Numeric Monthly Revenue Range */}
      {draft.platform !== 'gaming' &&
        draft.platform !== 'domain' &&
        draft.monetization !== 'non-monetized' && (
          <div>
            <span className="bx-label">Monthly Revenue ({currency})</span>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                min="0"
                inputMode="numeric"
                aria-label="Minimum monthly revenue"
                placeholder="Min"
                value={draft.minRevenue}
                onChange={(e) => setDraft((prev) => ({ ...prev, minRevenue: e.target.value }))}
                className={`bx-input ${revErr ? 'bx-input-err' : ''}`}
              />
              <input
                type="number"
                min="0"
                inputMode="numeric"
                aria-label="Maximum monthly revenue"
                placeholder="Max"
                value={draft.maxRevenue}
                onChange={(e) => setDraft((prev) => ({ ...prev, maxRevenue: e.target.value }))}
                className={`bx-input ${revErr ? 'bx-input-err' : ''}`}
              />
            </div>
            {revErr && (
              <p className="text-xs font-bold mt-1" style={{ color: 'var(--red)' }}>
                Minimum revenue cannot exceed maximum.
              </p>
            )}
          </div>
        )}

      {/* 7. Manual Price Range */}
      <div>
        <span className="bx-label">Asking Price ({currency})</span>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            min="0"
            inputMode="numeric"
            aria-label="Minimum asking price"
            placeholder="Min"
            value={draft.minPrice}
            onChange={(e) => setDraft((prev) => ({ ...prev, minPrice: e.target.value }))}
            className={`bx-input ${priceErr ? 'bx-input-err' : ''}`}
          />
          <input
            type="number"
            min="0"
            inputMode="numeric"
            aria-label="Maximum asking price"
            placeholder="Max"
            value={draft.maxPrice}
            onChange={(e) => setDraft((prev) => ({ ...prev, maxPrice: e.target.value }))}
            className={`bx-input ${priceErr ? 'bx-input-err' : ''}`}
          />
        </div>
        {priceErr && (
          <p className="text-xs font-bold mt-1" style={{ color: 'var(--red)' }}>
            Minimum price cannot exceed maximum.
          </p>
        )}
      </div>

      {/* 8. Verified Seller Filter */}
      <label className="flex items-center gap-2.5 p-3 rounded-xl bx-soft cursor-pointer text-sm font-bold">
        <input
          type="checkbox"
          checked={draft.verifiedSeller}
          onChange={(e) => setDraft((prev) => ({ ...prev, verifiedSeller: e.target.checked }))}
          className="w-4 h-4 accent-purple-700"
        />
        <span>Verified Sellers Only</span>
      </label>

      {/* 9. Sort Order */}
      <div>
        <label htmlFor="flt-sort" className="bx-label">
          Sort Results
        </label>
        <select
          id="flt-sort"
          value={draft.sort}
          onChange={(e) =>
            setDraft((prev) => ({
              ...prev,
              sort: e.target.value as MarketplaceFilterState['sort'],
            }))
          }
          className="bx-select"
        >
          <option value="newest">Newest First</option>
          <option value="oldest">Oldest First</option>
          <option value="price-asc">Price: Low to High</option>
          <option value="price-desc">Price: High to Low</option>
          <option value="popular">Most Viewed</option>
        </select>
      </div>

      <div className="grid grid-cols-2 gap-2 pt-1">
        <button
          type="button"
          onClick={onApply}
          disabled={anyRangeErr}
          className="bx-btn bx-btn-primary w-full"
        >
          Apply Filters
        </button>
        <button type="button" onClick={onReset} className="bx-btn w-full">
          Reset
        </button>
      </div>

      <p className="bx-hint text-center tabular-nums">
        {matchCount} listing{matchCount === 1 ? '' : 's'} currently displayed
      </p>
    </div>
  );
};
