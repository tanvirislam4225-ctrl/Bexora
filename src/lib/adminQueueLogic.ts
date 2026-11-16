import type {
  AdminInvitationRecord,
  DealRecord,
  DepositRequestRecord,
  IdentityVerificationRecord,
  ListingStatus,
  MarketplaceListing,
  PlatformId,
  WithdrawalRequestRecord,
} from '../types';
import { isDealTerminalStatus, isDealUnpaidStatus } from './marketplaceLogic';
import { isDealEligibleForAutoRelease } from './adminFinanceLogic';

export type AdminListingBucket = 'pending' | 'approved' | 'rejected' | 'other';
export type AdminNidBucket = 'pending_review' | 'verified' | 'rejected';
export type AdminDepositBucket = 'pending' | 'approved' | 'rejected';
export type AdminWithdrawalBucket = 'pending' | 'paid' | 'rejected';
export type AdminRoleBucket = 'pending' | 'accepted' | 'rejected';
export type AdminDealQueueTab = 'disputed' | 'ready' | 'active' | 'unpaid' | 'settled' | 'all';

export interface ActiveAdminRecord {
  uid: string;
  role: 'admin' | 'superadmin';
  permissions: string[];
  email?: string;
  displayName?: string;
  grantedBy?: string;
  updatedAtMs?: number;
}

export interface PaginatedAdminResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
}

function normalizeQuery(raw?: string): string {
  return String(raw || '').trim().toLowerCase();
}

function matchesQuery(fields: Array<unknown>, query: string): boolean {
  if (!query) return true;
  return fields.some((f) => String(f ?? '').toLowerCase().includes(query));
}

function toTimestampMs(val: unknown): number {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (val && typeof val === 'object' && 'toMillis' in val && typeof (val as { toMillis?: unknown }).toMillis === 'function') {
    return Number((val as { toMillis: () => number }).toMillis()) || 0;
  }
  return 0;
}

export function paginateAdminItems<T>(
  items: ReadonlyArray<T>,
  requestedPage = 1,
  pageSize = 12
): PaginatedAdminResult<T> {
  const safePageSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / safePageSize));
  const page = Math.max(1, Math.min(totalPages, Math.floor(requestedPage || 1)));
  const start = (page - 1) * safePageSize;
  const slice = items.slice(start, start + safePageSize);
  return {
    items: slice,
    page,
    pageSize: safePageSize,
    totalItems,
    totalPages,
    startIndex: totalItems === 0 ? 0 : start + 1,
    endIndex: Math.min(totalItems, start + slice.length),
  };
}

// ----------------------------------------------------------------------------
// 1. MARKETPLACE LISTINGS (Pending / Approved / Rejected + Suspended/Draft)
// ----------------------------------------------------------------------------

export function classifyAdminListingBucket(status: ListingStatus | string): AdminListingBucket {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'active':
    case 'reserved':
    case 'sold':
      return 'approved';
    case 'rejected':
      return 'rejected';
    default:
      return 'other';
  }
}

export function filterAndBucketListings(
  listings: ReadonlyArray<MarketplaceListing>,
  opts: {
    bucket: AdminListingBucket;
    query?: string;
    platform?: PlatformId | 'all';
  }
): {
  items: MarketplaceListing[];
  counts: Record<AdminListingBucket, number>;
} {
  const query = normalizeQuery(opts.query);
  const platform = opts.platform && opts.platform !== 'all' ? opts.platform : null;
  const counts: Record<AdminListingBucket, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
    other: 0,
  };

  const filtered: MarketplaceListing[] = [];
  for (const item of listings) {
    if (!item || !item.id) continue;
    const bucket = classifyAdminListingBucket(item.status);
    counts[bucket] += 1;
    if (bucket !== opts.bucket) continue;
    if (platform && item.platform !== platform) continue;
    if (
      !matchesQuery(
        [item.id, item.title, item.sellerName, item.sellerUsername, item.sellerId, item.subcategory, item.platform, item.rejectionReason],
        query
      )
    ) {
      continue;
    }
    filtered.push(item);
  }

  filtered.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return { items: filtered, counts };
}

// ----------------------------------------------------------------------------
// 2. NID VERIFICATIONS (Pending Review / Verified / Rejected)
// ----------------------------------------------------------------------------

