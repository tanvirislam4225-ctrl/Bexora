import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotificationId,
  chunkForFirestoreBatch,
  classifyAuthFailureCause,
  classifyTokenServiceProbe,
  computeUnreadNotificationCount,
  evaluateDealDeadlineNotification,
  filterNotificationsForRecipient,
  formatUnreadBadgeCount,
  isValidFirestoreDocId,
  sanitizeNotificationDestination,
  sortNotificationsNewestFirst,
  truncateNotificationField,
} from './notificationLogic';
import type { NotificationRecord } from '../types';

test('buildNotificationId produces deterministic, valid Firestore IDs and prevents duplicates', () => {
  const idA = buildNotificationId('user_123', 'deal_funded_deal_999');
  const idB = buildNotificationId('user_123', 'deal_funded_deal_999');
  const idOtherUser = buildNotificationId('user_456', 'deal_funded_deal_999');
  const idOtherEvent = buildNotificationId('user_123', 'deal_settled_deal_999');

  assert.equal(idA, idB, 'Repeated emissions for same recipient and eventKey must produce identical ID');
  assert.notEqual(idA, idOtherUser, 'Different recipients must receive distinct notification IDs');
  assert.notEqual(idA, idOtherEvent, 'Different eventKeys must produce distinct notification IDs');
  assert.equal(isValidFirestoreDocId(idA), true);
  assert.ok(idA.length <= 120);
});

test('sanitizeNotificationDestination allows safe internal routes and blocks XSS / external redirects', () => {
  assert.deepEqual(sanitizeNotificationDestination('wallet')?.kind, 'wallet');
  assert.deepEqual(sanitizeNotificationDestination('deals')?.view, 'deals');
  assert.deepEqual(sanitizeNotificationDestination('profile:nid')?.profileTab, 'nid');

  const dealDest = sanitizeNotificationDestination('deal:deal_abc-123');
  assert.ok(dealDest);
  assert.equal(dealDest.kind, 'deal');
  assert.equal(dealDest.targetId, 'deal_abc-123');

  const listingDest = sanitizeNotificationDestination('listing:lst_01');
  assert.ok(listingDest);
  assert.equal(listingDest.kind, 'listing');
  assert.equal(listingDest.targetId, 'lst_01');

  // Adversarial / unsafe destinations must return null
  assert.equal(sanitizeNotificationDestination('https://evil.example.com/phish'), null);
  assert.equal(sanitizeNotificationDestination('http://localhost:3000/admin'), null);
  assert.equal(sanitizeNotificationDestination('javascript:alert(1)'), null);
  assert.equal(sanitizeNotificationDestination('data:text/html,<script>alert(1)</script>'), null);
  assert.equal(sanitizeNotificationDestination('//evil.example.com'), null);
  assert.equal(sanitizeNotificationDestination('deal:../privateUsers/victim'), null);
  assert.equal(sanitizeNotificationDestination('listing:<script>'), null);
  assert.equal(sanitizeNotificationDestination(''), null);
  assert.equal(sanitizeNotificationDestination(null), null);
});

test('sortNotificationsNewestFirst and computeUnreadNotificationCount handle ordering and unread badges accurately', () => {
  const sample: NotificationRecord[] = [
    {
      id: 'ntf_old',
      recipientId: 'u1',
      actorId: 'u1',
      actorRole: 'user',
      category: 'account',
      severity: 'info',
      title: 'Welcome',
      preview: 'Welcome preview',
      body: 'Welcome body',
      refType: 'none',
      refId: '',
      referenceLabel: '',
      destination: 'profile',
      read: true,
      createdAtMs: 1000,
    },
    {
      id: 'ntf_new',
      recipientId: 'u1',
      actorId: 'u2',
      actorRole: 'user',
      category: 'bid',
      severity: 'info',
      title: 'New Bid',
      preview: 'Bid preview',
      body: 'Bid body',
      refType: 'listing',
      refId: 'lst_1',
      referenceLabel: 'Listing #1',
      destination: 'listing:lst_1',
      read: false,
      createdAtMs: 5000,
    },
    {
      id: 'ntf_other_user',
      recipientId: 'u2',
      actorId: 'u2',
      actorRole: 'user',
      category: 'wallet',
      severity: 'success',
      title: 'Private Wallet Credit',
      preview: 'Credited',
      body: 'Credited body',
      refType: 'wallet',
      refId: 'dep_1',
      referenceLabel: 'Deposit #1',
      destination: 'wallet',
      read: false,
      createdAtMs: 9000,
    },
  ];

  const u1Items = filterNotificationsForRecipient(sample, 'u1');
  assert.equal(u1Items.length, 2, 'Cross-user wallet notification must never appear in u1 feed');
  assert.equal(u1Items[0].id, 'ntf_new');
  assert.equal(u1Items[1].id, 'ntf_old');
  assert.equal(computeUnreadNotificationCount(u1Items), 1);

  const sorted = sortNotificationsNewestFirst(u1Items);
  assert.equal(sorted[0].createdAtMs, 5000);
  assert.equal(formatUnreadBadgeCount(0), '');
  assert.equal(formatUnreadBadgeCount(7), '7');
  assert.equal(formatUnreadBadgeCount(142), '99+');
});

