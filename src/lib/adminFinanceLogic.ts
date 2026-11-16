import type { CurrencyCode, DealRecord } from '../types';

export const HELD_ESCROW_DEAL_STATUSES = new Set<string>([
  'paid_deal_room_active',
  'paid',
  'transfer_in_progress',
  'transfer_submitted',
  'awaiting_buyer_confirmation',
  'transfer_rejected',
  'security_period_active',
  'protection_active',
  'reported_under_review',
  'protection_expired',
]);

export const TERMINAL_DEAL_STATUSES = new Set<string>([
  'settled',
  'refunded',
  'cancelled',
]);

export const UNPAID_DEAL_STATUSES = new Set<string>([
  'accepted_pending_payment',
  'awaiting_payment',
]);

export function sanitizeUsdToBdtRate(rawRate: unknown, fallback = 120): number {
  const num = Number(rawRate);
  if (Number.isFinite(num) && num > 0 && num < 100_000) {
    return num;
  }
  return fallback;
}

/**
 * Converts a minor-unit amount in BDT or USD into integer BDT minor units (paisa).
 * 100 paisa = 1 BDT. Never relies on floating-point currency math at storage boundaries.
 */
export function toBdtMinorInteger(
  rawAmountMinor: unknown,
  rawCurrency: unknown,
  usdToBdtRate = 120
): number {
  const num = Number(rawAmountMinor);
  if (!Number.isFinite(num) || num === 0) return 0;
  const minor = Math.round(num);
  const currency = String(rawCurrency || 'BDT').trim().toUpperCase();
  if (currency === 'USD') {
    const safeRate = sanitizeUsdToBdtRate(usdToBdtRate, 120);
    return Math.round(minor * safeRate);
  }
  return minor;
}

export interface FinanceRestrictionDoc {
  id?: string;
  userId?: string;
  accountStatus?: string;
  restrictWithdrawals?: boolean;
  financialHoldActive?: boolean;
  expiresAtMs?: number;
}

/**
 * Returns true if a user's wallet balance is frozen/restricted and must be excluded from
 * "Total User Withdrawable Balance".
 * - Explicit `financialHoldActive` or `restrictWithdrawals` freezes balance immediately.
 * - Permanent/protective suspensions and non-expired temporary suspensions freeze balance.
 */
export function isUserBalanceRestricted(
  restriction: FinanceRestrictionDoc | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!restriction) return false;
  if (Boolean(restriction.financialHoldActive) || Boolean(restriction.restrictWithdrawals)) {
    return true;
  }
  const status = String(restriction.accountStatus || '').trim();
  if (status === 'permanent_ban' || status === 'protective_suspension') {
    return true;
  }
  if (status === 'temporary_suspension') {
    const expiresAtMs = Number(restriction.expiresAtMs || 0);
    if (expiresAtMs <= 0 || nowMs < expiresAtMs) {
      return true;
    }
  }
  return false;
}

export interface FinanceDealInput {
  id?: string;
  listingId?: string;
  listingTitle?: string;
  platform?: string;
  buyerId?: string;
  buyerName?: string;
  sellerId?: string;
  sellerName?: string;
  status?: string;
  currency?: CurrencyCode | string;
  baseAmountMinor?: number;
  platformCommissionMinor?: number;
  refundPlatformRetainedMinor?: number;
  sellerPayoutMinor?: number;
  buyerTotalMinor?: number;
  originalDeadlineMs?: number;
  unresolvedReportCount?: number;
  settlementLedgerId?: string;
}

/**
 * Strict eligibility check for automatic/idempotent release of Pending Seller Balance
 * into the seller's Available Wallet Balance:
 * 1. Deal must be in an active funded escrow status (never settled/refunded/cancelled/unpaid).
 * 2. Deal must NOT be `reported_under_review`, and must have 0 unresolved reports both on
 *    the deal counter AND in the live reports subcollection.
 * 3. Deal's immutable `originalDeadlineMs` must be set (> 0) and reached (`nowMs >= originalDeadlineMs`).
 * 4. Must not already carry a `settlementLedgerId`.
 */
