import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  AdminInvitationRecord,
  DealRecord,
  DepositRequestRecord,
  IdentityVerificationRecord,
  MarketplaceListing,
  WithdrawalRequestRecord,
} from '../types';
import {
  classifyAdminListingBucket,
  filterAndBucketAdminGovernance,
  filterAndBucketDeposits,
  filterAndBucketListings,
  filterAndBucketNids,
  filterAndBucketWithdrawals,
  filterAdminDeals,
  paginateAdminItems,
} from './adminQueueLogic';

function makeListing(partial: Partial<MarketplaceListing> & { id: string }): MarketplaceListing {
  return {
    sellerId: 's1',
    sellerName: 'Seller One',
    sellerUsername: 'seller1',
    sellerVerified: true,
    platform: 'youtube',
    subcategory: 'YouTube Channel',
    title: 'Channel Listing',
    description: 'Description',
    priceMinor: 100000,
    currency: 'BDT',
    monetizationStatus: 'monetized',
    claimedOptions: [],
    verifiedOptions: [],
    verificationState: 'not_claimed',
    ageYears: 1,
    ageMonths: 0,
    metricValue: 1000,
    monthlyRevenueMinor: 0,
    accountUrl: 'https://youtube.com/@test',
    urlValidationStatus: 'domain_matched',
    images: [],
    status: 'pending',
    views: 0,
    createdAtMs: 1000,
    ...partial,
  };
}

test('filterAndBucketListings separates pending, approved (active/reserved/sold), rejected, and other without status bleed', () => {
  const listings: MarketplaceListing[] = [
    makeListing({ id: 'l_pend', status: 'pending', platform: 'others', title: 'Discord Community' }),
    makeListing({ id: 'l_act', status: 'active', platform: 'youtube', title: 'YT Tech' }),
    makeListing({ id: 'l_res', status: 'reserved', platform: 'facebook', title: 'FB Page' }),
    makeListing({ id: 'l_sold', status: 'sold', platform: 'gaming', title: 'FF Max' }),
    makeListing({ id: 'l_rej', status: 'rejected', platform: 'others', rejectionReason: 'Incomplete info' }),
    makeListing({ id: 'l_susp', status: 'suspended', platform: 'tiktok' }),
  ];

  assert.equal(classifyAdminListingBucket('pending'), 'pending');
  assert.equal(classifyAdminListingBucket('active'), 'approved');
  assert.equal(classifyAdminListingBucket('reserved'), 'approved');
  assert.equal(classifyAdminListingBucket('sold'), 'approved');
  assert.equal(classifyAdminListingBucket('rejected'), 'rejected');
  assert.equal(classifyAdminListingBucket('suspended'), 'other');

  const pendingRes = filterAndBucketListings(listings, { bucket: 'pending' });
  assert.deepEqual(pendingRes.counts, { pending: 1, approved: 3, rejected: 1, other: 1 });
  assert.deepEqual(pendingRes.items.map((x) => x.id), ['l_pend']);

  const approvedRes = filterAndBucketListings(listings, { bucket: 'approved' });
  assert.deepEqual(approvedRes.items.map((x) => x.id).sort(), ['l_act', 'l_res', 'l_sold']);

  const othersRejected = filterAndBucketListings(listings, { bucket: 'rejected', platform: 'others', query: 'incomplete' });
  assert.deepEqual(othersRejected.items.map((x) => x.id), ['l_rej']);
});

test('filterAndBucketNids, Deposits, Withdrawals strictly isolate statuses and support search', () => {
  const nids: IdentityVerificationRecord[] = [
    { uid: 'u1', frontImageData: 'a', backImageData: 'b', status: 'pending_review' },
    { uid: 'u2', frontImageData: 'a', backImageData: 'b', status: 'verified', reviewedBy: 'admin1' },
    { uid: 'u3', frontImageData: 'a', backImageData: 'b', status: 'rejected', rejectionReason: 'Blurry NID' },
  ];
  const nidRes = filterAndBucketNids(nids, { bucket: 'rejected', query: 'blurry' });
  assert.deepEqual(nidRes.counts, { pending_review: 1, verified: 1, rejected: 1 });
  assert.deepEqual(nidRes.items.map((n) => n.uid), ['u3']);

  const deps: DepositRequestRecord[] = [
    { id: 'd1', userId: 'u1', userName: 'Arif', method: 'bkash', amountMinor: 50000, currency: 'BDT', senderNumber: '017', transactionId: 'TX1', status: 'pending', createdAtMs: 10 },
    { id: 'd2', userId: 'u2', userName: 'Babu', method: 'nagad', amountMinor: 80000, currency: 'BDT', senderNumber: '018', transactionId: 'TX2', status: 'approved', createdAtMs: 20 },
    { id: 'd3', userId: 'u3', userName: 'Chinu', method: 'rocket', amountMinor: 30000, currency: 'BDT', senderNumber: '019', transactionId: 'TX3', status: 'rejected', rejectionReason: 'Fake TrxID', createdAtMs: 30 },
  ];
  const depRes = filterAndBucketDeposits(deps, { bucket: 'approved', query: 'TX2' });
  assert.deepEqual(depRes.counts, { pending: 1, approved: 1, rejected: 1 });
  assert.deepEqual(depRes.items.map((d) => d.id), ['d2']);

  const wds: WithdrawalRequestRecord[] = [
    { id: 'w1', userId: 'u1', userName: 'Arif', method: 'bkash', payoutAccount: '017', amountMinor: 50000, currency: 'BDT', status: 'pending', createdAtMs: 10 },
    { id: 'w2', userId: 'u2', userName: 'Babu', method: 'nagad', payoutAccount: '018', amountMinor: 90000, currency: 'BDT', status: 'paid', referenceId: 'PAY99', createdAtMs: 20 },
    { id: 'w3', userId: 'u3', userName: 'Chinu', method: 'bank', payoutAccount: '123', amountMinor: 20000, currency: 'BDT', status: 'rejected', rejectionReason: 'Wrong acct', createdAtMs: 30 },
  ];
  const wdRes = filterAndBucketWithdrawals(wds, { bucket: 'paid', query: 'PAY99' });
  assert.deepEqual(wdRes.counts, { pending: 1, paid: 1, rejected: 1 });
  assert.deepEqual(wdRes.items.map((w) => w.id), ['w2']);
});

