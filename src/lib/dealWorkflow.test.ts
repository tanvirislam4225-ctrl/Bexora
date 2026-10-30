import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PUBLIC_SETTINGS,
  calculateAcceptedBidDealFinancials,
  calculateDisputeRefundBreakdown,
  calculateProtectionDeadline,
  canAutoReleaseEscrow,
  canTransitionDealStatus,
  computeRemainingProtectionMs,
  getActiveBids,
  getBidStatusLabel,
  getDealStatusLabel,
  getHighestActiveBidMinor,
  getProtectionDurationHours,
  isBidAcceptedStatus,
  isBidActive,
  validateBidSubmission,
  validateBuyerTransferRejection,
  validateDealReportInput,
  validateTransferSubmissionInput,
} from './marketplaceLogic';
import {
  buildNotificationId,
  evaluateDealDeadlineNotification,
  sanitizeNotificationDestination,
} from './notificationLogic';

test('PART 1: Bid acceptance updates status to accepted_pending_payment without disappearing and blocks competing bids', () => {
  const bids = [
    { id: 'bid_1', buyerId: 'buyer_a', amountMinor: 8_000, status: 'pending', createdAtMs: 1000 },
    {
      id: 'bid_2',
      buyerId: 'buyer_b',
      amountMinor: 10_000,
      status: 'accepted_pending_payment',
      createdAtMs: 2000,
    },
  ];

  // Accepted bid remains visible in active bids and preserves exact amount
  const active = getActiveBids(bids);
  assert.equal(active.length, 2);
  assert.equal(active[0].id, 'bid_2');
  assert.equal(active[0].amountMinor, 10_000);
  assert.equal(isBidAcceptedStatus('accepted_pending_payment'), true);
  assert.equal(isBidAcceptedStatus('accepted'), true);
  assert.equal(isBidAcceptedStatus('paid'), true);
  assert.equal(isBidActive('accepted_pending_payment'), true);
  assert.equal(getHighestActiveBidMinor(bids), 10_000);
  assert.equal(getBidStatusLabel('accepted_pending_payment'), 'Accepted — Pending Payment');

  // Competing bid while an accepted bid is pending payment MUST be blocked
  const competingAttempt = validateBidSubmission(12_000, bids, 'buyer_c');
  assert.equal(competingAttempt.valid, false);
  assert.match(competingAttempt.error || '', /already been accepted/);
});

test('PART 2: Accepted-bid payment uses exact accepted bid price (not listing price) + 5% buyer fee (100 BDT -> 105 BDT)', () => {
  assert.equal(DEFAULT_PUBLIC_SETTINGS.buyerFeePct, 5);
  assert.equal(DEFAULT_PUBLIC_SETTINGS.buyerFeeEnabled, true);

  // Listing was 150 BDT (15,000 minor), accepted bid is 100 BDT (10,000 minor)
  const snapshot = calculateAcceptedBidDealFinancials(
    10_000,
    {
      buyerFeeEnabled: true,
      buyerFeePct: 5,
      sellerFeeEnabled: true,
      sellerFeePct: 5,
    },
    15_000
  );

  assert.equal(snapshot.originalListingPriceMinor, 15_000);
  assert.equal(snapshot.baseAmountMinor, 10_000); // Strictly accepted bid 100 BDT, NOT 150 BDT!
  assert.equal(snapshot.buyerFeePct, 5);
  assert.equal(snapshot.buyerFeeMinor, 500); // 5 BDT
  assert.equal(snapshot.buyerTotalMinor, 10_500); // 105 BDT
  assert.equal(snapshot.sellerPayoutMinor, 9_500); // 95 BDT
  assert.equal(snapshot.refundBuyerMinor, 10_200); // 102 BDT
  assert.equal(snapshot.refundPlatformRetainedMinor, 300); // 3 BDT
});