export function isDealEligibleForAutoRelease(
  deal: Pick<
    FinanceDealInput,
    'status' | 'originalDeadlineMs' | 'unresolvedReportCount' | 'settlementLedgerId'
  > | null | undefined,
  openSubcollectionReportsCount = 0,
  nowMs = Date.now()
): boolean {
  if (!deal) return false;
  const status = String(deal.status || '');
  if (!HELD_ESCROW_DEAL_STATUSES.has(status) || status === 'reported_under_review') {
    return false;
  }
  if (deal.settlementLedgerId) {
    return false;
  }
  const unresolvedCount = Math.max(0, Number(deal.unresolvedReportCount) || 0);
  const subOpenCount = Math.max(0, Number(openSubcollectionReportsCount) || 0);
  if (unresolvedCount > 0 || subOpenCount > 0) {
    return false;
  }
  const deadlineMs = Number(deal.originalDeadlineMs) || 0;
  if (deadlineMs <= 0) {
    return false;
  }
  return nowMs >= deadlineMs;
}

export interface UserPendingSellerSummary {
  totalPendingBdtMinor: number;
  activePendingCount: number;
  readyForReleaseCount: number;
  disputedPendingCount: number;
  deals: Array<{
    dealId: string;
    listingTitle: string;
    status: string;
    payoutBdtMinor: number;
    originalDeadlineMs: number;
    isDisputed: boolean;
    isReadyForRelease: boolean;
  }>;
}

/**
 * Computes a seller's live Pending Seller Balance in integer BDT minor units across all
 * funded, unsettled escrow deals (`deal.sellerId === userUid`).
 */
export function summarizeUserPendingSellerDeals(
  deals: ReadonlyArray<
    Pick<
      DealRecord,
      | 'id'
      | 'listingTitle'
      | 'sellerId'
      | 'status'
      | 'sellerPayoutMinor'
      | 'currency'
      | 'originalDeadlineMs'
      | 'unresolvedReportCount'
      | 'settlementLedgerId'
    >
  >,
  userUid: string | null | undefined,
  usdToBdtRate = 120,
  nowMs = Date.now()
): UserPendingSellerSummary {
  if (!userUid || !Array.isArray(deals) || deals.length === 0) {
    return {
      totalPendingBdtMinor: 0,
      activePendingCount: 0,
      readyForReleaseCount: 0,
      disputedPendingCount: 0,
      deals: [],
    };
  }

  const seenIds = new Set<string>();
  let totalPendingBdtMinor = 0;
  let activePendingCount = 0;
  let readyForReleaseCount = 0;
  let disputedPendingCount = 0;
  const pendingDeals: UserPendingSellerSummary['deals'] = [];

  for (const deal of deals) {
    if (!deal || !deal.id || seenIds.has(deal.id)) continue;
    seenIds.add(deal.id);
    if (deal.sellerId !== userUid) continue;
    if (!HELD_ESCROW_DEAL_STATUSES.has(String(deal.status || ''))) continue;

    const payoutBdtMinor = Math.max(
      0,
      toBdtMinorInteger(deal.sellerPayoutMinor, deal.currency, usdToBdtRate)
    );
    const isDisputed =
      deal.status === 'reported_under_review' || (Number(deal.unresolvedReportCount) || 0) > 0;
    const isReadyForRelease = isDealEligibleForAutoRelease(deal, 0, nowMs);

    totalPendingBdtMinor += payoutBdtMinor;
    activePendingCount += 1;
    if (isDisputed) disputedPendingCount += 1;
    if (isReadyForRelease) readyForReleaseCount += 1;

    pendingDeals.push({
      dealId: deal.id,
      listingTitle: String(deal.listingTitle || 'Escrow Deal'),
      status: String(deal.status || ''),
      payoutBdtMinor,
      originalDeadlineMs: Number(deal.originalDeadlineMs) || 0,
      isDisputed,
      isReadyForRelease,
    });
  }

  return {
    totalPendingBdtMinor,
    activePendingCount,
    readyForReleaseCount,
    disputedPendingCount,
    deals: pendingDeals,
  };
}

