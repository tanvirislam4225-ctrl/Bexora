import React, { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, query } from 'firebase/firestore';
import { ShieldCheck, Star, Trophy, UserCheck, UserPlus } from 'lucide-react';
import { PublicProfile } from '../types';
import { db } from '../lib/firebase';
import { canUserFollowSeller } from '../lib/engagementLogic';

interface TopSellersViewProps {
  onOpenPublicProfile: (uid: string) => void;
  viewerUid?: string | null;
  followedSellerIds?: ReadonlySet<string>;
  onToggleFollowSeller?: (seller: {
    uid: string;
    displayName: string;
    username: string;
    avatarUrl?: string;
    nidVerified: boolean;
  }) => void;
}

export const TopSellersView: React.FC<TopSellersViewProps> = ({
  onOpenPublicProfile,
  viewerUid = null,
  followedSellerIds,
  onToggleFollowSeller,
}) => {
  const [sellers, setSellers] = useState<PublicProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const q = query(collection(db, 'publicProfiles'), limit(60));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: PublicProfile[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            uid: data.uid || d.id,
            displayName: data.displayName || 'Member',
            username: data.username || 'member',
            bio: data.bio || '',
            avatarUrl: data.avatarUrl,
            location: data.location,
            nidVerified: Boolean(data.nidVerified),
            completedTrader: Boolean(data.completedTrader),
            completedSales: Number(data.completedSales || 0),
            completedPurchases: Number(data.completedPurchases || 0),
            ratingSum: Number(data.ratingSum || 0),
            ratingCount: Number(data.ratingCount || 0),
            followerCount:
              typeof data.followerCount === 'number' && Number.isFinite(data.followerCount)
                ? Math.max(0, Math.floor(data.followerCount))
                : 0,
          };
        });

        // Rank transparently by completed sales first, then verified rating average, then NID verification
        list.sort((a, b) => {
          if (b.completedSales !== a.completedSales) return b.completedSales - a.completedSales;
          const avgA = a.ratingCount > 0 ? a.ratingSum / a.ratingCount : 0;
          const avgB = b.ratingCount > 0 ? b.ratingSum / b.ratingCount : 0;
          if (avgB !== avgA) return avgB - avgA;
          return Number(b.nidVerified) - Number(a.nidVerified);
        });

        setSellers(list);
        setLoading(false);
      },
      (err) => {
        console.error('Error loading sellers directory:', err);
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b-2 border-[var(--bx-border)] pb-5">
        <div>
          <div className="inline-flex items-center gap-1.5 text-xs font-black uppercase tracking-wider px-2.5 py-1 bg-[#FFD400] text-[#191919] border border-[#191919] mb-2">
            <Trophy className="w-3.5 h-3.5" />
            Verified Seller Directory
          </div>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">Top Sellers & Verified Members</h1>
          <p className="text-sm opacity-75 mt-1">
            Ranked strictly by settled escrow transactions and authentic post-deal buyer ratings. Follow sellers to receive instant alerts when they publish new listings.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="bx-card p-10 text-center">
          <p className="text-sm font-bold opacity-75">Loading verified member directory…</p>
        </div>
      ) : sellers.length === 0 ? (
        <div className="bx-card p-10 text-center space-y-2">
          <h2 className="text-lg font-black">No registered sellers yet</h2>
          <p className="text-sm opacity-75 max-w-md mx-auto">
            BEXORA displays only real accounts and authentic transaction history. Create an account and list a digital asset to appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {sellers.map((s, idx) => {
            const hasRatings = s.ratingCount > 0;
            const avgLabel = hasRatings
              ? `${(s.ratingSum / s.ratingCount).toFixed(1)} (${s.ratingCount})`
              : 'No ratings yet';
            const isFollowing = Boolean(followedSellerIds?.has(s.uid));
            const canFollow = canUserFollowSeller(viewerUid, s.uid);
            const followerTotal = s.followerCount ?? 0;

            return (
              <article key={s.uid} className="bx-card p-5 flex flex-col justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => onOpenPublicProfile(s.uid)}
                      className="flex items-center gap-3 text-left min-w-0 hover:underline"
                    >
                      <div className="w-12 h-12 rounded-lg border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] overflow-hidden flex items-center justify-center font-black shrink-0">
                        {s.avatarUrl ? (
                          <img
                            src={s.avatarUrl}
                            alt={s.displayName}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <span>{s.displayName.slice(0, 2).toUpperCase()}</span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <h2 className="font-black text-base leading-tight truncate">{s.displayName}</h2>
                        <div className="flex items-center gap-1.5 text-xs font-bold opacity-70 min-w-0">
                          <span className="truncate">@{s.username}</span>
                          <span aria-hidden="true" className="shrink-0">·</span>
                          <span className="shrink-0 whitespace-nowrap tabular-nums">
                            {followerTotal.toLocaleString('en-US')} follower
                            {followerTotal === 1 ? '' : 's'}
                          </span>
                        </div>
                      </div>
                    </button>
                    <span className="text-xs font-black px-2 py-0.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] shrink-0">
                      #{idx + 1}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5 text-xs font-bold" style={{ color: 'var(--text-2)' }}>
                    {s.nidVerified && (
                      <span className="inline-flex items-center gap-1" style={{ color: 'var(--green)' }}>
                        <ShieldCheck className="w-3.5 h-3.5" />
                        NID Verified
                      </span>
                    )}
                    {s.nidVerified && s.completedTrader && <span aria-hidden="true">·</span>}
                    {s.completedTrader && (
                      <span className="inline-flex items-center gap-1" style={{ color: 'var(--purple)' }}>
                        <UserCheck className="w-3.5 h-3.5" />
                        Completed Trader
                      </span>
                    )}
                  </div>

                  {s.bio && <p className="text-xs opacity-80 line-clamp-2">{s.bio}</p>}
                </div>

                <div className="pt-3 border-t border-[var(--bx-border)] flex items-center justify-between gap-2 flex-wrap">
                  <div className="text-xs font-bold space-y-0.5 tabular-nums">
                    <div>Settled Sales: {s.completedSales}</div>
                    <div className="inline-flex items-center gap-1 text-[#FF6500]">
                      <Star className="w-3.5 h-3.5 fill-[#FF6500]" />
                      <span>{avgLabel}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {onToggleFollowSeller && canFollow && (
                      <button
                        type="button"
                        onClick={() =>
                          onToggleFollowSeller({
                            uid: s.uid,
                            displayName: s.displayName,
                            username: s.username,
                            avatarUrl: s.avatarUrl,
                            nidVerified: s.nidVerified,
                          })
                        }
                        aria-pressed={isFollowing}
                        aria-label={
                          isFollowing
                            ? `Unfollow seller ${s.displayName}`
                            : `Follow seller ${s.displayName}`
                        }
                        className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                        style={
                          isFollowing
                            ? {
                                background: 'var(--surface)',
                                borderColor: 'var(--green)',
                                color: 'var(--green)',
                              }
                            : undefined
                        }
                      >
                        {isFollowing ? (
                          <UserCheck className="w-3.5 h-3.5" />
                        ) : (
                          <UserPlus className="w-3.5 h-3.5" />
                        )}
                        <span>{isFollowing ? 'Following' : 'Follow'}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onOpenPublicProfile(s.uid)}
                      className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold whitespace-nowrap shrink-0"
                    >
                      View Profile
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};

