import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFavoriteDocId,
  buildFollowerNewListingNotificationSpec,
  buildListingShareDeepLink,
  buildListingSharePayload,
  buildSellerFollowDocId,
  canUserFollowSeller,
  chunkIdsForFirestoreInQuery,
  classifyUserBidEntry,
  executeShareListing,
  filterClassifiedBids,
  resolveFavoriteDisplayItem,
  resolveSellerFollowerCount,
  shouldTriggerFollowerPublicationAlert,
} from './engagementLogic';
import { parseRouteFromSearch } from './checkoutAndIntentLogic';
import {
  isFollowedSellerNewListingNotification,
  matchesNotificationInboxFilter,
  sanitizeNotificationDestination,
} from './notificationLogic';
import type {
  BidRecord,
  DealRecord,
  FavoriteRecord,
  MarketplaceListing,
  NotificationRecord,
} from '../types';

const SAMPLE_LISTING: MarketplaceListing = {
  id: 'lst_yt_888',
  sellerId: 'seller_alpha',
  sellerName: 'Nadia Digital',
  sellerUsername: 'nadiadigital',
  sellerVerified: true,
  platform: 'youtube',
  subcategory: 'YouTube Channel',
  title: 'Monetized Tech Channel 95K Subscribers',
  description: 'Organic subscribers, clean monetization status, ready for escrow transfer.',
  priceMinor: 4_500_000, // 45,000 BDT
  currency: 'BDT',
  monetizationStatus: 'monetized',
  claimedOptions: ['yt-ypp'],
  verifiedOptions: ['yt-ypp'],
  verificationState: 'active_verified',
  ageYears: 2,
  ageMonths: 6,
  metricValue: 95000,
  monthlyRevenueMinor: 350000,
  accountUrl: 'https://youtube.com/@nadiatech',
  urlValidationStatus: 'domain_matched',
  images: ['https://example.com/thumb1.jpg'],
  status: 'active',
  views: 120,
  createdAtMs: 1_750_000_000_000,
};

const SAMPLE_FAVORITE: FavoriteRecord = {
  id: 'fav_buyer_1_lst_yt_888',
  userId: 'buyer_1',
  listingId: 'lst_yt_888',
  sellerId: 'seller_alpha',
  sellerName: 'Nadia Digital',
  sellerUsername: 'nadiadigital',
  title: 'Monetized Tech Channel 95K Subscribers',
  platform: 'youtube',
  subcategory: 'YouTube Channel',
  priceMinor: 4_500_000,
  currency: 'BDT',
  thumbnailUrl: 'https://example.com/snapshot.jpg',
  createdAtMs: 1_750_000_050_000,
};

test('Deterministic Favorite & SellerFollow IDs: enforces valid IDs and prevents self-following', () => {
  assert.equal(buildFavoriteDocId('buyer_1', 'lst_yt_888'), 'fav_buyer_1_lst_yt_888');
  assert.equal(buildFavoriteDocId('', 'lst_yt_888'), '');
  assert.equal(buildFavoriteDocId('buyer_1', '../bad/id'), '');

  assert.equal(buildSellerFollowDocId('buyer_1', 'seller_alpha'), 'fol_buyer_1_seller_alpha');
  // Self-follow must return empty ID and false permission
  assert.equal(buildSellerFollowDocId('seller_alpha', 'seller_alpha'), '');
  assert.equal(canUserFollowSeller('seller_alpha', 'seller_alpha'), false);
  assert.equal(canUserFollowSeller('buyer_1', 'seller_alpha'), true);
  // Logged-out visitor sees Follow button so PendingAuthIntent can guide sign-in
  assert.equal(canUserFollowSeller(null, 'seller_alpha'), true);
});

test('chunkIdsForFirestoreInQuery: deduplicates, filters malformed IDs, and chunks by <= 10', () => {
  const ids = Array.from({ length: 23 }, (_, idx) => `lst_${idx + 1}`);
  const withDupesAndBad = [...ids, 'lst_1', 'lst_5', '', 'bad/slash', '<script>'];
  const chunks = chunkIdsForFirestoreInQuery(withDupesAndBad, 10);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 10);
  assert.equal(chunks[1].length, 10);
  assert.equal(chunks[2].length, 3);
});

