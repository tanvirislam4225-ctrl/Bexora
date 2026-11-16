import React from 'react';
import { ArrowRight, Lock, Plus, ShieldCheck, SlidersHorizontal, Sparkles, Search } from 'lucide-react';
import type {
  CurrencyCode,
  LanguageCode,
  MarketplaceListing,
  PlatformId,
  PublicActivityItem,
  PublicSettings,
} from '../types';
import { getProtectionDurationHours, PLATFORM_CATALOG, PLATFORM_LIST } from '../lib/marketplaceLogic';
import { t } from '../lib/i18n';
import { ListingCard } from './ListingCard';
import { LiveActivityTickers } from './LiveActivityTickers';
import { MarketplaceGridSkeleton } from './LoadingSkeletons';

interface HomePageViewProps {
  language: LanguageCode;
  currency: CurrencyCode;
  settings: PublicSettings;
  searchQuery: string;
  activeListings: MarketplaceListing[];
  listingsHydrated: boolean;
  favoriteListingIds: Set<string>;
  onSearchQueryChange: (val: string) => void;
  onSubmitSearch: () => void;
  onOpenMarket: (resetFilters?: boolean) => void;
  onQuickCategorySelect: (p: PlatformId) => void;
  onOpenSell: () => void;
  onOpenListingDetail: (listing: MarketplaceListing) => void;
  onOpenPublicProfile: (uid: string) => void;
  onToggleFavorite: (listing: MarketplaceListing) => void;
  onActivitiesChange: (items: PublicActivityItem[]) => void;
  onPrefetchRoute?: (page: 'market' | 'listing' | 'sell') => void;
}

