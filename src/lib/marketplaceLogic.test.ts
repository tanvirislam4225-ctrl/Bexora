import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCommission,
  calculateProtectionDeadline,
  computeRemainingProtectionMs,
  canAutoReleaseEscrow,
  validateAccountAge,
  formatAccountAge,
  validatePlatformAssetUrl,
  validateGamingFields,
  detectSensitiveOrOffPlatformContent,
  validateUsername,
  calculateAverageRating,
  getActiveBids,
  getHighestActiveBidMinor,
  isBidActive,
  isTokenServiceDisabledMessage,
  extractTokenServiceActivationUrl,
  computeMsUntilSafeSessionExpiry,
  computeSessionRenewalSchedule,
  inspectStoredFirebaseAuthToken,
  isPrivacySafeResetError,
  validateBidSubmission,
  validateStrongPassword,
  classifyEmailPasswordProbe,
  classifyGoogleProviderProbe,
  validateLoginInput,
  validateRegistrationInput,
  validatePasswordResetInput,
} from './marketplaceLogic';

test('Commission Engine: ৳100 accepted deal with 5% buyer fee and 5% seller fee', () => {
  // ৳100 = 10,000 paisa (minor units)
  const res = calculateCommission(10_000, 5, 5, true, true);
  assert.equal(res.baseAmountMinor, 10_000);
  assert.equal(res.buyerFeeMinor, 500);          // ৳5
  assert.equal(res.buyerTotalMinor, 10_500);     // ৳105
  assert.equal(res.sellerFeeMinor, 500);         // ৳5
  assert.equal(res.sellerPayoutMinor, 9_500);    // ৳95
  assert.equal(res.platformCommissionMinor, 1_000); // ৳10
  // Accounting invariants
  assert.equal(res.baseAmountMinor, res.sellerPayoutMinor + res.sellerFeeMinor);
  assert.equal(res.buyerTotalMinor, res.baseAmountMinor + res.buyerFeeMinor);
  assert.equal(res.platformCommissionMinor, res.buyerFeeMinor + res.sellerFeeMinor);
});

test('Commission Engine: ৳1,000 accepted deal with 3% buyer fee and 2% seller fee', () => {
  const res = calculateCommission(100_000, 3, 2, true, true);
  assert.equal(res.buyerFeeMinor, 3_000);           // ৳30
  assert.equal(res.buyerTotalMinor, 103_000);       // ৳1,030
  assert.equal(res.sellerFeeMinor, 2_000);          // ৳20
  assert.equal(res.sellerPayoutMinor, 98_000);      // ৳980
  assert.equal(res.platformCommissionMinor, 5_000); // ৳50
});

test('Commission Engine: disabled fee flags and invalid rate rejection', () => {
  const buyerDisabled = calculateCommission(50_000, 5, 4, false, true);
  assert.equal(buyerDisabled.buyerFeeMinor, 0);
  assert.equal(buyerDisabled.sellerFeeMinor, 2_000);

  const bothDisabled = calculateCommission(50_000, 5, 4, false, false);
  assert.equal(bothDisabled.platformCommissionMinor, 0);

  assert.throws(() => calculateCommission(10_000, -1, 0));
  assert.throws(() => calculateCommission(10_000, 60, 0));
});

test('Escrow Protection Timer: immutable original deadline & report blocks auto-release', () => {
  const confirmTime = Date.UTC(2026, 9, 16, 12, 0, 0);
  const originalDeadline = calculateProtectionDeadline(confirmTime, 48); // Oct 18 12:00 UTC

  // Midway check (24h later)
  assert.equal(computeRemainingProtectionMs(originalDeadline, confirmTime + 24 * 3_600_000), 24 * 3_600_000);

  // Even after multiple reports and admin resume 36h later, remaining time is strictly 12h (never extended)
  assert.equal(computeRemainingProtectionMs(originalDeadline, confirmTime + 36 * 3_600_000), 12 * 3_600_000);

  // At deadline with unresolved report -> auto-release MUST be blocked
  const afterDeadline = originalDeadline + 60_000;
  assert.equal(computeRemainingProtectionMs(originalDeadline, afterDeadline), 0);
  assert.equal(
    canAutoReleaseEscrow(
      { status: 'reported_under_review', originalDeadlineMs: originalDeadline, unresolvedReportCount: 1 },
      afterDeadline
    ),
    false
  );

  // At deadline with zero unresolved reports -> eligible for release
  assert.equal(
    canAutoReleaseEscrow(
      { status: 'protection_active', originalDeadlineMs: originalDeadline, unresolvedReportCount: 0 },
      afterDeadline
    ),
    true
  );
});

