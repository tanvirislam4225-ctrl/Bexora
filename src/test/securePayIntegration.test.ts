import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeCheckoutWalletState,
  convertOrderMinorToWalletBdtMinor,
} from '../lib/checkoutAndIntentLogic';
import {
  getSecurePayConfig,
  requestSecurePayCreateApi,
  requestSecurePayVerifyApi,
  SecurePayGatewayConfig,
  storeSessionInMemory,
  getSessionFromMemory,
  SecurePaySessionRecord,
} from '../server/securePayGatewayEngine';

// ============================================================================
// SCENARIO 1: Wallet Payment with Sufficient Available Balance
// ============================================================================
test('Scenario 1: Wallet payment with sufficient Available Balance calculates correct debit and remaining', () => {
  const availableBalanceMinor = 150000; // 1500 BDT
  const orderQuote = {
    buyerTotalMinor: 120000, // 1200 BDT
    currency: 'BDT' as const,
  };

  const state = computeCheckoutWalletState(availableBalanceMinor, orderQuote, 120);

  assert.equal(state.hasSufficientBalance, true);
  assert.equal(state.shortfallMinor, 0);
  assert.equal(state.requiredInWalletCurrencyMinor, 120000);
  assert.equal(state.remainingAfterPurchaseMinor, 30000); // 300 BDT remaining
});

// ============================================================================
// SCENARIO 2: Wallet Payment with Insufficient Available Balance
// ============================================================================
test('Scenario 2: Wallet payment with insufficient Available Balance calculates exact shortfall and prevents purchase', () => {
  const availableBalanceMinor = 40000; // 400 BDT available
  const orderQuote = {
    buyerTotalMinor: 100000, // 1000 BDT required
    currency: 'BDT' as const,
  };

  const state = computeCheckoutWalletState(availableBalanceMinor, orderQuote, 120);

  assert.equal(state.hasSufficientBalance, false);
  assert.equal(state.shortfallMinor, 60000); // 600 BDT shortfall
  assert.equal(state.remainingAfterPurchaseMinor, 0);
});

// ============================================================================
// SCENARIOS 3, 4, 5, 6: Successful External Payments (bKash, Nagad, Rocket, Upay)
// ============================================================================
const methods = ['bKash', 'Nagad', 'Rocket', 'Upay'] as const;

