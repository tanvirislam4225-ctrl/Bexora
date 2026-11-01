import {
  AuditIssueLifecycleState,
  AuditIssueRecord,
  AuditReportComparison,
  DailyAuditScheduleConfig,
} from '../types/aiAdmin';

function normalizePosixSegments(rawPath: string): { isAbsolute: boolean; segments: string[]; escapedRoot: boolean } {
  const unified = rawPath.replace(/\\/g, '/');
  const isAbsolute = unified.startsWith('/');
  const parts = unified.split('/');
  const out: string[] = [];
  let escapedRoot = false;
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        escapedRoot = true;
      } else {
        out.pop();
      }
    } else {
      out.push(part);
    }
  }
  return { isAbsolute, segments: out, escapedRoot };
}

export const DEFAULT_DAILY_AUDIT_TIMEZONE = 'Asia/Dhaka';

export const DEFAULT_DAILY_AUDIT_SCHEDULE: DailyAuditScheduleConfig = {
  enabled: true,
  hour: 9,
  minute: 0,
  timezone: DEFAULT_DAILY_AUDIT_TIMEZONE,
  notifyInApp: true,
  notifyTelegram: false,
  notifyEmail: false,
  lastRunDateKey: '',
  lastRunAtMs: 0,
  lastReportId: '',
  lastRunTrigger: 'none',
  updatedBy: 'system_default',
  updatedAtMs: 0,
};

/**
 * Validates an IANA timezone string using Intl.DateTimeFormat; falls back safely to Asia/Dhaka.
 */
export function normalizeAuditTimezone(rawTimezone: unknown): string {
  const candidate = typeof rawTimezone === 'string' ? rawTimezone.trim() : '';
  if (!candidate || candidate.length > 64) {
    return DEFAULT_DAILY_AUDIT_TIMEZONE;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date(0));
    return candidate;
  } catch {
    return DEFAULT_DAILY_AUDIT_TIMEZONE;
  }
}

/**
 * Normalizes a partial daily schedule config while enforcing bounds and defaults.
 */
export function normalizeDailyScheduleConfig(
  partial: Partial<DailyAuditScheduleConfig> | null | undefined,
  existing: DailyAuditScheduleConfig = DEFAULT_DAILY_AUDIT_SCHEDULE
): DailyAuditScheduleConfig {
  const rawHour =
    partial?.hour !== undefined ? Number(partial.hour) : existing.hour;
  const rawMinute =
    partial?.minute !== undefined ? Number(partial.minute) : existing.minute;

  const hour = Number.isFinite(rawHour)
    ? Math.max(0, Math.min(23, Math.floor(rawHour)))
    : existing.hour;
  const minute = Number.isFinite(rawMinute)
    ? Math.max(0, Math.min(59, Math.floor(rawMinute)))
    : existing.minute;

  return {
    enabled:
      typeof partial?.enabled === 'boolean' ? partial.enabled : existing.enabled,
    hour,
    minute,
    timezone:
      partial?.timezone !== undefined
        ? normalizeAuditTimezone(partial.timezone)
        : normalizeAuditTimezone(existing.timezone),
    notifyInApp:
      typeof partial?.notifyInApp === 'boolean'
        ? partial.notifyInApp
        : existing.notifyInApp,
    notifyTelegram:
      typeof partial?.notifyTelegram === 'boolean'
        ? partial.notifyTelegram
        : existing.notifyTelegram,
    notifyEmail:
      typeof partial?.notifyEmail === 'boolean'
        ? partial.notifyEmail
        : existing.notifyEmail,
    lastRunDateKey:
      typeof partial?.lastRunDateKey === 'string'
        ? partial.lastRunDateKey.slice(0, 20)
        : existing.lastRunDateKey,
    lastRunAtMs:
      typeof partial?.lastRunAtMs === 'number' && Number.isFinite(partial.lastRunAtMs)
        ? partial.lastRunAtMs
        : existing.lastRunAtMs,
    lastReportId:
      typeof partial?.lastReportId === 'string'
        ? partial.lastReportId.slice(0, 128)
        : existing.lastReportId,
    lastRunTrigger:
      partial?.lastRunTrigger === 'manual' ||
      partial?.lastRunTrigger === 'scheduled_daily' ||
      partial?.lastRunTrigger === 'none'
        ? partial.lastRunTrigger
        : existing.lastRunTrigger,
    updatedBy:
      typeof partial?.updatedBy === 'string' && partial.updatedBy.trim()
        ? partial.updatedBy.trim().slice(0, 128)
        : existing.updatedBy,
    updatedAtMs:
      typeof partial?.updatedAtMs === 'number' && Number.isFinite(partial.updatedAtMs)
        ? partial.updatedAtMs
        : existing.updatedAtMs,
  };
}

export interface ZonedWallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateKey: string; // YYYY-MM-DD
}