export function computeUserPendingSellerBalanceBdtMinor(
  deals: ReadonlyArray<
    Pick<
      DealRecord,
      | 'id'
      | 'listingTitle'
      | 'sellerId'
      | 'status'
      | 'sellerPayoutMinor'
      | 'currency'
      | 'originalDeadlineMs'
      | 'unresolvedReportCount'
      | 'settlementLedgerId'
    >
  >,
  userUid: string | null | undefined,
  usdToBdtRate = 120,
  nowMs = Date.now()
): number {
  return summarizeUserPendingSellerDeals(deals, userUid, usdToBdtRate, nowMs).totalPendingBdtMinor;
}

export interface ComputeAdminFinanceInput {
  privateUsers: ReadonlyArray<{
    id?: string;
    uid?: string;
    walletBalanceMinor?: unknown;
    reservedBalanceMinor?: unknown;
  }>;
  userRestrictions?: ReadonlyArray<FinanceRestrictionDoc>;
  listings: ReadonlyArray<{
    id?: string;
    status?: unknown;
    priceMinor?: unknown;
    currency?: unknown;
  }>;
  deals: ReadonlyArray<FinanceDealInput>;
  withdrawals: ReadonlyArray<{
    id?: string;
    status?: unknown;
    amountMinor?: unknown;
    currency?: unknown;
  }>;
  deposits: ReadonlyArray<{
    id?: string;
    status?: unknown;
    amountMinor?: unknown;
    currency?: unknown;
  }>;
  identityVerifications?: ReadonlyArray<{
    id?: string;
    uid?: string;
    status?: unknown;
  }>;
  usdToBdtRate?: number;
  nowMs?: number;
  complete?: boolean;
  failedCollections?: string[];
  collectionDiagnostics?: Record<
    string,
    { complete: boolean; count: number; source: string; error?: string }
  >;
}

export interface CollectionReadDiagnostic {
  complete: boolean;
  count: number;
  source: string;
  error?: string;
}

export interface AdminFinanceOverviewResult {
  ok: true;
  generatedAtMs: number;
  usdToBdtRateUsed: number;
  complete: boolean;
  failedCollections?: string[];
  collectionDiagnostics?: Record<string, CollectionReadDiagnostic>;
  actionQueue: {
    pendingListingsCount: number;
    pendingNidsCount: number;
    pendingDepositsCount: number;
    pendingWithdrawalsCount: number;
    disputedDealsCount: number;
    readyToSettleDealsCount: number;
  };
  listings: {
    liveCount: number;
    liveValueBdtMinor: number;
    pendingCount: number;
    pendingValueBdtMinor: number;
  };
  deals: {
    settledCount: number;
    grossSalesBdtMinor: number;
    realizedRevenueBdtMinor: number;
    refundRetainedRevenueBdtMinor: number;
    totalPlatformEarningsBdtMinor: number;
    sellerPayoutsReleasedBdtMinor: number;
    heldCount: number;
    escrowHeldBdtMinor: number;
    pendingSellerEarningsBdtMinor: number;
    expectedRevenueBdtMinor: number;
  };
  users: {
    totalUsers: number;
    usersWithBalance: number;
    availableWalletBdtMinor: number;
    restrictedUsersCount: number;
    restrictedWalletBdtMinor: number;
    lockedInWithdrawalsBdtMinor: number;
  };
  withdrawals: {
    pendingCount: number;
    pendingBdtMinor: number;
    paidBdtMinor: number;
  };
  deposits: {
    pendingCount: number;
    pendingBdtMinor: number;
    approvedBdtMinor: number;
  };
}

function deduplicateDocsById<T extends { id?: string }>(docs: ReadonlyArray<T>): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    if (!d) continue;
    if (d.id) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
    }
    out.push(d);
  }
  return out;
}

