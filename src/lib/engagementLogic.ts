import type {
  BidRecord,
  BidStatus,
  CurrencyCode,
  DealRecord,
  FavoriteRecord,
  ListingStatus,
  MarketplaceListing,
  PlatformId,
  PublicProfile,
  SellerFollowRecord,
} from '../types';
import {
  buildNotificationId,
  isValidFirestoreDocId,
  truncateNotificationField,
} from './notificationLogic';
import { formatMoneyFromMinor, PLATFORM_CATALOG } from './marketplaceLogic';

// ============================================================================
// 1. DETERMINISTIC DOCUMENT IDS & VALIDATION
// ============================================================================

const SAFE_PART_REGEX = /^[a-zA-Z0-9_-]{1,56}$/;

export function buildFavoriteDocId(userId: string, listingId: string): string {
  const cleanUser = String(userId || '').trim();
  const cleanListing = String(listingId || '').trim();
  if (!SAFE_PART_REGEX.test(cleanUser) || !SAFE_PART_REGEX.test(cleanListing)) {
    return '';
  }
  const candidate = `fav_${cleanUser}_${cleanListing}`;
  return isValidFirestoreDocId(candidate) ? candidate : '';
}

export function buildSellerFollowDocId(followerId: string, sellerId: string): string {
  const cleanFollower = String(followerId || '').trim();
  const cleanSeller = String(sellerId || '').trim();
  if (
    !SAFE_PART_REGEX.test(cleanFollower) ||
    !SAFE_PART_REGEX.test(cleanSeller) ||
    cleanFollower === cleanSeller
  ) {
    return '';
  }
  const candidate = `fol_${cleanFollower}_${cleanSeller}`;
  return isValidFirestoreDocId(candidate) ? candidate : '';
}

export function canUserFollowSeller(
  viewerUid: string | null | undefined,
  sellerUid: string | null | undefined
): boolean {
  const cleanSeller = String(sellerUid || '').trim();
  if (!cleanSeller || !SAFE_PART_REGEX.test(cleanSeller)) return false;
  if (!viewerUid) return true; // Logged-out users see Follow button -> redirects cleanly via PendingAuthIntent
  return viewerUid.trim() !== cleanSeller;
}

export function chunkIdsForFirestoreInQuery(
  ids: ReadonlyArray<string>,
  maxChunk = 10
): string[][] {
  const safeMax = Math.max(1, Math.min(30, Math.floor(maxChunk) || 10));
  const uniqueValid: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const clean = String(raw || '').trim();
    if (clean && isValidFirestoreDocId(clean) && !seen.has(clean)) {
      seen.add(clean);
      uniqueValid.push(clean);
    }
  }
  const chunks: string[][] = [];
  for (let i = 0; i < uniqueValid.length; i += safeMax) {
    chunks.push(uniqueValid.slice(i, i + safeMax));
  }
  return chunks;
}

// ============================================================================
// 2. FAVORITES DISPLAY & GRACEFUL UNAVAILABLE / SOLD SNAPSHOT RESOLUTION
// ============================================================================

export type FavoriteAvailabilityState =
  | 'active'
  | 'reserved'
  | 'sold'
  | 'unavailable';

export interface ResolvedFavoriteItem {
  favoriteId: string;
  listingId: string;
  sellerId: string;
  sellerName: string;
  sellerUsername: string;
  title: string;
  platform: PlatformId;
  subcategory: string;
  priceMinor: number;
  currency: CurrencyCode;
  thumbnailUrl?: string;
  savedAtMs: number;
  availability: FavoriteAvailabilityState;
  statusLabel: string;
  canOpenListing: boolean;
  liveListing: MarketplaceListing | null;
}