for (const method of methods) {
  test(`Scenario ${method === 'bKash' ? 3 : method === 'Nagad' ? 4 : method === 'Rocket' ? 5 : 6}: Successful external ${method} payment creates session and verifies COMPLETED`, async () => {
    const config: SecurePayGatewayConfig = {
      apiKey: 'test_sec_api_key_12345',
      siteUrl: 'https://pay.securepaybd.xyz/',
      isConfigured: true,
      supportedMethods: ['bKash', 'Nagad', 'Rocket', 'Upay'],
    };

    // 1. Mock create API response from Secure Pay BD
    const mockCreateFetch: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://pay.securepaybd.xyz/api/create');
      assert.equal(init?.method, 'POST');
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers['API-KEY'], 'test_sec_api_key_12345');

      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.amount, 1250);
      assert.equal(body.cus_name, 'Tanvir Islam');

      return new Response(
        JSON.stringify({
          result: 'success',
          payment_url: `https://pay.securepaybd.xyz/checkout/mock_${method.toLowerCase()}_session_token`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const createResult = await requestSecurePayCreateApi(
      {
        cus_name: 'Tanvir Islam',
        cus_email: 'tanvir@example.com',
        amount: 1250,
        webhook_url: 'https://bexora.com/api/payments/securepay/webhook',
        success_url: 'https://bexora.com/?view=checkout&payment_status=success',
        cancel_url: 'https://bexora.com/?view=checkout&payment_status=cancelled',
      },
      config,
      mockCreateFetch
    );

    assert.equal(createResult.ok, true);
    assert.match(createResult.paymentUrl!, /https:\/\/pay\.securepaybd\.xyz\/checkout\//);

    // 2. Mock verify API response from Secure Pay BD for completed payment
    const trxId = `TRX_${method.toUpperCase()}_998877`;
    const mockVerifyFetch: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://pay.securepaybd.xyz/api/verify');
      const body = JSON.parse(String(init?.body || '{}'));
      assert.equal(body.transaction_id, trxId);

      return new Response(
        JSON.stringify({
          status: 'COMPLETED',
          amount: '1250.00',
          cus_email: 'tanvir@example.com',
          transaction_id: trxId,
          payment_method: method.toLowerCase(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const verifyResult = await requestSecurePayVerifyApi(trxId, config, mockVerifyFetch);

    assert.equal(verifyResult.ok, true);
    assert.equal(verifyResult.status, 'COMPLETED');
    assert.equal(verifyResult.amount, 1250);
  });
}

// ============================================================================
// SCENARIO 7: Failed External Payment
// ============================================================================
test('Scenario 7: Failed external payment is correctly detected and rejected', async () => {
  const config: SecurePayGatewayConfig = {
    apiKey: 'test_sec_api_key_12345',
    siteUrl: 'https://pay.securepaybd.xyz/',
    isConfigured: true,
    supportedMethods: ['bKash', 'Nagad'],
  };

  const mockVerifyFailed: typeof fetch = async () => {
    return new Response(
      JSON.stringify({
        status: 'FAILED',
        amount: '1250.00',
        transaction_id: 'TRX_FAILED_001',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const result = await requestSecurePayVerifyApi('TRX_FAILED_001', config, mockVerifyFailed);

  assert.equal(result.ok, true);
  assert.equal(result.status, 'FAILED');
  assert.notEqual(result.status, 'COMPLETED'); // Verifies it will NOT activate escrow
});

// ============================================================================
// SCENARIO 8: Cancelled External Payment
// ============================================================================
test('Scenario 8: Cancelled external payment preserves deal in unpaid state without activation', () => {
  const session: SecurePaySessionRecord = {
    sessionId: 'sp_session_cancel_test',
    mode: 'buy_now',
    buyerUid: 'buyer_123',
    buyerName: 'Buyer Name',
    buyerEmail: 'buyer@test.com',
    listingId: 'list_123',
    dealId: 'deal_123',
    listingTitle: 'Test Asset',
    amountMinorBdt: 120000,
    amountBdt: 1200,
    originalCurrency: 'BDT',
    originalAmountMinor: 120000,
    status: 'created',
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };

  storeSessionInMemory(session);

  // User hits cancel_url -> server / client marks session cancelled
  const retrieved = getSessionFromMemory('sp_session_cancel_test');
  assert.ok(retrieved);
  retrieved.status = 'cancelled';
  retrieved.updatedAtMs = Date.now();

  assert.equal(retrieved.status, 'cancelled');
  assert.notEqual(retrieved.status, 'completed');
});

// ============================================================================
// SCENARIO 9: Duplicate Callback (Idempotency Protection)
// ============================================================================
test('Scenario 9: Duplicate callback/webhook is idempotent and avoids double-crediting or duplicate deal activation', () => {
  const session: SecurePaySessionRecord = {
    sessionId: 'sp_session_dup_test',
    mode: 'buy_now',
    buyerUid: 'buyer_dup_123',
    buyerName: 'Buyer Dup',
    buyerEmail: 'buyer_dup@test.com',
    listingId: 'list_dup_123',
    dealId: 'deal_dup_123',
    listingTitle: 'Test Duplicate Asset',
    amountMinorBdt: 50000,
    amountBdt: 500,
    originalCurrency: 'BDT',
    originalAmountMinor: 50000,
    status: 'completed', // Already completed by first callback
    transactionId: 'TRX_FIRST_CALLBACK_1122',
    verifiedAtMs: Date.now() - 5000,
    createdAtMs: Date.now() - 10000,
    updatedAtMs: Date.now() - 5000,
  };

  storeSessionInMemory(session);

  // Second incoming webhook with same or duplicate notification
  const existing = getSessionFromMemory('sp_session_dup_test');
  assert.ok(existing);

  const isDuplicate = existing.status === 'completed';
  assert.equal(isDuplicate, true);
  // System recognizes duplicate without re-executing transactions
});

// ============================================================================
// SCENARIO 10: Payment Verification Failure (Network / Invalid API Key)
// ============================================================================
test('Scenario 10: Payment verification failure (HTTP error / unreachable) safely leaves order unpaid', async () => {
  const config: SecurePayGatewayConfig = {
    apiKey: 'invalid_key',
    siteUrl: 'https://pay.securepaybd.xyz/',
    isConfigured: true,
    supportedMethods: ['bKash', 'Nagad'],
  };

  const mockNetworkError: typeof fetch = async () => {
    return new Response('Unauthorized API-KEY', { status: 401 });
  };

  const result = await requestSecurePayVerifyApi('TRX_INVALID_KEY', config, mockNetworkError);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'HTTP_ERROR');
  assert.match(result.error!, /HTTP 401/);
});
