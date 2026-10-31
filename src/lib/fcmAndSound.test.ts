import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPrivacySafePushPayload,
  DEAL_ROOM_VIBRATION_PATTERN,
  DEFAULT_NOTIFICATION_PREFERENCES,
  detectBrowserPushEnvironment,
  FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY,
  getDealRoomVibrationPattern,
  isValidVapidPublicKey,
  NOTIFICATION_SOUND_CATALOG,
  NotificationArrivalTracker,
  normalizeNotificationPreferences,
  resolveNotificationAlertKind,
  sanitizeSensitiveTokensFromPreview,
  selectSoundForAlertKind,
  STANDARD_DEAL_VIBRATION_PATTERN,
  STRONG_DEAL_VIBRATION_PATTERN,
} from './soundAndPushConfig';
import {
  classifyWebPushRegistrationError,
  resolveConfiguredVapidPublicKey,
} from './pushNotifications';
import type { NotificationRecord } from '../types';

function makeNotification(overrides: Partial<NotificationRecord> & { id: string }): NotificationRecord {
  return {
    id: overrides.id,
    recipientId: overrides.recipientId ?? 'user_buyer_1',
    actorId: overrides.actorId ?? 'user_seller_1',
    actorRole: overrides.actorRole ?? 'user',
    category: overrides.category ?? 'deal',
    severity: overrides.severity ?? 'info',
    alertKind: overrides.alertKind,
    title: overrides.title ?? 'Escrow Update',
    preview: overrides.preview ?? 'Your escrow status updated.',
    body: overrides.body ?? 'Full notification body.',
    refType: overrides.refType ?? 'deal',
    refId: overrides.refId ?? 'deal_123',
    referenceLabel: overrides.referenceLabel ?? 'Deal #deal_123',
    destination: overrides.destination ?? 'deal:deal_123',
    read: overrides.read ?? false,
    createdAtMs: overrides.createdAtMs ?? Date.now(),
  };
}

test('VAPID validator accepts genuine 65-byte uncompressed P-256 public key and rejects private keys or placeholders', () => {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const validPubBase64Url = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
  const privateKeyBase64Url = ecdh.getPrivateKey().toString('base64url');
  const compressedPubBase64Url = ecdh.getPublicKey(null, 'compressed').toString('base64url');

  assert.equal(isValidVapidPublicKey(validPubBase64Url), true);
  assert.equal(isValidVapidPublicKey(`  ${validPubBase64Url}  `), true);

  // Must reject 32-byte private keys, compressed keys, placeholders, empty strings, and forged 87-char strings not starting with 0x04
  assert.equal(isValidVapidPublicKey(privateKeyBase64Url), false);
  assert.equal(isValidVapidPublicKey(compressedPubBase64Url), false);
  assert.equal(isValidVapidPublicKey(''), false);
  assert.equal(isValidVapidPublicKey('PASTE_YOUR_VAPID_KEY_HERE'), false);

  const forgedBytes = Buffer.alloc(65, 0x02);
  assert.equal(isValidVapidPublicKey(forgedBytes.toString('base64url')), false);

  // Official Firebase Cloud Messaging built-in managed public VAPID key (`DEFAULT_VAPID_KEY`) is valid 65-byte 0x04 P-256
  assert.equal(isValidVapidPublicKey(FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY), true);
});