export function classifyAdminNidBucket(status: string | undefined): AdminNidBucket {
  if (status === 'verified') return 'verified';
  if (status === 'rejected') return 'rejected';
  return 'pending_review';
}

export function filterAndBucketNids(
  nids: ReadonlyArray<IdentityVerificationRecord>,
  opts: {
    bucket: AdminNidBucket;
    query?: string;
  },
  profileLookup: Record<string, { displayName?: string; username?: string }> = {}
): {
  items: IdentityVerificationRecord[];
  counts: Record<AdminNidBucket, number>;
} {
  const query = normalizeQuery(opts.query);
  const counts: Record<AdminNidBucket, number> = {
    pending_review: 0,
    verified: 0,
    rejected: 0,
  };
  const filtered: IdentityVerificationRecord[] = [];
  for (const n of nids) {
    if (!n || !n.uid) continue;
    const bucket = classifyAdminNidBucket(n.status);
    counts[bucket] += 1;
    if (bucket !== opts.bucket) continue;
    const prof = profileLookup[n.uid];
    if (
      !matchesQuery(
        [n.uid, prof?.displayName, prof?.username, n.rejectionReason, n.reviewedBy],
        query
      )
    ) {
      continue;
    }
    filtered.push(n);
  }
  filtered.sort((a, b) => {
    const tA = toTimestampMs(a.updatedAt) || toTimestampMs(a.submittedAt);
    const tB = toTimestampMs(b.updatedAt) || toTimestampMs(b.submittedAt);
    return tB - tA;
  });
  return { items: filtered, counts };
}

// ----------------------------------------------------------------------------
// 3. DEPOSIT REQUESTS (Pending / Approved / Rejected)
// ----------------------------------------------------------------------------

export function classifyAdminDepositBucket(status: string | undefined): AdminDepositBucket {
  if (status === 'approved') return 'approved';
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

export function filterAndBucketDeposits(
  deposits: ReadonlyArray<DepositRequestRecord>,
  opts: {
    bucket: AdminDepositBucket;
    query?: string;
  }
): {
  items: DepositRequestRecord[];
  counts: Record<AdminDepositBucket, number>;
} {
  const query = normalizeQuery(opts.query);
  const counts: Record<AdminDepositBucket, number> = {
    pending: 0,
    approved: 0,
    rejected: 0,
  };
  const filtered: DepositRequestRecord[] = [];
  for (const d of deposits) {
    if (!d || !d.id) continue;
    const bucket = classifyAdminDepositBucket(d.status);
    counts[bucket] += 1;
    if (bucket !== opts.bucket) continue;
    if (
      !matchesQuery(
        [d.id, d.userName, d.userId, d.method, d.senderNumber, d.transactionId, d.rejectionReason],
        query
      )
    ) {
      continue;
    }
    filtered.push(d);
  }
  filtered.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return { items: filtered, counts };
}

// ----------------------------------------------------------------------------
// 4. WITHDRAWAL REQUESTS (Pending / Paid / Rejected)
// ----------------------------------------------------------------------------

export function classifyAdminWithdrawalBucket(status: string | undefined): AdminWithdrawalBucket {
  if (status === 'paid') return 'paid';
  if (status === 'rejected') return 'rejected';
  return 'pending';
}

export function filterAndBucketWithdrawals(
  withdrawals: ReadonlyArray<WithdrawalRequestRecord>,
  opts: {
    bucket: AdminWithdrawalBucket;
    query?: string;
  }
): {
  items: WithdrawalRequestRecord[];
  counts: Record<AdminWithdrawalBucket, number>;
} {
  const query = normalizeQuery(opts.query);
  const counts: Record<AdminWithdrawalBucket, number> = {
    pending: 0,
    paid: 0,
    rejected: 0,
  };
  const filtered: WithdrawalRequestRecord[] = [];
  for (const w of withdrawals) {
    if (!w || !w.id) continue;
    const bucket = classifyAdminWithdrawalBucket(w.status);
    counts[bucket] += 1;
    if (bucket !== opts.bucket) continue;
    if (
      !matchesQuery(
        [w.id, w.userName, w.userId, w.method, w.payoutAccount, w.referenceId, w.rejectionReason],
        query
      )
    ) {
      continue;
    }
    filtered.push(w);
  }
  filtered.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return { items: filtered, counts };
}

// ----------------------------------------------------------------------------
// 5. ADMIN GOVERNANCE / INVITATIONS (Pending / Accepted / Rejected)
// ----------------------------------------------------------------------------

export function filterAndBucketAdminGovernance(
  activeAdmins: ReadonlyArray<ActiveAdminRecord>,
  invitations: ReadonlyArray<AdminInvitationRecord>,
  opts: {
    bucket: AdminRoleBucket;
    query?: string;
  }
): {
  pendingInvites: AdminInvitationRecord[];
  acceptedAdmins: ActiveAdminRecord[];
  rejectedInvites: AdminInvitationRecord[];
  counts: Record<AdminRoleBucket, number>;
} {
  const query = normalizeQuery(opts.query);
  const activeUidSet = new Set(activeAdmins.map((a) => a.uid));

  const allPending: AdminInvitationRecord[] = [];
  const allRejected: AdminInvitationRecord[] = [];
  for (const inv of invitations) {
    if (!inv || !inv.id) continue;
    if (inv.status === 'pending' && !activeUidSet.has(inv.targetUid)) {
      allPending.push(inv);
    } else if (inv.status === 'rejected' && !activeUidSet.has(inv.targetUid)) {
      allRejected.push(inv);
    }
  }

  allPending.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  allRejected.sort((a, b) => (b.respondedAtMs || b.createdAtMs || 0) - (a.respondedAtMs || a.createdAtMs || 0));
  const allAccepted = activeAdmins.slice().sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0));

  const counts: Record<AdminRoleBucket, number> = {
    pending: allPending.length,
    accepted: allAccepted.length,
    rejected: allRejected.length,
  };

  return {
    pendingInvites: allPending.filter((inv) =>
      matchesQuery([inv.id, inv.targetUid, inv.targetName, inv.targetEmail, inv.role, inv.invitedBy], query)
    ),
    acceptedAdmins: allAccepted.filter((adm) =>
      matchesQuery([adm.uid, adm.displayName, adm.email, adm.role, adm.grantedBy], query)
    ),
    rejectedInvites: allRejected.filter((inv) =>
      matchesQuery([inv.id, inv.targetUid, inv.targetName, inv.targetEmail, inv.role, inv.rejectionReason], query)
    ),
    counts,
  };
}

