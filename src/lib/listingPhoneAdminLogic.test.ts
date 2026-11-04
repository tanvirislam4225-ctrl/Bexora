import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAndNormalizePhone,
  resolvePhoneFormatValidationUiState,
  resolvePhoneVerificationUiState,
  splitSavedPhoneForCountryInput,
  SUPPORTED_PHONE_COUNTRIES,
} from './phoneValidation';
import {
  MAX_LISTING_IMAGES,
  MAX_GALLERY_LIMIT_MESSAGE,
  validateGalleryBatchAdd,
  removeGalleryImageAt,
  replaceGalleryImageAt,
  moveGalleryImage,
  setGalleryCoverImage,
  canSellerEditListingStatus,
  evaluateListingDeletionEligibility,
  canBuyerWithdrawBid,
  canSellerRejectBid,
  partitionBidsForListingView,
  evaluateAdminUserDeletionEligibility,
  LISTING_DELETE_BLOCKED_ACTIVE_DEAL,
  LISTING_DELETE_CONFIRM_COPY,
} from './listingAndBidManagementLogic';

test('Bangladesh (+880) Phone Validation: accepts valid local/international mobile formats and normalizes to E.164', () => {
  // Local 11-digit format 01XXXXXXXXX -> +8801XXXXXXXXX (13 digits excluding +)
  const localBd = validateAndNormalizePhone('01712345678', 'BD');
  assert.equal(localBd.valid, true);
  assert.equal(localBd.e164, '+8801712345678');
  assert.equal(localBd.e164.replace('+', '').length, 13);
  assert.equal(localBd.nationalNumber.length, 10);

  // National 10-digit format 1XXXXXXXXX -> +8801XXXXXXXXX
  const nationalBd = validateAndNormalizePhone('1812-345678', 'BD');
  assert.equal(nationalBd.valid, true);
  assert.equal(nationalBd.e164, '+8801812345678');

  // International +880 format with spaces/hyphens
  const intlBd = validateAndNormalizePhone('+880 1912-345678', 'BD');
  assert.equal(intlBd.valid, true);
  assert.equal(intlBd.e164, '+8801912345678');

  // All valid BD mobile operator prefixes 13..19
  for (const op of ['13', '14', '15', '16', '17', '18', '19']) {
    const res = validateAndNormalizePhone(`0${op}12345678`, 'BD');
    assert.equal(res.valid, true, `Operator 0${op} should be valid`);
    assert.equal(res.e164, `+880${op}12345678`);
  }
});

test('Bangladesh (+880) Phone Validation: rejects missing digits, excess digits, trunk zero after +880, bad prefixes, and country mismatch', () => {
  // Missing digits (only 9 national digits)
  const missing = validateAndNormalizePhone('0171234567', 'BD');
  assert.equal(missing.valid, false);
  assert.equal(missing.errorCode, 'missing_digits');
  assert.match(missing.error || '', /Bangladesh mobile number/);

  // Excess digits (12 local digits / 11 national digits)
  const excess = validateAndNormalizePhone('017123456789', 'BD');
  assert.equal(excess.valid, false);
  assert.equal(excess.errorCode, 'excess_digits');

  // Trunk zero accidentally included after explicit +880 (+88001712345678 -> 14 digits excluding +)
  const trunkAfterIntl = validateAndNormalizePhone('+88001712345678', 'BD');
  assert.equal(trunkAfterIntl.valid, false);
  assert.equal(trunkAfterIntl.errorCode, 'excess_digits');

  // Invalid Bangladesh operator prefix (010, 011, 012)
  assert.equal(validateAndNormalizePhone('01112345678', 'BD').valid, false);
  assert.equal(validateAndNormalizePhone('01212345678', 'BD').valid, false);

  // Country calling code mismatch (+1 US number entered while BD selected)
  const mismatch = validateAndNormalizePhone('+12025550143', 'BD');
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.errorCode, 'country_code_mismatch');

  // Empty & alphabetic garbage
  assert.equal(validateAndNormalizePhone('   ', 'BD').valid, false);
  assert.equal(validateAndNormalizePhone('01712abc678', 'BD').valid, false);
});

