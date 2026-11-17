import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POPUP_THEME_LIBRARY,
  canUserAccessPopupCampaign,
  computePopupNotificationDashboardStats,
  dhakaInputToUtcMs,
  formatDhakaDateTime,
  mergePopupStyleWithThemeDefaults,
  resolveEffectivePopupStatus,
  sanitizePopupBannerImageUrl,
  sanitizePopupDestinationUrl,
  shouldDisplayPopupForFrequency,
  utcMsToDhakaInput,
  type PopupNotificationCampaign,
} from './popupNotificationLogic';

test('POPUP_THEME_LIBRARY provides all 10 required themes with distinct labels and valid defaults', () => {
  assert.equal(POPUP_THEME_LIBRARY.length, 10);
  const expectedLabels = [
    'Modern Gradient',
    'Premium Gold',
    'Professional Business',
    'Minimal White',
    'Dark Elegant',
    'Colorful Announcement',
    'Special Offer',
    'Warning Alert',
    'Success Notification',
    'Festive Celebration',
  ];
  assert.deepEqual(
    POPUP_THEME_LIBRARY.map((t) => t.label),
    expectedLabels
  );

  for (const theme of POPUP_THEME_LIBRARY) {
    assert.ok(theme.defaultTitle.length >= 4);
    assert.ok(theme.defaultBody.length >= 10);
    assert.match(theme.style.backgroundColor, /^#[0-9A-F]{6}$/);
    assert.match(theme.style.textColor, /^#[0-9A-F]{6}$/);
  }
});

test('Asia/Dhaka (UTC+06:00) scheduling converts cleanly without browser timezone drift', () => {
  const input = '2026-12-01T14:30';
  const utcMs = dhakaInputToUtcMs(input);
  // 14:30 BDT == 08:30 UTC
  assert.equal(utcMs, Date.UTC(2026, 11, 1, 8, 30, 0, 0));
  assert.equal(utcMsToDhakaInput(utcMs), input);
  assert.match(formatDhakaDateTime(utcMs), /BST/);
});

test('resolveEffectivePopupStatus handles draft, paused, scheduled, active, and expired transitions', () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);

  assert.equal(
    resolveEffectivePopupStatus({ storedStatus: 'draft', startAtMs: 0, expiresAtMs: 0 }, now),
    'draft'
  );
  assert.equal(
    resolveEffectivePopupStatus({ storedStatus: 'paused', startAtMs: 0, expiresAtMs: 0 }, now),
    'paused'
  );
  assert.equal(
    resolveEffectivePopupStatus(
      { storedStatus: 'active', startAtMs: now + 60_000, expiresAtMs: 0 },
      now
    ),
    'scheduled'
  );
  assert.equal(
    resolveEffectivePopupStatus(
      { storedStatus: 'active', startAtMs: now - 60_000, expiresAtMs: now + 60_000 },
      now
    ),
    'active'
  );
  assert.equal(
    resolveEffectivePopupStatus(
      { storedStatus: 'active', startAtMs: now - 120_000, expiresAtMs: now },
      now
    ),
    'expired'
  );
});

test('canUserAccessPopupCampaign enforces strict targetUserIds privacy isolation', () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);
  const targeted: Pick<
    PopupNotificationCampaign,
    'deliveryMode' | 'targetUserIds' | 'storedStatus' | 'startAtMs' | 'expiresAtMs'
  > = {
    deliveryMode: 'targeted',
    targetUserIds: ['uid_alice', 'uid_bob'],
    storedStatus: 'active',
    startAtMs: now - 10_000,
    expiresAtMs: now + 100_000,
  };

  assert.equal(canUserAccessPopupCampaign(targeted, null, now), false);
  assert.equal(canUserAccessPopupCampaign(targeted, 'uid_charlie', now), false);
  assert.equal(canUserAccessPopupCampaign(targeted, 'uid_alice', now), true);

  const globalCampaign = { ...targeted, deliveryMode: 'global' as const, targetUserIds: [] };
  assert.equal(canUserAccessPopupCampaign(globalCampaign, null, now), true);
  assert.equal(canUserAccessPopupCampaign(globalCampaign, 'uid_charlie', now), true);
});