test('Account Age Validation & Formatting', () => {
  assert.equal(validateAccountAge('2', '5', true).valid, true);
  assert.equal(formatAccountAge(2, 5), '2 Years, 5 Months');
  assert.equal(formatAccountAge(0, 8), '8 Months');
  assert.equal(validateAccountAge('1', '12', true).valid, false);
  assert.equal(validateAccountAge('', '5', true).valid, false);
  assert.equal(validateAccountAge('0', '0', true).valid, false);
});

test('Platform Asset URL Validation enforces HTTPS & domain matching without overclaiming ownership', () => {
  const ytOk = validatePlatformAssetUrl('youtube', 'https://www.youtube.com/@bexoracreator');
  assert.equal(ytOk.valid, true);
  assert.equal(ytOk.status, 'domain_matched');

  const ytWrongDomain = validatePlatformAssetUrl('youtube', 'https://facebook.com/somepage');
  assert.equal(ytWrongDomain.valid, false);

  const unsafeScheme = validatePlatformAssetUrl('website', 'javascript:alert(1)');
  assert.equal(unsafeScheme.valid, false);

  const httpInsecure = validatePlatformAssetUrl('instagram', 'http://instagram.com/handle');
  assert.equal(httpInsecure.valid, false);

  const gamingOptional = validatePlatformAssetUrl('gaming', '');
  assert.equal(gamingOptional.valid, true);
  assert.equal(gamingOptional.status, 'not_applicable');
});

test('Gaming Fields Validation requires supported game, UID, and positive Level', () => {
  const ok = validateGamingFields('Free Fire', 'FF-99887766', 68);
  assert.equal(ok.valid, true);
  assert.equal(ok.level, 68);

  const badGame = validateGamingFields('Unknown Game', '123456', 10);
  assert.equal(badGame.valid, false);

  const missingUid = validateGamingFields('PUBG Mobile', 'ab', 50);
  assert.equal(missingUid.valid, false);
});

test('Sensitive & Off-Platform Content Detection blocks secrets, phones, and emails while allowing metrics', () => {
  assert.equal(detectSensitiveOrOffPlatformContent('Channel has 128,400 subscribers and 45 videos.').blocked, false);
  assert.equal(detectSensitiveOrOffPlatformContent('Call me on +8801712345678 for discount').blocked, true);
  assert.equal(detectSensitiveOrOffPlatformContent('Email me at seller@gmail.com').blocked, true);
  assert.equal(detectSensitiveOrOffPlatformContent('Here is the recovery code 9921').blocked, true);
});

test('Authentic Rating Calculation starts empty (never defaults to 5.0)', () => {
  const empty = calculateAverageRating([]);
  assert.equal(empty.average, null);
  assert.equal(empty.count, 0);
  assert.equal(empty.label, 'No ratings yet');

  const real = calculateAverageRating([5, 4, 5]);
  assert.equal(real.average, 4.7);
  assert.equal(real.count, 3);
});

test('Role-Based Bidding accepts small initial bids (1, 5, 10 BDT) and enforces strict higher subsequent bids', () => {
  // First bid of 1 BDT (100 minor) is valid
  assert.equal(validateBidSubmission(100, []).valid, true);
  // Equal or lower second bid is rejected
  assert.equal(validateBidSubmission(100, [{ amountMinor: 100, status: 'pending' }]).valid, false);
  // Higher second bid of 5 BDT (500 minor) is valid
  assert.equal(validateBidSubmission(500, [{ amountMinor: 100, status: 'pending' }]).valid, true);
});