test('resolveConfiguredVapidPublicKey uses official FCM managed default public key automatically and eliminates unresolved env errors', () => {
  // Empty / unset env resolves cleanly to official FCM built-in public VAPID key
  const defaultResolved = resolveConfiguredVapidPublicKey(null, '');
  assert.equal(defaultResolved.key, FCM_OFFICIAL_DEFAULT_VAPID_PUBLIC_KEY);
  assert.equal(defaultResolved.source, 'fcm_default');
  assert.equal(defaultResolved.hasMalformedEnvValue, false);

  // Explicit custom P-256 public certificate overrides default
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const customPub = ecdh.getPublicKey(null, 'uncompressed').toString('base64url');
  const envResolved = resolveConfiguredVapidPublicKey(null, customPub);
  assert.equal(envResolved.key, customPub);
  assert.equal(envResolved.source, 'env');
  assert.equal(envResolved.hasMalformedEnvValue, false);

  // Public settings fallback overrides default when env is unset
  const pubSettingsResolved = resolveConfiguredVapidPublicKey(customPub, '');
  assert.equal(pubSettingsResolved.key, customPub);
  assert.equal(pubSettingsResolved.source, 'public_settings');

  // Malformed non-placeholder env string is still caught accurately
  const malformedResolved = resolveConfiguredVapidPublicKey(null, 'NOT_A_VALID_KEY_123');
  assert.equal(malformedResolved.key, '');
  assert.equal(malformedResolved.hasMalformedEnvValue, true);

  // .env.example must not declare unresolved FIREBASE_SERVICE_ACCOUNT_JSON="" or VITE_FIREBASE_VAPID_KEY=""
  const envExample = fs.readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');
  assert.doesNotMatch(envExample, /^FIREBASE_SERVICE_ACCOUNT_JSON=/m);
  assert.doesNotMatch(envExample, /^VITE_FIREBASE_VAPID_KEY=/m);
});

test('Default notification preferences preserve Sample 2 normal sound, Sample 4 deal alert sound, and Strong vibration', () => {
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.normalSoundId, '02_crisp_normal');
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.dealAlertSoundId, '04_urgent_deal');
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.vibrationEnabled, true);
  assert.equal(DEFAULT_NOTIFICATION_PREFERENCES.vibrationStrength, 'strong');

  const normalizedEmpty = normalizeNotificationPreferences(null);
  assert.equal(normalizedEmpty.normalSoundId, '02_crisp_normal');
  assert.equal(normalizedEmpty.dealAlertSoundId, '04_urgent_deal');
  assert.equal(normalizedEmpty.vibrationStrength, 'strong');

  assert.deepEqual(getDealRoomVibrationPattern('strong'), [260, 90, 320, 90, 260]);
  assert.deepEqual(getDealRoomVibrationPattern('standard'), [180, 90, 240]);
  assert.deepEqual(DEAL_ROOM_VIBRATION_PATTERN, STRONG_DEAL_VIBRATION_PATTERN);
  assert.notDeepEqual(STRONG_DEAL_VIBRATION_PATTERN, STANDARD_DEAL_VIBRATION_PATTERN);
});

test('All 4 bundled .wav sound files exist in public/sounds/ with valid RIFF/WAVE headers', () => {
  assert.equal(NOTIFICATION_SOUND_CATALOG.length, 4);
  for (const item of NOTIFICATION_SOUND_CATALOG) {
    const diskPath = path.join(process.cwd(), 'public', item.path.replace(/^\//, ''));
    assert.equal(fs.existsSync(diskPath), true, `Missing sound asset: ${diskPath}`);
    const buf = fs.readFileSync(diskPath);
    assert.ok(buf.length > 4096, `Sound asset unexpectedly small: ${diskPath}`);
    assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(buf.subarray(8, 12).toString('ascii'), 'WAVE');
  }
});

test('firebase-messaging-sw.js matches firebase-applet-config.json project identifiers and contains zero secrets', () => {
  const swSource = fs.readFileSync(path.join(process.cwd(), 'public', 'firebase-messaging-sw.js'), 'utf8');
  const appCfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'firebase-applet-config.json'), 'utf8'));

  assert.match(swSource, new RegExp(`projectId:\\s*'${appCfg.projectId}'`));
  assert.match(swSource, new RegExp(`messagingSenderId:\\s*'${appCfg.messagingSenderId}'`));
  assert.match(swSource, new RegExp(`appId:\\s*'${appCfg.appId}'`));
  assert.doesNotMatch(swSource, /PRIVATE_KEY|FIREBASE_SERVICE_ACCOUNT/i);
  assert.match(swSource, /importScripts\('\/vendor\/firebase\/firebase-app-compat\.js'\)/);
  assert.match(swSource, /importScripts\('\/vendor\/firebase\/firebase-messaging-compat\.js'\)/);
});

