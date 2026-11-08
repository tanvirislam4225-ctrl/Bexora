import React, { useEffect, useMemo, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Eye,
  EyeOff,
  Flag,
  LayoutGrid,
  Search,
  ShieldCheck,
  Star,
  X,
} from 'lucide-react';
import { db, extractUserFacingFirestoreError } from '../lib/firebase';
import { PlatformId, ReviewRecord } from '../types';
import { PLATFORM_CATALOG, PLATFORM_LIST } from '../lib/marketplaceLogic';
import {
  computeMarketplaceRatingBreakdown,
  filterAndSortReviews,
  ReviewSortOption,
  validateReviewReportReason,
} from '../lib/reviewsAndStatsLogic';
import { formatActivityRelativeTime } from '../lib/activityTickerLogic';
import type { ReportModalTarget } from '../lib/moderationClient';

export interface ReviewsViewProps {
  userUid: string | null;
  userEmailVerified: boolean;
  userDisplayName: string;
  isAdmin: boolean;
  onOpenPublicProfile: (sellerUid: string) => void;
  onOpenDealsPage: () => void;
  onBrowseMarketplace: () => void;
  onRequireAuth: () => void;
  onFlash: (msg: string) => void;
  onReportReviewer?: (target: ReportModalTarget) => void;
}

const REVIEWS_PAGE_SIZE = 12;

