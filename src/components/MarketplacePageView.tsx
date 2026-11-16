import React from 'react';
import { Filter, History, Search, X } from 'lucide-react';
import type {
  CurrencyCode,
  LanguageCode,
  MarketplaceListing,
  PublicSettings,
  RecentSearchRecord,
} from '../types';
import { t } from '../lib/i18n';
import { buildActiveFilterChips, clearAllMarketplaceFiltersAndSearch, removeFilterChipFromState } from '../lib/marketplaceFilterLogic';
import { FilterPanel, MarketplaceFilterState } from './FilterPanel';
import { ListingCard } from './ListingCard';
import { MarketplaceGridSkeleton } from './LoadingSkeletons';

interface MarketplacePageViewProps {
  language: LanguageCode;
  currency: CurrencyCode;
  settings: PublicSettings;
  searchQuery: string;
  draftFilters: MarketplaceFilterState;
  appliedFilters: MarketplaceFilterState;
  draftMatchCount: number;
  filteredListings: MarketplaceListing[];
  activeListingsCount: number;
  listingLimit: number;
  listingsHydrated: boolean;
  mobileFilterOpen: boolean;
  recentSearches: RecentSearchRecord[];
  favoriteListingIds: Set<string>;
  onSearchQueryChange: (val: string) => void;
  onSetDraftFilters: React.Dispatch<React.SetStateAction<MarketplaceFilterState>>;
  onSetAppliedFilters: React.Dispatch<React.SetStateAction<MarketplaceFilterState>>;
  onSetMobileFilterOpen: React.Dispatch<React.SetStateAction<boolean>>;
  onRecordRecentSearch: () => void;
  onExecuteRecentSearch: (rec: RecentSearchRecord) => void;
  onManageRecentSearches: () => void;
  onLoadMoreListings: () => void;
  onOpenListingDetail: (listing: MarketplaceListing) => void;
  onOpenPublicProfile: (uid: string) => void;
  onToggleFavorite: (listing: MarketplaceListing) => void;
  onOpenSell: () => void;
  onPrefetchRoute?: (page: 'listing') => void;
}

