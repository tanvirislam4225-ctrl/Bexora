export type ModerationLanguage =
  | 'bn'
  | 'banglish'
  | 'en'
  | 'hi'
  | 'ur'
  | 'roman_hi_ur'
  | 'mixed'
  | 'unknown';

export type ModerationCategory =
  | 'profanity_vulgarity'
  | 'sexual_harassment'
  | 'violent_threat'
  | 'extortion_coercion'
  | 'hate_speech'
  | 'scam_off_platform'
  | 'fraud_impersonation'
  | 'child_safety_severe'
  | 'spam_manipulation'
  | 'suspicious_conduct'
  | 'clean';

export type ModerationDecisionLevel = 'LEVEL_A' | 'LEVEL_B' | 'LEVEL_C' | 'CLEAN';

export type AlertPriority = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type AccountEnforcementStatus =
  | 'active'
  | 'warned'
  | 'restricted'
  | 'temporary_suspension'
  | 'protective_suspension'
  | 'permanent_ban';

export type ContentSurface =
  | 'public_profile'
  | 'username_display_name'
  | 'listing_text'
  | 'listing_media'
  | 'pre_deal_chat'
  | 'deal_room_chat'
  | 'review'
  | 'user_report'
  | 'account_appeal';

export type MediaScanStatus =
  | 'not_applicable'
  | 'approved'
  | 'quarantined'
  | 'review_required'
  | 'blocked';

export type UserReportCategory =
  | 'abusive_language_slurs'
  | 'harassment_bullying'
  | 'threats_intimidation'
  | 'scam_fraud_attempt'
  | 'fake_stolen_listing'
  | 'payment_manipulation_off_platform'
  | 'impersonation'
  | 'hate_speech_discrimination'
  | 'sexual_explicit_content'
  | 'violent_illegal_content'
  | 'extortion_blackmail'
  | 'spam_bot_fake_engagement'
  | 'review_manipulation'
  | 'suspicious_account_behavior';

export interface ModerationStrikeRecord {
  id: string;
  eventKey: string;
  userId: string;
  strikeNumber: 1 | 2 | 3;
  category: ModerationCategory;
  surface: ContentSurface;
  summary: string;
  evidenceSnippet: string;
  issuedBy: 'ai_protective_system' | 'human_admin';
  adminId?: string;
  reversed?: boolean;
  reversedAtMs?: number;
  reversedByAdminId?: string;
  reversalReason?: string;
  createdAtMs: number;
}