// ----------------------------------------------------------------------------
// 6. ESCROW DEALS QUEUE FILTERING
// ----------------------------------------------------------------------------

export function filterAdminDeals(
  deals: ReadonlyArray<DealRecord>,
  opts: {
    tab: AdminDealQueueTab;
    query?: string;
    nowMs?: number;
  }
): {
  items: DealRecord[];
  counts: Record<AdminDealQueueTab, number>;
} {
  const nowMs = opts.nowMs ?? Date.now();
  const query = normalizeQuery(opts.query);
  const counts: Record<AdminDealQueueTab, number> = {
    disputed: 0,
    ready: 0,
    active: 0,
    unpaid: 0,
    settled: 0,
    all: 0,
  };

  const items: DealRecord[] = [];
  for (const d of deals) {
    if (!d || !d.id) continue;
    counts.all += 1;

    const isDisputed = d.status === 'reported_under_review' || (d.unresolvedReportCount || 0) > 0;
    const isReady = !isDisputed && isDealEligibleForAutoRelease(d, 0, nowMs);
    const isUnpaid = isDealUnpaidStatus(d.status);
    const isSettled = isDealTerminalStatus(d.status);
    const isActive = !isDisputed && !isReady && !isUnpaid && !isSettled;

    if (isDisputed) counts.disputed += 1;
    if (isReady) counts.ready += 1;
    if (isActive) counts.active += 1;
    if (isUnpaid) counts.unpaid += 1;
    if (isSettled) counts.settled += 1;

    const matchesTab =
      opts.tab === 'all' ||
      (opts.tab === 'disputed' && isDisputed) ||
      (opts.tab === 'ready' && isReady) ||
      (opts.tab === 'active' && isActive) ||
      (opts.tab === 'unpaid' && isUnpaid) ||
      (opts.tab === 'settled' && isSettled);

    if (!matchesTab) continue;
    if (
      !matchesQuery(
        [d.id, d.listingId, d.listingTitle, d.platform, d.buyerName, d.buyerId, d.sellerName, d.sellerId, d.status],
        query
      )
    ) {
      continue;
    }
    items.push(d);
  }

  items.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  return { items, counts };
}
