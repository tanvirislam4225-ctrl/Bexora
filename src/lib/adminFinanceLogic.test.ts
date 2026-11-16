import test from 'node:test';
import assert from 'node:assert/strict';
import type { DealStatus } from '../types';
import {
  computeAdminFinanceOverview,
  computeUserPendingSellerBalanceBdtMinor,
  isDealEligibleForAutoRelease,
  isUserBalanceRestricted,
  summarizeUserPendingSellerDeals,
  toBdtMinorInteger,
} from './adminFinanceLogic';

test('Total Listing Value sums ONLY active published listings and excludes non-active statuses cleanly', () => {
  const result = computeAdminFinanceOverview({
    usdToBdtRate: 120,
    privateUsers: [],
    deals: [],
    withdrawals: [],
    deposits: [],
    listings: [
      { id: 'l1', status: 'active', priceMinor: 100_000, currency: 'BDT' }, // 1,000 BDT
      { id: 'l2', status: 'active', priceMinor: 1_000, currency: 'USD' }, // $10 = 1,200 BDT = 120,000 paisa
      { id: 'l3', status: 'reserved', priceMinor: 500_000, currency: 'BDT' },
      { id: 'l4', status: 'pending', priceMinor: 300_000, currency: 'BDT' },
      { id: 'l5', status: 'rejected', priceMinor: 900_000, currency: 'BDT' },
      { id: 'l6', status: 'draft', priceMinor: 400_000, currency: 'BDT' },
      { id: 'l7', status: 'cancelled', priceMinor: 250_000, currency: 'BDT' },
      { id: 'l8', status: 'sold', priceMinor: 800_000, currency: 'BDT' },
      { id: 'l9', status: 'suspended', priceMinor: 700_000, currency: 'BDT' },
      { id: 'l10', status: 'archived', priceMinor: 600_000, currency: 'BDT' },
      // Duplicate ID must not double-count
      { id: 'l1', status: 'active', priceMinor: 100_000, currency: 'BDT' },
    ],
  });

  assert.equal(result.listings.liveCount, 2);
  assert.equal(result.listings.liveValueBdtMinor, 220_000); // 2,200 BDT in paisa
  assert.equal(result.listings.pendingCount, 1);
  assert.equal(result.listings.pendingValueBdtMinor, 300_000);
  assert.equal(result.actionQueue.pendingListingsCount, 1);
});