test('Withdrawn Bid Lifecycle: withdrawn bids disappear from active list, count, and highest bid immediately', () => {
  assert.equal(isBidActive('pending'), true);
  assert.equal(isBidActive('accepted'), true);
  assert.equal(isBidActive('withdrawn'), false);
  assert.equal(isBidActive('rejected'), false);

  // Step 1: Buyer places Bid A (৳500 = 50,000 minor)
  const afterBidA = [{ id: 'bid_a', buyerId: 'buyer_1', amountMinor: 50_000, status: 'pending' }];
  assert.equal(getActiveBids(afterBidA).length, 1);
  assert.equal(getHighestActiveBidMinor(afterBidA), 50_000);

  // Duplicate concurrent active pending bid by same buyer is blocked until Bid A is withdrawn
  const dupAttempt = validateBidSubmission(60_000, afterBidA, 'buyer_1');
  assert.equal(dupAttempt.valid, false);
  assert.match(dupAttempt.error || '', /Withdraw your current bid first/);

  // Step 2: Buyer withdraws Bid A -> status becomes 'withdrawn' in history
  const afterWithdrawA = [{ id: 'bid_a', buyerId: 'buyer_1', amountMinor: 50_000, status: 'withdrawn' }];
  assert.equal(getActiveBids(afterWithdrawA).length, 0);
  assert.equal(getHighestActiveBidMinor(afterWithdrawA), 0);

  // Step 3: Buyer places new Bid B (even lower than withdrawn Bid A, e.g. ৳300 = 30,000 minor) -> succeeds cleanly!
  const bidBCheck = validateBidSubmission(30_000, afterWithdrawA, 'buyer_1');
  assert.equal(bidBCheck.valid, true);
  assert.equal(bidBCheck.highestMinor, 0);

  const afterBidB = [
    ...afterWithdrawA,
    { id: 'bid_b', buyerId: 'buyer_1', amountMinor: 30_000, status: 'pending' },
  ];
  const visibleBids = getActiveBids(afterBidB);
  assert.equal(visibleBids.length, 1);
  assert.equal(visibleBids[0].id, 'bid_b');
  assert.equal(getHighestActiveBidMinor(afterBidB), 30_000);
});

test('Withdrawn Bid Lifecycle: two-buyer auction recalculates highest bid when leader withdraws', () => {
  const twoBuyerBids = [
    { id: 'b1', buyerId: 'buyer_1', amountMinor: 20_000, status: 'pending' },
    { id: 'b2', buyerId: 'buyer_2', amountMinor: 45_000, status: 'withdrawn' },
  ];
  assert.equal(getActiveBids(twoBuyerBids).length, 1);
  assert.equal(getHighestActiveBidMinor(twoBuyerBids), 20_000);
  // Buyer 2 can now place 25,000 (> 20,000 active highest, even though < their old 45,000 withdrawn bid)
  assert.equal(validateBidSubmission(25_000, twoBuyerBids, 'buyer_2').valid, true);
  assert.equal(validateBidSubmission(15_000, twoBuyerBids, 'buyer_2').valid, false);
});

test('Username Uniqueness Normalization rejects reserved names and normalizes case', () => {
  const u1 = validateUsername('Rafi_Tech99');
  assert.equal(u1.valid, true);
  assert.equal(u1.normalized, 'rafi_tech99');

  assert.equal(validateUsername('admin').valid, false);
  assert.equal(validateUsername('ab').valid, false);
});

test('Token Service API disabled error classifier detects Firebase securetoken errors and extracts Console URL', () => {
  const sampleError =
    'FirebaseError: [code=unknown]: Fetching auth token failed: Firebase: Error (auth/token-service-api-has-not-been-used-in-project-448578956301-before-or-it-is-disabled.-enable-it-by-visiting-https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=448578956301-then-retry.).';

  assert.equal(isTokenServiceDisabledMessage(sampleError), true);
  assert.equal(
    extractTokenServiceActivationUrl(sampleError),
    'https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=448578956301'
  );
  assert.equal(isTokenServiceDisabledMessage('auth/wrong-password'), false);
  assert.equal(
    extractTokenServiceActivationUrl('no url present', '448578956301'),
    'https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=448578956301'
  );
});

test('Safe Session Expiry Window computes pre-expiry delay before Firestore token refresh failure', () => {
  const now = 1_700_000_000_000;
  const oneHourExpiry = now + 3_600_000; // 60m Firebase ID token
  // With 90s buffer, fires at 58m 30s (3,510,000 ms)
  assert.equal(computeMsUntilSafeSessionExpiry(oneHourExpiry, now, 90_000), 3_510_000);
  // Already inside 90s buffer -> clamps to 0
  assert.equal(computeMsUntilSafeSessionExpiry(now + 45_000, now, 90_000), 0);
  // Already expired or invalid timestamp -> clamps to 0
  assert.equal(computeMsUntilSafeSessionExpiry(now - 10_000, now, 90_000), 0);
  assert.equal(computeMsUntilSafeSessionExpiry(Number.NaN, now, 90_000), 0);
});

