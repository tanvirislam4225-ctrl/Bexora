import { auth, fetchWithFreshBearerToken, getValidFirebaseIdToken } from './firebase';
import {
  AccountAppealRecord,
  ContentSurface,
  MediaInspectionItem,
  ModerationAlertRecord,
  ModerationAuditLogRecord,
  ModerationCategory,
  ModerationDecisionLevel,
  ModerationInspectionRequest,
  ModerationInspectionResult,
  ModerationPolicySettings,
  ModerationStrikeRecord,
  MonitoringHealthSnapshot,
  UserReportCategory,
  UserReportRecord,
  UserRestrictionRecord,
} from '../types/moderation';
import { evaluateTextDeterministically, PAUSED_CONVERSATION_NOTICE } from './moderationEngine';

export interface ReportModalTarget {
  reportedUserId: string;
  reportedUserName: string;
  surface: ContentSurface;
  listingId?: string;
  listingTitle?: string;
  dealId?: string;
  conversationId?: string;
  messageId?: string;
  reviewId?: string;
  quotedContent?: string;
  defaultCategory?: UserReportCategory;
}

export const USER_REPORT_CATEGORIES: Array<{
  value: UserReportCategory;
  label: string;
  hint: string;
}> = [
  {
    value: 'scam_fraud_attempt',
    label: 'Scam or Fraud Attempt',
    hint: 'Deceptive conduct, credential theft, or fraudulent representation.',
  },
  {
    value: 'payment_manipulation_off_platform',
    label: 'Off-Platform Payment or Escrow Bypass',
    hint: 'Pressuring to pay via WhatsApp, Telegram, bKash/crypto outside BEXORA Escrow.',
  },
  {
    value: 'fake_stolen_listing',
    label: 'Fake, Stolen, or Misrepresented Asset',
    hint: 'Forged analytics screenshots, stolen channel/page, or false ownership claim.',
  },
  {
    value: 'abusive_language_slurs',
    label: 'Abusive Language, Profanity, or Slurs',
    hint: 'Severe profanity or slurs in Bengali, Banglish, English, Hindi, Urdu, or mixed text.',
  },
  {
    value: 'harassment_bullying',
    label: 'Harassment or Bullying',
    hint: 'Targeted insults, repeated unwanted contact, or personal degradation.',
  },
  {
    value: 'threats_intimidation',
    label: 'Threats of Violence or Intimidation',
    hint: 'Threats of physical harm, doxxing, or account sabotage.',
  },
  {
    value: 'extortion_blackmail',
    label: 'Extortion, Coercion, or Blackmail',
    hint: 'Coercing early escrow release, ransom demands, or blackmail threats.',
  },
  {
    value: 'impersonation',
    label: 'Impersonation of Staff or Another Seller',
    hint: 'Pretending to be BEXORA Admin, Escrow Agent, or a verified creator.',
  },
  {
    value: 'hate_speech_discrimination',
    label: 'Hate Speech or Discrimination',
    hint: 'Attacks targeting religion, nationality, ethnicity, caste, or protected groups.',
  },
  {
    value: 'sexual_explicit_content',
    label: 'Sexually Explicit Content or Harassment',
    hint: 'Unsolicited explicit imagery, sexual remarks, or adult content.',
  },
  {
    value: 'violent_illegal_content',
    label: 'Violent, Dangerous, or Illegal Content',
    hint: 'Graphic violence, illegal goods, malware, or severe safety violations.',
  },
  {
    value: 'review_manipulation',
    label: 'Fake Reviews or Rating Manipulation',
    hint: 'Retaliatory review blackmail, coordinated fake ratings, or review bribery.',
  },
  {
    value: 'spam_bot_fake_engagement',
    label: 'Spam, Bot Activity, or Fake Engagement',
    hint: 'Repetitive spam messages, automated bots, or artificial bid manipulation.',
  },
  {
    value: 'suspicious_account_behavior',
    label: 'Other Suspicious Account Behavior',
    hint: 'Unusual risk signals warranting confidential Trust & Safety review.',
  },
];