test('Favorites Display Resolution: handles active, reserved, sold, moderated, and deleted listings cleanly', () => {
  const activeItem = resolveFavoriteDisplayItem(SAMPLE_FAVORITE, SAMPLE_LISTING);
  assert.equal(activeItem.availability, 'active');
  assert.equal(activeItem.statusLabel, 'Available');
  assert.equal(activeItem.canOpenListing, true);

  const reservedItem = resolveFavoriteDisplayItem(SAMPLE_FAVORITE, {
    ...SAMPLE_LISTING,
    status: 'reserved',
  });
  assert.equal(reservedItem.availability, 'reserved');
  assert.equal(reservedItem.statusLabel, 'Reserved in Escrow');
  assert.equal(reservedItem.canOpenListing, true);

  const soldItem = resolveFavoriteDisplayItem(SAMPLE_FAVORITE, {
    ...SAMPLE_LISTING,
    status: 'sold',
  });
  assert.equal(soldItem.availability, 'sold');
  assert.equal(soldItem.statusLabel, 'Sold');
  assert.equal(soldItem.canOpenListing, true);

  const suspendedItem = resolveFavoriteDisplayItem(SAMPLE_FAVORITE, {
    ...SAMPLE_LISTING,
    status: 'suspended',
  });
  assert.equal(suspendedItem.availability, 'unavailable');
  assert.equal(suspendedItem.canOpenListing, false);

  // Deleted / unreadable listing falls back to saved Favorite snapshot without crashing
  const deletedItem = resolveFavoriteDisplayItem(SAMPLE_FAVORITE, null);
  assert.equal(deletedItem.availability, 'unavailable');
  assert.equal(deletedItem.statusLabel, 'No Longer Available');
  assert.equal(deletedItem.canOpenListing, false);
  assert.equal(deletedItem.title, SAMPLE_FAVORITE.title);
  assert.equal(deletedItem.priceMinor, SAMPLE_FAVORITE.priceMinor);
});

test('My Bids Classification & Withdrawal Rules: classifies all lifecycle states and blocks withdrawal on accepted deals', () => {
  const baseBid: BidRecord = {
    id: 'bid_101',
    listingId: SAMPLE_LISTING.id,
    sellerId: SAMPLE_LISTING.sellerId,
    buyerId: 'buyer_1',
    buyerName: 'Buyer One',
    buyerUsername: 'buyerone',
    buyerVerified: true,
    amountMinor: 4_000_000,
    currency: 'BDT',
    status: 'pending',
    createdAtMs: 1_750_000_100_000,
  };

  // 1. Active pending bid -> can withdraw
  const pendingClassified = classifyUserBidEntry(baseBid, SAMPLE_LISTING, null);
  assert.equal(pendingClassified.bucket, 'pending');
  assert.equal(pendingClassified.canWithdraw, true);

  // 2. Accepted bid awaiting buyer payment -> in accepted_deal bucket, CANNOT withdraw via ordinary bid cancellation, CAN open deal checkout
  const unpaidDeal: DealRecord = {
    id: 'deal_201',
    listingId: SAMPLE_LISTING.id,
    listingTitle: SAMPLE_LISTING.title,
    platform: 'youtube',
    acceptedBidId: baseBid.id,
    buyerId: 'buyer_1',
    buyerName: 'Buyer One',
    sellerId: SAMPLE_LISTING.sellerId,
    sellerName: SAMPLE_LISTING.sellerName,
    baseAmountMinor: 4_000_000,
    buyerFeePct: 5,
    sellerFeePct: 0,
    buyerFeeMinor: 200_000,
    sellerFeeMinor: 0,
    buyerTotalMinor: 4_200_000,
    sellerPayoutMinor: 4_000_000,
    platformCommissionMinor: 200_000,
    currency: 'BDT',
    protectionDurationHours: 168,
    confirmedAtMs: 0,
    originalDeadlineMs: 0,
    unresolvedReportCount: 0,
    status: 'accepted_pending_payment',
    createdAtMs: 1_750_000_200_000,
  };
  const acceptedClassified = classifyUserBidEntry(
    { ...baseBid, id: 'bid_102', status: 'accepted_pending_payment', dealId: unpaidDeal.id, createdAtMs: 1_750_000_200_000 },
    { ...SAMPLE_LISTING, status: 'reserved' },
    unpaidDeal
  );
  assert.equal(acceptedClassified.bucket, 'accepted_deal');
  assert.equal(acceptedClassified.canWithdraw, false);
  assert.equal(acceptedClassified.canOpenDealCheckout, true);
  assert.equal(acceptedClassified.canOpenDealRoom, true);

  // 3. Rejected, Withdrawn, and Expired (listing sold while bid still pending)
  const rejectedClassified = classifyUserBidEntry(
    { ...baseBid, id: 'bid_103', status: 'rejected', createdAtMs: 1_750_000_050_000 },
    SAMPLE_LISTING,
    null
  );
  assert.equal(rejectedClassified.bucket, 'rejected');
  assert.equal(rejectedClassified.canWithdraw, false);

  const withdrawnClassified = classifyUserBidEntry(
    { ...baseBid, id: 'bid_104', status: 'withdrawn', createdAtMs: 1_750_000_030_000 },
    SAMPLE_LISTING,
    null
  );
  assert.equal(withdrawnClassified.bucket, 'cancelled');
  assert.equal(withdrawnClassified.canWithdraw, false);

  const expiredBySoldListing = classifyUserBidEntry(
    { ...baseBid, id: 'bid_105', status: 'pending', createdAtMs: 1_750_000_010_000 },
    { ...SAMPLE_LISTING, status: 'sold' },
    null
  );
  assert.equal(expiredBySoldListing.bucket, 'expired');
  assert.equal(expiredBySoldListing.canWithdraw, false);

  const allEntries = [
    pendingClassified,
    acceptedClassified,
    rejectedClassified,
    withdrawnClassified,
    expiredBySoldListing,
  ];
  assert.equal(filterClassifiedBids(allEntries, 'all').length, 5);
  assert.equal(filterClassifiedBids(allEntries, 'pending').length, 1);
  assert.equal(filterClassifiedBids(allEntries, 'accepted_deal').length, 1);
  assert.equal(filterClassifiedBids(allEntries, 'rejected').length, 1);
  assert.equal(filterClassifiedBids(allEntries, 'cancelled').length, 1);
  assert.equal(filterClassifiedBids(allEntries, 'expired').length, 1);
});