export function resolveFavoriteDisplayItem(
  fav: FavoriteRecord,
  liveListing?: MarketplaceListing | null
): ResolvedFavoriteItem {
  if (liveListing) {
    if (liveListing.status === 'active') {
      return {
        favoriteId: fav.id,
        listingId: fav.listingId,
        sellerId: liveListing.sellerId,
        sellerName: liveListing.sellerName,
        sellerUsername: liveListing.sellerUsername,
        title: liveListing.title,
        platform: liveListing.platform,
        subcategory: liveListing.subcategory,
        priceMinor: liveListing.priceMinor,
        currency: liveListing.currency,
        thumbnailUrl: liveListing.images?.[0] || fav.thumbnailUrl,
        savedAtMs: fav.createdAtMs,
        availability: 'active',
        statusLabel: 'Available',
        canOpenListing: true,
        liveListing,
      };
    }
    if (liveListing.status === 'reserved') {
      return {
        favoriteId: fav.id,
        listingId: fav.listingId,
        sellerId: liveListing.sellerId,
        sellerName: liveListing.sellerName,
        sellerUsername: liveListing.sellerUsername,
        title: liveListing.title,
        platform: liveListing.platform,
        subcategory: liveListing.subcategory,
        priceMinor: liveListing.priceMinor,
        currency: liveListing.currency,
        thumbnailUrl: liveListing.images?.[0] || fav.thumbnailUrl,
        savedAtMs: fav.createdAtMs,
        availability: 'reserved',
        statusLabel: 'Reserved in Escrow',
        canOpenListing: true,
        liveListing,
      };
    }
    if (liveListing.status === 'sold') {
      return {
        favoriteId: fav.id,
        listingId: fav.listingId,
        sellerId: liveListing.sellerId,
        sellerName: liveListing.sellerName,
        sellerUsername: liveListing.sellerUsername,
        title: liveListing.title,
        platform: liveListing.platform,
        subcategory: liveListing.subcategory,
        priceMinor: liveListing.priceMinor,
        currency: liveListing.currency,
        thumbnailUrl: liveListing.images?.[0] || fav.thumbnailUrl,
        savedAtMs: fav.createdAtMs,
        availability: 'sold',
        statusLabel: 'Sold',
        canOpenListing: true,
        liveListing,
      };
    }

    // Listing exists in seller/admin state as rejected, suspended, archived, draft, or pending
    const nonPublicLabels: Record<ListingStatus, string> = {
      draft: 'Unpublished',
      pending: 'Under Review',
      active: 'Available',
      reserved: 'Reserved in Escrow',
      sold: 'Sold',
      rejected: 'Removed / Unavailable',
      suspended: 'Suspended / Unavailable',
      archived: 'Archived / Removed',
    };
    return {
      favoriteId: fav.id,
      listingId: fav.listingId,
      sellerId: liveListing.sellerId || fav.sellerId,
      sellerName: liveListing.sellerName || fav.sellerName,
      sellerUsername: liveListing.sellerUsername || fav.sellerUsername,
      title: liveListing.title || fav.title,
      platform: liveListing.platform || fav.platform,
      subcategory: liveListing.subcategory || fav.subcategory,
      priceMinor: liveListing.priceMinor || fav.priceMinor,
      currency: liveListing.currency || fav.currency,
      thumbnailUrl: liveListing.images?.[0] || fav.thumbnailUrl,
      savedAtMs: fav.createdAtMs,
      availability: 'unavailable',
      statusLabel: nonPublicLabels[liveListing.status] || 'Listing Unavailable',
      canOpenListing: false,
      liveListing: null,
    };
  }

  // Listing was deleted or is no longer publicly readable (e.g., suspended/archived by seller/admin)
  return {
    favoriteId: fav.id,
    listingId: fav.listingId,
    sellerId: fav.sellerId,
    sellerName: fav.sellerName,
    sellerUsername: fav.sellerUsername,
    title: fav.title,
    platform: fav.platform,
    subcategory: fav.subcategory,
    priceMinor: fav.priceMinor,
    currency: fav.currency,
    thumbnailUrl: fav.thumbnailUrl,
    savedAtMs: fav.createdAtMs,
    availability: 'unavailable',
    statusLabel: 'No Longer Available',
    canOpenListing: false,
    liveListing: null,
  };
}

// ============================================================================
// 3. MY BIDS CLASSIFICATION, FILTERING & WITHDRAWAL RULES
// ============================================================================

export type MyBidsFilterTab =
  | 'all'
  | 'pending'
  | 'accepted_deal'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export interface ClassifiedUserBidEntry {
  bid: BidRecord;
  listing: MarketplaceListing | null;
  deal: DealRecord | null;
  bucket: Exclude<MyBidsFilterTab, 'all'>;
  statusBadgeLabel: string;
  sellerDecisionSummary: string;
  canWithdraw: boolean;
  canOpenListing: boolean;
  canOpenDealCheckout: boolean;
  canOpenDealRoom: boolean;
  resolvedDealId?: string;
  assetTitle: string;
  assetPlatform?: PlatformId;
  assetSubcategory: string;
  assetThumbnailUrl?: string;
  sellerId: string;
  sellerName: string;
  sellerUsername?: string;
}