test('Project-ID-aware Token Service Console URL avoids numeric project picker fallback', () => {
  assert.equal(
    extractTokenServiceActivationUrl('', '448578956301', 'responsive-dragon-tmn89'),
    'https://console.cloud.google.com/apis/library/securetoken.googleapis.com?project=responsive-dragon-tmn89'
  );
  // Placeholder project IDs fall back safely
  assert.equal(
    extractTokenServiceActivationUrl('', '448578956301', 'remixed-project-id'),
    'https://console.developers.google.com/apis/api/securetoken.googleapis.com/overview?project=448578956301'
  );
});

test('Strong password validator enforces >=8 chars plus letters and digits', () => {
  assert.equal(validateStrongPassword('short1').valid, false);
  assert.equal(validateStrongPassword('alllettersonly').valid, false);
  assert.equal(validateStrongPassword('1234567890').valid, false);
  assert.equal(validateStrongPassword('Bexora2026!').valid, true);
});

test('Privacy-safe password reset error classifier masks account-existence probes only', () => {
  assert.equal(isPrivacySafeResetError('Firebase: Error (auth/user-not-found).'), true);
  assert.equal(isPrivacySafeResetError('EMAIL_NOT_FOUND'), true);
  assert.equal(isPrivacySafeResetError('PASSWORD_LOGIN_DISABLED'), false);
  assert.equal(isPrivacySafeResetError('auth/invalid-email'), false);
});

test('Pre-boot Firebase Auth localStorage token inspector purges expired tokens only when Token Service API is disabled', () => {
  const now = 1_793_280_000_000;
  const expiredPayload = JSON.stringify({
    uid: 'user_123',
    email: 'tanvirislam7574@gmail.com',
    displayName: 'Tanvir Islam',
    providerData: [{ providerId: 'google.com' }],
    stsTokenManager: {
      accessToken: 'jwt_expired',
      refreshToken: 'rt_1',
      expirationTime: now - 5_000,
    },
  });

  // When Token Service API is disabled, expired cached session MUST be purged before Firestore boots
  const checkDisabledExpired = inspectStoredFirebaseAuthToken(expiredPayload, now, false);
  assert.equal(checkDisabledExpired.hasSession, true);
  assert.equal(checkDisabledExpired.shouldPurgeBeforeBoot, true);
  assert.equal(checkDisabledExpired.providerId, 'google.com');
  assert.equal(checkDisabledExpired.email, 'tanvirislam7574@gmail.com');

  // When Token Service API IS verified enabled, expired cached session is kept so Firebase refreshes via securetoken
  const checkEnabledExpired = inspectStoredFirebaseAuthToken(expiredPayload, now, true);
  assert.equal(checkEnabledExpired.shouldPurgeBeforeBoot, false);

  // Active unexpired session (45m remaining) is ALWAYS preserved across reloads even when Token Service API is disabled
  const validPayload = JSON.stringify({
    uid: 'user_123',
    email: 'tanvirislam7574@gmail.com',
    displayName: 'Tanvir Islam',
    providerData: [{ providerId: 'google.com' }],
    stsTokenManager: {
      accessToken: 'jwt_valid',
      refreshToken: 'rt_1',
      expirationTime: now + 45 * 60_000,
    },
  });
  const checkDisabledValid = inspectStoredFirebaseAuthToken(validPayload, now, false);
  assert.equal(checkDisabledValid.hasSession, true);
  assert.equal(checkDisabledValid.shouldPurgeBeforeBoot, false);
});

test('3-stage Session Renewal Schedule runs silent GIS renewal before 5m ProactiveRefresh and guards before 30s StsTokenManager buffer', () => {
  const now = 1_793_280_000_000;
  const oneHourExpiry = now + 3_600_000; // 60m
  const schedule = computeSessionRenewalSchedule(oneHourExpiry, now);

  // Stage 1: Minute 52 (8m = 480s before expiry -> 3,120,000ms), strictly before Firebase's 5m ProactiveRefresh (3,300,000ms)
  assert.equal(schedule.silentIdpRefreshDelayMs, 3_120_000);
  assert.ok(schedule.silentIdpRefreshDelayMs < 3_600_000 - 300_000);

  // Stage 2: Minute 57.5 (150s before expiry -> 3,450,000ms)
  assert.equal(schedule.promptExtendDelayMs, 3_450_000);

  // Stage 3: Minute 59:15 (45s before expiry -> 3,555,000ms), strictly before Firebase's 30s StsTokenManager.isExpired threshold
  assert.equal(schedule.safePreExpiryGuardDelayMs, 3_555_000);
  assert.ok(schedule.safePreExpiryGuardDelayMs < 3_600_000 - 30_000);
});

