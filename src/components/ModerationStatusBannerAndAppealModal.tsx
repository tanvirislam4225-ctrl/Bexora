import React, { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Scale,
  ShieldAlert,
  Wallet,
  X,
} from 'lucide-react';
import { UserProfile } from '../types';
import {
  AccountAppealRecord,
  ModerationStrikeRecord,
  UserReportCategory,
  UserReportRecord,
  UserRestrictionRecord,
} from '../types/moderation';
import {
  acknowledgeModerationWarningClient,
  formatModerationCategoryLabel,
  formatSurfaceLabel,
  submitAccountAppealClient,
} from '../lib/moderationClient';

interface ModerationStatusBannerAndAppealModalProps {
  currentUser: { uid: string; displayName?: string | null } | null;
  restriction: UserRestrictionRecord | null;
  activeStrikes: ModerationStrikeRecord[];
  appeals: AccountAppealRecord[];
  myReports: Array<{
    id: string;
    trackingRef: string;
    category: UserReportCategory;
    reportedUserName: string;
    status: UserReportRecord['status'];
    resolutionSummary?: string;
    createdAtMs: number;
  }>;
  modalOpen: boolean;
  onOpenModal: () => void;
  onCloseModal: () => void;
  onRefreshStatus: () => Promise<void>;
}

function getRestrictedCapabilitiesList(r: UserRestrictionRecord | null): string[] {
  if (!r) return [];
  const items: string[] = [];
  if (r.restrictListings) items.push('Publishing Listings');
  if (r.restrictBidding) items.push('Placing Bids');
  if (r.restrictPurchasing) items.push('Purchasing Assets');
  if (r.restrictPreDealChat) items.push('Pre-Deal Messaging');
  if (r.restrictDealChat) items.push('Deal Room Chat');
  if (r.restrictReviews) items.push('Submitting Reviews');
  if (r.restrictProfileEdits) items.push('Editing Public Profile');
  if (r.restrictWithdrawals || r.financialHoldActive) items.push('New Withdrawal Requests (Balance Preserved)');
  return items;
}

