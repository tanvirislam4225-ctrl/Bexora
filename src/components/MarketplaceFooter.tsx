import React, { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, query } from 'firebase/firestore';
import { Mail, MessageCircle, Send, ShieldCheck } from 'lucide-react';
import { db } from '../lib/firebase';
import {
  InfoTopicId,
  MarketplaceListing,
  MarketplaceLiveStats,
  PlatformId,
  PublicActivityItem,
  PublicProfile,
  PublicSettings,
  ReviewRecord,
} from '../types';
import {
  getProtectionDurationHours,
  PLATFORM_CATALOG,
  PLATFORM_LIST,
} from '../lib/marketplaceLogic';
import { computeVerifiedMarketplaceStats } from '../lib/reviewsAndStatsLogic';
import { formatRecordedTickerAmount } from '../lib/activityTickerLogic';
import { BexoraLogo } from './Icons';

export interface MarketplaceFooterProps {
  settings: PublicSettings;
  activeListings: ReadonlyArray<MarketplaceListing>;
  publicActivities: ReadonlyArray<PublicActivityItem>;
  isAuthenticated: boolean;
  isPwaInstalled: boolean;
  onTriggerPwaInstall: () => void;
  onNavigateHome: () => void;
  onBrowseMarketplace: () => void;
  onBrowseCategory: (platform: PlatformId) => void;
  onOpenTopSellers: () => void;
  onOpenFavorites: () => void;
  onOpenMyListings: () => void;
  onOpenMyBids: () => void;
  onOpenFollowing: () => void;
  onOpenSellAsset: () => void;
  onOpenRecentSearches: () => void;
  onOpenReviews: () => void;
  onOpenInfoTopic: (topic: InfoTopicId) => void;
}

