import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { CurrencyCode, MarketplaceListing } from '../types';
import {
  formatAccountAge,
  formatMoneyFromMinor,
  getCategoryMetricLabel,
  PLATFORM_CATALOG,
} from '../lib/marketplaceLogic';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface ListingCardProps {
  listing: MarketplaceListing;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpen: (l: MarketplaceListing) => void;
  onOpenSellerProfile?: (sellerId: string) => void;
}

export const ListingCard: React.FC<ListingCardProps> = ({
  listing,
  displayCurrency,
  usdToBdtRate,
  onOpen,
  onOpenSellerProfile,
}) => {
  const [imgFailed, setImgFailed] = useState(false);
  const platformDef = PLATFORM_CATALOG[listing.platform];
  const metricLabel = getCategoryMetricLabel(listing.platform, listing.subcategory);
  const hasImage = listing.images && listing.images.length > 0 && !imgFailed;

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
    <article className="bx-card overflow-hidden flex flex-col min-w-0 hover:-translate-y-0.5">
      {/* 16:10 Media Showcase with Zero-Broken-Image Resilient Fallback */}
      <button
        type="button"
        onClick={() => onOpen(listing)}
        className="relative aspect-[16/10] w-full overflow-hidden flex items-center justify-center text-left"
        style={{ background: PLATFORM_BANNER_BG[listing.platform] }}
        aria-label={`Open listing ${listing.title}`}
      >
        {hasImage ? (
          <img
            src={listing.images[0]}
            alt={listing.title}
            referrerPolicy="no-referrer"
            onError={() => setImgFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 text-white">
            <PlatformIcon id={listing.platform} size={44} />
            <span className="text-xs font-extrabold tracking-wide uppercase opacity-90">
              {listing.subcategory || platformDef.name}
            </span>
          </div>
        )}
        {isReserved && (
          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/65 to-transparent px-3 py-2 text-[11px] font-bold text-amber-300">
            Reserved — Pending Buyer Payment
          </div>
        )}
      </button>

      {/* Card Body — Clean Unboxed Metadata Discipline */}
      <div className="p-4 flex flex-col gap-2.5 flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-semibold truncate" style={{ color: 'var(--text-2)' }}>
          <span>{platformDef.name}</span>
          <span aria-hidden="true">·</span>
          <span>{listing.subcategory}</span>
          <span aria-hidden="true">·</span>
          <span>{formatAccountAge(listing.ageYears, listing.ageMonths)}</span>
        </div>

        <button
          type="button"
          onClick={() => onOpen(listing)}
          className="text-left font-extrabold text-[15px] leading-snug line-clamp-2 hover:underline"
          style={{ color: 'var(--text)' }}
        >
          {listing.title}
        </button>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums" style={{ color: 'var(--text-2)' }}>
          {listing.platform === 'gaming' ? (
            <span>Level {listing.gameLevel ?? listing.metricValue}</span>
          ) : (
            <span>
              {listing.metricValue.toLocaleString('en-US')} {metricLabel.toLowerCase()}
            </span>
          )}
          {listing.monthlyRevenueMinor > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {formatMoneyFromMinor(listing.monthlyRevenueMinor, displayCurrency, listing.currency, usdToBdtRate)}/mo
              </span>
            </>
          )}
        </div>

        <div
          className="text-xs font-bold truncate"
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
          {isReserved ? 'Bid Accepted · Reserved Pending Payment' : monetizationSummary}
        </div>

        {/* Footer Baseline */}
        <div
          className="mt-auto pt-3 border-t flex items-center justify-between gap-2"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (onOpenSellerProfile) onOpenSellerProfile(listing.sellerId);
              else onOpen(listing);
            }}
            className="inline-flex items-center gap-2 min-w-0 text-left hover:underline"
            aria-label={`View seller ${listing.sellerName}`}
          >
            <span
              className="w-6 h-6 rounded-full grid place-items-center text-[10px] font-extrabold text-white shrink-0"
              style={{ background: 'var(--purple)' }}
            >
              {initials}
            </span>
            <span className="text-xs font-bold truncate" style={{ color: 'var(--text)' }}>
              {listing.sellerName}
            </span>
            {listing.sellerVerified && (
              <ShieldCheck className="w-3.5 h-3.5 shrink-0" style={{ color: 'var(--green)' }} aria-label="Verified Seller" />
            )}
          </button>

          <div className="text-right shrink-0 tabular-nums">
            {isReserved && listing.acceptedBidAmountMinor ? (
              <div className="flex flex-col items-end leading-tight">
                <span className="text-[10px] line-through opacity-60" style={{ color: 'var(--text-2)' }}>
                  {formatMoneyFromMinor(listing.priceMinor, displayCurrency, listing.currency, usdToBdtRate)}
                </span>
                <span className="font-extrabold text-sm" style={{ color: 'var(--orange)' }}>
                  {formatMoneyFromMinor(listing.acceptedBidAmountMinor, displayCurrency, listing.currency, usdToBdtRate)}
                </span>
              </div>
            ) : (
              <span className="font-extrabold text-base" style={{ color: 'var(--text)' }}>
                {formatMoneyFromMinor(listing.priceMinor, displayCurrency, listing.currency, usdToBdtRate)}
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
};
