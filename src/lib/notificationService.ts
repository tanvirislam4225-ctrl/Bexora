import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import {
  buildNotificationId,
  chunkForFirestoreBatch,
  isValidFirestoreDocId,
  sanitizeNotificationDestination,
  truncateNotificationField,
} from './notificationLogic';
import type {
  AnnouncementRecord,
  NotificationAlertKind,
  NotificationCategory,
  NotificationRecord,
  NotificationRefType,
  NotificationSeverity,
} from '../types';
import { dispatchBackgroundWebPush } from './pushNotifications';
import { resolveNotificationAlertKind } from './soundAndPushConfig';

export const BOOTSTRAPPED_SUPERADMIN_UID = 'FFiOzaXKxBMuCzoQXM68sy3aPax2';

export interface EmitNotificationInput {
  recipientId: string;
  eventKey: string;
  actorId?: string;
  actorRole?: 'user' | 'admin' | 'system';
  category: NotificationCategory;
  severity?: NotificationSeverity;
  alertKind?: NotificationAlertKind;
  title: string;
  preview: string;
  body: string;
  refType?: NotificationRefType;
  refId?: string;
  referenceLabel?: string;
  destination?: string;
}

const inFlightCreateIds = new Set<string>();
const inFlightMarkAllByUid = new Map<string, Promise<{ updatedCount: number }>>();

/**
 * Emits a real Firestore-backed notification idempotently AFTER the underlying marketplace action succeeds.
 * - Uses deterministic IDs (`buildNotificationId(recipientId, eventKey)`) so retries/listeners never duplicate.
 * - For self-scoped notifications (`recipientId === currentUid`), checks `getDoc` first so an existing or already-read
 *   notification is never overwritten. For cross-user counterparty notifications (`recipientId !== currentUid`),
 *   Security Rules intentionally forbid reading another user's notification doc (`get`), so we write directly via
 *   `setDoc` with deterministic ID; if already created, Firestore rejects `update` and we treat that idempotent replay cleanly.
 */