test('PART 4 & 5: Seller transfer submission enforces 2-3 valid screenshots, safe notes, checklist, and buyer rejection reason', () => {
  const validShot1 = 'data:image/jpeg;base64,' + 'A'.repeat(60);
  const validShot2 = 'data:image/jpeg;base64,' + 'B'.repeat(60);
  const validShot3 = 'data:image/jpeg;base64,' + 'C'.repeat(60);
  const validShot4 = 'data:image/jpeg;base64,' + 'D'.repeat(60);

  // Only 1 screenshot -> rejected
  assert.equal(
    validateTransferSubmissionInput({
      screenshots: [validShot1],
      transferNote: 'Sent Primary Owner invite in Studio.',
      completedSteps: ['Step 1 completed'],
    }).valid,
    false
  );

  // 4 screenshots -> rejected
  assert.equal(
    validateTransferSubmissionInput({
      screenshots: [validShot1, validShot2, validShot3, validShot4],
      transferNote: 'Sent Primary Owner invite in Studio.',
      completedSteps: ['Step 1 completed'],
    }).valid,
    false
  );

  // Raw password or phone number in transfer note -> rejected by safety filter
  assert.equal(
    validateTransferSubmissionInput({
      screenshots: [validShot1, validShot2],
      transferNote: 'Call me on +8801712345678 to finish',
      completedSteps: ['Step 1 completed'],
    }).valid,
    false
  );

  // 2 or 3 screenshots + clean note + completed checklist -> accepted
  const ok2 = validateTransferSubmissionInput({
    screenshots: [validShot1, validShot2],
    transferNote: 'Invited buyer account as Brand Account Owner and attached confirmation screenshots.',
    completedSteps: ['Invited buyer as Brand Owner', 'Verified monetization status'],
  });
  assert.equal(ok2.valid, true);
  assert.equal(ok2.cleanSteps.length, 2);

  const ok3 = validateTransferSubmissionInput({
    screenshots: [validShot1, validShot2, validShot3],
    transferNote: 'Resubmitted updated Page Full Control invitation screenshots.',
    completedSteps: ['Sent Full Control Admin invite'],
  });
  assert.equal(ok3.valid, true);

  // Buyer rejection requires written reason >= 5 chars
  assert.equal(validateBuyerTransferRejection('no').valid, false);
  assert.equal(
    validateBuyerTransferRejection('Admin invite screenshot shows Editor role instead of Full Control.').valid,
    true
  );
});

test('PART 6: Asset-specific security timer enforces 7 days (168h) for YouTube and 40 hours for Facebook & other assets', () => {
  // Even if legacy settings had 48 stored without customProtectionWindowsEnabled, policy enforces 168h / 40h
  const legacySettings = {
    ...DEFAULT_PUBLIC_SETTINGS,
    protectionHoursYoutube: 168,
    protectionHoursFacebook: 48,
    protectionHoursDefault: 48,
    customProtectionWindowsEnabled: false,
  };

  assert.equal(getProtectionDurationHours('youtube', legacySettings), 168);
  assert.equal(getProtectionDurationHours('facebook', legacySettings), 40);
  assert.equal(getProtectionDurationHours('instagram', legacySettings), 40);
  assert.equal(getProtectionDurationHours('tiktok', legacySettings), 40);
  assert.equal(getProtectionDurationHours('telegram', legacySettings), 40);
  assert.equal(getProtectionDurationHours('website', legacySettings), 40);
  assert.equal(getProtectionDurationHours('domain', legacySettings), 40);
  assert.equal(getProtectionDurationHours('gaming', legacySettings), 40);

  // Explicit admin override is respected when customProtectionWindowsEnabled === true
  const customAdminSettings = {
    ...legacySettings,
    protectionHoursFacebook: 72,
    customProtectionWindowsEnabled: true,
  };
  assert.equal(getProtectionDurationHours('facebook', customAdminSettings), 72);

  // Verify exact millisecond math for 7 days (168h) and 40 hours
  const t0 = Date.UTC(2026, 9, 29, 12, 0, 0);
  assert.equal(calculateProtectionDeadline(t0, 168) - t0, 7 * 24 * 3_600_000);
  assert.equal(calculateProtectionDeadline(t0, 40) - t0, 40 * 3_600_000);
});

