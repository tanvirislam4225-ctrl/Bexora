/* BEXORA Firebase Cloud Messaging Service Worker (Web Push + Deep-Link Routing) */
/* Uses same-origin version-matched Firebase compat SDK (13.1.0) and public Web App identifiers only — zero secrets. */

importScripts('/vendor/firebase/firebase-app-compat.js');
importScripts('/vendor/firebase/firebase-messaging-compat.js');

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

const VERIFIED_BEXORA_AUTH_HOSTS = new Set([
  'bexora.com',
  'www.bexora.com',
  'auth.bexora.com',
  'bexora.ai.studio',
  'bexora-448578956301.asia-southeast1.run.app',
  'ais-pre-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
  'ais-dev-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
  'ais-mob-45y7auub4nznkdwaxyqbcw-496121292925.asia-southeast1.run.app',
]);

const swHost =
  typeof self !== 'undefined' && self.location && self.location.hostname
    ? self.location.hostname.toLowerCase()
    : '';
const swProto =
  typeof self !== 'undefined' && self.location && self.location.protocol
    ? self.location.protocol.toLowerCase()
    : '';

firebase.initializeApp({
  apiKey: 'AIzaSyC_j2As3-45kP54cWDfzBOR69qqTR8rMr4',
  authDomain:
    swProto === 'https:' && VERIFIED_BEXORA_AUTH_HOSTS.has(swHost)
      ? swHost
      : 'bexora.ai.studio',
  projectId: 'responsive-dragon-tmn89',
  storageBucket: 'responsive-dragon-tmn89.firebasestorage.app',
  messagingSenderId: '448578956301',
  appId: '1:448578956301:web:091629c6e19eafa50ef944',
});

function sanitizeSwDestination(rawDest) {
  if (typeof rawDest !== 'string') return '';
  const trimmed = rawDest.trim();
  if (!trimmed || trimmed.length > 160) return '';
  const lower = trimmed.toLowerCase();
  if (
    lower.startsWith('http:') ||
    lower.startsWith('https:') ||
    lower.startsWith('javascript:') ||
    lower.startsWith('data:') ||
    lower.startsWith('vbscript:') ||
    lower.startsWith('//') ||
    trimmed.includes('..') ||
    trimmed.includes('<') ||
    trimmed.includes('>') ||
    trimmed.includes('\\')
  ) {
    return '';
  }
  return /^[a-zA-Z0-9_:-]{1,160}$/.test(trimmed) ? trimmed : '';
}

function extractFallbackDestFromLink(rawLink) {
  if (typeof rawLink !== 'string' || !rawLink) return '';
  try {
    const parsed = new URL(rawLink, self.location.origin);
    if (parsed.origin !== self.location.origin) return '';
    return sanitizeSwDestination(parsed.searchParams.get('dest') || '');
  } catch {
    return '';
  }
}

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  // Guard against duplicate display if an external test push includes a top-level `notification` object
  // (which firebase-messaging-compat already auto-renders in its built-in push listener).
  if (payload && payload.notification && (payload.notification.title || payload.notification.body)) {
    return undefined;
  }

  const data = (payload && payload.data) || {};
  let alertKind = 'normal';
  if (data.alertKind === 'deal_room_created' || data.alertKind === 'level_3_premium') {
    alertKind = 'deal_room_created';
  } else if (data.alertKind === 'important' || data.alertKind === 'level_2_important') {
    alertKind = 'important';
  }

  const destination = sanitizeSwDestination(data.destination || '');
  const notificationId = String(data.notificationId || data.tag || 'bexora-alert').slice(0, 96);

  const notificationTitle =
    data.title ||
    (alertKind === 'deal_room_created'
      ? 'Congratulations! Your Listing Has Been Purchased'
      : alertKind === 'important'
      ? 'New Bid Received!'
      : 'BEXORA Notification');

  const notificationBody =
    data.body ||
    data.preview ||
    (alertKind === 'deal_room_created'
      ? 'A buyer has successfully paid. Your new deal is ready.'
      : alertKind === 'important'
      ? 'A new bid has been placed on your BEXORA listing.'
      : 'Open BEXORA to view your latest marketplace update.');

  const isLevel3 = alertKind === 'deal_room_created';
  const isLevel2 = alertKind === 'important';

  const notificationOptions = {
    body: String(notificationBody).slice(0, 200),
    icon: '/icon-192.png',
    badge: '/favicon-32x32.png',
    tag: notificationId,
    renotify: isLevel3 || isLevel2,
    requireInteraction: isLevel3,
    data: {
      destination,
      notificationId,
      alertKind,
    },
  };

  // Tactile vibration patterns: Level 2 = [180, 90, 240], Level 3 = [260, 90, 320, 90, 260]
  if (data.vibrationEnabled !== 'false') {
    if (isLevel3) {
      notificationOptions.vibrate =
        data.vibrationStrength === 'standard' ? [180, 90, 240] : [260, 90, 320, 90, 260];
    } else if (isLevel2) {
      notificationOptions.vibrate = [180, 90, 240];
    }
  }

  return self.registration.showNotification(String(notificationTitle).slice(0, 120), notificationOptions);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  const fcmMsg = data.FCM_MSG || {};
  const fcmLink = (fcmMsg.fcmOptions && fcmMsg.fcmOptions.link) || '';
  const destination =
    sanitizeSwDestination(data.destination || '') || extractFallbackDestFromLink(fcmLink);
  const notificationId = String(data.notificationId || event.notification.tag || '').slice(0, 96);
  const targetUrl = destination ? `/?dest=${encodeURIComponent(destination)}` : '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin && 'focus' in client) {
            client.postMessage({
              type: 'BEXORA_NOTIFICATION_CLICK',
              destination,
              notificationId,
            });
            return client.focus();
          }
        } catch {
          // Ignore malformed client URLs
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
      return undefined;
    })
  );
});
