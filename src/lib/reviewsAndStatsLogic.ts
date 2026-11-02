import {
  MarketplaceListing,
  MarketplaceLiveStats,
  PlatformId,
  PublicActivityItem,
  PublicProfile,
  ReviewRecord,
} from '../types';

export type ReviewSortOption = 'newest' | 'highest' | 'lowest';

export interface ReviewFilterOptions {
  starFilter?: number | null; // 1..5 or null for all
  platformFilter?: PlatformId | 'all';
  searchQuery?: string;
  sortBy?: ReviewSortOption;
}

export interface MarketplaceRatingBreakdown {
  totalPublished: number;
  averageRating: number;
  countsByStar: Record<1 | 2 | 3 | 4 | 5, number>;
}

/**
 * Filters out hidden/moderated reviews and validates score bounds (1..5).
 */
export function getPublishedReviews(reviews: ReviewRecord[]): ReviewRecord[] {
  return reviews.filter((r) => {
    if (!r || r.moderationStatus === 'hidden') return false;
    const score = Number(r.score);
    return Number.isInteger(score) && score >= 1 && score <= 5 && Boolean(r.comment?.trim());
  });
}

/**
 * Calculates genuine average rating and 5-to-1 star counts strictly from published reviews.
 * Never fabricates fallback averages when 0 reviews exist.
 */
export function computeMarketplaceRatingBreakdown(
  reviews: ReviewRecord[]
): MarketplaceRatingBreakdown {
  const published = getPublishedReviews(reviews);
  const countsByStar: Record<1 | 2 | 3 | 4 | 5, number> = {
    1: 0,
    2: 0,
    3: 0,
    4: 0,
    5: 0,
  };

  for (const rev of published) {
    const s = rev.score as 1 | 2 | 3 | 4 | 5;
    countsByStar[s] += 1;
  }

  const totalPublished = published.length;
  if (totalPublished === 0) {
    return {
      totalPublished: 0,
      averageRating: 0,
      countsByStar,
    };
  }

  const sum = published.reduce((acc, r) => acc + r.score, 0);
  const averageRating = Math.round((sum / totalPublished) * 10) / 10;

  return {
    totalPublished,
    averageRating,
    countsByStar,
  };
}

/**
 * Filters and sorts published reviews according to user-selected discovery controls.
 */
export function filterAndSortReviews(
  reviews: ReviewRecord[],
  opts: ReviewFilterOptions = {}
): ReviewRecord[] {
  const published = getPublishedReviews(reviews);
  const star = opts.starFilter && opts.starFilter >= 1 && opts.starFilter <= 5 ? opts.starFilter : null;
  const plat = opts.platformFilter && opts.platformFilter !== 'all' ? opts.platformFilter : null;
  const q = String(opts.searchQuery || '').trim().toLowerCase();
  const sortBy: ReviewSortOption = opts.sortBy || 'newest';

  const filtered = published.filter((r) => {
    if (star !== null && r.score !== star) return false;
    if (plat !== null && r.platform !== plat) return false;
    if (q) {
      const hay = [
        r.reviewerName || '',
        r.sellerName || '',
        r.listingTitle || '',
        r.comment || '',
        r.platform || '',
      ]
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return [...filtered].sort((a, b) => {
    if (sortBy === 'highest') {
      return b.score - a.score || b.createdAtMs - a.createdAtMs;
    }
    if (sortBy === 'lowest') {
      return a.score - b.score || b.createdAtMs - a.createdAtMs;
    }
    return b.createdAtMs - a.createdAtMs;
  });
}

/**
 * Validates user input for reporting an abusive or policy-violating review.
 */
export function validateReviewReportReason(rawReason: string): {
  valid: boolean;
  cleanReason: string;
  error?: string;
} {
  const cleanReason = String(rawReason || '')
    .replace(/[\u0000-\u001F\u007F<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);

  if (cleanReason.length < 8) {
    return {
      valid: false,
      cleanReason,
      error: 'Please enter a brief explanation (at least 8 characters) so moderation can review it.',
    };
  }
  return { valid: true, cleanReason };
}

/**
 * Aggregates live, genuine marketplace statistics exclusively from verified public records.
 * Excludes draft/pending/rejected/suspended listings, pending/cancelled/refunded deals, and hidden reviews.
 */
export function computeVerifiedMarketplaceStats(input: {
  listings: Array<Pick<MarketplaceListing, 'status'>>;
  publicProfiles: Array<Pick<PublicProfile, 'nidVerified' | 'completedSales'>>;
  publicActivities: PublicActivityItem[];
  reviews: ReviewRecord[];
  nowMs?: number;
}): MarketplaceLiveStats {
  const activeListingsCount = input.listings.filter(
    (l) => l && (l.status === 'active' || l.status === 'reserved')
  ).length;

  const registeredMembersCount = input.publicProfiles.length;
  const verifiedSellersCount = input.publicProfiles.filter((p) => Boolean(p?.nidVerified)).length;

  const profileSalesTotal = input.publicProfiles.reduce(
    (sum, p) => sum + Math.max(0, Math.floor(Number(p?.completedSales) || 0)),
    0
  );

  const soldActivities = input.publicActivities.filter(
    (a) => a && a.kind === 'sold' && a.amountMinor > 0
  );

  // Use the higher of verified profile completedSales sum or projected settled sold activities count
  const completedSalesCount = Math.max(profileSalesTotal, soldActivities.length);

  let settledVolumeBdtMinor = 0;
  let settledVolumeUsdMinor = 0;
  for (const act of soldActivities) {
    if (act.currency === 'USD') {
      settledVolumeUsdMinor += Math.floor(act.amountMinor);
    } else if (act.currency === 'BDT') {
      settledVolumeBdtMinor += Math.floor(act.amountMinor);
    }
  }

  const ratingBreakdown = computeMarketplaceRatingBreakdown(input.reviews);

  return {
    activeListingsCount,
    completedSalesCount,
    registeredMembersCount,
    verifiedSellersCount,
    publishedReviewsCount: ratingBreakdown.totalPublished,
    averageRating: ratingBreakdown.averageRating,
    settledVolumeBdtMinor,
    settledVolumeUsdMinor,
    updatedAtMs: input.nowMs ?? Date.now(),
  };
}
