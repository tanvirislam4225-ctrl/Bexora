import {
  collection,
  deleteDoc,
  doc,
  documentId,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebase';
import type {
  BidRecord,
  MarketplaceListing,
  PublicProfile,
  SellerFollowRecord,
} from '../types';
import {
  buildFavoriteDocId,
  buildFollowerNewListingNotificationSpec,
  buildSellerFollowDocId,
  canUserFollowSeller,
  chunkIdsForFirestoreInQuery,
} from './engagementLogic';
import { chunkForFirestoreBatch, truncateNotificationField } from './notificationLogic';
import { emitUserNotification, EmitNotificationInput } from './notificationService';

// In-flight deduplication locks prevent double-click race conditions on toggle actions
const inFlightFavoriteKeys = new Set<string>();
const inFlightFollowKeys = new Set<string>();
const inFlightWithdrawBidIds = new Set<string>();

/**
 * Toggles a listing in the authenticated user's strictly private `/favorites` collection.
 * Uses deterministic document ID `fav_${uid}_${listingId}` so duplicates are impossible.
 */
export async function toggleFavoriteListingInFirestore(
  userUid: string,
  listing: Pick<
    MarketplaceListing,
    | 'id'
    | 'sellerId'
    | 'sellerName'
    | 'sellerUsername'
    | 'title'
    | 'platform'
    | 'subcategory'
    | 'priceMinor'
    | 'currency'
    | 'images'
  >,
  currentlySaved: boolean
): Promise<{ saved: boolean; favoriteId: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== userUid) {
    throw new Error('Please sign in to save Favorites.');
  }

  const favoriteId = buildFavoriteDocId(userUid, listing.id);
  if (!favoriteId) {
    throw new Error('Invalid listing identifier.');
  }

  if (inFlightFavoriteKeys.has(favoriteId)) {
    return { saved: currentlySaved, favoriteId };
  }
  inFlightFavoriteKeys.add(favoriteId);

  const favRef = doc(db, 'favorites', favoriteId);
  const path = `favorites/${favoriteId}`;

  try {
    if (currentlySaved) {
      await deleteDoc(favRef);
      return { saved: false, favoriteId };
    }

    const existingSnap = await getDoc(favRef);
    if (existingSnap.exists()) {
      await deleteDoc(favRef);
      return { saved: false, favoriteId };
    }

    const rawThumb = listing.images?.[0] ? String(listing.images[0]).trim() : '';
    const payload: Record<string, unknown> = {
      userId: userUid,
      listingId: listing.id,
      sellerId: String(listing.sellerId || '').slice(0, 128),
      sellerName: truncateNotificationField(listing.sellerName || 'Seller', 80) || 'Seller',
      sellerUsername:
        String(listing.sellerUsername || 'seller')
          .trim()
          .slice(0, 40) || 'seller',
      title: truncateNotificationField(listing.title || 'Digital Asset', 140) || 'Digital Asset',
      platform: listing.platform,
      subcategory: truncateNotificationField(listing.subcategory || 'General', 80) || 'General',
      priceMinor: Math.max(100, Math.round(Number(listing.priceMinor) || 100)),
      currency: listing.currency === 'USD' ? 'USD' : 'BDT',
      createdAtMs: Date.now(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    if (rawThumb && rawThumb.length <= 350000) {
      payload.thumbnailUrl = rawThumb;
    }

    await setDoc(favRef, payload);
    return { saved: true, favoriteId };
  } catch (error) {
    handleFirestoreError(error, currentlySaved ? OperationType.DELETE : OperationType.WRITE, path);
    throw error;
  } finally {
    inFlightFavoriteKeys.delete(favoriteId);
  }
}

export async function removeFavoriteListingInFirestore(
  userUid: string,
  listingId: string
): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== userUid) {
    throw new Error('Please sign in to manage Favorites.');
  }
  const favoriteId = buildFavoriteDocId(userUid, listingId);
  if (!favoriteId) return;
  const path = `favorites/${favoriteId}`;
  try {
    await deleteDoc(doc(db, 'favorites', favoriteId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export interface FollowTargetSellerSummary {
  uid: string;
  displayName: string;
  username: string;
  avatarUrl?: string;
  nidVerified: boolean;
}

/**
 * Atomically follows or unfollows a seller using `runTransaction`:
 * - Creates or deletes `/sellerFollows/fol_${followerUid}_${sellerUid}`
 * - Synchronously increments/decrements `publicProfiles/${sellerUid}.followerCount`
 *   (validated by Pillar-7 `exists` + `existsAfter` rules in `firestore.rules`).
 */
export async function toggleFollowSellerInFirestore(
  followerUid: string,
  seller: FollowTargetSellerSummary,
  currentlyFollowing: boolean
): Promise<{ following: boolean; followId: string; nextFollowerCount: number }> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== followerUid) {
    throw new Error('Please sign in to follow sellers.');
  }
  if (!canUserFollowSeller(followerUid, seller.uid)) {
    throw new Error('You cannot follow your own seller profile.');
  }

  const followId = buildSellerFollowDocId(followerUid, seller.uid);
  if (!followId) {
    throw new Error('Invalid seller profile identifier.');
  }

  if (inFlightFollowKeys.has(followId)) {
    return { following: currentlyFollowing, followId, nextFollowerCount: 0 };
  }
  inFlightFollowKeys.add(followId);

  const followRef = doc(db, 'sellerFollows', followId);
  const sellerProfileRef = doc(db, 'publicProfiles', seller.uid);
  const path = `sellerFollows/${followId}`;

  try {
    const result = await runTransaction(db, async (tx) => {
      const [followSnap, sellerSnap] = await Promise.all([
        tx.get(followRef),
        tx.get(sellerProfileRef),
      ]);

      if (!sellerSnap.exists()) {
        throw new Error('This seller profile is not available.');
      }

      const sellerData = sellerSnap.data() as PublicProfile;
      const currentCount =
        typeof sellerData.followerCount === 'number' && Number.isFinite(sellerData.followerCount)
          ? Math.max(0, Math.floor(sellerData.followerCount))
          : 0;

      if (followSnap.exists()) {
        const nextCount = Math.max(0, currentCount - 1);
        tx.delete(followRef);
        tx.update(sellerProfileRef, {
          followerCount: nextCount,
          updatedAt: serverTimestamp(),
        });
        return { following: false, followId, nextFollowerCount: nextCount };
      }

      const nextCount = currentCount + 1;
      const cleanAvatar = seller.avatarUrl || sellerData.avatarUrl || '';
      const followPayload: Record<string, unknown> = {
        followerId: followerUid,
        sellerId: seller.uid,
        sellerName:
          truncateNotificationField(
            sellerData.displayName || seller.displayName || 'Seller',
            80
          ) || 'Seller',
        sellerUsername:
          String(sellerData.username || seller.username || 'seller')
            .trim()
            .slice(0, 40) || 'seller',
        sellerVerified: Boolean(sellerData.nidVerified ?? seller.nidVerified),
        createdAtMs: Date.now(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (cleanAvatar && cleanAvatar.length <= 350000) {
        followPayload.sellerAvatarUrl = cleanAvatar;
      }

      tx.set(followRef, followPayload);
      tx.update(sellerProfileRef, {
        followerCount: nextCount,
        updatedAt: serverTimestamp(),
      });
      return { following: true, followId, nextFollowerCount: nextCount };
    });

    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('missing or insufficient permissions')) {
      handleFirestoreError(error, OperationType.WRITE, path);
    }
    throw error;
  } finally {
    inFlightFollowKeys.delete(followId);
  }
}

export async function unfollowSellerByIdInFirestore(
  followerUid: string,
  sellerUid: string
): Promise<void> {
  await toggleFollowSellerInFirestore(
    followerUid,
    {
      uid: sellerUid,
      displayName: 'Seller',
      username: 'seller',
      nidVerified: false,
    },
    true
  );
}

/**
 * Safely withdraws a buyer's own `pending` bid via Firestore transaction.
 * Rejects withdrawal if the bid has already been accepted, linked to a Deal, or belongs to someone else.
 */
export async function withdrawPendingBidInFirestore(
  buyerUid: string,
  bid: Pick<BidRecord, 'id' | 'buyerId' | 'listingId' | 'sellerId'>,
  listingTitle?: string
): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== buyerUid || bid.buyerId !== buyerUid) {
    throw new Error('You can only withdraw your own pending bids.');
  }

  if (inFlightWithdrawBidIds.has(bid.id)) return;
  inFlightWithdrawBidIds.add(bid.id);

  const bidRef = doc(db, 'bids', bid.id);
  const path = `bids/${bid.id}`;

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(bidRef);
      if (!snap.exists()) {
        throw new Error('Bid record could not be found.');
      }
      const liveBid = snap.data() as BidRecord;
      if (liveBid.buyerId !== buyerUid) {
        throw new Error('You do not have permission to modify this bid.');
      }
      if (liveBid.dealId || liveBid.status !== 'pending') {
        throw new Error(
          liveBid.dealId ||
          liveBid.status === 'accepted_pending_payment' ||
          liveBid.status === 'accepted' ||
          liveBid.status === 'paid'
            ? 'Accepted bids with active Escrow Deals cannot be cancelled via bid withdrawal.'
            : `This bid is already ${liveBid.status} and cannot be withdrawn.`
        );
      }

      tx.update(bidRef, {
        status: 'withdrawn',
        updatedAt: serverTimestamp(),
      });
    });

    // Notify seller politely if their bid-update preference permits (non-blocking)
    if (bid.sellerId && bid.sellerId !== buyerUid) {
      void emitBidActivityNotification({
        recipientId: bid.sellerId,
        eventKey: `bid_withdrawn_${bid.id}`,
        actorId: buyerUid,
        actorRole: 'user',
        category: 'bid',
        severity: 'info',
        title: 'Bid Withdrawn by Buyer',
        preview: `A pending bid on "${listingTitle || 'your listing'}" was withdrawn by the buyer.`,
        body: `A buyer withdrew their pending bid on "${listingTitle || 'your listing'}". Other pending bids and your listing remain unaffected.`,
        refType: 'listing',
        refId: bid.listingId,
        referenceLabel: listingTitle || `Listing #${bid.listingId.slice(0, 10)}`,
        destination: `listing:${bid.listingId}`,
      });
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.toLowerCase().includes('missing or insufficient permissions')) {
      handleFirestoreError(error, OperationType.UPDATE, path);
    }
    throw error;
  } finally {
    inFlightWithdrawBidIds.delete(bid.id);
  }
}