export function classifyUserBidEntry(
  bid: BidRecord,
  listing?: MarketplaceListing | null,
  deal?: DealRecord | null
): ClassifiedUserBidEntry {
  const effectiveDealId = deal?.id || bid.dealId || undefined;
  const hasActiveOrHistoricalDeal = Boolean(deal || bid.dealId);

  let bucket: Exclude<MyBidsFilterTab, 'all'> = 'pending';
  let statusBadgeLabel = 'Active / Pending';
  let sellerDecisionSummary = 'Awaiting seller review';

  const status: BidStatus = bid.status;

  if (
    status === 'accepted_pending_payment' ||
    status === 'accepted' ||
    status === 'paid'
  ) {
    bucket = 'accepted_deal';
    if (deal) {
      if (
        deal.status === 'accepted_pending_payment' ||
        deal.status === 'awaiting_payment'
      ) {
        statusBadgeLabel = 'Accepted — Complete Escrow Payment';
        sellerDecisionSummary = 'Seller accepted your bid. Proceed to Escrow Checkout to fund the deal room.';
      } else if (deal.status === 'payment_pending_verification') {
        statusBadgeLabel = 'Payment Under Verification';
        sellerDecisionSummary = 'Seller accepted your bid; your escrow payment is awaiting admin verification.';
      } else if (deal.status === 'settled') {
        statusBadgeLabel = 'Accepted — Deal Settled';
        sellerDecisionSummary = 'Deal completed and escrow settled.';
      } else if (deal.status === 'refunded' || deal.status === 'cancelled') {
        statusBadgeLabel = `Deal ${deal.status === 'refunded' ? 'Refunded' : 'Cancelled'}`;
        sellerDecisionSummary = `Accepted bid deal ended as ${deal.status}.`;
      } else {
        statusBadgeLabel = 'Accepted — Deal Room Active';
        sellerDecisionSummary = 'Escrow funded. Private 3-party Deal Room is active.';
      }
    } else if (status === 'paid') {
      statusBadgeLabel = 'Accepted & Paid';
      sellerDecisionSummary = 'Escrow payment confirmed; 3-party Deal Room created.';
    } else {
      statusBadgeLabel = 'Accepted — Deal Created';
      sellerDecisionSummary = 'Seller accepted your bid and reserved the listing for you.';
    }
  } else if (status === 'rejected') {
    bucket = 'rejected';
    statusBadgeLabel = 'Declined by Seller';
    sellerDecisionSummary =
      listing?.status === 'reserved' || listing?.status === 'sold'
        ? 'Seller accepted another offer or completed a sale on this asset.'
        : 'Seller declined this bid. You may submit a new offer if the listing is still active.';
  } else if (status === 'withdrawn' || status === 'cancelled') {
    bucket = 'cancelled';
    statusBadgeLabel = status === 'withdrawn' ? 'Withdrawn by You' : 'Cancelled';
    sellerDecisionSummary =
      status === 'withdrawn'
        ? 'You withdrew this pending bid before seller acceptance.'
        : 'This bid was cancelled.';
  } else if (status === 'expired') {
    bucket = 'expired';
    statusBadgeLabel = 'Expired';
    sellerDecisionSummary = 'This bid expired before acceptance.';
  } else {
    // status === 'pending'
    if (listing && (listing.status === 'sold' || listing.status === 'archived' || listing.status === 'suspended' || listing.status === 'rejected')) {
      bucket = 'expired';
      statusBadgeLabel = listing.status === 'sold' ? 'Listing Sold' : 'Listing Closed';
      sellerDecisionSummary =
        listing.status === 'sold'
          ? 'This listing was sold before your pending bid was accepted.'
          : 'This listing is no longer active on the marketplace.';
    } else {
      bucket = 'pending';
      statusBadgeLabel = 'Active / Pending';
      sellerDecisionSummary =
        listing?.status === 'reserved'
          ? 'Listing is currently reserved for another accepted offer; your bid remains on record.'
          : 'Pending seller decision.';
    }
  }

  // CRITICAL INVARIANT: Accepted bids or bids tied to any created Deal CANNOT be withdrawn via ordinary bid cancellation
  const canWithdraw =
    status === 'pending' &&
    !hasActiveOrHistoricalDeal &&
    (!listing || (listing.status !== 'sold' && listing.status !== 'archived'));

  const canOpenListing = Boolean(
    listing &&
      (listing.status === 'active' || listing.status === 'reserved' || listing.status === 'sold')
  );

  const canOpenDealCheckout = Boolean(
    effectiveDealId &&
      ((deal &&
        (deal.status === 'accepted_pending_payment' || deal.status === 'awaiting_payment')) ||
        (!deal && status === 'accepted_pending_payment'))
  );

  const canOpenDealRoom = Boolean(effectiveDealId);

  return {
    bid,
    listing: listing || null,
    deal: deal || null,
    bucket,
    statusBadgeLabel,
    sellerDecisionSummary,
    canWithdraw,
    canOpenListing,
    canOpenDealCheckout,
    canOpenDealRoom,
    resolvedDealId: effectiveDealId,
    assetTitle: listing?.title || deal?.listingTitle || `Listing #${bid.listingId.slice(0, 10)}`,
    assetPlatform: listing?.platform || deal?.platform,
    assetSubcategory:
      listing?.subcategory ||
      (deal?.platform ? PLATFORM_CATALOG[deal.platform]?.name || deal.platform : 'Digital Asset'),
    assetThumbnailUrl: listing?.images?.[0],
    sellerId: listing?.sellerId || deal?.sellerId || bid.sellerId,
    sellerName: listing?.sellerName || deal?.sellerName || 'Verified Seller',
    sellerUsername: listing?.sellerUsername,
  };
}