export interface UserRestrictionRecord {
  userId: string;
  userEmail?: string;
  userDisplayName?: string;
  accountStatus: AccountEnforcementStatus;
  activeStrikes: number;
  totalHistoricalStrikes: number;
  latestWarningTitle?: string;
  latestWarningMessage?: string;
  latestCategory?: ModerationCategory;
  restrictListings: boolean;
  restrictBidding: boolean;
  restrictPurchasing: boolean;
  restrictPreDealChat: boolean;
  restrictDealChat: boolean;
  restrictReviews: boolean;
  restrictProfileEdits: boolean;
  restrictWithdrawals: boolean;
  financialHoldActive: boolean;
  financialHoldReason?: string;
  requiresHumanPermanentBanReview: boolean;
  reason: string;
  enforcedBy: 'ai_protective_system' | 'human_admin';
  enforcedByAdminId?: string;
  expiresAtMs: number; // 0 means indefinite until human review / appeal
  acknowledgedWarningAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ModerationAlertRecord {
  id: string;
  eventKey: string;
  priority: AlertPriority;
  decisionLevel: ModerationDecisionLevel;
  status: 'open' | 'investigating' | 'resolved' | 'false_positive' | 'escalated';
  surface: ContentSurface;
  category: ModerationCategory;
  detectedLanguages: ModerationLanguage[];
  confidence: number;
  aiScanCompleted: boolean;
  mediaScanStatus: MediaScanStatus;
  userId: string;
  userName?: string;
  userEmail?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  listingId?: string;
  dealId?: string;
  conversationId?: string;
  messageId?: string;
  reviewId?: string;
  rawContent: string;
  normalizedPreview: string;
  ocrExtractedText?: string;
  audioTranscript?: string;
  evasionSignals: string[];
  aiReasoning: string;
  aiRecommendation: string;
  protectiveActionTaken: string;
  conversationPaused: boolean;
  strikeIssuedNumber?: number;
  humanFinalDecision?: string;
  reviewedByAdminId?: string;
  reviewedByAdminEmail?: string;
  reviewedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface UserReportRecord {
  id: string;
  trackingRef: string;
  reporterId: string;
  reporterName: string;
  reporterEmail?: string;
  reportedUserId: string;
  reportedUserName: string;
  category: UserReportCategory;
  surface: ContentSurface;
  description: string;
  evidenceAttachmentCount: number;
  evidenceAttachmentSummaries: string[];
  listingId?: string;
  dealId?: string;
  conversationId?: string;
  messageId?: string;
  reviewId?: string;
  quotedContent?: string;
  aiTriagePriority: AlertPriority;
  aiTriageSummary: string;
  aiSuggestedCategory: ModerationCategory;
  status: 'submitted' | 'under_review' | 'action_taken' | 'dismissed' | 'needs_info';
  assignedAdminId?: string;
  assignedAdminEmail?: string;
  internalAdminNotes: Array<{
    id: string;
    adminId: string;
    adminEmail: string;
    note: string;
    createdAtMs: number;
  }>;
  resolutionSummaryForReporter?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface AccountAppealRecord {
  id: string;
  trackingRef: string;
  userId: string;
  userName: string;
  userEmail?: string;
  accountStatusAtSubmission: AccountEnforcementStatus;
  activeStrikesAtSubmission: number;
  explanation: string;
  supportingContext?: string;
  status: 'pending' | 'under_review' | 'accepted' | 'rejected' | 'info_requested';
  adminDecisionNote?: string;
  reviewedByAdminId?: string;
  reviewedByAdminEmail?: string;
  reviewedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface ModerationAuditLogRecord {
  id: string;
  actorType: 'ai_protective_system' | 'human_admin' | 'human_superadmin';
  actorId: string;
  actorEmail?: string;
  targetUserId: string;
  targetUserName?: string;
  actionType:
    | 'content_blocked'
    | 'media_quarantined'
    | 'conversation_paused'
    | 'conversation_resumed'
    | 'strike_recorded'
    | 'strike_reversed'
    | 'protective_suspension_applied'
    | 'temporary_suspension_applied'
    | 'permanent_ban_applied'
    | 'account_unbanned'
    | 'granular_restriction_updated'
    | 'financial_hold_applied'
    | 'financial_hold_released'
    | 'report_resolved'
    | 'appeal_decided'
    | 'policy_settings_updated';
  reason: string;
  relatedAlertId?: string;
  relatedReportId?: string;
  relatedAppealId?: string;
  relatedConversationId?: string;
  previousStateSummary?: string;
  newStateSummary?: string;
  createdAtMs: number;
}

export interface ModerationPolicySettings {
  enabledLanguages: ModerationLanguage[];
  strictProfanityBlocking: boolean;
  blockOffPlatformScamLures: boolean;
  autoPauseSuspiciousChats: boolean;
  requireMediaAiVerification: boolean;
  failSafeQuarantineUncertainMedia: boolean;
  levelAConfidenceThreshold: number;
  levelBConfidenceThreshold: number;
  maxStrikesBeforeProtectiveSuspension: number;
  protectiveSuspensionDurationHours: number; // 0 = until human admin review
  reportRateLimitPerHour: number;
  appealCooldownHours: number;
  firstWarningTemplate: string;
  finalWarningTemplate: string;
  protectiveSuspensionTemplate: string;
  updatedAtMs: number;
  updatedByAdminEmail?: string;
}

export interface MonitoringRetryJob {
  id: string;
  eventKey: string;
  kind: 'text_contextual_recheck' | 'media_multimodal_scan';
  surface: ContentSurface;
  userId: string;
  userName?: string;
  listingId?: string;
  conversationId?: string;
  dealId?: string;
  rawText?: string;
  mediaMimeType?: string;
  mediaBase64Preview?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAtMs: number;
  lastError?: string;
  createdAtMs: number;
}

export interface MonitoringHealthSnapshot {
  monitorActive: boolean;
  aiEngineStatus: 'operational' | 'degraded_fallback' | 'unconfigured_fallback';
  backgroundWorkerIntervalSec: number;
  lastBackgroundSweepAtMs: number;
  lastEventProcessedAtMs: number;
  totalEventsInspected: number;
  confirmedViolationsCount: number;
  suspiciousPausedConversationsCount: number;
  quarantinedMediaCount: number;
  openCriticalHighAlertsCount: number;
  openUserReportsCount: number;
  pendingAppealsCount: number;
  pendingRetryJobsCount: number;
  failedJobsCount: number;
  lastOperationalError?: string;
}

export interface ModerationInspectionRequest {
  eventKey?: string;
  surface: ContentSurface;
  text?: string;
  secondaryText?: string;
  listingId?: string;
  dealId?: string;
  conversationId?: string;
  messageId?: string;
  reviewId?: string;
  counterpartyId?: string;
  counterpartyName?: string;
  isQuotedReportOrAppeal?: boolean;
}

export interface MediaInspectionItem {
  id: string;
  kind: 'image' | 'video_frame' | 'audio';
  mimeType: string;
  base64Data: string;
  fileName?: string;
  frameTimestampSec?: number;
}

export interface ModerationInspectionResult {
  allowed: boolean;
  decisionLevel: ModerationDecisionLevel;
  category: ModerationCategory;
  priority: AlertPriority;
  confidence: number;
  detectedLanguages: ModerationLanguage[];
  evasionSignals: string[];
  aiScanCompleted: boolean;
  mediaScanStatus: MediaScanStatus;
  conversationPaused: boolean;
  pauseNotice?: string;
  userNoticeTitle?: string;
  userNoticeMessage?: string;
  strikeIssuedNumber?: number;
  activeStrikes: number;
  accountStatus: AccountEnforcementStatus;
  alertId?: string;
  ocrExtractedText?: string;
  audioTranscript?: string;
}
