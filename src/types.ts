export type PlatformId =
  | 'youtube'
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'telegram'
  | 'website'
  | 'domain'
  | 'gaming';

export type CurrencyCode = 'BDT' | 'USD';
export type LanguageCode = 'en' | 'bn' | 'hi' | 'ar' | 'ur';
export type ThemeMode = 'light' | 'dark';

export type MonetizationStatus = 'monetized' | 'non-monetized' | 'not_applicable';

export type VerificationState =
  | 'not_claimed'
  | 'submitted_for_verification'
  | 'in_review'
  | 'active_verified'
  | 'eligible_not_active'
  | 'rejected'
  | 'unable_to_verify';

export type ListingStatus =
  | 'draft'
  | 'pending'
  | 'active'
  | 'reserved'
  | 'sold'
  | 'rejected'
  | 'suspended'
  | 'archived';

export type DealStatus =
  | 'accepted_pending_payment'
  | 'awaiting_payment'
  | 'payment_pending_verification'
  | 'paid_deal_room_active'
  | 'paid'
  | 'transfer_in_progress'
  | 'transfer_submitted'
  | 'awaiting_buyer_confirmation'
  | 'transfer_rejected'
  | 'security_period_active'
  | 'protection_active'
  | 'reported_under_review'
  | 'protection_expired'
  | 'refunded'
  | 'settled'
  | 'cancelled';

export type BidStatus =
  | 'pending'
  | 'accepted_pending_payment'
  | 'accepted'
  | 'paid'
  | 'rejected'
  | 'withdrawn'
  | 'expired'
  | 'cancelled';

export type NidVerificationStatus = 'not_verified' | 'pending_review' | 'verified' | 'rejected';

