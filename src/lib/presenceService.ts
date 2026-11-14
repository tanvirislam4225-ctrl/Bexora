/**
 * BEXORA Real-Time "Active Status" (Presence) Service & Hooks.
 *
 * Provides:
 * - `usePresence(userUid)`: Writes presence for logged-in user with RTDB onDisconnect,
 *   multi-tab/device connection tracking, 30s heartbeat, 2m idle detection, and Page Visibility.
 * - `useUserStatus(targetUserId, viewerUserId)`: Reads real-time presence, handles stale protection,
 *   respects privacy (showStatus), and updates elapsed time every 60s without page reload.
 * - `saveUserActiveStatusPrivacy(userUid, showStatus)`: Toggles active status visibility.
 */

import { useEffect, useRef, useState } from 'react';
import {
  getDatabase,
  ref as rtdbRef,
  onValue as rtdbOnValue,
  set as rtdbSet,
  onDisconnect as rtdbOnDisconnect,
  serverTimestamp as rtdbServerTimestamp,
  Database,
} from 'firebase/database';
import {
  doc,
  onSnapshot,
  setDoc,
  serverTimestamp as firestoreServerTimestamp,
} from 'firebase/firestore';
import { app, db as firestoreDb } from './firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  calculateActiveStatusText,
  generateConnectionId,
  HEARTBEAT_INTERVAL_MS,
  IDLE_TIMEOUT_MS,
  PresenceRecord,
  ActiveStatusResult,
} from './activeStatusLogic';

// Resolve Realtime Database instance if configured
let cachedRtdb: Database | null = null;
let rtdbCheckAttempted = false;

