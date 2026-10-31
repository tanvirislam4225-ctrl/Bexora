import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ExternalLink,
  Heart,
  LayoutGrid,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type {
  CurrencyCode,
  FavoriteRecord,
  MarketplaceListing,
} from '../types';
import {
  FavoriteAvailabilityState,
  resolveFavoriteDisplayItem,
} from '../lib/engagementLogic';
import { fetchSpecificListingsByIds } from '../lib/engagementService';
import { formatMoneyFromMinor, PLATFORM_CATALOG } from '../lib/marketplaceLogic';
import { formatNotificationTimestamp } from '../lib/notificationLogic';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface FavoritesViewProps {
  userUid: string | null;
  favorites: ReadonlyArray<FavoriteRecord>;
  liveListings: ReadonlyArray<MarketplaceListing>;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpenListingById: (listingId: string) => void;
  onOpenPublicProfile: (sellerId: string) => void;
  onRemoveFavorite: (listingId: string, title: string) => Promise<void>;
  onBrowseMarketplace: () => void;
  onRequireAuth: () => void;
}

type FavoritesFilter = 'all' | 'active' | 'reserved_sold' | 'unavailable';

export const FavoritesView: React.FC<FavoritesViewProps> = ({
  userUid,
  favorites,
  liveListings,
  displayCurrency,
  usdToBdtRate,
  onOpenListingById,
  onOpenPublicProfile,
  onRemoveFavorite,
  onBrowseMarketplace,
  onRequireAuth,
}) => {
  const [filter, setFilter] = useState<FavoritesFilter>('all');
  const [extraListingsMap, setExtraListingsMap] = useState<Map<string, MarketplaceListing>>(
    () => new Map()
  );
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(18);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  const liveMap = useMemo(() => {
    const map = new Map<string, MarketplaceListing>();
    for (const item of liveListings) {
      map.set(item.id, item);
    }
    return map;
  }, [liveListings]);

  // Fetch any favorited listings that are not in the active/reserved feed (e.g. sold listings)
  useEffect(() => {
    if (!userUid || favorites.length === 0) return;
    const missingIds = favorites
      .map((f) => f.listingId)
      .filter((id) => !liveMap.has(id) && !extraListingsMap.has(id));
    if (missingIds.length === 0) return;

    let cancelled = false;
    void (async () => {
      const fetched = await fetchSpecificListingsByIds(missingIds);
      if (cancelled || fetched.size === 0) return;
      setExtraListingsMap((prev) => {
        const next = new Map(prev);
        fetched.forEach((val, key) => next.set(key, val));
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [userUid, favorites, liveMap, extraListingsMap]);

  const resolvedItems = useMemo(() => {
    const sortedFavs = [...favorites].sort(
      (a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0)
    );
    return sortedFavs.map((fav) => {
      const live = liveMap.get(fav.listingId) || extraListingsMap.get(fav.listingId) || null;
      return resolveFavoriteDisplayItem(fav, live);
    });
  }, [favorites, liveMap, extraListingsMap]);

  const counts = useMemo(() => {
    let active = 0;
    let reservedSold = 0;
    let unavailable = 0;
    for (const item of resolvedItems) {
      if (item.availability === 'active') active += 1;
      else if (item.availability === 'reserved' || item.availability === 'sold') reservedSold += 1;
      else unavailable += 1;
    }
    return {
      all: resolvedItems.length,
      active,
      reserved_sold: reservedSold,
      unavailable,
    };
  }, [resolvedItems]);

  const filteredItems = useMemo(() => {
    switch (filter) {
      case 'active':
        return resolvedItems.filter((i) => i.availability === 'active');
      case 'reserved_sold':
        return resolvedItems.filter(
          (i) => i.availability === 'reserved' || i.availability === 'sold'
        );
      case 'unavailable':
        return resolvedItems.filter((i) => i.availability === 'unavailable');
      default:
        return resolvedItems;
    }
  }, [resolvedItems, filter]);

  if (!userUid) {
    return (
      <section className="bx-wrap py-12">
        <div className="bx-card max-w-xl mx-auto p-8 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--orange-soft)', color: 'var(--orange)' }}
          >
            <Heart className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-black">Saved Favorites</h1>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Sign in to save marketplace listings to your private Favorites list and keep them synchronized across all your devices.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button type="button" onClick={onRequireAuth} className="bx-btn bx-btn-primary">
              <span>Sign In to View Favorites</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button type="button" onClick={onBrowseMarketplace} className="bx-btn">
              <span>Browse Marketplace</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  const getStatusColor = (availability: FavoriteAvailabilityState): string => {
    switch (availability) {
      case 'active':
        return 'var(--green)';
      case 'reserved':
        return 'var(--orange)';
      case 'sold':
        return 'var(--purple)';
      case 'unavailable':
        return 'var(--red)';
    }
  };

  return (
    <section className="bx-wrap py-8 space-y-6" aria-label="Saved Favorites">
      {/* Header */}
      <div
        className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div>
          <p className="bx-eyebrow mb-1">Private Watchlist</p>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">Saved Favorites</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
            Only you can see your saved listings. Sold, reserved, or removed items show their real-time status and can be removed anytime.
          </p>
        </div>

        <button
          type="button"
          onClick={onBrowseMarketplace}
          className="bx-btn bx-btn-sm self-start sm:self-auto whitespace-nowrap shrink-0"
        >
          <LayoutGrid className="w-4 h-4" />
          <span>Explore Marketplace</span>
        </button>
      </div>

      {/* Filter Bar */}
      {resolvedItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter favorites">
          {(
            [
              { id: 'all', label: `All Saved (${counts.all})` },
              { id: 'active', label: `Available (${counts.active})` },
              { id: 'reserved_sold', label: `Reserved / Sold (${counts.reserved_sold})` },
              { id: 'unavailable', label: `Unavailable (${counts.unavailable})` },
            ] as const
          ).map((tab) => {
            const active = filter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(tab.id)}
                className="bx-chip whitespace-nowrap shrink-0 tabular-nums"
                data-active={active ? 'true' : 'false'}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Empty States */}
      {resolvedItems.length === 0 ? (
        <div className="bx-card p-10 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--surface-2)', color: 'var(--orange)' }}
          >
            <Heart className="w-6 h-6" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <h2 className="text-lg font-extrabold">No saved favorites yet</h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Tap the Heart icon on any channel, page, website, domain, or gaming asset to bookmark it privately for quick comparison.
            </p>
          </div>
          <button type="button" onClick={onBrowseMarketplace} className="bx-btn bx-btn-primary">
            <LayoutGrid className="w-4 h-4" />
            <span>Browse Verified Listings</span>
          </button>
        </div>
      ) : filteredItems.length === 0 ? (
        <div className="bx-card p-8 text-center space-y-3">
          <h2 className="text-base font-extrabold">No saved listings match this filter</h2>
          <button type="button" onClick={() => setFilter('all')} className="bx-btn bx-btn-sm">
            <span>Show All Saved ({counts.all})</span>
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {filteredItems.slice(0, visibleLimit).map((item) => {
              const platformDef = PLATFORM_CATALOG[item.platform];
              const hasImg = Boolean(item.thumbnailUrl && !failedImages[item.favoriteId]);
              const isRemoving = removingId === item.listingId;

              return (
                <article
                  key={item.favoriteId}
                  className="bx-card overflow-hidden flex flex-col justify-between min-w-0"
                >
                  <div>
                    {/* Media Banner */}
                    <div
                      className="relative aspect-[16/10] w-full overflow-hidden flex items-center justify-center"
                      style={{ background: PLATFORM_BANNER_BG[item.platform] }}
                    >
                      {hasImg ? (
                        <img
                          src={item.thumbnailUrl}
                          alt={item.title}
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setFailedImages((prev) => ({ ...prev, [item.favoriteId]: true }))
                          }
                          className={`w-full h-full object-cover ${
                            item.availability === 'unavailable' || item.availability === 'sold'
                              ? 'opacity-65 grayscale-[35%]'
                              : ''
                          }`}
                        />
                      ) : (
                        <div className="flex flex-col items-center justify-center gap-2 text-white">
                          <PlatformIcon id={item.platform} size={42} />
                          <span className="text-xs font-extrabold uppercase opacity-90">
                            {item.subcategory || platformDef?.name || item.platform}
                          </span>
                        </div>
                      )}

                      {item.availability !== 'active' && (
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-3 py-2 text-xs font-extrabold text-white">
                          {item.statusLabel}
                        </div>
                      )}
                    </div>

                    {/* Content */}
                    <div className="p-4 space-y-2.5">
                      <div
                        className="flex items-center justify-between gap-2 text-xs font-semibold tabular-nums"
                        style={{ color: 'var(--text-2)' }}
                      >
                        <span className="truncate">
                          {platformDef?.name || item.platform} · {item.subcategory}
                        </span>
                        <span
                          className="font-extrabold shrink-0"
                          style={{ color: getStatusColor(item.availability) }}
                        >
                          {item.statusLabel}
                        </span>
                      </div>

                      {item.canOpenListing ? (
                        <button
                          type="button"
                          onClick={() => onOpenListingById(item.listingId)}
                          className="text-left font-extrabold text-[15px] leading-snug line-clamp-2 hover:underline block"
                        >
                          {item.title}
                        </button>
                      ) : (
                        <h2
                          className="font-extrabold text-[15px] leading-snug line-clamp-2"
                          style={{ color: 'var(--text-2)' }}
                        >
                          {item.title}
                        </h2>
                      )}

                      <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
                        <button
                          type="button"
                          onClick={() => onOpenPublicProfile(item.sellerId)}
                          className="inline-flex items-center gap-1 font-bold truncate hover:underline"
                          style={{ color: 'var(--text-2)' }}
                        >
                          <span>{item.sellerName}</span>
                          {item.liveListing?.sellerVerified && (
                            <ShieldCheck
                              className="w-3.5 h-3.5 shrink-0"
                              style={{ color: 'var(--green)' }}
                            />
                          )}
                        </button>
                        <span style={{ color: 'var(--text-3)' }}>
                          Saved {formatNotificationTimestamp(item.savedAtMs)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Card Footer */}
                  <div
                    className="px-4 py-3 border-t flex items-center justify-between gap-2 flex-wrap"
                    style={{ borderColor: 'var(--border-soft)' }}
                  >
                    <strong className="text-base font-extrabold tabular-nums">
                      {formatMoneyFromMinor(
                        item.priceMinor,
                        displayCurrency,
                        item.currency,
                        usdToBdtRate
                      )}
                    </strong>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isRemoving}
                        onClick={async () => {
                          setRemovingId(item.listingId);
                          try {
                            await onRemoveFavorite(item.listingId, item.title);
                          } finally {
                            setRemovingId(null);
                          }
                        }}
                        aria-label={`Remove ${item.title} from favorites`}
                        className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>{isRemoving ? 'Removing…' : 'Remove'}</span>
                      </button>

                      {item.canOpenListing && (
                        <button
                          type="button"
                          onClick={() => onOpenListingById(item.listingId)}
                          className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap shrink-0"
                        >
                          <span>Open</span>
                          <ExternalLink className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {filteredItems.length > visibleLimit && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => setVisibleLimit((prev) => prev + 18)}
                className="bx-btn"
              >
                <span>
                  Load More ({filteredItems.length - visibleLimit} remaining)
                </span>
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
