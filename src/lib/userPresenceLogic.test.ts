import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAggregatePresence,
  formatUserPresenceStatus,
  isSessionStale,
  isUserCurrentlyOnline,
  resolveDeviceType,
} from './userPresenceLogic';

test('userPresenceLogic: formatUserPresenceStatus handles Online status', () => {
  const now = 1731300000000;
  const status = formatUserPresenceStatus(
    { state: 'online', lastSeenMs: now - 5_000 },
    now
  );
  assert.equal(status.isOnline, true);
  assert.equal(status.label, 'Online');
  assert.equal(status.shortLabel, 'Online');
});

test('userPresenceLogic: marks stale Online status as Offline if heartbeat window exceeded', () => {
  const now = 1731300000000;
  // 90 seconds ago with 65s threshold -> offline
  const status = formatUserPresenceStatus(
    { state: 'online', lastSeenMs: now - 90_000 },
    now,
    65_000
  );
  assert.equal(status.isOnline, false);
  assert.equal(status.label, 'Last seen 1 minute ago');
  assert.equal(status.shortLabel, '1m ago');
});

test('userPresenceLogic: formats "Last seen just now" for <1 minute activity', () => {
  const now = 1731300000000;
  const status = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: now - 20_000 },
    now
  );
  assert.equal(status.isOnline, false);
  assert.equal(status.label, 'Last seen just now');
  assert.equal(status.shortLabel, 'Just now');
});

test('userPresenceLogic: formats exact minutes (5 minutes, 15 minutes)', () => {
  const now = 1731300000000;
  const fiveMin = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: now - 5 * 60_000 },
    now
  );
  assert.equal(fiveMin.isOnline, false);
  assert.equal(fiveMin.label, 'Last seen 5 minutes ago');
  assert.equal(fiveMin.shortLabel, '5m ago');

  const fifteenMin = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: now - 15 * 60_000 },
    now
  );
  assert.equal(fifteenMin.isOnline, false);
  assert.equal(fifteenMin.label, 'Last seen 15 minutes ago');
  assert.equal(fifteenMin.shortLabel, '15m ago');
});

test('userPresenceLogic: formats exact hours (1 hour ago, 3 hours ago)', () => {
  const now = new Date(2026, 10, 11, 14, 0, 0).getTime();
  const oneHour = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: new Date(2026, 10, 11, 13, 0, 0).getTime() },
    now
  );
  assert.equal(oneHour.isOnline, false);
  assert.equal(oneHour.label, 'Last seen 1 hour ago');
  assert.equal(oneHour.shortLabel, '1h ago');

  const threeHours = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: new Date(2026, 10, 11, 11, 0, 0).getTime() },
    now
  );
  assert.equal(threeHours.isOnline, false);
  assert.equal(threeHours.label, 'Last seen 3 hours ago');
  assert.equal(threeHours.shortLabel, '3h ago');
});

test('userPresenceLogic: formats "Last seen yesterday"', () => {
  const now = new Date(2026, 10, 11, 10, 0, 0).getTime();
  const yesterday = new Date(2026, 10, 10, 18, 0, 0).getTime();
  const status = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: yesterday },
    now
  );
  assert.equal(status.isOnline, false);
  assert.equal(status.label, 'Last seen yesterday');
  assert.equal(status.shortLabel, 'Yesterday');
});

test('userPresenceLogic: formats older activity (days ago and date)', () => {
  const now = new Date(2026, 10, 11, 12, 0, 0).getTime();
  const threeDaysAgo = new Date(2026, 10, 8, 12, 0, 0).getTime();
  const status = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: threeDaysAgo },
    now
  );
  assert.equal(status.isOnline, false);
  assert.equal(status.label, 'Last seen 3 days ago');
  assert.equal(status.shortLabel, '3d ago');

  const tenDaysAgo = new Date(2026, 10, 1, 12, 0, 0).getTime();
  const olderStatus = formatUserPresenceStatus(
    { state: 'offline', lastSeenMs: tenDaysAgo },
    now
  );
  assert.equal(olderStatus.isOnline, false);
  assert.match(olderStatus.label, /Last seen Nov 1/);
});

test('userPresenceLogic: computeAggregatePresence keeps user Online if at least one session is active', () => {
  const now = 1731300000000;
  const sessions = [
    { state: 'offline', lastHeartbeatAtMs: now - 300_000 }, // dead tab
    { state: 'online', lastHeartbeatAtMs: now - 10_000 },  // active mobile
  ];

  const agg = computeAggregatePresence(sessions, now, 65_000);
  assert.equal(agg.isOnline, true);
  assert.equal(agg.activeSessions, 1);
  assert.equal(agg.latestActivityMs, now - 10_000);
});

test('userPresenceLogic: computeAggregatePresence marks Offline when all sessions are disconnected or stale', () => {
  const now = 1731300000000;
  const sessions = [
    { state: 'offline', lastHeartbeatAtMs: now - 120_000 },
    { state: 'online', lastHeartbeatAtMs: now - 90_000 }, // stale heartbeat > 65s
  ];

  const agg = computeAggregatePresence(sessions, now, 65_000);
  assert.equal(agg.isOnline, false);
  assert.equal(agg.activeSessions, 0);
  assert.equal(agg.latestActivityMs, now - 90_000);
});

test('userPresenceLogic: isSessionStale correctly flags heartbeats past threshold', () => {
  const now = 100_000;
  assert.equal(isSessionStale(now - 30_000, now, 60_000), false);
  assert.equal(isSessionStale(now - 70_000, now, 60_000), true);
  assert.equal(isSessionStale(0, now), true);
});

test('userPresenceLogic: resolveDeviceType accurately identifies desktop, mobile, tablet', () => {
  assert.equal(
    resolveDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X)'),
    'mobile'
  );
  assert.equal(
    resolveDeviceType('Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X)'),
    'tablet'
  );
  assert.equal(
    resolveDeviceType('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'),
    'desktop'
  );
});