test('NotificationArrivalTracker stays silent on initial snapshot load and deduplicates re-snapshots while prioritizing deal_room_created', () => {
  const tracker = new NotificationArrivalTracker();
  const now = 1_800_000_000_000;

  // 1. Initial snapshot with 2 historical unread items -> MUST NOT chime
  const initial = tracker.processSnapshot(
    'uid_1',
    [
      makeNotification({ id: 'n_old_1', read: false, createdAtMs: now - 5_000 }),
      makeNotification({ id: 'n_old_2', read: false, alertKind: 'deal_room_created', createdAtMs: now - 2_000 }),
    ],
    now
  );
  assert.equal(initial.shouldAlert, false);

  // 2. Subsequent snapshot with same IDs -> MUST NOT chime
  const repeat = tracker.processSnapshot(
    'uid_1',
    [
      makeNotification({ id: 'n_old_1', read: false, createdAtMs: now - 5_000 }),
      makeNotification({ id: 'n_old_2', read: false, alertKind: 'deal_room_created', createdAtMs: now - 2_000 }),
    ],
    now + 1_000
  );
  assert.equal(repeat.shouldAlert, false);

  // 3. New normal unread notification arrives -> chimes once with 'normal'
  const freshNormal = tracker.processSnapshot(
    'uid_1',
    [
      makeNotification({ id: 'n_fresh_normal', read: false, category: 'bid', createdAtMs: now + 2_000 }),
      makeNotification({ id: 'n_old_1', read: false, createdAtMs: now - 5_000 }),
    ],
    now + 2_500
  );
  assert.equal(freshNormal.shouldAlert, true);
  assert.equal(freshNormal.alertKind, 'normal');
  assert.equal(freshNormal.triggerItem?.id, 'n_fresh_normal');

  // 4. Simultaneous arrival of normal + deal_room_created -> fires ONCE and prioritizes deal_room_created
  const burst = tracker.processSnapshot(
    'uid_1',
    [
      makeNotification({ id: 'n_burst_normal', read: false, category: 'wallet', createdAtMs: now + 4_000 }),
      makeNotification({
        id: 'n_burst_deal',
        read: false,
        category: 'deal',
        alertKind: 'deal_room_created',
        title: 'New Deal Room Created',
        createdAtMs: now + 4_000,
      }),
    ],
    now + 4_200
  );
  assert.equal(burst.shouldAlert, true);
  assert.equal(burst.alertKind, 'deal_room_created');
  assert.equal(burst.triggerItem?.id, 'n_burst_deal');

  // 5. Re-snapshot marking it read -> silent
  const afterRead = tracker.processSnapshot(
    'uid_1',
    [
      makeNotification({
        id: 'n_burst_deal',
        read: true,
        alertKind: 'deal_room_created',
        createdAtMs: now + 4_000,
      }),
    ],
    now + 5_000
  );
  assert.equal(afterRead.shouldAlert, false);
});

test('selectSoundForAlertKind respects independent normal, deal-room, admin sound choices and vibration toggle', () => {
  const customPrefs = normalizeNotificationPreferences({
    inAppSoundEnabled: true,
    dealAlertSoundEnabled: true,
    adminAlertSoundEnabled: true,
    vibrationEnabled: true,
    vibrationStrength: 'strong',
    lockScreenPrivacyMode: 'minimal',
    normalSoundId: '02_crisp_normal',
    dealAlertSoundId: '04_urgent_deal',
    adminAlertSoundId: '03_premium_deal',
  });

  const normalSel = selectSoundForAlertKind('normal', customPrefs);
  assert.equal(normalSel.soundId, '02_crisp_normal');
  assert.equal(normalSel.path, '/sounds/02_crisp_normal.wav');
  assert.equal(normalSel.shouldVibrate, false);

  const dealSel = selectSoundForAlertKind('deal_room_created', customPrefs);
  assert.equal(dealSel.soundId, '04_urgent_deal');
  assert.equal(dealSel.path, '/sounds/04_urgent_deal.wav');
  assert.equal(dealSel.shouldVibrate, true);

  const adminSel = selectSoundForAlertKind('admin_alert', customPrefs);
  assert.equal(adminSel.soundId, '03_premium_deal');
  assert.equal(adminSel.shouldVibrate, false);

  // Turning off vibration disables deal vibration while keeping deal sound
  const noVib = selectSoundForAlertKind('deal_room_created', {
    ...DEFAULT_NOTIFICATION_PREFERENCES,
    vibrationEnabled: false,
  });
  assert.equal(noVib.enabled, true);
  assert.equal(noVib.shouldVibrate, false);
});