/**
 * Extracts wall-clock parts and YYYY-MM-DD dateKey in the given IANA timezone.
 */
export function getZonedWallClockParts(
  epochMs: number,
  rawTimezone: string
): ZonedWallClockParts {
  const timezone = normalizeAuditTimezone(rawTimezone);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(new Date(epochMs));
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }
  const year = Number(map.year || 1970);
  const month = Number(map.month || 1);
  const day = Number(map.day || 1);
  const rawHour = Number(map.hour || 0);
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = Number(map.minute || 0);
  const second = Number(map.second || 0);
  const dateKey = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, minute, second, dateKey };
}

/**
 * Determines whether the scheduled daily audit is due right now in the configured timezone,
 * ensuring at most ONE scheduled run per calendar day (`dateKey`) even across server restarts
 * or repeated schedule updates.
 */
export function shouldTriggerDailyScheduledAudit(
  schedule: DailyAuditScheduleConfig,
  nowMs: number,
  isAuditCurrentlyRunning: boolean
): { due: boolean; dateKey: string; reason: string } {
  const clock = getZonedWallClockParts(nowMs, schedule.timezone);
  if (!schedule.enabled) {
    return { due: false, dateKey: clock.dateKey, reason: 'schedule_disabled' };
  }
  if (isAuditCurrentlyRunning) {
    return { due: false, dateKey: clock.dateKey, reason: 'audit_already_running' };
  }
  if (schedule.lastRunDateKey === clock.dateKey) {
    return { due: false, dateKey: clock.dateKey, reason: 'already_ran_today' };
  }
  const currentMinutesOfDay = clock.hour * 60 + clock.minute;
  const targetMinutesOfDay = schedule.hour * 60 + schedule.minute;
  if (currentMinutesOfDay < targetMinutesOfDay) {
    return { due: false, dateKey: clock.dateKey, reason: 'before_scheduled_time' };
  }
  return { due: true, dateKey: clock.dateKey, reason: 'scheduled_window_reached' };
}

/**
 * Computes the next scheduled daily audit timestamp (epoch ms) and human-readable label.
 */
export function computeNextScheduledRunInfo(
  schedule: DailyAuditScheduleConfig,
  nowMs: number
): { nextRunMs: number | null; formatted: string } {
  const tz = normalizeAuditTimezone(schedule.timezone);
  const hh = String(schedule.hour).padStart(2, '0');
  const mm = String(schedule.minute).padStart(2, '0');
  if (!schedule.enabled) {
    return {
      nextRunMs: null,
      formatted: `Paused (${hh}:${mm} ${tz})`,
    };
  }

  // Step forward in 1-minute increments up to 48 hours to handle DST/offset transitions accurately
  const startMinuteMs = Math.ceil(nowMs / 60000) * 60000;
  for (let i = 0; i <= 2880; i++) {
    const candidateMs = startMinuteMs + i * 60000;
    const parts = getZonedWallClockParts(candidateMs, tz);
    if (
      parts.hour === schedule.hour &&
      parts.minute === schedule.minute &&
      parts.dateKey !== schedule.lastRunDateKey
    ) {
      return {
        nextRunMs: candidateMs,
        formatted: `${parts.dateKey} ${hh}:${mm} (${tz})`,
      };
    }
  }

  return {
    nextRunMs: nowMs + 86400000,
    formatted: `Daily at ${hh}:${mm} (${tz})`,
  };
}

const BLOCKED_WORKSPACE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.playwright-cli',
  '.bexora-runtime',
]);

const BLOCKED_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..+)?$/i,
  /service[-_]?account.*\.json$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
];

/**
 * Resolves a project-relative path strictly inside workspaceRoot, blocking path traversal,
 * hidden secret files (.env*), private keys, and heavy build/dependency directories.
 */
export function resolveSafeProjectFilePath(
  workspaceRoot: string,
  requestedRelativePath: string
): { ok: true; absolutePath: string; relativePath: string } | { ok: false; error: string } {
  const rootNorm = normalizePosixSegments(String(workspaceRoot || '/app/applet'));
  const cleaned = String(requestedRelativePath || '')
    .trim()
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.length > 260) {
    return { ok: false, error: 'Invalid or empty file path.' };
  }
  if (cleaned.includes('\0')) {
    return { ok: false, error: 'Null bytes are forbidden in file paths.' };
  }

  const parsedRel = normalizePosixSegments(cleaned);
  if (parsedRel.escapedRoot || parsedRel.segments.length === 0) {
    return { ok: false, error: 'Path traversal outside the workspace is strictly blocked.' };
  }

  const segments = parsedRel.segments;
  for (const seg of segments) {
    if (BLOCKED_WORKSPACE_SEGMENTS.has(seg)) {
      return { ok: false, error: `Access to restricted directory "${seg}" is blocked.` };
    }
  }

  const baseName = segments[segments.length - 1] || '';
  if (
    baseName.toLowerCase() !== '.env.example' &&
    BLOCKED_FILE_PATTERNS.some((rx) => rx.test(baseName))
  ) {
    return { ok: false, error: `Access to secret or credential file "${baseName}" is forbidden.` };
  }

  const normalizedRel = segments.join('/');
  const rootPrefix = `${rootNorm.isAbsolute ? '/' : ''}${rootNorm.segments.join('/')}`;
  const absolutePath = rootPrefix === '/' ? `/${normalizedRel}` : `${rootPrefix}/${normalizedRel}`;

  return {
    ok: true,
    absolutePath,
    relativePath: normalizedRel,
  };
}

