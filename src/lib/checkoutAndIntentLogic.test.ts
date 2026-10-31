import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAcceptedDealCheckoutQuote,
  buildListingBuyNowQuote,
  buildSearchForRoute,
  canCheckoutDeal,
  canResumeAuthIntent,
  computeCheckoutWalletState,
  deserializePendingAuthIntent,
  describePendingAuthIntent,
  normalizeWordPressDiscovery,
  parseRouteFromSearch,
  PendingAuthIntent,
  serializePendingAuthIntent,
  validateWordPressSiteUrl,
} from './checkoutAndIntentLogic';
import { DEFAULT_PUBLIC_SETTINGS } from './marketplaceLogic';
import { DealRecord, MarketplaceListing } from '../types';

const SAMPLE_LISTING: MarketplaceListing = {
  id: 'lst_yt_1001',
  sellerId: 'seller_99',
  sellerName: 'Arif Creator',
  sellerUsername: 'arifcreator',
  sellerVerified: true,
  platform: 'youtube',
  subcategory: 'YouTube Channel',
  title: 'Monetized Tech YouTube Channel 120K Subs',
  description: 'Verified organic channel with clean history and AdSense revenue.',
  priceMinor: 200_000, // 2,000 BDT
  currency: 'BDT',
  monetizationStatus: 'monetized',
  claimedOptions: ['yt-ypp'],
  verifiedOptions: ['yt-ypp'],
  verificationState: 'active_verified',
  ageYears: 3,
  ageMonths: 4,
  metricValue: 120000,
  monthlyRevenueMinor: 15000,
  accountUrl: 'https://youtube.com/@ariftech',
  urlValidationStatus: 'domain_matched',
  images: [],
  status: 'active',
  views: 42,
  createdAtMs: 1_700_000_000_000,
};

test('Full-Screen Route Parser & Builder: round-trips all full-screen views and blocks malicious IDs', () => {
  assert.deepEqual(parseRouteFromSearch(''), { page: 'home' });
  assert.deepEqual(parseRouteFromSearch('?autostart=1'), { page: 'market' });

  const listingSearch = buildSearchForRoute({ page: 'listing', listingId: 'lst_yt_1001' });
  assert.equal(listingSearch, '?view=listing&id=lst_yt_1001');
  assert.deepEqual(parseRouteFromSearch(listingSearch), {
    page: 'listing',
    listingId: 'lst_yt_1001',
  });

  const checkoutSearch = buildSearchForRoute({
    page: 'checkout',
    checkoutListingId: 'lst_yt_1001',
  });
  assert.equal(checkoutSearch, '?view=checkout&listingId=lst_yt_1001');
  assert.deepEqual(parseRouteFromSearch(checkoutSearch), {
    page: 'checkout',
    checkoutListingId: 'lst_yt_1001',
  });

  const dealCheckoutSearch = buildSearchForRoute({
    page: 'checkout',
    checkoutDealId: 'deal_lst_1_abc',
  });
  assert.equal(dealCheckoutSearch, '?view=checkout&dealId=deal_lst_1_abc');
  assert.deepEqual(parseRouteFromSearch(dealCheckoutSearch), {
    page: 'checkout',
    checkoutDealId: 'deal_lst_1_abc',
  });

  // Legacy push notification deep links map directly to full-screen views
  assert.deepEqual(parseRouteFromSearch('?dest=listing:lst_yt_1001'), {
    page: 'listing',
    listingId: 'lst_yt_1001',
  });
  assert.deepEqual(parseRouteFromSearch('?dest=wallet'), { page: 'wallet' });
  assert.deepEqual(parseRouteFromSearch('?dest=deal:deal_99'), {
    page: 'deals',
    dealId: 'deal_99',
  });

  const editListingSearch = buildSearchForRoute({
    page: 'sell',
    editListingId: 'lst_draft_42',
  });
  assert.equal(editListingSearch, '?view=sell&editListingId=lst_draft_42');
  assert.deepEqual(parseRouteFromSearch(editListingSearch), {
    page: 'sell',
    editListingId: 'lst_draft_42',
  });

  // Rejects XSS / malformed IDs safely
  assert.deepEqual(parseRouteFromSearch('?view=listing&id=<script>alert(1)</script>'), {
    page: 'market',
  });

  // New Marketplace Navigation Views round-trip cleanly
  assert.equal(buildSearchForRoute({ page: 'favorites' }), '?view=favorites');
  assert.deepEqual(parseRouteFromSearch('?view=favorites'), { page: 'favorites' });
  assert.equal(buildSearchForRoute({ page: 'my-bids' }), '?view=my-bids');
  assert.deepEqual(parseRouteFromSearch('?view=my-bids'), { page: 'my-bids' });
  assert.equal(buildSearchForRoute({ page: 'following' }), '?view=following');
  assert.deepEqual(parseRouteFromSearch('?view=following'), { page: 'following' });
});

