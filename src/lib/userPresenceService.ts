import { useEffect, useState, useRef, useSyncExternalStore } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { db } from './firebase';
import type { UserPresence, UserPresenceSession, UserPresenceState } from '../types';
import {
  computeAggregatePresence,
  formatUserPresenceStatus,
  getOrCreateTabSessionId,
  isUserCurrentlyOnline,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  PRESENCE_STALE_THRESHOLD_MS,
  resolveDeviceType,
  type PresenceDisplayStatus,
} from './userPresenceLogic';

// Shared Listener Cache for deduplicated Firestore subscriptions
interface SharedPresenceSubscription {
  presence: UserPresence | null;
  listeners: Set<() => void>;
  unsubscribe: () => void;
  lastUpdatedMs: number;
}

const presenceCache = new Map<string, SharedPresenceSubscription>();

function notifyPresenceSubscribers(uid: string) {
  const sub = presenceCache.get(uid);
  if (sub) {
    for (const listener of sub.listeners) {
      try {
        listener();
      } catch {
        // Non-fatal listener error
      }
    }
  }
}

function subscribeToSharedPresence(uid: string, onStoreChange: () => void): () => void {
  let sub = presenceCache.get(uid);

  if (!sub) {
    const listeners = new Set<() => void>();
    listeners.add(onStoreChange);

    const docRef = doc(db, 'userPresence', uid);
    const unsubFirestore = onSnapshot(
      docRef,
      (snapshot) => {
        const cachedSub = presenceCache.get(uid);
        if (!cachedSub) return;

        if (!snapshot.exists()) {
          cachedSub.presence = {
            uid,
            state: 'offline',
            lastSeenMs: 0,
            activeSessions: 0,
          };
        } else {
          const d = snapshot.data();
          const lastSeen =
            typeof d.lastSeenMs === 'number'
              ? d.lastSeenMs
              : d.updatedAt?.toMillis?.() || Date.now();

          cachedSub.presence = {
            uid,
            state: (d.state as UserPresenceState) || 'offline',
            lastSeenMs: lastSeen,
            activeSessions: typeof d.activeSessions === 'number' ? d.activeSessions : 0,
            updatedAtMs: d.updatedAt?.toMillis?.(),
          };
        }
        cachedSub.lastUpdatedMs = Date.now();
        notifyPresenceSubscribers(uid);
      },
      (err) => {
        console.warn(`[UserPresence] Subscription error for ${uid}:`, err);
      }
    );

    sub = {
      presence: null,
      listeners,
      unsubscribe: unsubFirestore,
      lastUpdatedMs: Date.now(),
    };
    presenceCache.set(uid, sub);
  } else {
    sub.listeners.add(onStoreChange);
  }

  return () => {
    const existingSub = presenceCache.get(uid);
    if (existingSub) {
      existingSub.listeners.delete(onStoreChange);
      if (existingSub.listeners.size === 0) {
        existingSub.unsubscribe();
        presenceCache.delete(uid);
      }
    }
  };
}

function getSharedPresenceSnapshot(uid: string): UserPresence | null {
  return presenceCache.get(uid)?.presence ?? null;
}

/**
 * Hook to consume real-time presence for any single user.
 * Automatically ticks time locally every 30s to advance "last seen X minutes ago" labels without network overhead.
 */
