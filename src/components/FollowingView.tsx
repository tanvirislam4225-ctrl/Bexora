import React, { useEffect, useMemo, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import {
  ArrowRight,
  Bell,
  ExternalLink,
  ShieldCheck,
  Star,
  Trophy,
  UserCheck,
  UserMinus,
} from 'lucide-react';
import type {
  CurrencyCode,
  MarketplaceListing,
  PublicProfile,
  SellerFollowRecord,
} from '../types';
import { db } from '../lib/firebase';
import { formatNotificationTimestamp } from '../lib/notificationLogic';
import { ListingCard } from './ListingCard';

interface FollowingViewProps {
  userUid: string | null;
  follows: ReadonlyArray<SellerFollowRecord>;
  liveListings: ReadonlyArray<MarketplaceListing>;
  favoriteListingIds: ReadonlySet<string>;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpenPublicProfile: (sellerUid: string) => void;
  onUnfollowSeller: (sellerUid: string, sellerName: string) => Promise<void>;
  onOpenListing: (listing: MarketplaceListing) => void;
  onToggleFavorite: (listing: MarketplaceListing) => void;
  onExploreTopSellers: () => void;
  onRequireAuth: () => void;
}

export const FollowingView: React.FC<FollowingViewProps> = ({
  userUid,
  follows,
  liveListings,
  favoriteListingIds,
  displayCurrency,
  usdToBdtRate,
  onOpenPublicProfile,
  onUnfollowSeller,
  onOpenListing,
  onToggleFavorite,
  onExploreTopSellers,
  onRequireAuth,
}) => {
  const [sellerProfilesMap, setSellerProfilesMap] = useState<Map<string, PublicProfile>>(
    () => new Map()
  );
  const [unfollowingUid, setUnfollowingUid] = useState<string | null>(null);
  const [failedAvatars, setFailedAvatars] = useState<Record<string, boolean>>({});

  // Hydrate live publicProfiles for followed sellers so followerCount, ratings, and settled sales stay fresh
  useEffect(() => {
    if (!userUid || follows.length === 0) return;
    const missingUids = follows
      .map((f) => f.sellerId)
      .filter((uid) => Boolean(uid) && !sellerProfilesMap.has(uid));
    if (missingUids.length === 0) return;

    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        missingUids.slice(0, 60).map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, 'publicProfiles', uid));
            if (snap.exists()) {
              const d = snap.data() as PublicProfile;
              return [uid, { ...d, uid: d.uid || snap.id }] as const;
            }
          } catch {
            // Fall back to SellerFollowRecord snapshot fields
          }
          return null;
        })
      );
      if (cancelled) return;
      setSellerProfilesMap((prev) => {
        const next = new Map(prev);
        for (const pair of entries) {
          if (pair) next.set(pair[0], pair[1]);
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [userUid, follows, sellerProfilesMap]);

  const sortedFollows = useMemo(
    () =>
      [...follows].sort(
        (a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0)
      ),
    [follows]
  );

  const followedSet = useMemo(
    () => new Set(follows.map((f) => f.sellerId)),
    [follows]
  );

  const activeListingsBySeller = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of liveListings) {
      if (l.status === 'active' && followedSet.has(l.sellerId)) {
        counts.set(l.sellerId, (counts.get(l.sellerId) || 0) + 1);
      }
    }
    return counts;
  }, [liveListings, followedSet]);

  const recentFollowedSellerListings = useMemo(() => {
    if (followedSet.size === 0) return [];
    return liveListings
      .filter((l) => l.status === 'active' && followedSet.has(l.sellerId))
      .sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0))
      .slice(0, 9);
  }, [liveListings, followedSet]);

  if (!userUid) {
    return (
      <section className="bx-wrap py-12">
        <div className="bx-card max-w-xl mx-auto p-8 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--orange-soft)', color: 'var(--orange)' }}
          >
            <UserCheck className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-black">Followed Sellers</h1>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Sign in to follow verified sellers on BEXORA and receive instant notifications whenever they publish new marketplace listings.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button type="button" onClick={onRequireAuth} className="bx-btn bx-btn-primary">
              <span>Sign In to View Following</span>
              <ArrowRight className="w-4 h-4" />
            </button>
            <button type="button" onClick={onExploreTopSellers} className="bx-btn">
              <span>Explore Top Sellers</span>
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="bx-wrap py-8 space-y-8" aria-label="Followed Sellers">
      {/* Header */}
      <div
        className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div>
          <p className="bx-eyebrow mb-1">Seller Subscriptions & Instant Alerts</p>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
            Following ({sortedFollows.length})
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
            You automatically receive an in-app and Web Push notification whenever a seller you follow publishes a newly approved listing.
          </p>
        </div>

        <button
          type="button"
          onClick={onExploreTopSellers}
          className="bx-btn bx-btn-sm self-start sm:self-auto whitespace-nowrap shrink-0"
        >
          <Trophy className="w-4 h-4" />
          <span>Discover Top Sellers</span>
        </button>
      </div>

      {/* Empty State */}
      {sortedFollows.length === 0 ? (
        <div className="bx-card p-10 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--surface-2)', color: 'var(--orange)' }}
          >
            <Bell className="w-6 h-6" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <h2 className="text-lg font-extrabold">You aren&apos;t following any sellers yet</h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Follow trusted sellers from Top Sellers, public profiles, or any listing page to get notified immediately when they publish new assets.
            </p>
          </div>
          <button type="button" onClick={onExploreTopSellers} className="bx-btn bx-btn-primary">
            <Trophy className="w-4 h-4" />
            <span>Browse Top Sellers</span>
          </button>
        </div>
      ) : (
        <>
          {/* Followed Sellers Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {sortedFollows.map((follow) => {
              const liveProf = sellerProfilesMap.get(follow.sellerId);
              const displayName = liveProf?.displayName || follow.sellerName || 'Seller';
              const username = liveProf?.username || follow.sellerUsername || 'seller';
              const avatarUrl = liveProf?.avatarUrl || follow.sellerAvatarUrl;
              const nidVerified = Boolean(liveProf?.nidVerified ?? follow.sellerVerified);
              const completedSales = Number(liveProf?.completedSales ?? 0);
              const ratingCount = Number(liveProf?.ratingCount ?? 0);
              const ratingSum = Number(liveProf?.ratingSum ?? 0);
              const followerCount =
                typeof liveProf?.followerCount === 'number'
                  ? Math.max(0, liveProf.followerCount)
                  : 1;
              const activeCount = activeListingsBySeller.get(follow.sellerId) || 0;
              const isBusy = unfollowingUid === follow.sellerId;

              return (
                <article
                  key={follow.id}
                  className="bx-card p-5 flex flex-col justify-between gap-4"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        onClick={() => onOpenPublicProfile(follow.sellerId)}
                        className="flex items-center gap-3 text-left min-w-0 hover:underline"
                      >
                        <div
                          className="w-12 h-12 rounded-xl overflow-hidden grid place-items-center font-extrabold text-sm text-white shrink-0"
                          style={{ background: 'var(--purple)' }}
                        >
                          {avatarUrl && !failedAvatars[follow.id] ? (
                            <img
                              src={avatarUrl}
                              alt={displayName}
                              referrerPolicy="no-referrer"
                              onError={() =>
                                setFailedAvatars((prev) => ({ ...prev, [follow.id]: true }))
                              }
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <span>{displayName.slice(0, 2).toUpperCase()}</span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <h2 className="font-black text-base leading-tight truncate">
                              {displayName}
                            </h2>
                            {nidVerified && (
                              <ShieldCheck
                                className="w-4 h-4 shrink-0"
                                style={{ color: 'var(--green)' }}
                                aria-label="NID Verified"
                              />
                            )}
                          </div>
                          <p className="text-xs font-semibold truncate" style={{ color: 'var(--text-2)' }}>
                            @{username} · Followed {formatNotificationTimestamp(follow.createdAtMs)}
                          </p>
                        </div>
                      </button>
                    </div>

                    <div
                      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tabular-nums"
                      style={{ color: 'var(--text-2)' }}
                    >
                      <span>{followerCount.toLocaleString('en-US')} followers</span>
                      <span aria-hidden="true">·</span>
                      <span>{completedSales} settled sales</span>
                      <span aria-hidden="true">·</span>
                      <span>{activeCount} active listings</span>
                      {ratingCount > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="inline-flex items-center gap-1" style={{ color: 'var(--orange)' }}>
                            <Star className="w-3 h-3 fill-current" />
                            {(ratingSum / ratingCount).toFixed(1)} ({ratingCount})
                          </span>
                        </>
                      )}
                    </div>

                    {liveProf?.bio && (
                      <p className="text-xs line-clamp-2" style={{ color: 'var(--text-2)' }}>
                        {liveProf.bio}
                      </p>
                    )}
                  </div>

                  <div
                    className="pt-3 border-t flex items-center justify-between gap-2 flex-wrap"
                    style={{ borderColor: 'var(--border-soft)' }}
                  >
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={async () => {
                        setUnfollowingUid(follow.sellerId);
                        try {
                          await onUnfollowSeller(follow.sellerId, displayName);
                        } finally {
                          setUnfollowingUid(null);
                        }
                      }}
                      aria-label={`Unfollow ${displayName}`}
                      className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                    >
                      <UserMinus className="w-3.5 h-3.5" />
                      <span>{isBusy ? 'Updating…' : 'Unfollow'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onOpenPublicProfile(follow.sellerId)}
                      className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap shrink-0"
                    >
                      <span>Visit Profile</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {/* Recent Active Listings from Followed Sellers */}
          <div className="space-y-4 pt-2">
            <div
              className="pb-3 border-b flex items-center justify-between gap-3"
              style={{ borderColor: 'var(--border-soft)' }}
            >
              <div>
                <h2 className="text-lg sm:text-xl font-black">
                  Recent Active Listings from Followed Sellers
                </h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-2)' }}>
                  Live marketplace inventory published by the sellers you follow.
                </p>
              </div>
            </div>

            {recentFollowedSellerListings.length === 0 ? (
              <div className="bx-card p-6 text-center">
                <p className="text-sm font-semibold" style={{ color: 'var(--text-2)' }}>
                  None of your followed sellers currently have active listings on the marketplace. You&apos;ll be notified as soon as they publish a new asset.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                {recentFollowedSellerListings.map((listing) => (
                  <ListingCard
                    key={listing.id}
                    listing={listing}
                    displayCurrency={displayCurrency}
                    usdToBdtRate={usdToBdtRate}
                    onOpen={onOpenListing}
                    onOpenSellerProfile={onOpenPublicProfile}
                    isFavorited={favoriteListingIds.has(listing.id)}
                    onToggleFavorite={onToggleFavorite}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};
