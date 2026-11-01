import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Archive,
  Bot,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Download,
  ExternalLink,
  FileSearch,
  History,
  Layers,
  Loader2,
  Menu,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { auth, db } from '../lib/firebase';
import { evaluateProposalGovernanceGate } from '../lib/aiAuditLogic';
import {
  AiProposalRecord,
  AuditLogRecord,
  DealRecord,
  MarketplaceListing,
  PublicSettings,
} from '../types';
import {
  ActiveAuditRunStatus,
  AiAdminRuntimeOverview,
  AiChatMessageRecord,
  AiConversationRecord,
  AiEvidenceMode,
  AuditIssueRecord,
  DailyAuditScheduleConfig,
  WebsiteAuditReport,
} from '../types/aiAdmin';

type WorkspaceMode = 'chat' | 'reports' | 'issues' | 'governance';

interface StagedProposalServerItem {
  id: string;
  title: string;
  category: 'bugfix' | 'security' | 'feature' | 'performance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  affectedFiles: string[];
  proposedDiff: string;
  status: 'awaiting_review' | 'in_review' | 'approved' | 'rejected' | 'deployed';
  linkedIssueId?: string;
  syncedToFirestore?: boolean;
}

interface OverviewApiResponse extends AiAdminRuntimeOverview {
  conversations: AiConversationRecord[];
  serverStagedProposals: StagedProposalServerItem[];
}

export interface AdminAiAssistantWorkspaceProps {
  adminUid: string;
  settings: PublicSettings;
  proposals: AiProposalRecord[];
  auditLogs: AuditLogRecord[];
  allListings: MarketplaceListing[];
  deals: DealRecord[];
  reportedDealsCount: number;
  healthSnapshot: Record<string, unknown> | null;
  enablingCloudService: 'token_service' | 'fcm_apis' | null;
  downloadingInfinityZip: boolean;
  onToggleEmergencyStop: () => Promise<void>;
  onRefreshSystemHealth: () => Promise<void>;
  onEnableCloudService: (target: 'token_service' | 'fcm_apis') => Promise<void>;
  onDownloadInfinityZip: () => Promise<void>;
  onExportJsonBackup: () => void;
  onWriteAuditLog: (
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    details: string
  ) => Promise<void>;
  onFlash: (message: string) => void;
  firebaseAuthProvidersUrl: string;
  firebaseAuthDomainsUrl: string;
  tokenServiceActivationUrl: string;
}

const COMMON_TIMEZONES = [
  'Asia/Dhaka',
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
];

const QUICK_STARTER_PROMPTS = [
  {
    label: 'Summarize Website Health',
    prompt:
      'Inspect our current system overview and latest audit report, then give me a clear executive summary of what is healthy, what needs attention, and why.',
  },
  {
    label: 'Audit Escrow & Security Rules',
    prompt:
      'Inspect firestore.rules and src/lib/marketplaceLogic.ts to verify our 3-Party Deal Room timer immutability, 102%/3% dispute refund math, and PII isolation. Cite verified file evidence.',
  },
  {
    label: 'Run Automated Test Suite',
    prompt:
      'Run our automated unit and Firestore security rules test suite right now and explain the exact results.',
  },
  {
    label: 'Recommend Marketplace Features',
    prompt:
      'Based on BEXORA’s actual codebase and workflows, propose 3 high-impact, safe feature improvements with beneficiaries, affected files, risks, complexity, verification plan, and whether to implement now or defer.',
  },
];

function renderDiffLines(diffText: string) {
  const lines = String(diffText || '').split('\n');
  return lines.map((line, i) => {
    let lineCls = 'text-[var(--text-2)]';
    if (line.startsWith('+++') || line.startsWith('---')) {
      lineCls = 'font-bold text-[var(--text)]';
    } else if (line.startsWith('@@')) {
      lineCls = 'text-sky-600 dark:text-sky-400 font-bold';
    } else if (line.startsWith('+')) {
      lineCls = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    } else if (line.startsWith('-')) {
      lineCls = 'bg-red-500/10 text-red-700 dark:text-red-300';
    }
    return (
      <div key={i} className={`px-2 py-0.5 whitespace-pre font-mono text-[11px] leading-relaxed ${lineCls}`}>
        {line || ' '}
      </div>
    );
  });
}

function EvidenceBadge({ mode }: { mode: AiEvidenceMode }) {
  if (mode === 'live_tool_inspection') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider border border-emerald-600/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">
        <FileSearch className="w-3 h-3 shrink-0" />
        Live Code &amp; Tool Evidence
      </span>
    );
  }
  if (mode === 'verified_project_evidence') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider border border-sky-600/40 bg-sky-500/10 text-sky-700 dark:text-sky-300">
        <ShieldCheck className="w-3 h-3 shrink-0" />
        Verified Project Evidence
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider border border-amber-600/40 bg-amber-500/10 text-amber-700 dark:text-amber-300">
      <Sparkles className="w-3 h-3 shrink-0" />
      General Engineering Reasoning
    </span>
  );
}

