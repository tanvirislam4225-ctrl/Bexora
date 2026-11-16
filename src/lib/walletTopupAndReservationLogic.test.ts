import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSafeDealDeletionUpdate,
  buildTopupLedgerId,
  canAcquireListingReservation,
  computeReservationCountdown,
  CUSTOMER_GATEWAY_UNAVAILABLE_MESSAGE,
  DEFAULT_GATEWAY_DISPLAY_METHODS,
  generateDealCode,
  hasForbiddenDeveloperCopy,
  isListingReservationActive,
  LISTING_RESERVATION_TTL_MS,
  matchesAdminDealQuery,
  moveGatewayDisplayMethod,
  normalizeGatewayPaymentMethods,
  sanitizeCustomerGatewayError,
  shouldRecordLatePaymentReconciliation,
  toggleGatewayDisplayMethod,
  upsertGatewayDisplayMethod,
  validateWalletTopupAmountBdt,
  verifyGatewayPaidAmountMatchesSession,
} from './walletTopupAndReservationLogic.ts';

test('gateway display methods normalize, upsert, toggle, and reorder cleanly', () => {
  const defaults = normalizeGatewayPaymentMethods(undefined);
  assert.equal(defaults.length, DEFAULT_GATEWAY_DISPLAY_METHODS.length);
  assert.equal(defaults[0].name, 'bKash');

  const added = upsertGatewayDisplayMethod(defaults, {
    id: 'upay',
    name: 'Upay',
    badge: 'Mobile Wallet',
    color: '#FFC700',
    enabled: true,
  });
  assert.equal(added.length, 5);
  assert.equal(added[4].order, 4);

  const toggled = toggleGatewayDisplayMethod(added, 'upay');
  assert.equal(toggled[4].enabled, false);

  const moved = moveGatewayDisplayMethod(toggled, 'upay', 'up');
  assert.equal(moved[3].id, 'upay');
  assert.equal(moved[3].order, 3);
  assert.equal(moved[4].order, 4);
});

test('sanitizeCustomerGatewayError strips all forbidden developer and plugin strings', () => {
  const forbiddenSamples = [
    'Payment plugin not installed on server',
    'You need to add the plugin first',
    'Gateway will be added later',
    'WordPress integration is not configured yet',
    'SECUREPAY_API_KEY is not configured in environment.',
    'Manual Deposits Updating',
    'mock_gateway=1 fallback triggered',
  ];
  for (const sample of forbiddenSamples) {
    assert.equal(hasForbiddenDeveloperCopy(sample), true);
    const sanitized = sanitizeCustomerGatewayError(sample);
    assert.equal(sanitized, CUSTOMER_GATEWAY_UNAVAILABLE_MESSAGE);
    assert.equal(hasForbiddenDeveloperCopy(sanitized), false);
  }
  assert.equal(
    sanitizeCustomerGatewayError('Minimum wallet top-up is ৳10 BDT.'),
    'Minimum wallet top-up is ৳10 BDT.'
  );
});

test('wallet top-up validation enforces whole positive BDT bounds and builds deterministic ledger ID', () => {
  assert.equal(validateWalletTopupAmountBdt(0).valid, false);
  assert.equal(validateWalletTopupAmountBdt(-100).valid, false);
  assert.equal(validateWalletTopupAmountBdt(5).valid, false);
  assert.equal(validateWalletTopupAmountBdt(100.5).valid, false);

  const ok = validateWalletTopupAmountBdt(1500);
  assert.equal(ok.valid, true);
  assert.equal(ok.amountBdt, 1500);
  assert.equal(ok.amountMinor, 150000);
  assert.equal(buildTopupLedgerId('sptop_123'), 'led_topup_sptop_123');
});

test('gateway verification requires COMPLETED status AND exact amount match', () => {
  assert.equal(
    verifyGatewayPaidAmountMatchesSession({
      expectedBdt: 1000,
      returnedAmountBdt: 1000,
      gatewayStatus: 'COMPLETED',
    }).verified,
    true
  );
  assert.equal(
    verifyGatewayPaidAmountMatchesSession({
      expectedBdt: 1000,
      returnedAmountBdt: 1000,
      gatewayStatus: 'PENDING',
    }).verified,
    false
  );
  assert.equal(
    verifyGatewayPaidAmountMatchesSession({
      expectedBdt: 1000,
      returnedAmountBdt: 500,
      gatewayStatus: 'COMPLETED',
    }).verified,
    false
  );
});