test('shouldDisplayPopupForFrequency evaluates all 4 frequency modes accurately', () => {
  // once_per_user
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'once_per_user',
      serverReceipt: { viewed: false, dismissed: false },
    }),
    true
  );
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'once_per_user',
      serverReceipt: { viewed: true, dismissed: false },
    }),
    false
  );

  // once_per_session
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'once_per_session',
      localViewed: true,
      sessionViewed: false,
    }),
    true
  );
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'once_per_session',
      sessionViewed: true,
    }),
    false
  );

  // every_open
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'every_open',
      localViewed: true,
      localDismissed: true,
      sessionViewed: true,
      shownThisMount: false,
    }),
    true
  );
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'every_open',
      shownThisMount: true,
    }),
    false
  );

  // until_dismissed
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'until_dismissed',
      localViewed: true,
      sessionViewed: true,
      serverReceipt: { viewed: true, dismissed: false },
    }),
    true
  );
  assert.equal(
    shouldDisplayPopupForFrequency({
      campaignId: 'c1',
      frequency: 'until_dismissed',
      serverReceipt: { viewed: true, dismissed: true },
    }),
    false
  );
});

test('sanitizePopupDestinationUrl and sanitizePopupBannerImageUrl block XSS/javascript URIs', () => {
  assert.equal(sanitizePopupDestinationUrl('javascript:alert(1)'), '');
  assert.equal(sanitizePopupDestinationUrl('http://evil.com/phish'), '');
  assert.equal(sanitizePopupDestinationUrl('/market'), '/market');
  assert.equal(sanitizePopupDestinationUrl('https://bexora.com/deals'), 'https://bexora.com/deals');

  assert.equal(sanitizePopupBannerImageUrl('data:image/svg+xml;base64,PHN2Zz4='), '');
  assert.equal(
    sanitizePopupBannerImageUrl('data:image/jpeg;base64,/9j/4AAQSkZJRg=='),
    'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
  );
  assert.equal(
    sanitizePopupBannerImageUrl('https://cdn.bexora.com/banner.webp'),
    'https://cdn.bexora.com/banner.webp'
  );
});

test('mergePopupStyleWithThemeDefaults clamps invalid dimensions and keeps user overrides unlocked', () => {
  const custom = mergePopupStyleWithThemeDefaults('premium_gold', {
    backgroundColor: '#123456',
    fontSizePx: 99,
    popupWidthPx: 120,
    buttonText: 'Go Now',
  });
  assert.equal(custom.backgroundColor, '#123456');
  assert.equal(custom.fontSizePx, 24);
  assert.equal(custom.popupWidthPx, 320);
  assert.equal(custom.buttonText, 'Go Now');
});

test('computePopupNotificationDashboardStats summarizes active, scheduled, expired, audience, views & dismissals', () => {
  const now = Date.UTC(2026, 10, 17, 12, 0, 0);
  const style = mergePopupStyleWithThemeDefaults('modern_gradient');
  const base = {
    title: 'T',
    body: 'Body text here',
    themeId: 'modern_gradient' as const,
    style,
    bannerImageUrl: '',
    frequency: 'once_per_user' as const,
    createdBy: 'admin_1',
    createdAtMs: now - 10_000,
    updatedAtMs: now - 5_000,
  };
  const campaigns: PopupNotificationCampaign[] = [
    {
      ...base,
      id: 'c1',
      deliveryMode: 'global',
      targetUserIds: [],
      storedStatus: 'active',
      startAtMs: now - 1000,
      expiresAtMs: now + 50000,
      viewCount: 120,
      dismissCount: 40,
    },
    {
      ...base,
      id: 'c2',
      deliveryMode: 'targeted',
      targetUserIds: ['u1', 'u2'],
      storedStatus: 'active',
      startAtMs: now + 60000,
      expiresAtMs: 0,
      viewCount: 0,
      dismissCount: 0,
    },
    {
      ...base,
      id: 'c3',
      deliveryMode: 'targeted',
      targetUserIds: ['u3'],
      storedStatus: 'active',
      startAtMs: now - 100000,
      expiresAtMs: now - 1000,
      viewCount: 55,
      dismissCount: 12,
    },
  ];

  const stats = computePopupNotificationDashboardStats(campaigns, now);
  assert.deepEqual(stats, {
    total: 3,
    active: 1,
    scheduled: 1,
    expired: 1,
    globalCount: 1,
    targetedCount: 2,
    totalViews: 175,
    totalDismissals: 52,
  });
});