export const MarketplacePageView: React.FC<MarketplacePageViewProps> = ({
  language,
  currency,
  settings,
  searchQuery,
  draftFilters,
  appliedFilters,
  draftMatchCount,
  filteredListings,
  activeListingsCount,
  listingLimit,
  listingsHydrated,
  mobileFilterOpen,
  recentSearches,
  favoriteListingIds,
  onSearchQueryChange,
  onSetDraftFilters,
  onSetAppliedFilters,
  onSetMobileFilterOpen,
  onRecordRecentSearch,
  onExecuteRecentSearch,
  onManageRecentSearches,
  onLoadMoreListings,
  onOpenListingDetail,
  onOpenPublicProfile,
  onToggleFavorite,
  onOpenSell,
  onPrefetchRoute,
}) => {
  const showInitialSkeleton = !listingsHydrated && activeListingsCount === 0;
  const activeChips = buildActiveFilterChips(appliedFilters, searchQuery, currency);

  return (
    <div className="bx-wrap-wide py-6 sm:py-8 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b-2 border-[var(--bx-border)] pb-5">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">{t(language, 'nav_market')}</h1>
          <p className="text-xs sm:text-sm opacity-75 tabular-nums">
            Showing {filteredListings.length} active digital asset{filteredListings.length === 1 ? '' : 's'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onRecordRecentSearch();
            }}
            className="flex items-center gap-2 flex-1 sm:flex-initial min-w-0"
          >
            <div className="relative flex-1 min-w-[160px] sm:w-72">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-60 pointer-events-none" />
              <input
                type="search"
                aria-label="Search marketplace listings"
                value={searchQuery}
                onChange={(e) => onSearchQueryChange(e.target.value)}
                placeholder={t(language, 'search_placeholder')}
                className="bx-input w-full pl-9 pr-3 py-2 text-xs font-semibold"
              />
            </div>
            <button
              type="submit"
              className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap shrink-0"
            >
              Search
            </button>
          </form>
          <button
            type="button"
            onClick={() => onSetMobileFilterOpen((v) => !v)}
            aria-expanded={mobileFilterOpen}
            className="lg:hidden bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
          >
            <Filter className="w-3.5 h-3.5" />
            Filters
          </button>
        </div>
      </div>

      {/* Inline Recent Searches Quick Bar */}
      {recentSearches.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 min-w-0">
            <span
              className="inline-flex items-center gap-1 font-extrabold shrink-0"
              style={{ color: 'var(--text-2)' }}
            >
              <History className="w-3.5 h-3.5" />
              <span>Recent:</span>
            </span>
            {recentSearches.slice(0, 5).map((rs) => (
              <button
                key={rs.id}
                type="button"
                onClick={() => onExecuteRecentSearch(rs)}
                className="px-3 py-1.5 min-h-[36px] rounded-md border font-semibold hover:underline truncate max-w-[200px]"
                style={{
                  background: 'var(--surface)',
                  borderColor: 'var(--border-soft)',
                  color: 'var(--text)',
                }}
              >
                {rs.summaryLabel}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onManageRecentSearches}
            className="font-extrabold hover:underline shrink-0 min-h-[36px] inline-flex items-center"
            style={{ color: 'var(--purple)' }}
          >
            Manage Recent Searches →
          </button>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6 items-start">
        {/* Desktop Sidebar or Mobile Collapsible Filter Panel */}
        <div
          className={`w-full lg:w-[272px] xl:w-[280px] shrink-0 ${
            mobileFilterOpen ? 'block' : 'hidden lg:block'
          }`}
        >
          <FilterPanel
            draft={draftFilters}
            setDraft={onSetDraftFilters}
            onApply={() => {
              onSetAppliedFilters(draftFilters);
              onSetMobileFilterOpen(false);
              onRecordRecentSearch();
            }}
            onReset={() => {
              const { nextFilters, nextSearchQuery } = clearAllMarketplaceFiltersAndSearch();
              onSetDraftFilters(nextFilters);
              onSetAppliedFilters(nextFilters);
              onSearchQueryChange(nextSearchQuery);
            }}
            matchCount={draftMatchCount}
            currency={currency}
            gamingTitles={settings.gamingTitles}
            disabledMonetizationIds={settings.disabledMonetizationIds}
          />
        </div>

        {/* Listings Grid (4 Balanced Columns on Wide Desktop) */}
        <div className="flex-1 min-w-0 w-full space-y-4">
          {activeChips.length > 0 && (
            <div
              data-testid="active-filter-chips-bar"
              aria-label="Active marketplace filters"
              className="p-3 rounded-xl border border-[var(--border-soft)] bg-[var(--surface-2)] flex flex-wrap items-center gap-2"
            >
              <span className="text-[11px] font-extrabold uppercase tracking-wide text-[var(--text-2)] mr-1">
                Active Filters:
              </span>
              {activeChips.map((chip) => (
                <span
                  key={chip.id}
                  data-testid={`filter-chip-${chip.id}`}
                  className="inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] text-xs font-bold text-[var(--text)]"
                >
                  <span>{chip.label}</span>
                  <button
                    type="button"
                    onClick={() => {
                      const { nextFilters, nextSearchQuery } =
                        removeFilterChipFromState(appliedFilters, searchQuery, chip.id);
                      onSetAppliedFilters(nextFilters);
                      onSetDraftFilters(nextFilters);
                      onSearchQueryChange(nextSearchQuery);
                    }}
                    aria-label={`Remove filter: ${chip.label}`}
                    className="w-7 h-7 sm:w-6 sm:h-6 rounded-md inline-flex items-center justify-center hover:bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--red)] transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
              <button
                type="button"
                data-testid="clear-all-filters-btn"
                onClick={() => {
                  const { nextFilters, nextSearchQuery } =
                    clearAllMarketplaceFiltersAndSearch();
                  onSetAppliedFilters(nextFilters);
                  onSetDraftFilters(nextFilters);
                  onSearchQueryChange(nextSearchQuery);
                }}
                className="ml-auto px-2.5 py-1.5 min-h-[36px] text-xs font-extrabold text-[var(--orange)] hover:underline whitespace-nowrap"
              >
                Clear All
              </button>
            </div>
          )}

          {showInitialSkeleton ? (
            <MarketplaceGridSkeleton count={8} />
          ) : filteredListings.length === 0 ? (
            <div className="bx-card p-8 sm:p-10 text-center space-y-4">
              <h2 className="text-lg font-black">{t(language, 'no_listings')}</h2>
              <p className="text-xs sm:text-sm opacity-75 max-w-md mx-auto">
                No active assets match your current category or numeric range criteria. Adjust your filters or list a verified asset for sale.
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const { nextFilters, nextSearchQuery } =
                      clearAllMarketplaceFiltersAndSearch();
                    onSetDraftFilters(nextFilters);
                    onSetAppliedFilters(nextFilters);
                    onSearchQueryChange(nextSearchQuery);
                  }}
                  className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold"
                >
                  Reset All Filters
                </button>
                <button
                  type="button"
                  onClick={onOpenSell}
                  className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold"
                >
                  {t(language, 'btn_sell')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div
                data-testid="marketplace-listings-grid"
                className="bx-listing-grid"
                onMouseEnter={() => onPrefetchRoute?.('listing')}
              >
                {filteredListings.map((item, idx) => (
                  <ListingCard
                    key={item.id}
                    listing={item}
                    displayCurrency={currency}
                    usdToBdtRate={settings.usdToBdtRate}
                    onOpen={onOpenListingDetail}
                    onOpenSellerProfile={onOpenPublicProfile}
                    isFavorited={favoriteListingIds.has(item.id)}
                    onToggleFavorite={onToggleFavorite}
                    priority={idx < 2}
                  />
                ))}
              </div>
              {activeListingsCount >= listingLimit && (
                <div className="pt-6 flex justify-center">
                  <button
                    type="button"
                    onClick={onLoadMoreListings}
                    className="bx-btn bx-btn-ghost px-6 py-2.5 text-xs font-extrabold"
                  >
                    Load more listings
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
