import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSanitizedPayoutTickerPayload,
  buildSanitizedSoldTickerPayload,
  formatActivityRelativeTime,
  formatRecordedTickerAmount,
  generateOpaquePublicActivityId,
  isEligiblePaidWithdrawalForTicker,
  isEligibleSoldDealForTicker,
  mergeAndSortTickerItems,
  parseRawPublicActivityItem,
  resolvePublicActivityActorName,
} from './activityTickerLogic';
import { DealRecord, WithdrawalRequestRecord } from '../types';

const sampleSettledDeal: DealRecord = {
  id: 'deal_secret_991',
  listingId: 'lst_1',
  listingTitle: 'Monetized Tech YouTube Channel 120K Subs',
  platform: 'youtube',
  buyerId: 'buyer_uid_1',
  buyerName: 'Buyer One',
  sellerId: 'seller_uid_1',
  sellerName: 'Arif Digital',
  baseAmountMinor: 1550000, // 15,500 BDT
  buyerFeePct: 5,
  sellerFeePct: 0,
  buyerFeeMinor: 77500,
  sellerFeeMinor: 0,
  buyerTotalMinor: 1627500,
  sellerPayoutMinor: 1550000,
  platformCommissionMinor: 77500,
  currency: 'BDT',
  protectionDurationHours: 168,
  confirmedAtMs: 1700000000000,
  originalDeadlineMs: 1700604800000,
  unresolvedReportCount: 0,
  settledAtMs: 1700605000000,
  status: 'settled',
  createdAtMs: 1699990000000,
};

const samplePaidWithdrawal: WithdrawalRequestRecord = {
  id: 'wd_secret_882',
  userId: 'seller_uid_1',
  userName: 'Arif Digital',
  method: 'bkash',
  payoutAccount: '01712345678',
  amountMinor: 500000, // 5,000 BDT
  currency: 'BDT',
  status: 'paid',
  referenceId: 'TRX998877',
  reviewedBy: 'admin_1',
  reviewedAtMs: 1700610000000,
  createdAtMs: 1700608000000,
};

test('Ticker Eligibility: strictly accepts only settled deals and paid withdrawals', () => {
  assert.equal(isEligibleSoldDealForTicker(sampleSettledDeal), true);
  assert.equal(
    isEligibleSoldDealForTicker({ ...sampleSettledDeal, status: 'security_period_active' }),
    false
  );
  assert.equal(isEligibleSoldDealForTicker({ ...sampleSettledDeal, status: 'refunded' }), false);
  assert.equal(isEligibleSoldDealForTicker({ ...sampleSettledDeal, status: 'cancelled' }), false);
  assert.equal(
    isEligibleSoldDealForTicker({ ...sampleSettledDeal, status: 'accepted_pending_payment' }),
    false
  );

  assert.equal(isEligiblePaidWithdrawalForTicker(samplePaidWithdrawal), true);
  assert.equal(
    isEligiblePaidWithdrawalForTicker({ ...samplePaidWithdrawal, status: 'pending' }),
    false
  );
  assert.equal(
    isEligiblePaidWithdrawalForTicker({ ...samplePaidWithdrawal, status: 'rejected' }),
    false
  );
});

test('Privacy & Sanitization: respects hidePublicActivityName and strips emails, phones, and payout accounts', () => {
  assert.equal(
    resolvePublicActivityActorName({
      displayName: 'Arif Digital',
      nidVerified: true,
      hidePublicActivityName: true,
    }),
    'Verified Seller'
  );
  assert.equal(
    resolvePublicActivityActorName({
      displayName: 'Arif Digital',
      nidVerified: false,
      hidePublicActivityName: true,
    }),
    'BEXORA User'
  );
  assert.equal(
    resolvePublicActivityActorName({
      displayName: 'arif@gmail.com +8801712345678',
      nidVerified: true,
      hidePublicActivityName: false,
    }),
    'Verified Seller'
  );

  const payoutPayload = buildSanitizedPayoutTickerPayload({
    withdrawal: samplePaidWithdrawal,
    userDisplayName: 'Arif Digital',
    userNidVerified: true,
    hidePublicActivityName: false,
  });
  assert.ok(payoutPayload);
  const serialized = JSON.stringify(payoutPayload);
  assert.doesNotMatch(serialized, /01712345678/);
  assert.doesNotMatch(serialized, /TRX998877/);
  assert.doesNotMatch(serialized, /seller_uid_1/);
  assert.doesNotMatch(serialized, /wd_secret_882/);

  const opaqueId = generateOpaquePublicActivityId(1700610000000);
  assert.match(opaqueId, /^act_1700610000000_[a-z0-9]+$/);
});

test('Sold Payload, Formatting, Deduplication & Relative Time: preserves recorded currency and orders newest first', () => {
  const soldPayload = buildSanitizedSoldTickerPayload({
    deal: sampleSettledDeal,
    sellerDisplayName: 'Arif Digital',
    sellerNidVerified: true,
  });
  assert.ok(soldPayload);
  assert.equal(soldPayload.kind, 'sold');
  assert.equal(soldPayload.amountMinor, 1550000);
  assert.equal(soldPayload.currency, 'BDT');
  assert.equal(formatRecordedTickerAmount(1550000, 'BDT'), '৳15,500');
  assert.equal(formatRecordedTickerAmount(25000, 'USD'), '$250');

  const now = 1700610000000;
  assert.equal(formatActivityRelativeTime(now - 10_000, now), 'Just now');
  assert.equal(formatActivityRelativeTime(now - 5 * 60_000, now), '5m ago');
  assert.equal(formatActivityRelativeTime(now - 3 * 3600_000, now), '3h ago');
  assert.equal(formatActivityRelativeTime(now + 15_000, now), 'Just now');

  const parsedA = parseRawPublicActivityItem('act_1', { ...soldPayload, completedAtMs: 1000 });
  const parsedB = parseRawPublicActivityItem('act_2', { ...soldPayload, completedAtMs: 3000 });
  const parsedADup = parseRawPublicActivityItem('act_1', { ...soldPayload, completedAtMs: 2000 });
  assert.ok(parsedA && parsedB && parsedADup);

  const merged = mergeAndSortTickerItems([parsedA, parsedB, parsedADup], 10);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'act_2');
  assert.equal(merged[1].id, 'act_1');
  assert.equal(merged[1].completedAtMs, 2000);
});