test('Follower Publication Trigger & Notification Spec: fires ONLY on first-time active publication and builds deterministic safe specs', () => {
  // First-time pending -> active without firstPublishedAtMs => TRUE
  assert.equal(shouldTriggerFollowerPublicationAlert('pending', 'active', undefined), true);
  assert.equal(shouldTriggerFollowerPublicationAlert('draft', 'active', null), true);

  // Draft, pending, rejected, suspended => FALSE
  assert.equal(shouldTriggerFollowerPublicationAlert('draft', 'pending', undefined), false);
  assert.equal(shouldTriggerFollowerPublicationAlert('pending', 'rejected', undefined), false);
  assert.equal(shouldTriggerFollowerPublicationAlert('active', 'suspended', 1_750_000_000_000), false);

  // Already active edit or restored suspended listing that already has firstPublishedAtMs => FALSE (no duplicate spam!)
  assert.equal(shouldTriggerFollowerPublicationAlert('active', 'active', 1_750_000_000_000), false);
  assert.equal(shouldTriggerFollowerPublicationAlert('suspended', 'active', 1_750_000_000_000), false);
  assert.equal(shouldTriggerFollowerPublicationAlert('pending', 'active', 1_750_000_000_000), false);

  // Seller never receives follower alert for their own listing
  assert.equal(buildFollowerNewListingNotificationSpec(SAMPLE_LISTING, SAMPLE_LISTING.sellerId), null);

  // Deterministic spec for real follower
  const specA = buildFollowerNewListingNotificationSpec(SAMPLE_LISTING, 'follower_42');
  const specB = buildFollowerNewListingNotificationSpec(SAMPLE_LISTING, 'follower_42');
  assert.ok(specA);
  assert.equal(specA.id, specB?.id);
  assert.equal(specA.destination, `listing:${SAMPLE_LISTING.id}`);
  assert.deepEqual(sanitizeNotificationDestination(specA.destination), {
    raw: `listing:${SAMPLE_LISTING.id}`,
    kind: 'listing',
    targetId: SAMPLE_LISTING.id,
    ctaLabel: 'View Listing',
  });
  assert.deepEqual(sanitizeNotificationDestination('seller:seller_alpha'), {
    raw: 'seller:seller_alpha',
    kind: 'seller',
    view: 'public-profile',
    targetId: 'seller_alpha',
    ctaLabel: 'View Seller Profile',
  });

  // Notification inbox category filter recognizes Followed Seller alerts cleanly
  const notifRecord: NotificationRecord = {
    id: specA.id,
    recipientId: 'follower_42',
    actorId: 'admin_1',
    actorRole: 'admin',
    category: specA.category,
    severity: specA.severity,
    alertKind: specA.alertKind,
    title: specA.title,
    preview: specA.preview,
    body: specA.body,
    refType: specA.refType,
    refId: specA.refId,
    referenceLabel: specA.referenceLabel,
    destination: specA.destination,
    read: false,
    createdAtMs: 1_750_000_300_000,
  };
  assert.equal(isFollowedSellerNewListingNotification(notifRecord), true);
  assert.equal(matchesNotificationInboxFilter(notifRecord, 'followed_sellers'), true);
  assert.equal(matchesNotificationInboxFilter(notifRecord, 'security_system'), false);
  assert.equal(resolveSellerFollowerCount({ followerCount: 14 }), 14);
});