export const MarketplaceFooter: React.FC<MarketplaceFooterProps> = ({
  settings,
  activeListings,
  publicActivities,
  isPwaInstalled,
  onTriggerPwaInstall,
  onNavigateHome,
  onBrowseMarketplace,
  onBrowseCategory,
  onOpenTopSellers,
  onOpenFavorites,
  onOpenMyListings,
  onOpenMyBids,
  onOpenFollowing,
  onOpenSellAsset,
  onOpenRecentSearches,
  onOpenReviews,
  onOpenInfoTopic,
}) => {
  const [profilesSample, setProfilesSample] = useState<
    Array<Pick<PublicProfile, 'nidVerified' | 'completedSales'>>
  >([]);
  const [reviewsSample, setReviewsSample] = useState<ReviewRecord[]>([]);
  const [serverStatsFallback, setServerStatsFallback] = useState<MarketplaceLiveStats | null>(null);

  useEffect(() => {
    let active = true;

    const unsubProfiles = onSnapshot(
      query(collection(db, 'publicProfiles'), limit(100)),
      (snap) => {
        if (!active) return;
        setProfilesSample(
          snap.docs.map((d) => {
            const pd = d.data();
            return {
              nidVerified: Boolean(pd.nidVerified),
              completedSales: Number(pd.completedSales || 0),
            };
          })
        );
      },
      () => {
        // Fallback handled via /api/public/marketplace-stats
      }
    );

    const unsubReviews = onSnapshot(
      query(collection(db, 'reviews'), limit(100)),
      (snap) => {
        if (!active) return;
        setReviewsSample(
          snap.docs.map((d) => {
            const rd = d.data();
            return {
              id: d.id,
              dealId: String(rd.dealId || ''),
              sellerId: String(rd.sellerId || ''),
              reviewerId: String(rd.reviewerId || ''),
              reviewerName: String(rd.reviewerName || ''),
              score: Number(rd.score || 0),
              comment: String(rd.comment || ''),
              moderationStatus: rd.moderationStatus === 'hidden' ? 'hidden' : 'published',
              createdAtMs: rd.createdAt?.toMillis ? rd.createdAt.toMillis() : Date.now(),
            };
          })
        );
      },
      () => {
        // Fallback handled via /api/public/marketplace-stats
      }
    );

    fetch('/api/public/marketplace-stats')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { ok?: boolean; stats?: MarketplaceLiveStats } | null) => {
        if (active && json?.ok && json.stats) {
          setServerStatsFallback(json.stats);
        }
      })
      .catch(() => {
        // Non-fatal
      });

    return () => {
      active = false;
      unsubProfiles();
      unsubReviews();
    };
  }, []);

  const liveStats = useMemo<MarketplaceLiveStats>(() => {
    const clientComputed = computeVerifiedMarketplaceStats({
      listings: activeListings.map((l) => ({ status: l.status })),
      publicProfiles: profilesSample,
      publicActivities: [...publicActivities],
      reviews: reviewsSample,
    });

    if (!serverStatsFallback) return clientComputed;

    return {
      activeListingsCount: Math.max(
        clientComputed.activeListingsCount,
        serverStatsFallback.activeListingsCount
      ),
      completedSalesCount: Math.max(
        clientComputed.completedSalesCount,
        serverStatsFallback.completedSalesCount
      ),
      registeredMembersCount: Math.max(
        clientComputed.registeredMembersCount,
        serverStatsFallback.registeredMembersCount
      ),
      verifiedSellersCount: Math.max(
        clientComputed.verifiedSellersCount,
        serverStatsFallback.verifiedSellersCount
      ),
      publishedReviewsCount: Math.max(
        clientComputed.publishedReviewsCount,
        serverStatsFallback.publishedReviewsCount
      ),
      averageRating:
        clientComputed.publishedReviewsCount > 0
          ? clientComputed.averageRating
          : serverStatsFallback.averageRating,
      settledVolumeBdtMinor: Math.max(
        clientComputed.settledVolumeBdtMinor,
        serverStatsFallback.settledVolumeBdtMinor
      ),
      settledVolumeUsdMinor: Math.max(
        clientComputed.settledVolumeUsdMinor,
        serverStatsFallback.settledVolumeUsdMinor
      ),
      updatedAtMs: Date.now(),
    };
  }, [activeListings, profilesSample, publicActivities, reviewsSample, serverStatsFallback]);

  const siteName = (settings.siteName || 'BEXORA').trim() || 'BEXORA';
  const tagline =
    (settings.brandTagline || '').trim() ||
    'Escrow-Protected Marketplace for Verifiable Digital Assets';

  const cleanWhatsapp = (settings.supportWhatsapp || '').trim();
  const cleanTelegram = (settings.supportTelegram || '').trim();
  const cleanEmail = (settings.supportEmail || '').trim();
  const hasConfiguredSupport = Boolean(cleanWhatsapp || cleanTelegram || cleanEmail);

  const whatsappHref = cleanWhatsapp
    ? cleanWhatsapp.startsWith('http')
      ? cleanWhatsapp
      : `https://wa.me/${cleanWhatsapp.replace(/[^\d]/g, '')}`
    : '';
  const telegramHref = cleanTelegram
    ? cleanTelegram.startsWith('http')
      ? cleanTelegram
      : `https://t.me/${cleanTelegram.replace(/^@/, '')}`
    : '';

  const currentYear = new Date().getFullYear();

  return (
    <footer
      data-testid="marketplace-footer"
      className="border-t-2 mt-14 pt-10 pb-24 lg:pb-16"
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border-strong)',
        color: 'var(--text)',
      }}
    >
      <div className="bx-wrap-wide space-y-8">
        {/* SECTION F (Top Strip): Genuine Live Marketplace Metrics */}
        <div
          className="pb-8 border-b grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <div className="space-y-0.5">
            <div className="text-xs font-bold" style={{ color: 'var(--text-2)' }}>
              Active Verified Listings
            </div>
            <div className="text-xl font-black tabular-nums">
              {liveStats.activeListingsCount.toLocaleString('en-US')}
            </div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs font-bold" style={{ color: 'var(--text-2)' }}>
              Settled Escrow Sales
            </div>
            <div className="text-xl font-black tabular-nums">
              {liveStats.completedSalesCount.toLocaleString('en-US')}
            </div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs font-bold" style={{ color: 'var(--text-2)' }}>
              NID-Verified Sellers
            </div>
            <div className="text-xl font-black tabular-nums">
              {liveStats.verifiedSellersCount.toLocaleString('en-US')}
            </div>
          </div>

          <div className="space-y-0.5">
            <div className="text-xs font-bold" style={{ color: 'var(--text-2)' }}>
              Registered Members
            </div>
            <div className="text-xl font-black tabular-nums">
              {liveStats.registeredMembersCount.toLocaleString('en-US')}
            </div>
          </div>

          <div className="space-y-0.5 col-span-2 sm:col-span-1">
            <div className="text-xs font-bold" style={{ color: 'var(--text-2)' }}>
              {liveStats.settledVolumeBdtMinor > 0 || liveStats.settledVolumeUsdMinor > 0
                ? 'Verified Settled Volume'
                : 'Verified Deal Reviews'}
            </div>
            <div className="text-xl font-black tabular-nums">
              {liveStats.settledVolumeBdtMinor > 0
                ? formatRecordedTickerAmount(liveStats.settledVolumeBdtMinor, 'BDT')
                : liveStats.settledVolumeUsdMinor > 0
                ? formatRecordedTickerAmount(liveStats.settledVolumeUsdMinor, 'USD')
                : liveStats.publishedReviewsCount > 0
                ? `${liveStats.averageRating.toFixed(1)} ★ (${liveStats.publishedReviewsCount})`
                : '0'}
            </div>
          </div>
        </div>

        {/* MAIN FOOTER COLUMNS (Sections A, B, C, D, E) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-8">
          {/* A. Brand & Marketplace Intro */}
          <div className="sm:col-span-2 lg:col-span-4 space-y-4">
            <div>
              <button
                type="button"
                onClick={onNavigateHome}
                className="text-left focus:outline-none"
                aria-label={`${siteName} Home`}
              >
                <BexoraLogo siteName={siteName} logoUrl={settings.logoUrl} />
              </button>
              <p className="text-xs font-bold mt-1.5" style={{ color: 'var(--purple)' }}>
                {tagline}
              </p>
            </div>

            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {siteName} connects buyers and sellers of monetization-ready channels, social pages, websites, domains, and gaming accounts through moderator-audited listings and wallet-backed 3-party escrow protection.
            </p>

            {/* Supported Asset Categories */}
            <div className="space-y-1.5">
              <div
                className="text-[11px] font-extrabold uppercase tracking-wider"
                style={{ color: 'var(--text-3)' }}
              >
                Supported Asset Categories
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold">
                {PLATFORM_LIST.map((pId, idx) => {
                  const plat = PLATFORM_CATALOG[pId];
                  return (
                    <React.Fragment key={pId}>
                      {idx > 0 && (
                        <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>
                          ·
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => onBrowseCategory(pId)}
                        className="hover:underline"
                        style={{ color: 'var(--text-2)' }}
                      >
                        {plat.name}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>

            <div
              className="inline-flex items-center gap-1.5 text-xs font-bold"
              style={{ color: 'var(--green)' }}
            >
              <ShieldCheck className="w-4 h-4 shrink-0" />
              <span>
                {getProtectionDurationHours('youtube')}h YouTube &amp;{' '}
                {getProtectionDurationHours('facebook')}h Standard Buyer Protection
              </span>
            </div>
          </div>

          {/* B. Marketplace Navigation */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--text)' }}>
              Marketplace
            </h2>
            <ul className="space-y-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
              <li>
                <button type="button" onClick={onBrowseMarketplace} className="hover:underline">
                  Browse Listings
                </button>
              </li>
              <li>
                <button type="button" onClick={onNavigateHome} className="hover:underline">
                  Latest Verified Listings
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenTopSellers} className="hover:underline">
                  Top Sellers
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenSellAsset} className="hover:underline">
                  Sell an Asset
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenFavorites} className="hover:underline">
                  Saved Favorites
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenMyListings} className="hover:underline">
                  My Listings
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenMyBids} className="hover:underline">
                  My Bids
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenFollowing} className="hover:underline">
                  Following Sellers
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenRecentSearches} className="hover:underline">
                  Recent Searches
                </button>
              </li>
              <li>
                <button type="button" onClick={onOpenReviews} className="hover:underline">
                  Reviews &amp; Ratings
                </button>
              </li>
            </ul>
          </div>

          {/* C. Trust, Safety & Transaction Info */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--text)' }}>
              Trust &amp; Escrow
            </h2>
            <ul className="space-y-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('how-buying-works')}
                  className="hover:underline"
                >
                  How Buying Works
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('how-selling-works')}
                  className="hover:underline"
                >
                  How Selling Works
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('escrow-protection')}
                  className="hover:underline"
                >
                  Escrow Protection
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('buyer-verification')}
                  className="hover:underline"
                >
                  Buyer Verification Guide
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('seller-guidelines')}
                  className="hover:underline"
                >
                  Seller Guidelines
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('listing-moderation')}
                  className="hover:underline"
                >
                  Listing Moderation
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('dispute-process')}
                  className="hover:underline"
                >
                  Dispute Process
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('account-security')}
                  className="hover:underline"
                >
                  Account Security
                </button>
              </li>
            </ul>
          </div>

          {/* E. Policies & Legal Info */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--text)' }}>
              Policies &amp; Legal
            </h2>
            <ul className="space-y-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('terms-of-service')}
                  className="hover:underline"
                >
                  Terms of Service
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('privacy-policy')}
                  className="hover:underline"
                >
                  Privacy Policy
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('cookie-policy')}
                  className="hover:underline"
                >
                  Cookie &amp; Storage Policy
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('refund-policy')}
                  className="hover:underline"
                >
                  Refund &amp; Cancellation Policy
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('dispute-policy')}
                  className="hover:underline"
                >
                  Dispute Resolution Policy
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('acceptable-use')}
                  className="hover:underline"
                >
                  Acceptable Use Policy
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('user-responsibilities')}
                  className="hover:underline"
                >
                  User Responsibilities
                </button>
              </li>
            </ul>
          </div>

          {/* D. Verified Support & App Access (Never fabricates unconfigured contact details) */}
          <div className="lg:col-span-2 space-y-3">
            <h2 className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--text)' }}>
              Support &amp; Help
            </h2>
            <ul className="space-y-2.5 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
              {cleanWhatsapp && (
                <li>
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 hover:underline"
                    style={{ color: 'var(--green)' }}
                  >
                    <MessageCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>WhatsApp Support</span>
                  </a>
                </li>
              )}
              {cleanTelegram && (
                <li>
                  <a
                    href={telegramHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 hover:underline"
                    style={{ color: 'var(--purple)' }}
                  >
                    <Send className="w-3.5 h-3.5 shrink-0" />
                    <span>Telegram Support</span>
                  </a>
                </li>
              )}
              {cleanEmail && (
                <li className="min-w-0">
                  <a
                    href={`mailto:${cleanEmail}`}
                    title={cleanEmail}
                    className="inline-flex items-center gap-1.5 max-w-full hover:underline"
                    style={{ color: 'var(--text)' }}
                  >
                    <Mail className="w-3.5 h-3.5 shrink-0" />
                    <span className="truncate">{cleanEmail}</span>
                  </a>
                </li>
              )}
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('dispute-process')}
                  className="hover:underline text-left"
                >
                  {hasConfiguredSupport ? 'Deal Room Dispute Center' : 'Escrow Help & Dispute Guide'}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  onClick={() => onOpenInfoTopic('buyer-verification')}
                  className="hover:underline text-left"
                >
                  Transfer Safety Checklist
                </button>
              </li>
              {!isPwaInstalled && (
                <li className="pt-1">
                  <button
                    type="button"
                    onClick={onTriggerPwaInstall}
                    className="font-extrabold hover:underline"
                    style={{ color: 'var(--orange)' }}
                  >
                    Install {siteName} App →
                  </button>
                </li>
              )}
            </ul>
          </div>
        </div>

        {/* Bottom Copyright & Escrow Disclaimer Row */}
        <div
          className="pt-6 border-t sm:pr-40 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
          style={{ borderColor: 'var(--border-soft)', color: 'var(--text-3)' }}
        >
          <p className="font-semibold">
            © {currentYear} {siteName}. All rights reserved. Escrow-protected digital asset marketplace.
          </p>
          <div className="flex flex-wrap items-center gap-3 font-semibold">
            <button
              type="button"
              onClick={() => onOpenInfoTopic('escrow-protection')}
              className="hover:underline"
            >
              Escrow Rules
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onOpenInfoTopic('privacy-policy')}
              className="hover:underline"
            >
              Privacy
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onOpenInfoTopic('terms-of-service')}
              className="hover:underline"
            >
              Terms
            </button>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              onClick={() => onOpenInfoTopic('refund-policy')}
              className="hover:underline"
            >
              Refunds
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
};