test('PART 7: Dispute report validation & non-extension of security timer across reports', () => {
  assert.equal(
    validateDealReportInput({
      category: 'ownership_not_transferred',
      reason: 'Seller only sent Analyst role instead of Primary Owner access.',
      evidenceImages: [],
    }).valid,
    true
  );
  assert.equal(
    validateDealReportInput({
      category: 'invalid_cat',
      reason: 'Valid length explanation here.',
    }).valid,
    false
  );

  // Timer never extends when report is submitted and later dismissed
  const approvedAt = 1_700_000_000_000;
  const originalDeadline = calculateProtectionDeadline(approvedAt, 40);
  const reportFiledAt = approvedAt + 10 * 3_600_000;
  const adminContinuedAt = approvedAt + 25 * 3_600_000;

  // Remaining time at hour 25 is strictly 15 hours (never 40 hours or 30 hours!)
  assert.equal(computeRemainingProtectionMs(originalDeadline, reportFiledAt), 30 * 3_600_000);
  assert.equal(computeRemainingProtectionMs(originalDeadline, adminContinuedAt), 15 * 3_600_000);

  // Auto-release blocked while reported_under_review even past deadline
  assert.equal(
    canAutoReleaseEscrow(
      {
        status: 'reported_under_review',
        originalDeadlineMs: originalDeadline,
        unresolvedReportCount: 1,
      },
      originalDeadline + 10_000
    ),
    false
  );

  // Eligible once security_period_active elapsed with 0 unresolved reports
  assert.equal(
    canAutoReleaseEscrow(
      {
        status: 'security_period_active',
        originalDeadlineMs: originalDeadline,
        unresolvedReportCount: 0,
      },
      originalDeadline
    ),
    true
  );
});

test('PART 8: Dispute Rejection Refund Formula enforces exact 102 BDT refund & 3 BDT retained commission on 100 BDT + 5% fee deal', () => {
  // 100 BDT = 10,000 poisha; 5% fee = 500 poisha; total paid = 10,500 poisha (105 BDT)
  const r100 = calculateDisputeRefundBreakdown({
    baseAmountMinor: 10_000,
    buyerFeeMinor: 500,
    buyerTotalMinor: 10_500,
  });
  assert.equal(r100.originalBuyerPaymentMinor, 10_500); // 105 BDT
  assert.equal(r100.buyerRefundMinor, 10_200); // 102 BDT
  assert.equal(r100.platformRetainedCommissionMinor, 300); // 3 BDT
  assert.equal(r100.sellerPayoutMinor, 0);
  assert.equal(r100.buyerRefundMinor + r100.platformRetainedCommissionMinor, r100.originalBuyerPaymentMinor);

  // Larger deal: 2,500 BDT (250,000 minor) + 5% fee (12,500 minor = 125 BDT) -> Total 2,625 BDT
  // Buyer refund = 2,500 + 50 (2%) = 2,550 BDT (255,000 minor); Platform retained = 75 BDT (7,500 minor = 3%)
  const r2500 = calculateDisputeRefundBreakdown({
    baseAmountMinor: 250_000,
    buyerFeeMinor: 12_500,
    buyerTotalMinor: 262_500,
  });
  assert.equal(r2500.buyerRefundMinor, 255_000);
  assert.equal(r2500.platformRetainedCommissionMinor, 7_500);

  // Safety clamp when fee was 0%: never refunds more than buyer paid
  const rZeroFee = calculateDisputeRefundBreakdown({
    baseAmountMinor: 10_000,
    buyerFeeMinor: 0,
    buyerTotalMinor: 10_000,
  });
  assert.equal(rZeroFee.buyerRefundMinor, 10_000);
  assert.equal(rZeroFee.platformRetainedCommissionMinor, 0);
});

