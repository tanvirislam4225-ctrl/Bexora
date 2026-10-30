import React, { useEffect, useState } from 'react';
import { collection, getDocs, limit, query } from 'firebase/firestore';
import { ShieldCheck, Star, Trophy, UserCheck } from 'lucide-react';
import { PublicProfile } from '../types';
import { db } from '../lib/firebase';

interface TopSellersViewProps {
  onOpenPublicProfile: (uid: string) => void;
}

export const TopSellersView: React.FC<TopSellersViewProps> = ({ onOpenPublicProfile }) => {
  const [sellers, setSellers] = useState<PublicProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    async function loadSellers() {
      setLoading(true);
      try {
        const snap = await getDocs(query(collection(db, 'publicProfiles'), limit(60)));
        if (!active) return;
        const list: PublicProfile[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            uid: data.uid,
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
      } catch (err) {
        console.error('Error loading sellers directory:', err);
      } finally {
        if (active) setLoading(false);
      }
    }
    loadSellers();
    return () => {
      active = false;
    };
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
            Ranked strictly by settled escrow transactions and authentic post-deal buyer ratings. New accounts start with no ratings.
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
            return (
              <article key={s.uid} className="bx-card p-5 flex flex-col justify-between gap-4">
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-lg border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] overflow-hidden flex items-center justify-center font-black shrink-0">
                        {s.avatarUrl ? (
                          <img src={s.avatarUrl} alt={s.displayName} className="w-full h-full object-cover" />
                        ) : (
                          <span>{s.displayName.slice(0, 2).toUpperCase()}</span>
                        )}
                      </div>
                      <div>
                        <h2 className="font-black text-base leading-tight">{s.displayName}</h2>
                        <p className="text-xs font-bold opacity-70">@{s.username}</p>
                      </div>
                    </div>
                    <span className="text-xs font-black px-2 py-0.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                      #{idx + 1}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {s.nidVerified && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-extrabold px-2 py-0.5 bg-emerald-600 text-white border border-black">
                        <ShieldCheck className="w-3 h-3" />
                        NID Verified
                      </span>
                    )}
                    {s.completedTrader && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-extrabold px-2 py-0.5 bg-[#793A91] text-white border border-black">
                        <UserCheck className="w-3 h-3" />
                        Completed Trader
                      </span>
                    )}
                  </div>

                  {s.bio && <p className="text-xs opacity-80 line-clamp-2">{s.bio}</p>}
                </div>

                <div className="pt-3 border-t border-[var(--bx-border)] flex items-center justify-between">
                  <div className="text-xs font-bold space-y-0.5">
                    <div>Settled Sales: {s.completedSales}</div>
                    <div className="inline-flex items-center gap-1 text-[#FF6500]">
                      <Star className="w-3.5 h-3.5 fill-[#FF6500]" />
                      <span>{avgLabel}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => onOpenPublicProfile(s.uid)}
                    className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold"
                  >
                    View Profile
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
};
