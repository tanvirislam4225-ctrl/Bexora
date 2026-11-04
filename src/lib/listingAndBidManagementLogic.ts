import type { ListingStatus } from '../types';

export const MAX_LISTING_IMAGES = 10;

export const MAX_GALLERY_LIMIT_MESSAGE = 'Maximum 10 images allowed per listing.';

export const LISTING_UPDATED_REVIEW_NOTICE = {
  title: 'LISTING UPDATED — PENDING REVIEW',
  message:
    'Your listing changes have been submitted successfully. The updated listing will become publicly available after the review process is completed.',
} as const;

export const LISTING_DELETE_BLOCKED_ACTIVE_DEAL = {
  title: 'LISTING CANNOT BE DELETED',
  message:
    'This listing is connected to an active transaction. Please complete or resolve the ongoing deal before deleting this asset.',
} as const;

export const LISTING_DELETE_CONFIRM_COPY = {
  title: 'DELETE THIS LISTING?',
  message:
    'Are you sure you want to permanently remove this asset listing from your marketplace dashboard?\n\nThis action cannot be undone.',
  successBanner: 'LISTING DELETED SUCCESSFULLY',
} as const;

export const BUYER_WITHDRAW_BID_COPY = {
  title: 'WITHDRAW YOUR BID?',
  message:
    'Are you sure you want to withdraw this offer?\n\nOnce withdrawn, it will no longer appear as an active bid on this listing.',
  cancelLabel: 'Cancel',
  confirmLabel: 'Confirm Withdrawal',
  successBanner: 'YOUR BID HAS BEEN WITHDRAWN SUCCESSFULLY.',
} as const;

export const SELLER_REJECT_BID_COPY = {
  title: 'REJECT THIS BID?',
  message:
    "Are you sure you want to reject this buyer's offer?\n\nThe bid will be removed from the active bidding list.",
  cancelLabel: 'Cancel',
  confirmLabel: 'Confirm Rejection',
  successBanner: 'BID REJECTED SUCCESSFULLY.',
  buyerNotificationTitle: 'YOUR BID WAS NOT ACCEPTED',
  buyerNotificationBody: 'The seller has rejected your offer for this asset.',
} as const;

/**
 * Validates how many new images can be added to a listing gallery capped at 10 images.
 * Never silently drops overflow files — returns an explicit `exceededLimit` flag and user notice.
 */
export function validateGalleryBatchAdd(
  existingCount: number,
  incomingFilesCount: number,
  maxImages = MAX_LISTING_IMAGES
): {
  allowedCount: number;
  exceededLimit: boolean;
  notice?: string;
} {
  const safeExisting = Math.max(0, Math.floor(existingCount));
  const safeIncoming = Math.max(0, Math.floor(incomingFilesCount));
  const remainingSlots = Math.max(0, maxImages - safeExisting);

  if (remainingSlots === 0 || safeIncoming > remainingSlots) {
    return {
      allowedCount: Math.min(safeIncoming, remainingSlots),
      exceededLimit: true,
      notice: MAX_GALLERY_LIMIT_MESSAGE,
    };
  }

  return {
    allowedCount: safeIncoming,
    exceededLimit: false,
  };
}

export function removeGalleryImageAt<T>(images: T[], index: number): T[] {
  if (index < 0 || index >= images.length) return [...images];
  return images.filter((_, idx) => idx !== index);
}

export function replaceGalleryImageAt<T>(images: T[], index: number, replacement: T): T[] {
  if (index < 0 || index >= images.length) return [...images];
  const next = [...images];
  next[index] = replacement;
  return next;
}