test('Auth Intent Continuation: gates execution until both Auth and Firestore profile/wallet are hydrated', () => {
  // Race condition scenario: fbUser exists, but privateUser has not arrived yet -> MUST wait!
  assert.equal(
    canResumeAuthIntent({
      authReady: true,
      userUid: 'buyer_1',
      profileBootstrapped: true,
      hasProfile: true,
      hasPrivateUser: false,
      signingOut: false,
    }),
    false
  );

  // Fully hydrated -> ready to resume immediately
  assert.equal(
    canResumeAuthIntent({
      authReady: true,
      userUid: 'buyer_1',
      profileBootstrapped: true,
      hasProfile: true,
      hasPrivateUser: true,
      signingOut: false,
    }),
    true
  );
});

test('Auth Intent Continuation: serializes, deserializes, preserves bid/favorite/follow intents, and expires stale intents', () => {
  const now = 1_750_000_000_000;
  const bidIntent: PendingAuthIntent = {
    kind: 'place_bid',
    listingId: 'lst_yt_1001',
    listingTitle: SAMPLE_LISTING.title,
    draftBidAmount: '1850',
    currency: 'BDT',
    returnPage: 'listing',
    createdAtMs: now,
  };

  const raw = serializePendingAuthIntent(bidIntent);
  const restored = deserializePendingAuthIntent(raw, now + 5_000);
  assert.deepEqual(restored, bidIntent);

  const summary = describePendingAuthIntent(restored);
  assert.ok(summary?.detail.includes('1850'));
  assert.equal(summary?.backLabel, 'Back to Listing');

  const favIntent: PendingAuthIntent = {
    kind: 'toggle_favorite',
    listingId: 'lst_yt_1001',
    listingTitle: SAMPLE_LISTING.title,
    returnPage: 'market',
    createdAtMs: now,
  };
  assert.deepEqual(
    deserializePendingAuthIntent(serializePendingAuthIntent(favIntent), now + 1_000),
    favIntent
  );

  const followIntent: PendingAuthIntent = {
    kind: 'follow_seller',
    sellerUid: 'seller_99',
    sellerName: 'Arif Creator',
    returnPage: 'public-profile',
    createdAtMs: now,
  };
  assert.deepEqual(
    deserializePendingAuthIntent(serializePendingAuthIntent(followIntent), now + 1_000),
    followIntent
  );

  // Expired after > 30 minutes
  assert.equal(deserializePendingAuthIntent(raw, now + 31 * 60 * 1000), null);
});