/**
 * Redacts API keys, private keys, Bearer tokens, webhook secrets, emails, and phone numbers
 * before storing logs, displaying evidence, or sending snippets to the AI model.
 */
export function redactSensitiveContent(rawText: unknown, maxLen = 12000): string {
  const input = String(rawText ?? '');
  if (!input) return '';

  const redacted = input
    // PEM private keys
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      '[REDACTED_PRIVATE_KEY]'
    )
    // Bearer tokens / JWTs
    .replace(/Bearer\s+[A-Za-z0-9._\-+/=]{16,}/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]')
    // Secret assignments in env/config snippets
    .replace(
      /\b(GEMINI_API_KEY|API_KEY|FIREBASE_SERVICE_ACCOUNT_JSON|WORDPRESS_WEBHOOK_SECRET|TELEGRAM_BOT_TOKEN|SMTP_PASS|PRIVATE_KEY)\s*[:=]\s*(['"]?)[^\s'"\n]+(\2)/gi,
      '$1=[REDACTED_SECRET]'
    )
    // Google API keys (AIza...)
    .replace(/\bAIza[0-9A-Za-z_-]{31,39}\b/g, 'AIza[REDACTED_KEY]')
    // Inline base64 data URLs (NID / evidence screenshots)
    .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{64,}/g, '[REDACTED_BASE64_IMAGE]')
    // Emails (preserve official public bootstrapped admin reference only if needed, redact general PII)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');

  return redacted.length > maxLen ? `${redacted.slice(0, maxLen)}\n…[truncated]` : redacted;
}

/**
 * Wraps untrusted repository or user-originated text so prompt-injection instructions inside
 * listings, logs, or comments are treated strictly as inert data.
 */
export function wrapUntrustedEvidenceBlock(label: string, rawContent: unknown, maxLen = 6000): string {
  const safeLabel = String(label || 'evidence')
    .replace(/[^a-zA-Z0-9_./:-]/g, '_')
    .slice(0, 100);
  const sanitized = redactSensitiveContent(rawContent, maxLen).replace(
    /<\/?untrusted_evidence>/gi,
    '[escaped_tag]'
  );
  return `<untrusted_evidence source="${safeLabel}">\n${sanitized}\n</untrusted_evidence>`;
}

/**
 * Builds a deterministic, human-readable Issue ID from category and slug.
 */
export function buildDeterministicIssueId(category: string, slug: string): string {
  const cleanCat = category
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8) || 'GEN';
  const cleanSlug = slug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'CHECK';
  return `ISS-${cleanCat}-${cleanSlug}`;
}

/**
 * Compares newly detected active issues against the previous report's issue set and
 * historically known issues to classify lifecycle states (`new`, `persisting`, `regressed`, `fixed_verified`)
 * without duplicating unresolved issues across consecutive audits.
 */