/**
 * Emits an optional bid-activity notification (e.g. new bid submitted, pending bid declined/withdrawn).
 * Note: Accepted bids that create a Deal use `category: 'deal'` directly via `emitUserNotification`
 * because Deal & Escrow notifications are mandatory and always delivered.
 */
export async function emitBidActivityNotification(
  input: EmitNotificationInput
): Promise<{ created: boolean; id: string }> {
  return emitUserNotification(input);
}

/**
 * Fetches publicly readable listings (`active`, `reserved`, `sold`) for specific IDs
 * in chunks of `<= 10` without scanning the entire `/listings` collection.
 * Gracefully handles chunks containing non-public/deleted listings by falling back to per-doc reads.
 */
export async function fetchSpecificListingsByIds(
  ids: ReadonlyArray<string>
): Promise<Map<string, MarketplaceListing>> {
  const result = new Map<string, MarketplaceListing>();
  const chunks = chunkIdsForFirestoreInQuery(ids, 10);
  if (chunks.length === 0) return result;

  for (const chunk of chunks) {
    try {
      const q = query(
        collection(db, 'listings'),
        where(documentId(), 'in', chunk),
        where('status', 'in', ['active', 'reserved', 'sold'])
      );
      const snap = await getDocs(q);
      snap.forEach((docSnap) => {
        const d = docSnap.data() as Omit<MarketplaceListing, 'id'>;
        result.set(docSnap.id, { ...d, id: docSnap.id });
      });
    } catch {
      // Fallback: inspect individually in case an edge status restricted batch query
      await Promise.all(
        chunk.map(async (listingId) => {
          try {
            const single = await getDoc(doc(db, 'listings', listingId));
            if (single.exists()) {
              const d = single.data() as Omit<MarketplaceListing, 'id'>;
              result.set(single.id, { ...d, id: single.id });
            }
          } catch {
            // Non-public or deleted listing -> caller uses saved snapshot metadata gracefully
          }
        })
      );
    }
  }

  return result;
}