export interface PublicProfile {
  uid: string;
  displayName: string;
  username: string;
  bio: string;
  avatarUrl?: string;
  coverUrl?: string;
  location?: string;
  nidVerified: boolean;
  completedTrader: boolean;
  completedSales: number;
  completedPurchases: number;
  ratingSum: number;
  ratingCount: number;
  followerCount?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface PrivateUser {
  uid: string;
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  nidStatus: NidVerificationStatus;
  nidRejectionReason?: string;
  walletBalanceMinor: number;
  reservedBalanceMinor: number;
  preferredLanguage?: LanguageCode;
  preferredCurrency?: CurrencyCode;
  notificationPrefs?: UserNotificationPreferences;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface IdentityVerificationRecord {
  uid: string;
  frontImageData: string;
  backImageData: string;
  status: 'pending_review' | 'verified' | 'rejected';
  rejectionReason?: string;
  reviewedBy?: string;
  submittedAt?: unknown;
  updatedAt?: unknown;
}

export interface MarketplaceListing {
  id: string;
  sellerId: string;
  sellerName: string;
  sellerUsername: string;
  sellerVerified: boolean;
  platform: PlatformId;
  subcategory: string;
  title: string;
  description: string;
  priceMinor: number; // Stored in integer minor units (100 paisa = 1 BDT)
  currency: CurrencyCode;
  monetizationStatus: MonetizationStatus;
  claimedOptions: string[];
  verifiedOptions: string[];
  verificationState: VerificationState;
  ageYears: number;
  ageMonths: number;
  metricValue: number;
  monthlyRevenueMinor: number;
  accountUrl: string;
  urlValidationStatus: 'domain_matched' | 'not_applicable';
  gameName?: string;
  gameUid?: string;
  gameLevel?: number;
  images: string[];
  activeDealId?: string;
  acceptedBidAmountMinor?: number;
  reservedBuyerId?: string;
  status: ListingStatus;
  rejectionReason?: string;
  views: number;
  firstPublishedAtMs?: number;
  createdAtMs: number;
}

export interface FavoriteRecord {
  id: string;
  userId: string;
  listingId: string;
  sellerId: string;
  sellerName: string;
  sellerUsername: string;
  title: string;
  platform: PlatformId;
  subcategory: string;
  priceMinor: number;
  currency: CurrencyCode;
  thumbnailUrl?: string;
  createdAtMs: number;
}

export interface SellerFollowRecord {
  id: string;
  followerId: string;
  sellerId: string;
  sellerName: string;
  sellerUsername: string;
  sellerAvatarUrl?: string;
  sellerVerified: boolean;
  createdAtMs: number;
}

export interface BidRecord {
  id: string;
  listingId: string;
  sellerId: string;
  buyerId: string;
  buyerName: string;
  buyerUsername: string;
  buyerVerified: boolean;
  amountMinor: number;
  currency: CurrencyCode;
  status: BidStatus;
  dealId?: string;
  createdAtMs: number;
}

export interface ConversationRecord {
  id: string;
  buyerId: string;
  sellerId: string;
  buyerName: string;
  sellerName: string;
  listingId: string;
  listingTitle: string;
  lastMessage: string;
  safetyAcceptedByBuyer: boolean;
  safetyAcceptedBySeller: boolean;
  updatedAtMs: number;
}

export interface ChatMessageRecord {
  id: string;
  senderId: string;
  senderName: string;
  senderRole?: 'buyer' | 'seller' | 'admin' | 'system';
  kind: 'text' | 'image' | 'voice' | 'system';
  text: string;
  mediaData?: string;
  createdAtMs: number;
}

export interface DealRecord {
  id: string;
  listingId: string;
  listingTitle: string;
  platform: PlatformId;
  buyerId: string;
  buyerName: string;
  sellerId: string;
  sellerName: string;
  acceptedBidId?: string;
  originalListingPriceMinor?: number;
  baseAmountMinor: number;
  buyerFeePct: number;
  sellerFeePct: number;
  buyerFeeMinor: number;
  sellerFeeMinor: number;
  buyerTotalMinor: number;
  sellerPayoutMinor: number;
  platformCommissionMinor: number;
  refundBuyerMinor?: number;
  refundPlatformRetainedMinor?: number;
  currency: CurrencyCode;
  protectionDurationHours: number;
  confirmedAtMs: number;
  originalDeadlineMs: number;
  unresolvedReportCount: number;
  paymentLedgerId?: string;
  paidAtMs?: number;
  transferSubmissionCount?: number;
  latestTransferSubmissionId?: string;
  latestRejectionReason?: string;
  refundLedgerId?: string;
  settlementLedgerId?: string;
  adminHoldNote?: string;
  settledAtMs?: number;
  refundedAtMs?: number;
  status: DealStatus;
  createdAtMs: number;
}

export interface DealTransferSubmission {
  id: string;
  dealId: string;
  sellerId: string;
  sellerName: string;
  version: number;
  screenshots: string[];
  transferNote: string;
  completedSteps: string[];
  status: 'submitted' | 'approved' | 'rejected';
  buyerDecisionBy?: string;
  buyerDecisionReason?: string;
  buyerDecisionNote?: string;
  decidedAtMs?: number;
  submittedAtMs?: number;
  createdAtMs: number;
}

export type DealReportCategory =
  | 'credentials_invalid'
  | 'ownership_not_transferred'
  | 'monetization_mismatch'
  | 'account_recovered_by_seller'
  | 'buyer_unresponsive'
  | 'other';

export interface DealReportRecord {
  id: string;
  dealId: string;
  dealReference?: string;
  reporterId: string;
  reporterName?: string;
  reporterRole: 'buyer' | 'seller';
  category?: DealReportCategory;
  reason: string;
  evidenceImages?: string[];
  status:
    | 'open'
    | 'evidence_requested'
    | 'rejected_resumed'
    | 'resolved_refund'
    | 'resolved_release';
  adminDecisionNote?: string;
  decidedBy?: string;
  decidedAtMs?: number;
  createdAtMs: number;
}

export interface DealAuditEvent {
  id: string;
  dealId: string;
  actorId: string;
  actorName: string;
  actorRole: 'buyer' | 'seller' | 'admin' | 'system';
  eventType: string;
  summary: string;
  createdAtMs: number;
}

export interface DepositRequestRecord {
  id: string;
  userId: string;
  userName: string;
  method: 'bkash' | 'nagad' | 'rocket';
  amountMinor: number;
  currency: 'BDT';
  senderNumber: string;
  transactionId: string;
  screenshotData?: string;
  status: 'pending' | 'approved' | 'rejected';
  rejectionReason?: string;
  reviewedBy?: string;
  createdAtMs: number;
}

export interface WithdrawalRequestRecord {
  id: string;
  userId: string;
  userName: string;
  method: 'bkash' | 'nagad' | 'rocket' | 'bank';
  payoutAccount: string;
  amountMinor: number;
  currency: CurrencyCode;
  status: 'pending' | 'paid' | 'rejected';
  referenceId?: string;
  rejectionReason?: string;
  reviewedBy?: string;
  reviewedAtMs?: number;
  createdAtMs: number;
}

export interface ReviewRecord {
  id: string;
  dealId: string;
  sellerId: string;
  reviewerId: string;
  reviewerName: string;
  score: number;
  comment: string;
  createdAtMs: number;
}

export interface PublicSettings {
  buyerFeeEnabled: boolean;
  buyerFeePct: number;
  sellerFeeEnabled: boolean;
  sellerFeePct: number;
  usdToBdtRate: number;
  supportWhatsapp: string;
  supportTelegram: string;
  supportEmail: string;
  bkashNumber: string;
  nagadNumber: string;
  rocketNumber: string;
  aiEmergencyStop: boolean;
  disabledMonetizationIds: string[];
  gamingTitles: string[];
  protectionHoursYoutube: number;
  protectionHoursFacebook: number;
  protectionHoursDefault: number;
  customProtectionWindowsEnabled?: boolean;
  fcmVapidPublicKey?: string;
  wordpressPaymentEnabled?: boolean;
  wordpressSiteUrl?: string;
  wordpressBridgeEndpoint?: string;
  siteName?: string;
  brandTagline?: string;
  logoUrl?: string;
  noticeBannerEnabled?: boolean;
  noticeBannerText?: string;
  enabledLanguages?: LanguageCode[];
}

export interface AiProposalRecord {
  id: string;
  title: string;
  category: 'bugfix' | 'security' | 'feature' | 'performance';
  severity: 'low' | 'medium' | 'high' | 'critical';
  summary: string;
  affectedFiles: string[];
  proposedDiff: string;
  status: 'awaiting_review' | 'in_review' | 'approved' | 'rejected' | 'deployed';
  decidedBy?: string;
  createdAtMs: number;
}

export interface AuditLogRecord {
  id: string;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string;
  details: string;
  createdAtMs: number;
}

export type NotificationCategory =
  | 'account'
  | 'security'
  | 'verification'
  | 'listing'
  | 'bid'
  | 'deal'
  | 'dispute'
  | 'wallet'
  | 'announcement'
  | 'system';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical';

export type NotificationRefType =
  | 'none'
  | 'listing'
  | 'deal'
  | 'wallet'
  | 'profile'
  | 'announcement';

export type NotificationSoundId =
  | '01_soft_normal'
  | '02_crisp_normal'
  | '03_premium_deal'
  | '04_urgent_deal';

export type NotificationAlertKind = 'normal' | 'deal_room_created' | 'admin_alert';

export type VibrationStrength = 'standard' | 'strong';

export interface UserNotificationPreferences {
  inAppSoundEnabled: boolean;
  dealAlertSoundEnabled: boolean;
  adminAlertSoundEnabled: boolean;
  vibrationEnabled: boolean;
  vibrationStrength?: VibrationStrength;
  lockScreenPrivacyMode: 'minimal' | 'standard';
  normalSoundId: NotificationSoundId;
  dealAlertSoundId: NotificationSoundId;
  adminAlertSoundId: NotificationSoundId;
  followedSellerListingsEnabled?: boolean;
  bidUpdatesEnabled?: boolean;
}

export interface NotificationRecord {
  id: string;
  recipientId: string;
  actorId: string;
  actorRole: 'user' | 'admin' | 'system';
  category: NotificationCategory;
  severity: NotificationSeverity;
  alertKind?: NotificationAlertKind;
  title: string;
  preview: string;
  body: string;
  refType: NotificationRefType;
  refId: string;
  referenceLabel: string;
  destination: string;
  read: boolean;
  readAtMs?: number;
  createdAtMs: number;
  isAnnouncementMirror?: boolean;
}

export interface AnnouncementRecord {
  id: string;
  title: string;
  preview: string;
  body: string;
  severity: NotificationSeverity;
  destination: string;
  active: boolean;
  authorId: string;
  createdAtMs: number;
}

export interface PushTokenRecord {
  id: string;
  uid: string;
  token: string;
  userAgent: string;
  platform?: string;
  deviceLabel?: string;
  enabled: boolean;
  createdAtMs: number;
  lastRefreshedAtMs?: number;
}

export type TokenServiceStatus =
  | 'enabled_verified'
  | 'disabled'
  | 'enablement_pending'
  | 'permission_denied'
  | 'unable_to_verify'
  | 'config_mismatch';

export type AuthProviderStatus = 'enabled' | 'disabled' | 'unable_to_verify';