export const AdminAiAssistantWorkspace: React.FC<AdminAiAssistantWorkspaceProps> = ({
  adminUid,
  settings,
  proposals,
  auditLogs,
  allListings,
  deals,
  reportedDealsCount,
  healthSnapshot,
  enablingCloudService,
  downloadingInfinityZip,
  onToggleEmergencyStop,
  onRefreshSystemHealth,
  onEnableCloudService,
  onDownloadInfinityZip,
  onExportJsonBackup,
  onWriteAuditLog,
  onFlash,
  firebaseAuthProvidersUrl,
  firebaseAuthDomainsUrl,
  tokenServiceActivationUrl,
}) => {
  const [mode, setMode] = useState<WorkspaceMode>('chat');
  const [mobileRailOpen, setMobileRailOpen] = useState(false);

  const [overview, setOverview] = useState<OverviewApiResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  // Conversations & Chat state
  const [conversations, setConversations] = useState<AiConversationRecord[]>([]);
  const [convSearch, setConvSearch] = useState('');
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiChatMessageRecord[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [composerText, setComposerText] = useState('');
  const [sendingChat, setSendingChat] = useState(false);
  const [chatError, setChatError] = useState<{ message: string; retryText: string } | null>(null);
  const [expandedToolMsgIds, setExpandedToolMsgIds] = useState<Record<string, boolean>>({});
  const [pinnedContext, setPinnedContext] = useState<{
    label: string;
    reportId?: string;
    issueId?: string;
    proposalId?: string;
  } | null>(null);

  // Audit & Reports state
  const [activeAudit, setActiveAudit] = useState<ActiveAuditRunStatus | null>(null);
  const [triggeringAudit, setTriggeringAudit] = useState(false);
  const [selectedReport, setSelectedReport] = useState<WebsiteAuditReport | null>(null);
  const [loadingReportId, setLoadingReportId] = useState<string | null>(null);

  // Daily Schedule Form state
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [schedHour, setSchedHour] = useState(9);
  const [schedMinute, setSchedMinute] = useState(0);
  const [schedTimezone, setSchedTimezone] = useState('Asia/Dhaka');
  const [schedNotifyInApp, setSchedNotifyInApp] = useState(true);
  const [schedNotifyTelegram, setSchedNotifyTelegram] = useState(false);
  const [schedNotifyEmail, setSchedNotifyEmail] = useState(false);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Issues & Proposals UI state
  const [issueFilter, setIssueFilter] = useState<'open' | 'fixed' | 'all'>('open');
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(null);
  const [showManualStageForm, setShowManualStageForm] = useState(false);
  const [manualTitle, setManualTitle] = useState('');
  const [manualCategory, setManualCategory] = useState<'bugfix' | 'security' | 'feature' | 'performance'>('bugfix');
  const [manualSeverity, setManualSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [manualFiles, setManualFiles] = useState('src/App.tsx');
  const [manualSummary, setManualSummary] = useState('');
  const [manualDiff, setManualDiff] = useState('--- a/src/App.tsx\n+++ b/src/App.tsx\n@@ -1,3 +1,4 @@\n+// Staged change preview for human review');
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const syncedServerPropIdsRef = useRef<Set<string>>(new Set());

  const getAdminBearerHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const token = auth.currentUser ? await auth.currentUser.getIdToken() : '';
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }, []);

  const syncServerStagedProposalsToFirestore = useCallback(
    async (items: StagedProposalServerItem[]) => {
      if (settings.aiEmergencyStop || !items || items.length === 0) return;
      for (const item of items) {
        if (item.syncedToFirestore || syncedServerPropIdsRef.current.has(item.id)) continue;
        syncedServerPropIdsRef.current.add(item.id);
        try {
          await addDoc(collection(db, 'aiProposals'), {
            title: item.title.slice(0, 140),
            category: item.category,
            severity: item.severity,
            summary: item.summary.slice(0, 2000),
            affectedFiles: item.affectedFiles.slice(0, 20),
            proposedDiff: item.proposedDiff.slice(0, 8000),
            status: 'awaiting_review',
            ...(item.linkedIssueId ? { linkedIssueId: item.linkedIssueId.slice(0, 80) } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          const headers = await getAdminBearerHeaders();
          await fetch(`/api/admin/ai/proposals/${encodeURIComponent(item.id)}/mark-synced`, {
            method: 'POST',
            headers,
          }).catch(() => {});
        } catch {
          syncedServerPropIdsRef.current.delete(item.id);
        }
      }
    },
    [getAdminBearerHeaders, settings.aiEmergencyStop]
  );

  const applyScheduleToForm = useCallback((sched: DailyAuditScheduleConfig) => {
    setSchedEnabled(sched.enabled);
    setSchedHour(sched.hour);
    setSchedMinute(sched.minute);
    setSchedTimezone(sched.timezone || 'Asia/Dhaka');
    setSchedNotifyInApp(sched.notifyInApp);
    setSchedNotifyTelegram(sched.notifyTelegram);
    setSchedNotifyEmail(sched.notifyEmail);
  }, []);

  const fetchOverview = useCallback(
    async (silent = false) => {
      if (!silent) setLoadingOverview(true);
      setOverviewError(null);
      try {
        const headers = await getAdminBearerHeaders();
        const res = await fetch('/api/admin/ai/overview', { headers });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(errJson.error || `Failed to load AI Workspace (${res.status}).`);
        }
        const data = (await res.json()) as OverviewApiResponse;
        setOverview(data);
        setConversations(data.conversations || []);
        setActiveAudit(data.activeAudit);
        if (data.latestReport && !selectedReport) {
          setSelectedReport(data.latestReport);
        } else if (
          data.latestReport &&
          selectedReport &&
          data.latestReport.reportId !== selectedReport.reportId &&
          silent
        ) {
          setSelectedReport(data.latestReport);
        }
        if (!silent) {
          applyScheduleToForm(data.schedule);
        }
        void syncServerStagedProposalsToFirestore(data.serverStagedProposals || []);
      } catch (err) {
        setOverviewError(
          err instanceof Error ? err.message : 'Unable to reach AI Admin server endpoints.'
        );
      } finally {
        if (!silent) setLoadingOverview(false);
      }
    },
    [applyScheduleToForm, getAdminBearerHeaders, selectedReport, syncServerStagedProposalsToFirestore]
  );

  useEffect(() => {
    void fetchOverview(false);
  }, [fetchOverview]);

  // Poll live step-by-step progress while an audit is actively running
  useEffect(() => {
    if (!activeAudit?.running) return;
    const timer = window.setInterval(async () => {
      try {
        const headers = await getAdminBearerHeaders();
        const res = await fetch('/api/admin/ai/audit/status', { headers });
        if (!res.ok) return;
        const status = (await res.json()) as ActiveAuditRunStatus;
        setActiveAudit(status);
        if (!status.running) {
          void fetchOverview(true);
        }
      } catch {
        // Ignore transient poll error
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [activeAudit?.running, fetchOverview, getAdminBearerHeaders]);

  // Auto-scroll chat to newest message
  useEffect(() => {
    if (mode === 'chat') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [messages.length, sendingChat, mode]);

  const handleSelectConversation = async (convId: string) => {
    setActiveConvId(convId);
    setMode('chat');
    setMobileRailOpen(false);
    setChatError(null);
    setLoadingMessages(true);
    try {
      const headers = await getAdminBearerHeaders();
      const res = await fetch(`/api/admin/ai/conversations/${encodeURIComponent(convId)}`, {
        headers,
      });
      if (!res.ok) throw new Error('Could not load conversation messages.');
      const data = (await res.json()) as { messages?: AiChatMessageRecord[] };
      setMessages(data.messages || []);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to load conversation.');
    } finally {
      setLoadingMessages(false);
    }
  };

  const handleStartNewChat = () => {
    setActiveConvId(null);
    setMessages([]);
    setChatError(null);
    setPinnedContext(null);
    setMode('chat');
    setMobileRailOpen(false);
  };

  const handleDeleteConversation = async (convId: string) => {
    try {
      const headers = await getAdminBearerHeaders();
      const res = await fetch(`/api/admin/ai/conversations/${encodeURIComponent(convId)}`, {
        method: 'DELETE',
        headers,
      });
      if (res.ok) {
        setConversations((prev) => prev.filter((c) => c.id !== convId));
        if (activeConvId === convId) {
          setActiveConvId(null);
          setMessages([]);
        }
      }
    } catch {
      onFlash('Could not delete conversation.');
    }
  };

  const sendChatMessage = async (rawMessageText: string) => {
    const cleanText = rawMessageText.trim();
    if (!cleanText || sendingChat) return;

    setChatError(null);
    setSendingChat(true);
    setComposerText('');
    setMode('chat');

    const optimisticUserMsg: AiChatMessageRecord = {
      id: `temp_u_${Date.now()}`,
      conversationId: activeConvId || 'pending',
      role: 'admin',
      content: cleanText,
      evidenceMode: 'verified_project_evidence',
      createdAtMs: Date.now(),
    };
    setMessages((prev) => [...prev, optimisticUserMsg]);

    try {
      const headers = await getAdminBearerHeaders();
      const res = await fetch('/api/admin/ai/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversationId: activeConvId || undefined,
          message: cleanText,
          pinnedContext: pinnedContext
            ? {
                reportId: pinnedContext.reportId,
                issueId: pinnedContext.issueId,
                proposalId: pinnedContext.proposalId,
              }
            : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        conversation?: AiConversationRecord;
        messages?: AiChatMessageRecord[];
        stagedProposal?: StagedProposalServerItem;
      };
      if (!res.ok || !data.conversation || !data.messages) {
        throw new Error(data.error || `Assistant request failed (${res.status}).`);
      }

      setActiveConvId(data.conversation.id);
      setMessages(data.messages);
      setConversations((prev) => {
        const filtered = prev.filter((c) => c.id !== data.conversation!.id);
        return [data.conversation!, ...filtered];
      });

      if (data.stagedProposal) {
        await syncServerStagedProposalsToFirestore([data.stagedProposal]);
        onFlash(
          `Assistant staged proposal "${data.stagedProposal.title}" into Approvals Queue (awaiting human review).`
        );
      }
    } catch (err) {
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUserMsg.id));
      setChatError({
        message: err instanceof Error ? err.message : 'Network error communicating with AI Assistant.',
        retryText: cleanText,
      });
    } finally {
      setSendingChat(false);
    }
  };

  const handleComposerSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendChatMessage(composerText);
  };

  const handleRunCheckNowAudit = async () => {
    if (triggeringAudit || activeAudit?.running) return;
    setTriggeringAudit(true);
    // Immediately switch to show progress banner and poll status
    setActiveAudit({
      running: true,
      runId: 'starting',
      trigger: 'manual',
      startedAtMs: Date.now(),
      currentStepLabel: '1. Codebase, Route & Bundle Integrity',
      completedSteps: 0,
      totalSteps: 7,
      steps: [],
    });

    try {
      const headers = await getAdminBearerHeaders();
      const res = await fetch('/api/admin/ai/audit/run', {
        method: 'POST',
        headers,
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        alreadyRunning?: boolean;
        report?: WebsiteAuditReport;
        activeAudit?: ActiveAuditRunStatus;
      };
      if (!res.ok) {
        throw new Error(data.error || `Audit failed (${res.status}).`);
      }
      if (data.activeAudit) {
        setActiveAudit(data.activeAudit);
      }
      if (data.alreadyRunning) {
        onFlash('An audit is already in progress — tracking live progress.');
      } else if (data.report) {
        setSelectedReport(data.report);
        setMode('reports');
        await onWriteAuditLog(
          adminUid,
          'run_website_audit',
          'aiAuditReport',
          data.report.reportId,
          `Manual Check Now audit completed (${data.report.overallStatus}, ${data.report.issues.length} findings).`
        );
        onFlash(
          `Website Audit completed in ${(data.report.durationMs / 1000).toFixed(1)}s — Status: ${data.report.overallStatus.replace(/_/g, ' ').toUpperCase()}.`
        );
        await fetchOverview(true);
      }
    } catch (err) {
      setActiveAudit((prev) => (prev ? { ...prev, running: false } : null));
      onFlash(err instanceof Error ? err.message : 'Could not complete Check Now audit.');
    } finally {
      setTriggeringAudit(false);
    }
  };

  const handleSelectReportById = async (reportId: string) => {
    if (selectedReport?.reportId === reportId) return;
    setLoadingReportId(reportId);
    try {
      const headers = await getAdminBearerHeaders();
      const res = await fetch(`/api/admin/ai/reports/${encodeURIComponent(reportId)}`, {
        headers,
      });
      if (!res.ok) throw new Error('Could not load historical report.');
      const data = (await res.json()) as { report: WebsiteAuditReport };
      setSelectedReport(data.report);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to load report.');
    } finally {
      setLoadingReportId(null);
    }
  };

  const handleSaveDailySchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingSchedule(true);
    try {
      const headers = await getAdminBearerHeaders();
      const res = await fetch('/api/admin/ai/schedule', {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          enabled: schedEnabled,
          hour: schedHour,
          minute: schedMinute,
          timezone: schedTimezone.trim() || 'Asia/Dhaka',
          notifyInApp: schedNotifyInApp,
          notifyTelegram: schedNotifyTelegram,
          notifyEmail: schedNotifyEmail,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        schedule?: DailyAuditScheduleConfig;
        nextScheduledRunFormatted?: string;
      };
      if (!res.ok || !data.schedule) {
        throw new Error(data.error || 'Failed to save daily schedule.');
      }

      // Also mirror dailySchedule document to Firestore /aiSystemConfig/dailySchedule for auditability
      try {
        const { setDoc } = await import('firebase/firestore');
        await setDoc(doc(db, 'aiSystemConfig', 'dailySchedule'), {
          enabled: data.schedule.enabled,
          hour: data.schedule.hour,
          minute: data.schedule.minute,
          timezone: data.schedule.timezone,
          notifyInApp: data.schedule.notifyInApp,
          notifyTelegram: data.schedule.notifyTelegram,
          notifyEmail: data.schedule.notifyEmail,
          updatedBy: adminUid,
          updatedAt: serverTimestamp(),
        });
      } catch {
        // Server state already persisted reliably
      }

      await onWriteAuditLog(
        adminUid,
        'update_ai_daily_schedule',
        'aiSystemConfig',
        'dailySchedule',
        `Daily audit schedule: enabled=${data.schedule.enabled}, ${String(data.schedule.hour).padStart(2, '0')}:${String(data.schedule.minute).padStart(2, '0')} ${data.schedule.timezone}`
      );
      await fetchOverview(true);
      onFlash(`Daily Audit Schedule saved — Next run: ${data.nextScheduledRunFormatted || 'Updated'}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Could not update schedule.');
    } finally {
      setSavingSchedule(false);
    }
  };

  const handleDiscussIssueInChat = (issue: AuditIssueRecord) => {
    setPinnedContext({
      label: `${issue.issueId}: ${issue.title}`,
      issueId: issue.issueId,
      reportId: selectedReport?.reportId,
    });
    setMode('chat');
    setComposerText(
      `Investigate issue ${issue.issueId} ("${issue.title}") in ${issue.affectedTarget}. Inspect the actual source code, explain the root cause and side effects, and if appropriate stage a safe unified diff proposal for my review.`
    );
  };

  const handleDiscussReportInChat = (report: WebsiteAuditReport) => {
    setPinnedContext({
      label: `Audit Report ${report.dateKey} (${report.reportId})`,
      reportId: report.reportId,
    });
    setMode('chat');
    setComposerText(
      `Walk me through Audit Report ${report.reportId} (${report.dateKey}), compare it against the previous report, and highlight what actions I should prioritize.`
    );
  };

  const handleProposalHumanDecision = async (
    prop: AiProposalRecord,
    nextStatus: 'in_review' | 'approved' | 'rejected'
  ) => {
    const actionMap = {
      approved: 'approve_proposal',
      rejected: 'reject_proposal',
      in_review: 'mark_in_review',
    } as const;

    const gate = evaluateProposalGovernanceGate({
      action: actionMap[nextStatus],
      actorType: 'human_admin',
      actorUid: adminUid,
      emergencyStopActive: settings.aiEmergencyStop,
      targetProposalId: prop.id,
      confirmedProposalId: prop.id,
      currentProposalStatus: prop.status,
    });

    if (!gate.allowed) {
      onFlash(gate.reason);
      return;
    }

    setBusyProposalId(prop.id);
    try {
      await updateDoc(doc(db, 'aiProposals', prop.id), {
        status: nextStatus,
        decidedBy: adminUid,
        updatedAt: serverTimestamp(),
      });
      await onWriteAuditLog(
        adminUid,
        `proposal_${nextStatus}`,
        'aiProposal',
        prop.id,
        `Human admin marked proposal "${prop.title}" (${prop.id}) as ${nextStatus}`
      );
      onFlash(`Proposal "${prop.title}" marked as ${nextStatus.replace('_', ' ').toUpperCase()}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to update proposal decision.');
    } finally {
      setBusyProposalId(null);
    }
  };

  const handleManualProposalSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const gate = evaluateProposalGovernanceGate({
      action: 'stage_proposal',
      actorType: 'human_admin',
      actorUid: adminUid,
      emergencyStopActive: settings.aiEmergencyStop,
    });
    if (!gate.allowed) {
      onFlash(gate.reason);
      return;
    }
    if (manualTitle.trim().length < 3) {
      onFlash('Proposal title must be at least 3 characters.');
      return;
    }
    try {
      await addDoc(collection(db, 'aiProposals'), {
        title: manualTitle.trim().slice(0, 140),
        category: manualCategory,
        severity: manualSeverity,
        summary: (manualSummary.trim() || 'Staged manually for administrator diff review.').slice(0, 2000),
        affectedFiles: manualFiles
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20),
        proposedDiff: manualDiff.slice(0, 8000),
        status: 'awaiting_review',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await onWriteAuditLog(
        adminUid,
        'stage_ai_proposal',
        'aiProposal',
        manualTitle.trim(),
        'Created staged diff proposal in Governance Queue'
      );
      setManualTitle('');
      setManualSummary('');
      setShowManualStageForm(false);
      onFlash('Proposal staged in Approval Queue (Awaiting Human Review).');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to stage proposal.');
    }
  };

  const filteredConversations = useMemo(() => {
    const q = convSearch.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.lastMessagePreview.toLowerCase().includes(q)
    );
  }, [conversations, convSearch]);

  const trackedIssues = overview?.trackedIssues || selectedReport?.issues || [];
  const filteredIssues = useMemo(() => {
    if (issueFilter === 'open') {
      return trackedIssues.filter((i) => i.lifecycleState !== 'fixed_verified');
    }
    if (issueFilter === 'fixed') {
      return trackedIssues.filter((i) => i.lifecycleState === 'fixed_verified');
    }
    return trackedIssues;
  }, [trackedIssues, issueFilter]);

  const awaitingProposalsCount = proposals.filter((p) => p.status === 'awaiting_review').length;
  const openIssuesCount = trackedIssues.filter((i) => i.lifecycleState !== 'fixed_verified').length;
  const selectedProposal =
    proposals.find((p) => p.id === selectedProposalId) || proposals[0] || null;

  const isAuditBusy = Boolean(triggeringAudit || activeAudit?.running);

  return (
    <div className="space-y-4" data-testid="admin-ai-unified-workspace">
      {/* TOP COMMAND HEADER */}
      <div className="bx-card p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1.5 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 text-[11px] font-black uppercase tracking-wider bg-[#191919] text-white dark:bg-white dark:text-[#191919]">
              <Bot className="w-3.5 h-3.5 text-[#FF6500]" />
              Unified AI Assistant &amp; Auditor
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              <span
                className={`w-2 h-2 rounded-full ${
                  overview?.aiProviderConfigured !== false ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              {overview?.aiProviderConfigured !== false
                ? 'Gemini 3.8 Flash (Server-Only)'
                : 'Deterministic Mode'}
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono tabular-nums border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              <CalendarClock className="w-3 h-3 text-[#FF6500] shrink-0" />
              Daily: {overview?.nextScheduledRunFormatted || '09:00 Asia/Dhaka'}
            </span>
          </div>
          <h1 className="text-lg sm:text-xl font-black tracking-tight">
            BEXORA Conversational Engineer, Autonomous Audit &amp; Safe Improvement System
          </h1>
          <p className="text-xs text-[var(--text-2)]">
            Ask questions naturally, inspect live source code &amp; security rules, run full website audits, review daily Asia/Dhaka reports, and approve or reject specific code diffs.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleRunCheckNowAudit()}
            disabled={isAuditBusy}
            className="bx-btn bx-btn-primary px-4 py-2.5 text-xs font-black whitespace-nowrap shrink-0 inline-flex items-center gap-2"
          >
            {isAuditBusy ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                Audit Running ({activeAudit?.completedSteps ?? 0}/{activeAudit?.totalSteps ?? 7})…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 shrink-0" />
                Check Now
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => void onToggleEmergencyStop()}
            className={`px-3.5 py-2.5 text-xs font-black border-2 border-[#191919] whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 transition-colors ${
              settings.aiEmergencyStop
                ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                : 'bg-red-600 text-white hover:bg-red-700'
            }`}
          >
            <AlertOctagon className="w-4 h-4 shrink-0" />
            {settings.aiEmergencyStop ? 'Clear Emergency Stop' : 'Emergency Stop'}
          </button>
        </div>
      </div>

      {/* EMERGENCY STOP ACTIVE DISCLOSURE BANNER */}
      {settings.aiEmergencyStop && (
        <div
          role="status"
          className="p-3.5 border-2 border-red-600 bg-red-500/10 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs"
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-black uppercase text-red-700 dark:text-red-300">
                Emergency Stop Active — Protected Mutations Halted:
              </span>{' '}
              Staging new AI diffs and approving proposals are strictly blocked. Safe read-only conversation, code inspection, and <strong>Check Now</strong> website audits remain available.
            </div>
          </div>
        </div>
      )}

      {/* LIVE STEP-BY-STEP AUDIT PROGRESS PANEL */}
      {activeAudit?.running && (
        <div
          role="region"
          aria-label="Live Website Audit Progress"
          className="bx-card p-4 space-y-3 border-2 border-[#FF6500]"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-black">
              <Loader2 className="w-4 h-4 text-[#FF6500] animate-spin shrink-0" />
              <span>
                Running Comprehensive Website Audit ({activeAudit.completedSteps}/{activeAudit.totalSteps} stages completed)
              </span>
            </div>
            <span className="text-[11px] font-mono tabular-nums text-[var(--text-2)]">
              Current: {activeAudit.currentStepLabel}
            </span>
          </div>
          {activeAudit.steps.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              {activeAudit.steps.map((st) => (
                <div
                  key={st.stepId}
                  className={`p-2.5 border text-[11px] space-y-1 ${
                    st.status === 'running'
                      ? 'border-[#FF6500] bg-[#FF6500]/10 font-bold'
                      : st.status === 'completed'
                      ? 'border-emerald-600/40 bg-emerald-500/5'
                      : st.status === 'warning' || st.status === 'failed'
                      ? 'border-amber-600/40 bg-amber-500/5'
                      : 'border-[var(--bx-border)] bg-[var(--bx-surface-alt)] opacity-75'
                  }`}
                >
                  <div className="flex items-center justify-between gap-1 font-extrabold">
                    <span className="truncate">{st.label}</span>
                    <span className="uppercase text-[9px] font-mono shrink-0">{st.status}</span>
                  </div>
                  <p className="text-[10px] text-[var(--text-2)] line-clamp-2">{st.summary}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {overviewError && (
        <div className="p-3.5 border border-amber-600 bg-amber-500/10 flex items-center justify-between gap-3 text-xs">
          <span>{overviewError}</span>
          <button
            type="button"
            onClick={() => void fetchOverview(false)}
            className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold whitespace-nowrap shrink-0"
          >
            Retry Connection
          </button>
        </div>
      )}

      {/* MOBILE NAVIGATION BAR */}
      <div className="flex lg:hidden items-center justify-between gap-2 bx-card p-2.5">
        <button
          type="button"
          onClick={() => setMobileRailOpen((v) => !v)}
          aria-expanded={mobileRailOpen}
          aria-label="Toggle Conversations and Workspace Menu"
          className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
        >
          <Menu className="w-4 h-4" />
          Threads ({conversations.length})
        </button>

        <div className="flex items-center gap-1 overflow-x-auto">
          {(
            [
              { id: 'chat', label: 'Chat' },
              { id: 'reports', label: 'Audits' },
              { id: 'issues', label: `Issues (${openIssuesCount})` },
              { id: 'governance', label: `Queue (${awaitingProposalsCount})` },
            ] as { id: WorkspaceMode; label: string }[]
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setMode(tab.id)}
              className={`px-2.5 py-1.5 text-[11px] font-extrabold border whitespace-nowrap shrink-0 ${
                mode === tab.id
                  ? 'bg-[#FF6500] text-white border-[#191919]'
                  : 'bg-[var(--bx-surface)] border-[var(--bx-border)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* UNIFIED 2-PANE ASSISTANT WORKSPACE */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* LEFT RAIL: CONVERSATION THREADS & CONTEXT VIEWS */}
        <aside
          aria-label="Assistant Conversations and Context Views"
          className={`lg:col-span-3 bx-card p-3.5 space-y-4 ${
            mobileRailOpen ? 'block' : 'hidden lg:block'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={handleStartNewChat}
              className="bx-btn bx-btn-primary flex-1 py-2 px-3 text-xs font-black inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
            >
              <Plus className="w-4 h-4 shrink-0" />
              New Chat
            </button>
            <button
              type="button"
              onClick={() => void fetchOverview(false)}
              aria-label="Refresh AI Workspace State"
              className="bx-btn bx-btn-ghost p-2 shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingOverview ? 'animate-spin' : ''}`} />
            </button>
          </div>

          {/* Primary Context Switchers */}
          <nav aria-label="AI Assistant Workspace Views" className="space-y-1">
            {(
              [
                {
                  id: 'chat',
                  label: 'Assistant Conversation',
                  icon: MessageSquare,
                  badge: activeConvId ? 'Active' : null,
                },
                {
                  id: 'reports',
                  label: 'Audits & Daily Schedule',
                  icon: Activity,
                  badge: overview?.recentReports?.length ? String(overview.recentReports.length) : null,
                },
                {
                  id: 'issues',
                  label: 'Issues & Feature Ideas',
                  icon: Wrench,
                  badge: openIssuesCount > 0 ? String(openIssuesCount) : null,
                },
                {
                  id: 'governance',
                  label: 'Approvals, Diffs & Tools',
                  icon: Layers,
                  badge: awaitingProposalsCount > 0 ? String(awaitingProposalsCount) : null,
                },
              ] as const
            ).map((navItem) => {
              const Icon = navItem.icon;
              const active = mode === navItem.id;
              return (
                <button
                  key={navItem.id}
                  type="button"
                  onClick={() => {
                    setMode(navItem.id);
                    setMobileRailOpen(false);
                  }}
                  className={`w-full px-3 py-2 text-left text-xs font-extrabold border flex items-center justify-between gap-2 transition-colors ${
                    active
                      ? 'bg-[#191919] text-white border-[#191919] dark:bg-white dark:text-[#191919]'
                      : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:border-[#FF6500]'
                  }`}
                >
                  <span className="inline-flex items-center gap-2 truncate">
                    <Icon className="w-3.5 h-3.5 text-[#FF6500] shrink-0" />
                    <span className="truncate">{navItem.label}</span>
                  </span>
                  {navItem.badge && (
                    <span className="px-1.5 py-0.5 text-[10px] font-mono tabular-nums bg-[#FF6500] text-white shrink-0">
                      {navItem.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Saved Conversation History */}
          <div className="pt-2 border-t border-[var(--bx-border)] space-y-2">
            <div className="flex items-center justify-between text-[11px] font-black uppercase tracking-wider text-[var(--text-2)]">
              <span className="inline-flex items-center gap-1">
                <History className="w-3 h-3" />
                Saved Conversations
              </span>
              <span className="font-mono tabular-nums">{conversations.length}</span>
            </div>

            {conversations.length > 3 && (
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-[var(--text-2)]" />
                <input
                  type="search"
                  aria-label="Search saved conversations"
                  value={convSearch}
                  onChange={(e) => setConvSearch(e.target.value)}
                  placeholder="Filter threads…"
                  className="bx-input w-full pl-8 pr-2.5 py-1.5 text-xs"
                />
              </div>
            )}

            <div className="max-h-72 overflow-y-auto space-y-1.5 pr-0.5">
              {filteredConversations.length === 0 ? (
                <p className="text-[11px] text-[var(--text-2)] py-3 text-center border border-dashed border-[var(--bx-border)] px-2">
                  No saved threads yet. Send a message to start a persistent conversation.
                </p>
              ) : (
                filteredConversations.map((c) => {
                  const isCurrent = activeConvId === c.id && mode === 'chat';
                  return (
                    <div
                      key={c.id}
                      className={`group border p-2 flex items-start justify-between gap-1.5 transition-colors ${
                        isCurrent
                          ? 'border-[#FF6500] bg-[#FF6500]/10'
                          : 'border-[var(--bx-border)] bg-[var(--bx-surface-alt)] hover:border-[var(--text-2)]'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => void handleSelectConversation(c.id)}
                        className="text-left min-w-0 flex-1 space-y-0.5"
                      >
                        <div className="text-xs font-extrabold truncate">{c.title}</div>
                        <div className="text-[10px] text-[var(--text-2)] truncate">
                          {c.lastMessagePreview}
                        </div>
                        <div className="text-[10px] font-mono tabular-nums opacity-65">
                          {new Date(c.updatedAtMs).toLocaleDateString()} · {c.messageCount} msgs
                        </div>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete conversation ${c.title}`}
                        onClick={() => void handleDeleteConversation(c.id)}
                        className="p-1 opacity-60 hover:opacity-100 hover:text-red-600 shrink-0"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </aside>

        {/* MAIN RIGHT WORKSPACE CANVAS */}
        <section className="lg:col-span-9 min-w-0">
          {/* =========================================================
              VIEW 1: CHATGPT-LIKE CONVERSATIONAL ENGINEERING ASSISTANT
             ========================================================= */}
          {mode === 'chat' && (
            <div className="bx-card flex flex-col min-h-[600px] max-h-[780px]">
              {/* Thread Subheader */}
              <div className="p-3.5 border-b border-[var(--bx-border)] flex flex-wrap items-center justify-between gap-2 bg-[var(--bx-surface-alt)]">
                <div className="min-w-0">
                  <h2 className="text-sm font-black truncate">
                    {activeConvId
                      ? conversations.find((c) => c.id === activeConvId)?.title || 'Active Thread'
                      : 'New Engineering & Website Health Session'}
                  </h2>
                  <p className="text-[11px] text-[var(--text-2)]">
                    Equipped with live read-only codebase search, file reader, unit test runner, 16-section audit inspector, and human-gated diff staging.
                  </p>
                </div>
                {selectedReport && (
                  <button
                    type="button"
                    onClick={() => setMode('reports')}
                    className="bx-btn bx-btn-ghost px-2.5 py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                  >
                    <Activity className="w-3.5 h-3.5 text-[#FF6500]" />
                    Latest Audit: {selectedReport.overallStatus.replace(/_/g, ' ').toUpperCase()}
                  </button>
                )}
              </div>

              {/* Message Stream */}
              <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {loadingMessages ? (
                  <div className="py-16 flex flex-col items-center justify-center gap-2 text-xs text-[var(--text-2)]">
                    <Loader2 className="w-5 h-5 animate-spin text-[#FF6500]" />
                    Loading conversation history…
                  </div>
                ) : messages.length === 0 ? (
                  <div className="py-6 space-y-5 max-w-2xl mx-auto">
                    <div className="space-y-2 text-center">
                      <div className="w-11 h-11 mx-auto border-2 border-[#191919] bg-[#FFD400] text-[#191919] flex items-center justify-center">
                        <Bot className="w-6 h-6" />
                      </div>
                      <h3 className="text-base font-black">
                        How would you like to inspect or improve BEXORA today?
                      </h3>
                      <p className="text-xs text-[var(--text-2)] max-w-lg mx-auto">
                        Ask in plain language about any page, bug, Firebase rule, payment bridge, Deal Room workflow, or audit finding. Every claim is labeled with its verification source, and any proposed code fix waits for your explicit approval.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {QUICK_STARTER_PROMPTS.map((starter) => (
                        <button
                          key={starter.label}
                          type="button"
                          onClick={() => void sendChatMessage(starter.prompt)}
                          disabled={sendingChat}
                          className="p-3.5 text-left border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] hover:border-[#FF6500] transition-colors space-y-1"
                        >
                          <div className="text-xs font-black flex items-center justify-between gap-2">
                            <span>{starter.label}</span>
                            <ChevronRight className="w-3.5 h-3.5 text-[#FF6500] shrink-0" />
                          </div>
                          <p className="text-[11px] text-[var(--text-2)] line-clamp-2">
                            {starter.prompt}
                          </p>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  messages.map((m) => {
                    const isAdmin = m.role === 'admin';
                    const toolsOpen = Boolean(expandedToolMsgIds[m.id]);
                    return (
                      <div
                        key={m.id}
                        className={`flex flex-col ${isAdmin ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={`max-w-full sm:max-w-[88%] p-3.5 border space-y-2.5 ${
                            isAdmin
                              ? 'bg-[#191919] text-white border-[#191919] dark:bg-white dark:text-[#191919]'
                              : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] text-[var(--text)]'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[10px] font-black uppercase tracking-wider opacity-75">
                              {isAdmin ? 'You (Administrator)' : 'BEXORA AI Engineer'}
                            </span>
                            {!isAdmin && <EvidenceBadge mode={m.evidenceMode} />}
                          </div>

                          <div className="text-xs leading-relaxed whitespace-pre-wrap break-words">
                            {m.content}
                          </div>

                          {/* Inspected Files & Executed Tools Disclosure */}
                          {!isAdmin &&
                            ((m.toolCalls && m.toolCalls.length > 0) ||
                              (m.inspectedFiles && m.inspectedFiles.length > 0)) && (
                              <div className="pt-2 border-t border-[var(--bx-border)] space-y-2">
                                <button
                                  type="button"
                                  aria-expanded={toolsOpen}
                                  onClick={() =>
                                    setExpandedToolMsgIds((prev) => ({
                                      ...prev,
                                      [m.id]: !prev[m.id],
                                    }))
                                  }
                                  className="text-[11px] font-extrabold text-[#FF6500] inline-flex items-center gap-1"
                                >
                                  {toolsOpen ? (
                                    <ChevronDown className="w-3.5 h-3.5" />
                                  ) : (
                                    <ChevronRight className="w-3.5 h-3.5" />
                                  )}
                                  Verified Inspection Trace ({m.toolCalls?.length || 0} tool call(s)
                                  {m.inspectedFiles && m.inspectedFiles.length > 0
                                    ? ` · ${m.inspectedFiles.length} file(s)`
                                    : ''}
                                  )
                                </button>
                                {toolsOpen && (
                                  <div className="p-2.5 bg-[var(--bx-surface)] border border-[var(--bx-border)] space-y-1.5 text-[11px]">
                                    {m.inspectedFiles && m.inspectedFiles.length > 0 && (
                                      <div className="font-mono text-[10px]">
                                        <span className="font-bold">Files Read:</span>{' '}
                                        {m.inspectedFiles.join(', ')}
                                      </div>
                                    )}
                                    {m.toolCalls?.map((tc, tIdx) => (
                                      <div
                                        key={tIdx}
                                        className="flex items-start justify-between gap-2 text-[10px] border-t first:border-t-0 border-[var(--bx-border)] pt-1 first:pt-0"
                                      >
                                        <span className="font-mono font-bold shrink-0">
                                          {tc.toolName}({tc.target})
                                        </span>
                                        <span className="text-[var(--text-2)] text-right">
                                          {tc.detail}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}

                          {/* Inline Staged Unified Diff Preview */}
                          {!isAdmin && m.proposedDiff && (
                            <div className="pt-2 border-t border-[var(--bx-border)] space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-black uppercase text-[#FF6500]">
                                  Staged Code Diff (Awaiting Human Approval)
                                </span>
                                <button
                                  type="button"
                                  onClick={() => setMode('governance')}
                                  className="bx-btn bx-btn-primary px-2.5 py-1 text-[10px] font-extrabold whitespace-nowrap shrink-0"
                                >
                                  Open in Approval Queue
                                </button>
                              </div>
                              <div className="border border-[var(--bx-border)] bg-[var(--bx-surface)] overflow-x-auto max-h-56">
                                {renderDiffLines(m.proposedDiff)}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}

                {sendingChat && (
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-2)] p-2">
                    <Loader2 className="w-4 h-4 animate-spin text-[#FF6500]" />
                    Inspecting BEXORA evidence &amp; preparing response…
                  </div>
                )}

                {chatError && (
                  <div className="p-3 border border-red-600 bg-red-500/10 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="text-red-700 dark:text-red-300 font-bold">
                      {chatError.message}
                    </span>
                    <button
                      type="button"
                      onClick={() => void sendChatMessage(chatError.retryText)}
                      className="bx-btn bx-btn-ghost px-3 py-1 text-xs font-extrabold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      Retry Message
                    </button>
                  </div>
                )}

                <div ref={chatEndRef} />
              </div>

              {/* Pinned Context & Composer */}
              <div className="p-3.5 border-t border-[var(--bx-border)] bg-[var(--bx-surface)] space-y-2">
                {pinnedContext && (
                  <div className="px-2.5 py-1.5 border border-[#FF6500] bg-[#FF6500]/10 flex items-center justify-between gap-2 text-[11px]">
                    <span className="font-bold truncate">
                      Pinned Context: {pinnedContext.label}
                    </span>
                    <button
                      type="button"
                      aria-label="Clear pinned context"
                      onClick={() => setPinnedContext(null)}
                      className="p-0.5 hover:text-red-600 shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <form onSubmit={handleComposerSubmit} className="flex items-end gap-2">
                  <label htmlFor="admin-ai-chat-input" className="sr-only">
                    Message BEXORA AI Assistant
                  </label>
                  <textarea
                    id="admin-ai-chat-input"
                    rows={2}
                    value={composerText}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        void sendChatMessage(composerText);
                      }
                    }}
                    disabled={sendingChat}
                    placeholder="Message BEXORA AI Assistant — ask about bugs, files, security rules, audit reports, or feature ideas…"
                    className="bx-input flex-1 px-3 py-2 text-xs resize-none"
                  />
                  <button
                    type="submit"
                    disabled={sendingChat || !composerText.trim()}
                    className="bx-btn bx-btn-primary px-4 py-2.5 text-xs font-black whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
                  >
                    <Send className="w-3.5 h-3.5 shrink-0" />
                    {sendingChat ? 'Sending…' : 'Send'}
                  </button>
                </form>
              </div>
            </div>
          )}

          {/* =========================================================
              VIEW 2: 16-SECTION AUDIT REPORTS & DAILY SCHEDULE (ASIA/DHAKA)
             ========================================================= */}
          {mode === 'reports' && (
            <div className="space-y-4">
              {/* Automatic Daily Audit Schedule Configurator */}
              <form onSubmit={handleSaveDailySchedule} className="bx-card p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-black flex items-center gap-2">
                      <CalendarClock className="w-4 h-4 text-[#FF6500]" />
                      Unattended Automatic Daily Health Report Schedule
                    </h2>
                    <p className="text-xs text-[var(--text-2)]">
                      Runs on the server using the shared 7-stage audit engine without requiring you to open the chatbot. Default timezone: <strong>Asia/Dhaka</strong>.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs font-extrabold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={schedEnabled}
                      onChange={(e) => setSchedEnabled(e.target.checked)}
                      className="w-4 h-4 accent-[#FF6500]"
                    />
                    Enable Daily Scheduled Audit
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="sched-hour" className="block text-[11px] font-extrabold mb-1">
                      Run Hour (24h)
                    </label>
                    <input
                      id="sched-hour"
                      type="number"
                      min={0}
                      max={23}
                      value={schedHour}
                      onChange={(e) => setSchedHour(Number(e.target.value))}
                      className="bx-input w-full px-3 py-2 text-xs font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor="sched-minute" className="block text-[11px] font-extrabold mb-1">
                      Run Minute (0–59)
                    </label>
                    <input
                      id="sched-minute"
                      type="number"
                      min={0}
                      max={59}
                      value={schedMinute}
                      onChange={(e) => setSchedMinute(Number(e.target.value))}
                      className="bx-input w-full px-3 py-2 text-xs font-mono tabular-nums"
                    />
                  </div>
                  <div>
                    <label htmlFor="sched-tz" className="block text-[11px] font-extrabold mb-1">
                      Timezone (IANA)
                    </label>
                    <select
                      id="sched-tz"
                      value={schedTimezone}
                      onChange={(e) => setSchedTimezone(e.target.value)}
                      className="bx-input w-full px-3 py-2 text-xs font-bold"
                    >
                      {COMMON_TIMEZONES.map((tz) => (
                        <option key={tz} value={tz}>
                          {tz}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-[var(--bx-border)]">
                  <div className="flex flex-wrap items-center gap-4 text-xs font-bold">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={schedNotifyInApp}
                        onChange={(e) => setSchedNotifyInApp(e.target.checked)}
                        className="accent-[#FF6500]"
                      />
                      In-App Admin Notification
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={schedNotifyTelegram}
                        onChange={(e) => setSchedNotifyTelegram(e.target.checked)}
                        className="accent-[#FF6500]"
                      />
                      Telegram Bot (if server token configured)
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={schedNotifyEmail}
                        onChange={(e) => setSchedNotifyEmail(e.target.checked)}
                        className="accent-[#FF6500]"
                      />
                      Alert Webhook (if server URL configured)
                    </label>
                  </div>

                  <button
                    type="submit"
                    disabled={savingSchedule}
                    className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black whitespace-nowrap shrink-0"
                  >
                    {savingSchedule ? 'Saving…' : 'Save Daily Schedule'}
                  </button>
                </div>

                <div className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-[11px] text-[var(--text-2)] flex flex-wrap items-center justify-between gap-2">
                  <span>
                    Next Scheduled Run: <strong className="text-[var(--text)] font-mono">{overview?.nextScheduledRunFormatted || '09:00 Asia/Dhaka'}</strong>
                    {overview?.schedule.lastRunDateKey
                      ? ` · Last Daily Date Key: ${overview.schedule.lastRunDateKey}`
                      : ''}
                  </span>
                  <span>
                    Persistence Mode:{' '}
                    <strong className="text-[var(--text)]">
                      {overview?.firestoreAdminDirectAccess
                        ? 'Direct Firebase Admin SDK'
                        : 'Durable Server Disk + Admin Firestore Sync'}
                    </strong>
                  </span>
                </div>
              </form>

              {/* Historical Report Switcher & Full 16-Section Report */}
              <div className="bx-card p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-black">
                      Structured 16-Section Website Health Reports
                    </h2>
                    <p className="text-xs text-[var(--text-2)]">
                      Generated by the unified server audit engine across both manual Check Now and scheduled daily runs.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {overview?.recentReports && overview.recentReports.length > 0 && (
                      <select
                        aria-label="Select Audit Report History"
                        value={selectedReport?.reportId || ''}
                        onChange={(e) => void handleSelectReportById(e.target.value)}
                        className="bx-input px-3 py-1.5 text-xs font-mono"
                      >
                        {overview.recentReports.map((r) => (
                          <option key={r.reportId} value={r.reportId}>
                            {r.dateKey} · {r.trigger === 'scheduled_daily' ? 'Daily' : 'Manual'} ·{' '}
                            {r.overallStatus.toUpperCase()} ({r.reportId.slice(-6)})
                          </option>
                        ))}
                      </select>
                    )}
                    {selectedReport && (
                      <button
                        type="button"
                        onClick={() => handleDiscussReportInChat(selectedReport)}
                        className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold whitespace-nowrap shrink-0 inline-flex items-center gap-1.5"
                      >
                        <MessageSquare className="w-3.5 h-3.5 text-[#FF6500]" />
                        Discuss Report in Chat
                      </button>
                    )}
                  </div>
                </div>

                {loadingReportId ? (
                  <div className="py-12 text-center text-xs text-[var(--text-2)]">
                    <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-[#FF6500]" />
                    Loading audit report…
                  </div>
                ) : !selectedReport ? (
                  <div className="p-8 text-center border border-dashed border-[var(--bx-border)] space-y-3">
                    <p className="text-xs font-bold">
                      No Website Audit Report has been generated yet in this workspace.
                    </p>
                    <p className="text-xs text-[var(--text-2)]">
                      Click <strong>Check Now</strong> in the header above to run all 7 real verification stages (Codebase, TypeScript, Firestore ESLint Rules, Automated Unit Tests, Firebase/FCM, Marketplace Workflows, and Security Telemetry).
                    </p>
                    <button
                      type="button"
                      onClick={() => void handleRunCheckNowAudit()}
                      disabled={isAuditBusy}
                      className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black whitespace-nowrap"
                    >
                      Run First Check Now Audit
                    </button>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Comparison Delta Summary Strip */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                        <div className="text-[10px] font-black uppercase text-[var(--text-2)]">
                          Newly Discovered
                        </div>
                        <div className="text-lg font-black font-mono tabular-nums">
                          {selectedReport.comparison.newlyDiscoveredIds.length}
                        </div>
                      </div>
                      <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                        <div className="text-[10px] font-black uppercase text-[var(--text-2)]">
                          Persisting Open
                        </div>
                        <div className="text-lg font-black font-mono tabular-nums">
                          {selectedReport.comparison.persistingUnresolvedIds.length}
                        </div>
                      </div>
                      <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                        <div className="text-[10px] font-black uppercase text-emerald-600">
                          Verified Fixed
                        </div>
                        <div className="text-lg font-black font-mono tabular-nums text-emerald-600">
                          {selectedReport.comparison.fixedAndVerifiedIds.length}
                        </div>
                      </div>
                      <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                        <div className="text-[10px] font-black uppercase text-amber-600">
                          Regressions
                        </div>
                        <div className="text-lg font-black font-mono tabular-nums text-amber-600">
                          {selectedReport.comparison.regressionIds.length}
                        </div>
                      </div>
                    </div>

                    <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs space-y-1">
                      <div className="font-bold">{selectedReport.comparison.healthDeltaSummary}</div>
                      <div className="text-[11px] text-[var(--text-2)]">
                        Generated: {new Date(selectedReport.generatedAtMs).toLocaleString()} · Duration:{' '}
                        {(selectedReport.durationMs / 1000).toFixed(2)}s · Notification Delivery:{' '}
                        {selectedReport.notificationDelivery.detail}
                      </div>
                    </div>

                    {/* All 16 Structured Report Sections */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {selectedReport.sections.map((sec) => (
                        <div
                          key={sec.key}
                          className="p-3.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <h3 className="text-xs font-black">{sec.title}</h3>
                            <span
                              className={`px-2 py-0.5 text-[10px] font-extrabold uppercase shrink-0 ${
                                sec.status === 'pass'
                                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                  : sec.status === 'fail'
                                  ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                                  : sec.status === 'warning' || sec.status === 'incomplete'
                                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                                  : 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
                              }`}
                            >
                              {sec.status}
                            </span>
                          </div>
                          <p className="text-xs font-semibold">{sec.summary}</p>
                          <ul className="space-y-1 text-[11px] text-[var(--text-2)] list-disc pl-4">
                            {sec.findings.map((f, idx) => (
                              <li key={idx} className="break-words">
                                {f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* =========================================================
              VIEW 3: TRACKED ISSUES & STRUCTURED FEATURE RECOMMENDATIONS
             ========================================================= */}
          {mode === 'issues' && (
            <div className="space-y-4">
              {/* Tracked Issues Lifecycle List */}
              <div className="bx-card p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-black">
                      Evidence-Based Issue Tracker (Deduplicated Across Audits)
                    </h2>
                    <p className="text-xs text-[var(--text-2)]">
                      Each issue carries a deterministic ID, confidence level, reproduction steps, root cause, side effects, and lifecycle state.
                    </p>
                  </div>
                  <div className="flex items-center gap-1">
                    {(['open', 'fixed', 'all'] as const).map((f) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => setIssueFilter(f)}
                        className={`px-3 py-1.5 text-xs font-extrabold border uppercase whitespace-nowrap shrink-0 ${
                          issueFilter === f
                            ? 'bg-[#FF6500] text-white border-[#191919]'
                            : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)]'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>

                {filteredIssues.length === 0 ? (
                  <div className="p-6 text-center border border-dashed border-[var(--bx-border)] text-xs text-[var(--text-2)]">
                    {trackedIssues.length === 0
                      ? 'Run Check Now to populate verified codebase, cloud, and security findings.'
                      : `No issues match the "${issueFilter}" filter.`}
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredIssues.map((iss) => (
                      <div
                        key={iss.issueId}
                        className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2.5 text-xs"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-mono font-black text-[11px] px-2 py-0.5 bg-[#191919] text-white dark:bg-white dark:text-[#191919]">
                              {iss.issueId}
                            </span>
                            <span
                              className={`px-2 py-0.5 text-[10px] font-black uppercase ${
                                iss.severity === 'critical' || iss.severity === 'high'
                                  ? 'bg-red-600 text-white'
                                  : iss.severity === 'medium'
                                  ? 'bg-amber-500 text-[#191919]'
                                  : 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
                              }`}
                            >
                              {iss.severity}
                            </span>
                            <span className="px-2 py-0.5 text-[10px] font-extrabold uppercase border border-[var(--bx-border)]">
                              {iss.lifecycleState.replace('_', ' ')}
                            </span>
                            <span className="text-[11px] font-mono text-[var(--text-2)]">
                              Confidence: {iss.confidence}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDiscussIssueInChat(iss)}
                            className="bx-btn bx-btn-primary px-3 py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                          >
                            <MessageSquare className="w-3 h-3" />
                            Investigate in Chat
                          </button>
                        </div>

                        <div className="font-black text-sm">{iss.title}</div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                          <div>
                            <span className="font-extrabold">Affected Target:</span>{' '}
                            <code className="font-mono">{iss.affectedTarget}</code>
                          </div>
                          <div>
                            <span className="font-extrabold">Approval Required:</span>{' '}
                            {iss.approvalRequired ? 'Yes (Human Admin Queue)' : 'No (Operational Info)'}
                          </div>
                        </div>
                        <div className="p-2.5 bg-[var(--bx-surface)] border border-[var(--bx-border)] font-mono text-[11px] break-words">
                          <strong>Evidence:</strong> {iss.evidence}
                        </div>
                        <div className="space-y-1 text-[11px] text-[var(--text-2)]">
                          <div>
                            <strong className="text-[var(--text)]">Root Cause:</strong> {iss.rootCause}
                          </div>
                          <div>
                            <strong className="text-[var(--text)]">Proposed Safe Resolution:</strong>{' '}
                            {iss.proposedResolution}
                          </div>
                          <div>
                            <strong className="text-[var(--text)]">Potential Side Effects:</strong>{' '}
                            {iss.potentialSideEffects}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Structured Feature Recommendations */}
              {selectedReport?.featureRecommendations &&
                selectedReport.featureRecommendations.length > 0 && (
                  <div className="bx-card p-4 sm:p-5 space-y-3">
                    <h2 className="text-base font-black">
                      BEXORA Product &amp; Marketplace Feature Recommendations
                    </h2>
                    <div className="grid grid-cols-1 gap-3">
                      {selectedReport.featureRecommendations.map((feat) => (
                        <div
                          key={feat.id}
                          className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2 text-xs"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-black text-sm">{feat.title}</span>
                              <span
                                className={`px-2 py-0.5 text-[10px] font-black uppercase ${
                                  feat.priorityRecommendation === 'implement_now'
                                    ? 'bg-emerald-600 text-white'
                                    : 'bg-[var(--bx-surface)] border border-[var(--bx-border)]'
                                }`}
                              >
                                {feat.priorityRecommendation === 'implement_now'
                                  ? 'Recommended Now'
                                  : 'Defer'}
                              </span>
                              <span className="px-2 py-0.5 text-[10px] font-mono uppercase border border-[var(--bx-border)]">
                                Complexity: {feat.complexity}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setMode('chat');
                                setComposerText(
                                  `Let's evaluate feature recommendation "${feat.title}" (${feat.id}). Inspect ${feat.affectedFilesAndServices.join(', ')} and draft a staged implementation plan and unified diff for review.`
                                );
                              }}
                              className="bx-btn bx-btn-ghost px-3 py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                            >
                              Plan in Chat
                            </button>
                          </div>
                          <p>{feat.whatItDoes}</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-[var(--text-2)]">
                            <div>
                              <strong className="text-[var(--text)]">Why Useful for BEXORA:</strong>{' '}
                              {feat.whyUsefulForBexora}
                            </div>
                            <div>
                              <strong className="text-[var(--text)]">Who Benefits:</strong>{' '}
                              {feat.beneficiaries.join(', ')}
                            </div>
                            <div>
                              <strong className="text-[var(--text)]">Problem Solved:</strong>{' '}
                              {feat.problemSolved}
                            </div>
                            <div>
                              <strong className="text-[var(--text)]">Affected Files/Services:</strong>{' '}
                              <span className="font-mono">{feat.affectedFilesAndServices.join(', ')}</span>
                            </div>
                            <div>
                              <strong className="text-[var(--text)]">Risks &amp; Dependencies:</strong>{' '}
                              {feat.risksAndDependencies}
                            </div>
                            <div>
                              <strong className="text-[var(--text)]">Verification Plan:</strong>{' '}
                              {feat.verificationPlan}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
            </div>
          )}

          {/* =========================================================
              VIEW 4: HUMAN APPROVAL QUEUE, UNIFIED DIFFS & SYSTEM TOOLS
             ========================================================= */}
          {mode === 'governance' && (
            <div className="space-y-4">
              {/* Human Approval Queue & Diff Inspector */}
              <div className="bx-card p-4 sm:p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="text-base font-black flex items-center gap-2">
                      <Code2 className="w-4 h-4 text-[#FF6500]" />
                      Human-Gated Code Diff &amp; Proposal Approval Queue ({proposals.length})
                    </h2>
                    <p className="text-xs text-[var(--text-2)]">
                      AI can never self-approve. Approving one specific proposal never authorizes another.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={settings.aiEmergencyStop}
                    onClick={() => setShowManualStageForm((v) => !v)}
                    className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold whitespace-nowrap shrink-0"
                  >
                    {showManualStageForm ? 'Close Stage Form' : '+ Stage Manual Proposal'}
                  </button>
                </div>

                {showManualStageForm && (
                  <form
                    onSubmit={handleManualProposalSubmit}
                    className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3"
                  >
                    <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
                      <input
                        type="text"
                        required
                        aria-label="Proposal Title"
                        value={manualTitle}
                        onChange={(e) => setManualTitle(e.target.value)}
                        placeholder="Specific proposal title…"
                        className="bx-input sm:col-span-2 px-3 py-2 text-xs"
                      />
                      <select
                        aria-label="Proposal Category"
                        value={manualCategory}
                        onChange={(e) =>
                          setManualCategory(
                            e.target.value as 'bugfix' | 'security' | 'feature' | 'performance'
                          )
                        }
                        className="bx-input px-3 py-2 text-xs font-bold"
                      >
                        <option value="bugfix">Bugfix</option>
                        <option value="security">Security</option>
                        <option value="feature">Feature</option>
                        <option value="performance">Performance</option>
                      </select>
                      <select
                        aria-label="Proposal Severity"
                        value={manualSeverity}
                        onChange={(e) =>
                          setManualSeverity(
                            e.target.value as 'low' | 'medium' | 'high' | 'critical'
                          )
                        }
                        className="bx-input px-3 py-2 text-xs font-bold"
                      >
                        <option value="low">Low Risk</option>
                        <option value="medium">Medium Risk</option>
                        <option value="high">High Risk</option>
                        <option value="critical">Critical</option>
                      </select>
                    </div>
                    <input
                      type="text"
                      aria-label="Affected Files"
                      value={manualFiles}
                      onChange={(e) => setManualFiles(e.target.value)}
                      placeholder="Affected files (comma-separated)"
                      className="bx-input w-full px-3 py-2 text-xs font-mono"
                    />
                    <textarea
                      rows={2}
                      aria-label="Proposal Summary and Verification Plan"
                      value={manualSummary}
                      onChange={(e) => setManualSummary(e.target.value)}
                      placeholder="Root cause, side effects, and test verification plan…"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                    <textarea
                      rows={4}
                      aria-label="Unified Diff"
                      value={manualDiff}
                      onChange={(e) => setManualDiff(e.target.value)}
                      className="bx-input w-full px-3 py-2 text-xs font-mono"
                    />
                    <button
                      type="submit"
                      className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black whitespace-nowrap"
                    >
                      Stage for Human Review
                    </button>
                  </form>
                )}

                {proposals.length === 0 ? (
                  <p className="text-xs text-[var(--text-2)] p-4 border border-dashed border-[var(--bx-border)] text-center">
                    No staged proposals in queue. Ask the AI Assistant to draft a reviewable fix diff or stage one manually above.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                    <div className="lg:col-span-5 space-y-2 max-h-96 overflow-y-auto">
                      {proposals.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setSelectedProposalId(p.id)}
                          className={`w-full text-left p-3 border space-y-1 transition-colors ${
                            selectedProposal?.id === p.id
                              ? 'border-[#FF6500] bg-[#FF6500]/10'
                              : 'border-[var(--bx-border)] bg-[var(--bx-surface-alt)]'
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-black uppercase px-1.5 py-0.5 bg-[#191919] text-white dark:bg-white dark:text-[#191919]">
                              {p.category} · {p.severity}
                            </span>
                            <span className="text-[10px] font-mono uppercase font-bold">
                              {p.status.replace('_', ' ')}
                            </span>
                          </div>
                          <div className="text-xs font-extrabold truncate">{p.title}</div>
                          <div className="text-[10px] text-[var(--text-2)] truncate">
                            {p.affectedFiles.join(', ') || 'No files listed'}
                          </div>
                        </button>
                      ))}
                    </div>

                    <div className="lg:col-span-7">
                      {selectedProposal && (
                        <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3 text-xs">
                          <div className="flex flex-wrap items-start justify-between gap-2">
                            <div>
                              <h3 className="font-black text-sm">{selectedProposal.title}</h3>
                              <p className="text-[11px] font-mono text-[var(--text-2)]">
                                ID: {selectedProposal.id} · Status:{' '}
                                <strong>{selectedProposal.status.toUpperCase()}</strong>
                                {selectedProposal.linkedIssueId
                                  ? ` · Issue: ${selectedProposal.linkedIssueId}`
                                  : ''}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                setPinnedContext({
                                  label: `Proposal: ${selectedProposal.title}`,
                                  proposalId: selectedProposal.id,
                                });
                                setMode('chat');
                                setComposerText(
                                  `Explain the exact impact, risks, and test verification steps for staged proposal "${selectedProposal.title}" (${selectedProposal.id}).`
                                );
                              }}
                              className="bx-btn bx-btn-ghost px-2.5 py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                            >
                              Discuss Diff in Chat
                            </button>
                          </div>

                          <p className="whitespace-pre-wrap text-[11px]">{selectedProposal.summary}</p>

                          <div className="text-[11px] font-mono">
                            <strong>Affected Files:</strong>{' '}
                            {selectedProposal.affectedFiles.join(', ') || 'None specified'}
                          </div>

                          <div className="border border-[var(--bx-border)] bg-[var(--bx-surface)] overflow-x-auto max-h-64">
                            {renderDiffLines(selectedProposal.proposedDiff)}
                          </div>

                          <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-[var(--bx-border)]">
                            <button
                              type="button"
                              disabled={
                                settings.aiEmergencyStop ||
                                busyProposalId === selectedProposal.id ||
                                (selectedProposal.status !== 'awaiting_review' &&
                                  selectedProposal.status !== 'in_review')
                              }
                              onClick={() =>
                                void handleProposalHumanDecision(selectedProposal, 'approved')
                              }
                              className="px-3.5 py-1.5 text-xs font-black bg-emerald-600 text-white disabled:opacity-40 whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Approve Specific Change
                            </button>
                            <button
                              type="button"
                              disabled={busyProposalId === selectedProposal.id}
                              onClick={() =>
                                void handleProposalHumanDecision(selectedProposal, 'in_review')
                              }
                              className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                            >
                              <Clock className="w-3.5 h-3.5" />
                              Mark In Review
                            </button>
                            <button
                              type="button"
                              disabled={
                                busyProposalId === selectedProposal.id ||
                                selectedProposal.status === 'rejected'
                              }
                              onClick={() =>
                                void handleProposalHumanDecision(selectedProposal, 'rejected')
                              }
                              className="px-3.5 py-1.5 text-xs font-black bg-red-600 text-white disabled:opacity-40 whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Cloud Diagnostics, Deployment Exports & Immutable Audit Logs */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bx-card p-4 space-y-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-black text-sm">Cloud, Auth &amp; FCM Quick Actions</h3>
                    <button
                      type="button"
                      onClick={() => void onRefreshSystemHealth()}
                      className="bx-btn bx-btn-ghost px-2.5 py-1 text-[11px] font-bold whitespace-nowrap shrink-0"
                    >
                      Refresh Probe
                    </button>
                  </div>
                  <p className="text-[11px] text-[var(--text-2)]">
                    Active Listings: <strong>{allListings.length}</strong> · Escrow Deals:{' '}
                    <strong>{deals.length}</strong> · Reported Deals:{' '}
                    <strong>{reportedDealsCount}</strong>
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={enablingCloudService !== null}
                      onClick={() => void onEnableCloudService('token_service')}
                      className="bx-btn bx-btn-primary px-3 py-1.5 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                    >
                      {enablingCloudService === 'token_service'
                        ? 'Checking Token API…'
                        : 'Verify Token Service API'}
                    </button>
                    <button
                      type="button"
                      disabled={enablingCloudService !== null}
                      onClick={() => void onEnableCloudService('fcm_apis')}
                      className="bx-btn bx-btn-ghost px-3 py-1.5 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                    >
                      {enablingCloudService === 'fcm_apis'
                        ? 'Checking FCM…'
                        : 'Verify FCM Cloud APIs'}
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <a
                      href={firebaseAuthProvidersUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-bold underline inline-flex items-center gap-1"
                    >
                      Auth Providers <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                      href={firebaseAuthDomainsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-bold underline inline-flex items-center gap-1"
                    >
                      Authorized Domains <ExternalLink className="w-3 h-3" />
                    </a>
                    <a
                      href={tokenServiceActivationUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-bold underline inline-flex items-center gap-1"
                    >
                      Token Service <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
                  {healthSnapshot && (
                    <pre className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-[10px] font-mono overflow-x-auto max-h-40">
                      {JSON.stringify(healthSnapshot, null, 2)}
                    </pre>
                  )}
                </div>

                <div className="bx-card p-4 space-y-3 text-xs">
                  <h3 className="font-black text-sm flex items-center gap-1.5">
                    <Archive className="w-4 h-4 text-[#FF6500]" />
                    Release Packages &amp; Config Checkpoints
                  </h3>
                  <p className="text-[11px] text-[var(--text-2)]">
                    Export a static frontend bundle or non-secret configuration checkpoint before applying major platform updates.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={downloadingInfinityZip || settings.aiEmergencyStop}
                      onClick={() => void onDownloadInfinityZip()}
                      className="bx-btn bx-btn-primary px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      {downloadingInfinityZip ? 'Packaging .zip…' : 'Download InfinityFree .zip'}
                    </button>
                    <button
                      type="button"
                      onClick={onExportJsonBackup}
                      className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Export Config Checkpoint (.json)
                    </button>
                  </div>

                  <div className="pt-2 border-t border-[var(--bx-border)] space-y-1.5">
                    <div className="text-[11px] font-black uppercase text-[var(--text-2)]">
                      Recent Immutable Admin Audit Logs ({auditLogs.length})
                    </div>
                    <div className="max-h-36 overflow-y-auto space-y-1 font-mono text-[10px]">
                      {auditLogs.slice(0, 12).map((l) => (
                        <div
                          key={l.id}
                          className="p-1.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] truncate"
                        >
                          [{new Date(l.createdAtMs).toLocaleTimeString()}] <strong>{l.action}</strong>:{' '}
                          {l.details}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};