test('Total Escrow Held, Completed Sales, Platform Earnings, and Pending Seller Balance compute accurately without double counting', () => {
  const now = 1_700_000_000_000;
  const result = computeAdminFinanceOverview({
    nowMs: now,
    usdToBdtRate: 120,
    privateUsers: [],
    listings: [],
    withdrawals: [],
    deposits: [],
    deals: [
      // 1. Settled deal: gross 1000 BDT (100,000 minor), fee 50 BDT (5,000), seller payout 950 BDT (95,000)
      {
        id: 'd_settled',
        status: 'settled',
        currency: 'BDT',
        baseAmountMinor: 100_000,
        platformCommissionMinor: 5_000,
        sellerPayoutMinor: 95_000,
        buyerTotalMinor: 105_000,
      },
      // 2. Refunded dispute: platform retained 3% = 3,000 minor
      {
        id: 'd_refunded',
        status: 'refunded',
        currency: 'BDT',
        baseAmountMinor: 100_000,
        platformCommissionMinor: 5_000,
        refundPlatformRetainedMinor: 3_000,
        sellerPayoutMinor: 95_000,
        buyerTotalMinor: 105_000,
      },
      // 3. Cancelled / unpaid: zero contribution to escrow, completed sales, earnings, or pending seller
      {
        id: 'd_cancelled',
        status: 'cancelled',
        currency: 'BDT',
        baseAmountMinor: 500_000,
        platformCommissionMinor: 25_000,
        sellerPayoutMinor: 475_000,
        buyerTotalMinor: 525_000,
      },
      {
        id: 'd_unpaid',
        status: 'accepted_pending_payment',
        currency: 'BDT',
        baseAmountMinor: 500_000,
        platformCommissionMinor: 25_000,
        sellerPayoutMinor: 475_000,
        buyerTotalMinor: 525_000,
      },
      // 4. Held in security timer (not yet expired)
      {
        id: 'd_active_timer',
        status: 'protection_active',
        currency: 'BDT',
        baseAmountMinor: 200_000,
        platformCommissionMinor: 10_000,
        sellerPayoutMinor: 190_000,
        buyerTotalMinor: 210_000,
        originalDeadlineMs: now + 3_600_000,
        unresolvedReportCount: 0,
      },
      // 5. Held with elapsed timer & 0 disputes (ready to settle)
      {
        id: 'd_ready',
        status: 'protection_active',
        currency: 'USD',
        baseAmountMinor: 1_000, // $10 = 120,000 BDT minor
        platformCommissionMinor: 50, // $0.50 = 6,000 BDT minor
        sellerPayoutMinor: 950, // $9.50 = 114,000 BDT minor
        buyerTotalMinor: 1_050, // $10.50 = 126,000 BDT minor
        originalDeadlineMs: now - 60_000,
        unresolvedReportCount: 0,
      },
      // 6. Disputed hold
      {
        id: 'd_disputed',
        status: 'reported_under_review',
        currency: 'BDT',
        baseAmountMinor: 50_000,
        platformCommissionMinor: 2_500,
        sellerPayoutMinor: 47_500,
        buyerTotalMinor: 52_500,
        originalDeadlineMs: now - 60_000,
        unresolvedReportCount: 1,
      },
    ],
  });

  assert.equal(result.deals.settledCount, 1);
  assert.equal(result.deals.grossSalesBdtMinor, 100_000);
  assert.equal(result.deals.realizedRevenueBdtMinor, 5_000);
  assert.equal(result.deals.refundRetainedRevenueBdtMinor, 3_000);
  assert.equal(result.deals.totalPlatformEarningsBdtMinor, 8_000);
  assert.equal(result.deals.sellerPayoutsReleasedBdtMinor, 95_000);

  assert.equal(result.deals.heldCount, 3);
  assert.equal(result.deals.escrowHeldBdtMinor, 210_000 + 126_000 + 52_500);
  assert.equal(result.deals.pendingSellerEarningsBdtMinor, 190_000 + 114_000 + 47_500);
  assert.equal(result.deals.expectedRevenueBdtMinor, 10_000 + 6_000 + 2_500);

  assert.equal(result.actionQueue.disputedDealsCount, 1);
  assert.equal(result.actionQueue.readyToSettleDealsCount, 1);
});

test('Total User Withdrawable Balance excludes frozen, restricted, and suspended wallets and never includes Pending Seller Balance', () => {
  const now = 1_700_000_000_000;
  const result = computeAdminFinanceOverview({
    nowMs: now,
    listings: [],
    deals: [
      {
        id: 'deal_pending',
        sellerId: 'u_clean',
        status: 'protection_active',
        currency: 'BDT',
        buyerTotalMinor: 105_000,
        sellerPayoutMinor: 95_000,
        platformCommissionMinor: 5_000,
      },
    ],
    withdrawals: [],
    deposits: [],
    privateUsers: [
      { id: 'u_clean', walletBalanceMinor: 50_000, reservedBalanceMinor: 10_000 },
      { id: 'u_frozen', walletBalanceMinor: 200_000, reservedBalanceMinor: 0 },
      { id: 'u_banned', walletBalanceMinor: 150_000, reservedBalanceMinor: 0 },
      { id: 'u_expired_susp', walletBalanceMinor: 30_000, reservedBalanceMinor: 0 },
      { id: 'u_negative', walletBalanceMinor: -5_000, reservedBalanceMinor: 0 },
    ],
    userRestrictions: [
      { id: 'u_frozen', financialHoldActive: true },
      { id: 'u_banned', accountStatus: 'permanent_ban' },
      { id: 'u_expired_susp', accountStatus: 'temporary_suspension', expiresAtMs: now - 10_000 },
    ],
  });

  // u_clean (50,000) + u_expired_susp (30,000) = 80,000
  assert.equal(result.users.availableWalletBdtMinor, 80_000);
  assert.equal(result.users.usersWithBalance, 2);
  assert.equal(result.users.restrictedUsersCount, 2);
  assert.equal(result.users.restrictedWalletBdtMinor, 350_000);
  assert.equal(result.users.lockedInWithdrawalsBdtMinor, 10_000);
  assert.equal(result.deals.pendingSellerEarningsBdtMinor, 95_000);
});