export function moveGalleryImage<T>(images: T[], fromIndex: number, toIndex: number): T[] {
  if (
    fromIndex < 0 ||
    fromIndex >= images.length ||
    toIndex < 0 ||
    toIndex >= images.length ||
    fromIndex === toIndex
  ) {
    return [...images];
  }
  const next = [...images];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/**
 * Promotes the selected gallery image to index 0 (Cover image) while preserving relative order of others.
 */
export function setGalleryCoverImage<T>(images: T[], index: number): T[] {
  return moveGalleryImage(images, index, 0);
}

/**
 * Seller can edit own listings when in `draft`, `pending`, `active`, `rejected`, or `archived`
 * AND not bound to an active deal (`reserved`, `sold`, `suspended` are blocked).
 */
export function canSellerEditListingStatus(
  status: ListingStatus | string,
  activeDealId?: string | null
): boolean {
  if (activeDealId && String(activeDealId).trim().length > 0) {
    return false;
  }
  return (
    status === 'draft' ||
    status === 'pending' ||
    status === 'active' ||
    status === 'rejected' ||
    status === 'archived'
  );
}

export type ListingDeletionBlockCode =
  | 'not_owner'
  | 'active_deal'
  | 'accepted_bid_obligation'
  | 'sold_completed_history'
  | 'open_dispute'
  | 'open_moderation_report'
  | 'suspended_by_admin';

export interface ListingDeletionPreflightInput {
  isOwner: boolean;
  listingStatus: string;
  activeDealId?: string | null;
  deals?: Array<{ id?: string; status?: string; sellerPayoutCredited?: boolean }>;
  bids?: Array<{ id?: string; status?: string; dealId?: string }>;
  openDealReportsCount?: number;
  openUserReportsCount?: number;
}

export interface ListingDeletionPreflightResult {
  eligible: boolean;
  blockingCode?: ListingDeletionBlockCode;
  title: string;
  message: string;
  pendingBidsCount: number;
}

const TERMINAL_FINISHED_DEAL_STATUSES = new Set(['settled', 'refunded', 'cancelled']);
const ACCEPTED_OBLIGATION_BID_STATUSES = new Set(['accepted_pending_payment', 'accepted', 'paid']);

/**
 * Evaluates all pre-deletion safety checks for a seller-owned listing.
 */
export function evaluateListingDeletionEligibility(
  input: ListingDeletionPreflightInput
): ListingDeletionPreflightResult {
  const bids = Array.isArray(input.bids) ? input.bids : [];
  const deals = Array.isArray(input.deals) ? input.deals : [];
  const pendingBidsCount = bids.filter((b) => b.status === 'pending' && !b.dealId).length;

  if (!input.isOwner) {
    return {
      eligible: false,
      blockingCode: 'not_owner',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message: 'You are not authorized to delete a listing owned by another seller.',
      pendingBidsCount,
    };
  }

  if (input.listingStatus === 'suspended') {
    return {
      eligible: false,
      blockingCode: 'suspended_by_admin',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message:
        'This listing is currently suspended under moderation review and cannot be deleted until the review concludes.',
      pendingBidsCount,
    };
  }

  if ((input.openDealReportsCount || 0) > 0) {
    return {
      eligible: false,
      blockingCode: 'open_dispute',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message:
        'This listing has an open transaction dispute under review. Please wait until the dispute is resolved.',
      pendingBidsCount,
    };
  }

  const hasOngoingDeal =
    (Boolean(input.activeDealId) && String(input.activeDealId).trim().length > 0 && input.listingStatus === 'reserved') ||
    deals.some((d) => !TERMINAL_FINISHED_DEAL_STATUSES.has(String(d.status || '')));

  if (hasOngoingDeal || input.listingStatus === 'reserved') {
    return {
      eligible: false,
      blockingCode: 'active_deal',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.message,
      pendingBidsCount,
    };
  }

  const hasAcceptedBidObligation = bids.some((b) =>
    ACCEPTED_OBLIGATION_BID_STATUSES.has(String(b.status || ''))
  );
  if (hasAcceptedBidObligation) {
    return {
      eligible: false,
      blockingCode: 'accepted_bid_obligation',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.message,
      pendingBidsCount,
    };
  }

  const hasSettledDealHistory =
    input.listingStatus === 'sold' || deals.some((d) => d.status === 'settled');
  if (hasSettledDealHistory) {
    return {
      eligible: false,
      blockingCode: 'sold_completed_history',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message:
        'Completed marketplace sales remain part of buyer & seller transaction records and cannot be deleted.',
      pendingBidsCount,
    };
  }

  if ((input.openUserReportsCount || 0) > 0) {
    return {
      eligible: false,
      blockingCode: 'open_moderation_report',
      title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
      message:
        'This listing has an open safety or moderation investigation and cannot be deleted until review finishes.',
      pendingBidsCount,
    };
  }

  return {
    eligible: true,
    title: LISTING_DELETE_CONFIRM_COPY.title,
    message: LISTING_DELETE_CONFIRM_COPY.message,
    pendingBidsCount,
  };
}

export interface MinimalBidItem {
  id: string;
  listingId?: string;
  buyerId: string;
  amountMinor: number;
  status: string;
  dealId?: string;
  buyerName?: string;
  buyerUsername?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export function canBuyerWithdrawBid(bid: MinimalBidItem, viewerUid?: string | null): boolean {
  if (!viewerUid || bid.buyerId !== viewerUid) return false;
  if (bid.dealId && String(bid.dealId).trim().length > 0) return false;
  return bid.status === 'pending';
}

export function canSellerRejectBid(
  bid: MinimalBidItem,
  isSellerOwner: boolean,
  listingStatus?: string
): boolean {
  if (!isSellerOwner) return false;
  if (listingStatus === 'sold' || listingStatus === 'suspended') return false;
  if (bid.dealId && String(bid.dealId).trim().length > 0) return false;
  return bid.status === 'pending';
}

/**
 * Separates bids on a listing into:
 * - `activePendingBids`: strictly `status === 'pending'` (sorted highest offer first)
 * - `acceptedDealBids`: `accepted_pending_payment`, `accepted`, `paid`
 * - `historicalBids`: `withdrawn`, `rejected`, `expired`, `cancelled` (visible to seller owner, admin, or the bid's own buyer)
 */
export function partitionBidsForListingView<T extends MinimalBidItem>(
  bids: T[],
  viewerUid?: string | null,
  canViewAllHistory = false
): {
  activePendingBids: T[];
  acceptedDealBids: T[];
  historicalBids: T[];
} {
  const activePendingBids: T[] = [];
  const acceptedDealBids: T[] = [];
  const historicalBids: T[] = [];

  for (const bid of bids) {
    const st = String(bid.status || '');
    if (st === 'pending') {
      activePendingBids.push(bid);
    } else if (st === 'accepted_pending_payment' || st === 'accepted' || st === 'paid') {
      acceptedDealBids.push(bid);
    } else if (
      st === 'withdrawn' ||
      st === 'rejected' ||
      st === 'expired' ||
      st === 'cancelled'
    ) {
      if (canViewAllHistory || (viewerUid && bid.buyerId === viewerUid)) {
        historicalBids.push(bid);
      }
    }
  }

  activePendingBids.sort((a, b) => Number(b.amountMinor || 0) - Number(a.amountMinor || 0));
  acceptedDealBids.sort((a, b) => Number(b.amountMinor || 0) - Number(a.amountMinor || 0));

  return {
    activePendingBids,
    acceptedDealBids,
    historicalBids,
  };
}

export interface AdminUserDeletionPreflightInput {
  callerRole: 'superadmin' | 'moderator' | string;
  callerUid: string;
  targetUid: string;
  walletBalanceMinor: number;
  reservedBalanceMinor: number;
  financialHoldActive: boolean;
  activeDealsCount: number;
  acceptedObligationBidsCount: number;
  pendingDepositsCount: number;
  pendingWithdrawalsCount: number;
  openDisputesCount: number;
  openModerationInvestigationsCount: number;
}

export interface AdminUserDeletionPreflightResult {
  eligible: boolean;
  blockers: string[];
}

/**
 * Evaluates whether an administrator can permanently delete a user account without
 * corrupting active transactions, escrow funds, wallet balances, or ongoing investigations.
 */
export function evaluateAdminUserDeletionEligibility(
  input: AdminUserDeletionPreflightInput
): AdminUserDeletionPreflightResult {
  const blockers: string[] = [];

  if (input.callerRole !== 'superadmin') {
    blockers.push('Only a Superadmin can permanently delete user accounts.');
  }

  if (input.callerUid && input.callerUid === input.targetUid) {
    blockers.push('You cannot permanently delete your own active Superadmin account.');
  }

  if (input.activeDealsCount > 0) {
    blockers.push(
      `User has ${input.activeDealsCount} active or unresolved marketplace deal(s) in escrow.`
    );
  }

  if (input.acceptedObligationBidsCount > 0) {
    blockers.push(
      `User has ${input.acceptedObligationBidsCount} accepted bid obligation(s) awaiting payment or completion.`
    );
  }

  if (input.walletBalanceMinor > 0) {
    blockers.push(
      `User holds a non-zero available wallet balance (${(input.walletBalanceMinor / 100).toFixed(2)} BDT). Settle or refund balance before deletion.`
    );
  }

  if (input.reservedBalanceMinor > 0) {
    blockers.push(
      `User holds reserved/escrow funds (${(input.reservedBalanceMinor / 100).toFixed(2)} BDT).`
    );
  }

  if (input.pendingDepositsCount > 0) {
    blockers.push(
      `User has ${input.pendingDepositsCount} pending wallet deposit request(s) awaiting review.`
    );
  }

  if (input.pendingWithdrawalsCount > 0) {
    blockers.push(
      `User has ${input.pendingWithdrawalsCount} pending payout/withdrawal request(s) in queue.`
    );
  }

  if (input.openDisputesCount > 0) {
    blockers.push(`User is involved in ${input.openDisputesCount} open transaction dispute(s).`);
  }

  if (input.financialHoldActive) {
    blockers.push(
      'Account currently has an active financial hold. Resolve the financial hold before permanent deletion.'
    );
  }

  if (input.openModerationInvestigationsCount > 0) {
    blockers.push(
      `User has ${input.openModerationInvestigationsCount} open moderation report(s) or pending appeal(s) under investigation.`
    );
  }

  return {
    eligible: blockers.length === 0,
    blockers,
  };
}