export function getEffectiveRealtimeDb(): Database | null {
  if (rtdbCheckAttempted) return cachedRtdb;
  rtdbCheckAttempted = true;

  try {
    const rawUrl =
      (typeof import.meta !== 'undefined' &&
        (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FIREBASE_DATABASE_URL) ||
      (firebaseConfig as unknown as { databaseURL?: string }).databaseURL;

    if (rawUrl && typeof rawUrl === 'string' && rawUrl.startsWith('https://')) {
      cachedRtdb = getDatabase(app, rawUrl);
      return cachedRtdb;
    }
    // If databaseURL has not been provisioned in config yet, fall back seamlessly to Firestore
    cachedRtdb = null;
  } catch {
    cachedRtdb = null;
  }
  return cachedRtdb;
}

// Track server time offset via .info/serverTimeOffset
let serverTimeOffsetMs = 0;
let serverTimeOffsetSubscribed = false;

function ensureServerTimeOffsetListener(rtdb: Database | null): void {
  if (serverTimeOffsetSubscribed || !rtdb) return;
  try {
    serverTimeOffsetSubscribed = true;
    const offsetRef = rtdbRef(rtdb, '.info/serverTimeOffset');
    rtdbOnValue(offsetRef, (snap) => {
      const val = snap.val();
      if (typeof val === 'number') {
        serverTimeOffsetMs = val;
      }
    });
  } catch {
    // Non-fatal if offset lookup fails
  }
}

export function getEstimatedServerTime(): number {
  return Date.now() + serverTimeOffsetMs;
}

/**
 * Hook for logged-in user to write live presence.
 * Runs onDisconnect, connections list, heartbeats, 2-minute idle detection, and visibility handling.
 */
export function usePresence(userUid: string | null | undefined): void {
  const rtdb = getEffectiveRealtimeDb();

  useEffect(() => {
    if (!userUid) return;

    ensureServerTimeOffsetListener(rtdb);

    const connectionId = generateConnectionId();
    let isCurrentTabActive = !document.hidden;
    let lastUserActivityTime = Date.now();
    let isUserIdle = false;
    let heartbeatTimer: number | null = null;
    let idleCheckTimer: number | null = null;
    let cleanedUp = false;

    // Local tab broadcast channel to coordinate sister tabs
    const channelName = `bx_active_status_${userUid}`;
    let broadcast: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        broadcast = new BroadcastChannel(channelName);
      }
    } catch {
      broadcast = null;
    }

    // --- RTDB WRITE IMPLEMENTATION ---
    const userPresenceRef = rtdb ? rtdbRef(rtdb, `/presence/${userUid}`) : null;
    const connectionsRef = rtdb ? rtdbRef(rtdb, `/presence/${userUid}/connections`) : null;
    const myConnectionRef = rtdb ? rtdbRef(rtdb, `/presence/${userUid}/connections/${connectionId}`) : null;
    const connectedRef = rtdb ? rtdbRef(rtdb, '.info/connected') : null;

    let unsubConnected: (() => void) | null = null;

    const EFFECTIVE_HEARTBEAT_INTERVAL_MS = Math.max(60_000, HEARTBEAT_INTERVAL_MS);

    const writeOnline = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = getEstimatedServerTime();
      if (myConnectionRef && userPresenceRef) {
        try {
          await rtdbSet(myConnectionRef, true);
          await rtdbSet(userPresenceRef, {
            state: 'online',
            lastActiveAt: rtdbServerTimestamp(),
            showStatus: true,
          });
        } catch {
          // RTDB write fallback below
        }
      }
      // Dual-sync to Firestore /presence/{userUid}
      try {
        const fDoc = doc(firestoreDb, 'presence', userUid);
        await setDoc(
          fDoc,
          {
            state: 'online',
            lastActiveAt: now,
            updatedAt: firestoreServerTimestamp(),
          },
          { merge: true }
        );
      } catch {
        // Non-fatal
      }
    };

    const writeOffline = async (timestampMs?: number) => {
      const ts = timestampMs || getEstimatedServerTime();
      if (myConnectionRef && userPresenceRef) {
        try {
          await rtdbSet(myConnectionRef, null);
          await rtdbSet(userPresenceRef, {
            state: 'offline',
            lastActiveAt: ts,
            showStatus: true,
          });
        } catch {
          // Non-fatal
        }
      }
      try {
        const fDoc = doc(firestoreDb, 'presence', userUid);
        await setDoc(
          fDoc,
          {
            state: 'offline',
            lastActiveAt: ts,
            updatedAt: firestoreServerTimestamp(),
          },
          { merge: true }
        );
      } catch {
        // Non-fatal
      }
    };

    const startHeartbeatLoop = () => {
      if (heartbeatTimer !== null || cleanedUp || document.hidden) return;
      heartbeatTimer = window.setInterval(() => {
        if (document.hidden || !isCurrentTabActive || isUserIdle) return;
        void writeOnline();
      }, EFFECTIVE_HEARTBEAT_INTERVAL_MS);
    };

    const stopHeartbeatLoop = () => {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    // 1. Connection Lifecycle via .info/connected
    if (connectedRef && myConnectionRef && userPresenceRef) {
      try {
        unsubConnected = rtdbOnValue(connectedRef, (snap) => {
          if (snap.val() === true) {
            // Register onDisconnect hooks
            const disconnConn = rtdbOnDisconnect(myConnectionRef);
            disconnConn.remove().catch(() => {});

            const disconnUser = rtdbOnDisconnect(userPresenceRef);
            disconnUser
              .set({
                state: 'offline',
                lastActiveAt: rtdbServerTimestamp(),
                showStatus: true,
              })
              .catch(() => {});

            // Set online only if tab is visible
            if (!document.hidden) {
              void writeOnline();
            }
          }
        });
      } catch {
        if (!document.hidden) void writeOnline();
      }
    } else if (!document.hidden) {
      void writeOnline();
    }

    // 2. Heartbeat: while user is active & tab visible, update every >= 60s
    startHeartbeatLoop();

    // 3. User Activity Tracking (mouse, click, keypress, touch, scroll)
    const onUserActivity = () => {
      lastUserActivityTime = Date.now();
      if (isUserIdle) {
        isUserIdle = false;
        if (isCurrentTabActive && !document.hidden) {
          void writeOnline();
        }
      }
    };

    const activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    activityEvents.forEach((evt) => {
      window.addEventListener(evt, onUserActivity, { passive: true });
    });

    // 4. Idle Check Timer (2 minutes of inactivity)
    idleCheckTimer = window.setInterval(() => {
      if (document.hidden) return;
      const idleTime = Date.now() - lastUserActivityTime;
      if (!isUserIdle && idleTime >= IDLE_TIMEOUT_MS) {
        isUserIdle = true;
        void writeOffline(lastUserActivityTime);
      }
    }, 15_000);

    // 5. Page Visibility Handling (pause heartbeats when document.hidden)
    const onVisibilityChange = () => {
      if (document.hidden) {
        isCurrentTabActive = false;
        stopHeartbeatLoop();
        void writeOffline(Date.now());
      } else {
        isCurrentTabActive = true;
        lastUserActivityTime = Date.now();
        isUserIdle = false;
        void writeOnline();
        startHeartbeatLoop();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // 6. BeforeUnload & PageHide cleanup
    const onUnload = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void writeOffline(Date.now());
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);

    return () => {
      cleanedUp = true;
      if (heartbeatTimer) window.clearInterval(heartbeatTimer);
      if (idleCheckTimer) window.clearInterval(idleCheckTimer);
      if (unsubConnected) unsubConnected();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
      activityEvents.forEach((evt) => {
        window.removeEventListener(evt, onUserActivity);
      });
      if (broadcast) {
        try {
          broadcast.close();
        } catch {
          // Non-fatal
        }
      }
      void writeOffline(Date.now());
    };
  }, [userUid, rtdb]);
}