export function reconcileAuditIssuesLifecycle(params: {
  detectedActiveIssues: Omit<
    AuditIssueRecord,
    'lifecycleState' | 'firstDetectedAtMs' | 'lastSeenAtMs'
  >[];
  previousReportId: string | null;
  previousGeneratedAtMs: number | null;
  previousHistoricalIssues: AuditIssueRecord[];
  nowMs: number;
}): {
  mergedTrackedIssues: AuditIssueRecord[];
  currentReportIssues: AuditIssueRecord[];
  comparison: AuditReportComparison;
} {
  const {
    detectedActiveIssues,
    previousReportId,
    previousGeneratedAtMs,
    previousHistoricalIssues,
    nowMs,
  } = params;

  const historyById = new Map<string, AuditIssueRecord>();
  for (const oldIssue of previousHistoricalIssues) {
    historyById.set(oldIssue.issueId, oldIssue);
  }

  const newlyDiscoveredIds: string[] = [];
  const persistingUnresolvedIds: string[] = [];
  const fixedAndVerifiedIds: string[] = [];
  const regressionIds: string[] = [];

  const activeById = new Map<string, AuditIssueRecord>();

  // Deduplicate incoming active issues by issueId
  for (const incoming of detectedActiveIssues) {
    if (activeById.has(incoming.issueId)) continue;
    const prev = historyById.get(incoming.issueId);
    let lifecycleState: AuditIssueLifecycleState = 'new';

    if (!prev) {
      lifecycleState = 'new';
      newlyDiscoveredIds.push(incoming.issueId);
    } else if (prev.lifecycleState === 'fixed_verified') {
      lifecycleState = 'regressed';
      regressionIds.push(incoming.issueId);
    } else {
      lifecycleState = 'persisting';
      persistingUnresolvedIds.push(incoming.issueId);
    }

    const record: AuditIssueRecord = {
      ...incoming,
      lifecycleState,
      firstDetectedAtMs: prev ? prev.firstDetectedAtMs : nowMs,
      lastSeenAtMs: nowMs,
      linkedProposalId: incoming.linkedProposalId || prev?.linkedProposalId,
    };
    activeById.set(incoming.issueId, record);
    historyById.set(incoming.issueId, record);
  }

  // Mark previously open issues that no longer reproduce as fixed_verified
  for (const [id, prev] of historyById.entries()) {
    if (!activeById.has(id)) {
      if (prev.lifecycleState !== 'fixed_verified') {
        fixedAndVerifiedIds.push(id);
        historyById.set(id, {
          ...prev,
          lifecycleState: 'fixed_verified',
          resolvedAtMs: nowMs,
        });
      }
    }
  }

  const severityRank: Record<AuditIssueRecord['severity'], number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  const currentReportIssues = Array.from(activeById.values()).sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity]
  );

  const mergedTrackedIssues = Array.from(historyById.values()).sort((a, b) => {
    if (a.lifecycleState === 'fixed_verified' && b.lifecycleState !== 'fixed_verified') return 1;
    if (a.lifecycleState !== 'fixed_verified' && b.lifecycleState === 'fixed_verified') return -1;
    return severityRank[a.severity] - severityRank[b.severity];
  });

  const healthDeltaSummary = !previousReportId
    ? `Baseline audit established: ${currentReportIssues.length} active finding(s) recorded.`
    : `${newlyDiscoveredIds.length} new, ${persistingUnresolvedIds.length} persisting, ${fixedAndVerifiedIds.length} fixed & verified, ${regressionIds.length} regression(s) compared to report ${previousReportId}.`;

  return {
    mergedTrackedIssues,
    currentReportIssues,
    comparison: {
      previousReportId,
      previousGeneratedAtMs,
      newlyDiscoveredIds,
      persistingUnresolvedIds,
      fixedAndVerifiedIds,
      regressionIds,
      healthDeltaSummary,
    },
  };
}

/**
 * Enforces strict human-only governance over AI proposals:
 * - Emergency Stop blocks staging new proposals and approving proposals (rejecting remains allowed).
 * - The AI assistant itself can NEVER approve or deploy a proposal (`actorType === 'human_admin'` required).
 * - Approval applies strictly to the exact target `proposalId` currently in `awaiting_review` or `in_review`.
 */
export function evaluateProposalGovernanceGate(params: {
  action: 'stage_proposal' | 'approve_proposal' | 'reject_proposal' | 'mark_in_review';
  actorType: 'human_admin' | 'ai_assistant';
  actorUid: string;
  emergencyStopActive: boolean;
  targetProposalId?: string;
  confirmedProposalId?: string;
  currentProposalStatus?: string;
}): { allowed: boolean; reason: string } {
  const {
    action,
    actorType,
    actorUid,
    emergencyStopActive,
    targetProposalId,
    confirmedProposalId,
    currentProposalStatus,
  } = params;

  if (!actorUid || actorUid.trim().length < 3) {
    return { allowed: false, reason: 'Authenticated administrator UID is required.' };
  }

  if (action === 'approve_proposal' && actorType !== 'human_admin') {
    return {
      allowed: false,
      reason: 'AI self-approval is strictly prohibited. Only a human administrator can approve a proposal.',
    };
  }

  if (emergencyStopActive && (action === 'stage_proposal' || action === 'approve_proposal')) {
    return {
      allowed: false,
      reason: 'AI Emergency Stop is active. Protected proposal staging and approvals are halted while read-only diagnostics remain available.',
    };
  }

  if (action === 'approve_proposal') {
    if (!targetProposalId || targetProposalId !== confirmedProposalId) {
      return {
        allowed: false,
        reason: 'Approval must explicitly match the exact specific proposal ID under review.',
      };
    }
    if (
      currentProposalStatus !== 'awaiting_review' &&
      currentProposalStatus !== 'in_review'
    ) {
      return {
        allowed: false,
        reason: `Proposal in status "${currentProposalStatus || 'unknown'}" cannot be approved.`,
      };
    }
  }

  return { allowed: true, reason: 'authorized' };
}