export function filterClassifiedBids(
  entries: ReadonlyArray<ClassifiedUserBidEntry>,
  tab: MyBidsFilterTab
): ClassifiedUserBidEntry[] {
  const sorted = [...entries].sort(
    (a, b) => (Number(b.bid.createdAtMs) || 0) - (Number(a.bid.createdAtMs) || 0)
  );
  if (tab === 'all') return sorted;
  return sorted.filter((item) => item.bucket === tab);
}

// ============================================================================
// 4. FOLLOWER NEW-LISTING PUBLICATION GUARD & PAYLOAD BUILDER
// ============================================================================

/**
 * Ensures follower notifications fire ONLY when a listing genuinely transitions to
 * published (`status === 'active'`) for the FIRST TIME (`!firstPublishedAtMs`).
 * Draft, pending, rejected, suspended, restored (`firstPublishedAtMs > 0`), or edited
 * listings never trigger duplicate follower broadcasts.
 */
export function shouldTriggerFollowerPublicationAlert(
  previousStatus: ListingStatus | null | undefined,
  nextStatus: ListingStatus,
  firstPublishedAtMs?: number | null
): boolean {
  if (nextStatus !== 'active') return false;
  if (previousStatus === 'active') return false;
  if (typeof firstPublishedAtMs === 'number' && firstPublishedAtMs > 0) {
    return false;
  }
  return true;
}

export interface FollowerListingNotificationSpec {
  id: string;
  eventKey: string;
  recipientId: string;
  category: 'listing';
  severity: 'info';
  alertKind: 'normal';
  title: string;
  preview: string;
  body: string;
  refType: 'listing';
  refId: string;
  referenceLabel: string;
  destination: string;
}

export function buildFollowerNewListingNotificationSpec(
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
  >,
  followerUid: string
): FollowerListingNotificationSpec | null {
  const cleanFollower = String(followerUid || '').trim();
  if (!cleanFollower || !isValidFirestoreDocId(cleanFollower)) return null;
  if (cleanFollower === listing.sellerId) return null; // Never notify seller about their own listing via follower fan-out

  const eventKey = `seller_new_listing_${listing.id}`;
  const id = buildNotificationId(cleanFollower, eventKey);
  const platformLabel = PLATFORM_CATALOG[listing.platform]?.name || listing.platform;
  const priceFormatted = formatMoneyFromMinor(
    listing.priceMinor,
    listing.currency,
    listing.currency
  );
  const sellerDisplay = listing.sellerName || `@${listing.sellerUsername || 'seller'}`;

  const title = truncateNotificationField(`New Listing from ${sellerDisplay}`, 130);
  const preview = truncateNotificationField(
    `${sellerDisplay} published "${listing.title}" (${platformLabel}) at ${priceFormatted}.`,
    220
  );
  const body = truncateNotificationField(
    `${sellerDisplay} (@${listing.sellerUsername || 'seller'}), a seller you follow on BEXORA, just published a new verified marketplace listing:\n\n• Asset: ${listing.title}\n• Category: ${platformLabel} · ${listing.subcategory}\n• Asking Price: ${priceFormatted}\n\nOpen the listing to inspect metrics, save to Favorites, place a bid, or proceed with Escrow Buy Now.`,
    1800
  );

  return {
    id,
    eventKey,
    recipientId: cleanFollower,
    category: 'listing',
    severity: 'info',
    alertKind: 'normal',
    title,
    preview,
    body,
    refType: 'listing',
    refId: listing.id,
    referenceLabel: truncateNotificationField(
      `Followed Seller · @${listing.sellerUsername || 'seller'}`,
      120
    ),
    destination: `listing:${listing.id}`,
  };
}