/**
 * Fans out instant New-Listing Notifications to all followers of `listing.sellerId`
 * when an admin approves & publishes a listing to `active` for the first time.
 * - Never blocks or fails listing publication if notification delivery encounters an error.
 * - Uses deterministic IDs (`ntf_<follower>_seller_new_listing_<listingId>_...`) so duplicates cannot occur.
 * - Respects each follower's `privateUsers/{uid}.notificationPrefs.followedSellerListingsEnabled !== false`.
 * - Dispatches non-blocking server Web Push via `/api/fcm/fanout-followers`.
 */
export async function fanoutNewListingToFollowers(
  adminUid: string,
  listing: MarketplaceListing
): Promise<{ notifiedCount: number; skippedByPrefCount: number }> {
  const currentUser = auth.currentUser;
  if (!currentUser || currentUser.uid !== adminUid) {
    return { notifiedCount: 0, skippedByPrefCount: 0 };
  }

  try {
    const followsSnap = await getDocs(
      query(collection(db, 'sellerFollows'), where('sellerId', '==', listing.sellerId))
    );
    if (followsSnap.empty) {
      return { notifiedCount: 0, skippedByPrefCount: 0 };
    }

    const followerUids = Array.from(
      new Set(
        followsSnap.docs
          .map((d) => String((d.data() as SellerFollowRecord).followerId || '').trim())
          .filter((uid) => Boolean(uid) && uid !== listing.sellerId)
      )
    );

    if (followerUids.length === 0) {
      return { notifiedCount: 0, skippedByPrefCount: 0 };
    }

    // Check follower preferences (admins have read permission on privateUsers)
    let skippedByPrefCount = 0;
    const eligibleUids: string[] = [];

    const prefChunks = chunkForFirestoreBatch(followerUids, 25);
    for (const group of prefChunks) {
      const checks = await Promise.all(
        group.map(async (uid) => {
          try {
            const privSnap = await getDoc(doc(db, 'privateUsers', uid));
            if (privSnap.exists()) {
              const prefs = privSnap.data()?.notificationPrefs;
              if (prefs && prefs.followedSellerListingsEnabled === false) {
                return { uid, enabled: false };
              }
            }
          } catch {
            // Default to enabled if unreadable
          }
          return { uid, enabled: true };
        })
      );
      for (const item of checks) {
        if (item.enabled) eligibleUids.push(item.uid);
        else skippedByPrefCount += 1;
      }
    }

    const specs = eligibleUids
      .map((uid) => buildFollowerNewListingNotificationSpec(listing, uid))
      .filter((s): s is NonNullable<typeof s> => Boolean(s));

    if (specs.length === 0) {
      return { notifiedCount: 0, skippedByPrefCount };
    }

    const batches = chunkForFirestoreBatch(specs, 400);
    let notifiedCount = 0;
    const pushRecipients: Array<{ recipientId: string; notificationId: string }> = [];

    for (const chunk of batches) {
      const batch = writeBatch(db);
      const nowMs = Date.now();
      for (const spec of chunk) {
        batch.set(doc(db, 'notifications', spec.id), {
          recipientId: spec.recipientId,
          actorId: adminUid,
          actorRole: 'admin',
          category: spec.category,
          severity: spec.severity,
          alertKind: spec.alertKind,
          title: spec.title,
          preview: spec.preview,
          body: spec.body,
          refType: spec.refType,
          refId: spec.refId,
          referenceLabel: spec.referenceLabel,
          destination: spec.destination,
          read: false,
          createdAtMs: nowMs,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        pushRecipients.push({
          recipientId: spec.recipientId,
          notificationId: spec.id,
        });
      }
      try {
        await batch.commit();
        notifiedCount += chunk.length;
      } catch (batchErr) {
        // Fallback: write individually so one already-existing deterministic doc never aborts sibling followers
        for (const spec of chunk) {
          try {
            await setDoc(doc(db, 'notifications', spec.id), {
              recipientId: spec.recipientId,
              actorId: adminUid,
              actorRole: 'admin',
              category: spec.category,
              severity: spec.severity,
              alertKind: spec.alertKind,
              title: spec.title,
              preview: spec.preview,
              body: spec.body,
              refType: spec.refType,
              refId: spec.refId,
              referenceLabel: spec.referenceLabel,
              destination: spec.destination,
              read: false,
              createdAtMs: Date.now(),
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            notifiedCount += 1;
          } catch {
            // Already delivered idempotently or transient failure -> ignore safely
          }
        }
        console.warn('[BEXORA Follower Fanout] Batch fallback triggered:', batchErr);
      }
    }

    // Trigger non-blocking server-side FCM Web Push fan-out for closed-tab delivery
    if (pushRecipients.length > 0) {
      void (async () => {
        try {
          const idToken = await currentUser.getIdToken();
          const sample = specs[0];
          await fetch('/api/fcm/fanout-followers', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({
              listingId: listing.id,
              title: sample.title,
              preview: sample.preview,
              referenceLabel: sample.referenceLabel,
              destination: sample.destination,
              recipients: pushRecipients.slice(0, 500),
            }),
          });
        } catch {
          // Never block or fail listing publication on push fanout error
        }
      })();
    }

    return { notifiedCount, skippedByPrefCount };
  } catch (err) {
    console.warn('[BEXORA Follower Fanout] Non-fatal error during follower notification:', err);
    return { notifiedCount: 0, skippedByPrefCount: 0 };
  }
}
