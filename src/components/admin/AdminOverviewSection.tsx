import React from 'react';
import { CheckCircle2, RefreshCw } from 'lucide-react';
import type { PublicSettings } from '../../types';
import { formatMoneyFromMinor, getProtectionDurationHours } from '../../lib/marketplaceLogic';
import { DismissibleNotice, hideAllAdminNotices, restoreAllAdminNotices } from '../DismissibleNotice';
import { DashboardStatsSkeleton } from '../LoadingSkeletons';

export interface AdminFinanceOverviewPayload {
  ok: boolean;
  generatedAtMs: number;
  usdToBdtRateUsed: number;
  complete: boolean;
  failedCollections?: string[];
  collectionDiagnostics?: Record<
    string,
    { complete: boolean; count: number; source: string; error?: string }
  >;
  actionQueue?: {
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
    totalPlatformEarningsBdtMinor?: number;
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
    restrictedUsersCount?: number;
    restrictedWalletBdtMinor?: number;
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

interface AdminOverviewSectionProps {
  settings: PublicSettings;
  financeOverview: AdminFinanceOverviewPayload | null;
  financeLoading: boolean;
  financeError: string | null;
  settlingExpiredDeals: boolean;
  pendingListingsCount: number;
  pendingNidsCount: number;
  pendingDepositsCount: number;
  pendingWithdrawalsCount: number;
  reportedDealsCount: number;
  readyToSettleDealsCount: number;
  onRefreshFinance: () => void;
  onSettleAllExpiredDeals: () => void;
  onNavigateSection: (
    section: 'moderation' | 'nid' | 'deposits' | 'withdrawals' | 'deals'
  ) => void;
  onFlash: (msg: string) => void;
}

export const AdminOverviewSection: React.FC<AdminOverviewSectionProps> = ({
  settings,
  financeOverview,
  financeLoading,
  financeError,
  settlingExpiredDeals,
  pendingListingsCount,
  pendingNidsCount,
  pendingDepositsCount,
  pendingWithdrawalsCount,
  reportedDealsCount,
  readyToSettleDealsCount,
  onRefreshFinance,
  onSettleAllExpiredDeals,
  onNavigateSection,
  onFlash,
}) => {
  const financeRateUsed = financeOverview?.usdToBdtRateUsed || settings.usdToBdtRate || 120;
  const fmtBdt = (bdtMinor: number) =>
    formatMoneyFromMinor(bdtMinor, 'BDT', 'BDT', financeRateUsed);
  const isInitialFinanceLoad = financeLoading && !financeOverview;
  const queueListings =
    financeOverview?.actionQueue?.pendingListingsCount ?? pendingListingsCount;
  const queueNids =
    financeOverview?.actionQueue?.pendingNidsCount ?? pendingNidsCount;
  const queueDeposits =
    financeOverview?.actionQueue?.pendingDepositsCount ?? pendingDepositsCount;
  const queueWithdrawals =
    financeOverview?.actionQueue?.pendingWithdrawalsCount ?? pendingWithdrawalsCount;
  const queueDisputedDeals =
    financeOverview?.actionQueue?.disputedDealsCount ?? reportedDealsCount;
  const queueReadyDeals =
    financeOverview?.actionQueue?.readyToSettleDealsCount ?? readyToSettleDealsCount;

  const availableUserBalanceMinor = financeOverview?.users.availableWalletBdtMinor ?? 0;
  const restrictedWalletMinor = financeOverview?.users.restrictedWalletBdtMinor ?? 0;
  const restrictedUsersCount = financeOverview?.users.restrictedUsersCount ?? 0;
  const lockedInWithdrawalsMinor = financeOverview?.users.lockedInWithdrawalsBdtMinor ?? 0;
  const payableIfAllWithdrawMinor = availableUserBalanceMinor + lockedInWithdrawalsMinor;
  const escrowHeldMinor = financeOverview?.deals.escrowHeldBdtMinor ?? 0;
  const totalPlatformEarningsMinor =
    financeOverview?.deals.totalPlatformEarningsBdtMinor ??
    (financeOverview?.deals.realizedRevenueBdtMinor ?? 0) +
      (financeOverview?.deals.refundRetainedRevenueBdtMinor ?? 0);
  const totalPlatformObligationsMinor = payableIfAllWithdrawMinor + escrowHeldMinor;
  const estimatedSurplusMinor =
    ((financeOverview?.deposits.approvedBdtMinor ?? 0) -
      (financeOverview?.withdrawals.paidBdtMinor ?? 0)) -
    totalPlatformObligationsMinor;

  return (
    <div className="space-y-6">
      <div className="bx-card p-5 sm:p-6 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-black tracking-tight">BEXORA Operations &amp; Financial Overview</h1>
          <p className="text-xs opacity-75 mt-1">
            Live server-computed Firebase metrics in BDT (৳) — zero synthetic totals.
            {financeOverview && (
              <span className="ml-2 font-bold">
                · Updated {new Date(financeOverview.generatedAtMs).toLocaleTimeString()} · 1 USD ={' '}
                {financeOverview.usdToBdtRateUsed} BDT
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRefreshFinance}
            disabled={financeLoading}
            className="bx-btn bx-btn-primary px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5 disabled:opacity-60"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${financeLoading ? 'animate-spin' : ''}`} />
            <span>{financeLoading ? 'Refreshing…' : 'Refresh Totals'}</span>
          </button>
          {queueReadyDeals > 0 && (
            <button
              type="button"
              onClick={onSettleAllExpiredDeals}
              disabled={settlingExpiredDeals}
              className="bx-btn bx-btn-yellow px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5 disabled:opacity-60"
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>
                {settlingExpiredDeals
                  ? 'Releasing Payouts…'
                  : `Release ${queueReadyDeals} Ready Escrow Payout(s)`}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              hideAllAdminNotices();
              onFlash('Admin tips hidden.');
            }}
            className="bx-btn bx-btn-ghost px-3 py-2 text-xs font-extrabold"
          >
            Hide tips
          </button>
          <button
            type="button"
            onClick={() => {
              restoreAllAdminNotices();
              onFlash('Hidden admin tips restored.');
            }}
            className="bx-btn bx-btn-ghost px-3 py-2 text-xs font-extrabold"
          >
            Show hidden tips
          </button>
        </div>
      </div>

      {financeError && (
        <div
          role="alert"
          className="bx-card p-4 border-2 border-red-600 bg-red-50 dark:bg-red-950/30 text-xs font-bold text-red-700 dark:text-red-300 flex flex-wrap items-center justify-between gap-2"
        >
          <span>Finance overview failed to load: {financeError}</span>
          <button
            type="button"
            onClick={onRefreshFinance}
            disabled={financeLoading}
            className="bx-btn bx-btn-sm font-extrabold"
          >
            Retry
          </button>
        </div>
      )}

      {financeOverview && financeOverview.complete === false && (
        <div
          role="status"
          className="bx-card p-4 border-2 border-amber-500 bg-amber-50 dark:bg-amber-950/30 text-xs font-bold text-amber-800 dark:text-amber-300 flex flex-wrap items-center justify-between gap-2"
        >
          <span>
            Partial collection read
            {financeOverview.failedCollections && financeOverview.failedCollections.length > 0
              ? `: ${financeOverview.failedCollections.join(', ')} could not be read completely.`
              : ': Some Firestore collections could not be read completely.'}{' '}
            Displayed totals may be partial.
          </span>
          <button
            type="button"
            onClick={onRefreshFinance}
            disabled={financeLoading}
            className="bx-btn bx-btn-sm font-extrabold"
          >
            Retry Totals
          </button>
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-black uppercase tracking-wide">Action Queue</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4 tabular-nums">
          <button
            type="button"
            onClick={() => onNavigateSection('moderation')}
            className="bx-card p-4 text-left cursor-pointer hover:border-[#FF6500] transition-colors min-h-[76px]"
          >
            <div className="text-xs font-bold uppercase opacity-70">Pending Listings</div>
            <div className="text-2xl font-black mt-1">{queueListings}</div>
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('nid')}
            className="bx-card p-4 text-left cursor-pointer hover:border-[#FF6500] transition-colors min-h-[76px]"
          >
            <div className="text-xs font-bold uppercase opacity-70">Pending NIDs</div>
            <div className="text-2xl font-black mt-1">{queueNids}</div>
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('deposits')}
            className="bx-card p-4 text-left cursor-pointer hover:border-[#FF6500] transition-colors min-h-[76px]"
          >
            <div className="text-xs font-bold uppercase opacity-70">Pending Deposits</div>
            <div className="text-2xl font-black mt-1">{queueDeposits}</div>
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('withdrawals')}
            className="bx-card p-4 text-left cursor-pointer hover:border-[#FF6500] transition-colors min-h-[76px]"
          >
            <div className="text-xs font-bold uppercase opacity-70">Pending Withdrawals</div>
            <div className="text-2xl font-black mt-1">{queueWithdrawals}</div>
          </button>
          <button
            type="button"
            onClick={() => onNavigateSection('deals')}
            className="bx-card p-4 text-left cursor-pointer hover:border-[#FF6500] transition-colors min-h-[76px] col-span-2 sm:col-span-1"
          >
            <div className="text-xs font-bold uppercase opacity-70">Disputes / Ready</div>
            <div className="text-2xl font-black mt-1 text-red-600">
              {queueDisputedDeals} / <span className="text-emerald-600">{queueReadyDeals}</span>
            </div>
          </button>
        </div>
      </div>

      {/* PRIMARY 6 FINANCIAL OVERVIEW KPI CARDS (ALL IN BDT) */}
      <div className="space-y-3" data-testid="admin-financial-overview-section">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-black uppercase tracking-wide">Financial Overview (BDT)</h2>
          <span className="text-[11px] font-bold opacity-75">
            Real-time accounting · Restricted user wallets &amp; non-active listings excluded from active totals
          </span>
        </div>
        {isInitialFinanceLoad || !financeOverview ? (
          <DashboardStatsSkeleton cards={6} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 tabular-nums">
            <div className="bx-card p-4 space-y-1 border-l-4 border-l-[var(--orange)]">
              <div className="text-xs font-bold uppercase opacity-75">Total Listing Value</div>
              <div className="text-2xl font-black">
                {fmtBdt(financeOverview.listings.liveValueBdtMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                {financeOverview.listings.liveCount} active published listings only (excludes reserved, pending, rejected, draft, & sold)
              </p>
            </div>

            <div className="bx-card p-4 space-y-1 border-l-4 border-l-emerald-600">
              <div className="text-xs font-bold uppercase opacity-75">Total Platform Earnings</div>
              <div className="text-2xl font-black text-emerald-600 dark:text-emerald-400">
                {fmtBdt(totalPlatformEarningsMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Settled commissions ({fmtBdt(financeOverview.deals.realizedRevenueBdtMinor)}) + dispute retained ({fmtBdt(financeOverview.deals.refundRetainedRevenueBdtMinor)})
              </p>
            </div>

            <div className="bx-card p-4 space-y-1 border-l-4 border-l-sky-600">
              <div className="text-xs font-bold uppercase opacity-75">Total User Withdrawable Balance</div>
              <div className="text-2xl font-black">
                {fmtBdt(availableUserBalanceMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                {financeOverview.users.usersWithBalance} unrestricted users with withdrawable balance
              </p>
            </div>

            <div className="bx-card p-4 space-y-1 border-l-4 border-l-amber-500">
              <div className="text-xs font-bold uppercase opacity-75">Total Escrow Held</div>
              <div className="text-2xl font-black">
                {fmtBdt(escrowHeldMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                {financeOverview.deals.heldCount} active unsettled deals locked in escrow
              </p>
            </div>

            <div className="bx-card p-4 space-y-1 border-l-4 border-l-purple-600">
              <div className="text-xs font-bold uppercase opacity-75">Total Completed Sales</div>
              <div className="text-2xl font-black">
                {fmtBdt(financeOverview.deals.grossSalesBdtMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Gross selling volume across {financeOverview.deals.settledCount} finalized sales
              </p>
            </div>

            <div className="bx-card p-4 space-y-1 border-l-4 border-l-orange-500">
              <div className="text-xs font-bold uppercase opacity-75">Total Pending Seller Balance</div>
              <div className="text-2xl font-black text-[#FF6500]">
                {fmtBdt(financeOverview.deals.pendingSellerEarningsBdtMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Seller payouts awaiting security countdown (locked from withdrawal)
              </p>
            </div>
          </div>
        )}
      </div>

      {/* SECONDARY RESERVES, LIABILITIES & PIPELINE BREAKDOWN */}
      <div className="space-y-3">
        <h2 className="text-sm font-black uppercase tracking-wide">Reserves &amp; Liability Breakdown</h2>
        {isInitialFinanceLoad || !financeOverview ? (
          <DashboardStatsSkeleton cards={6} />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 tabular-nums">
            <div className="bx-card p-4 space-y-1">
              <div className="text-xs font-bold uppercase opacity-70">Projected Escrow Commission</div>
              <div className="text-xl font-black text-[#FF6500]">
                {fmtBdt(financeOverview.deals.expectedRevenueBdtMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Pending fee on {financeOverview.deals.heldCount} funded escrow deals
              </p>
            </div>

            <div className="bx-card p-4 space-y-1">
              <div className="text-xs font-bold uppercase opacity-70">Seller Payouts Released</div>
              <div className="text-xl font-black">
                {fmtBdt(financeOverview.deals.sellerPayoutsReleasedBdtMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Credited to sellers across {financeOverview.deals.settledCount} settled deals
              </p>
            </div>

            <div className="bx-card p-4 space-y-1">
              <div className="text-xs font-bold uppercase opacity-70">Locked in Withdrawals</div>
              <div className="text-xl font-black">
                {fmtBdt(lockedInWithdrawalsMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                {financeOverview.withdrawals.pendingCount} pending requests ({fmtBdt(financeOverview.withdrawals.pendingBdtMinor)})
              </p>
            </div>

            <div className="bx-card p-4 space-y-1">
              <div className="text-xs font-bold uppercase opacity-70">Frozen / Restricted Wallets</div>
              <div className="text-xl font-black">
                {fmtBdt(restrictedWalletMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                {restrictedUsersCount} suspended/held user account(s) excluded from withdrawable total
              </p>
            </div>

            <div className="bx-card p-4 space-y-1">
              <div className="text-xs font-bold uppercase opacity-70">Total Platform Obligations</div>
              <div className="text-xl font-black">
                {fmtBdt(totalPlatformObligationsMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Available wallets + withdrawal holds + escrow held
              </p>
            </div>

            <div className="bx-card p-4 space-y-1">
              <div className="text-xs font-bold uppercase opacity-70">Estimated Reserve Surplus</div>
              <div
                className={`text-xl font-black ${
                  estimatedSurplusMinor < 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {fmtBdt(estimatedSurplusMinor)}
              </div>
              <p className="text-[11px] opacity-75">
                Deposits ({fmtBdt(financeOverview.deposits.approvedBdtMinor)}) − Paid ({fmtBdt(financeOverview.withdrawals.paidBdtMinor)}) − Obligations
              </p>
            </div>
          </div>
        )}
      </div>

      <DismissibleNotice id="overview-policy" className="bx-card p-5 space-y-3">
        <h2 className="text-sm font-black uppercase">Active Fee, Dispute Refund &amp; Security Timer Policy</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-bold">
          <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
            Buyer Fee: {settings.buyerFeeEnabled ? `${settings.buyerFeePct}%` : 'Disabled (0%)'} · Dispute Refund: 100% Bid + Refundable Fee (3% Platform Retained)
          </div>
          <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
            Seller Commission: {settings.sellerFeeEnabled ? `${settings.sellerFeePct}%` : 'Disabled (0%)'}
          </div>
          <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
            Security Timers: YouTube {getProtectionDurationHours('youtube', settings)}h (7d) · Facebook &amp; Standard {getProtectionDurationHours('facebook', settings)}h
          </div>
        </div>
      </DismissibleNotice>
    </div>
  );
};