export function formatModerationCategoryLabel(cat?: ModerationCategory | string): string {
  switch (cat) {
    case 'profanity_vulgarity':
      return 'Severe Profanity & Vulgarity';
    case 'sexual_harassment':
      return 'Sexual Harassment / Explicit Content';
    case 'violent_threat':
      return 'Violent Threat / Intimidation';
    case 'extortion_coercion':
      return 'Extortion / Coercive Escrow Pressure';
    case 'hate_speech':
      return 'Hate Speech & Discrimination';
    case 'scam_off_platform':
      return 'Off-Platform Scam / Escrow Bypass';
    case 'fraud_impersonation':
      return 'Fraud / Staff Impersonation';
    case 'child_safety_severe':
      return 'Critical Safety Violation';
    case 'spam_manipulation':
      return 'Spam / Platform Manipulation';
    case 'suspicious_conduct':
      return 'Suspicious Conduct';
    case 'clean':
      return 'Clean';
    default:
      return cat ? String(cat).replace(/_/g, ' ') : 'Policy Review';
  }
}

export function formatSurfaceLabel(surface: ContentSurface | string): string {
  switch (surface) {
    case 'public_profile':
      return 'Public Profile';
    case 'username_display_name':
      return 'Display Name / Handle';
    case 'listing_text':
      return 'Listing Text';
    case 'listing_media':
      return 'Listing Media';
    case 'pre_deal_chat':
      return 'Pre-Deal Chat';
    case 'deal_room_chat':
      return 'Escrow Deal Room';
    case 'review':
      return 'Seller Review';
    case 'user_report':
      return 'User Report';
    case 'account_appeal':
      return 'Account Appeal';
    default:
      return String(surface).replace(/_/g, ' ');
  }
}