test('15-minute listing reservation acquire, countdown, expiration, and late reconciliation', () => {
  const nowMs = 1_700_000_000_000;
  assert.equal(LISTING_RESERVATION_TTL_MS, 900_000);

  // Active listing can be acquired by anyone
  assert.deepEqual(canAcquireListingReservation({ status: 'active' }, 'buyer_1', nowMs), {
    allowed: true,
    shouldExpireExisting: false,
  });

  // Active reservation blocks other buyer, allows same buyer
  const activeReserved = {
    status: 'reserved',
    reservedBuyerId: 'buyer_1',
    reservedUntilMs: nowMs + 600_000,
  };
  assert.equal(isListingReservationActive(activeReserved, nowMs), true);
  assert.equal(canAcquireListingReservation(activeReserved, 'buyer_1', nowMs).allowed, true);
  assert.equal(canAcquireListingReservation(activeReserved, 'buyer_2', nowMs).allowed, false);

  // Expired reservation can be reclaimed by buyer_2
  const expiredReserved = {
    status: 'reserved',
    reservedBuyerId: 'buyer_1',
    reservedUntilMs: nowMs - 1000,
  };
  assert.equal(isListingReservationActive(expiredReserved, nowMs), false);
  assert.deepEqual(canAcquireListingReservation(expiredReserved, 'buyer_2', nowMs), {
    allowed: true,
    shouldExpireExisting: true,
  });

  // Countdown formatting
  const cd = computeReservationCountdown(nowMs + 125_000, nowMs);
  assert.equal(cd.active, true);
  assert.equal(cd.expired, false);
  assert.equal(cd.formatted, '02:05');

  const cdExp = computeReservationCountdown(nowMs - 500, nowMs);
  assert.equal(cdExp.active, false);
  assert.equal(cdExp.expired, true);
  assert.equal(cdExp.formatted, '00:00');

  // Late reconciliation detection
  assert.equal(
    shouldRecordLatePaymentReconciliation({
      listingStatus: 'sold',
      reservationSessionId: 'sp_new',
      sessionId: 'sp_old',
      reservedBuyerId: 'buyer_2',
      buyerId: 'buyer_1',
    }),
    true
  );
  assert.equal(
    shouldRecordLatePaymentReconciliation({
      listingStatus: 'active',
      reservationSessionId: null,
      sessionId: 'sp_old',
      reservedBuyerId: null,
      buyerId: 'buyer_1',
    }),
    false
  );
});

test('deal code generation, admin search matching, and safe deletion payload', () => {
  const code = generateDealCode('deal_abc_123', 1_700_000_000_000);
  assert.match(code, /^BXR-[A-Z0-9]{6}$/);

  const sampleDeal = {
    id: 'deal_abc_123',
    dealCode: code,
    listingId: 'lst_1',
    listingTitle: 'Monetized Tech Channel',
    buyerName: 'Rahim',
    buyerId: 'u_buyer',
    sellerName: 'Karim',
    sellerId: 'u_seller',
    platform: 'youtube' as const,
    status: 'paid_deal_room_active' as const,
    createdAtMs: 1_700_000_000_000,
  };

  assert.equal(matchesAdminDealQuery(sampleDeal, code.toLowerCase()), true);
  assert.equal(matchesAdminDealQuery(sampleDeal, 'rahim'), true);
  assert.equal(matchesAdminDealQuery(sampleDeal, 'nonexistent'), false);

  const del = buildSafeDealDeletionUpdate({
    actorUid: 'admin_1',
    reason: 'Duplicate unpaid reservation cleanup',
    nowMs: 1_700_000_123_000,
  });
  assert.equal(del.isDeleted, true);
  assert.equal(del.deletedBy, 'admin_1');
  assert.equal(del.deletedAtMs, 1_700_000_123_000);
});