test('User Pending Seller Balance isolates per-seller funded unsettled deals and blocks early/disputed release', () => {
  const now = 1_700_000_000_000;
  const deals = [
    {
      id: 'd1',
      listingTitle: 'YouTube Gaming 50k',
      sellerId: 'seller_a',
      status: 'protection_active' as DealStatus,
      sellerPayoutMinor: 150_000,
      currency: 'BDT' as const,
      originalDeadlineMs: now + 7200_000,
      unresolvedReportCount: 0,
    },
    {
      id: 'd2',
      listingTitle: 'Instagram Meme Page',
      sellerId: 'seller_a',
      status: 'protection_active' as DealStatus,
      sellerPayoutMinor: 80_000,
      currency: 'BDT' as const,
      originalDeadlineMs: now - 1000,
      unresolvedReportCount: 0,
    },
    {
      id: 'd3',
      listingTitle: 'Facebook Monetized Page',
      sellerId: 'seller_a',
      status: 'reported_under_review' as DealStatus,
      sellerPayoutMinor: 90_000,
      currency: 'BDT' as const,
      originalDeadlineMs: now - 1000,
      unresolvedReportCount: 1,
    },
    {
      id: 'd4',
      listingTitle: 'Settled Domain',
      sellerId: 'seller_a',
      status: 'settled' as DealStatus,
      sellerPayoutMinor: 300_000,
      currency: 'BDT' as const,
      originalDeadlineMs: now - 5000,
      unresolvedReportCount: 0,
      settlementLedgerId: 'led_release_d4',
    },
    {
      id: 'd5',
      listingTitle: 'Other Seller Asset',
      sellerId: 'seller_b',
      status: 'paid_deal_room_active' as DealStatus,
      sellerPayoutMinor: 250_000,
      currency: 'BDT' as const,
      originalDeadlineMs: 0,
      unresolvedReportCount: 0,
    },
  ];

  const summary = summarizeUserPendingSellerDeals(deals, 'seller_a', 120, now);
  assert.equal(summary.totalPendingBdtMinor, 150_000 + 80_000 + 90_000);
  assert.equal(summary.activePendingCount, 3);
  assert.equal(summary.readyForReleaseCount, 1);
  assert.equal(summary.disputedPendingCount, 1);

  assert.equal(computeUserPendingSellerBalanceBdtMinor(deals, 'seller_b', 120, now), 250_000);
  assert.equal(computeUserPendingSellerBalanceBdtMinor(deals, 'nobody', 120, now), 0);

  // Strict auto-release eligibility gate
  assert.equal(isDealEligibleForAutoRelease(deals[0], 0, now), false, 'Unexpired deal cannot auto-release');
  assert.equal(isDealEligibleForAutoRelease(deals[1], 0, now), true, 'Expired dispute-free deal can release');
  assert.equal(isDealEligibleForAutoRelease(deals[1], 1, now), false, 'Open subcollection report blocks release');
  assert.equal(isDealEligibleForAutoRelease(deals[2], 0, now), false, 'Disputed deal blocks release');
  assert.equal(isDealEligibleForAutoRelease(deals[3], 0, now), false, 'Already settled deal blocks re-release');
  assert.equal(isDealEligibleForAutoRelease(deals[4], 0, now), false, 'Deal with deadline 0 blocks release');
});

test('isUserBalanceRestricted handles withdrawal pause, holds, bans, and integer conversions accurately', () => {
  const now = 1_700_000_000_000;
  assert.equal(isUserBalanceRestricted({ restrictWithdrawals: true }, now), true);
  assert.equal(isUserBalanceRestricted({ financialHoldActive: true }, now), true);
  assert.equal(isUserBalanceRestricted({ accountStatus: 'protective_suspension' }, now), true);
  assert.equal(
    isUserBalanceRestricted({ accountStatus: 'temporary_suspension', expiresAtMs: now + 60_000 }, now),
    true
  );
  assert.equal(isUserBalanceRestricted({ accountStatus: 'active' }, now), false);
  assert.equal(toBdtMinorInteger(100, 'USD', 122), 12_200);
  assert.equal(toBdtMinorInteger('invalid', 'BDT', 120), 0);
});

test('computeAdminFinanceOverview sets complete=false and preserves failedCollections diagnostics when any collection read fails', () => {
  const res = computeAdminFinanceOverview({
    privateUsers: [],
    listings: [],
    deals: [],
    withdrawals: [],
    deposits: [],
    failedCollections: ['deals'],
    collectionDiagnostics: {
      deals: { complete: false, count: 0, source: 'rest_query', error: 'REST timeout' },
    },
  });
  assert.equal(res.complete, false);
  assert.deepEqual(res.failedCollections, ['deals']);
  assert.equal(res.collectionDiagnostics?.deals.error, 'REST timeout');
});

