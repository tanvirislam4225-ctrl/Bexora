export type AiEvidenceMode =
  | 'verified_project_evidence'
  | 'live_tool_inspection'
  | 'general_reasoning';

export type AuditRunTrigger = 'manual' | 'scheduled_daily';

export type AuditRunOverallStatus =
  | 'healthy'
  | 'attention_needed'
  | 'critical_issues'
  | 'incomplete';

export type AuditIssueSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AuditIssueConfidence = 'verified' | 'high' | 'medium' | 'hypothesis';

export type AuditIssueLifecycleState =
  | 'new'
  | 'persisting'
  | 'regressed'
  | 'fixed_verified';

export type AuditCheckStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'skipped';

export interface AuditCheckStepProgress {
  stepId: string;
  label: string;
  category: 'codebase' | 'cloud' | 'workflows' | 'security' | 'tests';
  status: AuditCheckStepStatus;
  startedAtMs?: number;
  completedAtMs?: number;
  summary: string;
  incompleteReason?: string;
}

export interface AuditIssueRecord {
  issueId: string; // Stable deterministic ID e.g. ISS-CLOUD-ADC-FIRESTORE
  fingerprint: string;
  title: string;
  category:
    | 'codebase'
    | 'typescript_build'
    | 'firebase_cloud'
    | 'security_rules'
    | 'marketplace_workflow'
    | 'payments_wallet'
    | 'notifications_fcm'
    | 'ux_support'
    | 'performance';
  severity: AuditIssueSeverity;
  confidence: AuditIssueConfidence;
  lifecycleState: AuditIssueLifecycleState;
  affectedTarget: string; // Exact file, route, service, or workflow
  evidence: string;
  reproductionSteps: string[];
  rootCause: string;
  proposedResolution: string;
  potentialSideEffects: string;
  approvalRequired: boolean;
  verificationStatus: 'verified_reproducible' | 'static_analysis_verified' | 'runtime_probed' | 'needs_manual_check';
  firstDetectedAtMs: number;
  lastSeenAtMs: number;
  resolvedAtMs?: number;
  linkedProposalId?: string;
}

export interface FeatureRecommendationItem {
  id: string;
  title: string;
  whatItDoes: string;
  whyUsefulForBexora: string;
  beneficiaries: ('buyers' | 'sellers' | 'admins')[];
  problemSolved: string;
  affectedFilesAndServices: string[];
  risksAndDependencies: string;
  complexity: 'small' | 'medium' | 'large';
  verificationPlan: string;
  priorityRecommendation: 'implement_now' | 'defer';
}

export interface AuditReportSection {
  sectionNumber: number;
  key: string;
  title: string;
  status: 'pass' | 'warning' | 'fail' | 'info' | 'incomplete';
  summary: string;
  findings: string[];
  metrics?: Record<string, string | number | boolean>;
}

export interface AuditReportComparison {
  previousReportId: string | null;
  previousGeneratedAtMs: number | null;
  newlyDiscoveredIds: string[];
  persistingUnresolvedIds: string[];
  fixedAndVerifiedIds: string[];
  regressionIds: string[];
  healthDeltaSummary: string;
}

export interface ExecutedTestSuiteSummary {
  executed: boolean;
  command: string;
  totalTests: number;
  passedTests: number;
  failedTests: number;
  durationMs: number;
  rawSummary: string;
  incompleteReason?: string;
}

export interface WebsiteAuditReport {
  reportId: string;
  trigger: AuditRunTrigger;
  generatedAtMs: number;
  startedAtMs: number;
  durationMs: number;
  timezone: string;
  dateKey: string;
  overallStatus: AuditRunOverallStatus;
  executiveSummary: string;
  completedChecksCount: number;
  incompleteChecksCount: number;
  steps: AuditCheckStepProgress[];
  sections: AuditReportSection[]; // All 16 required sections
  issues: AuditIssueRecord[];
  featureRecommendations: FeatureRecommendationItem[];
  testSummary: ExecutedTestSuiteSummary;
  comparison: AuditReportComparison;
  notificationDelivery: {
    inAppQueuedOrDelivered: boolean;
    telegramStatus: 'delivered' | 'not_configured' | 'failed' | 'disabled';
    emailStatus: 'delivered' | 'not_configured' | 'failed' | 'disabled';
    detail: string;
  };
}

export interface DailyAuditScheduleConfig {
  enabled: boolean;
  hour: number; // 0-23
  minute: number; // 0-59
  timezone: string; // Default: 'Asia/Dhaka'
  notifyInApp: boolean;
  notifyTelegram: boolean;
  notifyEmail: boolean;
  lastRunDateKey: string; // YYYY-MM-DD in configured timezone
  lastRunAtMs: number;
  lastReportId: string;
  lastRunTrigger: AuditRunTrigger | 'none';
  updatedBy: string;
  updatedAtMs: number;
}

export interface AiToolExecutionSummary {
  toolName: string;
  target: string;
  outcome: 'ok' | 'blocked' | 'error';
  detail: string;
}

export interface AiChatMessageRecord {
  id: string;
  conversationId: string;
  role: 'admin' | 'assistant';
  content: string;
  evidenceMode: AiEvidenceMode;
  modelUsed?: string;
  inspectedFiles?: string[];
  toolCalls?: AiToolExecutionSummary[];
  linkedReportId?: string;
  linkedIssueId?: string;
  linkedProposalId?: string;
  proposedDiff?: string;
  createdAtMs: number;
  actorUid?: string;
}

export interface AiConversationRecord {
  id: string;
  title: string;
  summary: string;
  createdBy: string;
  messageCount: number;
  lastMessagePreview: string;
  pinnedReportId?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface SanitizedTelemetryEvent {
  id: string;
  kind: 'runtime_error' | 'unhandled_rejection' | 'route_failure' | 'api_failure' | 'ux_friction';
  route: string;
  componentOrEndpoint: string;
  messageRedacted: string;
  occurrences: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

export interface ActiveAuditRunStatus {
  running: boolean;
  runId: string | null;
  trigger: AuditRunTrigger | null;
  startedAtMs: number | null;
  currentStepLabel: string;
  completedSteps: number;
  totalSteps: number;
  steps: AuditCheckStepProgress[];
}

export interface AiAdminRuntimeOverview {
  aiProviderConfigured: boolean;
  aiPrimaryModel: string;
  aiFallbackModel: string;
  aiProviderNote: string;
  emergencyStopActive: boolean;
  firestoreAdminDirectAccess: boolean;
  firestoreSyncMode: 'admin_sdk_direct' | 'authenticated_admin_rest_and_durable_disk';
  schedulerRunning: boolean;
  nextScheduledRunIso: string | null;
  nextScheduledRunFormatted: string;
  schedule: DailyAuditScheduleConfig;
  activeAudit: ActiveAuditRunStatus;
  latestReport: WebsiteAuditReport | null;
  recentReports: Pick<
    WebsiteAuditReport,
    | 'reportId'
    | 'trigger'
    | 'generatedAtMs'
    | 'durationMs'
    | 'overallStatus'
    | 'executiveSummary'
    | 'completedChecksCount'
    | 'incompleteChecksCount'
    | 'dateKey'
  >[];
  trackedIssues: AuditIssueRecord[];
  telemetryEvents: SanitizedTelemetryEvent[];
}
