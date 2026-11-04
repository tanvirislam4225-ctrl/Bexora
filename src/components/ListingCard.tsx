import React, { useState } from 'react';
import { Heart, Images, ShieldCheck } from 'lucide-react';
import { CurrencyCode, MarketplaceListing } from '../types';
import {
  formatAccountAge,
  formatMoneyFromMinor,
  getCategoryMetricLabel,
  PLATFORM_CATALOG,
  sanitizeSafeImageSrc,
} from '../lib/marketplaceLogic';
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

  return (
    <article
      data-testid={`listing-card-${listing.id}`}
      className={`bx-card w-full sm:max-w-[320px] overflow-hidden flex flex-col min-w-0 hover:-translate-y-0.5${className ? ` ${className}` : ''}`}
    >
      {/* Compact 4:3 Media Showcase with Zero-Broken-Image Fallback + Save to Favorites Heart */}
      <div className="relative aspect-[4/3] w-full overflow-hidden">
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
            <div className="flex flex-col items-center justify-center gap-1.5 px-2 text-center text-white">
              <PlatformIcon id={listing.platform} size={36} />
              <span className="text-[10.5px] sm:text-xs font-extrabold tracking-wide uppercase opacity-90 truncate max-w-full">
                {listing.subcategory || platformDef.name}
              </span>
            </div>
          )}
          {imageCount > 1 && (
            <span
              className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-extrabold text-white tabular-nums"
              style={{ background: 'rgba(15, 15, 20, 0.78)' }}
            >
              <Images className="w-3 h-3" />
              <span>{imageCount}</span>
            </span>
          )}
          {isReserved && (
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/65 to-transparent px-2.5 py-1.5 text-[10.5px] sm:text-[11px] font-bold text-amber-300 truncate">
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
            className="absolute top-2 right-2 z-10 w-8 h-8 sm:w-9 sm:h-9 rounded-full grid place-items-center border transition-transform hover:scale-105 active:scale-95"
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

      {/* Compact Responsive Card Body */}
      <div className="p-2.5 sm:p-3.5 flex flex-col gap-1.5 sm:gap-2 flex-1 min-w-0">
        <div
          className="flex items-center gap-1 text-[10.5px] sm:text-[11.5px] font-semibold min-w-0"
          style={{ color: 'var(--text-2)' }}
        >
          {!listing.subcategory.toLowerCase().startsWith(platformDef.name.toLowerCase()) && (
            <>
              <span className="shrink-0 hidden sm:inline">{platformDef.name}</span>
              <span aria-hidden="true" className="shrink-0 hidden sm:inline">
                ·
              </span>
            </>
          )}
          <span className="truncate">{listing.subcategory}</span>
          <span aria-hidden="true" className="shrink-0">
            ·
          </span>
          <span className="shrink-0 tabular-nums">{formatAccountAge(listing.ageYears, listing.ageMonths)}</span>
        </div>

        <button
          type="button"
          onClick={() => onOpen(listing)}
          className="text-left font-extrabold text-[13px] sm:text-[14.5px] leading-snug line-clamp-2 min-h-[2.2rem] sm:min-h-[2.5rem] hover:underline break-words"
          style={{ color: 'var(--text)' }}
        >
          {listing.title}
        </button>

        <div
          className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] sm:text-xs tabular-nums min-w-0"
          style={{ color: 'var(--text-2)' }}
        >
          {listing.platform === 'gaming' ? (
            <span className="truncate">Level {listing.gameLevel ?? listing.metricValue}</span>
          ) : (
            <span className="truncate">
              {listing.metricValue.toLocaleString('en-US')} {metricLabel.toLowerCase()}
            </span>
          )}
          {listing.monthlyRevenueMinor > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span className="truncate">
                {formatMoneyFromMinor(listing.monthlyRevenueMinor, displayCurrency, listing.currency, usdToBdtRate)}/mo
              </span>
            </>
          )}
        </div>

        <div
          className="text-[10.5px] sm:text-[11.5px] font-bold truncate"
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
          {isReserved ? 'Reserved Pending Payment' : monetizationSummary}
        </div>

        {/* Footer Baseline */}
        <div
          className="mt-auto pt-2 sm:pt-2.5 border-t flex items-center justify-between gap-1.5 min-w-0"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenSellerProfile) onOpenSellerProfile(listing.sellerId);
              else onOpen(listing);
            }}
            className="inline-flex items-center gap-1 sm:gap-1.5 min-w-0 text-left hover:underline"
            aria-label={`View seller ${listing.sellerName}`}
          >
            <span
              className="w-5 h-5 sm:w-6 sm:h-6 rounded-full grid place-items-center text-[9.5px] sm:text-[10px] font-extrabold text-white shrink-0"
              style={{ background: 'var(--purple)' }}
            >
              {initials}
            </span>
            <span className="text-[11px] sm:text-xs font-bold truncate" style={{ color: 'var(--text)' }}>
              {listing.sellerName}
            </span>
            {listing.sellerVerified && (
              <ShieldCheck
                className="w-3 h-3 sm:w-3.5 sm:h-3.5 shrink-0"
                style={{ color: 'var(--green)' }}
                aria-label="Verified Seller"
              />
            )}
          </button>

          <div className="text-right shrink-0 tabular-nums">
            {isReserved && listing.acceptedBidAmountMinor ? (
              <div className="flex flex-col items-end leading-tight">
                <span className="text-[9.5px] sm:text-[10px] line-through opacity-60" style={{ color: 'var(--text-2)' }}>
                  {formatMoneyFromMinor(listing.priceMinor, displayCurrency, listing.currency, usdToBdtRate)}
                </span>
                <span className="font-extrabold text-[12.5px] sm:text-sm" style={{ color: 'var(--orange)' }}>
                  {formatMoneyFromMinor(listing.acceptedBidAmountMinor, displayCurrency, listing.currency, usdToBdtRate)}
                </span>
              </div>
            ) : (
              <span className="font-extrabold text-[13px] sm:text-[15px]" style={{ color: 'var(--text)' }}>
                {formatMoneyFromMinor(listing.priceMinor, displayCurrency, listing.currency, usdToBdtRate)}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};
