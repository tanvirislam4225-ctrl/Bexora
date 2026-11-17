import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { db, fetchWithFreshBearerToken } from '../lib/firebase';
import { buildApiUrl } from '../lib/apiClient';
import {
  isPopupCampaignLiveNow,
  mergePopupStyleWithThemeDefaults,
  sanitizePopupBannerImageUrl,
  shouldDisplayPopupForFrequency,
  type PopupNotificationCampaign,
  type PopupNotificationFrequency,
  type PopupNotificationReceiptState,
  type PopupNotificationStyleConfig,
  type PopupNotificationThemeId,
} from '../lib/popupNotificationLogic';
import { PopupNotificationModal } from './PopupNotificationModal';

interface PopupNotificationHostProps {
  userUid: string | null;
  onNavigateDestination: (destination: string) => void;
}

const LOCAL_RECEIPT_STORAGE_KEY = 'bexora_popup_receipts_v1';
const SESSION_VIEWED_STORAGE_KEY = 'bexora_popup_session_viewed_v1';
const SESSION_KEY_STORAGE_KEY = 'bexora_popup_session_key_v1';

function getOrCreateSessionKey(): string {
  if (typeof window === 'undefined') return 'ssr';
  try {
    const existing = window.sessionStorage.getItem(SESSION_KEY_STORAGE_KEY);
    if (existing) return existing;
    const generated = `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    window.sessionStorage.setItem(SESSION_KEY_STORAGE_KEY, generated);
    return generated;
  } catch {
    return 'mem';
  }
}

function readLocalStorageReceipts(): Record<string, { viewed?: boolean; dismissed?: boolean }> {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(LOCAL_RECEIPT_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeLocalStorageReceipt(
  campaignId: string,
  patch: { viewed?: boolean; dismissed?: boolean }
) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const current = readLocalStorageReceipts();
    const prev = current[campaignId] || {};
    current[campaignId] = {
      viewed: patch.viewed ?? prev.viewed ?? false,
      dismissed: patch.dismissed ?? prev.dismissed ?? false,
    };
    window.localStorage.setItem(LOCAL_RECEIPT_STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Non-fatal in private browsing
  }
}

function readSessionViewedSet(): Set<string> {
  if (typeof window === 'undefined' || !window.sessionStorage) return new Set();
  try {
    const raw = window.sessionStorage.getItem(SESSION_VIEWED_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
  } catch {
    return new Set();
  }
}

function markSessionViewed(campaignId: string) {
  if (typeof window === 'undefined' || !window.sessionStorage) return;
  try {
    const next = readSessionViewedSet();
    next.add(campaignId);
    window.sessionStorage.setItem(SESSION_VIEWED_STORAGE_KEY, JSON.stringify(Array.from(next)));
  } catch {
    // Non-fatal
  }
}

function mapDocToCampaign(
  id: string,
  raw: Record<string, unknown>,
  deliveryMode: 'global' | 'targeted'
): PopupNotificationCampaign {
  const themeId = String(raw.themeId || 'modern_gradient') as PopupNotificationThemeId;
  const freq = String(raw.frequency || 'once_per_user') as PopupNotificationFrequency;
  const storedStatus =
    raw.storedStatus === 'active' || raw.storedStatus === 'paused' ? raw.storedStatus : 'draft';
  return {
    id,
    title: String(raw.title || ''),
    body: String(raw.body || ''),
    deliveryMode,
    targetUserIds: [],
    themeId,
    style: mergePopupStyleWithThemeDefaults(
      themeId,
      (raw.style || {}) as Partial<PopupNotificationStyleConfig>
    ),
    bannerImageUrl: sanitizePopupBannerImageUrl(raw.bannerImageUrl),
    frequency: freq,
    storedStatus,
    startAtMs: Math.max(0, Number(raw.startAtMs || 0)),
    expiresAtMs: Math.max(0, Number(raw.expiresAtMs || 0)),
    viewCount: Math.max(0, Number(raw.viewCount || 0)),
    dismissCount: Math.max(0, Number(raw.dismissCount || 0)),
    createdBy: String(raw.createdBy || ''),
    createdAtMs: Number(raw.createdAtMs || 0),
    updatedAtMs: Number(raw.updatedAtMs || 0),
  };
}

export const PopupNotificationHost: React.FC<PopupNotificationHostProps> = ({
  userUid,
  onNavigateDestination,
}) => {
  const [globalCampaigns, setGlobalCampaigns] = useState<PopupNotificationCampaign[]>([]);
  const [targetedCampaigns, setTargetedCampaigns] = useState<PopupNotificationCampaign[]>([]);
  const [serverReceipts, setServerReceipts] = useState<Record<string, PopupNotificationReceiptState>>(
    {}
  );
  const [shownThisMountIds, setShownThisMountIds] = useState<Record<string, boolean>>({});
  const [receiptTick, setReceiptTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const trackedViewsRef = useRef<Set<string>>(new Set());
  const sessionKey = useMemo(() => getOrCreateSessionKey(), []);

  // Refresh time check every 30s so scheduled popups appear & expired popups disappear accurately
  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Subscribe to active global campaigns (readable by all visitors & signed-in members)
  useEffect(() => {
    const q = query(
      collection(db, 'popupNotifications'),
      where('deliveryMode', '==', 'global'),
      where('storedStatus', '==', 'active'),
      limit(20)
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) =>
          mapDocToCampaign(d.id, d.data() as Record<string, unknown>, 'global')
        );
        setGlobalCampaigns(list);
      },
      () => {
        // Fallback fetch via API if snapshot is temporarily offline
        void fetch(buildApiUrl('/api/popup-notifications/active'))
          .then((r) => r.json())
          .then((json: { ok?: boolean; notifications?: PopupNotificationCampaign[] }) => {
            if (json?.ok && Array.isArray(json.notifications)) {
              setGlobalCampaigns(json.notifications.filter((c) => c.deliveryMode === 'global'));
            }
          })
          .catch(() => {});
      }
    );
    return () => unsub();
  }, []);

  // Subscribe to signed-in user's targeted popups & cross-device receipts
  useEffect(() => {
    if (!userUid) {
      setTargetedCampaigns([]);
      setServerReceipts({});
      return;
    }

    const targetsQuery = query(
      collection(db, 'popupNotificationTargets'),
      where('targetUid', '==', userUid),
      where('storedStatus', '==', 'active'),
      limit(20)
    );
    const receiptsQuery = query(
      collection(db, 'popupNotificationReceipts'),
      where('uid', '==', userUid),
      limit(100)
    );

    const unsubTargets = onSnapshot(
      targetsQuery,
      (snap) => {
        const list = snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>;
          const cid = String(data.campaignId || d.id);
          return mapDocToCampaign(cid, data, 'targeted');
        });
        setTargetedCampaigns(list);
      },
      () => {
        setTargetedCampaigns([]);
      }
    );

    const unsubReceipts = onSnapshot(
      receiptsQuery,
      (snap) => {
        const map: Record<string, PopupNotificationReceiptState> = {};
        for (const d of snap.docs) {
          const data = d.data() as Record<string, unknown>;
          const cid = String(data.campaignId || '');
          if (cid) {
            map[cid] = {
              viewed: Boolean(data.viewed),
              dismissed: Boolean(data.dismissed),
              viewedAtMs: Number(data.viewedAtMs || 0),
              dismissedAtMs: Number(data.dismissedAtMs || 0),
            };
          }
        }
        setServerReceipts(map);
      },
      () => {}
    );

    return () => {
      unsubTargets();
      unsubReceipts();
    };
  }, [userUid]);

  const syncSignedInReceiptClient = useCallback(
    async (campaignId: string, event: 'view' | 'dismiss') => {
      if (!userUid) return;
      const receiptId = `pnr_${campaignId}_${userUid}`;
      const receiptRef = doc(db, 'popupNotificationReceipts', receiptId);
      const clientNow = Date.now();
      try {
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(receiptRef);
          if (snap.exists()) {
            const existing = snap.data() || {};
            const nextDismissed = event === 'dismiss' ? true : Boolean(existing.dismissed);
            tx.update(receiptRef, {
              viewed: true,
              dismissed: nextDismissed,
              viewedAtMs: existing.viewedAtMs ? Number(existing.viewedAtMs) : clientNow,
              dismissedAtMs:
                event === 'dismiss' && !existing.dismissed
                  ? clientNow
                  : Number(existing.dismissedAtMs || 0),
              updatedAt: serverTimestamp(),
            });
          } else {
            tx.set(receiptRef, {
              campaignId,
              uid: userUid,
              viewed: true,
              dismissed: event === 'dismiss',
              viewedAtMs: clientNow,
              dismissedAtMs: event === 'dismiss' ? clientNow : 0,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          }
        });
      } catch {
        // Server track route also persists receipts in production
      }
    },
    [userUid]
  );

  const trackCampaignEvent = useCallback(
    async (campaignId: string, event: 'view' | 'dismiss') => {
      const payload = JSON.stringify({ event, sessionKey });
      if (userUid) {
        void syncSignedInReceiptClient(campaignId, event);
        await fetchWithFreshBearerToken(
          `/api/popup-notifications/${encodeURIComponent(campaignId)}/track`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }
        ).catch(() => {});
      } else {
        await fetch(
          buildApiUrl(`/api/popup-notifications/${encodeURIComponent(campaignId)}/track`),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
          }
        ).catch(() => {});
      }
    },
    [sessionKey, syncSignedInReceiptClient, userUid]
  );

  // Merge targeted + global live campaigns and select the highest-priority eligible popup
  const activePopup = useMemo(() => {
    const merged = new Map<string, PopupNotificationCampaign>();
    for (const c of targetedCampaigns) {
      if (isPopupCampaignLiveNow(c, nowMs)) {
        merged.set(c.id, c);
      }
    }
    for (const c of globalCampaigns) {
      if (!merged.has(c.id) && isPopupCampaignLiveNow(c, nowMs)) {
        merged.set(c.id, c);
      }
    }

    const localReceipts = readLocalStorageReceipts();
    const sessionViewed = readSessionViewedSet();

    const ordered = Array.from(merged.values()).sort((a, b) => {
      // Targeted personal notifications display before global banners; newest first within same tier
      if (a.deliveryMode !== b.deliveryMode) {
        return a.deliveryMode === 'targeted' ? -1 : 1;
      }
      return (b.updatedAtMs || b.createdAtMs || 0) - (a.updatedAtMs || a.createdAtMs || 0);
    });

    for (const c of ordered) {
      const receiptKey = userUid ? `${c.id}` : c.id;
      const localEntry = localReceipts[receiptKey];
      const eligible = shouldDisplayPopupForFrequency({
        campaignId: c.id,
        frequency: c.frequency,
        serverReceipt: userUid ? serverReceipts[c.id] || null : null,
        localViewed: Boolean(localEntry?.viewed),
        localDismissed: Boolean(localEntry?.dismissed),
        sessionViewed: sessionViewed.has(c.id),
        shownThisMount: Boolean(shownThisMountIds[c.id]),
      });
      if (eligible) return c;
    }

    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    targetedCampaigns,
    globalCampaigns,
    serverReceipts,
    shownThisMountIds,
    nowMs,
    userUid,
    receiptTick,
  ]);

  // Deduplicated view recording when a popup displays
  useEffect(() => {
    if (!activePopup) return;
    if (trackedViewsRef.current.has(activePopup.id)) return;
    trackedViewsRef.current.add(activePopup.id);

    markSessionViewed(activePopup.id);
    if (!userUid || activePopup.frequency === 'once_per_user') {
      writeLocalStorageReceipt(activePopup.id, { viewed: true });
    }
    void trackCampaignEvent(activePopup.id, 'view');
  }, [activePopup, trackCampaignEvent, userUid]);

  const handleDismiss = useCallback(
    (campaign: PopupNotificationCampaign) => {
      setShownThisMountIds((prev) => ({ ...prev, [campaign.id]: true }));
      markSessionViewed(campaign.id);
      writeLocalStorageReceipt(campaign.id, { viewed: true, dismissed: true });
      setReceiptTick((n) => n + 1);
      void trackCampaignEvent(campaign.id, 'dismiss');
    },
    [trackCampaignEvent]
  );

  if (!activePopup) return null;

  return (
    <PopupNotificationModal
      campaign={activePopup}
      onDismiss={() => handleDismiss(activePopup)}
      onActionNavigate={(dest) => {
        handleDismiss(activePopup);
        onNavigateDestination(dest);
      }}
    />
  );
};