export function computeAdminFinanceOverview(
  input: ComputeAdminFinanceInput
): AdminFinanceOverviewResult {
  const nowMs = Number.isFinite(input.nowMs) && (input.nowMs || 0) > 0 ? Number(input.nowMs) : Date.now();
  const usdToBdtRateUsed = sanitizeUsdToBdtRate(input.usdToBdtRate, 120);

  const listings = deduplicateDocsById(input.listings || []);
  const deals = deduplicateDocsById(input.deals || []);
  const privateUsers = deduplicateDocsById(input.privateUsers || []);
  const withdrawals = deduplicateDocsById(input.withdrawals || []);
  const deposits = deduplicateDocsById(input.deposits || []);
  const nidDocs = deduplicateDocsById(input.identityVerifications || []);

  const restrictionByUid = new Map<string, FinanceRestrictionDoc>();
  for (const r of input.userRestrictions || []) {
    const uid = String(r?.userId || r?.id || '').trim();
    if (uid && !restrictionByUid.has(uid)) {
      restrictionByUid.set(uid, r);
    }
  }

  // 1. Total Listing Value: STRICTLY active, published listings (`status === 'active'`)
  let liveCount = 0;
  let liveValueBdtMinor = 0;
  let pendingListingCount = 0;
  let pendingValueBdtMinor = 0;

  for (const l of listings) {
    const st = String(l.status || '').trim();
    if (st === 'active') {
      const priceMinor = Math.max(0, toBdtMinorInteger(l.priceMinor, l.currency, usdToBdtRateUsed));
      liveCount += 1;
      liveValueBdtMinor += priceMinor;
    } else if (st === 'pending') {
      const priceMinor = Math.max(0, toBdtMinorInteger(l.priceMinor, l.currency, usdToBdtRateUsed));
      pendingListingCount += 1;
      pendingValueBdtMinor += priceMinor;
    }
  }

  // 2. Escrow Held, Completed Sales, Platform Earnings & Pending Seller Balance
  let settledCount = 0;
  let grossSalesBdtMinor = 0;
  let realizedRevenueBdtMinor = 0;
  let refundRetainedRevenueBdtMinor = 0;
  let sellerPayoutsReleasedBdtMinor = 0;
  let heldCount = 0;
  let escrowHeldBdtMinor = 0;
  let pendingSellerEarningsBdtMinor = 0;
  let expectedRevenueBdtMinor = 0;
  let disputedDealsCount = 0;
  let readyToSettleDealsCount = 0;

  for (const d of deals) {
    const st = String(d.status || '').trim();
    if (st === 'settled') {
      settledCount += 1;
      grossSalesBdtMinor += Math.max(0, toBdtMinorInteger(d.baseAmountMinor, d.currency, usdToBdtRateUsed));
      realizedRevenueBdtMinor += Math.max(
        0,
        toBdtMinorInteger(d.platformCommissionMinor, d.currency, usdToBdtRateUsed)
      );
      sellerPayoutsReleasedBdtMinor += Math.max(
        0,
        toBdtMinorInteger(d.sellerPayoutMinor, d.currency, usdToBdtRateUsed)
      );
    } else if (st === 'refunded') {
      refundRetainedRevenueBdtMinor += Math.max(
        0,
        toBdtMinorInteger(d.refundPlatformRetainedMinor, d.currency, usdToBdtRateUsed)
      );
    } else if (HELD_ESCROW_DEAL_STATUSES.has(st)) {
      heldCount += 1;
      escrowHeldBdtMinor += Math.max(0, toBdtMinorInteger(d.buyerTotalMinor, d.currency, usdToBdtRateUsed));
      pendingSellerEarningsBdtMinor += Math.max(
        0,
        toBdtMinorInteger(d.sellerPayoutMinor, d.currency, usdToBdtRateUsed)
      );
      expectedRevenueBdtMinor += Math.max(
        0,
        toBdtMinorInteger(d.platformCommissionMinor, d.currency, usdToBdtRateUsed)
      );

      if (st === 'reported_under_review' || (Number(d.unresolvedReportCount) || 0) > 0) {
        disputedDealsCount += 1;
      } else if (isDealEligibleForAutoRelease(d, 0, nowMs)) {
        readyToSettleDealsCount += 1;
      }
    }
  }

  const totalPlatformEarningsBdtMinor = realizedRevenueBdtMinor + refundRetainedRevenueBdtMinor;

  // 3. Total User Withdrawable Balance (excludes frozen/restricted user balances & reserved withdrawal holds)
  let usersWithBalance = 0;
  let availableWalletBdtMinor = 0;
  let restrictedUsersCount = 0;
  let restrictedWalletBdtMinor = 0;
  let lockedInWithdrawalsBdtMinor = 0;

  for (const u of privateUsers) {
    const uid = String(u.id || u.uid || '').trim();
    const walletNum = Number(u.walletBalanceMinor);
    const wallet = Number.isFinite(walletNum) && walletNum > 0 ? Math.round(walletNum) : 0;
    const reservedNum = Number(u.reservedBalanceMinor);
    const reserved = Number.isFinite(reservedNum) && reservedNum > 0 ? Math.round(reservedNum) : 0;

    const restricted = isUserBalanceRestricted(uid ? restrictionByUid.get(uid) : undefined, nowMs);
    if (restricted) {
      if (wallet > 0) {
        restrictedUsersCount += 1;
        restrictedWalletBdtMinor += wallet;
      }
    } else {
      if (wallet > 0) usersWithBalance += 1;
      availableWalletBdtMinor += wallet;
    }

    lockedInWithdrawalsBdtMinor += reserved;
  }

  // 4. Withdrawals & Deposits
  let pendingWithdrawalsCount = 0;
  let pendingWithdrawalsBdtMinor = 0;
  let paidWithdrawalsBdtMinor = 0;
  for (const w of withdrawals) {
    const st = String(w.status || '').trim();
    if (st === 'pending') {
      pendingWithdrawalsCount += 1;
      pendingWithdrawalsBdtMinor += Math.max(0, toBdtMinorInteger(w.amountMinor, w.currency, usdToBdtRateUsed));
    } else if (st === 'paid') {
      paidWithdrawalsBdtMinor += Math.max(0, toBdtMinorInteger(w.amountMinor, w.currency, usdToBdtRateUsed));
    }
  }

  let pendingDepositsCount = 0;
  let pendingDepositsBdtMinor = 0;
  let approvedDepositsBdtMinor = 0;
  for (const dep of deposits) {
    const st = String(dep.status || '').trim();
    if (st === 'pending') {
      pendingDepositsCount += 1;
      pendingDepositsBdtMinor += Math.max(0, toBdtMinorInteger(dep.amountMinor, dep.currency, usdToBdtRateUsed));
    } else if (st === 'approved') {
      approvedDepositsBdtMinor += Math.max(0, toBdtMinorInteger(dep.amountMinor, dep.currency, usdToBdtRateUsed));
    }
  }

  // 5. NID Review Queue Count
  let pendingNidsCount = 0;
  for (const n of nidDocs) {
    if (String(n.status || '').trim() === 'pending_review') {
      pendingNidsCount += 1;
    }
  }

  const failedCollections = Array.isArray(input.failedCollections)
    ? input.failedCollections.filter(Boolean)
    : [];
  const isComplete = input.complete !== false && failedCollections.length === 0;

  return {
    ok: true,
    generatedAtMs: nowMs,
    usdToBdtRateUsed,
    complete: isComplete,
    ...(failedCollections.length > 0 ? { failedCollections } : {}),
    ...(input.collectionDiagnostics ? { collectionDiagnostics: input.collectionDiagnostics } : {}),
    actionQueue: {
      pendingListingsCount: pendingListingCount,
      pendingNidsCount,
      pendingDepositsCount,
      pendingWithdrawalsCount,
      disputedDealsCount,
      readyToSettleDealsCount,
    },
    listings: {
      liveCount,
      liveValueBdtMinor,
      pendingCount: pendingListingCount,
      pendingValueBdtMinor,
    },
    deals: {
      settledCount,
      grossSalesBdtMinor,
      realizedRevenueBdtMinor,
      refundRetainedRevenueBdtMinor,
      totalPlatformEarningsBdtMinor,
      sellerPayoutsReleasedBdtMinor,
      heldCount,
      escrowHeldBdtMinor,
      pendingSellerEarningsBdtMinor,
      expectedRevenueBdtMinor,
    },
    users: {
      totalUsers: privateUsers.length,
      usersWithBalance,
      availableWalletBdtMinor,
      restrictedUsersCount,
      restrictedWalletBdtMinor,
      lockedInWithdrawalsBdtMinor,
    },
    withdrawals: {
      pendingCount: pendingWithdrawalsCount,
      pendingBdtMinor: pendingWithdrawalsBdtMinor,
      paidBdtMinor: paidWithdrawalsBdtMinor,
    },
    deposits: {
      pendingCount: pendingDepositsCount,
      pendingBdtMinor: pendingDepositsBdtMinor,
      approvedBdtMinor: approvedDepositsBdtMinor,
    },
  };
}
