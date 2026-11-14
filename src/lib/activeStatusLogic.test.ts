import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateActiveStatusText,
  generateConnectionId,
  PresenceRecord,
  validatePresencePayload,
} from './activeStatusLogic';

test('activeStatusLogic: Active now when online and fresh', () => {
  const now = 1_700_000_000_000;
  const p: PresenceRecord = {
    state: 'online',
    lastActiveAt: now - 15_000,
    showStatus: true,
  };
  const res = calculateActiveStatusText(p, now, 'userA', 'userB');
  assert.equal(res.visible, true);
  assert.equal(res.isOnline, true);
  assert.equal(res.dotColor, 'green');
  assert.equal(res.text, 'Active now');
  assert.equal(res.ariaLabel, 'User is active now');
});

test('activeStatusLogic: Stale protection treats online > 90s as offline', () => {
  const now = 1_700_000_000_000;
  const p: PresenceRecord = {
    state: 'online',
    lastActiveAt: now - 95_000, // 95s ago -> stale!
    showStatus: true,
  };
  const res = calculateActiveStatusText(p, now, 'userA', 'userB');
  assert.equal(res.visible, true);
  assert.equal(res.isOnline, false);
  assert.equal(res.dotColor, 'grey');
  assert.equal(res.text, 'Active 1 min ago');
});

test('activeStatusLogic: Active just now when diff < 1 minute', () => {
  const now = 1_700_000_000_000;
  const p: PresenceRecord = {
    state: 'offline',
    lastActiveAt: now - 35_000, // 35s ago
    showStatus: true,
  };
  const res = calculateActiveStatusText(p, now, 'userA', 'userB');
  assert.equal(res.visible, true);
  assert.equal(res.isOnline, false);
  assert.equal(res.dotColor, 'grey');
  assert.equal(res.text, 'Active just now');
});

test('activeStatusLogic: Exact minutes from 1 to 59 min ago', () => {
  const now = 1_700_000_000_000;

  // 1 min ago
  let p: PresenceRecord = {
    state: 'offline',
    lastActiveAt: now - 65_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 1 min ago');

  // 17 min ago
  p = {
    state: 'offline',
    lastActiveAt: now - 17 * 60_000 - 12_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 17 min ago');

  // 59 min ago
  p = {
    state: 'offline',
    lastActiveAt: now - 59 * 60_000 - 45_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 59 min ago');
});

test('activeStatusLogic: Exact hours from 1 to 23 hr ago', () => {
  const now = 1_700_000_000_000;

  // 1 hr ago
  let p: PresenceRecord = {
    state: 'offline',
    lastActiveAt: now - 60 * 60_000 - 5_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 1 hr ago');

  // 6 hr ago
  p = {
    state: 'offline',
    lastActiveAt: now - 6 * 3_600_000 - 15 * 60_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 6 hr ago');

  // 23 hr ago
  p = {
    state: 'offline',
    lastActiveAt: now - 23 * 3_600_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 23 hr ago');
});

test('activeStatusLogic: 1 to 2 days ago (< 72 hours) with correct pluralization', () => {
  const now = 1_700_000_000_000;

  // 1 day ago (25 hours)
  let p: PresenceRecord = {
    state: 'offline',
    lastActiveAt: now - 25 * 3_600_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 1 day ago');

  // 2 days ago (49 hours)
  p = {
    state: 'offline',
    lastActiveAt: now - 49 * 3_600_000,
    showStatus: true,
  };
  assert.equal(calculateActiveStatusText(p, now).text, 'Active 2 days ago');
});

test('activeStatusLogic: 72 hours or more shows Offline', () => {
  const now = 1_700_000_000_000;
  const p: PresenceRecord = {
    state: 'offline',
    lastActiveAt: now - 73 * 3_600_000,
    showStatus: true,
  };
  const res = calculateActiveStatusText(p, now);
  assert.equal(res.text, 'Offline');
  assert.equal(res.dotColor, 'grey');
  assert.equal(res.isOnline, false);
});

test('activeStatusLogic: Missing record shows Offline', () => {
  const now = 1_700_000_000_000;
  assert.equal(calculateActiveStatusText(null, now).text, 'Offline');
  assert.equal(calculateActiveStatusText(undefined, now).text, 'Offline');
});

test('activeStatusLogic: Privacy toggle hides status from other visitors but user sees their own', () => {
  const now = 1_700_000_000_000;
  const p: PresenceRecord = {
    state: 'online',
    lastActiveAt: now - 10_000,
    showStatus: false, // User disabled active status
  };

  // Other visitor viewing: visible MUST be false
  const visitorResult = calculateActiveStatusText(p, now, 'visitor123', 'owner456');
  assert.equal(visitorResult.visible, false);
  assert.equal(visitorResult.text, '');

  // Owner viewing own status: visible is true
  const selfResult = calculateActiveStatusText(p, now, 'owner456', 'owner456');
  assert.equal(selfResult.visible, true);
  assert.equal(selfResult.isOnline, true);
  assert.equal(selfResult.text, 'Active now');
});

test('activeStatusLogic: validatePresencePayload validates fields correctly', () => {
  assert.equal(validatePresencePayload({ state: 'online', lastActiveAt: 12345 }).valid, true);
  assert.equal(
    validatePresencePayload({ state: 'offline', lastActiveAt: 12345, showStatus: false }).valid,
    true
  );
  assert.equal(validatePresencePayload({ state: 'invalid', lastActiveAt: 12345 }).valid, false);
  assert.equal(validatePresencePayload({ state: 'online', lastActiveAt: 'invalid' }).valid, false);
  assert.equal(validatePresencePayload({ state: 'online', lastActiveAt: 123, showStatus: 'notBool' }).valid, false);
});

test('activeStatusLogic: generateConnectionId creates unique prefix conn_', () => {
  const id1 = generateConnectionId();
  const id2 = generateConnectionId();
  assert.match(id1, /^conn_/);
  assert.notEqual(id1, id2);
});