test('filterAndBucketAdminGovernance keeps pending/rejected invites strictly out of accepted admins', () => {
  const activeAdmins = [
    { uid: 'adm1', role: 'admin' as const, permissions: ['moderation'], displayName: 'Active Mod', updatedAtMs: 100 },
  ];
  const invites: AdminInvitationRecord[] = [
    { id: 'inv_u2', targetUid: 'u2', targetName: 'Pending Candidate', role: 'admin', permissions: ['moderation'], status: 'pending', invitedBy: 'super1', createdAtMs: 200 },
    { id: 'inv_u3', targetUid: 'u3', targetName: 'Declined Candidate', role: 'admin', permissions: ['moderation'], status: 'rejected', invitedBy: 'super1', rejectionReason: 'No time', createdAtMs: 150 },
    { id: 'inv_adm1', targetUid: 'adm1', targetName: 'Active Mod', role: 'admin', permissions: ['moderation'], status: 'pending', invitedBy: 'super1', createdAtMs: 50 },
  ];

  const res = filterAndBucketAdminGovernance(activeAdmins, invites, { bucket: 'pending' });
  assert.deepEqual(res.counts, { pending: 1, accepted: 1, rejected: 1 });
  assert.deepEqual(res.pendingInvites.map((i) => i.targetUid), ['u2']);
  assert.deepEqual(res.acceptedAdmins.map((a) => a.uid), ['adm1']);
  assert.deepEqual(res.rejectedInvites.map((i) => i.targetUid), ['u3']);
});

test('filterAdminDeals and paginateAdminItems handle tabs, search, and page clamping', () => {
  const now = 10_000_000;
  const deals: DealRecord[] = [
    {
      id: 'deal_ready',
      listingId: 'l1',
      listingTitle: 'Ready Channel',
      platform: 'youtube',
      buyerId: 'b1',
      buyerName: 'Buyer One',
      sellerId: 's1',
      sellerName: 'Seller One',
      baseAmountMinor: 10000,
      buyerFeePct: 5,
      sellerFeePct: 0,
      buyerFeeMinor: 500,
      sellerFeeMinor: 0,
      buyerTotalMinor: 10500,
      sellerPayoutMinor: 10000,
      platformCommissionMinor: 500,
      currency: 'BDT',
      protectionDurationHours: 40,
      confirmedAtMs: 1000,
      originalDeadlineMs: now - 1000,
      unresolvedReportCount: 0,
      status: 'security_period_active',
      createdAtMs: 500,
    },
    {
      id: 'deal_disp',
      listingId: 'l2',
      listingTitle: 'Disputed Store',
      platform: 'others',
      buyerId: 'b2',
      buyerName: 'Buyer Two',
      sellerId: 's2',
      sellerName: 'Seller Two',
      baseAmountMinor: 20000,
      buyerFeePct: 5,
      sellerFeePct: 0,
      buyerFeeMinor: 1000,
      sellerFeeMinor: 0,
      buyerTotalMinor: 21000,
      sellerPayoutMinor: 20000,
      platformCommissionMinor: 1000,
      currency: 'BDT',
      protectionDurationHours: 40,
      confirmedAtMs: 1000,
      originalDeadlineMs: now + 50000,
      unresolvedReportCount: 1,
      status: 'reported_under_review',
      createdAtMs: 600,
    },
  ];

  const readyRes = filterAdminDeals(deals, { tab: 'ready', nowMs: now });
  assert.equal(readyRes.counts.ready, 1);
  assert.equal(readyRes.counts.disputed, 1);
  assert.deepEqual(readyRes.items.map((d) => d.id), ['deal_ready']);

  const page = paginateAdminItems([1, 2, 3, 4, 5], 99, 2);
  assert.equal(page.page, 3);
  assert.equal(page.totalPages, 3);
  assert.deepEqual(page.items, [5]);
});