test('chunkForFirestoreBatch splits >500 notifications safely below Firestore 500-write batch limit', () => {
  const manyIds = Array.from({ length: 1200 }, (_, idx) => `ntf_${idx}`);
  const chunks = chunkForFirestoreBatch(manyIds, 450);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 450);
  assert.equal(chunks[1].length, 450);
  assert.equal(chunks[2].length, 300);
  assert.ok(chunks.every((c) => c.length <= 500));
});

test('evaluateDealDeadlineNotification triggers idempotent expiring-soon and expired reminders', () => {
  const now = 1_700_000_000_000;
  const dealFar = {
    id: 'deal_100',
    status: 'protection_active' as const,
    originalDeadlineMs: now + 24 * 3600 * 1000,
    listingTitle: 'Monetized Tech Channel',
    buyerId: 'buyer_1',
    sellerId: 'seller_1',
    unresolvedReportCount: 0,
  };
  assert.equal(evaluateDealDeadlineNotification(dealFar, now), null);

  const dealExpiring = { ...dealFar, originalDeadlineMs: now + 3 * 3600 * 1000 };
  const reminderSoon = evaluateDealDeadlineNotification(dealExpiring, now);
  assert.ok(reminderSoon);
  assert.match(reminderSoon.eventKey, /^deal_protection_expiring_6h_deal_100_/);
  assert.deepEqual(reminderSoon.recipientIds, ['buyer_1', 'seller_1']);

  const dealExpired = { ...dealFar, originalDeadlineMs: now - 60_000 };
  const reminderExpired = evaluateDealDeadlineNotification(dealExpired, now);
  assert.ok(reminderExpired);
  assert.match(reminderExpired.eventKey, /^deal_protection_expired_deal_100_/);

  const disputedDeal = { ...dealExpired, unresolvedReportCount: 1 };
  assert.equal(evaluateDealDeadlineNotification(disputedDeal, now), null);
});

test('classifyTokenServiceProbe distinguishes all 6 Token Service diagnostic states accurately', () => {
  const baseCfg = {
    configProjectId: 'responsive-dragon-tmn89',
    configProjectNumber: '448578956301',
    configApiKey: 'AIzaSyTestKey',
  };

  assert.equal(
    classifyTokenServiceProbe({
      ...baseCfg,
      httpStatus: 400,
      responseBody: '{"error":{"message":"INVALID_REFRESH_TOKEN"}}',
    }),
    'enabled_verified'
  );

  assert.equal(
    classifyTokenServiceProbe({
      ...baseCfg,
      httpStatus: 403,
      responseBody: 'Token Service API has not been used in project 448578956301 before or it is disabled. SERVICE_DISABLED',
    }),
    'disabled'
  );

  assert.equal(
    classifyTokenServiceProbe({
      ...baseCfg,
      httpStatus: 403,
      responseBody: 'SERVICE_DISABLED in projects/448578956301',
      enablementPending: true,
    }),
    'enablement_pending'
  );

  assert.equal(
    classifyTokenServiceProbe({
      ...baseCfg,
      httpStatus: 403,
      responseBody: 'SERVICE_DISABLED in projects/448578956301',
      permissionDeniedOnEnable: true,
    }),
    'permission_denied'
  );

  assert.equal(
    classifyTokenServiceProbe({
      ...baseCfg,
      httpStatus: 502,
      responseBody: 'Bad Gateway',
    }),
    'unable_to_verify'
  );

  assert.equal(
    classifyTokenServiceProbe({
      ...baseCfg,
      configProjectId: '',
      httpStatus: 400,
      responseBody: '{}',
    }),
    'config_mismatch'
  );
});

test('classifyAuthFailureCause never misattributes unrelated auth or Firestore errors to Token Service API', () => {
  assert.equal(
    classifyAuthFailureCause('Firebase: Error (auth/token-service-api-has-not-been-used-in-project-448578956301)'),
    'token_service_disabled'
  );
  assert.equal(classifyAuthFailureCause('PASSWORD_LOGIN_DISABLED'), 'password_provider_disabled');
  assert.equal(classifyAuthFailureCause('Firebase: Error (auth/unauthorized-domain).'), 'unauthorized_domain');
  assert.equal(classifyAuthFailureCause('Missing or insufficient permissions.'), 'firestore_permission_denied');
  assert.equal(truncateNotificationField('A'.repeat(200), 140).length <= 140, true);
});
