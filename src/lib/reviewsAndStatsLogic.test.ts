import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMarketplaceRatingBreakdown,
  computeVerifiedMarketplaceStats,
  filterAndSortReviews,
  validateReviewReportReason,
} from './reviewsAndStatsLogic';
import { ReviewRecord } from '../types';

const sampleReviews: ReviewRecord[] = [
  {
    id: 'rev_d1',
    dealId: 'd1',
    sellerId: 's1',
    sellerName: 'Alpha Media',
    listingId: 'l1',
    listingTitle: 'YouTube Finance Channel',
    platform: 'youtube',
    reviewerId: 'b1',
    reviewerName: 'Nadia R.',
    score: 5,
    comment: 'Smooth 3-party escrow transfer and verified monetization.',
    moderationStatus: 'published',
    createdAtMs: 1000,
  },
  {
    id: 'rev_d2',
    dealId: 'd2',
    sellerId: 's2',
    sellerName: 'Beta Domains',
    listingId: 'l2',
    listingTitle: 'SaaS Domain .com',
    platform: 'domain',
    reviewerId: 'b2',
    reviewerName: 'Karim S.',
    score: 4,
    comment: 'EPP transfer code worked cleanly.',
    createdAtMs: 3000,
  },
  {
    id: 'rev_d3_hidden',
    dealId: 'd3',
    sellerId: 's1',
    reviewerId: 'b3',
    reviewerName: 'Spammer',
    score: 1,
    comment: 'Abusive spam policy violation',
    moderationStatus: 'hidden',
    createdAtMs: 4000,
  },
];

test('Reviews Breakdown: excludes hidden reviews and returns honest zeros when empty', () => {
  const empty = computeMarketplaceRatingBreakdown([]);
  assert.equal(empty.totalPublished, 0);
  assert.equal(empty.averageRating, 0);

  const summary = computeMarketplaceRatingBreakdown(sampleReviews);
  assert.equal(summary.totalPublished, 2);
  assert.equal(summary.averageRating, 4.5);
  assert.equal(summary.countsByStar[5], 1);
  assert.equal(summary.countsByStar[4], 1);
  assert.equal(summary.countsByStar[1], 0);
});

test('Reviews Filter & Sort: filters by star, platform, query, and sorts accurately', () => {
  const newest = filterAndSortReviews(sampleReviews, { sortBy: 'newest' });
  assert.equal(newest.length, 2);
  assert.equal(newest[0].id, 'rev_d2');

  const ytOnly = filterAndSortReviews(sampleReviews, { platformFilter: 'youtube' });
  assert.equal(ytOnly.length, 1);
  assert.equal(ytOnly[0].id, 'rev_d1');

  const lowest = filterAndSortReviews(sampleReviews, { sortBy: 'lowest' });
  assert.equal(lowest[0].score, 4);

  assert.equal(validateReviewReportReason('short').valid, false);
  assert.equal(validateReviewReportReason('Contains abusive language violating BEXORA rules').valid, true);
});

test('Marketplace Live Stats: counts only active/reserved listings and settled sales without fake numbers', () => {
  const stats = computeVerifiedMarketplaceStats({
    listings: [
      { status: 'active' },
      { status: 'reserved' },
      { status: 'pending' },
      { status: 'draft' },
      { status: 'rejected' },
    ],
    publicProfiles: [
      { nidVerified: true, completedSales: 2 },
      { nidVerified: false, completedSales: 0 },
    ],
    publicActivities: [
      {
        id: 'act_1',
        kind: 'sold',
        actorDisplayName: 'Alpha Media',
        actorVerified: true,
        assetTitle: 'YouTube Finance Channel',
        platform: 'youtube',
        amountMinor: 1200000,
        currency: 'BDT',
        completedAtMs: 2000,
      },
      {
        id: 'act_2',
        kind: 'payout',
        actorDisplayName: 'Alpha Media',
        actorVerified: true,
        amountMinor: 500000,
        currency: 'BDT',
        completedAtMs: 2500,
      },
    ],
    reviews: sampleReviews,
    nowMs: 9999,
  });

  assert.equal(stats.activeListingsCount, 2);
  assert.equal(stats.registeredMembersCount, 2);
  assert.equal(stats.verifiedSellersCount, 1);
  assert.equal(stats.completedSalesCount, 2);
  assert.equal(stats.settledVolumeBdtMinor, 1200000);
  assert.equal(stats.settledVolumeUsdMinor, 0);
  assert.equal(stats.publishedReviewsCount, 2);
  assert.equal(stats.averageRating, 4.5);
});