export function useUserPresence(uid: string | null | undefined): {
  presence: UserPresence | null;
  isOnline: boolean;
  label: string;
  shortLabel: string;
  loading: boolean;
} {
  const validUid = uid && uid.trim().length > 0 ? uid.trim() : null;

  const presence = useSyncExternalStore(
    (onStoreChange) => {
      if (!validUid) return () => {};
      return subscribeToSharedPresence(validUid, onStoreChange);
    },
    () => {
      if (!validUid) return null;
      return getSharedPresenceSnapshot(validUid);
    }
  );

  // Local ticker to advance "X minutes ago" without re-querying Firestore
  const [tickEpoch, setTickEpoch] = useState<number>(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setTickEpoch(Date.now());
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  if (!validUid) {
    return {
      presence: null,
      isOnline: false,
      label: 'Offline',
      shortLabel: 'Offline',
      loading: false,
    };
  }

  const status = formatUserPresenceStatus(presence, tickEpoch);
  const loading = presence === null && presenceCache.has(validUid);

  return {
    presence,
    isOnline: status.isOnline,
    label: status.label,
    shortLabel: status.shortLabel,
    loading,
  };
}

/**
 * Initializes and manages active presence for the authenticated user.
 * Tracks tab session, sends periodic heartbeats, coordinates across tabs via BroadcastChannel,
 * and executes proper disconnect handling on page unload or visibility loss.
 */
export function initializeUserPresenceSession(uid: string): () => void {
  if (!uid || typeof window === 'undefined') {
    return () => {};
  }

  const sessionId = getOrCreateTabSessionId();
  const deviceType = resolveDeviceType();
  const sessionDocRef = doc(db, 'userPresence', uid, 'sessions', sessionId);
  const userPresenceDocRef = doc(db, 'userPresence', uid);

  let heartbeatInterval: NodeJS.Timeout | null = null;
  let broadcastChannel: BroadcastChannel | null = null;
  let isTornDown = false;

  // Local multi-tab tracker: sister tabs in the same browser
  const sisterTabs = new Map<string, number>();

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      broadcastChannel = new BroadcastChannel(`bexora_presence_${uid}`);
      broadcastChannel.onmessage = (event) => {
        if (!event?.data) return;
        const { type, senderSessionId, timestamp } = event.data;
        if (type === 'tab_heartbeat' && senderSessionId !== sessionId) {
          sisterTabs.set(senderSessionId, timestamp || Date.now());
        } else if (type === 'tab_closing' && senderSessionId !== sessionId) {
          sisterTabs.delete(senderSessionId);
        }
      };
    }
  } catch {
    // BroadcastChannel unsupported or restricted in sandbox
  }

  function broadcastHeartbeat() {
    if (broadcastChannel) {
      try {
        broadcastChannel.postMessage({
          type: 'tab_heartbeat',
          senderSessionId: sessionId,
          timestamp: Date.now(),
        });
      } catch {
        // Non-fatal
      }
    }
  }

  function broadcastClosing() {
    if (broadcastChannel) {
      try {
        broadcastChannel.postMessage({
          type: 'tab_closing',
          senderSessionId: sessionId,
        });
      } catch {
        // Non-fatal
      }
    }
  }

  // Prune dead sister tabs in local memory
  function getActiveSisterTabCount(): number {
    const now = Date.now();
    let count = 0;
    for (const [id, ts] of sisterTabs.entries()) {
      if (now - ts <= PRESENCE_STALE_THRESHOLD_MS) {
        count++;
      } else {
        sisterTabs.delete(id);
      }
    }
    return count;
  }

  const EFFECTIVE_HEARTBEAT_INTERVAL_MS = Math.max(60_000, PRESENCE_HEARTBEAT_INTERVAL_MS);

  async function writeOnlineHeartbeat() {
    if (isTornDown || document.hidden) return;
    const now = Date.now();

    try {
      // 1. Session heartbeat
      await setDoc(
        sessionDocRef,
        {
          sessionId,
          uid,
          deviceType,
          state: 'online',
          lastHeartbeatAtMs: now,
          createdAtMs: now,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      // 2. Aggregate user presence
      const activeSisterCount = getActiveSisterTabCount();
      await setDoc(
        userPresenceDocRef,
        {
          uid,
          state: 'online',
          lastSeenMs: now,
          activeSessions: Math.max(1, activeSisterCount + 1),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      broadcastHeartbeat();
    } catch (err) {
      console.warn('[UserPresence] Heartbeat error:', err);
    }
  }

  function startHeartbeatTimer() {
    if (heartbeatInterval || isTornDown || document.hidden) return;
    heartbeatInterval = setInterval(() => {
      if (!document.hidden && document.visibilityState === 'visible' && navigator.onLine) {
        void writeOnlineHeartbeat();
      }
    }, EFFECTIVE_HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeatTimer() {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  }

  async function handleTeardown() {
    if (isTornDown) return;
    isTornDown = true;

    stopHeartbeatTimer();

    broadcastClosing();

    const activeSisterCount = getActiveSisterTabCount();
    const now = Date.now();

    try {
      // Mark session as offline / delete session doc
      await deleteDoc(sessionDocRef).catch(() =>
        setDoc(
          sessionDocRef,
          {
            state: 'offline',
            lastHeartbeatAtMs: now,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        )
      );

      // If no other local tab is connected, mark user offline
      if (activeSisterCount === 0) {
        await setDoc(
          userPresenceDocRef,
          {
            uid,
            state: 'offline',
            lastSeenMs: now,
            activeSessions: 0,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      } else {
        // Another tab is still active: remain Online!
        await setDoc(
          userPresenceDocRef,
          {
            uid,
            state: 'online',
            lastSeenMs: now,
            activeSessions: activeSisterCount,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );
      }
    } catch {
      // Best-effort on unload
    }

    if (broadcastChannel) {
      try {
        broadcastChannel.close();
      } catch {
        // Non-fatal
      }
    }
  }

  // Visibility and Network listeners (pause heartbeats while hidden)
  const onVisibilityChange = () => {
    if (isTornDown) return;
    if (document.hidden || document.visibilityState !== 'visible') {
      stopHeartbeatTimer();
    } else {
      void writeOnlineHeartbeat();
      startHeartbeatTimer();
    }
  };

  const onOnlineEvent = () => {
    if (!isTornDown && !document.hidden) {
      void writeOnlineHeartbeat();
    }
  };

  const onPageHideEvent = () => {
    void handleTeardown();
  };

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('online', onOnlineEvent);
  window.addEventListener('pagehide', onPageHideEvent);
  window.addEventListener('beforeunload', onPageHideEvent);

  // Initial heartbeat only if tab is visible
  if (!document.hidden) {
    void writeOnlineHeartbeat();
    startHeartbeatTimer();
  }

  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('online', onOnlineEvent);
    window.removeEventListener('pagehide', onPageHideEvent);
    window.removeEventListener('beforeunload', onPageHideEvent);
    void handleTeardown();
  };
}