test('Checkout Quotes & Wallet Sufficiency: computes exact 5% buyer fee, accepted bid totals, and shortfall', () => {
  const buyNowQuote = buildListingBuyNowQuote(SAMPLE_LISTING, DEFAULT_PUBLIC_SETTINGS);
  assert.equal(buyNowQuote.baseAmountMinor, 200_000);
  assert.equal(buyNowQuote.buyerFeeMinor, 10_000); // 5% of 2,000 BDT = 100 BDT
  assert.equal(buyNowQuote.buyerTotalMinor, 210_000); // 2,100 BDT
  assert.equal(buyNowQuote.protectionDurationHours, 168); // 7-day YouTube hold

  const insufficient = computeCheckoutWalletState(50_000, buyNowQuote, 120);
  assert.equal(insufficient.hasSufficientBalance, false);
  assert.equal(insufficient.shortfallMinor, 160_000);

  const sufficient = computeCheckoutWalletState(250_000, buyNowQuote, 120);
  assert.equal(sufficient.hasSufficientBalance, true);
  assert.equal(sufficient.shortfallMinor, 0);
  assert.equal(sufficient.remainingAfterPurchaseMinor, 40_000);

  const sampleDeal: DealRecord = {
    id: 'deal_accepted_1',
    listingId: SAMPLE_LISTING.id,
    listingTitle: SAMPLE_LISTING.title,
    platform: 'youtube',
    acceptedBidId: 'bid_55',
    originalListingPriceMinor: 200_000,
    buyerId: 'buyer_1',
    buyerName: 'Buyer One',
    sellerId: 'seller_99',
    sellerName: 'Arif Creator',
    baseAmountMinor: 150_000, // Accepted bid = 1,500 BDT (NOT 2,000 BDT!)
    buyerFeePct: 5,
    sellerFeePct: 0,
    buyerFeeMinor: 7_500,
    sellerFeeMinor: 0,
    buyerTotalMinor: 157_500,
    sellerPayoutMinor: 150_000,
    platformCommissionMinor: 7_500,
    currency: 'BDT',
    protectionDurationHours: 168,
    confirmedAtMs: 0,
    originalDeadlineMs: 0,
    unresolvedReportCount: 0,
    status: 'accepted_pending_payment',
    createdAtMs: 1_750_000_000_000,
  };

  const dealQuote = buildAcceptedDealCheckoutQuote(sampleDeal, SAMPLE_LISTING);
  assert.equal(dealQuote.baseAmountMinor, 150_000);
  assert.equal(dealQuote.originalListingPriceMinor, 200_000);
  assert.equal(dealQuote.buyerTotalMinor, 157_500);
  assert.equal(canCheckoutDeal(sampleDeal, 'buyer_1').eligible, true);
  assert.equal(canCheckoutDeal(sampleDeal, 'intruder_9').eligible, false);
});

test('WordPress Live Payment Discovery: blocks fake payments when unconfigured or missing webhook verification, and normalizes multi-method gateways when live', () => {
  // 1. Unconfigured default -> never selectable
  const unconfigured = normalizeWordPressDiscovery({
    enabledInSettings: false,
    siteUrl: '',
    liveVerified: false,
    webhookSecretConfigured: false,
  });
  assert.equal(unconfigured.statusCode, 'not_configured');
  assert.equal(unconfigured.methods.length, 0);

  // 2. Rejects insecure http:// WordPress URLs
  assert.equal(validateWordPressSiteUrl('http://insecure-wp.example.com').valid, false);
  assert.equal(validateWordPressSiteUrl('https://user:secret@pay.example.com').valid, false);
  assert.equal(validateWordPressSiteUrl('https://pay.bexora.com/').normalizedUrl, 'https://pay.bexora.com');

  // 3. Enabled in settings, but missing server webhook verification secret -> locked (no fake success possible!)
  const missingSecret = normalizeWordPressDiscovery({
    enabledInSettings: true,
    siteUrl: 'https://pay.bexora.com',
    liveVerified: true,
    webhookSecretConfigured: false,
    rawMethods: [{ id: 'sslcommerz', title: 'SSLCommerz', enabled: true }],
  });
  assert.equal(missingSecret.statusCode, 'server_bridge_unconfigured');
  assert.equal(missingSecret.methods.length, 0);

  // 4. Fully verified WordPress bridge with multiple live gateways -> dynamically exposes all enabled methods
  const liveReady = normalizeWordPressDiscovery({
    enabledInSettings: true,
    siteUrl: 'https://pay.bexora.com',
    liveVerified: true,
    webhookSecretConfigured: true,
    rawMethods: [
      {
        id: 'sslcommerz',
        title: 'SSLCommerz (Cards, bKash, Nagad)',
        description: '<p>Instant local &amp; card checkout</p>',
        enabled: 'yes',
        currencies: ['BDT', 'USD'],
      },
      {
        id: 'stripe',
        title: 'Stripe International Cards',
        description: 'Visa, Mastercard, Apple Pay',
        enabled: true,
        currencies: ['USD'],
      },
      {
        id: 'cod',
        title: 'Disabled Offline Method',
        enabled: false,
      },
    ],
  });
  assert.equal(liveReady.statusCode, 'live_ready');
  assert.equal(liveReady.methods.length, 2);
  assert.equal(liveReady.methods[0].id, 'sslcommerz');
  assert.equal(liveReady.methods[0].description, 'Instant local &amp; card checkout');
  assert.equal(liveReady.methods[0].selectable, true);
  assert.equal(liveReady.methods[1].id, 'stripe');
  assert.deepEqual(liveReady.methods[1].supportedCurrencies, ['USD']);
});
