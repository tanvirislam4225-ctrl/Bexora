import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Flag,
  Lock,
  Play,
  RefreshCw,
  Scale,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import {
  AccountAppealRecord,
  AlertPriority,
  ModerationAlertRecord,
  ModerationPolicySettings,
  UserReportRecord,
  UserRestrictionRecord,
} from '../types/moderation';
import {
  AdminModerationOverviewResponse,
  fetchAdminModerationOverview,
  formatModerationCategoryLabel,
  formatSurfaceLabel,
  runAdminModerationSelfTest,
  saveAdminModerationSettings,
  SelfTestResultRow,
  triggerAdminAlertAction,
  triggerAdminAppealDecision,
  triggerAdminEnforceUserAction,
  triggerAdminMonitorSweepNow,
  triggerAdminReportAction,
} from '../lib/moderationClient';

interface AdminTrustSafetyCenterProps {
  isSuperAdmin: boolean;
  onFlash?: (type: 'success' | 'error', text: string) => void;
}

type TrustSafetySubTab = 'live_alerts' | 'user_reports' | 'appeals_ledger' | 'policy_settings';

export function AdminTrustSafetyCenter({ isSuperAdmin, onFlash }: AdminTrustSafetyCenterProps) {
  const [subTab, setSubTab] = useState<TrustSafetySubTab>('live_alerts');
  const [overview, setOverview] = useState<AdminModerationOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [runningSelfTest, setRunningSelfTest] = useState(false);
  const [selfTestResults, setSelfTestResults] = useState<{
    allPassed: boolean;
    checkedAtMs: number;
    results: SelfTestResultRow[];
  } | null>(null);

  // Filters
  const [alertPriorityFilter, setAlertPriorityFilter] = useState<'ALL' | AlertPriority>('ALL');
  const [alertStatusFilter, setAlertStatusFilter] = useState<'ALL' | 'open' | 'resolved'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Selected items for inspection
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const [alertActionReason, setAlertActionReason] = useState('');
  const [busyAction, setBusyAction] = useState(false);

  const [selectedReportId, setSelectedReportId] = useState<string | null>(null);
  const [reportNoteInput, setReportNoteInput] = useState('');
  const [reportStatusFilter, setReportStatusFilter] = useState<'ALL' | 'OPEN' | 'CLOSED'>('ALL');

  // Direct / Graduated User Enforcement state
  const [enforceTargetUid, setEnforceTargetUid] = useState('');
  const [enforceTargetName, setEnforceTargetName] = useState('');
  const [enforceAction, setEnforceAction] = useState<
    | 'update_granular_restrictions'
    | 'temporary_suspension'
    | 'permanent_ban'
    | 'unban_restore'
    | 'add_manual_strike'
    | 'reverse_strike'
    | 'apply_financial_hold'
    | 'release_financial_hold'
  >('temporary_suspension');
  const [enforceDurationHours, setEnforceDurationHours] = useState(72);
  const [enforceStrikeIdToReverse, setEnforceStrikeIdToReverse] = useState('');
  const [enforceReason, setEnforceReason] = useState('');
  const [granularFlags, setGranularFlags] = useState({
    restrictListings: false,
    restrictBidding: false,
    restrictPurchasing: false,
    restrictPreDealChat: false,
    restrictDealChat: false,
    restrictReviews: false,
    restrictProfileEdits: false,
    restrictWithdrawals: false,
  });

  // Appeal review state
  const [appealDecisionNotes, setAppealDecisionNotes] = useState<Record<string, string>>({});

  // Policy draft state
  const [policyDraft, setPolicyDraft] = useState<ModerationPolicySettings | null>(null);

  const notify = useCallback(
    (type: 'success' | 'error', text: string) => {
      if (onFlash) onFlash(type, text);
    },
    [onFlash]
  );

  const loadOverview = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminModerationOverview();
      setOverview(data);
      setPolicyDraft((prev) => prev || data.policy);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load Trust & Safety console.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview(false);
    const poll = window.setInterval(() => {
      void loadOverview(true);
    }, 25_000);
    return () => window.clearInterval(poll);
  }, [loadOverview]);

  const filteredAlerts = useMemo(() => {
    const list = overview?.alerts || [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((a) => {
      if (alertPriorityFilter !== 'ALL' && a.priority !== alertPriorityFilter) return false;
      if (alertStatusFilter === 'open' && a.status !== 'open' && a.status !== 'investigating') {
        return false;
      }
      if (
        alertStatusFilter === 'resolved' &&
        a.status !== 'resolved' &&
        a.status !== 'false_positive'
      ) {
        return false;
      }
      if (q) {
        const hay = `${a.userName || ''} ${a.userId} ${a.category} ${a.rawContent} ${a.surface}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [overview?.alerts, alertPriorityFilter, alertStatusFilter, searchQuery]);

  const selectedAlert: ModerationAlertRecord | null = useMemo(() => {
    if (!overview?.alerts.length) return null;
    if (selectedAlertId) {
      return overview.alerts.find((a) => a.id === selectedAlertId) || overview.alerts[0] || null;
    }
    return filteredAlerts[0] || overview.alerts[0] || null;
  }, [overview?.alerts, selectedAlertId, filteredAlerts]);

  const filteredReports = useMemo(() => {
    const list = overview?.reports || [];
    const q = searchQuery.trim().toLowerCase();
    return list.filter((r) => {
      if (reportStatusFilter === 'OPEN' && (r.status === 'action_taken' || r.status === 'dismissed')) {
        return false;
      }
      if (
        reportStatusFilter === 'CLOSED' &&
        r.status !== 'action_taken' &&
        r.status !== 'dismissed'
      ) {
        return false;
      }
      if (q) {
        const hay = `${r.trackingRef} ${r.reportedUserName} ${r.reportedUserId} ${r.category} ${r.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [overview?.reports, reportStatusFilter, searchQuery]);

  const selectedReport: UserReportRecord | null = useMemo(() => {
    if (!overview?.reports.length) return null;
    if (selectedReportId) {
      return overview.reports.find((r) => r.id === selectedReportId) || null;
    }
    return filteredReports[0] || null;
  }, [overview?.reports, selectedReportId, filteredReports]);

  const populateEnforceFromUser = (uid: string, name?: string) => {
    setEnforceTargetUid(uid);
    setEnforceTargetName(name || '');
    const existing: UserRestrictionRecord | undefined = overview?.restrictions.find(
      (r) => r.userId === uid
    );
    if (existing) {
      setGranularFlags({
        restrictListings: existing.restrictListings,
        restrictBidding: existing.restrictBidding,
        restrictPurchasing: existing.restrictPurchasing,
        restrictPreDealChat: existing.restrictPreDealChat,
        restrictDealChat: existing.restrictDealChat,
        restrictReviews: existing.restrictReviews,
        restrictProfileEdits: existing.restrictProfileEdits,
        restrictWithdrawals: existing.restrictWithdrawals,
      });
    }
  };

  const handleSweepNow = async () => {
    setSweeping(true);
    try {
      const res = await triggerAdminMonitorSweepNow();
      if (res.ok) {
        notify('success', '24/7 Trust & Safety sweep executed across listings, profiles, and reviews.');
        await loadOverview(true);
      }
    } finally {
      setSweeping(false);
    }
  };

  const handleRunSelfTest = async () => {
    setRunningSelfTest(true);
    try {
      const res = await runAdminModerationSelfTest();
      if (res.ok) {
        setSelfTestResults({
          allPassed: res.allPassed,
          checkedAtMs: res.checkedAtMs,
          results: res.results,
        });
        notify(
          res.allPassed ? 'success' : 'error',
          res.allPassed
            ? `Multilingual & fairness verification passed (${res.results.length}/${res.results.length} checks).`
            : 'One or more moderation verification checks reported a mismatch.'
        );
      }
    } finally {
      setRunningSelfTest(false);
    }
  };

  const handleAlertDecision = async (
    alert: ModerationAlertRecord,
    action:
      | 'resume_conversation'
      | 'keep_paused'
      | 'quarantine_content'
      | 'issue_warning'
      | 'apply_strike'
      | 'dismiss_false_positive'
  ) => {
    const reason =
      alertActionReason.trim() ||
      `Admin ${action.replace(/_/g, ' ')} on alert ${alert.id} (${alert.category}).`;
    setBusyAction(true);
    try {
      const res = await triggerAdminAlertAction({
        alertId: alert.id,
        action,
        reason,
      });
      if (!res.ok) {
        notify('error', res.error || 'Could not apply alert decision.');
        return;
      }
      setAlertActionReason('');
      notify('success', `Alert updated: ${action.replace(/_/g, ' ')}.`);
      await loadOverview(true);
    } finally {
      setBusyAction(false);
    }
  };

  const handleReportWorkflow = async (
    report: UserReportRecord,
    action:
      | 'mark_under_review'
      | 'assign_self'
      | 'add_internal_note'
      | 'request_info'
      | 'resolve_action_taken'
      | 'dismiss_report'
  ) => {
    const note =
      reportNoteInput.trim() ||
      `Admin workflow update: ${action.replace(/_/g, ' ')} for ${report.trackingRef}.`;
    if (action === 'add_internal_note' && reportNoteInput.trim().length < 4) {
      notify('error', 'Enter an internal note of at least 4 characters.');
      return;
    }
    setBusyAction(true);
    try {
      const res = await triggerAdminReportAction({
        reportId: report.id,
        action,
        noteOrReason: note,
      });
      if (!res.ok) {
        notify('error', res.error || 'Report update failed.');
        return;
      }
      setReportNoteInput('');
      notify('success', `Report ${report.trackingRef} updated (${action.replace(/_/g, ' ')}).`);
      await loadOverview(true);
    } finally {
      setBusyAction(false);
    }
  };

  const handleSubmitEnforcement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enforceTargetUid.trim()) {
      notify('error', 'Target User UID is required.');
      return;
    }
    if (enforceReason.trim().length < 6) {
      notify('error', 'Mandatory audit reason must be at least 6 characters.');
      return;
    }
    setBusyAction(true);
    try {
      const res = await triggerAdminEnforceUserAction({
        targetUserId: enforceTargetUid.trim(),
        targetUserName: enforceTargetName.trim() || undefined,
        action: enforceAction,
        reason: enforceReason.trim(),
        durationHours: enforceAction === 'temporary_suspension' ? enforceDurationHours : undefined,
        strikeIdToReverse:
          enforceAction === 'reverse_strike' ? enforceStrikeIdToReverse.trim() : undefined,
        granularFlags:
          enforceAction === 'update_granular_restrictions' ? granularFlags : undefined,
      });
      if (!res.ok) {
        notify('error', res.error || 'Enforcement action failed.');
        return;
      }
      setEnforceReason('');
      notify('success', `Enforcement applied (${enforceAction.replace(/_/g, ' ')}).`);
      await loadOverview(true);
    } finally {
      setBusyAction(false);
    }
  };

  const handleAppealDecision = async (
    appeal: AccountAppealRecord,
    decision: 'accept_restore' | 'accept_reverse_strike_and_restore' | 'request_info' | 'reject'
  ) => {
    const decisionNote = (appealDecisionNotes[appeal.id] || '').trim();
    if (decisionNote.length < 6) {
      notify('error', 'Please enter a decision explanation of at least 6 characters for the user.');
      return;
    }
    setBusyAction(true);
    try {
      const res = await triggerAdminAppealDecision({
        appealId: appeal.id,
        decision,
        decisionNote,
      });
      if (!res.ok) {
        notify('error', res.error || 'Could not record appeal decision.');
        return;
      }
      setAppealDecisionNotes((prev) => ({ ...prev, [appeal.id]: '' }));
      notify('success', `Appeal ${appeal.trackingRef} processed.`);
      await loadOverview(true);
    } finally {
      setBusyAction(false);
    }
  };

  const handleSavePolicy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!policyDraft) return;
    setBusyAction(true);
    try {
      const res = await saveAdminModerationSettings(policyDraft);
      if (!res.ok || !res.policy) {
        notify('error', res.error || 'Could not update policy settings.');
        return;
      }
      setPolicyDraft(res.policy);
      notify('success', 'Trust & Safety policy thresholds and templates saved.');
      await loadOverview(true);
    } finally {
      setBusyAction(false);
    }
  };

  const health = overview?.health;

  return (
    <div className="space-y-5">
      {/* Top Header & Actions */}
      <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">
              24/7 Autonomous AI Trust & Safety Monitor
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Continuous multilingual abuse detection (Bengali, Banglish, English, Hindi, Urdu),
              automated protective 3-strike safeguards, confidential user reporting, and human-final
              account governance.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleRunSelfTest}
              disabled={runningSelfTest}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-semibold text-slate-800 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0"
            >
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
              <span>{runningSelfTest ? 'Testing...' : 'Verify Multilingual Engine'}</span>
            </button>
            <button
              type="button"
              onClick={handleSweepNow}
              disabled={sweeping}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${sweeping ? 'animate-spin' : ''}`} />
              <span>{sweeping ? 'Sweeping...' : 'Run Monitor Sweep Now'}</span>
            </button>
          </div>
        </div>

        {/* 24/7 Health Telemetry Grid */}
        {health && (
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3 mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">24/7 Worker</div>
              <div className="text-xs font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                {health.monitorActive ? `Active (${health.backgroundWorkerIntervalSec}s)` : 'Standby'}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">AI Engine Mode</div>
              <div className="text-xs font-bold text-slate-900 dark:text-white">
                {health.aiEngineStatus === 'operational'
                  ? 'Gemini + Rules'
                  : health.aiEngineStatus === 'degraded_fallback'
                  ? 'Degraded Retry'
                  : 'Deterministic Safe'}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Last Sweep</div>
              <div className="text-xs font-mono font-semibold text-slate-900 dark:text-white tabular-nums">
                {health.lastBackgroundSweepAtMs
                  ? new Date(health.lastBackgroundSweepAtMs).toLocaleTimeString()
                  : 'Booting'}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Events Inspected</div>
              <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                {health.totalEventsInspected}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Critical/High Open</div>
              <div className="text-sm font-mono font-bold text-rose-600 dark:text-rose-400 tabular-nums">
                {health.openCriticalHighAlertsCount}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Paused Chats</div>
              <div className="text-sm font-mono font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                {health.suspiciousPausedConversationsCount}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Open User Reports</div>
              <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                {health.openUserReportsCount}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">Pending Appeals</div>
              <div className="text-sm font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                {health.pendingAppealsCount}
              </div>
            </div>
          </div>
        )}

        {/* Self-Test Verification Table (only rendered when Admin triggers it) */}
        {selfTestResults && (
          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold text-slate-900 dark:text-white">
                Isolated Multilingual & Fairness Diagnostic Results (Zero Fake Alerts Created)
              </span>
              <button
                type="button"
                onClick={() => setSelfTestResults(null)}
                className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
              >
                Dismiss
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                    <th className="py-1.5 pr-3 font-medium">Test Scenario</th>
                    <th className="py-1.5 px-3 font-medium">Expected</th>
                    <th className="py-1.5 px-3 font-medium">Actual</th>
                    <th className="py-1.5 px-3 font-medium">Category</th>
                    <th className="py-1.5 pl-3 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                  {selfTestResults.results.map((r) => (
                    <tr key={r.name}>
                      <td className="py-1.5 pr-3 text-slate-900 dark:text-slate-200 font-medium">
                        {r.name}
                      </td>
                      <td className="py-1.5 px-3 font-mono tabular-nums text-slate-600 dark:text-slate-400">
                        {r.expectedLevel}
                      </td>
                      <td className="py-1.5 px-3 font-mono tabular-nums text-slate-900 dark:text-white">
                        {r.actualLevel}
                      </td>
                      <td className="py-1.5 px-3 text-slate-600 dark:text-slate-300">
                        {formatModerationCategoryLabel(r.category)}
                      </td>
                      <td className="py-1.5 pl-3 text-right font-semibold">
                        {r.passed ? (
                          <span className="text-emerald-600 dark:text-emerald-400">PASS</span>
                        ) : (
                          <span className="text-rose-600 dark:text-rose-400">FAIL</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setSubTab('live_alerts')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'live_alerts'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>AI Security Monitor ({overview?.alerts.length || 0})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('user_reports')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'user_reports'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Flag className="w-3.5 h-3.5" />
            <span>User Reports & Enforcement ({overview?.reports.length || 0})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('appeals_ledger')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'appeals_ledger'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Scale className="w-3.5 h-3.5" />
            <span>Appeals & Audit Ledger ({overview?.appeals.length || 0})</span>
          </button>
          <button
            type="button"
            onClick={() => setSubTab('policy_settings')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'policy_settings'
                ? 'bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
            }`}
          >
            <Settings className="w-3.5 h-3.5" />
            <span>Policy Settings</span>
          </button>
        </div>

        {(subTab === 'live_alerts' || subTab === 'user_reports') && (
          <div className="relative w-full sm:w-64">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter user, ID, text..."
              aria-label="Filter moderation records"
              className="w-full pl-8 pr-3 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
            />
          </div>
        )}
      </div>

      {loading && !overview ? (
        <div className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center text-xs text-slate-500">
          Loading 24/7 Trust & Safety telemetry...
        </div>
      ) : error ? (
        <div className="rounded-2xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/30 p-5 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void loadOverview(false)}
            className="px-3 py-1.5 rounded-lg bg-rose-600 text-white font-semibold whitespace-nowrap shrink-0"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* TAB 1: AI SECURITY MONITOR — LIVE ALERTS */}
      {overview && subTab === 'live_alerts' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
            <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1">
                {(['ALL', 'CRITICAL', 'HIGH', 'MEDIUM'] as const).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setAlertPriorityFilter(p)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors whitespace-nowrap shrink-0 ${
                      alertPriorityFilter === p
                        ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1">
                {(['ALL', 'open', 'resolved'] as const).map((st) => (
                  <button
                    key={st}
                    type="button"
                    onClick={() => setAlertStatusFilter(st)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                      alertStatusFilter === st
                        ? 'bg-emerald-600 text-white'
                        : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                    }`}
                  >
                    {st === 'ALL' ? 'All' : st === 'open' ? 'Open' : 'Resolved'}
                  </button>
                ))}
              </div>
            </div>

            {filteredAlerts.length === 0 ? (
              <div className="p-8 text-center space-y-1.5">
                <CheckCircle2 className="w-7 h-7 text-emerald-500 mx-auto" />
                <p className="text-xs font-semibold text-slate-900 dark:text-white">
                  No Matching Live Moderation Alerts
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  The 24/7 AI monitor is actively scanning new listings, profiles, chats, media, and
                  reviews in real time. Zero fake alerts are generated.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[560px] overflow-y-auto">
                {filteredAlerts.map((alert) => {
                  const isSelected = selectedAlert?.id === alert.id;
                  return (
                    <button
                      key={alert.id}
                      type="button"
                      onClick={() => setSelectedAlertId(alert.id)}
                      className={`w-full text-left p-3.5 transition-colors space-y-1 ${
                        isSelected
                          ? 'bg-emerald-50/70 dark:bg-emerald-950/25'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span
                          className={`font-bold ${
                            alert.priority === 'CRITICAL' || alert.priority === 'HIGH'
                              ? 'text-rose-600 dark:text-rose-400'
                              : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {alert.priority} · {alert.decisionLevel}
                        </span>
                        <span className="text-[11px] font-mono tabular-nums text-slate-500">
                          {new Date(alert.createdAtMs).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-slate-900 dark:text-white truncate">
                        {formatModerationCategoryLabel(alert.category)}
                      </div>
                      <div className="text-[11px] text-slate-500 dark:text-slate-400 truncate">
                        {alert.userName || alert.userId} · {formatSurfaceLabel(alert.surface)} ·{' '}
                        {alert.status.replace(/_/g, ' ')}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
            {!selectedAlert ? (
              <div className="py-12 text-center space-y-2">
                <Eye className="w-7 h-7 text-slate-400 mx-auto" />
                <p className="text-sm font-semibold text-slate-900 dark:text-white">
                  Evidence & Decision Inspector
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                  Select any alert from the queue to inspect raw preserved text, OCR/transcripts, AI
                  protective actions, and execute human-final decisions.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                  <div>
                    <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                      {formatModerationCategoryLabel(selectedAlert.category)}
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 font-mono tabular-nums">
                      User: {selectedAlert.userName || 'Member'} ({selectedAlert.userId}) ·{' '}
                      {formatSurfaceLabel(selectedAlert.surface)} · Confidence:{' '}
                      {Math.round(selectedAlert.confidence * 100)}%
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      populateEnforceFromUser(selectedAlert.userId, selectedAlert.userName);
                      setSubTab('user_reports');
                    }}
                    className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                  >
                    Open User Enforcement
                  </button>
                </div>

                {/* Raw Preserved Evidence */}
                <div className="space-y-1.5">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                    Preserved Raw Content & Signals
                  </div>
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 text-xs font-mono text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
                    {selectedAlert.rawContent || '(Media submission)'}
                  </div>
                  {selectedAlert.ocrExtractedText && (
                    <div className="text-xs text-slate-600 dark:text-slate-300">
                      <span className="font-semibold">OCR Extracted Text:</span>{' '}
                      {selectedAlert.ocrExtractedText}
                    </div>
                  )}
                  {selectedAlert.audioTranscript && (
                    <div className="text-xs text-slate-600 dark:text-slate-300">
                      <span className="font-semibold">Voice Transcript:</span>{' '}
                      {selectedAlert.audioTranscript}
                    </div>
                  )}
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    Languages: {selectedAlert.detectedLanguages.join(', ')} · AI Scan Verified:{' '}
                    {selectedAlert.aiScanCompleted ? 'Yes' : 'Deterministic / Queued'} · Evasion Signals:{' '}
                    {selectedAlert.evasionSignals.length
                      ? selectedAlert.evasionSignals.join(', ')
                      : 'None'}
                  </div>
                </div>

                {/* Strict Separation: AI Protective Action vs Human Admin Final Authority */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1 text-xs">
                    <div className="font-bold text-slate-900 dark:text-white">
                      1. Automated Protective Action Taken
                    </div>
                    <p className="text-slate-600 dark:text-slate-300">
                      {selectedAlert.protectiveActionTaken}
                    </p>
                    <p className="text-[11px] text-slate-500 pt-1">
                      AI Reasoning: {selectedAlert.aiReasoning}
                    </p>
                    <p className="text-[11px] text-emerald-700 dark:text-emerald-400">
                      AI Recommendation: {selectedAlert.aiRecommendation}
                    </p>
                  </div>

                  <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1 text-xs">
                    <div className="font-bold text-slate-900 dark:text-white">
                      2. Human Administrator Final Decision
                    </div>
                    {selectedAlert.humanFinalDecision ? (
                      <>
                        <p className="text-emerald-700 dark:text-emerald-400 font-medium">
                          {selectedAlert.humanFinalDecision}
                        </p>
                        <p className="text-[11px] text-slate-500">
                          By {selectedAlert.reviewedByAdminEmail || selectedAlert.reviewedByAdminId} ·{' '}
                          {selectedAlert.reviewedAtMs
                            ? new Date(selectedAlert.reviewedAtMs).toLocaleString()
                            : ''}
                        </p>
                      </>
                    ) : (
                      <p className="text-slate-500 dark:text-slate-400">
                        Awaiting human administrator review. Permanent account bans are never issued
                        automatically by AI.
                      </p>
                    )}
                  </div>
                </div>

                {/* Admin Decision Controls */}
                <div className="space-y-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <label
                    htmlFor="alert-decision-reason"
                    className="block text-xs font-semibold text-slate-700 dark:text-slate-200"
                  >
                    Administrator Audit Note
                  </label>
                  <input
                    id="alert-decision-reason"
                    type="text"
                    value={alertActionReason}
                    onChange={(e) => setAlertActionReason(e.target.value)}
                    placeholder="Optional audit note for this alert decision..."
                    className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {(selectedAlert.conversationPaused || selectedAlert.conversationId || selectedAlert.dealId) && (
                      <>
                        <button
                          type="button"
                          disabled={busyAction}
                          onClick={() => void handleAlertDecision(selectedAlert, 'resume_conversation')}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                        >
                          <Play className="w-3.5 h-3.5" />
                          <span>Resume Conversation</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyAction}
                          onClick={() => void handleAlertDecision(selectedAlert, 'keep_paused')}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-400 dark:border-amber-700 text-amber-800 dark:text-amber-300 text-xs font-semibold whitespace-nowrap shrink-0"
                        >
                          <Lock className="w-3.5 h-3.5" />
                          <span>Keep Paused</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={() => void handleAlertDecision(selectedAlert, 'issue_warning')}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
                    >
                      Issue Formal Warning
                    </button>
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={() => void handleAlertDecision(selectedAlert, 'apply_strike')}
                      className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                    >
                      Record Policy Strike
                    </button>
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={() => void handleAlertDecision(selectedAlert, 'quarantine_content')}
                      className="px-3 py-1.5 rounded-lg border border-rose-300 dark:border-rose-800 text-rose-700 dark:text-rose-300 text-xs font-semibold whitespace-nowrap shrink-0"
                    >
                      Quarantine Listing/Media
                    </button>
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={() => void handleAlertDecision(selectedAlert, 'dismiss_false_positive')}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white whitespace-nowrap shrink-0"
                    >
                      Dismiss False Positive
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: USER REPORTS & GRADUATED LEVEL 1–5 ENFORCEMENT */}
      {overview && subTab === 'user_reports' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <div className="lg:col-span-5 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
              <div className="p-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-900 dark:text-white">
                  User Reports Queue ({filteredReports.length})
                </span>
                <div className="flex items-center gap-1">
                  {(['ALL', 'OPEN', 'CLOSED'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      onClick={() => setReportStatusFilter(st)}
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold whitespace-nowrap shrink-0 ${
                        reportStatusFilter === st
                          ? 'bg-slate-900 dark:bg-white text-white dark:text-slate-900'
                          : 'text-slate-500 hover:text-slate-900 dark:hover:text-white'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>

              {filteredReports.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  No user-submitted reports match the current filter.
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[480px] overflow-y-auto">
                  {filteredReports.map((rpt) => (
                    <button
                      key={rpt.id}
                      type="button"
                      onClick={() => {
                        setSelectedReportId(rpt.id);
                        populateEnforceFromUser(rpt.reportedUserId, rpt.reportedUserName);
                      }}
                      className={`w-full text-left p-3.5 space-y-1 transition-colors ${
                        selectedReport?.id === rpt.id
                          ? 'bg-emerald-50/70 dark:bg-emerald-950/25'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                          {rpt.trackingRef}
                        </span>
                        <span className="text-[11px] text-rose-600 dark:text-rose-400 font-semibold">
                          AI Triage: {rpt.aiTriagePriority}
                        </span>
                      </div>
                      <div className="text-xs font-semibold text-slate-800 dark:text-slate-200 truncate">
                        Reported: {rpt.reportedUserName} · {rpt.category.replace(/_/g, ' ')}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {formatSurfaceLabel(rpt.surface)} · Status: {rpt.status.replace(/_/g, ' ')} ·{' '}
                        {new Date(rpt.createdAtMs).toLocaleDateString()}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-7 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5">
              {!selectedReport ? (
                <div className="py-10 text-center text-xs text-slate-500 dark:text-slate-400">
                  Select a user report to inspect confidential reporter allegations, AI triage, and
                  internal investigation notes.
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-2 pb-3 border-b border-slate-200 dark:border-slate-800">
                    <div>
                      <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                        {selectedReport.trackingRef} — Against {selectedReport.reportedUserName} (
                        {selectedReport.reportedUserId})
                      </h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                        Confidential Reporter: {selectedReport.reporterName} ({selectedReport.reporterId}
                        ) · {formatSurfaceLabel(selectedReport.surface)}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        populateEnforceFromUser(
                          selectedReport.reportedUserId,
                          selectedReport.reportedUserName
                        )
                      }
                      className="px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-white text-white dark:text-slate-900 text-xs font-semibold whitespace-nowrap shrink-0"
                    >
                      Target in Enforcement Panel
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5">
                      <div className="font-bold text-slate-900 dark:text-white">
                        Reporter Allegation (Unverified Until Reviewed)
                      </div>
                      <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap break-words">
                        {selectedReport.description}
                      </p>
                      {selectedReport.quotedContent && (
                        <p className="text-[11px] text-slate-500 pt-1 border-t border-slate-200 dark:border-slate-800">
                          Quoted Context: {selectedReport.quotedContent}
                        </p>
                      )}
                    </div>

                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-3.5 space-y-1.5">
                      <div className="font-bold text-slate-900 dark:text-white">
                        Automated AI Triage & Evidence Scan
                      </div>
                      <p className="text-slate-600 dark:text-slate-300">
                        Priority: <span className="font-semibold">{selectedReport.aiTriagePriority}</span>{' '}
                        · Suggested:{' '}
                        {formatModerationCategoryLabel(selectedReport.aiSuggestedCategory)}
                      </p>
                      <p className="text-[11px] text-slate-500">{selectedReport.aiTriageSummary}</p>
                      {selectedReport.evidenceAttachmentSummaries.length > 0 && (
                        <div className="pt-1 text-[11px] text-emerald-700 dark:text-emerald-400">
                          Attachments ({selectedReport.evidenceAttachmentCount}):{' '}
                          {selectedReport.evidenceAttachmentSummaries.join(' | ')}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Internal Admin Notes */}
                  <div className="space-y-2">
                    <div className="text-xs font-bold text-slate-900 dark:text-white">
                      Internal Administrator Notes ({selectedReport.internalAdminNotes.length})
                    </div>
                    {selectedReport.internalAdminNotes.map((n) => (
                      <div
                        key={n.id}
                        className="rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs"
                      >
                        <span className="font-semibold text-slate-900 dark:text-white">
                          {n.adminEmail}:
                        </span>{' '}
                        <span className="text-slate-700 dark:text-slate-300">{n.note}</span>
                      </div>
                    ))}
                    <input
                      type="text"
                      value={reportNoteInput}
                      onChange={(e) => setReportNoteInput(e.target.value)}
                      placeholder="Write internal admin note or resolution summary for reporter..."
                      aria-label="Report note or resolution reason"
                      className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={() => void handleReportWorkflow(selectedReport, 'assign_self')}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0"
                      >
                        Assign to Me
                      </button>
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={() => void handleReportWorkflow(selectedReport, 'add_internal_note')}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0"
                      >
                        Save Internal Note
                      </button>
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={() => void handleReportWorkflow(selectedReport, 'resolve_action_taken')}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold whitespace-nowrap shrink-0"
                      >
                        Resolve (Action Taken)
                      </button>
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={() => void handleReportWorkflow(selectedReport, 'dismiss_report')}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-500 hover:text-slate-900 dark:hover:text-white whitespace-nowrap shrink-0"
                      >
                        Dismiss Unsubstantiated
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* GRADUATED LEVEL 1–5 HUMAN ADMIN ENFORCEMENT WORKBENCH */}
          <form
            onSubmit={handleSubmitEnforcement}
            className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  Graduated Level 1–5 Account Enforcement & Non-Destructive Financial Hold
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Every action writes an immutable audit log entry. Permanent bans, strike reversals, and
                  financial holds require Superadmin authority. Wallet balances are never erased.
                </p>
              </div>
              <span className="text-xs font-mono text-slate-500">
                Role: {isSuperAdmin ? 'Superadmin' : 'Moderator Admin'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="enforce-uid"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                >
                  Target User UID
                </label>
                <input
                  id="enforce-uid"
                  type="text"
                  value={enforceTargetUid}
                  onChange={(e) => setEnforceTargetUid(e.target.value)}
                  placeholder="Firebase UID"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label
                  htmlFor="enforce-name"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                >
                  Display Name (Optional)
                </label>
                <input
                  id="enforce-name"
                  type="text"
                  value={enforceTargetName}
                  onChange={(e) => setEnforceTargetName(e.target.value)}
                  placeholder="User display name"
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white"
                />
              </div>
              <div>
                <label
                  htmlFor="enforce-action-select"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                >
                  Enforcement Level / Action
                </label>
                <select
                  id="enforce-action-select"
                  value={enforceAction}
                  onChange={(e) =>
                    setEnforceAction(e.target.value as typeof enforceAction)
                  }
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white"
                >
                  <option value="add_manual_strike">Level 1: Record Formal Strike / Warning</option>
                  <option value="update_granular_restrictions">
                    Level 2: Granular Capability Restrictions
                  </option>
                  <option value="temporary_suspension">
                    Level 3: Temporary Suspension (Timed)
                  </option>
                  <option value="apply_financial_hold" disabled={!isSuperAdmin}>
                    Level 4: Apply Non-Destructive Withdrawal Hold (Superadmin)
                  </option>
                  <option value="release_financial_hold" disabled={!isSuperAdmin}>
                    Level 4B: Release Withdrawal Hold (Superadmin)
                  </option>
                  <option value="permanent_ban" disabled={!isSuperAdmin}>
                    Level 5: Permanent Account Ban (Superadmin Only)
                  </option>
                  <option value="reverse_strike" disabled={!isSuperAdmin}>
                    Restore: Reverse Specific Strike (Superadmin)
                  </option>
                  <option value="unban_restore">Restore: Lift Suspension / Restore Account</option>
                </select>
              </div>
            </div>

            {enforceAction === 'temporary_suspension' && (
              <div className="max-w-xs">
                <label
                  htmlFor="enforce-hours"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                >
                  Suspension Duration (Hours)
                </label>
                <input
                  id="enforce-hours"
                  type="number"
                  min={1}
                  max={2160}
                  value={enforceDurationHours}
                  onChange={(e) => setEnforceDurationHours(Number(e.target.value) || 24)}
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono tabular-nums text-slate-900 dark:text-white"
                />
              </div>
            )}

            {enforceAction === 'reverse_strike' && (
              <div className="max-w-md">
                <label
                  htmlFor="enforce-strike-id"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                >
                  Strike ID to Reverse
                </label>
                <input
                  id="enforce-strike-id"
                  type="text"
                  value={enforceStrikeIdToReverse}
                  onChange={(e) => setEnforceStrikeIdToReverse(e.target.value)}
                  placeholder="stk_..."
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs font-mono text-slate-900 dark:text-white"
                />
              </div>
            )}

            {enforceAction === 'update_granular_restrictions' && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 pt-1">
                {(
                  [
                    ['restrictListings', 'Block Listings'],
                    ['restrictBidding', 'Block Bidding'],
                    ['restrictPurchasing', 'Block Purchases'],
                    ['restrictPreDealChat', 'Block Pre-Deal Chat'],
                    ['restrictDealChat', 'Block Deal Chat'],
                    ['restrictReviews', 'Block Reviews'],
                    ['restrictProfileEdits', 'Block Profile Edits'],
                    ['restrictWithdrawals', 'Pause Withdrawals'],
                  ] as const
                ).map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-slate-800 dark:text-slate-200 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={granularFlags[key]}
                      onChange={(e) =>
                        setGranularFlags((prev) => ({ ...prev, [key]: e.target.checked }))
                      }
                      className="rounded border-slate-300 text-emerald-600"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-3">
              <div className="flex-1">
                <label
                  htmlFor="enforce-audit-reason"
                  className="block text-xs font-semibold text-slate-700 dark:text-slate-200 mb-1"
                >
                  Mandatory Audit Reason (min 6 chars)
                </label>
                <input
                  id="enforce-audit-reason"
                  type="text"
                  value={enforceReason}
                  onChange={(e) => setEnforceReason(e.target.value)}
                  placeholder="Document clear evidence-backed reason for the audit log and user notice..."
                  className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-xs text-slate-900 dark:text-white"
                />
              </div>
              <button
                type="submit"
                disabled={busyAction}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
              >
                Execute Enforcement Action
              </button>
            </div>

            {overview.restrictions.length > 0 && (
              <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2">
                <div className="text-xs font-bold text-slate-900 dark:text-white">
                  Currently Restricted / Suspended Accounts ({overview.restrictions.length})
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                        <th className="py-2 pr-3 font-medium">Account</th>
                        <th className="py-2 px-3 font-medium">Status</th>
                        <th className="py-2 px-3 font-medium">Strikes</th>
                        <th className="py-2 px-3 font-medium">Enforced By</th>
                        <th className="py-2 pl-3 font-medium text-right">Select</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/70">
                      {overview.restrictions.slice(0, 15).map((r) => (
                        <tr key={r.userId}>
                          <td className="py-2 pr-3 text-slate-900 dark:text-white font-medium">
                            {r.userDisplayName || r.userId}{' '}
                            <span className="font-mono text-[11px] text-slate-500">({r.userId})</span>
                          </td>
                          <td className="py-2 px-3 text-slate-700 dark:text-slate-300">
                            {r.accountStatus.replace(/_/g, ' ')}
                          </td>
                          <td className="py-2 px-3 font-mono tabular-nums text-slate-900 dark:text-white">
                            {r.activeStrikes} / 3
                          </td>
                          <td className="py-2 px-3 text-slate-500">{r.enforcedBy}</td>
                          <td className="py-2 pl-3 text-right">
                            <button
                              type="button"
                              onClick={() => populateEnforceFromUser(r.userId, r.userDisplayName)}
                              className="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline whitespace-nowrap"
                            >
                              Manage
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </form>
        </div>
      )}

      {/* TAB 3: APPEALS & IMMUTABLE AUDIT LEDGER */}
      {overview && subTab === 'appeals_ledger' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
          <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Account Appeals Queue ({overview.appeals.length})
            </h3>
            {overview.appeals.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
                No account appeals are currently waiting in queue.
              </p>
            ) : (
              <div className="space-y-3 max-h-[540px] overflow-y-auto">
                {overview.appeals.map((ap) => (
                  <div
                    key={ap.id}
                    className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-2 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                        {ap.trackingRef} · {ap.userName} ({ap.userId})
                      </span>
                      <span className="font-semibold text-slate-600 dark:text-slate-300">
                        {ap.status.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 font-mono tabular-nums">
                      Standing at Appeal: {ap.accountStatusAtSubmission} · Strikes:{' '}
                      {ap.activeStrikesAtSubmission}
                    </p>
                    <p className="text-slate-700 dark:text-slate-200 whitespace-pre-wrap">
                      {ap.explanation}
                    </p>
                    {ap.supportingContext && (
                      <p className="text-[11px] text-slate-500">Context: {ap.supportingContext}</p>
                    )}

                    {ap.status === 'pending' || ap.status === 'under_review' || ap.status === 'info_requested' ? (
                      <div className="space-y-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                        <input
                          type="text"
                          value={appealDecisionNotes[ap.id] || ''}
                          onChange={(e) =>
                            setAppealDecisionNotes((prev) => ({ ...prev, [ap.id]: e.target.value }))
                          }
                          placeholder="Decision explanation sent to user (min 6 chars)..."
                          aria-label={`Decision note for ${ap.trackingRef}`}
                          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs text-slate-900 dark:text-white"
                        />
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            disabled={busyAction}
                            onClick={() => void handleAppealDecision(ap, 'accept_restore')}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold whitespace-nowrap shrink-0"
                          >
                            <Unlock className="w-3.5 h-3.5" />
                            <span>Accept & Restore</span>
                          </button>
                          {isSuperAdmin && (
                            <button
                              type="button"
                              disabled={busyAction}
                              onClick={() =>
                                void handleAppealDecision(ap, 'accept_reverse_strike_and_restore')
                              }
                              className="px-3 py-1.5 rounded-lg border border-emerald-400 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 font-semibold whitespace-nowrap shrink-0"
                            >
                              Reverse Latest Strike & Restore
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={busyAction}
                            onClick={() => void handleAppealDecision(ap, 'request_info')}
                            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 font-semibold whitespace-nowrap shrink-0"
                          >
                            Request More Info
                          </button>
                          <button
                            type="button"
                            disabled={busyAction}
                            onClick={() => void handleAppealDecision(ap, 'reject')}
                            className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold whitespace-nowrap shrink-0"
                          >
                            Reject Appeal
                          </button>
                        </div>
                      </div>
                    ) : (
                      ap.adminDecisionNote && (
                        <p className="text-emerald-700 dark:text-emerald-400 pt-1 border-t border-slate-200 dark:border-slate-800">
                          Decision ({ap.reviewedByAdminEmail}): {ap.adminDecisionNote}
                        </p>
                      )
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="lg:col-span-6 rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-3">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Immutable Trust & Safety Audit Trail ({overview.auditLogs.length})
            </h3>
            {overview.auditLogs.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 py-6 text-center">
                No moderation audit actions recorded yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
                {overview.auditLogs.map((log) => (
                  <div key={log.id} className="py-2.5 space-y-0.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white">
                        {log.actionType.replace(/_/g, ' ')}
                      </span>
                      <span className="text-[11px] font-mono tabular-nums text-slate-500">
                        {new Date(log.createdAtMs).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Actor: {log.actorEmail || log.actorType} · Target:{' '}
                      {log.targetUserName || log.targetUserId}
                    </div>
                    <p className="text-slate-600 dark:text-slate-300">{log.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: DYNAMIC POLICY SETTINGS */}
      {overview && policyDraft && subTab === 'policy_settings' && (
        <form
          onSubmit={handleSavePolicy}
          className="rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4"
        >
          <div>
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Dynamic Moderation Policy & Strike Thresholds
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Configure real-time confidence thresholds, rate limits, and automated protective
              warning templates without redeploying code.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 text-xs">
            {(
              [
                ['strictProfanityBlocking', 'Block Multilingual Profanity & Slurs'],
                ['blockOffPlatformScamLures', 'Block Off-Platform Escrow Bypass Lures'],
                ['autoPauseSuspiciousChats', 'Auto-Pause High-Risk Coercive Chats (Level B)'],
                ['requireMediaAiVerification', 'Require Multimodal OCR & Vision Scan on Media'],
                ['failSafeQuarantineUncertainMedia', 'Quarantine Uncertain Media When AI Unavailable'],
              ] as const
            ).map(([field, label]) => (
              <label
                key={field}
                className="flex items-center gap-2.5 rounded-xl border border-slate-200 dark:border-slate-800 p-3 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={policyDraft[field]}
                  onChange={(e) =>
                    setPolicyDraft((prev) => (prev ? { ...prev, [field]: e.target.checked } : prev))
                  }
                  className="rounded border-slate-300 text-emerald-600"
                />
                <span className="font-medium text-slate-800 dark:text-slate-200">{label}</span>
              </label>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
            <div>
              <label
                htmlFor="policy-level-a"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Level A Confidence (0.60–0.99)
              </label>
              <input
                id="policy-level-a"
                type="number"
                step="0.05"
                min="0.6"
                max="0.99"
                value={policyDraft.levelAConfidenceThreshold}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev
                      ? { ...prev, levelAConfidenceThreshold: Number(e.target.value) || 0.85 }
                      : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono tabular-nums text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="policy-max-strikes"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Strikes Before Protective Hold
              </label>
              <input
                id="policy-max-strikes"
                type="number"
                min={2}
                max={5}
                value={policyDraft.maxStrikesBeforeProtectiveSuspension}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev
                      ? {
                          ...prev,
                          maxStrikesBeforeProtectiveSuspension: Number(e.target.value) || 3,
                        }
                      : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono tabular-nums text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="policy-report-limit"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Max Reports / Hour / User
              </label>
              <input
                id="policy-report-limit"
                type="number"
                min={2}
                max={30}
                value={policyDraft.reportRateLimitPerHour}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, reportRateLimitPerHour: Number(e.target.value) || 6 } : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono tabular-nums text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="policy-appeal-cooldown"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Appeal Cooldown (Hours)
              </label>
              <input
                id="policy-appeal-cooldown"
                type="number"
                min={1}
                max={168}
                value={policyDraft.appealCooldownHours}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, appealCooldownHours: Number(e.target.value) || 12 } : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 font-mono tabular-nums text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
            <div>
              <label
                htmlFor="tpl-strike-1"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Strike 1 Warning Template
              </label>
              <textarea
                id="tpl-strike-1"
                rows={3}
                value={policyDraft.firstWarningTemplate}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, firstWarningTemplate: e.target.value } : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="tpl-strike-2"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Strike 2 Final Warning Template
              </label>
              <textarea
                id="tpl-strike-2"
                rows={3}
                value={policyDraft.finalWarningTemplate}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, finalWarningTemplate: e.target.value } : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white"
              />
            </div>
            <div>
              <label
                htmlFor="tpl-strike-3"
                className="block font-semibold text-slate-700 dark:text-slate-200 mb-1"
              >
                Strike 3 Protective Suspension Template
              </label>
              <textarea
                id="tpl-strike-3"
                rows={3}
                value={policyDraft.protectiveSuspensionTemplate}
                onChange={(e) =>
                  setPolicyDraft((prev) =>
                    prev ? { ...prev, protectiveSuspensionTemplate: e.target.value } : prev
                  )
                }
                className="w-full rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-slate-900 dark:text-white"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={busyAction}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              {busyAction ? 'Saving Settings...' : 'Save Moderation Policy'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
