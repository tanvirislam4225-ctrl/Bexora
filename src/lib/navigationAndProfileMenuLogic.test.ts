import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfileMenuActions,
  DESKTOP_INLINE_NAV_MIN_WIDTH,
  shouldAutoCloseDrawerOnViewportWidth,
  shouldLockBodyScrollForDrawer,
} from './navigationAndProfileMenuLogic';

test('buildProfileMenuActions returns empty list when logged out', () => {
  assert.deepEqual(
    buildProfileMenuActions({ userUid: null, isAdmin: false }),
    []
  );
});

test('buildProfileMenuActions includes Main Dashboard, Deposit, Withdraw, View Public Profile, Safety & Appeals, and separated Logout at bottom', () => {
  const items = buildProfileMenuActions({
    userUid: 'uid_member_1',
    isAdmin: false,
    signingOut: false,
  });

  assert.deepEqual(
    items.map((i) => i.id),
    ['dashboard', 'deposit', 'withdraw', 'public_profile', 'safety_appeals', 'logout']
  );

  const primaryItems = items.filter((i) => i.section === 'primary');
  const footerItems = items.filter((i) => i.section === 'footer');

  assert.equal(primaryItems.length, 5);
  assert.equal(footerItems.length, 1);
  assert.equal(footerItems[0].id, 'logout');
  assert.equal(footerItems[0].label, 'Logout');
  assert.equal(footerItems[0].isDestructive, true);
});

test('buildProfileMenuActions includes Admin Console before Logout for admins and reflects signingOut label', () => {
  const items = buildProfileMenuActions({
    userUid: 'uid_admin_1',
    isAdmin: true,
    signingOut: true,
  });

  assert.deepEqual(
    items.map((i) => i.id),
    ['dashboard', 'deposit', 'withdraw', 'public_profile', 'safety_appeals', 'admin', 'logout']
  );
  assert.equal(items[items.length - 1].id, 'logout');
  assert.equal(items[items.length - 1].section, 'footer');
  assert.equal(items[items.length - 1].label, 'Signing out…');
});

test('drawer scroll lock and tablet vs desktop viewport breakpoint helpers behave deterministically', () => {
  assert.equal(shouldLockBodyScrollForDrawer(true), true);
  assert.equal(shouldLockBodyScrollForDrawer(false), false);

  // Small, standard, and large tablets (< 1280px) keep the hamburger drawer open
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, 600), false);
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, 768), false);
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, 820), false);
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, 1024), false);
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, 1180), false);

  // Desktop (>= 1280px) auto-closes the mobile/tablet drawer
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, DESKTOP_INLINE_NAV_MIN_WIDTH), true);
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(true, 1440), true);
  assert.equal(shouldAutoCloseDrawerOnViewportWidth(false, 1440), false);
});