async function getBearerHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (auth.currentUser) {
    const token = await getValidFirebaseIdToken(false);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

async function moderationApiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  return fetchWithFreshBearerToken(input, {
    ...init,
    headers: {
      ...baseHeaders,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function stripDataUrlPrefix(dataUrlOrBase64: string): { mimeType: string; base64Data: string } {
  const trimmed = String(dataUrlOrBase64 || '').trim();
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/s);
  if (match) {
    return {
      mimeType: match[1]!.trim().toLowerCase(),
      base64Data: match[2]!.replace(/\s+/g, ''),
    };
  }
  return {
    mimeType: 'image/jpeg',
    base64Data: trimmed.replace(/\s+/g, ''),
  };
}

/**
 * Samples up to `maxFrames` JPEG frames from a user-selected video file on an offscreen `<canvas>`
 * so server-side multimodal Trust & Safety can inspect video frames & visible on-screen text (OCR)
 * without uploading multi-megabyte raw video blobs into Firestore.
 */
export async function extractVideoFramesBase64(
  file: File,
  maxFrames = 4,
  maxDimension = 720
): Promise<Array<{ mimeType: string; base64Data: string; frameTimestampSec: number; fileName: string }>> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new Error('Video frame inspection requires a browser environment.');
  }
  const normalizedType = String(file.type || '').toLowerCase();
  if (!normalizedType.startsWith('video/') && !/\.(mp4|webm|mov)$/i.test(file.name)) {
    throw new Error('Unsupported video format. Please select an MP4, WebM, or MOV clip.');
  }
  if (file.size > 40 * 1024 * 1024) {
    throw new Error('Video clip exceeds the 40 MB safety inspection limit. Please select a shorter clip.');
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Timed out reading video metadata.')), 8000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Selected video file could not be decoded by the browser.'));
      };
      video.src = objectUrl;
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const count = Math.max(1, Math.min(maxFrames, Math.ceil(duration)));
    const timestamps: number[] = [];
    for (let i = 0; i < count; i++) {
      const ratio = count === 1 ? 0.2 : (i + 0.5) / count;
      timestamps.push(Math.min(Math.max(0.05, duration * ratio), Math.max(0.05, duration - 0.05)));
    }

    const frames: Array<{
      mimeType: string;
      base64Data: string;
      frameTimestampSec: number;
      fileName: string;
    }> = [];

    for (const ts of timestamps) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('Timed out sampling video frame.')), 6000);
        video.onseeked = () => {
          window.clearTimeout(timeout);
          resolve();
        };
        video.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error('Error seeking video stream during safety check.'));
        };
        video.currentTime = ts;
      });

      const rawW = video.videoWidth || 640;
      const rawH = video.videoHeight || 360;
      const scale = Math.min(1, maxDimension / Math.max(rawW, rawH));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rawW * scale));
      canvas.height = Math.max(1, Math.round(rawH * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
      const stripped = stripDataUrlPrefix(dataUrl);
      frames.push({
        mimeType: 'image/jpeg',
        base64Data: stripped.base64Data,
        frameTimestampSec: Math.round(ts * 10) / 10,
        fileName: `${file.name}@${ts.toFixed(1)}s.jpg`,
      });
    }

    if (frames.length === 0) {
      throw new Error('Could not extract readable frames from the selected video.');
    }
    return frames;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Inspects user-generated text via the server-side Trust & Safety engine (`/api/moderation/inspect`),
 * falling back to deterministic local multilingual moderation ONLY if the backend is unreachable (e.g. static host)
 * so severe Bengali/Banglish/English/Hindi/Urdu abuse and off-platform scam lures are still blocked reliably.
 */
export async function inspectTextClient(
  params: ModerationInspectionRequest & { callerName?: string }
): Promise<ModerationInspectionResult> {
  try {
    const res = await moderationApiFetch('/api/moderation/inspect', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = (await res.json()) as { ok?: boolean; result?: ModerationInspectionResult };
      if (data.ok && data.result) {
        return data.result;
      }
    }
  } catch {
    // Fallback to deterministic local evaluation below
  }

  const combined = [params.text || '', params.secondaryText || ''].filter(Boolean).join('\n');
  const local = evaluateTextDeterministically(combined, {
    surface: params.surface,
    isQuotedReportOrAppeal: params.isQuotedReportOrAppeal,
  });
  const allowed = local.decisionLevel === 'CLEAN' || local.decisionLevel === 'LEVEL_C';
  return {
    allowed,
    decisionLevel: local.decisionLevel,
    category: local.category,
    priority: local.priority,
    confidence: local.confidence,
    detectedLanguages: local.detectedLanguages,
    evasionSignals: local.evasionSignals,
    aiScanCompleted: false,
    mediaScanStatus: 'not_applicable',
    conversationPaused: local.shouldPauseConversation,
    pauseNotice: local.shouldPauseConversation ? PAUSED_CONVERSATION_NOTICE : undefined,
    userNoticeTitle: !allowed
      ? local.shouldPauseConversation
        ? 'CONVERSATION TEMPORARILY PAUSED'
        : 'CONTENT BLOCKED — COMMUNITY GUIDELINES VIOLATION'
      : undefined,
    userNoticeMessage: !allowed
      ? local.shouldPauseConversation
        ? PAUSED_CONVERSATION_NOTICE
        : 'Your submission contains prohibited abusive language, threats, or off-platform payment lures and cannot be posted on BEXORA.'
      : undefined,
    activeStrikes: 0,
    accountStatus: 'active',
  };
}

/**
 * Inspects uploaded images, sampled video frames, or voice notes via `/api/moderation/inspect-media`.
 * Never falsely claims `aiScanCompleted: true` when the server or Gemini API is unavailable.
 */
export async function inspectMediaClient(params: {
  eventKey?: string;
  surface: 'listing_media' | 'pre_deal_chat' | 'deal_room_chat' | 'public_profile';
  items: MediaInspectionItem[];
  callerName?: string;
  listingId?: string;
  dealId?: string;
  conversationId?: string;
}): Promise<ModerationInspectionResult> {
  try {
    const res = await moderationApiFetch('/api/moderation/inspect-media', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = (await res.json()) as { ok?: boolean; result?: ModerationInspectionResult };
      if (data.ok && data.result) {
        return data.result;
      }
    }
  } catch {
    // Fall through to honest unverified fallback
  }

  return {
    allowed: true,
    decisionLevel: 'CLEAN',
    category: 'clean',
    priority: 'LOW',
    confidence: 0,
    detectedLanguages: ['unknown'],
    evasionSignals: [],
    aiScanCompleted: false,
    mediaScanStatus: 'review_required',
    conversationPaused: false,
    activeStrikes: 0,
    accountStatus: 'active',
  };
}

export interface MyModerationStatusResponse {
  ok: boolean;
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
}

export async function fetchMyModerationStatus(): Promise<MyModerationStatusResponse | null> {
  if (!auth.currentUser) return null;
  try {
    const res = await moderationApiFetch('/api/moderation/my-status', {
      method: 'GET',
      cache: 'no-store',
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      return (await res.json()) as MyModerationStatusResponse;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

export async function acknowledgeModerationWarningClient(): Promise<UserRestrictionRecord | null> {
  if (!auth.currentUser) return null;
  try {
    const res = await moderationApiFetch('/api/moderation/acknowledge-warning', {
      method: 'POST',
    });
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      const data = (await res.json()) as { restriction?: UserRestrictionRecord | null };
      return data.restriction ?? null;
    }
  } catch {
    // Non-fatal
  }
  return null;
}

export async function submitUserReportClient(params: {
  reporterName: string;
  reportedUserId: string;
  reportedUserName: string;
  category: UserReportCategory;
  surface: ContentSurface;
  description: string;
  listingId?: string;
  dealId?: string;
  conversationId?: string;
  messageId?: string;
  reviewId?: string;
  quotedContent?: string;
  evidenceAttachments?: Array<{ mimeType: string; base64Data: string; fileName?: string }>;
}): Promise<{ ok: boolean; error?: string; report?: UserReportRecord }> {
  try {
    const res = await moderationApiFetch('/api/moderation/reports', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = (await res.json()) as { ok?: boolean; error?: string; report?: UserReportRecord };
      return {
        ok: Boolean(res.ok && data.ok),
        error: data.error,
        report: data.report,
      };
    }
    return { ok: false, error: `Report service returned HTTP ${res.status}.` };
  } catch {
    return { ok: false, error: 'Network error while submitting report. Please check your connection and retry.' };
  }
}

export async function submitAccountAppealClient(params: {
  callerName: string;
  explanation: string;
  supportingContext?: string;
}): Promise<{ ok: boolean; error?: string; appeal?: AccountAppealRecord }> {
  try {
    const res = await moderationApiFetch('/api/moderation/appeals', {
      method: 'POST',
      body: JSON.stringify(params),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const data = (await res.json()) as { ok?: boolean; error?: string; appeal?: AccountAppealRecord };
      return {
        ok: Boolean(res.ok && data.ok),
        error: data.error,
        appeal: data.appeal,
      };
    }
    return { ok: false, error: `Appeal service returned HTTP ${res.status}.` };
  } catch {
    return { ok: false, error: 'Network error while submitting appeal. Please try again.' };
  }
}

export interface AdminPausedConversationRecord {
  conversationId: string;
  surface: 'pre_deal_chat' | 'deal_room_chat';
  paused: boolean;
  reason: string;
  pausedAtMs: number;
  pausedBy: string;
  alertId?: string;
}

export interface AdminModerationOverviewResponse {
  ok: boolean;
  adminRole: 'admin' | 'superadmin';
  health: MonitoringHealthSnapshot;
  policy: ModerationPolicySettings;
  alerts: ModerationAlertRecord[];
  reports: UserReportRecord[];
  appeals: AccountAppealRecord[];
  restrictions: UserRestrictionRecord[];
  strikes: ModerationStrikeRecord[];
  pausedConversations: AdminPausedConversationRecord[];
  auditLogs: ModerationAuditLogRecord[];
}

export async function fetchAdminModerationOverview(): Promise<AdminModerationOverviewResponse> {
  const res = await moderationApiFetch('/api/admin/moderation/overview', {
    method: 'GET',
    cache: 'no-store',
  });
  const data = (await res.json()) as AdminModerationOverviewResponse & { error?: string };
  if (!res.ok || !data.ok) {
    throw new Error(data.error || 'Could not load Trust & Safety overview.');
  }
  return data;
}

export async function triggerAdminAlertAction(params: {
  alertId: string;
  action:
    | 'resume_conversation'
    | 'keep_paused'
    | 'quarantine_content'
    | 'issue_warning'
    | 'apply_strike'
    | 'dismiss_false_positive';
  reason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await moderationApiFetch('/api/admin/moderation/alert-action', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: Boolean(res.ok && data.ok), error: data.error };
}

export async function triggerAdminReportAction(params: {
  reportId: string;
  action:
    | 'mark_under_review'
    | 'assign_self'
    | 'add_internal_note'
    | 'request_info'
    | 'resolve_action_taken'
    | 'dismiss_report';
  noteOrReason: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await moderationApiFetch('/api/admin/moderation/report-action', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: Boolean(res.ok && data.ok), error: data.error };
}

export async function triggerAdminEnforceUserAction(params: {
  targetUserId: string;
  targetUserName?: string;
  targetUserEmail?: string;
  action:
    | 'update_granular_restrictions'
    | 'temporary_suspension'
    | 'permanent_ban'
    | 'unban_restore'
    | 'add_manual_strike'
    | 'reverse_strike'
    | 'apply_financial_hold'
    | 'release_financial_hold';
  reason: string;
  durationHours?: number;
  strikeIdToReverse?: string;
  granularFlags?: Partial<{
    restrictListings: boolean;
    restrictBidding: boolean;
    restrictPurchasing: boolean;
    restrictPreDealChat: boolean;
    restrictDealChat: boolean;
    restrictReviews: boolean;
    restrictProfileEdits: boolean;
    restrictWithdrawals: boolean;
  }>;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await moderationApiFetch('/api/admin/moderation/enforce', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: Boolean(res.ok && data.ok), error: data.error };
}

export async function triggerAdminAppealDecision(params: {
  appealId: string;
  decision: 'accept_restore' | 'accept_reverse_strike_and_restore' | 'request_info' | 'reject';
  decisionNote: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await moderationApiFetch('/api/admin/moderation/appeal-decision', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  const data = (await res.json()) as { ok?: boolean; error?: string };
  return { ok: Boolean(res.ok && data.ok), error: data.error };
}

export async function saveAdminModerationSettings(
  updates: Partial<ModerationPolicySettings>
): Promise<{ ok: boolean; policy?: ModerationPolicySettings; error?: string }> {
  const res = await moderationApiFetch('/api/admin/moderation/settings', {
    method: 'PUT',
    body: JSON.stringify(updates),
  });
  const data = (await res.json()) as { ok?: boolean; policy?: ModerationPolicySettings; error?: string };
  return { ok: Boolean(res.ok && data.ok), policy: data.policy, error: data.error };
}

export async function triggerAdminMonitorSweepNow(): Promise<{
  ok: boolean;
  health?: MonitoringHealthSnapshot;
}> {
  const res = await moderationApiFetch('/api/admin/moderation/sweep-now', {
    method: 'POST',
  });
  const data = (await res.json()) as { ok?: boolean; health?: MonitoringHealthSnapshot };
  return { ok: Boolean(res.ok && data.ok), health: data.health };
}

export interface SelfTestResultRow {
  name: string;
  passed: boolean;
  actualLevel: ModerationDecisionLevel;
  expectedLevel: string;
  category: ModerationCategory;
  pausedChat: boolean;
}

export async function runAdminModerationSelfTest(): Promise<{
  ok: boolean;
  allPassed: boolean;
  checkedAtMs: number;
  results: SelfTestResultRow[];
}> {
  const res = await moderationApiFetch('/api/admin/moderation/self-test', {
    method: 'POST',
  });
  const data = (await res.json()) as {
    ok?: boolean;
    allPassed?: boolean;
    checkedAtMs?: number;
    results?: SelfTestResultRow[];
  };
  return {
    ok: Boolean(res.ok && data.ok),
    allPassed: Boolean(data.allPassed),
    checkedAtMs: Number(data.checkedAtMs || Date.now()),
    results: Array.isArray(data.results) ? data.results : [],
  };
}
