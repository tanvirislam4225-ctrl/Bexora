import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateViewQualification,
  formatListingPublishedTime,
  formatViewCount,
  isViewDeduplicated,
  normalizeViewerKey,
  ViewDeduplicationCache,
  VIEW_DEDUPLICATION_WINDOW_MS,
} from './viewCountLogic';

test('normalizeViewerKey produces deterministic, privacy-safe keys', () => {
  assert.equal(
    normalizeViewerKey({ callerUid: 'user_123abc' }),
    'usr:user_123abc'
  );

  const anonKey1 = normalizeViewerKey({ viewerToken: 'browser-guest-session-uuid-1' });
  const anonKey2 = normalizeViewerKey({ viewerToken: 'browser-guest-session-uuid-1' });
  const anonKeyOther = normalizeViewerKey({ viewerToken: 'browser-guest-session-uuid-2' });

  assert.ok(anonKey1.startsWith('anon:'));
  assert.equal(anonKey1, anonKey2);
  assert.notEqual(anonKey1, anonKeyOther);

  const ipKey = normalizeViewerKey({ clientIp: '192.168.1.10' });
  assert.ok(ipKey.startsWith('ip:'));
});

test('isViewDeduplicated respects 30-minute deduplication window', () => {
  const now = 100000000;
  // 10 minutes ago -> inside window -> deduplicated (true)
  assert.equal(isViewDeduplicated(now - 10 * 60 * 1000, now, VIEW_DEDUPLICATION_WINDOW_MS), true);
  // 29 minutes ago -> inside window -> deduplicated (true)
  assert.equal(isViewDeduplicated(now - 29 * 60 * 1000, now, VIEW_DEDUPLICATION_WINDOW_MS), true);
  // 31 minutes ago -> outside window -> eligible for fresh view (false)
  assert.equal(isViewDeduplicated(now - 31 * 60 * 1000, now, VIEW_DEDUPLICATION_WINDOW_MS), false);
  // Never viewed before -> eligible (false)
  assert.equal(isViewDeduplicated(null, now), false);
  assert.equal(isViewDeduplicated(undefined, now), false);
});

test('evaluateViewQualification rejects self-views, inactive listings, and deduplicated visits', () => {
  const now = 5000000;
  const listingId = 'lst_yt_123';
  const sellerId = 'seller_rahim';

  // Seller viewing their own listing -> rejected
  const selfRes = evaluateViewQualification({
    listingId,
    sellerId,
    viewerKey: 'usr:seller_rahim',
    callerUid: sellerId,
    listingStatus: 'active',
    nowMs: now,
  });
  assert.equal(selfRes.qualifies, false);
  assert.equal(selfRes.reason, 'seller_self_view');

  // Inactive / draft listing -> rejected
  const draftRes = evaluateViewQualification({
    listingId,
    sellerId,
    viewerKey: 'usr:buyer_karim',
    callerUid: 'buyer_karim',
    listingStatus: 'draft',
    nowMs: now,
  });
  assert.equal(draftRes.qualifies, false);
  assert.equal(draftRes.reason, 'inactive_listing');

  // Genuine non-owner viewer first visit -> qualifies
  const firstRes = evaluateViewQualification({
    listingId,
    sellerId,
    viewerKey: 'usr:buyer_karim',
    callerUid: 'buyer_karim',
    lastViewAtMs: null,
    listingStatus: 'active',
    nowMs: now,
  });
  assert.equal(firstRes.qualifies, true);
  assert.equal(firstRes.reason, 'qualified');

  // Repeated visit within 5 minutes -> deduplicated
  const repeatRes = evaluateViewQualification({
    listingId,
    sellerId,
    viewerKey: 'usr:buyer_karim',
    callerUid: 'buyer_karim',
    lastViewAtMs: now - 5 * 60 * 1000,
    listingStatus: 'active',
    nowMs: now,
  });
  assert.equal(repeatRes.qualifies, false);
  assert.equal(repeatRes.reason, 'deduplicated');

  // Return visit after 35 minutes -> qualifies for new view
  const returnRes = evaluateViewQualification({
    listingId,
    sellerId,
    viewerKey: 'usr:buyer_karim',
    callerUid: 'buyer_karim',
    lastViewAtMs: now - 35 * 60 * 1000,
    listingStatus: 'active',
    nowMs: now,
  });
  assert.equal(returnRes.qualifies, true);
  assert.equal(returnRes.reason, 'qualified');
});

test('ViewDeduplicationCache stores and prunes expired views', () => {
  const cache = new ViewDeduplicationCache(1000); // 1 second window for test
  const t0 = 10000;

  assert.equal(cache.hasRecentView('lst_1', 'user_a', t0), false);
  cache.recordView('lst_1', 'user_a', t0);
  assert.equal(cache.hasRecentView('lst_1', 'user_a', t0 + 500), true);
  assert.equal(cache.hasRecentView('lst_1', 'user_a', t0 + 1500), false);

  cache.recordView('lst_2', 'user_b', t0 + 200);
  assert.equal(cache.size(), 2);
  cache.pruneExpired(t0 + 1500);
  assert.equal(cache.size(), 0);
});

test('formatViewCount formats counts truthfully', () => {
  assert.equal(formatViewCount(0), '0 views');
  assert.equal(formatViewCount(1), '1 view');
  assert.equal(formatViewCount(15), '15 views');
  assert.equal(formatViewCount(1250), '1,250 views');
  assert.equal(formatViewCount(null), '0 views');
});

test('formatListingPublishedTime formats relative times truthfully', () => {
  const now = 1710000000000;
  assert.equal(formatListingPublishedTime(null), 'Recently');
  assert.equal(formatListingPublishedTime(now - 30 * 1000, now), 'Just now');
  assert.equal(formatListingPublishedTime(now - 15 * 60 * 1000, now), '15m ago');
  assert.equal(formatListingPublishedTime(now - 4 * 3600 * 1000, now), '4h ago');
  assert.equal(formatListingPublishedTime(now - 2 * 86400 * 1000, now), '2d ago');
  assert.equal(formatListingPublishedTime(now - 14 * 86400 * 1000, now), '2w ago');
});

