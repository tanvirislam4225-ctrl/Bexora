import React, { useEffect, useMemo, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import {
  ArrowRight,
  CreditCard,
  ExternalLink,
  Gavel,
  LayoutGrid,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type {
  BidRecord,
  CurrencyCode,
  DealRecord,
  MarketplaceListing,
} from '../types';
import { db, extractUserFacingFirestoreError, handleFirestoreError, OperationType } from '../lib/firebase';
import {
  classifyUserBidEntry,
  filterClassifiedBids,
  MyBidsFilterTab,
} from '../lib/engagementLogic';
import {
  fetchSpecificListingsByIds,
  withdrawPendingBidInFirestore,
} from '../lib/engagementService';
import { formatMoneyFromMinor, PLATFORM_CATALOG } from '../lib/marketplaceLogic';
import { formatNotificationExactDateTime } from '../lib/notificationLogic';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface MyBidsViewProps {
  userUid: string | null;
  liveListings: ReadonlyArray<MarketplaceListing>;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpenListingById: (listingId: string) => void;
  onOpenPublicProfile: (sellerId: string) => void;
  onOpenDealRoom: (dealId: string) => void;
  onStartDealCheckout: (dealId: string, listingTitle: string) => void;
  onBrowseMarketplace: () => void;
  onRequireAuth: () => void;
  onFlash: (msg: string) => void;
}

export const MyBidsView: React.FC<MyBidsViewProps> = ({
  userUid,
  liveListings,
  displayCurrency,
  usdToBdtRate,
  onOpenListingById,
  onOpenPublicProfile,
  onOpenDealRoom,
  onStartDealCheckout,
  onBrowseMarketplace,
  onRequireAuth,
  onFlash,
}) => {
  const [bids, setBids] = useState<BidRecord[]>([]);
  const [dealsById, setDealsById] = useState<Map<string, DealRecord>>(() => new Map());
  const [dealsByAcceptedBidId, setDealsByAcceptedBidId] = useState<Map<string, DealRecord>>(
    () => new Map()
  );
  const [extraListingsMap, setExtraListingsMap] = useState<Map<string, MarketplaceListing>>(
    () => new Map()
  );
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<MyBidsFilterTab>('all');
  const [confirmWithdrawId, setConfirmWithdrawId] = useState<string | null>(null);
  const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
  const [visibleLimit, setVisibleLimit] = useState(20);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!userUid) {
      setBids([]);
      setDealsById(new Map());
      setDealsByAcceptedBidId(new Map());
      setLoading(false);
      return;
    }

    setLoading(true);
    const bidsQuery = query(collection(db, 'bids'), where('buyerId', '==', userUid));
    const dealsQuery = query(collection(db, 'deals'), where('buyerId', '==', userUid));

    const unsubBids = onSnapshot(
      bidsQuery,
      (snap) => {
        const list: BidRecord[] = snap.docs.map((d) => {
          const raw = d.data();
          const tsMs =
            typeof raw.createdAtMs === 'number'
              ? raw.createdAtMs
              : raw.createdAt?.toMillis?.() || 0;
          return {
            ...(raw as Omit<BidRecord, 'id' | 'createdAtMs'>),
            id: d.id,
            createdAtMs: tsMs,
          };
        });
        setBids(list);
        setLoading(false);
      },
      (err) => {
        setLoading(false);
        handleFirestoreError(err, OperationType.LIST, 'bids');
      }
    );

    const unsubDeals = onSnapshot(
      dealsQuery,
      (snap) => {
        const byId = new Map<string, DealRecord>();
        const byBid = new Map<string, DealRecord>();
        snap.docs.forEach((d) => {
          const raw = d.data();
          const createdAtMs =
            typeof raw.createdAtMs === 'number'
              ? raw.createdAtMs
              : raw.createdAt?.toMillis?.() || 0;
          const record: DealRecord = {
            ...(raw as Omit<DealRecord, 'id' | 'createdAtMs'>),
            id: d.id,
            createdAtMs,
          };
          byId.set(record.id, record);
          if (record.acceptedBidId) {
            byBid.set(record.acceptedBidId, record);
          }
        });
        setDealsById(byId);
        setDealsByAcceptedBidId(byBid);
      },
      (err) => {
        console.warn('[BEXORA MyBids] Deal lookup warning:', err);
      }
    );

    return () => {
      unsubBids();
      unsubDeals();
    };
  }, [userUid]);

  const liveMap = useMemo(() => {
    const m = new Map<string, MarketplaceListing>();
    for (const item of liveListings) {
      m.set(item.id, item);
    }
    return m;
  }, [liveListings]);

  // Incrementally load any referenced listings that aren't in the live active/reserved feed
  useEffect(() => {
    if (!userUid || bids.length === 0) return;
    const missing = bids
      .map((b) => b.listingId)
      .filter((id) => Boolean(id) && !liveMap.has(id) && !extraListingsMap.has(id));
    if (missing.length === 0) return;

    let cancelled = false;
    void (async () => {
      const fetched = await fetchSpecificListingsByIds(missing);
      if (cancelled || fetched.size === 0) return;
      setExtraListingsMap((prev) => {
        const next = new Map(prev);
        fetched.forEach((v, k) => next.set(k, v));
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [userUid, bids, liveMap, extraListingsMap]);

  const classifiedEntries = useMemo(() => {
    return bids.map((bid) => {
      const listing = liveMap.get(bid.listingId) || extraListingsMap.get(bid.listingId) || null;
      const deal =
        (bid.dealId ? dealsById.get(bid.dealId) : undefined) ||
        dealsByAcceptedBidId.get(bid.id) ||
        null;
      return classifyUserBidEntry(bid, listing, deal);
    });
  }, [bids, liveMap, extraListingsMap, dealsById, dealsByAcceptedBidId]);

  const counts = useMemo(() => {
    const acc = {
      all: classifiedEntries.length,
      pending: 0,
      accepted_deal: 0,
      rejected: 0,
      cancelled: 0,
      expired: 0,
    };
    for (const item of classifiedEntries) {
      acc[item.bucket] += 1;
    }
    return acc;
  }, [classifiedEntries]);

  const filteredEntries = useMemo(
    () => filterClassifiedBids(classifiedEntries, tab),
    [classifiedEntries, tab]
  );

  if (!userUid) {
    return (
      <section className="bx-wrap py-12">
        <div className="bx-card max-w-xl mx-auto p-8 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--orange-soft)', color: 'var(--orange)' }}
          >
            <Gavel className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-black">My Bids</h1>
          <p className="text-sm" style={{ color: 'var(--text-2)' }}>
            Sign in to track all your active, accepted, declined, and historical marketplace offers, withdraw pending bids, or jump straight to your Escrow Deal Rooms.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
            <button type="button" onClick={onRequireAuth} className="bx-btn bx-btn-primary">
              <span>Sign In to View My Bids</span>
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

  const handleConfirmWithdraw = async (bid: BidRecord, title: string) => {
    if (!userUid) return;
    setWithdrawingId(bid.id);
    try {
      await withdrawPendingBidInFirestore(userUid, bid, title);
      setConfirmWithdrawId(null);
      onFlash('Pending bid withdrawn and recorded in your bid history.');
    } catch (err) {
      onFlash(extractUserFacingFirestoreError(err, 'Could not withdraw bid.'));
    } finally {
      setWithdrawingId(null);
    }
  };

  return (
    <section className="bx-wrap py-8 space-y-6" aria-label="My Bids">
      {/* Header */}
      <div
        className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div>
          <p className="bx-eyebrow mb-1">Offer Management & Escrow Continuity</p>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">My Bids</h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-2)' }}>
            Track every offer you have submitted, withdraw pending bids before seller acceptance, or proceed directly to Escrow Checkout and Deal Rooms.
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

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter bids by status">
        {(
          [
            { id: 'all', label: `All (${counts.all})` },
            { id: 'pending', label: `Active / Pending (${counts.pending})` },
            { id: 'accepted_deal', label: `Accepted / Deal Created (${counts.accepted_deal})` },
            { id: 'rejected', label: `Rejected (${counts.rejected})` },
            { id: 'cancelled', label: `Withdrawn / Cancelled (${counts.cancelled})` },
            { id: 'expired', label: `Expired (${counts.expired})` },
          ] as const
        ).map((item) => {
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(item.id)}
              className="bx-chip whitespace-nowrap shrink-0 tabular-nums"
              data-active={active ? 'true' : 'false'}
            >
              {item.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      {loading ? (
        <div className="bx-card p-10 text-center">
          <p className="text-sm font-bold" style={{ color: 'var(--text-2)' }}>
            Loading your real-time bid history…
          </p>
        </div>
      ) : classifiedEntries.length === 0 ? (
        <div className="bx-card p-10 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--surface-2)', color: 'var(--orange)' }}
          >
            <Gavel className="w-6 h-6" />
          </div>
          <div className="space-y-1 max-w-md mx-auto">
            <h2 className="text-lg font-extrabold">You haven&apos;t placed any bids yet</h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Open any active listing on BEXORA to submit a custom offer. Once placed, your bids and seller responses appear here automatically.
            </p>
          </div>
          <button type="button" onClick={onBrowseMarketplace} className="bx-btn bx-btn-primary">
            <LayoutGrid className="w-4 h-4" />
            <span>Browse Marketplace Listings</span>
          </button>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="bx-card p-8 text-center space-y-3">
          <h2 className="text-base font-extrabold">No bids in this status category</h2>
          <button type="button" onClick={() => setTab('all')} className="bx-btn bx-btn-sm">
            <span>View All Bids ({counts.all})</span>
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredEntries.slice(0, visibleLimit).map((entry) => {
            const { bid } = entry;
            const hasThumb = Boolean(entry.assetThumbnailUrl && !failedImages[bid.id]);
            const platformId = entry.assetPlatform || 'youtube';
            const statusTone =
              entry.bucket === 'accepted_deal'
                ? 'var(--green)'
                : entry.bucket === 'pending'
                ? 'var(--orange)'
                : entry.bucket === 'rejected'
                ? 'var(--red)'
                : 'var(--text-2)';

            return (
              <article key={bid.id} className="bx-card p-4 sm:p-5 space-y-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  {/* Left: Thumbnail + Asset & Seller Info */}
                  <div className="flex items-start gap-3.5 min-w-0">
                    <div
                      className="w-20 h-14 sm:w-24 sm:h-16 rounded-xl overflow-hidden flex items-center justify-center shrink-0 border"
                      style={{
                        background: PLATFORM_BANNER_BG[platformId],
                        borderColor: 'var(--border-soft)',
                      }}
                    >
                      {hasThumb ? (
                        <img
                          src={entry.assetThumbnailUrl}
                          alt={entry.assetTitle}
                          referrerPolicy="no-referrer"
                          onError={() =>
                            setFailedImages((prev) => ({ ...prev, [bid.id]: true }))
                          }
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="text-white">
                          <PlatformIcon id={platformId} size={28} />
                        </div>
                      )}
                    </div>

                    <div className="min-w-0 space-y-1">
                      <div
                        className="flex flex-wrap items-center gap-1.5 text-xs font-semibold tabular-nums"
                        style={{ color: 'var(--text-2)' }}
                      >
                        <span>{PLATFORM_CATALOG[platformId]?.name || entry.assetSubcategory}</span>
                        <span aria-hidden="true">·</span>
                        <span>Submitted {formatNotificationExactDateTime(bid.createdAtMs)}</span>
                      </div>

                      {entry.canOpenListing ? (
                        <button
                          type="button"
                          onClick={() => onOpenListingById(bid.listingId)}
                          className="text-left font-extrabold text-base leading-snug hover:underline block truncate max-w-xl"
                        >
                          {entry.assetTitle}
                        </button>
                      ) : (
                        <h2 className="font-extrabold text-base leading-snug truncate max-w-xl">
                          {entry.assetTitle}
                        </h2>
                      )}

                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span style={{ color: 'var(--text-2)' }}>Seller:</span>
                        <button
                          type="button"
                          onClick={() => onOpenPublicProfile(entry.sellerId)}
                          className="font-bold hover:underline"
                          style={{ color: 'var(--text)' }}
                        >
                          {entry.sellerName}
                          {entry.sellerUsername ? ` (@${entry.sellerUsername})` : ''}
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Right: Bid Amount & Status */}
                  <div className="flex sm:flex-col items-baseline sm:items-end justify-between gap-2 shrink-0 tabular-nums">
                    <div className="text-right">
                      <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                        Your Offer
                      </span>
                      <strong className="text-lg sm:text-xl font-black">
                        {formatMoneyFromMinor(
                          bid.amountMinor,
                          displayCurrency,
                          bid.currency,
                          usdToBdtRate
                        )}
                      </strong>
                      {displayCurrency !== bid.currency && (
                        <span className="text-xs block" style={{ color: 'var(--text-3)' }}>
                          ({formatMoneyFromMinor(bid.amountMinor, bid.currency, bid.currency)})
                        </span>
                      )}
                    </div>
                    <span className="text-xs font-extrabold" style={{ color: statusTone }}>
                      {entry.statusBadgeLabel}
                    </span>
                  </div>
                </div>

                {/* Decision Summary & Actions Bar */}
                <div
                  className="pt-3 border-t flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                  style={{ borderColor: 'var(--border-soft)' }}
                >
                  <p className="text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
                    {entry.sellerDecisionSummary}
                  </p>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {entry.canOpenListing && (
                      <button
                        type="button"
                        onClick={() => onOpenListingById(bid.listingId)}
                        className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                      >
                        <span>View Listing</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </button>
                    )}

                    {entry.canOpenDealCheckout && entry.resolvedDealId && (
                      <button
                        type="button"
                        onClick={() =>
                          onStartDealCheckout(entry.resolvedDealId!, entry.assetTitle)
                        }
                        className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap shrink-0"
                      >
                        <CreditCard className="w-3.5 h-3.5" />
                        <span>Complete Escrow Payment</span>
                      </button>
                    )}

                    {entry.canOpenDealRoom && entry.resolvedDealId && (
                      <button
                        type="button"
                        onClick={() => onOpenDealRoom(entry.resolvedDealId!)}
                        className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Open Deal Room</span>
                      </button>
                    )}

                    {entry.canWithdraw && (
                      <>
                        {confirmWithdrawId === bid.id ? (
                          <div className="inline-flex items-center gap-1.5">
                            <button
                              type="button"
                              disabled={withdrawingId === bid.id}
                              onClick={() => handleConfirmWithdraw(bid, entry.assetTitle)}
                              className="bx-btn bx-btn-danger bx-btn-sm whitespace-nowrap shrink-0"
                            >
                              <span>
                                {withdrawingId === bid.id ? 'Withdrawing…' : 'Confirm Withdraw'}
                              </span>
                            </button>
                            <button
                              type="button"
                              disabled={withdrawingId === bid.id}
                              onClick={() => setConfirmWithdrawId(null)}
                              className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                            >
                              <span>Keep Bid</span>
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmWithdrawId(bid.id)}
                            className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            <span>Withdraw Bid</span>
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}

          {filteredEntries.length > visibleLimit && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => setVisibleLimit((prev) => prev + 20)}
                className="bx-btn"
              >
                <span>Load More ({filteredEntries.length - visibleLimit} remaining)</span>
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