test('Share Listing Deep Link & Payload: includes listing title, listing ID, and round-trips through parseRouteFromSearch', () => {
  const deepLink = buildListingShareDeepLink(
    'https://bexora.example.com/',
    '/',
    SAMPLE_LISTING.id
  );
  assert.equal(deepLink, 'https://bexora.example.com/?view=listing&id=lst_yt_888');

  const parsedUrl = new URL(deepLink);
  assert.deepEqual(parseRouteFromSearch(parsedUrl.search), {
    page: 'listing',
    listingId: SAMPLE_LISTING.id,
  });

  const payload = buildListingSharePayload({
    listingId: SAMPLE_LISTING.id,
    title: SAMPLE_LISTING.title,
    origin: 'https://bexora.example.com',
    pathname: '/',
  });
  assert.ok(payload.title.includes(SAMPLE_LISTING.title));
  assert.ok(payload.title.includes(SAMPLE_LISTING.id));
  assert.ok(payload.text.includes(SAMPLE_LISTING.title));
  assert.ok(payload.text.includes(SAMPLE_LISTING.id));
  assert.ok(payload.clipboardText.includes(SAMPLE_LISTING.title));
  assert.ok(payload.clipboardText.includes(SAMPLE_LISTING.id));
  assert.ok(payload.clipboardText.includes(deepLink));
});

test('executeShareListing: handles native Web Share API, AbortError cancellation, iframe NotAllowedError fallback, and legacy clipboard fallback', async () => {
  const shareInput = {
    listingId: SAMPLE_LISTING.id,
    title: SAMPLE_LISTING.title,
    origin: 'https://bexora.example.com',
    pathname: '/',
  };

  // 1. Native Web Share API succeeds when supported
  let sharedData: { title?: string; text?: string; url?: string } | null = null;
  const webShareRes = await executeShareListing(shareInput, {
    canShare: () => true,
    share: async (data) => {
      sharedData = data;
    },
    writeClipboardText: async () => {
      throw new Error('Should not hit clipboard when Web Share succeeds');
    },
  });
  assert.equal(webShareRes.method, 'web_share');
  assert.ok(sharedData);
  assert.ok((sharedData as { title?: string }).title?.includes(SAMPLE_LISTING.title));
  assert.ok((sharedData as { title?: string }).title?.includes(SAMPLE_LISTING.id));
  assert.equal(
    (sharedData as { url?: string }).url,
    'https://bexora.example.com/?view=listing&id=lst_yt_888'
  );

  // 2. Native Web Share API dismissed by user (AbortError) -> returns 'cancelled' without writing clipboard
  let clipboardCalledOnAbort = false;
  const abortRes = await executeShareListing(shareInput, {
    share: async () => {
      const abortErr = new Error('Share canceled');
      abortErr.name = 'AbortError';
      throw abortErr;
    },
    writeClipboardText: async () => {
      clipboardCalledOnAbort = true;
    },
  });
  assert.equal(abortRes.method, 'cancelled');
  assert.equal(clipboardCalledOnAbort, false);

  // 3. Native Web Share API blocked by iframe Permissions-Policy (NotAllowedError) -> falls back cleanly to Clipboard API
  let copiedText = '';
  const iframeFallbackRes = await executeShareListing(shareInput, {
    share: async () => {
      const policyErr = new Error('Permission denied');
      policyErr.name = 'NotAllowedError';
      throw policyErr;
    },
    writeClipboardText: async (text) => {
      copiedText = text;
    },
  });
  assert.equal(iframeFallbackRes.method, 'clipboard');
  assert.ok(copiedText.includes(SAMPLE_LISTING.title));
  assert.ok(copiedText.includes(SAMPLE_LISTING.id));
  assert.ok(copiedText.includes('?view=listing&id=lst_yt_888'));

  // 4. Both Web Share and async Clipboard API unavailable -> falls back to synchronous execCommand adapter
  let legacyCopiedText = '';
  const legacyRes = await executeShareListing(shareInput, {
    writeClipboardText: async () => {
      throw new Error('Clipboard blocked');
    },
    fallbackCopyText: (text) => {
      legacyCopiedText = text;
      return true;
    },
  });
  assert.equal(legacyRes.method, 'clipboard');
  assert.equal(legacyCopiedText, copiedText);
});