export function ModerationStatusBannerAndAppealModal({
  currentUser,
  restriction,
  activeStrikes,
  appeals,
  myReports,
  modalOpen,
  onOpenModal,
  onCloseModal,
  onRefreshStatus,
}: ModerationStatusBannerAndAppealModalProps) {
  const [acknowledging, setAcknowledging] = useState(false);
  const [activeTab, setActiveTab] = useState<'status_appeals' | 'my_reports'>('status_appeals');
  const [appealExplanation, setAppealExplanation] = useState('');
  const [supportingContext, setSupportingContext] = useState('');
  const [submittingAppeal, setSubmittingAppeal] = useState(false);
  const [appealError, setAppealError] = useState<string | null>(null);
  const [appealSuccessRef, setAppealSuccessRef] = useState<string | null>(null);

  if (!currentUser) return null;

  const accountStatus = restriction?.accountStatus || 'active';
  const strikeCount = Math.max(restriction?.activeStrikes || 0, activeStrikes.filter((s) => !s.reversed).length);
  const hasUnacknowledgedWarning = Boolean(
    restriction &&
      (restriction.latestWarningTitle || restriction.latestWarningMessage) &&
      !restriction.acknowledgedWarningAtMs
  );
  const restrictedCaps = getRestrictedCapabilitiesList(restriction);
  const isSuspendedOrBanned =
    accountStatus === 'protective_suspension' ||
    accountStatus === 'temporary_suspension' ||
    accountStatus === 'permanent_ban';
  const shouldShowBanner =
    isSuspendedOrBanned ||
    accountStatus === 'restricted' ||
    hasUnacknowledgedWarning ||
    Boolean(restriction?.financialHoldActive);

  const canSubmitAppeal =
    isSuspendedOrBanned ||
    accountStatus === 'restricted' ||
    strikeCount > 0 ||
    Boolean(restriction?.financialHoldActive);

  const handleAcknowledge = async () => {
    setAcknowledging(true);
    try {
      await acknowledgeModerationWarningClient();
      await onRefreshStatus();
    } finally {
      setAcknowledging(false);
    }
  };

  const handleAppealSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAppealError(null);
    setAppealSuccessRef(null);

    if (appealExplanation.trim().length < 20) {
      setAppealError(
        'Please write at least 20 characters explaining why this restriction or strike should be reviewed.'
      );
      return;
    }

    setSubmittingAppeal(true);
    try {
      const res = await submitAccountAppealClient({
        callerName: currentUser.displayName || 'Marketplace Member',
        explanation: appealExplanation.trim(),
        supportingContext: supportingContext.trim() || undefined,
      });
      if (!res.ok || !res.appeal) {
        setAppealError(res.error || 'Could not submit appeal at this time.');
        return;
      }
      setAppealSuccessRef(res.appeal.trackingRef);
      setAppealExplanation('');
      setSupportingContext('');
      await onRefreshStatus();
    } finally {
      setSubmittingAppeal(false);
    }
  };

  return (
    <>
      {shouldShowBanner && restriction && (
        <div
          role="region"
          aria-label="Account Trust and Safety Notice"
          className={`border-b px-4 py-3 ${
            isSuspendedOrBanned
              ? 'bg-rose-50 dark:bg-rose-950/40 border-rose-200 dark:border-rose-800/70'
              : 'bg-amber-50 dark:bg-amber-950/35 border-amber-200 dark:border-amber-800/70'
          }`}
        >
          <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <ShieldAlert
                className={`w-5 h-5 shrink-0 mt-0.5 ${
                  isSuspendedOrBanned
                    ? 'text-rose-600 dark:text-rose-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              />
              <div className="space-y-1 min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold text-slate-900 dark:text-white">
                  <span>
                    {restriction.latestWarningTitle ||
                      (accountStatus === 'permanent_ban'
                        ? 'ACCOUNT PERMANENTLY BANNED BY ADMINISTRATOR'
                        : accountStatus === 'protective_suspension'
                        ? 'ACCOUNT UNDER PROTECTIVE SUSPENSION — PENDING HUMAN ADMIN REVIEW'
                        : accountStatus === 'temporary_suspension'
                        ? 'ACCOUNT TEMPORARILY SUSPENDED'
                        : 'COMMUNITY GUIDELINES & ACCOUNT SAFETY NOTICE')}
                  </span>
                  <span aria-hidden="true" className="text-slate-400">
                    ·
                  </span>
                  <span className="font-mono tabular-nums text-rose-700 dark:text-rose-300">
                    Active Strikes: {strikeCount} / 3
                  </span>
                  {restriction.expiresAtMs > Date.now() && (
                    <>
                      <span aria-hidden="true" className="text-slate-400">
                        ·
                      </span>
                      <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        Until {new Date(restriction.expiresAtMs).toLocaleString()}
                      </span>
                    </>
                  )}
                </div>
                <p className="text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {restriction.latestWarningMessage || restriction.reason}
                </p>
                {restrictedCaps.length > 0 && (
                  <p className="text-[11px] text-slate-600 dark:text-slate-400">
                    Restricted Actions: {restrictedCaps.join(' · ')}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {hasUnacknowledgedWarning && !isSuspendedOrBanned && (
                <button
                  type="button"
                  onClick={handleAcknowledge}
                  disabled={acknowledging}
                  className="px-3 py-1.5 rounded-lg border border-amber-400 dark:border-amber-700 bg-white dark:bg-slate-900 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-amber-100/60 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
                >
                  {acknowledging ? 'Saving...' : 'Acknowledge Warning'}
                </button>
              )}
              <button
                type="button"
                onClick={onOpenModal}
                className="px-3.5 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold hover:opacity-90 transition-opacity whitespace-nowrap shrink-0"
              >
                Safety Center & Appeals
              </button>
            </div>
          </div>
        </div>
      )}

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="safety-appeals-modal-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 backdrop-blur-sm p-4 overflow-y-auto"
        >
          <div className="w-full max-w-2xl rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-2xl overflow-hidden my-auto">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2.5 min-w-0">
                <Scale className="w-5 h-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                <div className="min-w-0">
                  <h2
                    id="safety-appeals-modal-title"
                    className="text-base font-bold text-slate-900 dark:text-white truncate"
                  >
                    Account Safety, Strikes & Appeals
                  </h2>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">
                    Review active strikes, submit an appeal for human review, or check your submitted reports
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={onCloseModal}
                aria-label="Close Safety and Appeals dialog"
                className="p-2 rounded-lg text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 pt-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveTab('status_appeals')}
                className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'status_appeals'
                    ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400'
                    : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                Standing, Strikes & Appeals ({strikeCount}/3)
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('my_reports')}
                className={`px-3.5 py-2 text-xs font-semibold border-b-2 transition-colors whitespace-nowrap shrink-0 ${
                  activeTab === 'my_reports'
                    ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400'
                    : 'border-transparent text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white'
                }`}
              >
                My Submitted Reports ({myReports.length})
              </button>
            </div>

            <div className="p-5 max-h-[75vh] overflow-y-auto space-y-5">
              {activeTab === 'status_appeals' ? (
                <>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-slate-600 dark:text-slate-400">
                        Current Account Standing
                      </span>
                      <span className="text-xs font-bold text-slate-900 dark:text-white font-mono tabular-nums">
                        {accountStatus.replace(/_/g, ' ').toUpperCase()} · {strikeCount} / 3 Strikes
                      </span>
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                      {restriction?.reason ||
                        'Your account has no active Trust & Safety restrictions. Maintain respectful communication and keep all transactions inside BEXORA Escrow.'}
                    </p>
                    <div className="flex items-center gap-2 pt-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                      <Wallet className="w-3.5 h-3.5 shrink-0" />
                      <span>
                        Wallet Protection Guarantee: Automated protective suspensions never confiscate or erase your wallet balance.
                      </span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                      Active Policy Strikes ({activeStrikes.filter((s) => !s.reversed).length})
                    </h3>
                    {activeStrikes.filter((s) => !s.reversed).length === 0 ? (
                      <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 text-xs text-slate-500 dark:text-slate-400">
                        Zero active policy strikes on your account.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {activeStrikes
                          .filter((s) => !s.reversed)
                          .map((strike) => (
                            <div
                              key={strike.id}
                              className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1 text-xs"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <span className="font-semibold text-slate-900 dark:text-white">
                                  Strike #{strike.strikeNumber} ·{' '}
                                  {formatModerationCategoryLabel(strike.category)}
                                </span>
                                <span className="text-[11px] text-slate-500 font-mono tabular-nums">
                                  {formatSurfaceLabel(strike.surface)} ·{' '}
                                  {new Date(strike.createdAtMs).toLocaleString()}
                                </span>
                              </div>
                              <p className="text-slate-600 dark:text-slate-300">{strike.summary}</p>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>

                  {canSubmitAppeal && (
                    <form
                      onSubmit={handleAppealSubmit}
                      className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3"
                    >
                      <div>
                        <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                          Submit Appeal for Human Administrator Review
                        </h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                          Believe an automated protective action or strike was triggered by mistake or a
                          legitimate dispute? Submit context below for human review.
                        </p>
                      </div>

                      <div>
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <label
                            htmlFor="appeal-explanation"
                            className="text-xs font-semibold text-slate-700 dark:text-slate-200"
                          >
                            Appeal Explanation
                          </label>
                          <span className="text-[11px] font-mono tabular-nums text-slate-500">
                            {appealExplanation.trim().length} / 3000 (min 20)
                          </span>
                        </div>
                        <textarea
                          id="appeal-explanation"
                          rows={3}
                          value={appealExplanation}
                          onChange={(e) => setAppealExplanation(e.target.value)}
                          placeholder="Explain clearly why the flagged message, listing, or restriction should be reconsidered..."
                          className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        />
                      </div>

                      <div>
                        <label
                          htmlFor="appeal-context"
                          className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                        >
                          Deal ID, Listing ID, or Additional Context (Optional)
                        </label>
                        <input
                          id="appeal-context"
                          type="text"
                          value={supportingContext}
                          onChange={(e) => setSupportingContext(e.target.value)}
                          placeholder="e.g., Deal #deal_123 — discussing YouTube channel copyright strike history"
                          className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
                        />
                      </div>

                      {appealError && (
                        <div className="rounded-lg bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-800/70 px-3 py-2 text-xs text-rose-700 dark:text-rose-300 flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 shrink-0" />
                          <span>{appealError}</span>
                        </div>
                      )}

                      {appealSuccessRef && (
                        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/70 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                          <CheckCircle2 className="w-4 h-4 shrink-0" />
                          <span>
                            Appeal submitted ({appealSuccessRef}). A human administrator will review your
                            case.
                          </span>
                        </div>
                      )}

                      <div className="flex justify-end">
                        <button
                          type="submit"
                          disabled={submittingAppeal}
                          className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                        >
                          {submittingAppeal ? 'Submitting Appeal...' : 'Submit Appeal'}
                        </button>
                      </div>
                    </form>
                  )}

                  {appeals.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-bold text-slate-900 dark:text-white">
                        Appeal History ({appeals.length})
                      </h3>
                      {appeals.map((ap) => (
                        <div
                          key={ap.id}
                          className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                              {ap.trackingRef}
                            </span>
                            <span className="text-slate-600 dark:text-slate-300 font-medium">
                              Status: {ap.status.replace(/_/g, ' ')} ·{' '}
                              {new Date(ap.createdAtMs).toLocaleDateString()}
                            </span>
                          </div>
                          <p className="text-slate-600 dark:text-slate-300">{ap.explanation}</p>
                          {ap.adminDecisionNote && (
                            <p className="text-emerald-700 dark:text-emerald-400 pt-1 border-t border-slate-200 dark:border-slate-800">
                              Admin Decision: {ap.adminDecisionNote}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2.5">
                  {myReports.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-6 text-center space-y-1.5">
                      <FileText className="w-6 h-6 text-slate-400 mx-auto" />
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                        No Submitted Reports Yet
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Reports you file from listings, profiles, chats, or reviews will appear here with
                        their confidential tracking status.
                      </p>
                    </div>
                  ) : (
                    myReports.map((rpt) => (
                      <div
                        key={rpt.id}
                        className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                            {rpt.trackingRef} · {rpt.reportedUserName}
                          </span>
                          <span className="text-slate-600 dark:text-slate-300 font-medium">
                            {rpt.status.replace(/_/g, ' ')} ·{' '}
                            {new Date(rpt.createdAtMs).toLocaleDateString()}
                          </span>
                        </div>
                        <p className="text-slate-500 dark:text-slate-400">
                          Category: {rpt.category.replace(/_/g, ' ')}
                        </p>
                        {rpt.resolutionSummary && (
                          <p className="text-emerald-700 dark:text-emerald-400 pt-1 border-t border-slate-200 dark:border-slate-800">
                            Outcome: {rpt.resolutionSummary}
                          </p>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