test('classifyWebPushRegistrationError maps invalid VAPID, blocked permissions, and disabled FCM Registrations API accurately', () => {
  const invalidVapid = classifyWebPushRegistrationError(
    Object.assign(new Error('Failed to execute subscribe on PushManager: The provided applicationServerKey is not valid.'), {
      name: 'InvalidAccessError',
    })
  );
  assert.equal(invalidVapid.status, 'invalid_vapid_key');

  const blockedPerm = classifyWebPushRegistrationError(
    Object.assign(new Error('Messaging: The required permissions were not granted and blocked instead.'), {
      code: 'messaging/permission-blocked',
    })
  );
  assert.equal(blockedPerm.status, 'permission_denied');

  const disabledApi = classifyWebPushRegistrationError(
    Object.assign(new Error('FCM Registration API has not been used in project responsive-dragon-tmn89 before or it is disabled (SERVICE_DISABLED).'), {
      code: 'messaging/token-subscribe-failed',
    })
  );
  assert.equal(disabledApi.status, 'fcm_api_disabled');
});

test('buildPrivacySafePushPayload strips sensitive details and blocks malicious external destinations', () => {
  const minimalDeal = buildPrivacySafePushPayload({
    notificationId: 'ntf_deal_1',
    category: 'deal',
    alertKind: 'deal_room_created',
    title: 'New Deal Room Created',
    preview: 'Buyer paid ৳25,000 from 01712345678 (buyer@example.com) for YouTube Channel',
    destination: 'deal:deal_abc123',
    referenceLabel: 'Deal #deal_abc12',
    privacyMode: 'minimal',
  });
  assert.equal(minimalDeal.title, 'New Deal Room Created');
  assert.doesNotMatch(minimalDeal.body, /25,000|01712345678|buyer@example\.com|YouTube/);
  assert.equal(minimalDeal.destination, 'deal:deal_abc123');

  const standardWallet = buildPrivacySafePushPayload({
    notificationId: 'ntf_wal_1',
    category: 'wallet',
    alertKind: 'normal',
    title: 'Deposit Approved',
    preview: 'Credited ৳15,500 from +8801711223344 for user@test.com',
    destination: 'https://evil-phishing.example/steal',
    privacyMode: 'standard',
  });
  assert.doesNotMatch(standardWallet.body, /15,500|8801711223344|user@test\.com/);
  assert.equal(standardWallet.destination, '');

  assert.equal(
    sanitizeSensitiveTokensFromPreview('Paid $450 via test@mail.com +8801911223344'),
    'Paid [escrow amount] via [redacted-email] [redacted-number]'
  );
});

test('detectBrowserPushEnvironment accurately flags iOS Safari vs installed Home Screen PWA and secure context', () => {
  const iosSafariTab = detectBrowserPushEnvironment(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    false,
    true
  );
  assert.equal(iosSafariTab.isIOS, true);
  assert.equal(iosSafariTab.isStandalonePwa, false);
  assert.equal(iosSafariTab.iosRequiresHomeScreenInstall, true);
  assert.equal(iosSafariTab.isSecureContext, true);

  const insecureHttp = detectBrowserPushEnvironment(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0',
    false,
    false
  );
  assert.equal(insecureHttp.isSecureContext, false);
});

test('resolveNotificationAlertKind classifies deal_room_created, admin critical alerts, and normal updates', () => {
  assert.equal(
    resolveNotificationAlertKind({
      alertKind: 'deal_room_created',
      category: 'deal',
      severity: 'success',
      actorRole: 'user',
      title: 'New Deal Room Created',
    }),
    'deal_room_created'
  );
  assert.equal(
    resolveNotificationAlertKind({
      category: 'security',
      severity: 'critical',
      actorRole: 'admin',
      title: 'Urgent Account Hold',
    }),
    'admin_alert'
  );
  assert.equal(
    resolveNotificationAlertKind({
      category: 'bid',
      severity: 'info',
      actorRole: 'user',
      title: 'New Bid Placed',
    }),
    'normal'
  );
});
