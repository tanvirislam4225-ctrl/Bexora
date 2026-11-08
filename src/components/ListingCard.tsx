import React, { useState } from 'react';
import { Eye, Heart, Images, ShieldCheck } from 'lucide-react';
import { CurrencyCode, MarketplaceListing } from '../types';
import {
  formatAccountAge,
  formatMoneyFromMinor,
  getCategoryMetricLabel,
  PLATFORM_CATALOG,
  sanitizeSafeImageSrc,
} from '../lib/marketplaceLogic';
import { formatListingPublishedTime, formatViewCount } from '../lib/viewCountLogic';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface ListingCardProps {
  listing: MarketplaceListing;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpen: (l: MarketplaceListing) => void;
  onOpenSellerProfile?: (sellerId: string) => void;
  isFavorited?: boolean;
  onToggleFavorite?: (l: MarketplaceListing) => void;
  className?: string;
  style?: React.CSSProperties;
}

export const ListingCard: React.FC<ListingCardProps> = ({
  listing,
  displayCurrency,
  usdToBdtRate,
  onOpen,
  onOpenSellerProfile,
  isFavorited = false,
  onToggleFavorite,
  className,
  style,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const platformDef = PLATFORM_CATALOG[listing.platform];
  const metricLabel = getCategoryMetricLabel(listing.platform, listing.subcategory);
  const imageCount = Array.isArray(listing.images) ? listing.images.length : 0;
  const safeCoverSrc = imageCount > 0 ? sanitizeSafeImageSrc(listing.images[0]) : '';
  const hasImage = Boolean(safeCoverSrc) && !imgFailed;

  const isVerifiedMonetization = listing.verifiedOptions.length > 0;
  const monetizationSummary =
    listing.platform === 'gaming'
      ? `${listing.gameName || 'Game'} · UID ${listing.gameUid || '—'}`
      : listing.monetizationStatus === 'non-monetized'
      ? 'Non-Monetized'
      : listing.monetizationStatus === 'not_applicable'
      ? listing.subcategory
      : isVerifiedMonetization
      ? `Active — Verified (${listing.verifiedOptions.length})`
      : `Seller Claimed (${listing.claimedOptions.length})`;

  const initials = (listing.sellerName || 'S')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const isReserved = listing.status === 'reserved';
  const publishedTimeAgo = formatListingPublishedTime(listing.firstPublishedAtMs || listing.createdAtMs);
  const formattedViews = formatViewCount(listing.views || 0);

  return (
    <article
      data-testid={`listing-card-${listing.id}`}
      style={style}
      className={`bx-card w-full sm:max-w-[320px] rounded-[16px] sm:rounded-2xl overflow-hidden flex flex-col min-w-0 hover:-translate-y-0.5 transition-transform duration-150${
        className ? ` ${className}` : ''
      }`}
    >
      {/* 1. Asset Media Showcase (16:9 on mobile reference ~358x201px, 4:3 on desktop/tablet) */}
      <div className="relative aspect-[16/9] sm:aspect-[4/3] w-full overflow-hidden bg-black/10">
        <button
          type="button"
          onClick={() => onOpen(listing)}
          className="w-full h-full flex items-center justify-center text-left"
          style={{ background: PLATFORM_BANNER_BG[listing.platform] }}
          aria-label={`Open listing ${listing.title}`}
        >
          {hasImage ? (
            <img
              src={safeCoverSrc}
              alt={listing.title}
              referrerPolicy="no-referrer"
              onError={() => setImgFailed(true)}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-1.5 px-3 text-center text-white">
              <PlatformIcon id={listing.platform} size={40} />
              <span className="text-xs sm:text-xs font-extrabold tracking-wide uppercase opacity-95 truncate max-w-full">
                {listing.subcategory || platformDef.name}
              </span>
            </div>
          )}
          {imageCount > 1 && (
            <span
              className="absolute bottom-2.5 left-2.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] font-extrabold text-white tabular-nums shadow-sm"
              style={{ background: 'rgba(15, 15, 20, 0.82)' }}
            >
              <Images className="w-3 h-3" />
              <span>{imageCount}</span>
            </span>
          )}
          {isReserved && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/70 to-transparent px-3 py-1.5 text-xs font-bold text-amber-300 truncate">
              Reserved — Pending Payment
            </div>
          )}
        </button>

        {onToggleFavorite && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(listing);
            }}
            aria-label={
              isFavorited
                ? `Remove ${listing.title} from favorites`
                : `Save ${listing.title} to favorites`
            }
            aria-pressed={isFavorited}
            title={isFavorited ? 'Saved in Favorites — click to remove' : 'Save to Favorites'}
            className="absolute top-2.5 right-2.5 z-10 w-8 h-8 sm:w-9 sm:h-9 rounded-full grid place-items-center border shadow-sm transition-transform hover:scale-105 active:scale-95"
            style={{
              background: isFavorited ? '#FFE4E6' : 'rgba(18, 18, 22, 0.72)',
              borderColor: isFavorited ? '#E11D48' : 'rgba(255, 255, 255, 0.28)',
              color: isFavorited ? '#E11D48' : '#FFFFFF',
            }}
          >
            <Heart className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${isFavorited ? 'fill-current' : ''}`} />
          </button>
        )}
      </div>

      {/* Card Content Body: 14-16px padding on mobile, compact on tablet/desktop */}
      <div className="p-4 sm:p-3.5 flex flex-col gap-2 flex-1 min-w-0">
        {/* 2 & 3 & 4. Status Badge, Category & Publication Time */}
        <div className="flex flex-wrap items-center justify-between gap-1.5 min-w-0">
          <div
            className="text-[11px] sm:text-[11px] font-extrabold uppercase tracking-wide truncate"
            style={{
              color: isReserved
                ? 'var(--orange)'
                : isVerifiedMonetization
                ? 'var(--green)'
                : listing.monetizationStatus === 'monetized'
                ? 'var(--orange)'
                : 'var(--text-3)',
            }}
          >
            {isReserved ? 'Reserved' : monetizationSummary}
          </div>

          <div
            className="flex items-center gap-1.5 text-[11px] sm:text-[11px] font-semibold shrink-0 tabular-nums"
            style={{ color: 'var(--text-3)' }}
          >
            <span>{publishedTimeAgo}</span>
            <span aria-hidden="true">·</span>
            <span>{formatAccountAge(listing.ageYears, listing.ageMonths)}</span>
          </div>
        </div>

        {/* Category breadcrumb (compact) */}
        <div
          className="text-[11px] sm:text-[11.5px] font-bold truncate -mt-0.5"
          style={{ color: 'var(--orange)' }}
        >
          {platformDef.name} · {listing.subcategory}
        </div>

        {/* 5. Asset Title (17-19px on mobile, natural line wrapping) */}
        <button
          type="button"
          onClick={() => onOpen(listing)}
          className="text-left font-extrabold text-[17.5px] sm:text-[14px] leading-snug line-clamp-2 min-h-[2.4rem] sm:min-h-[2.3rem] hover:underline break-words"
          style={{ color: 'var(--text)' }}
        >
          {listing.title}
        </button>

        {/* 6. Metrics (Followers / Subscribers / Level & Revenue) */}
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs sm:text-[11.5px] tabular-nums min-w-0"
          style={{ color: 'var(--text-2)' }}
        >
          {listing.platform === 'gaming' ? (
            <span className="font-semibold truncate">Level {listing.gameLevel ?? listing.metricValue}</span>
          ) : (
            <span className="font-semibold truncate">
              {listing.metricValue.toLocaleString('en-US')} {metricLabel.toLowerCase()}
            </span>
          )}
          {listing.monthlyRevenueMinor > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="font-semibold truncate text-[var(--green)]">
                {formatMoneyFromMinor(listing.monthlyRevenueMinor, displayCurrency, listing.currency, usdToBdtRate)}/mo
              </span>
            </>
          )}
        </div>

        {/* 7. Price in BDT / active currency (25-30px bold on mobile) */}
        <div className="pt-1 min-w-0">
          {isReserved && listing.acceptedBidAmountMinor ? (
            <div className="flex items-baseline gap-2 leading-none">
              <span className="font-black text-[24px] sm:text-[15px] tabular-nums" style={{ color: 'var(--orange)' }}>
                {formatMoneyFromMinor(listing.acceptedBidAmountMinor, displayCurrency, listing.currency, usdToBdtRate)}
              </span>
              <span className="text-xs line-through opacity-60 tabular-nums" style={{ color: 'var(--text-3)' }}>
                {formatMoneyFromMinor(listing.priceMinor, displayCurrency, listing.currency, usdToBdtRate)}
              </span>
            </div>
          ) : (
            <div
              className="font-black text-[25px] sm:text-[16px] leading-tight tabular-nums tracking-tight"
              style={{ color: 'var(--text)' }}
            >
              {formatMoneyFromMinor(listing.priceMinor, displayCurrency, listing.currency, usdToBdtRate)}
            </div>
          )}
        </div>

        {/* 8 & 9. Seller Profile Name & Eye Icon with Real-Time View Count */}
        <div
          className="mt-auto pt-2.5 border-t flex items-center justify-between gap-2 min-w-0"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          {/* 8. Seller Profile */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenSellerProfile) onOpenSellerProfile(listing.sellerId);
              else onOpen(listing);
            }}
            className="inline-flex items-center gap-1.5 min-w-0 text-left hover:underline"
            aria-label={`View seller ${listing.sellerName}`}
          >
            <span
              className="w-5 h-5 sm:w-5 sm:h-5 rounded-full grid place-items-center text-[9.5px] font-extrabold text-white shrink-0"
              style={{ background: 'var(--purple)' }}
            >
              {initials}
            </span>
            <span className="text-xs sm:text-[11.5px] font-bold truncate" style={{ color: 'var(--text)' }}>
              {listing.sellerName}
            </span>
            {listing.sellerVerified && (
              <ShieldCheck
                className="w-3.5 h-3.5 shrink-0"
                style={{ color: 'var(--green)' }}
                aria-label="Verified Seller"
              />
            )}
          </button>

          {/* 9. Real-Time View Count with Eye Icon */}
          <div
            className="inline-flex items-center gap-1 text-[13px] sm:text-[11.5px] font-semibold tabular-nums shrink-0"
            style={{ color: 'var(--text-2)' }}
            title={`Asset viewed ${formattedViews}`}
          >
            <Eye className="w-3.5 h-3.5 sm:w-3 sm:h-3 text-[var(--orange)] shrink-0" />
            <span>{formattedViews}</span>
          </div>
        </div>

        {/* 10. Full-width View Details button on mobile (<768px), hidden on desktop/tablet */}
        <button
          type="button"
          onClick={() => onOpen(listing)}
          className="w-full bx-btn bx-btn-primary py-2.5 text-xs sm:hidden font-extrabold flex items-center justify-center gap-1.5 mt-1"
          aria-label={`View full details of ${listing.title}`}
        >
          <span>View Details</span>
        </button>
      </div>
    </article>
  );
};