test('PART 9 & 10: Deal State Machine blocks invalid/unauthorized role transitions and terminal mutations', () => {
  // Buyer cannot skip payment to security_period_active or settle deal directly
  assert.equal(canTransitionDealStatus('accepted_pending_payment', 'security_period_active', 'buyer'), false);
  assert.equal(canTransitionDealStatus('paid_deal_room_active', 'settled', 'buyer'), false);
  assert.equal(canTransitionDealStatus('security_period_active', 'refunded', 'buyer'), false);

  // Seller cannot mark transfer approved or release own payout
  assert.equal(canTransitionDealStatus('transfer_submitted', 'security_period_active', 'seller'), false);
  assert.equal(canTransitionDealStatus('security_period_active', 'settled', 'seller'), false);

  // Valid lifecycle flow:
  // 1) Buyer pays accepted_pending_payment -> paid_deal_room_active
  assert.equal(canTransitionDealStatus('accepted_pending_payment', 'paid_deal_room_active', 'buyer'), true);
  // 2) Seller submits transfer -> transfer_submitted
  assert.equal(canTransitionDealStatus('paid_deal_room_active', 'transfer_submitted', 'seller'), true);
  // 3a) Buyer rejects transfer -> transfer_rejected -> Seller resubmits -> transfer_submitted
  assert.equal(canTransitionDealStatus('transfer_submitted', 'transfer_rejected', 'buyer'), true);
  assert.equal(canTransitionDealStatus('transfer_rejected', 'transfer_submitted', 'seller'), true);
  // 3b) Buyer approves transfer -> security_period_active
  assert.equal(canTransitionDealStatus('transfer_submitted', 'security_period_active', 'buyer'), true);
  // 4) Admin cannot refund or settle an UNPAID deal
  assert.equal(canTransitionDealStatus('accepted_pending_payment', 'refunded', 'admin'), false);
  assert.equal(canTransitionDealStatus('accepted_pending_payment', 'settled', 'admin'), false);
  // 5) Admin CAN refund or settle a funded deal, and once terminal, no further transitions are allowed
  assert.equal(canTransitionDealStatus('reported_under_review', 'refunded', 'admin'), true);
  assert.equal(canTransitionDealStatus('security_period_active', 'settled', 'admin'), true);
  assert.equal(canTransitionDealStatus('refunded', 'settled', 'admin'), false);
  assert.equal(canTransitionDealStatus('settled', 'refunded', 'admin'), false);

  assert.equal(getDealStatusLabel('transfer_submitted'), 'Transfer Evidence Submitted — Awaiting Buyer Review');
});

test('PART 11: Notification deduplication and security_period_active deadline evaluation', () => {
  const id1 = buildNotificationId('buyer_123', 'transfer_submitted_deal_abc_v1');
  const id2 = buildNotificationId('buyer_123', 'transfer_submitted_deal_abc_v1');
  assert.equal(id1, id2);

  const dest = sanitizeNotificationDestination('admindeal:deal_xyz_123');
  assert.ok(dest);
  assert.equal(dest.view, 'admin');
  assert.equal(dest.targetId, 'deal_xyz_123');

  const deadline = 1_800_000_000_000;
  const deal = {
    id: 'deal_xyz_123',
    status: 'security_period_active' as const,
    originalDeadlineMs: deadline,
    listingTitle: 'Verified Monetized YouTube Channel',
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    unresolvedReportCount: 0,
  };

  // 3 hours before deadline -> warning notification
  const soon = evaluateDealDeadlineNotification(deal, deadline - 3 * 3_600_000);
  assert.ok(soon);
  assert.equal(soon.severity, 'warning');

  // Past deadline -> completed notification
  const done = evaluateDealDeadlineNotification(deal, deadline + 1_000);
  assert.ok(done);
  assert.match(done.title, /Security Protection Period Completed/);
});