test('Tri-state Email/Password & Google Provider Probe Classifiers never collapse network/5xx errors into disabled', () => {
  // Confirmed disabled
  assert.equal(
    classifyEmailPasswordProbe(400, '{"error":{"message":"PASSWORD_LOGIN_DISABLED"}}'),
    'disabled'
  );
  assert.equal(
    classifyEmailPasswordProbe(400, '{"error":{"message":"OPERATION_NOT_ALLOWED"}}'),
    'disabled'
  );

  // Confirmed enabled (non-existent probe credential evaluated by Identity Toolkit)
  assert.equal(
    classifyEmailPasswordProbe(400, '{"error":{"message":"INVALID_LOGIN_CREDENTIALS"}}'),
    'enabled'
  );
  assert.equal(
    classifyEmailPasswordProbe(400, '{"error":{"message":"EMAIL_NOT_FOUND"}}'),
    'enabled'
  );

  // Network/5xx/rate-limit/key block MUST classify as unable_to_verify, NOT disabled
  assert.equal(classifyEmailPasswordProbe(0, ''), 'unable_to_verify');
  assert.equal(classifyEmailPasswordProbe(503, 'Service Unavailable'), 'unable_to_verify');
  assert.equal(
    classifyEmailPasswordProbe(403, '{"error":{"message":"API_KEY_HTTP_REFERRER_BLOCKED"}}'),
    'unable_to_verify'
  );

  // Google provider probe
  assert.deepEqual(
    classifyGoogleProviderProbe(200, '{"authUri":"https://accounts.google.com/..."}'),
    { providerStatus: 'enabled', domainAuthorized: true }
  );
  assert.deepEqual(
    classifyGoogleProviderProbe(400, '{"error":{"message":"OPERATION_NOT_ALLOWED"}}'),
    { providerStatus: 'disabled', domainAuthorized: true }
  );
  assert.deepEqual(
    classifyGoogleProviderProbe(400, '{"error":{"message":"UNAUTHORIZED_DOMAIN"}}'),
    { providerStatus: 'enabled', domainAuthorized: false }
  );
  assert.deepEqual(classifyGoogleProviderProbe(502, 'Bad Gateway'), {
    providerStatus: 'unable_to_verify',
    domainAuthorized: null,
  });
});

test('Auth Form Validators validate Login, Registration, and Password Reset inputs accurately', () => {
  assert.equal(validateLoginInput('', 'secret123').valid, false);
  assert.equal(validateLoginInput('not-an-email', 'secret123').valid, false);
  assert.equal(validateLoginInput('user@gmail.com', '').valid, false);
  const validLogin = validateLoginInput('  User@Gmail.com ', 'Bexora2026');
  assert.equal(validLogin.valid, true);
  assert.equal(validLogin.cleanEmail, 'user@gmail.com');

  // Registration validations
  const baseReg = {
    fullName: 'Tanvir Member',
    username: 'tanvir_trader1',
    phone: '+880 1712-345678',
    email: 'Trader@Gmail.com',
    password: 'StrongPass99',
    confirmPassword: 'StrongPass99',
  };
  const validReg = validateRegistrationInput(baseReg);
  assert.equal(validReg.valid, true);
  assert.equal(validReg.normalizedUsername, 'tanvir_trader1');
  assert.equal(validReg.normalizedPhone, '+8801712345678');
  assert.equal(validReg.cleanEmail, 'trader@gmail.com');

  assert.equal(validateRegistrationInput({ ...baseReg, fullName: 'A' }).valid, false);
  assert.equal(validateRegistrationInput({ ...baseReg, username: 'admin' }).valid, false);
  assert.equal(validateRegistrationInput({ ...baseReg, phone: '123' }).valid, false);
  assert.equal(validateRegistrationInput({ ...baseReg, email: 'bad@' }).valid, false);
  assert.equal(validateRegistrationInput({ ...baseReg, password: 'weak', confirmPassword: 'weak' }).valid, false);
  assert.equal(
    validateRegistrationInput({ ...baseReg, confirmPassword: 'DifferentPass99' }).valid,
    false
  );

  // Password reset validations
  assert.equal(validatePasswordResetInput('').valid, false);
  assert.equal(validatePasswordResetInput('invalid-email').valid, false);
  const validReset = validatePasswordResetInput('  Member@Gmail.com ');
  assert.equal(validReset.valid, true);
  assert.equal(validReset.cleanEmail, 'member@gmail.com');
});