export const HomePageView: React.FC<HomePageViewProps> = ({
  language,
  currency,
  settings,
  searchQuery,
  activeListings,
  listingsHydrated,
  favoriteListingIds,
  onSearchQueryChange,
  onSubmitSearch,
  onOpenMarket,
  onQuickCategorySelect,
  onOpenSell,
  onOpenListingDetail,
  onOpenPublicProfile,
  onToggleFavorite,
  onActivitiesChange,
  onPrefetchRoute,
}) => {
  const showInitialSkeleton = !listingsHydrated && activeListings.length === 0;

  return (
    <div className="pb-12">
      {/* Real-Time RECENT SOLD & RECENT PAYOUT Activity Tickers */}
      <LiveActivityTickers onActivitiesChange={onActivitiesChange} />

      <div className="space-y-12">
        {/* Hero Section */}
        <section className="border-b-2 border-[var(--bx-border)] bg-[var(--bx-surface)]">
          <div className="bx-wrap-wide py-10 sm:py-12 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
            <div className="lg:col-span-7 space-y-6 min-w-0">
              <div className="inline-flex items-center gap-2 px-3 py-1 text-xs font-black uppercase tracking-wider bg-[#FFD400] text-[#191919] border-2 border-[#191919]">
                <ShieldCheck className="w-4 h-4 shrink-0" />
                <span>{t(language, 'hero_eyebrow')}</span>
              </div>

              <h1 className="text-3xl sm:text-5xl font-black tracking-tight leading-[1.08] break-words">
                {t(language, 'hero_title')}
              </h1>

              <p className="text-base sm:text-lg opacity-85 max-w-2xl leading-relaxed">
                {t(language, 'hero_sub')}
              </p>

              {/* Search Bar */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onSubmitSearch();
                }}
                className="flex flex-col sm:flex-row gap-3 max-w-2xl"
              >
                <div className="relative flex-1 min-w-0">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 opacity-60 pointer-events-none" />
                  <input
                    type="search"
                    aria-label={t(language, 'search_placeholder')}
                    value={searchQuery}
                    onChange={(e) => onSearchQueryChange(e.target.value)}
                    placeholder={t(language, 'search_placeholder')}
                    className="bx-input w-full pl-10 pr-4 py-3 text-sm font-semibold"
                  />
                </div>
                <button
                  type="submit"
                  onMouseEnter={() => onPrefetchRoute?.('market')}
                  className="bx-btn bx-btn-primary px-6 py-3 text-sm font-extrabold inline-flex items-center justify-center gap-2 shrink-0"
                >
                  <span>Explore Assets</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </form>

              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  onClick={onOpenSell}
                  onMouseEnter={() => onPrefetchRoute?.('sell')}
                  className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                >
                  <Plus className="w-4 h-4 text-[#FF6500]" />
                  {t(language, 'btn_sell')}
                </button>
                <span className="text-xs font-bold opacity-75">
                  Escrow Hold · Immutable Protection Windows · Evidence-Reviewed Monetization
                </span>
              </div>
            </div>

            {/* Right-side Escrow & Verification Architecture Card */}
            <div className="lg:col-span-5 min-w-0">
              <div className="bx-card p-5 sm:p-6 space-y-4">
                <div className="flex items-center justify-between gap-2 border-b-2 border-[var(--bx-border)] pb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <Lock className="w-5 h-5 text-[#FF6500] shrink-0" />
                    <h2 className="text-base font-black truncate">How BEXORA Escrow Works</h2>
                  </div>
                  <span className="text-[11px] font-black uppercase px-2 py-0.5 bg-[#793A91] text-white shrink-0">
                    Protected
                  </span>
                </div>

                <ol className="space-y-3 text-xs font-bold">
                  <li className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex gap-3">
                    <span className="w-6 h-6 shrink-0 bg-[#FF6500] text-white font-black flex items-center justify-center">
                      1
                    </span>
                    <div className="min-w-0">
                      <div className="font-black text-sm">Verify Before Bidding</div>
                      <p className="opacity-80 font-medium mt-0.5">
                        Inspect public domain-matched asset links, account age, and Admin-verified monetization status.
                      </p>
                    </div>
                  </li>
                  <li className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex gap-3">
                    <span className="w-6 h-6 shrink-0 bg-[#FF6500] text-white font-black flex items-center justify-center">
                      2
                    </span>
                    <div className="min-w-0">
                      <div className="font-black text-sm">Escrow Lock &amp; Guided Transfer</div>
                      <p className="opacity-80 font-medium mt-0.5">
                        Funds stay locked in BEXORA Escrow while ownership credentials are transferred inside the Deal Room.
                      </p>
                    </div>
                  </li>
                  <li className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex gap-3">
                    <span className="w-6 h-6 shrink-0 bg-[#FF6500] text-white font-black flex items-center justify-center">
                      3
                    </span>
                    <div className="min-w-0">
                      <div className="font-black text-sm">Category Protection Countdown</div>
                      <p className="opacity-80 font-medium mt-0.5">
                        7-day protection for YouTube channels ({getProtectionDurationHours('youtube', settings)}h) and {getProtectionDurationHours('facebook', settings)}h for Facebook &amp; standard-transfer assets.
                      </p>
                    </div>
                  </li>
                </ol>
              </div>
            </div>
          </div>
        </section>

        {/* Responsive 8-Category Grid */}
        <section className="bx-wrap-wide space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight">Browse by Asset Category</h2>
              <p className="text-xs sm:text-sm opacity-75">
                Select any platform to launch category-specific filters and monetization rules.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenMarket(true)}
              onMouseEnter={() => onPrefetchRoute?.('market')}
              className="text-xs font-black text-[#FF6500] hover:underline min-h-[44px] inline-flex items-center"
            >
              View All Categories →
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
            {PLATFORM_LIST.map((pId) => {
              const def = PLATFORM_CATALOG[pId];
              const count = activeListings.filter((l) => l.platform === pId).length;
              return (
                <button
                  key={pId}
                  type="button"
                  onClick={() => onQuickCategorySelect(pId)}
                  onMouseEnter={() => onPrefetchRoute?.('market')}
                  className="bx-cat-card bx-card p-3.5 flex flex-col items-start justify-between gap-3 text-left hover:-translate-y-0.5 transition-transform"
                >
                  <PlatformIconPlaceholder id={pId} />
                  <div className="w-full min-w-0">
                    <div className="font-black text-xs sm:text-sm truncate">{def.name}</div>
                    <div className="text-[11px] font-bold opacity-70 tabular-nums">
                      {count} {count === 1 ? 'listing' : 'listings'}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Live Marketplace Feed on Home (4-Column Wide Desktop Grid) */}
        <section className="bx-wrap-wide space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight">Latest Verified Listings</h2>
              <p className="text-xs sm:text-sm opacity-75">
                Real seller submissions approved by BEXORA Moderation.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onOpenMarket(false)}
              onMouseEnter={() => onPrefetchRoute?.('market')}
              className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Advanced Filters
            </button>
          </div>

          {showInitialSkeleton ? (
            <MarketplaceGridSkeleton count={4} />
          ) : activeListings.length === 0 ? (
            <div className="bx-card p-10 text-center space-y-4">
              <Sparkles className="w-8 h-8 text-[#FF6500] mx-auto" />
              <h3 className="text-lg font-black">{t(language, 'no_listings')}</h3>
              <p className="text-sm opacity-75 max-w-md mx-auto">
                BEXORA never populates fake or placeholder listings. Be the first verified seller to publish a YouTube channel, Facebook page, website, domain, or gaming asset.
              </p>
              <button
                type="button"
                onClick={onOpenSell}
                className="bx-btn bx-btn-primary px-6 py-2.5 text-xs font-extrabold"
              >
                {t(language, 'btn_sell')}
              </button>
            </div>
          ) : (
            <div
              data-testid="home-latest-listings-grid"
              className="bx-listing-grid"
              onMouseEnter={() => onPrefetchRoute?.('listing')}
            >
              {activeListings.slice(0, 8).map((item, idx) => (
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
          )}
        </section>
      </div>
    </div>
  );
};

import { PlatformIcon } from './Icons';

const PlatformIconPlaceholder: React.FC<{ id: PlatformId }> = ({ id }) => (
  <PlatformIcon id={id} size={32} />
);