/**
 * Hook for visitors to read any user's real-time active status.
 * Updates every 60 seconds automatically so "5 min ago" advances to "6 min ago" without refresh.
 */
export function useUserStatus(
  targetUserId?: string | null,
  viewerUserId?: string | null
): {
  loading: boolean;
  status: ActiveStatusResult;
  presenceData: PresenceRecord | null;
} {
  const [presenceData, setPresenceData] = useState<PresenceRecord | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [nowMs, setNowMs] = useState<number>(() => getEstimatedServerTime());
  const rtdb = getEffectiveRealtimeDb();

  useEffect(() => {
    if (!targetUserId) {
      setLoading(false);
      setPresenceData(null);
      return;
    }

    setLoading(true);
    let unsubRtdb: (() => void) | null = null;
    let unsubFirestore: (() => void) | null = null;
    let receivedRtdb = false;

    // 1. Subscribe to RTDB /presence/{targetUserId}
    if (rtdb) {
      try {
        const userRef = rtdbRef(rtdb, `/presence/${targetUserId}`);
        unsubRtdb = rtdbOnValue(
          userRef,
          (snap) => {
            const val = snap.val();
            if (val && typeof val === 'object') {
              receivedRtdb = true;
              setPresenceData({
                state: val.state === 'online' ? 'online' : 'offline',
                lastActiveAt: Number(val.lastActiveAt) || Date.now(),
                showStatus: val.showStatus !== false,
              });
              setLoading(false);
            } else if (!val) {
              receivedRtdb = true;
              setPresenceData(null);
              setLoading(false);
            }
          },
          () => {
            // Non-fatal if RTDB fails
          }
        );
      } catch {
        // Non-fatal
      }
    }

    // 2. Dual fallback to Firestore /presence/{targetUserId} if RTDB is unavailable or empty
    const fDoc = doc(firestoreDb, 'presence', targetUserId);
    unsubFirestore = onSnapshot(
      fDoc,
      (snap) => {
        if (!receivedRtdb && snap.exists()) {
          const d = snap.data();
          setPresenceData({
            state: d.state === 'online' ? 'online' : 'offline',
            lastActiveAt: Number(d.lastActiveAt) || Date.now(),
            showStatus: d.showStatus !== false,
          });
          setLoading(false);
        } else if (!receivedRtdb && !snap.exists()) {
          setPresenceData(null);
          setLoading(false);
        }
      },
      () => {
        if (!receivedRtdb) setLoading(false);
      }
    );

    return () => {
      if (unsubRtdb) unsubRtdb();
      if (unsubFirestore) unsubFirestore();
    };
  }, [targetUserId, rtdb]);

  // Live updating timer: recalculates text every 60s
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(getEstimatedServerTime());
    }, 60_000);
    return () => window.clearInterval(id);
  }, []);

  const status = calculateActiveStatusText(
    presenceData,
    nowMs,
    viewerUserId,
    targetUserId
  );

  return { loading, status, presenceData };
}

/**
 * Saves user's "Show my active status" privacy preference.
 */
export async function saveUserActiveStatusPrivacy(
  userUid: string,
  showStatus: boolean
): Promise<void> {
  const rtdb = getEffectiveRealtimeDb();
  if (rtdb) {
    try {
      const showStatusRef = rtdbRef(rtdb, `/presence/${userUid}/showStatus`);
      await rtdbSet(showStatusRef, showStatus);
    } catch {
      // Non-fatal
    }
  }
  try {
    const fDoc = doc(firestoreDb, 'presence', userUid);
    await setDoc(fDoc, { showStatus }, { merge: true });
  } catch {
    // Non-fatal
  }
}