test('International Country Phone Validation: validates US, UK, India, UAE, Saudi Arabia and rejects wrong lengths', () => {
  const usValid = validateAndNormalizePhone('(202) 555-0143', 'US');
  assert.equal(usValid.valid, true);
  assert.equal(usValid.e164, '+12025550143');
  assert.equal(validateAndNormalizePhone('20255501', 'US').valid, false);

  const gbValid = validateAndNormalizePhone('07911 123456', 'GB');
  assert.equal(gbValid.valid, true);
  assert.equal(gbValid.e164, '+447911123456');

  const inValid = validateAndNormalizePhone('98765 43210', 'IN');
  assert.equal(inValid.valid, true);
  assert.equal(inValid.e164, '+919876543210');
  assert.equal(validateAndNormalizePhone('98765432', 'IN').valid, false);

  const aeValid = validateAndNormalizePhone('50 123 4567', 'AE');
  assert.equal(aeValid.valid, true);
  assert.equal(aeValid.e164, '+971501234567');

  // Splitting saved E.164 back into country selector + national number
  const splitUk = splitSavedPhoneForCountryInput('+447911123456');
  assert.equal(splitUk.countryIso2, 'GB');
  assert.equal(splitUk.localInput, '7911123456');
});

test('Honest Phone Verification State: format validation NEVER claims ownership verified without matching DB OTP verification', () => {
  const validBd = validateAndNormalizePhone('01712345678', 'BD');

  // Valid format, unverified in DB -> MUST be valid_unverified with explicit verification required message
  const unverifiedState = resolvePhoneVerificationUiState({
    validation: validBd,
    savedPhoneE164: '+8801712345678',
    phoneVerifiedInDb: false,
  });
  assert.equal(unverifiedState.status, 'valid_unverified');
  assert.equal(unverifiedState.isOwnershipVerified, false);
  assert.equal(unverifiedState.primaryMessage, 'Valid phone number format.');
  assert.equal(unverifiedState.secondaryMessage, 'Phone number verification required.');

  // Verified in DB for OLD number, but user edited input to a NEW valid number -> MUST immediately drop to valid_unverified
  const editedNumberState = resolvePhoneVerificationUiState({
    validation: validateAndNormalizePhone('01899887766', 'BD'),
    savedPhoneE164: '+8801712345678',
    phoneVerifiedInDb: true,
  });
  assert.equal(editedNumberState.status, 'valid_unverified');
  assert.equal(editedNumberState.isOwnershipVerified, false);

  // Verified in DB AND matches current E.164 -> Verified
  const verifiedState = resolvePhoneVerificationUiState({
    validation: validBd,
    savedPhoneE164: '+8801712345678',
    phoneVerifiedInDb: true,
  });
  assert.equal(verifiedState.status, 'verified');
  assert.equal(verifiedState.isOwnershipVerified, true);
  assert.equal(verifiedState.primaryMessage, 'Phone number successfully verified.');
});

test('10-Image Gallery Logic: enforces 10-image cap with explicit notice and supports cover, move, replace, and remove', () => {
  assert.equal(MAX_LISTING_IMAGES, 10);

  const okBatch = validateGalleryBatchAdd(6, 4);
  assert.equal(okBatch.allowedCount, 4);
  assert.equal(okBatch.exceededLimit, false);

  const overflowBatch = validateGalleryBatchAdd(8, 5);
  assert.equal(overflowBatch.allowedCount, 2);
  assert.equal(overflowBatch.exceededLimit, true);
  assert.equal(overflowBatch.notice, MAX_GALLERY_LIMIT_MESSAGE);

  const fullBatch = validateGalleryBatchAdd(10, 1);
  assert.equal(fullBatch.allowedCount, 0);
  assert.equal(fullBatch.exceededLimit, true);
  assert.equal(fullBatch.notice, MAX_GALLERY_LIMIT_MESSAGE);

  const initial = ['img1', 'img2', 'img3', 'img4'];
  assert.deepEqual(setGalleryCoverImage(initial, 2), ['img3', 'img1', 'img2', 'img4']);
  assert.deepEqual(moveGalleryImage(initial, 1, 3), ['img1', 'img3', 'img4', 'img2']);
  assert.deepEqual(replaceGalleryImageAt(initial, 1, 'img2_new'), ['img1', 'img2_new', 'img3', 'img4']);
  assert.deepEqual(removeGalleryImageAt(initial, 0), ['img2', 'img3', 'img4']);
});