export const ReviewsView: React.FC<ReviewsViewProps> = ({
  userUid,
  userEmailVerified,
  userDisplayName,
  isAdmin,
  onOpenPublicProfile,
  onOpenDealsPage,
  onBrowseMarketplace,
  onRequireAuth,
  onFlash,
  onReportReviewer,
}) => {
  const [allReviews, setAllReviews] = useState<ReviewRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [starFilter, setStarFilter] = useState<number | null>(null);
  const [platformFilter, setPlatformFilter] = useState<PlatformId | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<ReviewSortOption>('newest');
  const [showHiddenAdmin, setShowHiddenAdmin] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(REVIEWS_PAGE_SIZE);

  // Report Abuse Modal State
  const [reportingReview, setReportingReview] = useState<ReviewRecord | null>(null);
  const [reportReason, setReportReason] = useState('');
  const [reportErr, setReportErr] = useState('');
  const [reportBusy, setReportBusy] = useState(false);
  const [moderatingId, setModeratingId] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db, 'reviews'), limit(100));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: ReviewRecord[] = snap.docs.map((d) => {
          const rd = d.data();
          return {
            id: d.id,
            dealId: String(rd.dealId || ''),
            sellerId: String(rd.sellerId || ''),
            sellerName: rd.sellerName ? String(rd.sellerName) : undefined,
            reviewerId: String(rd.reviewerId || ''),
            reviewerName: String(rd.reviewerName || 'Verified Buyer'),
            listingId: rd.listingId ? String(rd.listingId) : undefined,
            listingTitle: rd.listingTitle ? String(rd.listingTitle) : undefined,
            platform: rd.platform ? (String(rd.platform) as PlatformId) : undefined,
            score: Number(rd.score || 0),
            comment: String(rd.comment || ''),
            moderationStatus: rd.moderationStatus === 'hidden' ? 'hidden' : 'published',
            createdAtMs: rd.createdAt?.toMillis ? rd.createdAt.toMillis() : Date.now(),
          };
        });
        list.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setAllReviews(list);
        setLoading(false);
      },
      () => {
        setLoading(false);
      }
    );
    return () => unsub();
  }, []);

  const breakdown = useMemo(() => computeMarketplaceRatingBreakdown(allReviews), [allReviews]);

  const displayedReviews = useMemo(() => {
    if (isAdmin && showHiddenAdmin) {
      return allReviews.filter((r) => r.moderationStatus === 'hidden');
    }
    return filterAndSortReviews(allReviews, {
      starFilter,
      platformFilter,
      searchQuery,
      sortBy,
    });
  }, [allReviews, isAdmin, showHiddenAdmin, starFilter, platformFilter, searchQuery, sortBy]);

  const handleSubmitAbuseReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reportingReview) return;
    if (!userUid) {
      onRequireAuth();
      return;
    }
    if (!userEmailVerified) {
      setReportErr('Please verify your email address in Profile > Settings before submitting moderation reports.');
      return;
    }
    const check = validateReviewReportReason(reportReason);
    if (!check.valid) {
      setReportErr(check.error || 'Please describe why this review violates marketplace policy.');
      return;
    }

    setReportBusy(true);
    setReportErr('');
    try {
      const reportId = `rrep_${reportingReview.id}_${userUid}`;
      await setDoc(doc(db, 'reviewReports', reportId), {
        reviewId: reportingReview.id,
        dealId: reportingReview.dealId,
        reporterId: userUid,
        reporterName: (userDisplayName || 'Verified Member').slice(0, 80),
        reason: check.cleanReason,
        status: 'open',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      setReportingReview(null);
      setReportReason('');
      onFlash('Review flagged for BEXORA Admin moderation.');
    } catch (err) {
      setReportErr(
        extractUserFacingFirestoreError(
          err,
          'You have already reported this review or lack permission.'
        )
      );
    } finally {
      setReportBusy(false);
    }
  };

  const handleAdminToggleVisibility = async (rev: ReviewRecord) => {
    if (!isAdmin) return;
    const nextStatus = rev.moderationStatus === 'hidden' ? 'published' : 'hidden';
    setModeratingId(rev.id);
    try {
      await updateDoc(doc(db, 'reviews', rev.id), {
        moderationStatus: nextStatus,
        updatedAt: serverTimestamp(),
      });
      onFlash(
        nextStatus === 'hidden'
          ? 'Review hidden from public marketplace views.'
          : 'Review restored to public marketplace views.'
      );
    } catch (err) {
      onFlash(extractUserFacingFirestoreError(err, 'Failed to update review visibility.'));
    } finally {
      setModeratingId(null);
    }
  };

  return (
    <section
      className="bx-wrap-wide py-8 space-y-6"
      aria-label="Verified Marketplace Reviews and Ratings"
      data-testid="reviews-view"
    >
      {/* Header */}
      <div
        className="flex flex-col md:flex-row md:items-end justify-between gap-4 pb-5 border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div className="space-y-1">
          <p className="bx-eyebrow">Escrow-Verified Feedback</p>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">
            Reviews &amp; Seller Ratings
          </h1>
          <p className="text-sm max-w-2xl" style={{ color: 'var(--text-2)' }}>
            Every review on BEXORA is verified against a settled escrow transaction. Unverified accounts and incomplete deals cannot post ratings.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {userUid && (
            <button
              type="button"
              onClick={onOpenDealsPage}
              className="bx-btn bx-btn-sm whitespace-nowrap"
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Rate a Settled Deal</span>
            </button>
          )}
          <button
            type="button"
            onClick={onBrowseMarketplace}
            className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap"
          >
            <LayoutGrid className="w-4 h-4" />
            <span>Browse Listings</span>
          </button>
        </div>
      </div>

      {/* Rating Summary & 5-Star Distribution */}
      <div className="bx-card p-5 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
        <div className="lg:col-span-4 space-y-2">
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-black tabular-nums" style={{ color: 'var(--text)' }}>
              {breakdown.totalPublished > 0 ? breakdown.averageRating.toFixed(1) : '—'}
            </span>
            <span className="text-sm font-bold" style={{ color: 'var(--text-2)' }}>
              {breakdown.totalPublished > 0
                ? `out of 5.0 · ${breakdown.totalPublished.toLocaleString('en-US')} verified ${
                    breakdown.totalPublished === 1 ? 'review' : 'reviews'
                  }`
                : 'No published reviews yet'}
            </span>
          </div>

          <div className="flex items-center gap-1" aria-hidden="true">
            {[1, 2, 3, 4, 5].map((n) => {
              const filled =
                breakdown.totalPublished > 0 && n <= Math.round(breakdown.averageRating);
              return (
                <Star
                  key={n}
                  className={`w-4 h-4 ${filled ? 'fill-current' : ''}`}
                  style={{ color: filled ? 'var(--orange)' : 'var(--text-3)' }}
                />
              );
            })}
          </div>

          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
            Only the verified buyer of a completed escrow transaction can submit one immutable rating per deal.
          </p>
        </div>

        <div className="lg:col-span-8 space-y-2">
          {([5, 4, 3, 2, 1] as const).map((star) => {
            const count = breakdown.countsByStar[star];
            const pct =
              breakdown.totalPublished > 0
                ? Math.round((count / breakdown.totalPublished) * 100)
                : 0;
            const isSelected = starFilter === star;

            return (
              <button
                key={star}
                type="button"
                onClick={() => setStarFilter((prev) => (prev === star ? null : star))}
                aria-pressed={isSelected}
                className="w-full flex items-center gap-3 text-xs font-bold py-1 px-2 rounded-lg transition-colors text-left"
                style={{
                  background: isSelected ? 'var(--purple-soft)' : 'transparent',
                  color: 'var(--text)',
                }}
              >
                <span className="w-14 shrink-0 inline-flex items-center gap-1 tabular-nums">
                  <span>{star}</span>
                  <Star className="w-3.5 h-3.5 fill-current" style={{ color: 'var(--orange)' }} />
                </span>
                <div
                  className="flex-1 h-2.5 rounded-full overflow-hidden"
                  style={{ background: 'var(--surface-2)' }}
                >
                  <div
                    className="h-full rounded-full transition-transform duration-200 origin-left"
                    style={{
                      width: `${pct}%`,
                      background: 'var(--orange)',
                    }}
                  />
                </div>
                <span
                  className="w-20 text-right shrink-0 tabular-nums"
                  style={{ color: 'var(--text-2)' }}
                >
                  {count} ({pct}%)
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Discovery Filter & Sort Controls */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search
            className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-3)' }}
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setVisibleLimit(REVIEWS_PAGE_SIZE);
            }}
            placeholder="Filter reviews by seller, asset title, or keyword…"
            aria-label="Filter reviews"
            className="bx-input pl-10 pr-4"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={platformFilter}
            onChange={(e) => {
              setPlatformFilter(e.target.value as PlatformId | 'all');
              setVisibleLimit(REVIEWS_PAGE_SIZE);
            }}
            aria-label="Filter reviews by category"
            className="bx-select w-auto min-w-[165px] py-2 text-xs font-bold"
          >
            <option value="all">All Categories</option>
            {PLATFORM_LIST.map((pId) => (
              <option key={pId} value={pId}>
                {PLATFORM_CATALOG[pId].name}
              </option>
            ))}
          </select>

          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as ReviewSortOption)}
            aria-label="Sort reviews"
            className="bx-select w-auto min-w-[165px] py-2 text-xs font-bold"
          >
            <option value="newest">Newest First</option>
            <option value="highest">Highest Rated</option>
            <option value="lowest">Lowest Rated</option>
          </select>

          {starFilter !== null && (
            <button
              type="button"
              onClick={() => setStarFilter(null)}
              className="bx-btn bx-btn-sm whitespace-nowrap"
            >
              <span>{starFilter}-Star Filter</span>
              <X className="w-3.5 h-3.5" />
            </button>
          )}

          {isAdmin && (
            <button
              type="button"
              onClick={() => setShowHiddenAdmin((prev) => !prev)}
              aria-pressed={showHiddenAdmin}
              className="bx-btn bx-btn-sm whitespace-nowrap"
            >
              {showHiddenAdmin ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
              <span>{showHiddenAdmin ? 'Showing Hidden' : 'Hidden Reviews'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Reviews Grid or Truthful Empty State */}
      {loading ? (
        <div className="bx-card p-10 text-center">
          <p className="text-sm font-bold" style={{ color: 'var(--text-2)' }}>
            Loading verified escrow reviews…
          </p>
        </div>
      ) : breakdown.totalPublished === 0 && !showHiddenAdmin ? (
        <div className="bx-card p-10 text-center space-y-4">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--surface-2)', color: 'var(--orange)' }}
          >
            <Star className="w-6 h-6" />
          </div>
          <div className="space-y-1.5 max-w-md mx-auto">
            <h2 className="text-lg font-extrabold">No published customer reviews yet</h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              BEXORA never displays fabricated testimonials. Genuine buyer reviews appear here automatically as buyers rate sellers after escrow settlement.
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <button type="button" onClick={onBrowseMarketplace} className="bx-btn bx-btn-primary">
              <span>Explore Verified Listings</span>
            </button>
            {userUid && (
              <button type="button" onClick={onOpenDealsPage} className="bx-btn">
                <span>View My Escrow Deals</span>
              </button>
            )}
          </div>
        </div>
      ) : displayedReviews.length === 0 ? (
        <div className="bx-card p-8 text-center space-y-3">
          <h2 className="text-base font-extrabold">No reviews match the selected filters</h2>
          <button
            type="button"
            onClick={() => {
              setStarFilter(null);
              setPlatformFilter('all');
              setSearchQuery('');
              setShowHiddenAdmin(false);
            }}
            className="bx-btn bx-btn-sm"
          >
            <span>Reset Review Filters</span>
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
            {displayedReviews.slice(0, visibleLimit).map((rev) => {
              const platDef = rev.platform ? PLATFORM_CATALOG[rev.platform] : null;
              const isHidden = rev.moderationStatus === 'hidden';

              return (
                <article
                  key={rev.id}
                  className="bx-card p-5 flex flex-col justify-between gap-4 min-w-0"
                >
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-extrabold text-sm truncate" style={{ color: 'var(--text)' }}>
                          {rev.reviewerName}
                        </div>
                        <div
                          className="flex flex-wrap items-center gap-1.5 text-xs font-semibold tabular-nums mt-0.5"
                          style={{ color: 'var(--text-2)' }}
                        >
                          <span className="inline-flex items-center gap-1" style={{ color: 'var(--green)' }}>
                            <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
                            <span>Verified Escrow Deal</span>
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{formatActivityRelativeTime(rev.createdAtMs)}</span>
                        </div>
                      </div>

                      <div
                        className="inline-flex items-center gap-1 text-xs font-black tabular-nums shrink-0"
                        style={{ color: 'var(--orange)' }}
                      >
                        <Star className="w-4 h-4 fill-current" />
                        <span>{rev.score}.0</span>
                      </div>
                    </div>

                    <p className="text-sm leading-relaxed break-words" style={{ color: 'var(--text)' }}>
                      {rev.comment}
                    </p>

                    {(rev.listingTitle || platDef) && (
                      <div
                        className="text-xs font-semibold truncate"
                        style={{ color: 'var(--text-2)' }}
                      >
                        {platDef ? `${platDef.name}` : 'Digital Asset'}
                        {rev.listingTitle ? ` · ${rev.listingTitle}` : ''}
                      </div>
                    )}
                  </div>

                  <div
                    className="pt-3 border-t flex items-center justify-between gap-2 flex-wrap"
                    style={{ borderColor: 'var(--border-soft)' }}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenPublicProfile(rev.sellerId)}
                      className="text-xs font-extrabold hover:underline truncate"
                      style={{ color: 'var(--purple)' }}
                    >
                      Seller: {rev.sellerName || 'View Seller Profile'} →
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      {isAdmin && (
                        <button
                          type="button"
                          disabled={moderatingId === rev.id}
                          onClick={() => void handleAdminToggleVisibility(rev)}
                          className="text-xs font-bold hover:underline inline-flex items-center gap-1"
                          style={{ color: isHidden ? 'var(--green)' : 'var(--red)' }}
                        >
                          {isHidden ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                          <span>{isHidden ? 'Restore' : 'Hide'}</span>
                        </button>
                      )}
                      {userUid !== rev.reviewerId && (
                        <button
                          type="button"
                          onClick={() => {
                            if (onReportReviewer) {
                              onReportReviewer({
                                reportedUserId: rev.reviewerId,
                                reportedUserName: rev.reviewerName || 'Reviewer',
                                surface: 'review',
                                reviewId: rev.id,
                                dealId: rev.dealId,
                                listingId: rev.listingId,
                                listingTitle: rev.listingTitle,
                                quotedContent: rev.comment,
                                defaultCategory: 'review_manipulation',
                              });
                              return;
                            }
                            if (!userUid) {
                              onRequireAuth();
                              return;
                            }
                            setReportingReview(rev);
                            setReportReason('');
                            setReportErr('');
                          }}
                          aria-label={`Report review by ${rev.reviewerName}`}
                          className="text-xs font-semibold hover:underline inline-flex items-center gap-1"
                          style={{ color: 'var(--text-3)' }}
                        >
                          <Flag className="w-3 h-3" />
                          <span>Report</span>
                        </button>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>

          {displayedReviews.length > visibleLimit && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => setVisibleLimit((prev) => prev + REVIEWS_PAGE_SIZE)}
                className="bx-btn"
              >
                <span>
                  Load More ({displayedReviews.length - visibleLimit} remaining)
                </span>
              </button>
            </div>
          )}
        </>
      )}

      {/* Report Policy-Violating Review Modal */}
      {reportingReview && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="bx-report-review-title"
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs grid place-items-center p-4"
        >
          <form
            onSubmit={handleSubmitAbuseReport}
            className="bx-card w-full max-w-md p-6 space-y-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h2 id="bx-report-review-title" className="text-lg font-black">
                Report Review for Moderation
              </h2>
              <button
                type="button"
                onClick={() => setReportingReview(null)}
                aria-label="Close report dialog"
                className="w-8 h-8 rounded-lg grid place-items-center"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
              Flagging review by <strong>{reportingReview.reviewerName}</strong> for abusive language, personal contact info disclosure, or policy violation.
            </p>

            {reportErr && (
              <div
                className="p-3 rounded-lg text-xs font-bold border"
                style={{
                  background: 'var(--red-soft)',
                  borderColor: 'var(--red)',
                  color: 'var(--red)',
                }}
              >
                {reportErr}
              </div>
            )}

            <div>
              <label htmlFor="bx-review-report-reason" className="bx-label">
                Reason for Moderation *
              </label>
              <textarea
                id="bx-review-report-reason"
                rows={3}
                required
                maxLength={500}
                value={reportReason}
                onChange={(e) => setReportReason(e.target.value)}
                placeholder="Explain how this comment violates BEXORA guidelines…"
                className="bx-textarea"
              />
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                onClick={() => setReportingReview(null)}
                className="bx-btn bx-btn-sm"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={reportBusy}
                className="bx-btn bx-btn-primary bx-btn-sm"
              >
                {reportBusy ? 'Submitting…' : 'Submit Report'}
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
};