export function resolveSellerFollowerCount(
  profile?: Pick<PublicProfile, 'followerCount'> | null,
  fallbackFollowDocs?: ReadonlyArray<SellerFollowRecord>
): number {
  if (profile && typeof profile.followerCount === 'number' && Number.isFinite(profile.followerCount)) {
    return Math.max(0, Math.floor(profile.followerCount));
  }
  if (fallbackFollowDocs) {
    return fallbackFollowDocs.length;
  }
  return 0;
}

// ============================================================================
// 5. SHARE LISTING DEEP-LINK & WEB SHARE / CLIPBOARD ORCHESTRATION
// ============================================================================

const SHARE_LISTING_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

export interface ListingSharePayload {
  listingId: string;
  listingTitle: string;
  url: string;
  title: string;
  text: string;
  clipboardText: string;
}

export type ShareExecutionMethod = 'web_share' | 'clipboard' | 'cancelled' | 'failed';

export interface ShareExecutionResult {
  method: ShareExecutionMethod;
  payload: ListingSharePayload;
}

export interface ShareEnvironmentAdapters {
  canShare?: (data: { title?: string; text?: string; url?: string }) => boolean;
  share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
  writeClipboardText?: (text: string) => Promise<void>;
  fallbackCopyText?: (text: string) => boolean;
}

export function buildListingShareDeepLink(
  origin: string,
  pathname: string,
  listingId: string
): string {
  const cleanOrigin = String(origin || '').trim().replace(/\/+$/, '') || 'https://bexora.app';
  const rawPath = String(pathname || '/').trim() || '/';
  const cleanPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const cleanId = String(listingId || '').trim();
  const params = new URLSearchParams();

  if (cleanId && SHARE_LISTING_ID_REGEX.test(cleanId)) {
    params.set('view', 'listing');
    params.set('id', cleanId);
  } else {
    params.set('view', 'market');
  }

  return `${cleanOrigin}${cleanPath}?${params.toString()}`;
}

export function buildListingSharePayload(params: {
  listingId: string;
  title: string;
  origin: string;
  pathname?: string;
}): ListingSharePayload {
  const cleanId = String(params.listingId || '').trim();
  const cleanTitle = String(params.title || '').trim() || 'Digital Asset Listing';
  const url = buildListingShareDeepLink(params.origin, params.pathname || '/', cleanId);
  const title = `${cleanTitle} (ID: ${cleanId}) — BEXORA`;
  const text = `${cleanTitle} · Listing ID: ${cleanId}`;
  const clipboardText = `${cleanTitle} (Listing ID: ${cleanId}) — ${url}`;

  return {
    listingId: cleanId,
    listingTitle: cleanTitle,
    url,
    title,
    text,
    clipboardText,
  };
}

export async function executeShareListing(
  params: {
    listingId: string;
    title: string;
    origin: string;
    pathname?: string;
  },
  adapters: ShareEnvironmentAdapters
): Promise<ShareExecutionResult> {
  const payload = buildListingSharePayload(params);
  const shareData = {
    title: payload.title,
    text: payload.text,
    url: payload.url,
  };

  if (typeof adapters.share === 'function') {
    let shareSupported = true;
    if (typeof adapters.canShare === 'function') {
      try {
        shareSupported = adapters.canShare(shareData);
      } catch {
        shareSupported = false;
      }
    }

    if (shareSupported) {
      try {
        await adapters.share(shareData);
        return { method: 'web_share', payload };
      } catch (err) {
        const errName = (err as { name?: string } | null)?.name;
        if (errName === 'AbortError') {
          return { method: 'cancelled', payload };
        }
        // Non-abort errors (e.g. iframe Permissions-Policy NotAllowedError) fall back to clipboard
      }
    }
  }

  if (typeof adapters.writeClipboardText === 'function') {
    try {
      await adapters.writeClipboardText(payload.clipboardText);
      return { method: 'clipboard', payload };
    } catch {
      // Fall back to execCommand copy helper if Clipboard API is restricted
    }
  }

  if (typeof adapters.fallbackCopyText === 'function') {
    try {
      if (adapters.fallbackCopyText(payload.clipboardText)) {
        return { method: 'clipboard', payload };
      }
    } catch {
      // Ignore and report failure below
    }
  }

  return { method: 'failed', payload };
}