test('Seller Listing Edit & Delete Eligibility: blocks active deals/accepted bids/disputes/sold and allows clean listings', () => {
  assert.equal(canSellerEditListingStatus('active', null), true);
  assert.equal(canSellerEditListingStatus('pending', null), true);
  assert.equal(canSellerEditListingStatus('draft', null), true);
  assert.equal(canSellerEditListingStatus('rejected', null), true);
  assert.equal(canSellerEditListingStatus('reserved', 'deal_1'), false);
  assert.equal(canSellerEditListingStatus('sold', null), false);
  assert.equal(canSellerEditListingStatus('suspended', null), false);

  // Blocked by active deal
  const blockedDeal = evaluateListingDeletionEligibility({
    isOwner: true,
    listingStatus: 'reserved',
    activeDealId: 'deal_99',
    deals: [{ id: 'deal_99', status: 'funded' }],
    bids: [],
  });
  assert.equal(blockedDeal.eligible, false);
  assert.equal(blockedDeal.blockingCode, 'active_deal');
  assert.equal(blockedDeal.title, LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title);
  assert.equal(blockedDeal.message, LISTING_DELETE_BLOCKED_ACTIVE_DEAL.message);

  // Blocked by accepted bid awaiting buyer payment
  const blockedAcceptedBid = evaluateListingDeletionEligibility({
    isOwner: true,
    listingStatus: 'active',
    bids: [{ id: 'b1', status: 'accepted_pending_payment' }],
  });
  assert.equal(blockedAcceptedBid.eligible, false);
  assert.equal(blockedAcceptedBid.blockingCode, 'accepted_bid_obligation');

  // Blocked if not owner
  assert.equal(
    evaluateListingDeletionEligibility({ isOwner: false, listingStatus: 'active' }).eligible,
    false
  );

  // Eligible when active/pending/draft with only unaccepted pending bids (reports count of pending bids)
  const cleanListing = evaluateListingDeletionEligibility({
    isOwner: true,
    listingStatus: 'active',
    deals: [{ id: 'old_cancelled', status: 'cancelled' }],
    bids: [
      { id: 'b_pend_1', status: 'pending' },
      { id: 'b_withdrawn', status: 'withdrawn' },
    ],
  });
  assert.equal(cleanListing.eligible, true);
  assert.equal(cleanListing.title, LISTING_DELETE_CONFIRM_COPY.title);
  assert.equal(cleanListing.pendingBidsCount, 1);
});

test('Bid Withdrawal & Seller Bid Rejection Partitioning: isolates active pending bids from historical withdrawn/rejected bids', () => {
  const sampleBids = [
    { id: 'b1', buyerId: 'buyer_1', amountMinor: 40_000, status: 'pending' },
    { id: 'b2', buyerId: 'buyer_2', amountMinor: 65_000, status: 'withdrawn' },
    { id: 'b3', buyerId: 'buyer_3', amountMinor: 55_000, status: 'rejected' },
    { id: 'b4', buyerId: 'buyer_4', amountMinor: 50_000, status: 'pending' },
  ];

  // Buyer 1 can withdraw own pending bid, cannot withdraw Buyer 4's bid or already withdrawn bid
  assert.equal(canBuyerWithdrawBid(sampleBids[0], 'buyer_1'), true);
  assert.equal(canBuyerWithdrawBid(sampleBids[0], 'buyer_2'), false);
  assert.equal(canBuyerWithdrawBid(sampleBids[1], 'buyer_2'), false);

  // Seller owner can reject pending bids, cannot reject withdrawn/rejected bids
  assert.equal(canSellerRejectBid(sampleBids[0], true, 'active'), true);
  assert.equal(canSellerRejectBid(sampleBids[0], false, 'active'), false);
  assert.equal(canSellerRejectBid(sampleBids[2], true, 'active'), false);

  // Seller view sees all historical bids; Buyer 2 sees only own historical bid + active pending bids
  const sellerPartition = partitionBidsForListingView(sampleBids, 'seller_1', true);
  assert.deepEqual(
    sellerPartition.activePendingBids.map((b) => b.id),
    ['b4', 'b1']
  );
  assert.equal(sellerPartition.historicalBids.length, 2);

  const buyer2Partition = partitionBidsForListingView(sampleBids, 'buyer_2', false);
  assert.equal(buyer2Partition.activePendingBids.length, 2);
  assert.deepEqual(
    buyer2Partition.historicalBids.map((b) => b.id),
    ['b2']
  );
});