export async function emitUserNotification(
  input: EmitNotificationInput
): Promise<{ created: boolean; id: string }> {
  const currentUser = auth.currentUser;
  const recipientId = String(input.recipientId || '').trim();
  if (!currentUser || !isValidFirestoreDocId(recipientId)) {
    return { created: false, id: '' };
  }

  const actorId = String(input.actorId || currentUser.uid).trim();
  if (actorId !== currentUser.uid) {
    return { created: false, id: '' };
  }

  const notificationId = buildNotificationId(recipientId, input.eventKey);
  if (inFlightCreateIds.has(notificationId)) {
    return { created: false, id: notificationId };
  }
  inFlightCreateIds.add(notificationId);

  const safeDest = sanitizeNotificationDestination(input.destination);
  const destination = safeDest ? safeDest.raw : '';
  const refType: NotificationRefType = input.refType || 'none';
  const rawRefId = String(input.refId || '').trim();
  const refId = refType === 'none' ? '' : isValidFirestoreDocId(rawRefId) ? rawRefId : '';
  const referenceLabel = truncateNotificationField(input.referenceLabel || '', 140);
  const title = truncateNotificationField(input.title || 'BEXORA Update', 140) || 'BEXORA Update';
  const preview = truncateNotificationField(input.preview || title, 240) || title;
  const body = truncateNotificationField(input.body || preview, 2000) || preview;
  const actorRole: 'user' | 'admin' | 'system' = input.actorRole || 'user';
  const severity: NotificationSeverity = input.severity || 'info';
  const resolvedAlertKind: NotificationAlertKind = resolveNotificationAlertKind({
    alertKind: input.alertKind,
    category: input.category,
    severity,
    actorRole,
    title,
  });

  const notifRef = doc(db, 'notifications', notificationId);

  try {
    if (recipientId === currentUser.uid) {
      const existingSnap = await getDoc(notifRef);
      if (existingSnap.exists()) {
        return { created: false, id: notificationId };
      }
    }

    await setDoc(notifRef, {
      recipientId,
      actorId: currentUser.uid,
      actorRole,
      category: input.category,
      severity,
      alertKind: resolvedAlertKind,
      title,
      preview,
      body,
      refType: refId ? refType : 'none',
      refId: refId || '',
      referenceLabel,
      destination,
      read: false,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    // Trigger fault-isolated server-side Web Push for closed-tab delivery (never blocks caller)
    void dispatchBackgroundWebPush({
      recipientId,
      notificationId,
      category: input.category,
      alertKind: resolvedAlertKind,
      title,
      preview,
      destination,
      referenceLabel,
      dealId: refType === 'deal' && refId ? refId : undefined,
      listingId: refType === 'listing' && refId ? refId : undefined,
    });

    return { created: true, id: notificationId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // When a cross-user deterministic notification already exists, Firestore evaluates `setDoc` as an `update`
    // by a non-recipient and rejects it. Keep non-blocking idempotency while still logging genuine errors in dev.
    if (recipientId !== currentUser.uid && msg.toLowerCase().includes('Missing or insufficient permissions'.toLowerCase())) {
      return { created: false, id: notificationId };
    }
    console.warn('[BEXORA Notifications] Non-fatal notification write skipped:', msg);
    return { created: false, id: notificationId };
  } finally {
    inFlightCreateIds.delete(notificationId);
  }
}

/**
 * Marks a single notification belonging to `currentUid` as read in Firestore.
 */
export async function markNotificationReadInFirestore(
  notification: Pick<NotificationRecord, 'id' | 'recipientId' | 'read'>
): Promise<boolean> {
  const currentUser = auth.currentUser;
  if (!currentUser || !notification || notification.recipientId !== currentUser.uid) {
    return false;
  }
  if (notification.read) {
    return true;
  }
  const path = `notifications/${notification.id}`;
  try {
    await updateDoc(doc(db, 'notifications', notification.id), {
      read: true,
      readAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return true;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
    return false;
  }
}

/**
 * Marks all unread notifications belonging ONLY to `uid` as read using safe chunked Firestore `writeBatch`
 * (`<= 450` writes per batch) and an in-flight per-user lock to prevent duplicate batch races.
 */
export async function markAllNotificationsReadInFirestore(
  uid: string,
  notifications: ReadonlyArray<NotificationRecord>
): Promise<{ updatedCount: number }> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== uid) {
    throw new Error('You must be signed in to update your notifications.');
  }

  const existingInFlight = inFlightMarkAllByUid.get(uid);
  if (existingInFlight) {
    return existingInFlight;
  }

  const job = (async () => {
    const eligibleUnread = notifications.filter(
      (item) =>
        item &&
        item.recipientId === uid &&
        item.read === false &&
        !item.isAnnouncementMirror &&
        isValidFirestoreDocId(item.id)
    );

    if (eligibleUnread.length === 0) {
      return { updatedCount: 0 };
    }

    const chunks = chunkForFirestoreBatch(eligibleUnread, 450);
    let updatedCount = 0;

    for (const chunk of chunks) {
      const batch = writeBatch(db);
      for (const item of chunk) {
        batch.update(doc(db, 'notifications', item.id), {
          read: true,
          readAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      try {
        await batch.commit();
        updatedCount += chunk.length;
      } catch (error) {
        handleFirestoreError(error, OperationType.UPDATE, 'notifications');
      }
    }

    return { updatedCount };
  })();

  inFlightMarkAllByUid.set(uid, job);
  try {
    return await job;
  } finally {
    inFlightMarkAllByUid.delete(uid);
  }
}

export interface PublishAdminNotificationInput {
  mode: 'broadcast_announcement' | 'targeted_user';
  targetUid?: string;
  category: NotificationCategory;
  severity: NotificationSeverity;
  alertKind?: NotificationAlertKind;
  title: string;
  preview: string;
  body: string;
  destination?: string;
  persistPublicBanner?: boolean;
}

/**
 * Admin-only publisher:
 * - For `broadcast_announcement`: creates `/announcements/{announcementId}` (if `persistPublicBanner`)
 *   AND fans out individual `/notifications/{id}` records in chunked batches (`<= 450`) to registered users
 *   so every user gets durable personal read/unread tracking.
 * - For `targeted_user`: delivers a direct `/notifications/{id}` record to `targetUid`.
 */
export async function publishAdminNotification(
  input: PublishAdminNotificationInput
): Promise<{ announcementId?: string; deliveredCount: number }> {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error('Administrator sign-in required.');
  }

  const safeDest = sanitizeNotificationDestination(input.destination);
  const destination = safeDest ? safeDest.raw : '';
  const title = truncateNotificationField(input.title, 140);
  const preview = truncateNotificationField(input.preview || input.body, 240);
  const body = truncateNotificationField(input.body, 2000);
  if (!title || !body) {
    throw new Error('Notification title and full message are required.');
  }

  const nowMs = Date.now();
  const resolvedAlertKind: NotificationAlertKind = resolveNotificationAlertKind({
    alertKind: input.alertKind,
    category: input.category,
    severity: input.severity,
    actorRole: 'admin',
    title,
  });

  if (input.mode === 'targeted_user') {
    const targetUid = String(input.targetUid || '').trim();
    if (!isValidFirestoreDocId(targetUid)) {
      throw new Error('Enter a valid target User UID.');
    }
    const notifId = buildNotificationId(targetUid, `admin_direct_${nowMs}_${title.slice(0, 20)}`);
    try {
      await setDoc(doc(db, 'notifications', notifId), {
        recipientId: targetUid,
        actorId: currentUser.uid,
        actorRole: 'admin',
        category: input.category,
        severity: input.severity,
        alertKind: resolvedAlertKind,
        title,
        preview: preview || title,
        body,
        refType: 'none',
        refId: '',
        referenceLabel: 'Administrator Notice',
        destination,
        read: false,
        createdAtMs: nowMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      void dispatchBackgroundWebPush({
        recipientId: targetUid,
        notificationId: notifId,
        category: input.category,
        alertKind: resolvedAlertKind,
        title,
        preview: preview || title,
        destination,
        referenceLabel: 'Administrator Notice',
      });

      return { deliveredCount: 1 };
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `notifications/${notifId}`);
      return { deliveredCount: 0 };
    }
  }

  const announcementId = `ann_${nowMs}_${Math.random().toString(36).slice(2, 8)}`;
  if (input.persistPublicBanner !== false) {
    try {
      await setDoc(doc(db, 'announcements', announcementId), {
        title,
        preview: preview || title,
        body,
        severity: input.severity,
        destination,
        active: true,
        authorId: currentUser.uid,
        createdAtMs: nowMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `announcements/${announcementId}`);
    }
  }

  let recipientUids: string[] = [];
  try {
    const profilesSnap = await getDocs(collection(db, 'publicProfiles'));
    recipientUids = profilesSnap.docs
      .map((d) => d.id)
      .filter((uid) => isValidFirestoreDocId(uid));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'publicProfiles');
  }

  if (recipientUids.length === 0) {
    recipientUids = [currentUser.uid];
  }

  const chunks = chunkForFirestoreBatch(recipientUids, 450);
  let deliveredCount = 0;

  for (const chunk of chunks) {
    const batch = writeBatch(db);
    for (const uid of chunk) {
      const notifId = buildNotificationId(uid, `announcement_${announcementId}`);
      batch.set(doc(db, 'notifications', notifId), {
        recipientId: uid,
        actorId: currentUser.uid,
        actorRole: 'admin',
        category: 'announcement',
        severity: input.severity,
        alertKind: resolvedAlertKind,
        title,
        preview: preview || title,
        body,
        refType: input.persistPublicBanner !== false ? 'announcement' : 'none',
        refId: input.persistPublicBanner !== false ? announcementId : '',
        referenceLabel: 'BEXORA Announcement',
        destination,
        read: false,
        createdAtMs: nowMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    try {
      await batch.commit();
      deliveredCount += chunk.length;
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, 'notifications');
    }
  }

  return { announcementId, deliveredCount };
}

export async function archiveAdminAnnouncement(announcementId: string): Promise<void> {
  if (!isValidFirestoreDocId(announcementId)) return;
  try {
    await updateDoc(doc(db, 'announcements', announcementId), {
      active: false,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `announcements/${announcementId}`);
  }
}

const LOCAL_ANNOUNCEMENT_READ_STORAGE_KEY = 'bexora_read_announcements_v1';

export function getLocallyReadAnnouncementIds(scopeKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(`${LOCAL_ANNOUNCEMENT_READ_STORAGE_KEY}:${scopeKey}`);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

export function markLocalAnnouncementRead(scopeKey: string, announcementId: string): void {
  try {
    const current = getLocallyReadAnnouncementIds(scopeKey);
    current.add(announcementId);
    localStorage.setItem(
      `${LOCAL_ANNOUNCEMENT_READ_STORAGE_KEY}:${scopeKey}`,
      JSON.stringify(Array.from(current).slice(-200))
    );
  } catch {
    // Ignore storage quota issues in restricted browsers
  }
}

/**
 * Merges active `/announcements` that do not yet have a personal `/notifications` copy (for example,
 * for guests or newly registered accounts created after a broadcast) into the display feed cleanly.
 */
export function mergeAnnouncementsIntoFeed(
  personalNotifications: ReadonlyArray<NotificationRecord>,
  activeAnnouncements: ReadonlyArray<AnnouncementRecord>,
  viewerUid: string | null
): NotificationRecord[] {
  const existingAnnouncementRefs = new Set(
    personalNotifications
      .filter((n) => n.refType === 'announcement' && n.refId)
      .map((n) => n.refId)
  );
  const scopeKey = viewerUid || 'guest';
  const locallyReadIds = getLocallyReadAnnouncementIds(scopeKey);

  const syntheticMirrors: NotificationRecord[] = activeAnnouncements
    .filter((ann) => ann.active && !existingAnnouncementRefs.has(ann.id))
    .map((ann) => ({
      id: `ann_mirror_${ann.id}`,
      recipientId: viewerUid || 'guest',
      actorId: ann.authorId,
      actorRole: 'admin',
      category: 'announcement',
      severity: ann.severity,
      alertKind: 'normal',
      title: ann.title,
      preview: ann.preview,
      body: ann.body,
      refType: 'announcement',
      refId: ann.id,
      referenceLabel: 'Platform Announcement',
      destination: ann.destination || '',
      read: locallyReadIds.has(ann.id),
      createdAtMs: ann.createdAtMs,
      isAnnouncementMirror: true,
    }));

  return [...personalNotifications, ...syntheticMirrors].sort(
    (a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0)
  );
}

/**
 * Emits an actionable administrator notification to the bootstrapped superadmin UID
 * pointing directly to `admindeal:<dealId>` in the Admin Deal & Dispute Review panel.
 */
export async function emitDealAdminNotification(input: {
  dealId: string;
  eventKey: string;
  category: NotificationCategory;
  severity?: NotificationSeverity;
  alertKind?: NotificationAlertKind;
  title: string;
  preview: string;
  body: string;
  referenceLabel?: string;
}): Promise<{ created: boolean; id: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser || !isValidFirestoreDocId(input.dealId)) {
    return { created: false, id: '' };
  }
  return emitUserNotification({
    recipientId: BOOTSTRAPPED_SUPERADMIN_UID,
    eventKey: input.eventKey,
    actorId: currentUser.uid,
    actorRole: currentUser.uid === BOOTSTRAPPED_SUPERADMIN_UID ? 'admin' : 'user',
    category: input.category,
    severity: input.severity || 'warning',
    alertKind: input.alertKind,
    title: input.title,
    preview: input.preview,
    body: input.body,
    refType: 'deal',
    refId: input.dealId,
    referenceLabel: input.referenceLabel || `Deal ${input.dealId.slice(0, 10)}`,
    destination: `admindeal:${input.dealId}`,
  });
}

/**
 * PART 6 — High-Priority Paid Deal-Room Creation Alert:
 * Triggered ONLY AFTER a trusted wallet escrow payment transaction commits and the private
 * 3-party Deal Room (`paid_deal_room_active`) is active.
 * Targets ONLY:
 *   1. `buyerId` (`deal:<dealId>`)
 *   2. `sellerId` (`deal:<dealId>`)
 *   3. Authorized deal administrator (`admindeal:<dealId>`)
 * Uses deterministic `deal_room_created_${dealId}` eventKey per recipient so duplicate
 * clicks, retries, or snapshot updates can NEVER emit duplicate Deal-Room alerts.
 */
export async function emitPaidDealRoomCreatedAlerts(input: {
  dealId: string;
  listingTitle: string;
  buyerId: string;
  buyerName: string;
  sellerId: string;
  totalFormatted: string;
  paymentSummary: string;
}): Promise<void> {
  const { dealId, listingTitle, buyerId, buyerName, sellerId, totalFormatted, paymentSummary } = input;
  if (!isValidFirestoreDocId(dealId)) return;

  const shortDeal = `Deal #${dealId.slice(0, 10)}`;
  const jobs: Promise<{ created: boolean; id: string }>[] = [];

  if (isValidFirestoreDocId(buyerId)) {
    jobs.push(
      emitUserNotification({
        recipientId: buyerId,
        eventKey: `deal_room_created_${dealId}`,
        category: 'deal',
        severity: 'success',
        alertKind: 'deal_room_created',
        title: 'New Deal Room Created',
        preview: `Escrow funded (${totalFormatted}) for "${listingTitle}". Your private 3-party Deal Room is open.`,
        body: `Your ${paymentSummary} is locked in BEXORA Escrow for "${listingTitle}". Private 3-party Deal Room (${shortDeal}) is now active with Buyer, Seller, and BEXORA Escrow Administration. Wait for the seller to submit 2–3 official transfer proof screenshots before approving the transfer.`,
        refType: 'deal',
        refId: dealId,
        referenceLabel: shortDeal,
        destination: `deal:${dealId}`,
      })
    );
  }

  if (isValidFirestoreDocId(sellerId) && sellerId !== buyerId) {
    jobs.push(
      emitUserNotification({
        recipientId: sellerId,
        eventKey: `deal_room_created_${dealId}`,
        category: 'deal',
        severity: 'success',
        alertKind: 'deal_room_created',
        title: 'New Deal Room Created',
        preview: `${buyerName} funded ${totalFormatted} in Escrow for "${listingTitle}". Open Deal Room to transfer.`,
        body: `${buyerName} completed ${paymentSummary} into BEXORA Escrow for "${listingTitle}". Private 3-party Deal Room (${shortDeal}) is now open. Enter the Deal Room, complete the official asset transfer, and submit 2–3 transfer proof screenshots in the Seller Asset-Transfer Box.`,
        refType: 'deal',
        refId: dealId,
        referenceLabel: shortDeal,
        destination: `deal:${dealId}`,
      })
    );
  }

  if (BOOTSTRAPPED_SUPERADMIN_UID !== buyerId && BOOTSTRAPPED_SUPERADMIN_UID !== sellerId) {
    jobs.push(
      emitDealAdminNotification({
        dealId,
        eventKey: `deal_room_created_${dealId}`,
        category: 'deal',
        severity: 'info',
        alertKind: 'deal_room_created',
        title: 'New Deal Room Created',
        preview: `${buyerName} funded ${totalFormatted} for "${listingTitle}" — 3-party Deal Room active.`,
        body: `${shortDeal} ("${listingTitle}") is now funded via ${paymentSummary} and active in the 3-party Deal Room for Buyer, Seller, and BEXORA Administration.`,
        referenceLabel: `${shortDeal} · ${listingTitle.slice(0, 60)}`,
      })
    );
  }

  await Promise.all(jobs);
}

/**
 * Appends an immutable chronological audit event inside `deals/{dealId}/events`.
 * Must be called AFTER the parent `deals/{dealId}` transaction commits.
 */
export async function appendDealAuditEvent(input: {
  dealId: string;
  actorId?: string;
  actorName: string;
  actorRole: 'buyer' | 'seller' | 'admin' | 'system';
  eventType: string;
  summary: string;
}): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || !isValidFirestoreDocId(input.dealId)) return;

  const actorId = String(input.actorId || currentUser.uid).trim();
  if (actorId !== currentUser.uid) return;

  const actorName = truncateNotificationField(input.actorName || 'Participant', 80) || 'Participant';
  const eventType = truncateNotificationField(input.eventType || 'deal_event', 64) || 'deal_event';
  const summary = truncateNotificationField(input.summary || eventType, 600) || eventType;

  try {
    await addDoc(collection(db, 'deals', input.dealId, 'events'), {
      dealId: input.dealId,
      actorId,
      actorRole: input.actorRole,
      actorName,
      eventType,
      summary,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
    });
  } catch (err) {
    console.warn('[BEXORA Deal Audit] Non-fatal audit event write skipped:', err);
  }
}

