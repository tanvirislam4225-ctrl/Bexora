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

firebase.initializeApp({
  apiKey: 'AIzaSyC_j2As3-45kP54cWDfzBOR69qqTR8rMr4',
  authDomain: 'responsive-dragon-tmn89.firebaseapp.com',
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
  const alertKind = data.alertKind === 'deal_room_created' ? 'deal_room_created' : 'normal';
  const destination = sanitizeSwDestination(data.destination || '');
  const notificationId = String(data.notificationId || data.tag || 'bexora-alert').slice(0, 96);

  const notificationTitle =
    data.title ||
    (alertKind === 'deal_room_created' ? 'New Deal Room Created' : 'BEXORA Notification');

  const notificationBody =
    data.body ||
    data.preview ||
    (alertKind === 'deal_room_created'
      ? 'Payment confirmed in BEXORA Escrow. Tap to open your private 3-party Deal Room.'
      : 'Open BEXORA to view your latest marketplace update.');

  const notificationOptions = {
    body: String(notificationBody).slice(0, 200),
    icon: '/icon-192.png',
    badge: '/favicon-32x32.png',
    tag: notificationId,
    renotify: alertKind === 'deal_room_created',
    requireInteraction: alertKind === 'deal_room_created',
    data: {
      destination,
      notificationId,
      alertKind,
    },
  };

  // Trigger deal-room tactile vibration pattern on supported mobile OS/browsers (Strong default: [260, 90, 320, 90, 260])
  if (alertKind === 'deal_room_created' && data.vibrationEnabled !== 'false') {
    notificationOptions.vibrate =
      data.vibrationStrength === 'standard' ? [180, 90, 240] : [260, 90, 320, 90, 260];
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