test('Admin Permanent User Deletion Preflight: enforces superadmin role, blocks self-delete, and blocks financial/deal obligations', () => {
  const cleanTarget = evaluateAdminUserDeletionEligibility({
    callerRole: 'superadmin',
    callerUid: 'admin_1',
    targetUid: 'user_99',
    walletBalanceMinor: 0,
    reservedBalanceMinor: 0,
    financialHoldActive: false,
    activeDealsCount: 0,
    acceptedObligationBidsCount: 0,
    pendingDepositsCount: 0,
    pendingWithdrawalsCount: 0,
    openDisputesCount: 0,
    openModerationInvestigationsCount: 0,
  });
  assert.equal(cleanTarget.eligible, true);
  assert.equal(cleanTarget.blockers.length, 0);

  // Moderator cannot permanently delete
  const modAttempt = evaluateAdminUserDeletionEligibility({
    callerRole: 'moderator',
    callerUid: 'mod_1',
    targetUid: 'user_99',
    walletBalanceMinor: 0,
    reservedBalanceMinor: 0,
    financialHoldActive: false,
    activeDealsCount: 0,
    acceptedObligationBidsCount: 0,
    pendingDepositsCount: 0,
    pendingWithdrawalsCount: 0,
    openDisputesCount: 0,
    openModerationInvestigationsCount: 0,
  });
  assert.equal(modAttempt.eligible, false);

  // Self-delete blocked
  const selfAttempt = evaluateAdminUserDeletionEligibility({
    callerRole: 'superadmin',
    callerUid: 'admin_1',
    targetUid: 'admin_1',
    walletBalanceMinor: 0,
    reservedBalanceMinor: 0,
    financialHoldActive: false,
    activeDealsCount: 0,
    acceptedObligationBidsCount: 0,
    pendingDepositsCount: 0,
    pendingWithdrawalsCount: 0,
    openDisputesCount: 0,
    openModerationInvestigationsCount: 0,
  });
  assert.equal(selfAttempt.eligible, false);

  // Non-zero wallet + active deal blocked
  const obligationAttempt = evaluateAdminUserDeletionEligibility({
    callerRole: 'superadmin',
    callerUid: 'admin_1',
    targetUid: 'user_with_funds',
    walletBalanceMinor: 25_000,
    reservedBalanceMinor: 10_000,
    financialHoldActive: true,
    activeDealsCount: 1,
    acceptedObligationBidsCount: 0,
    pendingDepositsCount: 1,
    pendingWithdrawalsCount: 0,
    openDisputesCount: 0,
    openModerationInvestigationsCount: 0,
  });
  assert.equal(obligationAttempt.eligible, false);
  assert.equal(obligationAttempt.blockers.length, 5);
});

test('OTP-Free International Phone Format Validation UI State: validates 35+ countries, displays Format Validated, and never sets isOwnershipVerified', () => {
  assert.equal(SUPPORTED_PHONE_COUNTRIES[0].iso2, 'BD');
  assert.equal(SUPPORTED_PHONE_COUNTRIES[0].dialCode, '+880');
  assert.ok(SUPPORTED_PHONE_COUNTRIES.length >= 35);

  const bdValid = validateAndNormalizePhone('01712345678', 'BD');
  const unsavedFmt = resolvePhoneFormatValidationUiState({
    validation: bdValid,
    savedPhoneE164: '',
  });
  assert.equal(unsavedFmt.status, 'valid_unsaved');
  assert.equal(unsavedFmt.badgeLabel, 'Format Validated');
  assert.equal(unsavedFmt.isOwnershipVerified, false);

  const savedFmt = resolvePhoneFormatValidationUiState({
    validation: bdValid,
    savedPhoneE164: '+8801712345678',
  });
  assert.equal(savedFmt.status, 'format_validated');
  assert.equal(savedFmt.badgeLabel, 'Format Validated');
  assert.equal(savedFmt.isOwnershipVerified, false);

  // Editing an already-saved number to another valid number keeps Format Validated badge and prompts Save Phone Number to update
  const updatedValid = validateAndNormalizePhone('01899887766', 'BD');
  const editedFmt = resolvePhoneFormatValidationUiState({
    validation: updatedValid,
    savedPhoneE164: '+8801712345678',
  });
  assert.equal(editedFmt.status, 'valid_unsaved');
  assert.equal(editedFmt.badgeLabel, 'Format Validated');
  assert.match(editedFmt.primaryMessage, /Save Phone Number to update/);
  assert.equal(editedFmt.isOwnershipVerified, false);

  // Invalid format returns invalid status
  const invalidFmt = resolvePhoneFormatValidationUiState({
    validation: validateAndNormalizePhone('+88001712345678', 'BD'),
    savedPhoneE164: '+8801712345678',
  });
  assert.equal(invalidFmt.status, 'invalid');
  assert.equal(invalidFmt.isOwnershipVerified, false);

  // Additional international countries (Germany, Pakistan, Malaysia, Japan)
  assert.equal(validateAndNormalizePhone('1512 3456789', 'DE').e164, '+4915123456789');
  assert.equal(validateAndNormalizePhone('0300 1234567', 'PK').e164, '+923001234567');
  assert.equal(validateAndNormalizePhone('012-345 6789', 'MY').e164, '+60123456789');
  assert.equal(validateAndNormalizePhone('090-1234-5678', 'JP').e164, '+819012345678');
});

