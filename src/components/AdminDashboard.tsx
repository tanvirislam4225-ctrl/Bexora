import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import {
  Activity,
  AlertOctagon,
  BellRing,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Code2,
  ExternalLink,
  Eye,
  FileCheck2,
  FolderCog,
  Globe,
  Headset,
  History,
  Image as ImageIcon,
  Layers,
  Lock,
  Megaphone,
  MessageSquare,
  Percent,
  Play,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
  Volume2,
  Wallet,
  X,
} from 'lucide-react';
import {
  AdminInvitationRecord,
  AiProposalRecord,
  AnnouncementRecord,
  AuditLogRecord,
  ChatMessageRecord,
  CurrencyCode,
  DealAuditEvent,
  DealRecord,
  DealReportRecord,
  DealTransferSubmission,
  DepositRequestRecord,
  IdentityVerificationRecord,
  LanguageCode,
  MarketplaceListing,
  NotificationCategory,
  NotificationSeverity,
  PlatformId,
  PublicSettings,
  WithdrawalRequestRecord,
} from '../types';
import {
  buildApiUrl,
  cachedApiGetJson,
  invalidateClientApiCache,
} from '../lib/apiClient';
import { lazyWithRetry } from '../lib/chunkRetry';
import {
  ActiveAdminRecord,
  AdminDealQueueTab,
  AdminDepositBucket,
  AdminListingBucket,
  AdminNidBucket,
  AdminRoleBucket,
  AdminWithdrawalBucket,
  filterAdminDeals,
  filterAndBucketAdminGovernance,
  filterAndBucketDeposits,
  filterAndBucketListings,
  filterAndBucketNids,
  filterAndBucketWithdrawals,
  paginateAdminItems,
} from '../lib/adminQueueLogic';
import {
  BOOTSTRAPPED_SUPERADMIN_EMAIL,
  DEFAULT_FIREBASE_AUTH_DOMAINS_URL,
  DEFAULT_FIREBASE_AUTH_PROVIDERS_URL,
  DEFAULT_TOKEN_SERVICE_ACTIVATION_URL,
  auth,
  db,
  detectFirebaseAuthCapabilities,
  fetchWithFreshBearerToken,
  requestServerEnableTokenService,
} from '../lib/firebase';
import {
  appendDealAuditEvent,
  archiveAdminAnnouncement,
  emitUserNotification,
  publishAdminNotification,
} from '../lib/notificationService';
import {
  buildSanitizedPayoutTickerPayload,
  buildSanitizedSoldTickerPayload,
  generateOpaquePublicActivityId,
} from '../lib/activityTickerLogic';
import {
  calculateCommission,
  calculateDisputeRefundBreakdown,
  DEFAULT_PUBLIC_SETTINGS,
  formatMoneyFromMinor,
  getDealStatusLabel,
  getListingStatusBadgeMeta,
  getMonetizationLabel,
  getProtectionDurationHours,
  isDealPaidOrBeyond,
  isDealSecurityTimerActiveStatus,
  PLATFORM_CATALOG,
  PLATFORM_LIST,
} from '../lib/marketplaceLogic';
import {
  convertOrderMinorToWalletBdtMinor,
  validateWordPressSiteUrl,
  WordPressGatewayDiscoveryState,
} from '../lib/checkoutAndIntentLogic';
import { resolveDisplayDealCode } from '../lib/walletTopupAndReservationLogic';
import { shouldTriggerFollowerPublicationAlert } from '../lib/engagementLogic';
import { fanoutNewListingToFollowers } from '../lib/engagementService';
import { enableFcmCloudApisViaServer } from '../lib/pushNotifications';
import { UserProfileLink } from './UserProfileLink';
import {
  DismissibleNotice,
} from './DismissibleNotice';
import { ImageLightboxModal } from './ImageLightboxModal';
import { PageShellSkeleton } from './LoadingSkeletons';
import type { AdminFinanceOverviewPayload } from './admin/AdminOverviewSection';

const AdminPaymentManagement = lazyWithRetry(() =>
  import('./AdminPaymentManagement').then((m) => ({ default: m.AdminPaymentManagement }))
);
const AdminAiAssistantWorkspace = lazyWithRetry(() =>
  import('./AdminAiAssistantWorkspace').then((m) => ({ default: m.AdminAiAssistantWorkspace }))
);
const AdminTrustSafetyCenter = lazyWithRetry(() =>
  import('./AdminTrustSafetyCenter').then((m) => ({ default: m.AdminTrustSafetyCenter }))
);
const AdminUsersDirectory = lazyWithRetry(() =>
  import('./AdminUsersDirectory').then((m) => ({ default: m.AdminUsersDirectory }))
);
const AdminOverviewSection = lazyWithRetry(() =>
  import('./admin/AdminOverviewSection').then((m) => ({ default: m.AdminOverviewSection }))
);
const AdminCommissionsSection = lazyWithRetry(() =>
  import('./admin/AdminConfigSections').then((m) => ({ default: m.AdminCommissionsSection }))
);
const AdminCategoriesSection = lazyWithRetry(() =>
  import('./admin/AdminConfigSections').then((m) => ({ default: m.AdminCategoriesSection }))
);
const AdminSupportAndBrandingSection = lazyWithRetry(() =>
  import('./admin/AdminConfigSections').then((m) => ({ default: m.AdminSupportAndBrandingSection }))
);
const AdminAnnouncementsSection = lazyWithRetry(() =>
  import('./admin/AdminAnnouncementsSection').then((m) => ({
    default: m.AdminAnnouncementsSection,
  }))
);
const AdminNotificationManagement = lazyWithRetry(() =>
  import('./admin/AdminNotificationManagement').then((m) => ({
    default: m.AdminNotificationManagement,
  }))
);

interface AdminDashboardProps {
  adminUid: string;
  isSuperAdmin: boolean;
  settings: PublicSettings;
  displayCurrency: CurrencyCode;
  initialDealId?: string | null;
  onOpenPublicProfile?: (uid: string) => void;
  onFlash: (msg: string) => void;
}

type AdminSection =
  | 'overview'
  | 'users'
  | 'trust_safety'
  | 'moderation'
  | 'nid'
  | 'deposits'
  | 'withdrawals'
  | 'deals'
  | 'commissions'
  | 'categories'
  | 'support'
  | 'payments'
  | 'notifications'
  | 'notification_management'
  | 'roles'
  | 'aidev';

async function writeAuditLog(
  actorId: string,
  action: string,
  targetType: string,
  targetId: string,
  details: string
): Promise<void> {
  await addDoc(collection(db, 'auditLogs'), {
    actorId,
    action: action.slice(0, 80),
    targetType: targetType.slice(0, 40),
    targetId: targetId.slice(0, 128),
    details: details.slice(0, 1000),
    createdAt: serverTimestamp(),
  });
}

async function savePublicSettingsSafe(
  actorId: string,
  patch: Partial<PublicSettings>,
  auditSummary: string
): Promise<void> {
  await runTransaction(db, async (tx) => {
    const ref = doc(db, 'publicConfig', 'settings');
    const snap = await tx.get(ref);
    const base: PublicSettings = snap.exists()
      ? {
          buyerFeeEnabled: Boolean(snap.data().buyerFeeEnabled),
          buyerFeePct: Number(snap.data().buyerFeePct ?? 5),
          sellerFeeEnabled: Boolean(snap.data().sellerFeeEnabled),
          sellerFeePct: Number(snap.data().sellerFeePct ?? 0),
          usdToBdtRate: Number(snap.data().usdToBdtRate ?? 120),
          supportWhatsapp: String(snap.data().supportWhatsapp ?? ''),
          supportTelegram: String(snap.data().supportTelegram ?? ''),
          supportEmail: String(snap.data().supportEmail ?? ''),
          bkashNumber: String(snap.data().bkashNumber ?? ''),
          nagadNumber: String(snap.data().nagadNumber ?? ''),
          rocketNumber: String(snap.data().rocketNumber ?? ''),
          aiEmergencyStop: Boolean(snap.data().aiEmergencyStop),
          disabledMonetizationIds: Array.isArray(snap.data().disabledMonetizationIds)
            ? snap.data().disabledMonetizationIds
            : [],
          gamingTitles: Array.isArray(snap.data().gamingTitles)
            ? snap.data().gamingTitles
            : DEFAULT_PUBLIC_SETTINGS.gamingTitles,
          protectionHoursYoutube: Number(snap.data().protectionHoursYoutube ?? 168),
          protectionHoursFacebook: Number(snap.data().protectionHoursFacebook ?? 40),
          protectionHoursDefault: Number(snap.data().protectionHoursDefault ?? 40),
          customProtectionWindowsEnabled: Boolean(snap.data().customProtectionWindowsEnabled),
          fcmVapidPublicKey: String(snap.data().fcmVapidPublicKey ?? ''),
          wordpressPaymentEnabled: Boolean(snap.data().wordpressPaymentEnabled),
          wordpressSiteUrl: String(snap.data().wordpressSiteUrl ?? ''),
          wordpressBridgeEndpoint: String(
            snap.data().wordpressBridgeEndpoint ?? '/wp-json/bexora/v1'
          ),
          siteName: String(snap.data().siteName ?? DEFAULT_PUBLIC_SETTINGS.siteName ?? 'BEXORA'),
          brandTagline: String(snap.data().brandTagline ?? DEFAULT_PUBLIC_SETTINGS.brandTagline ?? ''),
          logoUrl: String(snap.data().logoUrl ?? DEFAULT_PUBLIC_SETTINGS.logoUrl ?? ''),
          noticeBannerEnabled: Boolean(snap.data().noticeBannerEnabled),
          noticeBannerText: String(snap.data().noticeBannerText ?? ''),
          enabledLanguages: Array.isArray(snap.data().enabledLanguages)
            ? (snap.data().enabledLanguages.filter((c: unknown) =>
                ['en', 'bn', 'hi', 'ar', 'ur'].includes(String(c))
              ) as LanguageCode[])
            : DEFAULT_PUBLIC_SETTINGS.enabledLanguages || ['en', 'bn', 'hi', 'ar', 'ur'],
        }
      : { ...DEFAULT_PUBLIC_SETTINGS };

    const merged = {
      ...base,
      ...patch,
      updatedAt: serverTimestamp(),
    };
    tx.set(ref, merged);
  });

  await writeAuditLog(actorId, 'update_public_settings', 'publicConfig', 'settings', auditSummary);
}

export const AdminDashboard: React.FC<AdminDashboardProps> = ({
  adminUid,
  isSuperAdmin,
  settings,
  displayCurrency,
  initialDealId,
  onOpenPublicProfile,
  onFlash,
}) => {
  const [section, setSection] = useState<AdminSection>(initialDealId ? 'deals' : 'overview');

  // Live Admin Collections
  const [allListings, setAllListings] = useState<MarketplaceListing[]>([]);
  const [nidSubmissions, setNidSubmissions] = useState<IdentityVerificationRecord[]>([]);
  const [deposits, setDeposits] = useState<DepositRequestRecord[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequestRecord[]>([]);
  const [deals, setDeals] = useState<DealRecord[]>([]);
  const [proposals, setProposals] = useState<AiProposalRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [adminRoles, setAdminRoles] = useState<ActiveAdminRecord[]>([]);
  const [adminInvitations, setAdminInvitations] = useState<AdminInvitationRecord[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRecord[]>([]);
  const [financeOverview, setFinanceOverview] = useState<AdminFinanceOverviewPayload | null>(null);
  const [financeLoading, setFinanceLoading] = useState(false);
  const [financeError, setFinanceError] = useState<string | null>(null);
  const [settlingExpiredDeals, setSettlingExpiredDeals] = useState(false);
  const [busyItemKey, setBusyItemKey] = useState<string | null>(null);

  // Organized Status Queues, Filters, Search & Pagination State
  const [listingBucket, setListingBucket] = useState<AdminListingBucket>('pending');
  const [listingSearch, setListingSearch] = useState('');
  const [listingPlatformFilter, setListingPlatformFilter] = useState<PlatformId | 'all'>('all');
  const [listingPage, setListingPage] = useState(1);

  const [nidBucket, setNidBucket] = useState<AdminNidBucket>('pending_review');
  const [nidSearch, setNidSearch] = useState('');
  const [nidPage, setNidPage] = useState(1);
  const [nidRejectReasons, setNidRejectReasons] = useState<Record<string, string>>({});

  const [depositBucket, setDepositBucket] = useState<AdminDepositBucket>('pending');
  const [depositSearch, setDepositSearch] = useState('');
  const [depositPage, setDepositPage] = useState(1);
  const [depositRejectReasons, setDepositRejectReasons] = useState<Record<string, string>>({});

  const [withdrawalBucket, setWithdrawalBucket] = useState<AdminWithdrawalBucket>('pending');
  const [withdrawalSearch, setWithdrawalSearch] = useState('');
  const [withdrawalPage, setWithdrawalPage] = useState(1);
  const [wdRefInputs, setWdRefInputs] = useState<Record<string, string>>({});
  const [wdRejectReasons, setWdRejectReasons] = useState<Record<string, string>>({});

  const [roleBucket, setRoleBucket] = useState<AdminRoleBucket>('pending');
  const [roleSearch, setRoleSearch] = useState('');
  const [targetInviteEmail, setTargetInviteEmail] = useState('');
  const [targetInviteName, setTargetInviteName] = useState('');

  const financeAbortRef = useRef<AbortController | null>(null);
  const financeInFlightRef = useRef<Promise<void> | null>(null);

  const fetchFinanceOverview = useCallback(
    (forceRefresh = false): Promise<void> => {
      if (!forceRefresh && financeInFlightRef.current) {
        return financeInFlightRef.current;
      }
      if (forceRefresh && financeAbortRef.current) {
        financeAbortRef.current.abort();
      }
      const ac = new AbortController();
      financeAbortRef.current = ac;

      let task: Promise<void> | null = null;
      task = (async () => {
        setFinanceLoading(true);
        setFinanceError(null);
        try {
          const rate =
            Number.isFinite(settings.usdToBdtRate) &&
            settings.usdToBdtRate > 0 &&
            settings.usdToBdtRate < 100000
              ? settings.usdToBdtRate
              : 120;
          const json = await cachedApiGetJson<AdminFinanceOverviewPayload & { error?: string }>(
            `GET:/api/admin/finance-overview:${rate}`,
            async () => {
              const refreshParam = forceRefresh ? '&refresh=1' : '';
              const resp = await fetchWithFreshBearerToken(
                `/api/admin/finance-overview?usdToBdtRate=${encodeURIComponent(String(rate))}${refreshParam}`,
                { signal: ac.signal }
              );
              const parsed = (await resp.json().catch(() => null)) as
                | (AdminFinanceOverviewPayload & { error?: string })
                | null;
              if (!resp.ok || !parsed || !parsed.ok) {
                throw new Error(parsed?.error || `Failed to load finance overview (${resp.status}).`);
              }
              return parsed;
            },
            {
              ttlMs: 12_000,
              forceRefresh,
              shouldCache: (res) => Boolean(res?.ok && res?.complete),
            }
          );
          if (!ac.signal.aborted) {
            setFinanceOverview(json);
          }
        } catch (err) {
          if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
            return;
          }
          setFinanceError(err instanceof Error ? err.message : 'Unable to load finance overview.');
        } finally {
          if (financeAbortRef.current === ac) {
            financeAbortRef.current = null;
          }
          if (task && financeInFlightRef.current === task) {
            financeInFlightRef.current = null;
          }
          if (!ac.signal.aborted) {
            setFinanceLoading(false);
          }
        }
      })();

      financeInFlightRef.current = task;
      return task;
    },
    [settings.usdToBdtRate]
  );

  const invalidateAndRefreshFinanceOverview = useCallback(async () => {
    invalidateClientApiCache('GET:/api/admin/finance-overview');
    await fetchWithFreshBearerToken('/api/admin/finance-overview/invalidate', {
      method: 'POST',
    }).catch(() => {});
    await fetchFinanceOverview(true);
  }, [fetchFinanceOverview]);

  useEffect(() => {
    return () => {
      financeAbortRef.current?.abort();
    };
  }, []);

  const handleSettleAllExpiredDeals = useCallback(async () => {
    if (settlingExpiredDeals) return;
    setSettlingExpiredDeals(true);
    try {
      const resp = await fetchWithFreshBearerToken('/api/admin/deals/settle-expired', {
        method: 'POST',
      });
      const json = (await resp.json().catch(() => null)) as
        | { ok?: boolean; settledCount?: number; checkedCount?: number; error?: string }
        | null;
      if (!resp.ok || !json?.ok) {
        throw new Error(json?.error || `Failed to settle expired deals (${resp.status}).`);
      }
      onFlash(
        json.settledCount && json.settledCount > 0
          ? `Released seller payouts for ${json.settledCount} completed escrow deal(s).`
          : 'No additional expired dispute-free escrow deals needed release.'
      );
      await fetchFinanceOverview(true);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Unable to run expired escrow payout release.');
    } finally {
      setSettlingExpiredDeals(false);
    }
  }, [settlingExpiredDeals, onFlash, fetchFinanceOverview]);

  useEffect(() => {
    if (section !== 'overview') return;
    void fetchFinanceOverview(false);
    const intervalId = window.setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void fetchFinanceOverview(false);
      }
    }, 20_000);
    const onOnline = () => {
      void fetchFinanceOverview(true);
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', onOnline);
    };
  }, [section, fetchFinanceOverview]);

  const overviewSnapshotFingerprint = `${allListings.length}:${nidSubmissions.length}:${deposits.length}:${withdrawals.length}:${deals.length}:${deals.map((d) => `${d.status}`).join(',')}`;
  const lastFingerprintRef = useRef<string>('');
  useEffect(() => {
    if (section !== 'overview') return;
    if (!lastFingerprintRef.current) {
      lastFingerprintRef.current = overviewSnapshotFingerprint;
      return;
    }
    if (lastFingerprintRef.current === overviewSnapshotFingerprint) return;
    lastFingerprintRef.current = overviewSnapshotFingerprint;
    const t = window.setTimeout(() => {
      void fetchFinanceOverview(true);
    }, 1200);
    return () => window.clearTimeout(t);
  }, [section, overviewSnapshotFingerprint, fetchFinanceOverview]);

  // Admin Notification & Broadcast Composer State
  const [notifMode, setNotifMode] = useState<'broadcast_announcement' | 'targeted_user'>('broadcast_announcement');
  const [notifTargetUid, setNotifTargetUid] = useState('');
  const [notifCategory, setNotifCategory] = useState<NotificationCategory>('announcement');
  const [notifSeverity, setNotifSeverity] = useState<NotificationSeverity>('info');
  const [notifTitle, setNotifTitle] = useState('');
  const [notifPreview, setNotifPreview] = useState('');
  const [notifBody, setNotifBody] = useState('');
  const [notifDestination, setNotifDestination] = useState('');
  const [notifPersistBanner, setNotifPersistBanner] = useState(true);
  const [sendingAdminNotif, setSendingAdminNotif] = useState(false);

  // Moderation Workbench State
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [evidenceDoc, setEvidenceDoc] = useState<{
    evidenceImages: string[];
    aiSummary?: string;
    aiMethod?: string;
  } | null>(null);
  const [listingRevisions, setListingRevisions] = useState<
    Array<{
      id: string;
      previousTitle: string;
      previousPriceMinor: number;
      previousCurrency: string;
      previousStatus: string;
      changeSummary: string;
      createdAtMs: number;
    }>
  >([]);
  const [verifiedSelections, setVerifiedSelections] = useState<string[]>([]);
  const [rejectReason, setRejectReason] = useState('');
  const [runningAiOcr, setRunningAiOcr] = useState(false);

  // Deal & Dispute Review Workbench State
  const [selectedDealId, setSelectedDealId] = useState<string | null>(initialDealId || null);
  const [dealFilter, setDealFilter] = useState<AdminDealQueueTab>('all');
  const [dealSearch, setDealSearch] = useState('');
  const [dealsPage, setDealsPage] = useState(1);
  const [dealReports, setDealReports] = useState<DealReportRecord[]>([]);
  const [dealTransfers, setDealTransfers] = useState<DealTransferSubmission[]>([]);
  const [dealMessages, setDealMessages] = useState<ChatMessageRecord[]>([]);
  const [dealEvents, setDealEvents] = useState<DealAuditEvent[]>([]);
  const [adminDealNote, setAdminDealNote] = useState('');
  const [adminChatInput, setAdminChatInput] = useState('');
  const [sendingAdminChat, setSendingAdminChat] = useState(false);
  const [busyDealAction, setBusyDealAction] = useState<string | null>(null);
  const [serverSearchedDeals, setServerSearchedDeals] = useState<DealRecord[] | null>(null);
  const [searchingServerDeals, setSearchingServerDeals] = useState(false);
  const [dealDeleteTarget, setDealDeleteTarget] = useState<DealRecord | null>(null);
  const [dealDeleteReason, setDealDeleteReason] = useState('');
  const [dealDeleteError, setDealDeleteError] = useState<string | null>(null);
  const [deletingDealId, setDeletingDealId] = useState<string | null>(null);
  const [lightboxState, setLightboxState] = useState<{
    images: string[];
    index: number;
    caption?: string;
  } | null>(null);

  useEffect(() => {
    if (initialDealId) {
      setSection('deals');
      setSelectedDealId(initialDealId);
    }
  }, [initialDealId]);

  // Commission Form State
  const [buyerFeeEnabled, setBuyerFeeEnabled] = useState(settings.buyerFeeEnabled);
  const [buyerFeePct, setBuyerFeePct] = useState(String(settings.buyerFeePct));
  const [sellerFeeEnabled, setSellerFeeEnabled] = useState(settings.sellerFeeEnabled);
  const [sellerFeePct, setSellerFeePct] = useState(String(settings.sellerFeePct));
  const [usdRate, setUsdRate] = useState(String(settings.usdToBdtRate));
  const [calcSampleBdt, setCalcSampleBdt] = useState('100');

  // Categories & Protection Form State
  const [disabledMonIds, setDisabledMonIds] = useState<string[]>(settings.disabledMonetizationIds);
  const [gamingText, setGamingText] = useState(settings.gamingTitles.join('\n'));
  const [protYt, setProtYt] = useState(String(settings.protectionHoursYoutube));
  const [protFb, setProtFb] = useState(String(settings.protectionHoursFacebook));
  const [protDef, setProtDef] = useState(String(settings.protectionHoursDefault));
  const [customProtEnabled, setCustomProtEnabled] = useState(Boolean(settings.customProtectionWindowsEnabled));

  // Support Contact & Editable Branding/Notice Form State
  const [supWa, setSupWa] = useState(settings.supportWhatsapp);
  const [supTg, setSupTg] = useState(settings.supportTelegram);
  const [supEmail, setSupEmail] = useState(settings.supportEmail);
  const [siteNameInput, setSiteNameInput] = useState(settings.siteName || 'BEXORA');
  const [brandTaglineInput, setBrandTaglineInput] = useState(settings.brandTagline || '');
  const [logoUrlInput, setLogoUrlInput] = useState(settings.logoUrl || '');
  const [noticeBannerEnabledInput, setNoticeBannerEnabledInput] = useState(
    Boolean(settings.noticeBannerEnabled)
  );
  const [noticeBannerTextInput, setNoticeBannerTextInput] = useState(
    settings.noticeBannerText || ''
  );
  const [enabledLanguagesInput, setEnabledLanguagesInput] = useState<LanguageCode[]>(
    settings.enabledLanguages && settings.enabledLanguages.length > 0
      ? settings.enabledLanguages
      : ['en', 'bn', 'hi', 'ar', 'ur']
  );

  // Manual Payment Numbers & WordPress Live Payment Bridge Form State
  const [bkashNum, setBkashNum] = useState(settings.bkashNumber);
  const [nagadNum, setNagadNum] = useState(settings.nagadNumber);
  const [rocketNum, setRocketNum] = useState(settings.rocketNumber);
  const [wpEnabled, setWpEnabled] = useState(Boolean(settings.wordpressPaymentEnabled));
  const [wpSiteUrl, setWpSiteUrl] = useState(settings.wordpressSiteUrl || '');
  const [wpBridgeEndpoint, setWpBridgeEndpoint] = useState(
    settings.wordpressBridgeEndpoint || '/wp-json/bexora/v1'
  );
  const [testingWpBridge, setTestingWpBridge] = useState(false);
  const [wpTestResult, setWpTestResult] = useState<WordPressGatewayDiscoveryState | null>(null);

  // Role Management Form State
  const [targetRoleUid, setTargetRoleUid] = useState('');
  const [targetRoleLevel, setTargetRoleLevel] = useState<'admin' | 'superadmin'>('admin');

  // AI Assistant & Cloud Diagnostics State
  const [healthSnapshot, setHealthSnapshot] = useState<Record<string, unknown> | null>(null);
  const [enablingCloudService, setEnablingCloudService] = useState<'token_service' | 'fcm_apis' | null>(null);
  const [migratingListingImages, setMigratingListingImages] = useState(false);
  const [listingMigrationProgress, setListingMigrationProgress] = useState<{
    processed: number;
    failed: number;
    skipped: number;
    remainingEstimate: number | null;
    statusText: string;
  } | null>(null);

  useEffect(() => {
    setBuyerFeeEnabled(settings.buyerFeeEnabled);
    setBuyerFeePct(String(settings.buyerFeePct));
    setSellerFeeEnabled(settings.sellerFeeEnabled);
    setSellerFeePct(String(settings.sellerFeePct));
    setUsdRate(String(settings.usdToBdtRate));
    setDisabledMonIds(settings.disabledMonetizationIds);
    setGamingText(settings.gamingTitles.join('\n'));
    setProtYt(String(settings.protectionHoursYoutube));
    setProtFb(String(settings.protectionHoursFacebook));
    setProtDef(String(settings.protectionHoursDefault));
    setCustomProtEnabled(Boolean(settings.customProtectionWindowsEnabled));
    setSupWa(settings.supportWhatsapp);
    setSupTg(settings.supportTelegram);
    setSupEmail(settings.supportEmail);
    setSiteNameInput(settings.siteName || 'BEXORA');
    setBrandTaglineInput(settings.brandTagline || '');
    setLogoUrlInput(settings.logoUrl || '');
    setNoticeBannerEnabledInput(Boolean(settings.noticeBannerEnabled));
    setNoticeBannerTextInput(settings.noticeBannerText || '');
    setEnabledLanguagesInput(
      settings.enabledLanguages && settings.enabledLanguages.length > 0
        ? settings.enabledLanguages
        : ['en', 'bn', 'hi', 'ar', 'ur']
    );
    setBkashNum(settings.bkashNumber);
    setNagadNum(settings.nagadNumber);
    setRocketNum(settings.rocketNumber);
    setWpEnabled(Boolean(settings.wordpressPaymentEnabled));
    setWpSiteUrl(settings.wordpressSiteUrl || '');
    setWpBridgeEndpoint(settings.wordpressBridgeEndpoint || '/wp-json/bexora/v1');
  }, [settings]);

  // Real-time Admin Subscriptions
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(
      onSnapshot(
        query(collection(db, 'listings'), limit(400)),
        (snap) => {
          const items: MarketplaceListing[] = snap.docs.map((d) => {
            const ld = d.data();
            return {
              id: d.id,
              sellerId: ld.sellerId,
              sellerName: ld.sellerName,
              sellerUsername: ld.sellerUsername,
              sellerVerified: Boolean(ld.sellerVerified),
              platform: ld.platform,
              subcategory: ld.subcategory,
              title: ld.title,
              description: ld.description,
              priceMinor: Number(ld.priceMinor || 0),
              currency: ld.currency || 'BDT',
              monetizationStatus: ld.monetizationStatus,
              claimedOptions: ld.claimedOptions || [],
              verifiedOptions: ld.verifiedOptions || [],
              verificationState: ld.verificationState,
              ageYears: Number(ld.ageYears || 0),
              ageMonths: Number(ld.ageMonths || 0),
              metricValue: Number(ld.metricValue || 0),
              monthlyRevenueMinor: Number(ld.monthlyRevenueMinor || 0),
              accountUrl: ld.accountUrl || '',
              urlValidationStatus: ld.urlValidationStatus || 'not_applicable',
              gameName: ld.gameName,
              gameUid: ld.gameUid,
              gameLevel: ld.gameLevel,
              images: ld.images || [],
              activeDealId: ld.activeDealId,
              acceptedBidAmountMinor: ld.acceptedBidAmountMinor ? Number(ld.acceptedBidAmountMinor) : undefined,
              reservedBuyerId: ld.reservedBuyerId,
              status: ld.status,
              rejectionReason: ld.rejectionReason,
              views: Number(ld.views || 0),
              firstPublishedAtMs: ld.firstPublishedAtMs ? Number(ld.firstPublishedAtMs) : undefined,
              createdAtMs: ld.createdAt?.toMillis ? ld.createdAt.toMillis() : Date.now(),
            };
          });
          items.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setAllListings(items);
        },
        (err) => console.error('Admin listings listener error:', err)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'identityVerifications'), limit(250)),
        (snap) => {
          setNidSubmissions(
            snap.docs.map((d) => {
              const nd = d.data();
              return {
                uid: d.id,
                frontImageData: nd.frontImageData,
                backImageData: nd.backImageData,
                status: nd.status,
                rejectionReason: nd.rejectionReason,
                reviewedBy: nd.reviewedBy,
                submittedAt: nd.submittedAt,
                updatedAt: nd.updatedAt,
              };
            })
          );
        },
        (err) => console.error('Admin NID listener error:', err)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deposits'), limit(250)),
        (snap) => {
          const items: DepositRequestRecord[] = snap.docs.map((d) => {
            const dd = d.data();
            return {
              id: d.id,
              userId: dd.userId,
              userName: dd.userName,
              method: dd.method,
              amountMinor: Number(dd.amountMinor || 0),
              currency: 'BDT',
              senderNumber: dd.senderNumber,
              transactionId: dd.transactionId,
              screenshotData: dd.screenshotData,
              status: dd.status,
              rejectionReason: dd.rejectionReason,
              createdAtMs: dd.createdAt?.toMillis ? dd.createdAt.toMillis() : Date.now(),
            };
          });
          items.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setDeposits(items);
        },
        (err) => console.error('Admin deposits listener error:', err)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'withdrawals'), limit(250)),
        (snap) => {
          const items: WithdrawalRequestRecord[] = snap.docs.map((d) => {
            const wd = d.data();
            return {
              id: d.id,
              userId: wd.userId,
              userName: wd.userName,
              method: wd.method,
              payoutAccount: wd.payoutAccount,
              amountMinor: Number(wd.amountMinor || 0),
              currency: wd.currency || 'BDT',
              status: wd.status,
              referenceId: wd.referenceId,
              rejectionReason: wd.rejectionReason,
              reviewedBy: wd.reviewedBy,
              reviewedAtMs: wd.reviewedAtMs ? Number(wd.reviewedAtMs) : undefined,
              publicActivityId: wd.publicActivityId ? String(wd.publicActivityId) : undefined,
              createdAtMs: wd.createdAt?.toMillis ? wd.createdAt.toMillis() : Date.now(),
            };
          });
          items.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setWithdrawals(items);
        },
        (err) => console.error('Admin withdrawals listener error:', err)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deals'), limit(250)),
        (snap) => {
          const items: DealRecord[] = snap.docs
            .map((d) => {
              const dl = d.data();
              return {
                id: d.id,
                dealCode: dl.dealCode ? String(dl.dealCode) : undefined,
                listingId: dl.listingId,
                listingTitle: dl.listingTitle,
                platform: dl.platform,
                acceptedBidId: dl.acceptedBidId,
                originalListingPriceMinor: dl.originalListingPriceMinor
                  ? Number(dl.originalListingPriceMinor)
                  : undefined,
                buyerId: dl.buyerId,
                buyerName: dl.buyerName,
                sellerId: dl.sellerId,
                sellerName: dl.sellerName,
                baseAmountMinor: Number(dl.baseAmountMinor || 0),
                buyerFeePct: Number(dl.buyerFeePct || 0),
                sellerFeePct: Number(dl.sellerFeePct || 0),
                buyerFeeMinor: Number(dl.buyerFeeMinor || 0),
                sellerFeeMinor: Number(dl.sellerFeeMinor || 0),
                buyerTotalMinor: Number(dl.buyerTotalMinor || 0),
                sellerPayoutMinor: Number(dl.sellerPayoutMinor || 0),
                platformCommissionMinor: Number(dl.platformCommissionMinor || 0),
                refundBuyerMinor:
                  dl.refundBuyerMinor !== undefined ? Number(dl.refundBuyerMinor) : undefined,
                refundPlatformRetainedMinor:
                  dl.refundPlatformRetainedMinor !== undefined
                    ? Number(dl.refundPlatformRetainedMinor)
                    : undefined,
                currency: dl.currency || 'BDT',
                protectionDurationHours: Number(
                  dl.protectionDurationHours || getProtectionDurationHours(dl.platform || 'other')
                ),
                confirmedAtMs: Number(dl.confirmedAtMs || 0),
                originalDeadlineMs: Number(dl.originalDeadlineMs || 0),
                unresolvedReportCount: Number(dl.unresolvedReportCount || 0),
                paymentLedgerId: dl.paymentLedgerId,
                paidAtMs: dl.paidAtMs ? Number(dl.paidAtMs) : undefined,
                transferSubmissionCount:
                  dl.transferSubmissionCount !== undefined ? Number(dl.transferSubmissionCount) : 0,
                latestTransferSubmissionId: dl.latestTransferSubmissionId,
                latestRejectionReason: dl.latestRejectionReason,
                refundLedgerId: dl.refundLedgerId,
                settlementLedgerId: dl.settlementLedgerId,
                adminHoldNote: dl.adminHoldNote,
                settledAtMs: dl.settledAtMs ? Number(dl.settledAtMs) : undefined,
                refundedAtMs: dl.refundedAtMs ? Number(dl.refundedAtMs) : undefined,
                publicActivityId: dl.publicActivityId ? String(dl.publicActivityId) : undefined,
                isDeleted: Boolean(dl.isDeleted),
                deletedAtMs: dl.deletedAtMs ? Number(dl.deletedAtMs) : undefined,
                deletedBy: dl.deletedBy ? String(dl.deletedBy) : undefined,
                deletionReason: dl.deletionReason ? String(dl.deletionReason) : undefined,
                status: dl.status,
                createdAtMs: dl.createdAt?.toMillis ? dl.createdAt.toMillis() : Date.now(),
              } satisfies DealRecord;
            })
            .filter((item) => !item.isDeleted);
          items.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setDeals(items);
        },
        (err) => console.error('Admin deals listener error:', err)
      )
    );

    return () => unsubs.forEach((u) => u());
  }, []);

  // Section-Scoped Secondary Admin Listeners (attach only when viewing Roles, AI Dev, or Notifications)
  useEffect(() => {
    if (section !== 'roles' && section !== 'aidev' && section !== 'notifications') {
      return;
    }
    const scopedUnsubs: (() => void)[] = [];

    if (section === 'aidev') {
      scopedUnsubs.push(
        onSnapshot(
          query(collection(db, 'aiProposals'), limit(60)),
          (snap) => {
            const items: AiProposalRecord[] = snap.docs.map((d) => {
              const p = d.data();
              return {
                id: d.id,
                title: p.title,
                category: p.category,
                severity: p.severity,
                summary: p.summary,
                affectedFiles: p.affectedFiles || [],
                proposedDiff: p.proposedDiff || '',
                status: p.status,
                decidedBy: p.decidedBy,
                linkedIssueId: p.linkedIssueId ? String(p.linkedIssueId) : undefined,
                createdAtMs: p.createdAt?.toMillis ? p.createdAt.toMillis() : Date.now(),
              };
            });
            items.sort((a, b) => b.createdAtMs - a.createdAtMs);
            setProposals(items);
          },
          (err) => console.error('Admin proposals listener error:', err)
        )
      );
    }

    if (section === 'roles' || section === 'aidev') {
      scopedUnsubs.push(
        onSnapshot(
          query(collection(db, 'auditLogs'), orderBy('createdAt', 'desc'), limit(60)),
          (snap) => {
            setAuditLogs(
              snap.docs.map((d) => {
                const al = d.data();
                return {
                  id: d.id,
                  actorId: al.actorId,
                  action: al.action,
                  targetType: al.targetType,
                  targetId: al.targetId,
                  details: al.details,
                  createdAtMs: al.createdAt?.toMillis ? al.createdAt.toMillis() : Date.now(),
                };
              })
            );
          },
          (err) => console.error('Admin auditLogs listener error:', err)
        )
      );
    }

    if (section === 'roles') {
      scopedUnsubs.push(
        onSnapshot(
          query(collection(db, 'admins'), limit(100)),
          (snap) => {
            setAdminRoles(
              snap.docs.map((d) => {
                const ad = d.data();
                return {
                  uid: d.id,
                  role: ad.role === 'superadmin' ? 'superadmin' : 'admin',
                  permissions: Array.isArray(ad.permissions)
                    ? ad.permissions.map((p: unknown) => String(p))
                    : ['all'],
                  grantedBy: String(ad.grantedBy || ''),
                  email: ad.email ? String(ad.email) : undefined,
                  displayName: ad.displayName ? String(ad.displayName) : undefined,
                  updatedAtMs: ad.createdAt?.toMillis ? ad.createdAt.toMillis() : Date.now(),
                };
              })
            );
          },
          () => {}
        )
      );

      if (isSuperAdmin) {
        scopedUnsubs.push(
          onSnapshot(
            query(collection(db, 'adminInvitations'), limit(200)),
            (snap) => {
              const list: AdminInvitationRecord[] = snap.docs.map((d) => {
                const idata = d.data();
                return {
                  id: d.id,
                  targetUid: String(idata.targetUid || ''),
                  targetName: idata.targetName ? String(idata.targetName) : undefined,
                  targetEmail: idata.targetEmail ? String(idata.targetEmail) : undefined,
                  role: idata.role === 'superadmin' ? 'superadmin' : 'admin',
                  permissions: Array.isArray(idata.permissions)
                    ? idata.permissions.map((p: unknown) => String(p))
                    : [],
                  status:
                    idata.status === 'accepted' ||
                    idata.status === 'rejected' ||
                    idata.status === 'revoked'
                      ? idata.status
                      : 'pending',
                  invitedBy: String(idata.invitedBy || ''),
                  invitedByName: idata.invitedByName ? String(idata.invitedByName) : undefined,
                  rejectionReason: idata.rejectionReason ? String(idata.rejectionReason) : undefined,
                  respondedAtMs:
                    typeof idata.respondedAtMs === 'number' ? idata.respondedAtMs : undefined,
                  createdAtMs: Number(
                    idata.createdAtMs || (idata.createdAt?.toMillis ? idata.createdAt.toMillis() : Date.now())
                  ),
                };
              });
              setAdminInvitations(list);
            },
            () => setAdminInvitations([])
          )
        );
      } else {
        setAdminInvitations([]);
      }
    }

    if (section === 'notifications') {
      scopedUnsubs.push(
        onSnapshot(
          query(collection(db, 'announcements'), limit(40)),
          (snap) => {
            const items: AnnouncementRecord[] = snap.docs.map((d) => {
              const ad = d.data();
              return {
                id: d.id,
                title: String(ad.title || ''),
                preview: String(ad.preview || ''),
                body: String(ad.body || ''),
                severity: (ad.severity as NotificationSeverity) || 'info',
                destination: ad.destination ? String(ad.destination) : '',
                active: Boolean(ad.active),
                authorId: String(ad.authorId || ''),
                createdAtMs: Number(ad.createdAtMs || (ad.createdAt?.toMillis ? ad.createdAt.toMillis() : Date.now())),
              };
            });
            items.sort((a, b) => b.createdAtMs - a.createdAtMs);
            setAnnouncements(items);
          },
          () => {}
        )
      );
    }

    return () => scopedUnsubs.forEach((u) => u());
  }, [section, isSuperAdmin]);

  // Load private monetization evidence and seller edit revision history when inspecting a listing
  useEffect(() => {
    if (!selectedListingId) {
      setEvidenceDoc(null);
      setListingRevisions([]);
      return;
    }
    const target = allListings.find((l) => l.id === selectedListingId);
    setVerifiedSelections(target?.verifiedOptions.length ? target.verifiedOptions : target?.claimedOptions || []);

    getDoc(doc(db, 'listingEvidence', selectedListingId))
      .then((snap) => {
        if (snap.exists()) {
          const d = snap.data();
          setEvidenceDoc({
            evidenceImages: d.evidenceImages || [],
            aiSummary: d.aiSummary,
            aiMethod: d.aiMethod,
          });
        } else {
          setEvidenceDoc({ evidenceImages: [] });
        }
      })
      .catch(() => setEvidenceDoc({ evidenceImages: [] }));

    getDocs(query(collection(db, 'listings', selectedListingId, 'revisions'), limit(15)))
      .then((snap) => {
        const revs = snap.docs
          .map((d) => {
            const rv = d.data();
            return {
              id: d.id,
              previousTitle: String(rv.previousTitle || ''),
              previousPriceMinor: Number(rv.previousPriceMinor || 0),
              previousCurrency: String(rv.previousCurrency || 'BDT'),
              previousStatus: String(rv.previousStatus || ''),
              changeSummary: String(rv.changeSummary || ''),
              createdAtMs: Number(rv.createdAtMs || rv.createdAt?.toMillis?.() || 0),
            };
          })
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setListingRevisions(revs);
      })
      .catch(() => setListingRevisions([]));
  }, [selectedListingId, allListings]);

  // One-time idempotent backfill: project any historical settled deals or paid withdrawals
  // missing `publicActivityId` into `/publicActivity` so live tickers reflect genuine history.
  const backfilledActivityRef = React.useRef<Set<string>>(new Set());
  useEffect(() => {
    const missingSold = deals.filter(
      (d) =>
        d.status === 'settled' &&
        !d.publicActivityId &&
        !backfilledActivityRef.current.has(`deal:${d.id}`)
    );
    const missingPayout = withdrawals.filter(
      (w) =>
        w.status === 'paid' &&
        !w.publicActivityId &&
        !backfilledActivityRef.current.has(`wd:${w.id}`)
    );
    if (missingSold.length === 0 && missingPayout.length === 0) return;

    let cancelled = false;
    (async () => {
      const targetDeals = missingSold.slice(0, 15);
      const targetWds = missingPayout.slice(0, 15);
      targetDeals.forEach((d) => backfilledActivityRef.current.add(`deal:${d.id}`));
      targetWds.forEach((w) => backfilledActivityRef.current.add(`wd:${w.id}`));

      const uniqueUids = Array.from(
        new Set([...targetDeals.map((d) => d.sellerId), ...targetWds.map((w) => w.userId)].filter(Boolean))
      );
      const profileMap = new Map<string, Record<string, unknown>>();
      await Promise.all(
        uniqueUids.map(async (uid) => {
          try {
            const snap = await getDoc(doc(db, 'publicProfiles', uid));
            if (snap.exists()) profileMap.set(uid, snap.data() as Record<string, unknown>);
          } catch {
            // Non-fatal
          }
        })
      );
      if (cancelled) return;

      const batch = writeBatch(db);
      let opCount = 0;

      for (const deal of targetDeals) {
        const pubData = profileMap.get(deal.sellerId);
        const settledTs = deal.settledAtMs || deal.createdAtMs || Date.now();
        const actId = generateOpaquePublicActivityId(settledTs);
        const payload = buildSanitizedSoldTickerPayload({
          deal: { ...deal, settledAtMs: settledTs },
          sellerDisplayName: pubData ? String(pubData.displayName || deal.sellerName || '') : deal.sellerName,
          sellerNidVerified: Boolean(pubData && pubData.nidVerified),
          hidePublicActivityName: Boolean(pubData && pubData.hidePublicActivityName),
          nowMs: settledTs,
        });
        if (!payload) continue;
        batch.set(doc(db, 'publicActivity', actId), {
          ...payload,
          createdAt: serverTimestamp(),
        });
        batch.update(doc(db, 'deals', deal.id), {
          publicActivityId: actId,
          updatedAt: serverTimestamp(),
        });
        opCount += 2;
      }

      for (const wd of targetWds) {
        const pubData = profileMap.get(wd.userId);
        const paidTs = wd.reviewedAtMs || wd.createdAtMs || Date.now();
        const actId = generateOpaquePublicActivityId(paidTs);
        const payload = buildSanitizedPayoutTickerPayload({
          withdrawal: { ...wd, reviewedAtMs: paidTs },
          userDisplayName: pubData ? String(pubData.displayName || wd.userName || '') : wd.userName,
          userNidVerified: Boolean(pubData && pubData.nidVerified),
          hidePublicActivityName: Boolean(pubData && pubData.hidePublicActivityName),
          nowMs: paidTs,
        });
        if (!payload) continue;
        batch.set(doc(db, 'publicActivity', actId), {
          ...payload,
          createdAt: serverTimestamp(),
        });
        batch.update(doc(db, 'withdrawals', wd.id), {
          publicActivityId: actId,
          updatedAt: serverTimestamp(),
        });
        opCount += 2;
      }

      if (opCount > 0 && !cancelled) {
        await batch.commit().catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [deals, withdrawals]);

  // Real-time subscriptions for selected deal's 3-party room (reports, transfers, messages, audit events)
  useEffect(() => {
    if (!selectedDealId) {
      setDealReports([]);
      setDealTransfers([]);
      setDealMessages([]);
      setDealEvents([]);
      return;
    }
    const dealSubUnsubs: (() => void)[] = [];

    dealSubUnsubs.push(
      onSnapshot(
        query(collection(db, 'deals', selectedDealId, 'reports'), limit(80)),
        (snap) => {
          const list: DealReportRecord[] = snap.docs.map((d) => {
            const r = d.data();
            return {
              id: d.id,
              dealId: r.dealId,
              reporterId: r.reporterId,
              reporterName: r.reporterName,
              reporterRole: r.reporterRole,
              category: r.category,
              dealReference: r.dealReference,
              reason: r.reason,
              evidenceImages: Array.isArray(r.evidenceImages) ? r.evidenceImages : [],
              status: r.status,
              adminDecisionNote: r.adminDecisionNote,
              decidedBy: r.decidedBy,
              decidedAtMs: r.decidedAtMs ? Number(r.decidedAtMs) : undefined,
              createdAtMs: r.createdAt?.toMillis ? r.createdAt.toMillis() : Date.now(),
            };
          });
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setDealReports(list);
        },
        () => setDealReports([])
      )
    );

    dealSubUnsubs.push(
      onSnapshot(
        query(collection(db, 'deals', selectedDealId, 'transfers'), limit(50)),
        (snap) => {
          const list: DealTransferSubmission[] = snap.docs.map((d) => {
            const tr = d.data();
            return {
              id: d.id,
              dealId: tr.dealId,
              sellerId: tr.sellerId,
              sellerName: tr.sellerName,
              version: Number(tr.version || 1),
              screenshots: Array.isArray(tr.screenshots) ? tr.screenshots : [],
              transferNote: String(tr.transferNote || ''),
              completedSteps: Array.isArray(tr.completedSteps) ? tr.completedSteps : [],
              status: tr.status,
              buyerDecisionBy: tr.buyerDecisionBy,
              buyerDecisionReason: tr.buyerDecisionReason,
              decidedAtMs: tr.decidedAtMs ? Number(tr.decidedAtMs) : undefined,
              submittedAtMs: Number(
                tr.submittedAtMs || (tr.createdAt?.toMillis ? tr.createdAt.toMillis() : Date.now())
              ),
              createdAtMs: tr.createdAt?.toMillis ? tr.createdAt.toMillis() : Date.now(),
            };
          });
          list.sort((a, b) => b.version - a.version);
          setDealTransfers(list);
        },
        () => setDealTransfers([])
      )
    );

    dealSubUnsubs.push(
      onSnapshot(
        query(collection(db, 'deals', selectedDealId, 'messages'), orderBy('createdAt', 'asc'), limit(120)),
        (snap) => {
          setDealMessages(
            snap.docs.map((d) => {
              const m = d.data();
              return {
                id: d.id,
                senderId: m.senderId,
                senderName: m.senderName,
                senderRole: m.senderRole,
                kind: m.kind,
                text: m.text,
                mediaData: m.mediaData,
                createdAtMs: m.createdAt?.toMillis ? m.createdAt.toMillis() : Date.now(),
              };
            })
          );
        },
        () => setDealMessages([])
      )
    );

    dealSubUnsubs.push(
      onSnapshot(
        query(collection(db, 'deals', selectedDealId, 'events'), orderBy('createdAt', 'desc'), limit(60)),
        (snap) => {
          setDealEvents(
            snap.docs.map((d) => {
              const ev = d.data();
              return {
                id: d.id,
                dealId: ev.dealId,
                actorId: ev.actorId,
                actorRole: ev.actorRole,
                actorName: ev.actorName,
                eventType: ev.eventType,
                summary: ev.summary,
                createdAtMs: Number(
                  ev.createdAtMs || (ev.createdAt?.toMillis ? ev.createdAt.toMillis() : Date.now())
                ),
              };
            })
          );
        },
        () => setDealEvents([])
      )
    );

    return () => dealSubUnsubs.forEach((u) => u());
  }, [selectedDealId]);

  // Load backend health + live Firebase Auth capability snapshot when opening AI Dev health tab
  const fetchSystemHealth = async () => {
    const authCapabilities = await detectFirebaseAuthCapabilities(true).catch(() => null);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : '';
      let resp = await fetch(buildApiUrl('/api/admin/system-health?refresh=1'), {
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
      });
      if (!resp.ok) {
        resp = await fetch(buildApiUrl('/api/health'));
      }
      if (resp.ok) {
        const json = await resp.json();
        setHealthSnapshot({
          ...json,
          firebaseAuthCapabilities: authCapabilities,
          sessionContinuityArchitecture:
            'browserLocalPersistence + pre-boot expiry guard + Identity Toolkit silent GIS renewal',
        });
      } else {
        setHealthSnapshot({
          status: 'static_hosting_mode',
          note: 'Running in static client-to-Firebase mode (e.g. InfinityFree). Firestore & Auth are active; Node AI endpoints require external server.',
          firebaseAuthCapabilities: authCapabilities,
        });
      }
    } catch {
      setHealthSnapshot({
        status: 'static_hosting_mode',
        note: 'Static hosting detected. Firebase Auth & Firestore security rules are active.',
        firebaseAuthCapabilities: authCapabilities,
      });
    }
  };

  const handleEnableCloudServiceFromHealth = async (kind: 'token_service' | 'fcm_apis') => {
    setEnablingCloudService(kind);
    try {
      if (kind === 'token_service') {
        const res = await requestServerEnableTokenService();
        onFlash(res.message);
      } else {
        const res = await enableFcmCloudApisViaServer();
        onFlash(res.message);
      }
      await fetchSystemHealth();
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Cloud API enablement request failed.');
    } finally {
      setEnablingCloudService(null);
    }
  };

  useEffect(() => {
    if (section === 'aidev') {
      fetchSystemHealth();
    }
  }, [section]);

  // --- Moderation Handlers ---
  const handleRunAiEvidenceCheck = async (listing: MarketplaceListing) => {
    if (!evidenceDoc?.evidenceImages?.[0]) {
      onFlash('No monetization screenshot uploaded by seller.');
      return;
    }
    setRunningAiOcr(true);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : '';
      const resp = await fetch(buildApiUrl('/api/ai/verify-evidence'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          platform: listing.platform,
          claimedOptions: listing.claimedOptions,
          imageDataUrl: evidenceDoc.evidenceImages[0],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        onFlash(String(data.error || 'AI screenshot check blocked or unavailable.'));
        return;
      }
      const summary = String(data.summary || 'Queued for manual review.').slice(0, 1900);
      const method = String(data.method || 'manual_queue_fallback').slice(0, 75);
      await updateDoc(doc(db, 'listingEvidence', listing.id), {
        aiSummary: summary,
        aiMethod: method,
        updatedAt: serverTimestamp(),
      });
      setEvidenceDoc((prev) => (prev ? { ...prev, aiSummary: summary, aiMethod: method } : prev));
      onFlash('AI screenshot assessment updated.');
    } catch {
      onFlash('AI endpoint unavailable in static mode — proceed with manual inspection.');
    } finally {
      setRunningAiOcr(false);
    }
  };

  const handleApproveListing = async (listing: MarketplaceListing) => {
    const lockKey = `listing:${listing.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    try {
      const nextVerState =
        listing.monetizationStatus === 'monetized'
          ? verifiedSelections.length > 0
            ? 'active_verified'
            : 'eligible_not_active'
          : 'not_claimed';

      const isFirstPublish = shouldTriggerFollowerPublicationAlert(
        listing.status,
        'active',
        listing.firstPublishedAtMs
      );
      const publishNowMs = Date.now();
      const verifiedOpts = listing.monetizationStatus === 'monetized' ? verifiedSelections : [];

      await updateDoc(doc(db, 'listings', listing.id), {
        status: 'active',
        verifiedOptions: verifiedOpts,
        verificationState: nextVerState,
        rejectionReason: deleteField(),
        ...(isFirstPublish ? { firstPublishedAtMs: publishNowMs } : {}),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(
        adminUid,
        'approve_listing',
        'listing',
        listing.id,
        `Approved listing "${listing.title}" with ${verifiedSelections.length} verified monetization options.`
      );
      await emitUserNotification({
        recipientId: listing.sellerId,
        actorRole: 'admin',
        eventKey: `listing_approved_${listing.id}_${Date.now()}`,
        category: 'listing',
        severity: 'success',
        title: 'Listing Approved & Live!',
        preview: `"${listing.title}" is now live on the BEXORA Marketplace.`,
        body: `Great news! Your ${listing.platform.toUpperCase()} listing "${listing.title}" passed moderation${
          verifiedSelections.length > 0 ? ` with ${verifiedSelections.length} verified monetization badge(s)` : ''
        } and is now live for buyers and bidders on BEXORA.`,
        refType: 'listing',
        refId: listing.id,
        referenceLabel: listing.title.slice(0, 80),
        destination: `listing:${listing.id}`,
      });

      if (isFirstPublish) {
        void fanoutNewListingToFollowers(adminUid, {
          ...listing,
          status: 'active',
          verifiedOptions: verifiedOpts,
          verificationState: nextVerState,
          firstPublishedAtMs: publishNowMs,
        }).catch(() => {
          // Never block or revert listing publication on follower notification delivery error
        });
      }

      void invalidateAndRefreshFinanceOverview();
      onFlash('Listing approved and published to Marketplace!');
      setSelectedListingId(null);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to approve listing.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleRejectListing = async (listing: MarketplaceListing) => {
    const lockKey = `listing:${listing.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    const cleanReason = rejectReason.trim() || 'Incomplete asset verification details.';
    try {
      await updateDoc(doc(db, 'listings', listing.id), {
        status: 'rejected',
        rejectionReason: cleanReason.slice(0, 500),
        verificationState: listing.monetizationStatus === 'monetized' ? 'rejected' : 'not_claimed',
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(adminUid, 'reject_listing', 'listing', listing.id, `Rejected: ${cleanReason}`);
      await emitUserNotification({
        recipientId: listing.sellerId,
        actorRole: 'admin',
        eventKey: `listing_rejected_${listing.id}_${Date.now()}`,
        category: 'listing',
        severity: 'warning',
        title: 'Listing Requires Changes',
        preview: `"${listing.title}" was returned with moderator feedback.`,
        body: `Your listing "${listing.title}" was not approved during moderation.\n\nModerator Reason: ${cleanReason}\n\nYou can review and update your listing details in Profile > My Listings.`,
        refType: 'listing',
        refId: listing.id,
        referenceLabel: listing.title.slice(0, 80),
        destination: 'profile',
      });
      setRejectReason('');
      setSelectedListingId(null);
      void invalidateAndRefreshFinanceOverview();
      onFlash('Listing rejected with note sent to seller.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to reject listing.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleSuspendListing = async (listing: MarketplaceListing) => {
    if (listing.status === 'reserved' || listing.status === 'sold') {
      onFlash('Cannot suspend a listing that has an active reservation or completed escrow deal.');
      return;
    }
    const lockKey = `listing:${listing.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    const cleanReason =
      rejectReason.trim() || 'Listing temporarily suspended by BEXORA Moderation pending compliance review.';
    try {
      await updateDoc(doc(db, 'listings', listing.id), {
        status: 'suspended',
        rejectionReason: cleanReason.slice(0, 500),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(
        adminUid,
        'suspend_listing',
        'listing',
        listing.id,
        `Suspended listing "${listing.title}": ${cleanReason}`
      );
      await emitUserNotification({
        recipientId: listing.sellerId,
        actorRole: 'admin',
        eventKey: `listing_suspended_${listing.id}_${Date.now()}`,
        category: 'listing',
        severity: 'warning',
        title: 'Listing Paused by Moderation',
        preview: `"${listing.title}" has been temporarily suspended from public search.`,
        body: `Your listing "${listing.title}" was temporarily suspended by BEXORA Moderation.\n\nModerator Note: ${cleanReason}\n\nContact BEXORA Support if you have questions or supporting verification documents.`,
        refType: 'listing',
        refId: listing.id,
        referenceLabel: listing.title.slice(0, 80),
        destination: 'profile',
      });
      setRejectReason('');
      setSelectedListingId(null);
      void invalidateAndRefreshFinanceOverview();
      onFlash('Listing suspended from public marketplace.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to suspend listing.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleRestoreSuspendedListing = async (listing: MarketplaceListing) => {
    const lockKey = `listing:${listing.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    try {
      await updateDoc(doc(db, 'listings', listing.id), {
        status: 'active',
        rejectionReason: deleteField(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(
        adminUid,
        'restore_suspended_listing',
        'listing',
        listing.id,
        `Restored suspended listing "${listing.title}" to active`
      );
      await emitUserNotification({
        recipientId: listing.sellerId,
        actorRole: 'admin',
        eventKey: `listing_restored_${listing.id}_${Date.now()}`,
        category: 'listing',
        severity: 'success',
        title: 'Listing Restored to Marketplace',
        preview: `"${listing.title}" is active again on BEXORA.`,
        body: `Your listing "${listing.title}" has been reviewed and restored to active status on the BEXORA Marketplace.`,
        refType: 'listing',
        refId: listing.id,
        referenceLabel: listing.title.slice(0, 80),
        destination: `listing:${listing.id}`,
      });
      setSelectedListingId(null);
      void invalidateAndRefreshFinanceOverview();
      onFlash('Suspended listing restored to live Marketplace!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to restore suspended listing.');
    } finally {
      setBusyItemKey(null);
    }
  };

  // --- NID Handlers ---
  const handleDecisionNid = async (uid: string, approve: boolean, reasonRaw = '') => {
    const lockKey = `nid:${uid}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    const cleanNidReason = (reasonRaw.trim() || 'Images unclear or mismatched. Please upload clear Front & Back photos.').slice(0, 500);
    try {
      await runTransaction(db, async (tx) => {
        const idRef = doc(db, 'identityVerifications', uid);
        const privRef = doc(db, 'privateUsers', uid);
        const pubRef = doc(db, 'publicProfiles', uid);
        const idSnap = await tx.get(idRef);
        if (!idSnap.exists()) throw new Error('NID submission not found.');

        if (approve) {
          tx.update(idRef, {
            status: 'verified',
            reviewedBy: adminUid,
            updatedAt: serverTimestamp(),
          });
          tx.update(privRef, {
            nidStatus: 'verified',
            updatedAt: serverTimestamp(),
          });
          tx.update(pubRef, {
            nidVerified: true,
            updatedAt: serverTimestamp(),
          });
        } else {
          tx.update(idRef, {
            status: 'rejected',
            rejectionReason: cleanNidReason,
            reviewedBy: adminUid,
            updatedAt: serverTimestamp(),
          });
          tx.update(privRef, {
            nidStatus: 'rejected',
            nidRejectionReason: cleanNidReason,
            updatedAt: serverTimestamp(),
          });
          tx.update(pubRef, {
            nidVerified: false,
            updatedAt: serverTimestamp(),
          });
        }
      });
      await writeAuditLog(adminUid, approve ? 'approve_nid' : 'reject_nid', 'identityVerification', uid, approve ? 'NID Verified' : cleanNidReason);
      await emitUserNotification({
        recipientId: uid,
        actorRole: 'admin',
        eventKey: `nid_decision_${approve ? 'verified' : 'rejected'}_${uid}_${Date.now()}`,
        category: 'verification',
        severity: approve ? 'success' : 'warning',
        title: approve ? 'NID Identity Verified!' : 'NID Verification Needs Resubmission',
        preview: approve
          ? 'Your NID Verified badge is now active on your BEXORA profile.'
          : `Your NID verification was declined: ${cleanNidReason}`,
        body: approve
          ? 'Your National ID (Front & Back) verification has been approved by BEXORA Moderation. Your public profile now displays the official NID Verified trust badge.'
          : `Your National ID submission could not be verified.\n\nReason: ${cleanNidReason}\n\nPlease open Profile > NID Verification to upload clear Front & Back photos and resubmit.`,
        refType: 'profile',
        refId: uid,
        referenceLabel: 'NID Identity Verification',
        destination: 'profile:nid',
      });
      setNidRejectReasons((prev) => {
        const next = { ...prev };
        delete next[uid];
        return next;
      });
      void invalidateAndRefreshFinanceOverview();
      onFlash(approve ? 'User NID verified and badge granted!' : 'NID submission rejected.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'NID review update failed.');
    } finally {
      setBusyItemKey(null);
    }
  };

  // --- Deposit Approval / Rejection (Idempotent Transaction) ---
  const handleApproveDeposit = async (dep: DepositRequestRecord) => {
    const lockKey = `dep:${dep.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    try {
      await runTransaction(db, async (tx) => {
        const depRef = doc(db, 'deposits', dep.id);
        const userRef = doc(db, 'privateUsers', dep.userId);
        const ledgerRef = doc(collection(db, 'walletLedger'));

        const depSnap = await tx.get(depRef);
        const userSnap = await tx.get(userRef);
        if (!depSnap.exists() || depSnap.data().status !== 'pending') {
          throw new Error('Deposit request has already been processed.');
        }
        if (!userSnap.exists()) {
          throw new Error('Target user wallet not found.');
        }

        const currentBal = Number(userSnap.data().walletBalanceMinor || 0);
        tx.update(depRef, {
          status: 'approved',
          reviewedBy: adminUid,
          updatedAt: serverTimestamp(),
        });
        tx.update(userRef, {
          walletBalanceMinor: currentBal + dep.amountMinor,
          updatedAt: serverTimestamp(),
        });
        tx.set(ledgerRef, {
          userId: dep.userId,
          kind: 'deposit_approved',
          amountMinor: dep.amountMinor,
          currency: 'BDT',
          referenceId: dep.id,
          note: `Approved ${dep.method.toUpperCase()} deposit (${dep.transactionId})`,
          createdAt: serverTimestamp(),
        });
      });
      await writeAuditLog(adminUid, 'approve_deposit', 'deposit', dep.id, `Credited ${dep.amountMinor} minor BDT to ${dep.userId}`);
      const depFmt = formatMoneyFromMinor(dep.amountMinor, 'BDT', 'BDT');
      await emitUserNotification({
        recipientId: dep.userId,
        actorRole: 'admin',
        eventKey: `deposit_approved_${dep.id}`,
        category: 'wallet',
        severity: 'success',
        title: `Deposit Approved: ${depFmt}`,
        preview: `${depFmt} (${dep.method.toUpperCase()}) has been credited to your BEXORA Wallet.`,
        body: `Your ${dep.method.toUpperCase()} deposit of ${depFmt} (TrxID: ${dep.transactionId}) has been verified and credited to your available BEXORA Wallet balance.`,
        refType: 'wallet',
        refId: dep.id,
        referenceLabel: `${dep.method.toUpperCase()} TrxID ${dep.transactionId}`,
        destination: 'wallet',
      });
      void invalidateAndRefreshFinanceOverview();
      onFlash('Deposit approved and credited to user wallet!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to approve deposit.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleRejectDeposit = async (dep: DepositRequestRecord, reason: string) => {
    const lockKey = `dep:${dep.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    const cleanDepReason = (reason.trim() || 'Transaction ID could not be verified.').slice(0, 500);
    try {
      await updateDoc(doc(db, 'deposits', dep.id), {
        status: 'rejected',
        rejectionReason: cleanDepReason,
        reviewedBy: adminUid,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(adminUid, 'reject_deposit', 'deposit', dep.id, `Rejected deposit ${dep.transactionId}`);
      const depFmt = formatMoneyFromMinor(dep.amountMinor, 'BDT', 'BDT');
      await emitUserNotification({
        recipientId: dep.userId,
        actorRole: 'admin',
        eventKey: `deposit_rejected_${dep.id}`,
        category: 'wallet',
        severity: 'warning',
        title: `Deposit Declined: ${depFmt}`,
        preview: `Your ${dep.method.toUpperCase()} deposit (${dep.transactionId}) could not be verified.`,
        body: `Your ${dep.method.toUpperCase()} deposit request of ${depFmt} (TrxID: ${dep.transactionId}) was declined.\n\nReason: ${cleanDepReason}\n\nPlease verify your Transaction ID and submit a new deposit request or contact BEXORA Support.`,
        refType: 'wallet',
        refId: dep.id,
        referenceLabel: `${dep.method.toUpperCase()} TrxID ${dep.transactionId}`,
        destination: 'wallet',
      });
      setDepositRejectReasons((prev) => {
        const next = { ...prev };
        delete next[dep.id];
        return next;
      });
      void invalidateAndRefreshFinanceOverview();
      onFlash('Deposit request rejected.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to reject deposit.');
    } finally {
      setBusyItemKey(null);
    }
  };

  // --- Withdrawal Payout / Rejection ---
  const handleProcessWithdrawal = async (wd: WithdrawalRequestRecord, markPaid: boolean, noteOrRef: string) => {
    const lockKey = `wd:${wd.id}`;
    if (busyItemKey) return;
    setBusyItemKey(lockKey);
    const cleanRef = (noteOrRef.trim() || (markPaid ? `PAID-${Date.now()}` : 'Invalid payout account details.')).slice(0, markPaid ? 80 : 500);
    try {
      await runTransaction(db, async (tx) => {
        const wdRef = doc(db, 'withdrawals', wd.id);
        const userRef = doc(db, 'privateUsers', wd.userId);
        const pubRef = doc(db, 'publicProfiles', wd.userId);
        const ledgerRef = doc(collection(db, 'walletLedger'));

        const [wdSnap, userSnap, pubSnap] = await Promise.all([
          tx.get(wdRef),
          tx.get(userRef),
          tx.get(pubRef),
        ]);
        if (!wdSnap.exists() || wdSnap.data().status !== 'pending') {
          throw new Error('Withdrawal has already been processed.');
        }
        if (!userSnap.exists()) throw new Error('User wallet missing.');

        const curAvail = Number(userSnap.data().walletBalanceMinor || 0);
        const curRes = Number(userSnap.data().reservedBalanceMinor || 0);
        const nextRes = Math.max(0, curRes - wd.amountMinor);
        const reviewedNowMs = Date.now();

        if (markPaid) {
          const actId = generateOpaquePublicActivityId(reviewedNowMs);
          const payoutPayload = buildSanitizedPayoutTickerPayload({
            withdrawal: {
              ...wd,
              status: 'paid',
              reviewedAtMs: reviewedNowMs,
            },
            userDisplayName: pubSnap.exists()
              ? String(pubSnap.data()?.displayName || wd.userName || '')
              : wd.userName,
            userNidVerified: Boolean(pubSnap.exists() && pubSnap.data()?.nidVerified),
            hidePublicActivityName: Boolean(
              pubSnap.exists() && pubSnap.data()?.hidePublicActivityName
            ),
            nowMs: reviewedNowMs,
          });

          tx.update(wdRef, {
            status: 'paid',
            referenceId: cleanRef,
            reviewedBy: adminUid,
            reviewedAtMs: reviewedNowMs,
            ...(payoutPayload ? { publicActivityId: actId } : {}),
            updatedAt: serverTimestamp(),
          });
          if (payoutPayload) {
            tx.set(doc(db, 'publicActivity', actId), {
              ...payoutPayload,
              createdAt: serverTimestamp(),
            });
          }
          tx.update(userRef, {
            reservedBalanceMinor: nextRes,
            updatedAt: serverTimestamp(),
          });
          tx.set(ledgerRef, {
            userId: wd.userId,
            kind: 'withdrawal_paid',
            amountMinor: wd.amountMinor,
            currency: wd.currency,
            referenceId: wd.id,
            note: `Payout sent via ${wd.method.toUpperCase()}`,
            createdAt: serverTimestamp(),
          });
        } else {
          tx.update(wdRef, {
            status: 'rejected',
            rejectionReason: cleanRef,
            reviewedBy: adminUid,
            reviewedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          });
          tx.update(userRef, {
            walletBalanceMinor: curAvail + wd.amountMinor,
            reservedBalanceMinor: nextRes,
            updatedAt: serverTimestamp(),
          });
          tx.set(ledgerRef, {
            userId: wd.userId,
            kind: 'withdrawal_restored',
            amountMinor: wd.amountMinor,
            currency: wd.currency,
            referenceId: wd.id,
            note: 'Rejected withdrawal restored to available balance',
            createdAt: serverTimestamp(),
          });
        }
      });
      await writeAuditLog(adminUid, markPaid ? 'mark_withdrawal_paid' : 'reject_withdrawal', 'withdrawal', wd.id, cleanRef);
      const wdFmt = formatMoneyFromMinor(wd.amountMinor, wd.currency, wd.currency);
      await emitUserNotification({
        recipientId: wd.userId,
        actorRole: 'admin',
        eventKey: `withdrawal_${markPaid ? 'paid' : 'rejected'}_${wd.id}`,
        category: 'wallet',
        severity: markPaid ? 'success' : 'warning',
        title: markPaid ? `Withdrawal Sent: ${wdFmt}` : `Withdrawal Returned to Wallet: ${wdFmt}`,
        preview: markPaid
          ? `${wdFmt} payout sent via ${wd.method.toUpperCase()} (Ref: ${cleanRef}).`
          : `Your ${wdFmt} withdrawal was declined and restored to your available wallet.`,
        body: markPaid
          ? `Your withdrawal of ${wdFmt} via ${wd.method.toUpperCase()} (${wd.payoutAccount}) has been paid out.\n\nPayout Reference: ${cleanRef}`
          : `Your withdrawal request of ${wdFmt} via ${wd.method.toUpperCase()} could not be completed and the full amount has been restored to your available BEXORA Wallet.\n\nReason: ${cleanRef}`,
        refType: 'wallet',
        refId: wd.id,
        referenceLabel: `${wd.method.toUpperCase()} Withdrawal`,
        destination: 'wallet',
      });
      setWdRefInputs((prev) => {
        const next = { ...prev };
        delete next[wd.id];
        return next;
      });
      setWdRejectReasons((prev) => {
        const next = { ...prev };
        delete next[wd.id];
        return next;
      });
      void invalidateAndRefreshFinanceOverview();
      onFlash(markPaid ? 'Withdrawal marked as Paid!' : 'Withdrawal rejected & funds restored to user.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Withdrawal update failed.');
    } finally {
      setBusyItemKey(null);
    }
  };

  // --- 3-Party Deal & Dispute Review Handlers (All 5 Separated Admin Actions + Chat + Unpaid Restore) ---
  const adminActorLabel = auth.currentUser?.email === BOOTSTRAPPED_SUPERADMIN_EMAIL ? 'BEXORA Superadmin' : 'BEXORA Admin';

  const handleSendAdminDealMessage = async (e: React.FormEvent, deal: DealRecord) => {
    e.preventDefault();
    const cleanText = adminChatInput.trim();
    if (!cleanText || sendingAdminChat) return;
    setSendingAdminChat(true);
    try {
      await addDoc(collection(db, 'deals', deal.id, 'messages'), {
        senderId: adminUid,
        senderName: adminActorLabel,
        senderRole: 'admin',
        kind: 'text',
        text: cleanText.slice(0, 1500),
        createdAt: serverTimestamp(),
      });
      await Promise.all([
        emitUserNotification({
          recipientId: deal.buyerId,
          actorRole: 'admin',
          eventKey: `admin_deal_msg_buyer_${deal.id}_${Date.now()}`,
          category: 'deal',
          severity: 'info',
          title: `Admin Message in Deal #${deal.id.slice(0, 8)}`,
          preview: cleanText.slice(0, 180),
          body: `BEXORA Administration posted a message in your 3-Party Deal Room for "${deal.listingTitle}":\n\n"${cleanText.slice(0, 600)}"`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
        emitUserNotification({
          recipientId: deal.sellerId,
          actorRole: 'admin',
          eventKey: `admin_deal_msg_seller_${deal.id}_${Date.now()}`,
          category: 'deal',
          severity: 'info',
          title: `Admin Message in Deal #${deal.id.slice(0, 8)}`,
          preview: cleanText.slice(0, 180),
          body: `BEXORA Administration posted a message in your 3-Party Deal Room for "${deal.listingTitle}":\n\n"${cleanText.slice(0, 600)}"`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
      ]);
      setAdminChatInput('');
      onFlash('Official Admin message posted to 3-Party Deal Room!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to post admin message.');
    } finally {
      setSendingAdminChat(false);
    }
  };

  // ADMIN ACTION 1: Continue Deal (Dismiss Report(s) & Resume Without Extending originalDeadlineMs)
  const handleAdminContinueDeal = async (deal: DealRecord) => {
    const cleanNote = adminDealNote.trim().slice(0, 1000);
    if (cleanNote.length < 5) {
      onFlash('Enter a documented Admin Decision Note (at least 5 characters) before continuing the deal.');
      return;
    }
    setBusyDealAction('continue');
    try {
      const openReports = dealReports.filter((r) => r.status === 'open' || r.status === 'evidence_requested');
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', deal.id);
        const dSnap = await tx.get(dealRef);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        const dd = dSnap.data();
        if (['settled', 'refunded', 'cancelled'].includes(dd.status)) {
          throw new Error(`Deal is already finalized (${dd.status}).`);
        }

        const origDeadline = Number(dd.originalDeadlineMs || 0);
        const resumedStatus =
          origDeadline > 0
            ? Date.now() >= origDeadline
              ? 'protection_expired'
              : 'security_period_active'
            : dd.latestTransferSubmissionId
            ? 'transfer_submitted'
            : 'paid_deal_room_active';

        for (const rep of openReports) {
          tx.update(doc(db, 'deals', deal.id, 'reports', rep.id), {
            status: 'rejected_resumed',
            adminDecisionNote: cleanNote,
            decidedBy: adminUid,
            decidedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          });
        }

        // CRITICAL: Never alter confirmedAtMs or originalDeadlineMs!
        tx.update(dealRef, {
          status: resumedStatus,
          unresolvedReportCount: 0,
          adminHoldNote: cleanNote,
          updatedAt: serverTimestamp(),
        });
      });

      await addDoc(collection(db, 'deals', deal.id, 'messages'), {
        senderId: adminUid,
        senderName: adminActorLabel,
        senderRole: 'admin',
        kind: 'system',
        text: `ADMIN DECISION — CONTINUE DEAL: Report reviewed and dismissed. Original security deadline remains unchanged. Note: ${cleanNote}`.slice(
          0,
          1500
        ),
        createdAt: serverTimestamp(),
      });

      await Promise.all([
        writeAuditLog(
          adminUid,
          'admin_continue_deal',
          'deal',
          deal.id,
          `Dismissed ${openReports.length} report(s) and resumed deal without extending originalDeadlineMs. Note: ${cleanNote}`
        ),
        appendDealAuditEvent({
          dealId: deal.id,
          actorId: adminUid,
          actorRole: 'admin',
          actorName: adminActorLabel,
          eventType: 'admin_continue_deal',
          summary: `Admin continued deal & preserved original security deadline: ${cleanNote}`,
        }),
        emitUserNotification({
          recipientId: deal.buyerId,
          actorRole: 'admin',
          eventKey: `admin_continue_buyer_${deal.id}_${Date.now()}`,
          category: 'dispute',
          severity: 'info',
          title: 'Dispute Reviewed — Deal Continued',
          preview: `Admin reviewed "${deal.listingTitle}" and resumed the deal under its original timeline.`,
          body: `BEXORA Dispute Resolution reviewed the open report(s) on Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}") and resumed the deal without extending the original security timer.\n\nAdmin Decision Note: ${cleanNote}`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
        emitUserNotification({
          recipientId: deal.sellerId,
          actorRole: 'admin',
          eventKey: `admin_continue_seller_${deal.id}_${Date.now()}`,
          category: 'dispute',
          severity: 'info',
          title: 'Dispute Dismissed — Deal Continued',
          preview: `Admin resumed Deal #${deal.id.slice(0, 8)} ("${deal.listingTitle}"); original timer preserved.`,
          body: `BEXORA Dispute Resolution reviewed the report(s) on Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}") and resumed the escrow deal under its original security deadline.\n\nAdmin Decision Note: ${cleanNote}`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
      ]);
      setAdminDealNote('');
      onFlash('Deal continued! Open reports dismissed and original security timer preserved.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to continue deal.');
    } finally {
      setBusyDealAction(null);
    }
  };

  // ADMIN ACTION 2: Request More Evidence from Buyer / Seller
  const handleAdminRequestEvidence = async (deal: DealRecord) => {
    const cleanNote = adminDealNote.trim().slice(0, 1000);
    if (cleanNote.length < 5) {
      onFlash('Enter specific instructions in the Admin Decision Note (at least 5 characters) explaining what evidence is needed.');
      return;
    }
    setBusyDealAction('evidence');
    try {
      const openReports = dealReports.filter((r) => r.status === 'open' || r.status === 'evidence_requested');
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', deal.id);
        const dSnap = await tx.get(dealRef);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        if (['settled', 'refunded', 'cancelled'].includes(dSnap.data().status)) {
          throw new Error('Cannot request evidence on a finalized deal.');
        }

        for (const rep of openReports) {
          tx.update(doc(db, 'deals', deal.id, 'reports', rep.id), {
            status: 'evidence_requested',
            adminDecisionNote: cleanNote,
            decidedBy: adminUid,
            decidedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          });
        }

        tx.update(dealRef, {
          status: 'reported_under_review',
          unresolvedReportCount: Math.max(1, Number(dSnap.data().unresolvedReportCount || openReports.length || 1)),
          adminHoldNote: `EVIDENCE REQUESTED: ${cleanNote}`.slice(0, 1000),
          updatedAt: serverTimestamp(),
        });
      });

      await addDoc(collection(db, 'deals', deal.id, 'messages'), {
        senderId: adminUid,
        senderName: adminActorLabel,
        senderRole: 'admin',
        kind: 'system',
        text: `ADMIN EVIDENCE REQUEST: Escrow settlement remains paused pending additional proof in this Deal Room. Instructions: ${cleanNote}`.slice(
          0,
          1500
        ),
        createdAt: serverTimestamp(),
      });

      await Promise.all([
        writeAuditLog(adminUid, 'admin_request_evidence', 'deal', deal.id, cleanNote),
        appendDealAuditEvent({
          dealId: deal.id,
          actorId: adminUid,
          actorRole: 'admin',
          actorName: adminActorLabel,
          eventType: 'admin_evidence_requested',
          summary: `Admin requested additional evidence: ${cleanNote}`,
        }),
        emitUserNotification({
          recipientId: deal.buyerId,
          actorRole: 'admin',
          eventKey: `admin_ev_req_buyer_${deal.id}_${Date.now()}`,
          category: 'dispute',
          severity: 'warning',
          title: 'Action Needed: Admin Requested Deal Evidence',
          preview: `Please provide additional proof in Deal #${deal.id.slice(0, 8)} ("${deal.listingTitle}").`,
          body: `BEXORA Dispute Resolution has requested additional evidence on Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}").\n\nAdmin Instructions: ${cleanNote}\n\nPlease reply or upload screenshots inside the 3-Party Deal Room.`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
        emitUserNotification({
          recipientId: deal.sellerId,
          actorRole: 'admin',
          eventKey: `admin_ev_req_seller_${deal.id}_${Date.now()}`,
          category: 'dispute',
          severity: 'warning',
          title: 'Action Needed: Admin Requested Deal Evidence',
          preview: `Please provide additional proof in Deal #${deal.id.slice(0, 8)} ("${deal.listingTitle}").`,
          body: `BEXORA Dispute Resolution has requested additional evidence on Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}").\n\nAdmin Instructions: ${cleanNote}\n\nPlease reply or upload screenshots inside the 3-Party Deal Room.`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
      ]);
      setAdminDealNote('');
      onFlash('Additional evidence requested! Buyer & Seller notified in Deal Room.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to request evidence.');
    } finally {
      setBusyDealAction(null);
    }
  };

  // ADMIN ACTION 3: Reject Deal & Refund Buyer — Exact 102% / 3% Policy (100 BDT + 5 BDT = 105 BDT -> 102 BDT Buyer Refund, 3 BDT Platform Retained)
  const handleAdminRejectAndRefundDeal = async (deal: DealRecord) => {
    const cleanNote = adminDealNote.trim().slice(0, 1000);
    if (cleanNote.length < 5) {
      onFlash('Enter a documented Admin Rejection & Refund Reason (at least 5 characters) before executing a refund.');
      return;
    }
    if (!isDealPaidOrBeyond(deal.status)) {
      onFlash('This deal has not been funded yet. Use "Cancel Unpaid Reservation & Restore Listing" instead.');
      return;
    }

    const refundCalc = calculateDisputeRefundBreakdown(deal);
    const ledgerId = `led_refund_${deal.id}`;
    setBusyDealAction('refund');

    try {
      const openReports = dealReports.filter((r) => r.status === 'open' || r.status === 'evidence_requested');
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', deal.id);
        const buyerPrivRef = doc(db, 'privateUsers', deal.buyerId);
        const ledgerRef = doc(db, 'walletLedger', ledgerId);

        const [dSnap, bSnap, ledSnap] = await Promise.all([
          tx.get(dealRef),
          tx.get(buyerPrivRef),
          tx.get(ledgerRef),
        ]);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        const curStatus = dSnap.data().status;
        if (['settled', 'refunded', 'cancelled', 'accepted_pending_payment', 'awaiting_payment'].includes(curStatus)) {
          throw new Error(`Deal cannot be refunded from status "${curStatus}".`);
        }
        if (ledSnap.exists()) {
          throw new Error('Duplicate refund blocked: deterministic refund ledger already exists for this deal.');
        }
        if (!bSnap.exists()) throw new Error('Buyer wallet record missing.');

        const curBuyerBal = Number(bSnap.data().walletBalanceMinor || 0);

        for (const rep of openReports) {
          tx.update(doc(db, 'deals', deal.id, 'reports', rep.id), {
            status: 'resolved_refund',
            adminDecisionNote: cleanNote,
            decidedBy: adminUid,
            decidedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          });
        }

        tx.update(dealRef, {
          status: 'refunded',
          unresolvedReportCount: 0,
          refundBuyerMinor: refundCalc.buyerRefundMinor,
          refundPlatformRetainedMinor: refundCalc.platformRetainedCommissionMinor,
          refundLedgerId: ledgerId,
          refundedAtMs: Date.now(),
          adminHoldNote: cleanNote,
          updatedAt: serverTimestamp(),
        });

        const buyerRefundWalletBdtMinor = convertOrderMinorToWalletBdtMinor(
          refundCalc.buyerRefundMinor,
          deal.currency,
          settings.usdToBdtRate
        );

        tx.update(buyerPrivRef, {
          walletBalanceMinor: curBuyerBal + buyerRefundWalletBdtMinor,
          updatedAt: serverTimestamp(),
        });

        tx.set(ledgerRef, {
          userId: deal.buyerId,
          kind: 'escrow_refund',
          amountMinor: refundCalc.buyerRefundMinor,
          currency: deal.currency,
          referenceId: deal.id,
          note: `Dispute refund (100% bid + refundable fee; 3% retained) for "${deal.listingTitle}"`.slice(0, 300),
          createdAt: serverTimestamp(),
        });
      });

      const refundFmt = formatMoneyFromMinor(refundCalc.buyerRefundMinor, deal.currency, deal.currency);
      const retainedFmt = formatMoneyFromMinor(
        refundCalc.platformRetainedCommissionMinor,
        deal.currency,
        deal.currency
      );
      const paidFmt = formatMoneyFromMinor(deal.buyerTotalMinor, deal.currency, deal.currency);

      await addDoc(collection(db, 'deals', deal.id, 'messages'), {
        senderId: adminUid,
        senderName: adminActorLabel,
        senderRole: 'admin',
        kind: 'system',
        text: `ADMIN DECISION — DEAL REJECTED & BUYER REFUNDED: Buyer paid ${paidFmt}; ${refundFmt} credited to Buyer Wallet (${retainedFmt} / 3% platform dispute commission retained). Seller payout: 0. Reason: ${cleanNote}`.slice(
          0,
          1500
        ),
        createdAt: serverTimestamp(),
      });

      await Promise.all([
        writeAuditLog(
          adminUid,
          'reject_and_refund_deal',
          'deal',
          deal.id,
          `Refunded ${refundCalc.buyerRefundMinor} minor (${refundFmt}) to buyer ${deal.buyerId}; retained ${refundCalc.platformRetainedCommissionMinor} minor (${retainedFmt}). Reason: ${cleanNote}`
        ),
        appendDealAuditEvent({
          dealId: deal.id,
          actorId: adminUid,
          actorRole: 'admin',
          actorName: adminActorLabel,
          eventType: 'admin_deal_refunded',
          summary: `Deal rejected by Admin. Buyer refunded ${refundFmt}; platform retained ${retainedFmt} (3%). Reason: ${cleanNote}`,
        }),
        emitUserNotification({
          recipientId: deal.buyerId,
          actorRole: 'admin',
          eventKey: `deal_refunded_buyer_${deal.id}`,
          category: 'deal',
          severity: 'info',
          title: `Deal Rejected & Refunded: ${refundFmt}`,
          preview: `${refundFmt} returned to your wallet (${retainedFmt} / 3% dispute fee retained).`,
          body: `BEXORA Administration rejected Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}").\n\nPayment Paid: ${paidFmt}\nRefunded to Your Wallet: ${refundFmt}\nRetained Platform Commission (3%): ${retainedFmt}\n\nAdmin Decision Note: ${cleanNote}`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
        emitUserNotification({
          recipientId: deal.buyerId,
          actorRole: 'admin',
          eventKey: `wallet_escrow_refund_${deal.id}`,
          category: 'wallet',
          severity: 'success',
          title: `Wallet Credited: ${refundFmt} Escrow Refund`,
          preview: `Refund for "${deal.listingTitle}" is now available in your BEXORA Wallet.`,
          body: `${refundFmt} has been credited to your available BEXORA Wallet balance under ledger reference ${ledgerId}.`,
          refType: 'wallet',
          refId: deal.id,
          referenceLabel: ledgerId,
          destination: 'wallet',
        }),
        emitUserNotification({
          recipientId: deal.sellerId,
          actorRole: 'admin',
          eventKey: `deal_refunded_seller_${deal.id}`,
          category: 'deal',
          severity: 'warning',
          title: 'Deal Rejected by Admin & Refunded to Buyer',
          preview: `Deal #${deal.id.slice(0, 8)} ("${deal.listingTitle}") was rejected and closed.`,
          body: `BEXORA Administration rejected Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}") and refunded the buyer (${refundFmt} refunded; ${retainedFmt} platform fee retained; Seller payout: 0).\n\nAdmin Decision Note: ${cleanNote}`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
      ]);
      setAdminDealNote('');
      void invalidateAndRefreshFinanceOverview();
      onFlash(`Deal rejected! Buyer refunded ${refundFmt} (${retainedFmt} platform commission retained).`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Deal refund failed.');
    } finally {
      setBusyDealAction(null);
    }
  };

  // ADMIN ACTION 4: Complete Deal & Release Seller Payout (Idempotent led_release_${dealId})
  const handleAdminSettleAndReleaseDeal = async (deal: DealRecord) => {
    const expiredCleanly =
      deal.originalDeadlineMs > 0 &&
      Date.now() >= deal.originalDeadlineMs &&
      deal.unresolvedReportCount === 0;
    const cleanNote = (
      adminDealNote.trim() ||
      (expiredCleanly
        ? 'Security timer completed with zero open disputes; releasing net seller payout.'
        : '')
    ).slice(0, 1000);

    if (cleanNote.length < 5) {
      onFlash('Enter a documented Admin Settlement Note (at least 5 characters) before releasing funds early.');
      return;
    }
    if (!isDealPaidOrBeyond(deal.status)) {
      onFlash('Cannot release funds on an unpaid deal.');
      return;
    }

    const ledgerId = `led_release_${deal.id}`;
    setBusyDealAction('settle');

    try {
      const openReports = dealReports.filter((r) => r.status === 'open' || r.status === 'evidence_requested');
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', deal.id);
        const sellerPrivRef = doc(db, 'privateUsers', deal.sellerId);
        const buyerPubRef = doc(db, 'publicProfiles', deal.buyerId);
        const sellerPubRef = doc(db, 'publicProfiles', deal.sellerId);
        const ledgerRef = doc(db, 'walletLedger', ledgerId);

        const [dSnap, sPrivSnap, sPubSnap, bPubSnap, ledSnap] = await Promise.all([
          tx.get(dealRef),
          tx.get(sellerPrivRef),
          tx.get(sellerPubRef),
          tx.get(buyerPubRef),
          tx.get(ledgerRef),
        ]);

        if (!dSnap.exists()) throw new Error('Deal not found.');
        const curStatus = dSnap.data().status;
        if (['settled', 'refunded', 'cancelled', 'accepted_pending_payment', 'awaiting_payment'].includes(curStatus)) {
          throw new Error(`Deal cannot be settled from status "${curStatus}".`);
        }
        if (ledSnap.exists()) {
          throw new Error('Duplicate release blocked: deterministic settlement ledger already exists for this deal.');
        }
        if (!sPrivSnap.exists()) throw new Error('Seller wallet record missing.');

        const curSellerBal = Number(sPrivSnap.data().walletBalanceMinor || 0);

        for (const rep of openReports) {
          tx.update(doc(db, 'deals', deal.id, 'reports', rep.id), {
            status: 'resolved_release',
            adminDecisionNote: cleanNote,
            decidedBy: adminUid,
            decidedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          });
        }

        const settledNowMs = Date.now();
        const actId = generateOpaquePublicActivityId(settledNowMs);
        const soldPayload = buildSanitizedSoldTickerPayload({
          deal: {
            ...deal,
            status: 'settled',
            settledAtMs: settledNowMs,
          },
          sellerDisplayName: sPubSnap.exists()
            ? String(sPubSnap.data()?.displayName || deal.sellerName || '')
            : deal.sellerName,
          sellerNidVerified: Boolean(sPubSnap.exists() && sPubSnap.data()?.nidVerified),
          hidePublicActivityName: Boolean(
            sPubSnap.exists() && sPubSnap.data()?.hidePublicActivityName
          ),
          nowMs: settledNowMs,
        });

        tx.update(dealRef, {
          status: 'settled',
          unresolvedReportCount: 0,
          settlementLedgerId: ledgerId,
          settledAtMs: settledNowMs,
          adminHoldNote: cleanNote,
          ...(soldPayload ? { publicActivityId: actId } : {}),
          updatedAt: serverTimestamp(),
        });

        if (soldPayload) {
          tx.set(doc(db, 'publicActivity', actId), {
            ...soldPayload,
            createdAt: serverTimestamp(),
          });
        }

        const sellerPayoutWalletBdtMinor = convertOrderMinorToWalletBdtMinor(
          deal.sellerPayoutMinor,
          deal.currency,
          settings.usdToBdtRate
        );

        tx.update(sellerPrivRef, {
          walletBalanceMinor: curSellerBal + sellerPayoutWalletBdtMinor,
          updatedAt: serverTimestamp(),
        });

        if (sPubSnap.exists()) {
          tx.update(sellerPubRef, {
            completedSales: Number(sPubSnap.data().completedSales || 0) + 1,
            completedTrader: true,
            updatedAt: serverTimestamp(),
          });
        }
        if (bPubSnap.exists()) {
          tx.update(buyerPubRef, {
            completedPurchases: Number(bPubSnap.data().completedPurchases || 0) + 1,
            completedTrader: true,
            updatedAt: serverTimestamp(),
          });
        }

        tx.set(ledgerRef, {
          userId: deal.sellerId,
          kind: 'escrow_release',
          amountMinor: deal.sellerPayoutMinor,
          currency: deal.currency,
          referenceId: deal.id,
          note: `Net seller escrow payout for "${deal.listingTitle}"`.slice(0, 300),
          createdAt: serverTimestamp(),
        });
      });

      const payoutFmt = formatMoneyFromMinor(deal.sellerPayoutMinor, deal.currency, deal.currency);
      await addDoc(collection(db, 'deals', deal.id, 'messages'), {
        senderId: adminUid,
        senderName: adminActorLabel,
        senderRole: 'admin',
        kind: 'system',
        text: `ADMIN DECISION — DEAL COMPLETED & PAYOUT RELEASED: ${payoutFmt} credited to Seller Wallet (Ledger: ${ledgerId}). Note: ${cleanNote}`.slice(
          0,
          1500
        ),
        createdAt: serverTimestamp(),
      });

      await Promise.all([
        writeAuditLog(
          adminUid,
          'settle_escrow_deal',
          'deal',
          deal.id,
          `Released ${deal.sellerPayoutMinor} minor (${payoutFmt}) to seller ${deal.sellerId}. Note: ${cleanNote}`
        ),
        appendDealAuditEvent({
          dealId: deal.id,
          actorId: adminUid,
          actorRole: 'admin',
          actorName: adminActorLabel,
          eventType: 'admin_deal_settled',
          summary: `Deal settled & ${payoutFmt} released to Seller. Note: ${cleanNote}`,
        }),
        emitUserNotification({
          recipientId: deal.sellerId,
          actorRole: 'admin',
          eventKey: `deal_settled_seller_${deal.id}`,
          category: 'deal',
          severity: 'success',
          title: `Escrow Released: ${payoutFmt} Credited!`,
          preview: `Deal settled for "${deal.listingTitle}" — ${payoutFmt} added to your wallet.`,
          body: `Escrow Deal #${deal.id.slice(0, 10)} for "${deal.listingTitle}" is officially completed! Your net seller payout of ${payoutFmt} has been credited to your available BEXORA Wallet.\n\nAdmin Note: ${cleanNote}`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
        emitUserNotification({
          recipientId: deal.sellerId,
          actorRole: 'admin',
          eventKey: `wallet_escrow_release_${deal.id}`,
          category: 'wallet',
          severity: 'success',
          title: `Wallet Credited: ${payoutFmt}`,
          preview: `Escrow payout from "${deal.listingTitle}" is now available to withdraw.`,
          body: `${payoutFmt} from settled Escrow Deal #${deal.id.slice(0, 10)} ("${deal.listingTitle}") was credited to your available BEXORA Wallet under ledger ${ledgerId}.`,
          refType: 'wallet',
          refId: deal.id,
          referenceLabel: ledgerId,
          destination: 'wallet',
        }),
        emitUserNotification({
          recipientId: deal.buyerId,
          actorRole: 'admin',
          eventKey: `deal_settled_buyer_${deal.id}`,
          category: 'deal',
          severity: 'success',
          title: 'Escrow Deal Completed & Settled',
          preview: `"${deal.listingTitle}" escrow is complete. You can now rate the seller.`,
          body: `Escrow Deal #${deal.id.slice(0, 10)} for "${deal.listingTitle}" is officially settled. Thank you for trading safely on BEXORA — you may now leave a verified buyer review in Escrow Deals.\n\nAdmin Note: ${cleanNote}`,
          refType: 'deal',
          refId: deal.id,
          referenceLabel: `Deal #${deal.id.slice(0, 10)}`,
          destination: `deal:${deal.id}`,
        }),
      ]);
      setAdminDealNote('');
      void invalidateAndRefreshFinanceOverview();
      onFlash(`Deal completed! ${payoutFmt} credited to Seller Wallet and trade counters incremented.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Escrow settlement failed.');
    } finally {
      setBusyDealAction(null);
    }
  };

  // ADMIN ACTION 5: Record Official Administrative Decision Note (Audit + Deal Event + Room Notice)
  const handleAdminRecordDecisionNote = async (deal: DealRecord) => {
    const cleanNote = adminDealNote.trim().slice(0, 1000);
    if (cleanNote.length < 5) {
      onFlash('Enter an Administrative Decision Note (at least 5 characters) to record on the audit trail.');
      return;
    }
    setBusyDealAction('note');
    try {
      await updateDoc(doc(db, 'deals', deal.id), {
        adminHoldNote: cleanNote,
        updatedAt: serverTimestamp(),
      });
      await addDoc(collection(db, 'deals', deal.id, 'messages'), {
        senderId: adminUid,
        senderName: adminActorLabel,
        senderRole: 'admin',
        kind: 'system',
        text: `OFFICIAL ADMIN RECORD: ${cleanNote}`.slice(0, 1500),
        createdAt: serverTimestamp(),
      });
      await Promise.all([
        writeAuditLog(adminUid, 'record_deal_decision_note', 'deal', deal.id, cleanNote),
        appendDealAuditEvent({
          dealId: deal.id,
          actorId: adminUid,
          actorRole: 'admin',
          actorName: adminActorLabel,
          eventType: 'admin_decision_recorded',
          summary: `Official Admin Decision Recorded: ${cleanNote}`,
        }),
      ]);
      setAdminDealNote('');
      onFlash('Administrative decision recorded permanently in Deal Timeline and Audit Logs!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to record administrative decision.');
    } finally {
      setBusyDealAction(null);
    }
  };

  // Safe Admin Unpaid Reservation Cancel & Restore Listing
  const handleAdminCancelUnpaidDeal = async (deal: DealRecord) => {
    const cleanNote = (adminDealNote.trim() || 'Unpaid accepted-bid reservation cancelled by Admin; listing restored to active.').slice(
      0,
      500
    );
    setBusyDealAction('cancel_unpaid');
    try {
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', deal.id);
        const listingRef = doc(db, 'listings', deal.listingId);
        const payLedgerRef = doc(db, 'walletLedger', `led_pay_${deal.id}`);

        const [dSnap, lSnap, paySnap] = await Promise.all([
          tx.get(dealRef),
          tx.get(listingRef),
          tx.get(payLedgerRef),
        ]);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        if (!['accepted_pending_payment', 'awaiting_payment'].includes(dSnap.data().status) || paySnap.exists()) {
          throw new Error('Deal is already funded or finalized and cannot be cancelled as unpaid.');
        }

        tx.update(dealRef, {
          status: 'cancelled',
          adminHoldNote: cleanNote,
          updatedAt: serverTimestamp(),
        });

        if (lSnap.exists() && lSnap.data().status === 'reserved' && lSnap.data().activeDealId === deal.id) {
          tx.update(listingRef, {
            status: 'active',
            activeDealId: deleteField(),
            acceptedBidAmountMinor: deleteField(),
            reservedBuyerId: deleteField(),
            reservedUntilMs: deleteField(),
            reservationExpiresAtMs: deleteField(),
            reservationSessionId: deleteField(),
            updatedAt: serverTimestamp(),
          });
        }

        if (deal.acceptedBidId) {
          const bidRef = doc(db, 'bids', deal.acceptedBidId);
          const bSnap = await tx.get(bidRef);
          if (bSnap.exists() && ['accepted_pending_payment', 'accepted'].includes(bSnap.data().status)) {
            tx.update(bidRef, {
              status: 'expired',
              updatedAt: serverTimestamp(),
            });
          }
        }
      });

      await Promise.all([
        writeAuditLog(adminUid, 'cancel_unpaid_reservation', 'deal', deal.id, cleanNote),
        appendDealAuditEvent({
          dealId: deal.id,
          actorId: adminUid,
          actorRole: 'admin',
          actorName: adminActorLabel,
          eventType: 'unpaid_reservation_cancelled',
          summary: cleanNote,
        }),
      ]);
      setAdminDealNote('');
      void invalidateAndRefreshFinanceOverview();
      onFlash('Unpaid reservation cancelled and listing restored to active Marketplace!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to cancel unpaid reservation.');
    } finally {
      setBusyDealAction(null);
    }
  };

  // --- Save Settings Forms ---
  const handleSaveCommissions = async (e: React.FormEvent) => {
    e.preventDefault();
    const bPct = Number(buyerFeePct);
    const sPct = Number(sellerFeePct);
    const rate = Number(usdRate);
    if (!Number.isFinite(bPct) || bPct < 0 || bPct > 50 || !Number.isFinite(sPct) || sPct < 0 || sPct > 50) {
      onFlash('Buyer and Seller fee percentages must be between 0% and 50%.');
      return;
    }
    if (!Number.isFinite(rate) || rate <= 0 || rate > 500) {
      onFlash('USD to BDT rate must be between 1 and 500.');
      return;
    }
    try {
      await savePublicSettingsSafe(
        adminUid,
        {
          buyerFeeEnabled,
          buyerFeePct: bPct,
          sellerFeeEnabled,
          sellerFeePct: sPct,
          usdToBdtRate: rate,
        },
        `Updated commissions: Buyer ${buyerFeeEnabled ? bPct : 0}%, Seller ${sellerFeeEnabled ? sPct : 0}%`
      );
      onFlash('Marketplace Commission & Fee settings saved!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save fee settings.');
    }
  };

  const handleSaveCategoriesConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    const games = gamingText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
    if (games.length === 0) {
      onFlash('Provide at least 1 supported game title.');
      return;
    }
    const ytH = Math.max(1, Math.min(720, Math.round(Number(protYt) || 168)));
    const fbH = Math.max(1, Math.min(720, Math.round(Number(protFb) || 40)));
    const defH = Math.max(1, Math.min(720, Math.round(Number(protDef) || 40)));
    try {
      await savePublicSettingsSafe(
        adminUid,
        {
          disabledMonetizationIds: disabledMonIds,
          gamingTitles: games,
          protectionHoursYoutube: ytH,
          protectionHoursFacebook: fbH,
          protectionHoursDefault: defH,
          customProtectionWindowsEnabled: customProtEnabled,
        },
        `Updated categories, ${games.length} gaming titles, and protection windows (${ytH}h/${fbH}h/${defH}h; customOverride=${customProtEnabled}).`
      );
      onFlash('Category, Gaming & Protection Duration settings saved!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save category settings.');
    }
  };

  const handleSaveSupportContacts = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = supEmail.trim();
    if (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      onFlash('Enter a valid Support Email address.');
      return;
    }
    try {
      await savePublicSettingsSafe(
        adminUid,
        {
          supportWhatsapp: supWa.trim().slice(0, 32),
          supportTelegram: supTg.trim().slice(0, 160),
          supportEmail: cleanEmail.slice(0, 160),
        },
        'Updated Support Contact Settings (WhatsApp, Telegram, Email).'
      );
      onFlash('Support Contact Settings updated live on the Floating Support Button!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save support contacts.');
    }
  };

  const handleSaveBrandingAndNotice = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanSiteName = siteNameInput.trim().slice(0, 60) || 'BEXORA';
    const cleanLogoUrl = logoUrlInput.trim().slice(0, 300);
    if (
      cleanLogoUrl !== '' &&
      cleanLogoUrl !== './icon.svg' &&
      !/^https:\/\/[A-Za-z0-9.\-/:_?=&%]+$/.test(cleanLogoUrl)
    ) {
      onFlash('Logo URL must be empty (default BEXORA emblem), "./icon.svg", or a valid HTTPS image URL.');
      return;
    }
    const safeLangs: LanguageCode[] =
      enabledLanguagesInput.length > 0 ? enabledLanguagesInput : ['en'];
    try {
      await savePublicSettingsSafe(
        adminUid,
        {
          siteName: cleanSiteName,
          brandTagline: brandTaglineInput.trim().slice(0, 140),
          logoUrl: cleanLogoUrl,
          noticeBannerEnabled: Boolean(noticeBannerEnabledInput),
          noticeBannerText: noticeBannerTextInput.trim().slice(0, 280),
          enabledLanguages: safeLangs,
        },
        `Updated Platform Branding (${cleanSiteName}), Notice Banner (enabled=${Boolean(
          noticeBannerEnabledInput
        )}), and ${safeLangs.length} active language(s).`
      );
      onFlash('Platform Branding, Top Notice Banner & Languages updated live!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save branding & notice settings.');
    }
  };

  const handleSaveManualPayments = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await savePublicSettingsSafe(
        adminUid,
        {
          bkashNumber: bkashNum.trim().slice(0, 32),
          nagadNumber: nagadNum.trim().slice(0, 32),
          rocketNumber: rocketNum.trim().slice(0, 32),
        },
        'Updated manual wallet payment numbers (bKash/Nagad/Rocket).'
      );
      onFlash('Manual payment numbers updated live for Wallet Deposits!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save payment numbers.');
    }
  };

  const handleSaveWordPressBridge = async (e: React.FormEvent) => {
    e.preventDefault();
    const urlCheck = validateWordPressSiteUrl(wpSiteUrl);
    if (!urlCheck.valid) {
      onFlash(urlCheck.error || 'Enter a valid HTTPS WordPress URL.');
      return;
    }
    const cleanEndpoint =
      (wpBridgeEndpoint.trim().startsWith('/')
        ? wpBridgeEndpoint.trim()
        : `/${wpBridgeEndpoint.trim()}`
      ).slice(0, 120) || '/wp-json/bexora/v1';

    try {
      await savePublicSettingsSafe(
        adminUid,
        {
          wordpressPaymentEnabled: Boolean(wpEnabled && urlCheck.normalizedUrl),
          wordpressSiteUrl: urlCheck.normalizedUrl,
          wordpressBridgeEndpoint: cleanEndpoint,
        },
        `Updated WordPress Live Payment Bridge (${urlCheck.normalizedUrl || 'not configured'}, enabled=${Boolean(
          wpEnabled && urlCheck.normalizedUrl
        )}).`
      );
      onFlash('WordPress Live Payment Bridge configuration saved!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save WordPress payment settings.');
    }
  };

  const handleTestWordPressBridge = async () => {
    const urlCheck = validateWordPressSiteUrl(wpSiteUrl);
    if (!urlCheck.valid || !urlCheck.normalizedUrl) {
      onFlash(urlCheck.error || 'Enter a valid HTTPS WordPress site URL first.');
      return;
    }
    setTestingWpBridge(true);
    setWpTestResult(null);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : '';
      const qs = new URLSearchParams({
        testDraft: '1',
        siteUrl: urlCheck.normalizedUrl,
        bridgeEndpoint: wpBridgeEndpoint.trim() || '/wp-json/bexora/v1',
      });
      const resp = await fetch(buildApiUrl(`/api/payments/wordpress/methods?${qs.toString()}`), {
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
      });
      if (!resp.ok) {
        throw new Error(`Bridge test failed (${resp.status}).`);
      }
      const data = (await resp.json()) as WordPressGatewayDiscoveryState;
      setWpTestResult(data);
      onFlash(data.userMessage || 'WordPress payment gateway diagnostic completed.');
    } catch (err) {
      onFlash(
        err instanceof Error
          ? err.message
          : 'Could not reach server WordPress bridge diagnostic endpoint.'
      );
    } finally {
      setTestingWpBridge(false);
    }
  };

  const handleSendAdminInvitation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || busyItemKey) return;
    const cleanUid = targetRoleUid.trim();
    if (!cleanUid || cleanUid.length < 4 || cleanUid.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cleanUid)) {
      onFlash('Enter a valid Firebase User UID.');
      return;
    }
    if (cleanUid === adminUid) {
      onFlash('You cannot send an admin role invitation to yourself.');
      return;
    }
    setBusyItemKey(`invite:${cleanUid}`);
    try {
      const inviteId = `inv_${cleanUid}`;
      const cleanName = targetInviteName.trim().slice(0, 80);
      const cleanEmail = targetInviteEmail.trim().slice(0, 160);
      const permissions = targetRoleLevel === 'superadmin' ? ['all'] : ['moderation', 'support'];
      const nowMs = Date.now();
      await setDoc(doc(db, 'adminInvitations', inviteId), {
        targetUid: cleanUid,
        ...(cleanName ? { targetName: cleanName } : {}),
        ...(cleanEmail ? { targetEmail: cleanEmail } : {}),
        role: targetRoleLevel,
        permissions,
        status: 'pending',
        invitedBy: adminUid,
        invitedByName: auth.currentUser?.displayName?.slice(0, 80) || 'BEXORA Superadmin',
        createdAtMs: nowMs,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(
        adminUid,
        'send_admin_invitation',
        'adminInvitation',
        inviteId,
        `Sent ${targetRoleLevel} invitation to UID ${cleanUid}`
      );
      await emitUserNotification({
        recipientId: cleanUid,
        actorRole: 'admin',
        eventKey: `admin_invite_${inviteId}_${nowMs}`,
        category: 'security',
        severity: 'info',
        title: `Admin Role Invitation (${targetRoleLevel.toUpperCase()})`,
        preview: 'You have been invited to join BEXORA Administration. Review in Profile.',
        body: `You received a ${targetRoleLevel.toUpperCase()} role invitation from BEXORA Superadmin. Open your Profile page to Accept or Decline this invitation.`,
        refType: 'profile',
        refId: cleanUid,
        referenceLabel: 'Admin Governance Invitation',
        destination: 'profile',
      }).catch(() => {});
      setTargetRoleUid('');
      setTargetInviteName('');
      setTargetInviteEmail('');
      setRoleBucket('pending');
      onFlash(`Admin invitation sent to UID ${cleanUid}. Admin access activates only after they accept.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to send admin invitation.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleRevokePendingInvitation = async (inv: AdminInvitationRecord) => {
    if (!isSuperAdmin || busyItemKey) return;
    setBusyItemKey(`rev_inv:${inv.id}`);
    try {
      await updateDoc(doc(db, 'adminInvitations', inv.id), {
        status: 'revoked',
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(
        adminUid,
        'revoke_admin_invitation',
        'adminInvitation',
        inv.id,
        `Revoked pending ${inv.role} invitation for ${inv.targetUid}`
      );
      onFlash(`Invitation for ${inv.targetUid} revoked.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to revoke invitation.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleGrantAdminRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin || busyItemKey) return;
    const cleanUid = targetRoleUid.trim();
    if (!cleanUid) return;
    setBusyItemKey(`grant:${cleanUid}`);
    try {
      await setDoc(doc(db, 'admins', cleanUid), {
        uid: cleanUid,
        role: targetRoleLevel,
        permissions: targetRoleLevel === 'superadmin' ? ['all'] : ['moderation', 'support'],
        grantedBy: adminUid,
        createdAt: serverTimestamp(),
      });
      await writeAuditLog(adminUid, 'grant_admin_role', 'admin', cleanUid, `Granted ${targetRoleLevel}`);
      setTargetRoleUid('');
      setTargetInviteName('');
      setTargetInviteEmail('');
      setRoleBucket('accepted');
      onFlash(`Granted ${targetRoleLevel} role directly to UID ${cleanUid}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to grant role.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handleRevokeAdminRole = async (uid: string) => {
    if (!isSuperAdmin || busyItemKey) return;
    setBusyItemKey(`revoke:${uid}`);
    try {
      await deleteDoc(doc(db, 'admins', uid));
      await writeAuditLog(adminUid, 'revoke_admin_role', 'admin', uid, 'Revoked admin document');
      onFlash(`Revoked admin role for ${uid}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to revoke role.');
    } finally {
      setBusyItemKey(null);
    }
  };

  const handlePublishAdminAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!notifTitle.trim() || !notifBody.trim()) {
      onFlash('Notification title and full message body are required.');
      return;
    }
    setSendingAdminNotif(true);
    try {
      const res = await publishAdminNotification({
        mode: notifMode,
        targetUid: notifMode === 'targeted_user' ? notifTargetUid.trim() : undefined,
        category: notifMode === 'broadcast_announcement' ? 'announcement' : notifCategory,
        severity: notifSeverity,
        title: notifTitle.trim(),
        preview: notifPreview.trim() || notifBody.trim().slice(0, 180),
        body: notifBody.trim(),
        destination: notifDestination,
        persistPublicBanner: notifPersistBanner,
      });
      await writeAuditLog(
        adminUid,
        notifMode === 'broadcast_announcement' ? 'broadcast_announcement' : 'send_user_notification',
        'notification',
        res.announcementId || notifTargetUid.trim() || 'broadcast',
        `Delivered "${notifTitle.trim()}" to ${res.deliveredCount} user(s).`
      );
      setNotifTitle('');
      setNotifPreview('');
      setNotifBody('');
      if (notifMode === 'targeted_user') setNotifTargetUid('');
      onFlash(
        notifMode === 'broadcast_announcement'
          ? `Announcement published and delivered to ${res.deliveredCount} member notification feed(s)!`
          : 'Targeted notification delivered to user Notification Center!'
      );
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Could not publish notification.');
    } finally {
      setSendingAdminNotif(false);
    }
  };

  const handleArchiveAnnouncement = async (announcementId: string) => {
    try {
      await archiveAdminAnnouncement(announcementId);
      await writeAuditLog(adminUid, 'archive_announcement', 'announcement', announcementId, 'Archived announcement');
      onFlash('Announcement archived from public feed.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to archive announcement.');
    }
  };

  // --- Superadmin Legacy Listing Image Storage Migration & Config Backup Handlers ---
  const handleMigrateListingImages = async () => {
    if (!isSuperAdmin || migratingListingImages) return;
    setMigratingListingImages(true);
    let totalProcessed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let cursor = '';
    let remainingEstimate: number | null = null;
    setListingMigrationProgress({
      processed: 0,
      failed: 0,
      skipped: 0,
      remainingEstimate: null,
      statusText: 'Starting migration scan…',
    });

    try {
      const idToken = await auth.currentUser?.getIdToken();
      if (!idToken) {
        onFlash('Superadmin authentication is required to migrate listing images.');
        return;
      }

      while (true) {
        const resp = await fetch(buildApiUrl('/api/admin/migrate-listing-images'), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ limit: 10, cursor }),
        });

        const data = (await resp.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          processed?: number;
          failed?: number;
          skipped?: number;
          nextCursor?: string;
          remainingEstimate?: number;
        };

        if (!resp.ok || !data.ok) {
          throw new Error(data.error || `Migration request failed (HTTP ${resp.status}).`);
        }

        const batchProcessed = Number(data.processed || 0);
        const batchFailed = Number(data.failed || 0);
        const batchSkipped = Number(data.skipped || 0);
        const nextCursor = typeof data.nextCursor === 'string' ? data.nextCursor.trim() : '';
        remainingEstimate =
          typeof data.remainingEstimate === 'number' ? data.remainingEstimate : remainingEstimate;

        totalProcessed += batchProcessed;
        totalFailed += batchFailed;
        totalSkipped += batchSkipped;

        const done = batchProcessed === 0 && !nextCursor;
        setListingMigrationProgress({
          processed: totalProcessed,
          failed: totalFailed,
          skipped: totalSkipped,
          remainingEstimate,
          statusText: done
            ? `Completed: ${totalProcessed} migrated, ${totalFailed} failed, ${totalSkipped} skipped.`
            : `Migrating… ${totalProcessed} processed, ${totalFailed} failed${
                remainingEstimate !== null ? ` (~${remainingEstimate} docs remaining)` : ''
              }`,
        });

        if (done || (nextCursor && nextCursor === cursor)) {
          break;
        }
        cursor = nextCursor;
      }

      onFlash(
        `Listing image migration finished: ${totalProcessed} migrated, ${totalFailed} failed.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to migrate listing images.';
      setListingMigrationProgress((prev) => ({
        processed: prev?.processed ?? totalProcessed,
        failed: prev?.failed ?? totalFailed,
        skipped: prev?.skipped ?? totalSkipped,
        remainingEstimate: prev?.remainingEstimate ?? remainingEstimate,
        statusText: `Stopped: ${msg}`,
      }));
      onFlash(msg);
    } finally {
      setMigratingListingImages(false);
    }
  };

  const handleToggleEmergencyStop = async () => {
    const next = !settings.aiEmergencyStop;
    try {
      await savePublicSettingsSafe(
        adminUid,
        { aiEmergencyStop: next },
        `${next ? 'ACTIVATED' : 'CLEARED'} AI Developer Emergency Stop`
      );
      onFlash(next ? 'EMERGENCY STOP ACTIVATED — All AI actions halted.' : 'Emergency Stop cleared.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to toggle Emergency Stop.');
    }
  };

  // Live Sample Calculator + Exact 102%/3% Dispute Refund Preview
  const sampleMinor = Math.max(100, Math.round((Number(calcSampleBdt) || 100) * 100));
  const safeBPct = Math.max(0, Math.min(50, Number(buyerFeePct) || 0));
  const safeSPct = Math.max(0, Math.min(50, Number(sellerFeePct) || 0));
  const liveSample = calculateCommission(sampleMinor, safeBPct, safeSPct, buyerFeeEnabled, sellerFeeEnabled);
  const liveSampleRefund = calculateDisputeRefundBreakdown({
    baseAmountMinor: liveSample.baseAmountMinor,
    buyerFeeMinor: liveSample.buyerFeeMinor,
    buyerTotalMinor: liveSample.buyerTotalMinor,
  });

  const listingQueue = filterAndBucketListings(allListings, {
    bucket: listingBucket,
    query: listingSearch,
    platform: listingPlatformFilter,
  });
  const paginatedListings = paginateAdminItems(listingQueue.items, listingPage, 12);

  const nidQueue = filterAndBucketNids(nidSubmissions, {
    bucket: nidBucket,
    query: nidSearch,
  });
  const paginatedNids = paginateAdminItems(nidQueue.items, nidPage, 10);

  const depositQueue = filterAndBucketDeposits(deposits, {
    bucket: depositBucket,
    query: depositSearch,
  });
  const paginatedDeposits = paginateAdminItems(depositQueue.items, depositPage, 12);

  const withdrawalQueue = filterAndBucketWithdrawals(withdrawals, {
    bucket: withdrawalBucket,
    query: withdrawalSearch,
  });
  const paginatedWithdrawals = paginateAdminItems(withdrawalQueue.items, withdrawalPage, 12);

  useEffect(() => {
    const q = dealSearch.trim();
    if (section !== 'deals' || q.length < 2) {
      setServerSearchedDeals(null);
      setSearchingServerDeals(false);
      return;
    }
    let cancelled = false;
    setSearchingServerDeals(true);
    const tId = window.setTimeout(() => {
      void (async () => {
        try {
          const resp = await fetchWithFreshBearerToken(
            `/api/admin/deals/search?q=${encodeURIComponent(q)}`
          );
          const data = (await resp.json().catch(() => null)) as {
            ok?: boolean;
            deals?: DealRecord[];
          } | null;
          if (!cancelled && resp.ok && data?.ok && Array.isArray(data.deals)) {
            setServerSearchedDeals(data.deals.filter((d) => !d.isDeleted));
          }
        } catch {
          // Live local list remains fallback if offline
        } finally {
          if (!cancelled) setSearchingServerDeals(false);
        }
      })();
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(tId);
    };
  }, [section, dealSearch]);

  const handleConfirmDeleteDeal = async () => {
    if (!dealDeleteTarget || deletingDealId) return;
    const target = dealDeleteTarget;
    setDealDeleteError(null);
    setDeletingDealId(target.id);
    try {
      const resp = await fetchWithFreshBearerToken(
        `/api/admin/deals/${encodeURIComponent(target.id)}/delete`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: dealDeleteReason.trim() }),
        }
      );
      const data = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        dealCode?: string;
        restoredListing?: boolean;
      } | null;
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || 'Could not delete deal.');
      }

      setDeals((prev) => prev.filter((item) => item.id !== target.id));
      setServerSearchedDeals((prev) =>
        prev ? prev.filter((item) => item.id !== target.id) : null
      );
      if (selectedDealId === target.id) {
        setSelectedDealId(null);
      }
      setDealDeleteTarget(null);
      setDealDeleteReason('');
      setDealDeleteError(null);
      void invalidateAndRefreshFinanceOverview();
      onFlash(
        `Deal ${data.dealCode || resolveDisplayDealCode(target)} deleted safely. Wallet ledger & user balances preserved.${
          data.restoredListing ? ' Unpaid listing reservation restored to active.' : ''
        }`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to delete deal.';
      setDealDeleteError(msg);
      onFlash(msg);
    } finally {
      setDeletingDealId(null);
    }
  };

  const mergedAdminDeals = (() => {
    const map = new Map<string, DealRecord>();
    for (const d of deals) {
      if (!d.isDeleted) map.set(d.id, d);
    }
    if (serverSearchedDeals) {
      for (const sd of serverSearchedDeals) {
        if (!sd.isDeleted && !map.has(sd.id)) {
          map.set(sd.id, sd);
        }
      }
    }
    return Array.from(map.values());
  })();

  const dealQueue = filterAdminDeals(mergedAdminDeals, {
    tab: dealFilter,
    query: dealSearch,
  });
  const paginatedDeals = paginateAdminItems(dealQueue.items, dealsPage, 12);

  const governanceQueue = filterAndBucketAdminGovernance(adminRoles, adminInvitations, {
    bucket: roleBucket,
    query: roleSearch,
  });

  const pendingListingsCount = listingQueue.counts.pending;
  const pendingNidsCount = nidQueue.counts.pending_review;
  const pendingDepositsCount = depositQueue.counts.pending;
  const pendingWithdrawalsCount = withdrawalQueue.counts.pending;
  const reportedDealsCount = dealQueue.counts.disputed;
  const readyToSettleDealsCount = dealQueue.counts.ready;

  const selectedModerationListing = allListings.find((l) => l.id === selectedListingId) || null;
  const selectedDeal = mergedAdminDeals.find((d) => d.id === selectedDealId) || null;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {lightboxState && (
        <ImageLightboxModal
          images={lightboxState.images.map((src, idx) => ({
            src,
            caption: lightboxState.caption
              ? `${lightboxState.caption} (${idx + 1}/${lightboxState.images.length})`
              : undefined,
          }))}
          activeIndex={lightboxState.index}
          title={lightboxState.caption || 'Evidence Inspection'}
          onClose={() => setLightboxState(null)}
          onChangeIndex={(nextIdx) =>
            setLightboxState((prev) => (prev ? { ...prev, index: nextIdx } : null))
          }
        />
      )}

      {/* TOP DISPUTE & SETTLEMENT ACTION ALERT BANNER */}
      {(reportedDealsCount > 0 || readyToSettleDealsCount > 0) && (
        <div
          role="region"
          aria-label="Urgent Escrow & Dispute Alerts"
          className="mb-6 bx-card p-4 border-2 border-[#191919] bg-[#FFD400]/25 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
        >
          <div className="flex items-start gap-3">
            <AlertOctagon className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
            <div className="text-xs space-y-0.5">
              <div className="font-black text-sm">
                Escrow Administration Attention Required
              </div>
              <p className="opacity-85">
                {reportedDealsCount > 0 && (
                  <span className="font-extrabold text-red-600">
                    {reportedDealsCount} Disputed Deal(s) Under Hold
                  </span>
                )}
                {reportedDealsCount > 0 && readyToSettleDealsCount > 0 ? ' · ' : ''}
                {readyToSettleDealsCount > 0 && (
                  <span className="font-extrabold text-emerald-700 dark:text-emerald-400">
                    {readyToSettleDealsCount} Completed Timer Deal(s) Ready for Seller Payout Release
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSection('deals');
              setDealFilter(reportedDealsCount > 0 ? 'disputed' : 'ready');
              setDealsPage(1);
            }}
            className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold whitespace-nowrap shrink-0"
          >
            Open Deal & Dispute Review
          </button>
        </div>
      )}

      <div className="flex flex-col lg:flex-row gap-6">
        {/* LEFT-SIDE ADMIN NAVIGATION */}
        <aside className="lg:w-64 shrink-0 space-y-3">
          <div className="bx-card p-4 space-y-1">
            <div className="text-[11px] font-black uppercase tracking-wider text-[#FF6500]">
              {isSuperAdmin ? 'Superadmin Console' : 'Admin Console'}
            </div>
            <div className="text-sm font-black truncate">{auth.currentUser?.email || adminUid}</div>
          </div>

          <nav
            aria-label="Admin Navigation"
            className="bx-card p-2 flex flex-row overflow-x-auto lg:flex-col gap-1.5 lg:gap-1"
          >
            {(
              [
                { id: 'overview', label: 'Overview', icon: Activity },
                { id: 'users', label: 'ALL USERS', icon: Users },
                { id: 'trust_safety', label: 'Trust & Safety (24/7 AI)', icon: ShieldAlert },
                { id: 'moderation', label: `Listings (${pendingListingsCount})`, icon: ShieldCheck },
                { id: 'nid', label: `NID Review (${pendingNidsCount})`, icon: FileCheck2 },
                { id: 'deposits', label: `Deposits (${pendingDepositsCount})`, icon: Wallet },
                { id: 'withdrawals', label: `Withdrawals (${pendingWithdrawalsCount})`, icon: RefreshCw },
                {
                  id: 'deals',
                  label: `Deals & Disputes (${reportedDealsCount + readyToSettleDealsCount})`,
                  icon: ShieldAlert,
                },
                { id: 'commissions', label: 'Fees & Commission', icon: Percent },
                { id: 'categories', label: 'Categories & Games', icon: FolderCog },
                { id: 'support', label: 'Support & Branding', icon: Headset },
                { id: 'payments', label: 'Payment', icon: Layers },
                { id: 'notifications', label: 'Announcements & Alerts', icon: Megaphone },
                { id: 'notification_management', label: 'Notification Management', icon: BellRing },
                { id: 'roles', label: 'Superadmin & Logs', icon: Users },
                { id: 'aidev', label: 'AI Assistant & Audit', icon: Bot },
              ] as { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }> }[]
            ).map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`shrink-0 lg:w-full px-3 py-2.5 min-h-[44px] text-left text-xs font-extrabold flex items-center gap-2 transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#FF6500] text-white border border-[#191919]'
                      : 'hover:bg-[var(--bx-surface-alt)]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        {/* RIGHT-SIDE CONTENT WORKBENCH */}
        <div className="flex-1 min-w-0 space-y-6">
          <Suspense fallback={<PageShellSkeleton label="Loading Admin section…" />}>
          {/* 1. OVERVIEW */}
          {section === 'overview' && (
            <AdminOverviewSection
              settings={settings}
              financeOverview={financeOverview}
              financeLoading={financeLoading}
              financeError={financeError}
              settlingExpiredDeals={settlingExpiredDeals}
              pendingListingsCount={pendingListingsCount}
              pendingNidsCount={pendingNidsCount}
              pendingDepositsCount={pendingDepositsCount}
              pendingWithdrawalsCount={pendingWithdrawalsCount}
              reportedDealsCount={reportedDealsCount}
              readyToSettleDealsCount={readyToSettleDealsCount}
              onRefreshFinance={() => void fetchFinanceOverview(true)}
              onSettleAllExpiredDeals={() => void handleSettleAllExpiredDeals()}
              onNavigateSection={(sec) => setSection(sec)}
              onFlash={onFlash}
            />
          )}

          {/* 1B. ALL USERS MANAGEMENT DIRECTORY */}
          {section === 'users' && (
            <AdminUsersDirectory
              adminUid={adminUid}
              isSuperAdmin={isSuperAdmin}
              displayCurrency={displayCurrency}
              usdToBdtRate={settings.usdToBdtRate}
              onOpenModerationTab={() => setSection('trust_safety')}
              onOpenPublicProfile={onOpenPublicProfile}
              onFlash={onFlash}
            />
          )}

          {/* 2. LISTING MODERATION & VERIFICATION WORKBENCH */}
          {section === 'moderation' && (
            <div className="space-y-5">
              <div className="bx-card p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-black">Listing Moderation &amp; Verification Queues</h1>
                    <p className="text-xs opacity-75 mt-0.5">
                      Review pending submissions, audit live approved listings, and inspect rejected/suspended items by status.
                    </p>
                  </div>
                </div>

                {!selectedModerationListing && (
                  <>
                    <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Listing Status Sections">
                      {(
                        [
                          { id: 'pending', label: `Pending (${listingQueue.counts.pending})` },
                          { id: 'approved', label: `Approved / Live (${listingQueue.counts.approved})` },
                          { id: 'rejected', label: `Rejected (${listingQueue.counts.rejected})` },
                          { id: 'other', label: `Other / Suspended (${listingQueue.counts.other})` },
                        ] as { id: AdminListingBucket; label: string }[]
                      ).map((tab) => (
                        <button
                          key={tab.id}
                          type="button"
                          role="tab"
                          aria-selected={listingBucket === tab.id}
                          onClick={() => {
                            setListingBucket(tab.id);
                            setListingPage(1);
                          }}
                          className={`px-3 py-1.5 text-xs font-extrabold border transition-colors whitespace-nowrap shrink-0 ${
                            listingBucket === tab.id
                              ? 'bg-[#FF6500] text-white border-[#191919]'
                              : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:bg-[var(--bx-surface)]'
                          }`}
                        >
                          {tab.label}
                        </button>
                      ))}
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2">
                      <div className="relative flex-1">
                        <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                        <input
                          type="search"
                          value={listingSearch}
                          onChange={(e) => {
                            setListingSearch(e.target.value);
                            setListingPage(1);
                          }}
                          placeholder="Search title, seller name, @username, ID…"
                          aria-label="Search admin listings"
                          className="bx-input w-full pl-8 pr-3 py-2 text-xs"
                        />
                      </div>
                      <select
                        value={listingPlatformFilter}
                        onChange={(e) => {
                          setListingPlatformFilter(e.target.value as PlatformId | 'all');
                          setListingPage(1);
                        }}
                        aria-label="Filter listings by category"
                        className="bx-input px-3 py-2 text-xs font-bold sm:w-48"
                      >
                        <option value="all">All Categories</option>
                        {PLATFORM_LIST.map((p) => (
                          <option key={p} value={p}>
                            {PLATFORM_CATALOG[p].name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </>
                )}
              </div>

              {selectedModerationListing ? (
                <div className="bx-card p-6 space-y-5">
                  <div className="flex items-center justify-between border-b border-[var(--bx-border)] pb-3">
                    <div>
                      <span className="text-xs font-black uppercase text-[#FF6500]">
                        {selectedModerationListing.platform} · {selectedModerationListing.subcategory}
                      </span>
                      <h2 className="text-lg font-black">{selectedModerationListing.title}</h2>
                      <div className="text-xs opacity-80 mt-0.5">
                        Seller:{' '}
                        <UserProfileLink
                          uid={selectedModerationListing.sellerId}
                          name={selectedModerationListing.sellerName || selectedModerationListing.sellerUsername}
                          username={selectedModerationListing.sellerUsername}
                          onOpenProfile={onOpenPublicProfile}
                          className="font-extrabold"
                        />
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedListingId(null)}
                      className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold"
                    >
                      Close Workbench
                    </button>
                  </div>

                  <p className="text-sm whitespace-pre-line">{selectedModerationListing.description}</p>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-bold">
                    <div className="p-3 border border-[var(--bx-border)]">
                      Price: {formatMoneyFromMinor(selectedModerationListing.priceMinor, displayCurrency, selectedModerationListing.currency, settings.usdToBdtRate)}
                    </div>
                    <div className="p-3 border border-[var(--bx-border)]">
                      Age: {selectedModerationListing.ageYears}y {selectedModerationListing.ageMonths}m
                    </div>
                    <div className="p-3 border border-[var(--bx-border)]">
                      Monetization: {selectedModerationListing.monetizationStatus}
                    </div>
                    <div className="p-3 border border-[var(--bx-border)] truncate">
                      {selectedModerationListing.accountUrl ? (
                        <a
                          href={selectedModerationListing.accountUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[#FF6500] underline inline-flex items-center gap-1"
                        >
                          Open Asset URL <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        `UID: ${selectedModerationListing.gameUid || 'N/A'}`
                      )}
                    </div>
                  </div>

                  {selectedModerationListing.images && selectedModerationListing.images.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-xs font-black uppercase">
                        Public Showcase Gallery ({selectedModerationListing.images.length}/10 screenshots)
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                        {selectedModerationListing.images.map((imgUrl, idx) => (
                          <button
                            key={idx}
                            type="button"
                            onClick={() =>
                              setLightboxState({
                                images: selectedModerationListing.images,
                                index: idx,
                                caption: `${selectedModerationListing.title} — Image ${idx + 1}/${selectedModerationListing.images.length}`,
                              })
                            }
                            className="relative aspect-[4/3] border border-[var(--bx-border)] overflow-hidden bg-black/5 group"
                          >
                            <img
                              src={imgUrl}
                              alt={`Showcase ${idx + 1}`}
                              className="w-full h-full object-cover"
                            />
                            {idx === 0 && (
                              <span className="absolute top-1 left-1 px-1.5 py-0.5 bg-[#191919]/85 text-white text-[10px] font-bold">
                                Cover
                              </span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {listingRevisions.length > 0 && (
                    <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2">
                      <div className="text-xs font-black flex items-center gap-1.5">
                        <History className="w-3.5 h-3.5 text-[#FF6500]" />
                        Seller Edit Revision History ({listingRevisions.length})
                      </div>
                      <div className="divide-y divide-[var(--bx-border)] text-xs">
                        {listingRevisions.map((rev) => (
                          <div key={rev.id} className="py-2 space-y-0.5">
                            <div className="font-bold">{rev.changeSummary}</div>
                            <div className="text-[11px] opacity-75">
                              Previous: &ldquo;{rev.previousTitle}&rdquo; · Prior Status: {rev.previousStatus} ·{' '}
                              {rev.createdAtMs ? new Date(rev.createdAtMs).toLocaleString() : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedModerationListing.monetizationStatus === 'monetized' && (
                    <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h3 className="text-xs font-black uppercase">
                          Private Seller Monetization Evidence ({evidenceDoc?.evidenceImages.length || 0} screenshots)
                        </h3>
                        <button
                          type="button"
                          disabled={runningAiOcr}
                          onClick={() => handleRunAiEvidenceCheck(selectedModerationListing)}
                          className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold inline-flex items-center gap-1.5"
                        >
                          <Sparkles className="w-3.5 h-3.5 text-[#FF6500]" />
                          {runningAiOcr ? 'Analyzing Screenshot…' : 'Run AI Evidence Check'}
                        </button>
                      </div>

                      {evidenceDoc?.aiSummary && (
                        <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface)] text-xs space-y-1">
                          <div className="font-black">AI Assessment ({evidenceDoc.aiMethod}):</div>
                          <p>{evidenceDoc.aiSummary}</p>
                        </div>
                      )}

                      {evidenceDoc && evidenceDoc.evidenceImages.length > 0 ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {evidenceDoc.evidenceImages.map((src, i) => (
                            <img
                              key={i}
                              src={src}
                              alt={`Evidence ${i + 1}`}
                              className="w-full h-48 object-contain border border-[var(--bx-border)] bg-black/5"
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs font-bold text-amber-600">
                          No private monetization screenshot was attached to this listing.
                        </p>
                      )}

                      <div className="space-y-2">
                        <div className="text-xs font-black">Select Monetization Programs Confirmed as Active:</div>
                        <div className="flex flex-wrap gap-2">
                          {selectedModerationListing.claimedOptions.map((optId) => {
                            const checked = verifiedSelections.includes(optId);
                            return (
                              <label
                                key={optId}
                                className="inline-flex items-center gap-2 px-3 py-1.5 border border-[var(--bx-border)] bg-[var(--bx-surface)] text-xs font-bold cursor-pointer"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() =>
                                    setVerifiedSelections((prev) =>
                                      checked ? prev.filter((x) => x !== optId) : [...prev, optId]
                                    )
                                  }
                                />
                                <span>{getMonetizationLabel(optId)}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="flex flex-col sm:flex-row flex-wrap gap-3 pt-2">
                    {selectedModerationListing.status === 'suspended' ? (
                      <button
                        type="button"
                        disabled={busyItemKey === `listing:${selectedModerationListing.id}`}
                        onClick={() => handleRestoreSuspendedListing(selectedModerationListing)}
                        className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                      >
                        <Check className="w-4 h-4" />
                        Restore Suspended Listing to Live
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busyItemKey === `listing:${selectedModerationListing.id}`}
                        onClick={() => handleApproveListing(selectedModerationListing)}
                        className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold inline-flex items-center justify-center gap-1.5 disabled:opacity-60"
                      >
                        <Check className="w-4 h-4" />
                        Approve &amp; Publish Listing
                      </button>
                    )}
                    <div className="flex-1 flex flex-wrap gap-2">
                      <input
                        type="text"
                        value={rejectReason}
                        onChange={(e) => setRejectReason(e.target.value)}
                        placeholder="Moderator reason for seller (reject or suspend)…"
                        className="bx-input flex-1 min-w-[200px] px-3 py-2 text-xs"
                      />
                      {selectedModerationListing.status === 'active' && (
                        <button
                          type="button"
                          disabled={busyItemKey === `listing:${selectedModerationListing.id}`}
                          onClick={() => handleSuspendListing(selectedModerationListing)}
                          className="bx-btn px-4 py-2 text-xs font-extrabold bg-amber-600 text-white border-2 border-[#191919] disabled:opacity-60"
                        >
                          Suspend Listing
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busyItemKey === `listing:${selectedModerationListing.id}`}
                        onClick={() => handleRejectListing(selectedModerationListing)}
                        className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919] disabled:opacity-60"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ) : paginatedListings.items.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No listings match this status section or search query.
                </div>
              ) : (
                <div className="space-y-3">
                  {paginatedListings.items.map((l) => {
                    const badge = getListingStatusBadgeMeta(l.status);
                    return (
                      <div key={l.id} className="bx-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] font-black uppercase px-2 py-0.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                              {badge.label}
                            </span>
                            <span className="text-xs font-bold opacity-75">{l.platform.toUpperCase()}</span>
                            {l.subcategory && (
                              <span className="text-[11px] opacity-65">· {l.subcategory}</span>
                            )}
                          </div>
                          <h3 className="font-black text-sm truncate">{l.title}</h3>
                          <p className="text-xs opacity-80">
                            Seller:{' '}
                            <UserProfileLink
                              uid={l.sellerId}
                              name={l.sellerName || `@${l.sellerUsername}`}
                              username={l.sellerUsername}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-bold"
                            />{' '}
                            · {formatMoneyFromMinor(l.priceMinor, displayCurrency, l.currency, settings.usdToBdtRate)}
                          </p>
                          {l.rejectionReason && (
                            <p className="text-[11px] text-red-600 font-bold">
                              Reason: {l.rejectionReason}
                            </p>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedListingId(l.id)}
                          className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5 shrink-0"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Inspect &amp; Moderate
                        </button>
                      </div>
                    );
                  })}

                  {paginatedListings.totalPages > 1 && (
                    <div className="bx-card p-3 flex items-center justify-between text-xs font-bold">
                      <span>
                        Showing {paginatedListings.startIndex}–{paginatedListings.endIndex} of {paginatedListings.totalItems}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={paginatedListings.page <= 1}
                          onClick={() => setListingPage((p) => Math.max(1, p - 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                          Prev
                        </button>
                        <span>
                          Page {paginatedListings.page} / {paginatedListings.totalPages}
                        </span>
                        <button
                          type="button"
                          disabled={paginatedListings.page >= paginatedListings.totalPages}
                          onClick={() => setListingPage((p) => Math.min(paginatedListings.totalPages, p + 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          Next
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 3. NID IDENTITY VERIFICATIONS */}
          {section === 'nid' && (
            <div className="space-y-4">
              <div className="bx-card p-5 space-y-4">
                <h1 className="text-xl font-black">Private NID Front &amp; Back Verification Queue</h1>
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="NID Status Sections">
                  {(
                    [
                      { id: 'pending_review', label: `Pending Review (${nidQueue.counts.pending_review})` },
                      { id: 'verified', label: `Verified (${nidQueue.counts.verified})` },
                      { id: 'rejected', label: `Rejected (${nidQueue.counts.rejected})` },
                    ] as { id: AdminNidBucket; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={nidBucket === tab.id}
                      onClick={() => {
                        setNidBucket(tab.id);
                        setNidPage(1);
                      }}
                      className={`px-3 py-1.5 text-xs font-extrabold border transition-colors whitespace-nowrap shrink-0 ${
                        nidBucket === tab.id
                          ? 'bg-[#FF6500] text-white border-[#191919]'
                          : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:bg-[var(--bx-surface)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                  <input
                    type="search"
                    value={nidSearch}
                    onChange={(e) => {
                      setNidSearch(e.target.value);
                      setNidPage(1);
                    }}
                    placeholder="Search user UID, reviewer, rejection note…"
                    aria-label="Search NID submissions"
                    className="bx-input w-full pl-8 pr-3 py-2 text-xs"
                  />
                </div>
              </div>

              {paginatedNids.items.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No NID identity verification submissions in this section.
                </div>
              ) : (
                <div className="space-y-4">
                  {paginatedNids.items.map((item) => {
                    const isBusy = busyItemKey === `nid:${item.uid}`;
                    return (
                      <div key={item.uid} className="bx-card p-5 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-sm font-black">
                            Member:{' '}
                            <UserProfileLink
                              uid={item.uid}
                              name={item.uid}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-mono text-xs"
                            />
                          </div>
                          <span className="text-xs font-extrabold uppercase px-2.5 py-1 border border-[var(--bx-border)]">
                            {item.status}
                          </span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div>
                            <div className="text-xs font-bold mb-1">Front Document</div>
                            <img src={item.frontImageData} alt="NID Front" className="w-full h-44 object-contain border border-[var(--bx-border)] bg-black/5" />
                          </div>
                          <div>
                            <div className="text-xs font-bold mb-1">Back Document</div>
                            <img src={item.backImageData} alt="NID Back" className="w-full h-44 object-contain border border-[var(--bx-border)] bg-black/5" />
                          </div>
                        </div>
                        {item.rejectionReason && (
                          <p className="text-xs font-bold text-red-600">
                            Rejection Reason: {item.rejectionReason}
                          </p>
                        )}
                        {item.status === 'pending_review' && (
                          <div className="flex flex-col sm:flex-row flex-wrap gap-2 pt-1">
                            <input
                              type="text"
                              value={nidRejectReasons[item.uid] || ''}
                              onChange={(e) =>
                                setNidRejectReasons((prev) => ({ ...prev, [item.uid]: e.target.value }))
                              }
                              placeholder="Optional rejection reason…"
                              aria-label={`NID rejection reason for ${item.uid}`}
                              className="bx-input flex-1 min-w-[200px] px-3 py-2 text-xs"
                            />
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleDecisionNid(item.uid, true)}
                              className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                            >
                              {isBusy ? 'Processing…' : 'Approve NID & Grant Badge'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleDecisionNid(
                                  item.uid,
                                  false,
                                  nidRejectReasons[item.uid] || 'Document photo blurry or incomplete.'
                                )
                              }
                              className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919] disabled:opacity-60"
                            >
                              Reject Submission
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {paginatedNids.totalPages > 1 && (
                    <div className="bx-card p-3 flex items-center justify-between text-xs font-bold">
                      <span>
                        Showing {paginatedNids.startIndex}–{paginatedNids.endIndex} of {paginatedNids.totalItems}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={paginatedNids.page <= 1}
                          onClick={() => setNidPage((p) => Math.max(1, p - 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                          Prev
                        </button>
                        <span>
                          Page {paginatedNids.page} / {paginatedNids.totalPages}
                        </span>
                        <button
                          type="button"
                          disabled={paginatedNids.page >= paginatedNids.totalPages}
                          onClick={() => setNidPage((p) => Math.min(paginatedNids.totalPages, p + 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          Next
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 4. MANUAL DEPOSIT REQUESTS */}
          {section === 'deposits' && (
            <div className="space-y-4">
              <div className="bx-card p-5 space-y-4">
                <h1 className="text-xl font-black">Manual Wallet Deposit Requests (bKash / Nagad / Rocket)</h1>
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Deposit Status Sections">
                  {(
                    [
                      { id: 'pending', label: `Pending (${depositQueue.counts.pending})` },
                      { id: 'approved', label: `Approved (${depositQueue.counts.approved})` },
                      { id: 'rejected', label: `Rejected (${depositQueue.counts.rejected})` },
                    ] as { id: AdminDepositBucket; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={depositBucket === tab.id}
                      onClick={() => {
                        setDepositBucket(tab.id);
                        setDepositPage(1);
                      }}
                      className={`px-3 py-1.5 text-xs font-extrabold border transition-colors whitespace-nowrap shrink-0 ${
                        depositBucket === tab.id
                          ? 'bg-[#FF6500] text-white border-[#191919]'
                          : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:bg-[var(--bx-surface)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                  <input
                    type="search"
                    value={depositSearch}
                    onChange={(e) => {
                      setDepositSearch(e.target.value);
                      setDepositPage(1);
                    }}
                    placeholder="Search user name, UID, sender number, TrxID…"
                    aria-label="Search deposits"
                    className="bx-input w-full pl-8 pr-3 py-2 text-xs"
                  />
                </div>
              </div>

              {paginatedDeposits.items.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No manual deposit requests in this section.
                </div>
              ) : (
                <div className="space-y-4">
                  {paginatedDeposits.items.map((dep) => {
                    const isBusy = busyItemKey === `dep:${dep.id}`;
                    return (
                      <div key={dep.id} className="bx-card p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-black uppercase px-2 py-0.5 bg-[#FFD400] text-[#191919] border border-[#191919]">
                              {dep.method}
                            </span>
                            <span className="font-black text-base">
                              {formatMoneyFromMinor(dep.amountMinor, 'BDT', 'BDT')}
                            </span>
                            <span className="text-xs font-bold uppercase opacity-75">({dep.status})</span>
                          </div>
                          <p className="text-xs font-bold">
                            User:{' '}
                            <UserProfileLink
                              uid={dep.userId}
                              name={dep.userName}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-extrabold"
                            />{' '}
                            · Sender: {dep.senderNumber} · TrxID: {dep.transactionId}
                          </p>
                          {dep.rejectionReason && (
                            <p className="text-xs font-bold text-red-600">Reason: {dep.rejectionReason}</p>
                          )}
                          {dep.screenshotData && (
                            <img
                              src={dep.screenshotData}
                              alt="Payment proof"
                              className="w-40 h-24 object-cover border border-[var(--bx-border)] mt-2"
                            />
                          )}
                        </div>
                        {dep.status === 'pending' && (
                          <div className="flex flex-col sm:flex-row flex-wrap gap-2 lg:max-w-md w-full lg:justify-end">
                            <input
                              type="text"
                              value={depositRejectReasons[dep.id] || ''}
                              onChange={(e) =>
                                setDepositRejectReasons((prev) => ({ ...prev, [dep.id]: e.target.value }))
                              }
                              placeholder="Optional rejection reason…"
                              aria-label={`Rejection reason for deposit ${dep.transactionId}`}
                              className="bx-input flex-1 min-w-[160px] px-3 py-2 text-xs"
                            />
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleApproveDeposit(dep)}
                              className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                            >
                              {isBusy ? 'Processing…' : 'Approve & Credit'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleRejectDeposit(dep, depositRejectReasons[dep.id] || 'Unmatched TrxID')
                              }
                              className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919] disabled:opacity-60"
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {paginatedDeposits.totalPages > 1 && (
                    <div className="bx-card p-3 flex items-center justify-between text-xs font-bold">
                      <span>
                        Showing {paginatedDeposits.startIndex}–{paginatedDeposits.endIndex} of {paginatedDeposits.totalItems}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={paginatedDeposits.page <= 1}
                          onClick={() => setDepositPage((p) => Math.max(1, p - 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                          Prev
                        </button>
                        <span>
                          Page {paginatedDeposits.page} / {paginatedDeposits.totalPages}
                        </span>
                        <button
                          type="button"
                          disabled={paginatedDeposits.page >= paginatedDeposits.totalPages}
                          onClick={() => setDepositPage((p) => Math.min(paginatedDeposits.totalPages, p + 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          Next
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 5. WITHDRAWAL REQUESTS */}
          {section === 'withdrawals' && (
            <div className="space-y-4">
              <div className="bx-card p-5 space-y-4">
                <h1 className="text-xl font-black">Seller &amp; Wallet Withdrawal Queue</h1>
                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Withdrawal Status Sections">
                  {(
                    [
                      { id: 'pending', label: `Pending (${withdrawalQueue.counts.pending})` },
                      { id: 'paid', label: `Paid (${withdrawalQueue.counts.paid})` },
                      { id: 'rejected', label: `Rejected (${withdrawalQueue.counts.rejected})` },
                    ] as { id: AdminWithdrawalBucket; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={withdrawalBucket === tab.id}
                      onClick={() => {
                        setWithdrawalBucket(tab.id);
                        setWithdrawalPage(1);
                      }}
                      className={`px-3 py-1.5 text-xs font-extrabold border transition-colors whitespace-nowrap shrink-0 ${
                        withdrawalBucket === tab.id
                          ? 'bg-[#FF6500] text-white border-[#191919]'
                          : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:bg-[var(--bx-surface)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                  <input
                    type="search"
                    value={withdrawalSearch}
                    onChange={(e) => {
                      setWithdrawalSearch(e.target.value);
                      setWithdrawalPage(1);
                    }}
                    placeholder="Search member name, UID, payout account, reference ID…"
                    aria-label="Search withdrawals"
                    className="bx-input w-full pl-8 pr-3 py-2 text-xs"
                  />
                </div>
              </div>

              {paginatedWithdrawals.items.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No withdrawal requests in this section.
                </div>
              ) : (
                <div className="space-y-4">
                  {paginatedWithdrawals.items.map((wd) => {
                    const isBusy = busyItemKey === `wd:${wd.id}`;
                    return (
                      <div key={wd.id} className="bx-card p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-black uppercase px-2 py-0.5 border border-[var(--bx-border)]">
                              {wd.method}
                            </span>
                            <span className="font-black text-base">
                              {formatMoneyFromMinor(wd.amountMinor, wd.currency, wd.currency)}
                            </span>
                            <span className="text-xs font-bold uppercase opacity-75">({wd.status})</span>
                          </div>
                          <p className="text-xs font-bold">
                            Member:{' '}
                            <UserProfileLink
                              uid={wd.userId}
                              name={wd.userName}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-extrabold"
                            />{' '}
                            · Destination: {wd.payoutAccount}
                          </p>
                          {wd.referenceId && (
                            <p className="text-xs font-mono text-emerald-700 dark:text-emerald-400 font-bold">
                              Payout Reference: {wd.referenceId}
                            </p>
                          )}
                          {wd.rejectionReason && (
                            <p className="text-xs font-bold text-red-600">
                              Rejection Reason: {wd.rejectionReason}
                            </p>
                          )}
                        </div>
                        {wd.status === 'pending' && (
                          <div className="flex flex-col sm:flex-row flex-wrap gap-2 lg:max-w-lg w-full lg:justify-end">
                            <input
                              type="text"
                              value={wdRefInputs[wd.id] || ''}
                              onChange={(e) =>
                                setWdRefInputs((prev) => ({ ...prev, [wd.id]: e.target.value }))
                              }
                              placeholder="Payout TrxID / Reference…"
                              aria-label={`Payout reference for ${wd.userName}`}
                              className="bx-input flex-1 min-w-[140px] px-3 py-2 text-xs"
                            />
                            <input
                              type="text"
                              value={wdRejectReasons[wd.id] || ''}
                              onChange={(e) =>
                                setWdRejectReasons((prev) => ({ ...prev, [wd.id]: e.target.value }))
                              }
                              placeholder="Optional rejection reason…"
                              aria-label={`Rejection reason for withdrawal ${wd.id}`}
                              className="bx-input flex-1 min-w-[140px] px-3 py-2 text-xs"
                            />
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleProcessWithdrawal(wd, true, wdRefInputs[wd.id] || `PAID-${Date.now()}`)
                              }
                              className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                            >
                              {isBusy ? 'Processing…' : 'Mark Paid'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                handleProcessWithdrawal(
                                  wd,
                                  false,
                                  wdRejectReasons[wd.id] || 'Payout account unreachable'
                                )
                              }
                              className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919] disabled:opacity-60"
                            >
                              Reject &amp; Restore
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {paginatedWithdrawals.totalPages > 1 && (
                    <div className="bx-card p-3 flex items-center justify-between text-xs font-bold">
                      <span>
                        Showing {paginatedWithdrawals.startIndex}–{paginatedWithdrawals.endIndex} of {paginatedWithdrawals.totalItems}
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={paginatedWithdrawals.page <= 1}
                          onClick={() => setWithdrawalPage((p) => Math.max(1, p - 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                          Prev
                        </button>
                        <span>
                          Page {paginatedWithdrawals.page} / {paginatedWithdrawals.totalPages}
                        </span>
                        <button
                          type="button"
                          disabled={paginatedWithdrawals.page >= paginatedWithdrawals.totalPages}
                          onClick={() => setWithdrawalPage((p) => Math.min(paginatedWithdrawals.totalPages, p + 1))}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                        >
                          Next
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 6. ADMIN 3-PARTY DEAL & DISPUTE REVIEW SCREEN */}
          {section === 'deals' && (
            <div className="space-y-5">
              <div className="bx-card p-5 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-black">3-Party Deal Room, Transfer Proof &amp; Dispute Review</h1>
                    <p className="text-xs opacity-80 mt-0.5">
                      Inspect Seller transfer-proof screenshots, Buyer approvals/rejections, immutable security timers (168h YouTube · 40h Standard), and execute atomic escrow settlements or 102%/3% dispute refunds.
                    </p>
                  </div>
                </div>

                {/* Filter Segmented Control */}
                <div className="flex flex-wrap gap-1.5 pt-1" role="tablist" aria-label="Filter Escrow Deals">
                  {(
                    [
                      { id: 'all', label: `All (${dealQueue.counts.all})` },
                      { id: 'disputed', label: `Disputed / On Hold (${dealQueue.counts.disputed})` },
                      { id: 'ready', label: `Timer Complete (${dealQueue.counts.ready})` },
                      { id: 'active', label: `In Progress (${dealQueue.counts.active})` },
                      { id: 'unpaid', label: `Reserved Unpaid (${dealQueue.counts.unpaid})` },
                      { id: 'settled', label: `Settled / Refunded (${dealQueue.counts.settled})` },
                    ] as { id: AdminDealQueueTab; label: string }[]
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="tab"
                      aria-selected={dealFilter === f.id}
                      onClick={() => {
                        setDealFilter(f.id);
                        setDealsPage(1);
                      }}
                      className={`px-3 py-1.5 text-xs font-extrabold border transition-colors whitespace-nowrap shrink-0 ${
                        dealFilter === f.id
                          ? 'bg-[#FF6500] text-white border-[#191919]'
                          : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:bg-[var(--bx-surface)]'
                      }`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                  <input
                    type="search"
                    value={dealSearch}
                    onChange={(e) => {
                      setDealSearch(e.target.value);
                      setDealsPage(1);
                    }}
                    placeholder="Search deal code (BXR-XXXXXX), deal ID, listing title, buyer, seller…"
                    aria-label="Search escrow deals by deal code or participant"
                    className="bx-input w-full pl-8 pr-3 py-2 text-xs"
                  />
                  {searchingServerDeals && (
                    <span className="text-[11px] font-bold opacity-65 mt-1 block">
                      Searching full archive by deal code &amp; participant…
                    </span>
                  )}
                </div>
              </div>

              {paginatedDeals.items.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No deals match the selected filter or search query.
                </div>
              ) : (
                paginatedDeals.items.map((dl) => {
                  const isExpanded = selectedDeal?.id === dl.id;
                  const displayDealCode = resolveDisplayDealCode(dl);
                  const expired = dl.originalDeadlineMs > 0 && Date.now() >= dl.originalDeadlineMs;
                  const readyToSettle =
                    expired &&
                    dl.unresolvedReportCount === 0 &&
                    (isDealSecurityTimerActiveStatus(dl.status) || dl.status === 'protection_expired');
                  const refundPreview = calculateDisputeRefundBreakdown(dl);
                  const isTerminal = ['settled', 'refunded', 'cancelled'].includes(dl.status);
                  const isUnpaid = ['accepted_pending_payment', 'awaiting_payment'].includes(dl.status);

                  return (
                    <div key={dl.id} className="bx-card p-5 space-y-4">
                      {/* Deal Summary Header */}
                      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-bold">
                            <span className="px-2 py-0.5 rounded font-mono font-black bg-[#FF6500]/15 text-[#FF6500] border border-[#FF6500]/30">
                              {displayDealCode}
                            </span>
                            <span className="font-black text-[#FF6500]">{getDealStatusLabel(dl.status)}</span>
                            <span aria-hidden="true">·</span>
                            <span>{dl.platform.toUpperCase()}</span>
                            <span aria-hidden="true">·</span>
                            <span className="font-mono">Deal #{dl.id.slice(0, 10)}</span>
                            {dl.acceptedBidId && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-mono">Accepted Bid #{dl.acceptedBidId.slice(0, 8)}</span>
                              </>
                            )}
                            {dl.unresolvedReportCount > 0 && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-black text-red-600">
                                  {dl.unresolvedReportCount} Open Dispute Report(s) — Settlement Paused
                                </span>
                              </>
                            )}
                            {readyToSettle && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="font-black text-emerald-600">
                                  Security Window Complete — Ready for Final Payout
                                </span>
                              </>
                            )}
                          </div>

                          <h3 className="font-black text-base">{dl.listingTitle}</h3>
                          <p className="text-xs opacity-85 tabular-nums">
                            Buyer:{' '}
                            <UserProfileLink
                              uid={dl.buyerId}
                              name={dl.buyerName}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-bold"
                            />{' '}
                            ({dl.buyerId.slice(0, 8)}…) · Seller:{' '}
                            <UserProfileLink
                              uid={dl.sellerId}
                              name={dl.sellerName}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-bold"
                            />{' '}
                            ({dl.sellerId.slice(0, 8)}…) · Agreed Price:{' '}
                            <span className="font-extrabold">
                              {formatMoneyFromMinor(dl.baseAmountMinor, 'BDT', dl.currency)}
                            </span>{' '}
                            · Buyer Paid:{' '}
                            <span className="font-extrabold">
                              {formatMoneyFromMinor(dl.buyerTotalMinor, 'BDT', dl.currency)}
                            </span>{' '}
                            · Seller Net:{' '}
                            <span className="font-extrabold">
                              {formatMoneyFromMinor(dl.sellerPayoutMinor, 'BDT', dl.currency)}
                            </span>
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedDealId(isExpanded ? null : dl.id);
                              setAdminDealNote('');
                            }}
                            className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold whitespace-nowrap shrink-0"
                          >
                            {isExpanded ? 'Close Review Screen' : 'Inspect Deal & Evidence'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setDealDeleteTarget(dl);
                              setDealDeleteReason('');
                              setDealDeleteError(null);
                            }}
                            className="bx-btn bx-btn-danger px-3 py-2 text-xs font-extrabold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                            aria-label={`Delete deal ${displayDealCode}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>Delete Deal</span>
                          </button>
                        </div>
                      </div>

                      {/* Expanded Full 3-Party Deal & Dispute Review Workbench */}
                      {isExpanded && (
                        <div className="pt-4 border-t-2 border-[var(--bx-border)] space-y-6">
                          {/* A. Financial & Timer Breakdown Grid */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 tabular-nums">
                            <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2 text-xs">
                              <div className="font-black uppercase text-[11px] text-[#FF6500]">
                                Agreed Price, Fee & 102% / 3% Refund Breakdown
                              </div>
                              {dl.originalListingPriceMinor && dl.originalListingPriceMinor !== dl.baseAmountMinor && (
                                <div className="flex justify-between opacity-75">
                                  <span>Original Listing Price:</span>
                                  <span className="line-through">
                                    {formatMoneyFromMinor(dl.originalListingPriceMinor, 'BDT', dl.currency)}
                                  </span>
                                </div>
                              )}
                              <div className="flex justify-between">
                                <span>Agreed Deal / Bid Price:</span>
                                <span className="font-bold">
                                  {formatMoneyFromMinor(dl.baseAmountMinor, 'BDT', dl.currency)}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>Buyer Marketplace Fee ({dl.buyerFeePct}%):</span>
                                <span className="font-bold">
                                  +{formatMoneyFromMinor(dl.buyerFeeMinor, 'BDT', dl.currency)}
                                </span>
                              </div>
                              <div className="flex justify-between font-black border-b border-[var(--bx-border)] pb-1.5">
                                <span>Total Paid Into Escrow:</span>
                                <span>{formatMoneyFromMinor(dl.buyerTotalMinor, 'BDT', dl.currency)}</span>
                              </div>
                              <div className="flex justify-between text-emerald-700 dark:text-emerald-400 font-bold">
                                <span>If Completed → Seller Net Payout:</span>
                                <span>{formatMoneyFromMinor(dl.sellerPayoutMinor, 'BDT', dl.currency)}</span>
                              </div>
                              <div className="flex justify-between text-red-600 font-bold">
                                <span>If Rejected → Buyer Refund (100% Bid + Refundable Fee):</span>
                                <span>{formatMoneyFromMinor(refundPreview.buyerRefundMinor, 'BDT', dl.currency)}</span>
                              </div>
                              <div className="flex justify-between opacity-85">
                                <span>If Rejected → Platform Retained Commission (3%):</span>
                                <span className="font-bold">
                                  {formatMoneyFromMinor(
                                    refundPreview.platformRetainedCommissionMinor,
                                    'BDT',
                                    dl.currency
                                  )}
                                </span>
                              </div>
                            </div>

                            <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2 text-xs">
                              <div className="font-black uppercase text-[11px] text-[#FF6500] flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5" />
                                Security Timer & Ledger Audit Identifiers
                              </div>
                              <div className="flex justify-between">
                                <span>Required Security Window:</span>
                                <span className="font-bold">
                                  {dl.protectionDurationHours} hours (
                                  {dl.platform === 'youtube' ? '7 Days YouTube' : 'Standard Asset'})
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>Buyer Transfer Approval:</span>
                                <span className="font-bold">
                                  {dl.confirmedAtMs > 0
                                    ? new Date(dl.confirmedAtMs).toLocaleString()
                                    : 'Awaiting Buyer Approval'}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>Immutable Security Deadline:</span>
                                <span className="font-bold">
                                  {dl.originalDeadlineMs > 0
                                    ? new Date(dl.originalDeadlineMs).toLocaleString()
                                    : 'Starts After Buyer Approves Transfer'}
                                </span>
                              </div>
                              <div className="flex justify-between">
                                <span>Payment Ledger ID:</span>
                                <span className="font-mono">
                                  {dl.paymentLedgerId || (isUnpaid ? 'Unpaid' : `led_pay_${dl.id.slice(0, 8)}…`)}
                                </span>
                              </div>
                              {dl.settlementLedgerId && (
                                <div className="flex justify-between text-emerald-700 dark:text-emerald-400">
                                  <span>Settlement Ledger ID:</span>
                                  <span className="font-mono">{dl.settlementLedgerId}</span>
                                </div>
                              )}
                              {dl.refundLedgerId && (
                                <div className="flex justify-between text-red-600">
                                  <span>Refund Ledger ID:</span>
                                  <span className="font-mono">{dl.refundLedgerId}</span>
                                </div>
                              )}
                              {dl.adminHoldNote && (
                                <div className="pt-1.5 border-t border-[var(--bx-border)]">
                                  <span className="font-black">Latest Admin Decision Note:</span>{' '}
                                  <span>{dl.adminHoldNote}</span>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* B. Seller Asset-Transfer Proof Submissions (Click to Enlarge in Lightbox) */}
                          <div className="space-y-3">
                            <div className="text-xs font-black uppercase flex items-center gap-1.5">
                              <ImageIcon className="w-4 h-4 text-[#FF6500]" />
                              Seller Asset-Transfer Proof Submissions ({dealTransfers.length})
                            </div>
                            {dealTransfers.length === 0 ? (
                              <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs opacity-75">
                                Seller has not submitted asset-transfer proof screenshots yet.
                              </div>
                            ) : (
                              dealTransfers.map((tr) => (
                                <div
                                  key={tr.id}
                                  className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3 text-xs"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2 font-bold">
                                    <span>
                                      Submission v{tr.version} by {tr.sellerName} ·{' '}
                                      {new Date(tr.submittedAtMs ?? tr.createdAtMs).toLocaleString()}
                                    </span>
                                    <span className="uppercase font-black text-[#FF6500]">
                                      Buyer Review: {tr.status}
                                    </span>
                                  </div>
                                  <p className="whitespace-pre-line">{tr.transferNote}</p>
                                  {tr.completedSteps.length > 0 && (
                                    <div className="text-[11px] opacity-85">
                                      <span className="font-black">Completed Handover Steps:</span>{' '}
                                      {tr.completedSteps.join(' · ')}
                                    </div>
                                  )}
                                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                    {tr.screenshots.map((imgUrl, idx) => (
                                      <button
                                        key={idx}
                                        type="button"
                                        onClick={() =>
                                          setLightboxState({
                                            images: tr.screenshots,
                                            index: idx,
                                            caption: `Seller Transfer Proof v${tr.version} — Screenshot ${idx + 1} of ${tr.screenshots.length}`,
                                          })
                                        }
                                        className="group relative border border-[var(--bx-border)] bg-black/5 overflow-hidden text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#FF6500]"
                                        aria-label={`Enlarge transfer proof v${tr.version} screenshot ${idx + 1}`}
                                      >
                                        <img
                                          src={imgUrl}
                                          alt={`Transfer proof v${tr.version} screenshot ${idx + 1}`}
                                          referrerPolicy="no-referrer"
                                          className="w-full h-32 object-cover"
                                        />
                                        <span className="block px-2 py-1 text-[11px] font-bold bg-[var(--bx-surface)]">
                                          Click to Enlarge #{idx + 1}
                                        </span>
                                      </button>
                                    ))}
                                  </div>
                                  {tr.buyerDecisionReason && (
                                    <div className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface)]">
                                      <span className="font-black">Buyer Rejection / Review Note:</span>{' '}
                                      {tr.buyerDecisionReason}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>

                          {/* C. Structured Dispute Reports & Evidence */}
                          <div className="space-y-3">
                            <div className="text-xs font-black uppercase flex items-center gap-1.5">
                              <ShieldAlert className="w-4 h-4 text-red-600" />
                              Submitted Dispute Reports ({dealReports.length})
                            </div>
                            {dealReports.length === 0 ? (
                              <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs opacity-75">
                                Zero dispute reports filed on this deal.
                              </div>
                            ) : (
                              dealReports.map((rep) => (
                                <div
                                  key={rep.id}
                                  className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2.5 text-xs"
                                >
                                  <div className="flex flex-wrap items-center justify-between gap-2 font-bold">
                                    <span>
                                      Filed by {rep.reporterRole.toUpperCase()}
                                      {rep.reporterName ? ` (${rep.reporterName})` : ''} · Category:{' '}
                                      {rep.category || 'general'} · {new Date(rep.createdAtMs).toLocaleString()}
                                    </span>
                                    <span className="uppercase font-black text-red-600">Status: {rep.status}</span>
                                  </div>
                                  <p className="whitespace-pre-line">{rep.reason}</p>
                                  {rep.evidenceImages && rep.evidenceImages.length > 0 && (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-1">
                                      {rep.evidenceImages.map((imgUrl, idx) => (
                                        <button
                                          key={idx}
                                          type="button"
                                          onClick={() =>
                                            setLightboxState({
                                              images: rep.evidenceImages || [],
                                              index: idx,
                                              caption: `Dispute Report #${rep.id.slice(0, 8)} — Evidence ${idx + 1}`,
                                            })
                                          }
                                          className="border border-[var(--bx-border)] bg-black/5 overflow-hidden text-left"
                                          aria-label={`Enlarge dispute report evidence ${idx + 1}`}
                                        >
                                          <img
                                            src={imgUrl}
                                            alt={`Report evidence ${idx + 1}`}
                                            referrerPolicy="no-referrer"
                                            className="w-full h-28 object-cover"
                                          />
                                          <span className="block px-2 py-1 text-[11px] font-bold bg-[var(--bx-surface)]">
                                            Enlarge Evidence #{idx + 1}
                                          </span>
                                        </button>
                                      ))}
                                    </div>
                                  )}
                                  {rep.adminDecisionNote && (
                                    <div className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface)]">
                                      <span className="font-black">Admin Decision Note:</span> {rep.adminDecisionNote}
                                    </div>
                                  )}
                                </div>
                              ))
                            )}
                          </div>

                          {/* D. 3-Party Deal Room Chat (Buyer + Seller + Admin) & Audit Events */}
                          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                            <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                              <div className="text-xs font-black uppercase flex items-center gap-1.5">
                                <MessageSquare className="w-4 h-4 text-[#FF6500]" />
                                Private 3-Party Deal Room Transcript ({dealMessages.length})
                              </div>
                              <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
                                {dealMessages.length === 0 ? (
                                  <p className="text-xs opacity-70">No messages in this Deal Room yet.</p>
                                ) : (
                                  dealMessages.map((m) => (
                                    <div
                                      key={m.id}
                                      className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface)] text-xs space-y-1"
                                    >
                                      <div className="flex items-center justify-between text-[11px] opacity-75 font-bold">
                                        <span>
                                          {m.senderName} ({(m.senderRole || 'member').toUpperCase()})
                                        </span>
                                        <span>{new Date(m.createdAtMs).toLocaleTimeString()}</span>
                                      </div>
                                      <p className="whitespace-pre-line">{m.text}</p>
                                      {m.mediaData && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            setLightboxState({
                                              images: [m.mediaData as string],
                                              index: 0,
                                              caption: `Chat Attachment from ${m.senderName}`,
                                            })
                                          }
                                          className="block mt-1"
                                          aria-label={`Enlarge chat attachment from ${m.senderName}`}
                                        >
                                          <img
                                            src={m.mediaData}
                                            alt="Chat attachment"
                                            referrerPolicy="no-referrer"
                                            className="w-32 h-20 object-cover border border-[var(--bx-border)]"
                                          />
                                        </button>
                                      )}
                                    </div>
                                  ))
                                )}
                              </div>
                              <form
                                onSubmit={(e) => handleSendAdminDealMessage(e, dl)}
                                className="flex gap-2 pt-1"
                              >
                                <input
                                  type="text"
                                  value={adminChatInput}
                                  onChange={(e) => setAdminChatInput(e.target.value)}
                                  placeholder="Post official Admin message to Buyer & Seller…"
                                  aria-label="Official Admin message to Deal Room"
                                  className="bx-input flex-1 px-3 py-2 text-xs"
                                />
                                <button
                                  type="submit"
                                  disabled={sendingAdminChat || !adminChatInput.trim()}
                                  className="bx-btn bx-btn-primary px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                                >
                                  <Send className="w-3.5 h-3.5" />
                                  Send
                                </button>
                              </form>
                            </div>

                            <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                              <div className="text-xs font-black uppercase flex items-center gap-1.5">
                                <History className="w-4 h-4 text-[#FF6500]" />
                                Immutable Deal Audit Timeline ({dealEvents.length})
                              </div>
                              <div className="max-h-64 overflow-y-auto space-y-2 pr-1">
                                {dealEvents.length === 0 ? (
                                  <p className="text-xs opacity-70">No audit events logged yet.</p>
                                ) : (
                                  dealEvents.map((ev) => (
                                    <div
                                      key={ev.id}
                                      className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface)] text-xs space-y-0.5"
                                    >
                                      <div className="flex items-center justify-between text-[11px] font-bold opacity-75">
                                        <span>
                                          {ev.actorName} ({ev.actorRole.toUpperCase()}) · {ev.eventType}
                                        </span>
                                        <span>{new Date(ev.createdAtMs).toLocaleString()}</span>
                                      </div>
                                      <p>{ev.summary}</p>
                                    </div>
                                  ))
                                )}
                              </div>
                            </div>
                          </div>

                          {/* E. 5 Clearly Separated Administrative Decision Controls */}
                          {!isTerminal && (
                            <div className="p-5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface)] space-y-4">
                              <div>
                                <label
                                  htmlFor={`bx-admin-deal-note-${dl.id}`}
                                  className="block text-xs font-black uppercase mb-1"
                                >
                                  Mandatory Documented Admin Reason / Decision Note (Saved to Deal Audit Trail & Notifications)
                                </label>
                                <textarea
                                  id={`bx-admin-deal-note-${dl.id}`}
                                  rows={2}
                                  value={adminDealNote}
                                  onChange={(e) => setAdminDealNote(e.target.value)}
                                  placeholder="Document the verified findings, evidence reviewed, and reason for your administrative action…"
                                  className="bx-input w-full px-3 py-2 text-xs"
                                />
                              </div>

                              {isUnpaid ? (
                                <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                                  <p className="text-xs opacity-80">
                                    This accepted-bid reservation has not been paid yet. No escrow funds are held.
                                  </p>
                                  <button
                                    type="button"
                                    disabled={busyDealAction !== null}
                                    onClick={() => handleAdminCancelUnpaidDeal(dl)}
                                    className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919] whitespace-nowrap shrink-0"
                                  >
                                    {busyDealAction === 'cancel_unpaid'
                                      ? 'Restoring Listing…'
                                      : 'Cancel Unpaid Reservation & Restore Listing'}
                                  </button>
                                </div>
                              ) : (
                                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                                  {/* 1. Continue Deal */}
                                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-2">
                                    <div className="text-xs space-y-1">
                                      <div className="font-black">1. Continue Deal</div>
                                      <p className="text-[11px] opacity-80">
                                        Dismiss invalid/resolved report(s) and resume without extending the original security timer.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={busyDealAction !== null}
                                      onClick={() => handleAdminContinueDeal(dl)}
                                      className="bx-btn bx-btn-ghost w-full py-2 text-xs font-extrabold"
                                    >
                                      {busyDealAction === 'continue' ? 'Continuing…' : 'Continue Deal'}
                                    </button>
                                  </div>

                                  {/* 2. Request More Evidence */}
                                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-2">
                                    <div className="text-xs space-y-1">
                                      <div className="font-black">2. Request More Evidence</div>
                                      <p className="text-[11px] opacity-80">
                                        Keep escrow paused and notify Buyer & Seller to upload additional proof in the Deal Room.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={busyDealAction !== null}
                                      onClick={() => handleAdminRequestEvidence(dl)}
                                      className="bx-btn bx-btn-ghost w-full py-2 text-xs font-extrabold"
                                    >
                                      {busyDealAction === 'evidence' ? 'Requesting…' : 'Request More Evidence'}
                                    </button>
                                  </div>

                                  {/* 3. Record Administrative Decision */}
                                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-2">
                                    <div className="text-xs space-y-1">
                                      <div className="font-black">3. Record Decision Note</div>
                                      <p className="text-[11px] opacity-80">
                                        Log an official administrative ruling to the Deal Room & Audit Log without moving funds yet.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={busyDealAction !== null}
                                      onClick={() => handleAdminRecordDecisionNote(dl)}
                                      className="bx-btn bx-btn-ghost w-full py-2 text-xs font-extrabold"
                                    >
                                      {busyDealAction === 'note' ? 'Recording…' : 'Record Admin Decision'}
                                    </button>
                                  </div>

                                  {/* 4. Complete Deal & Release Seller Payout */}
                                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-2">
                                    <div className="text-xs space-y-1">
                                      <div className="font-black text-emerald-700 dark:text-emerald-400">
                                        4. Complete Deal & Release Seller Payout
                                      </div>
                                      <p className="text-[11px] opacity-80">
                                        Credits{' '}
                                        <span className="font-bold">
                                          {formatMoneyFromMinor(dl.sellerPayoutMinor, 'BDT', dl.currency)}
                                        </span>{' '}
                                        to Seller Wallet via idempotent ledger <span className="font-mono">led_release_</span>.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={busyDealAction !== null}
                                      onClick={() => handleAdminSettleAndReleaseDeal(dl)}
                                      className="bx-btn bx-btn-primary w-full py-2 text-xs font-extrabold"
                                    >
                                      {busyDealAction === 'settle'
                                        ? 'Releasing Payout…'
                                        : `Release Seller Payout (${formatMoneyFromMinor(dl.sellerPayoutMinor, 'BDT', dl.currency)})`}
                                    </button>
                                  </div>

                                  {/* 5. Reject Deal & Refund Buyer (102% / 3% Policy) */}
                                  <div className="p-3 border border-red-600/50 bg-[var(--bx-surface-alt)] md:col-span-2 flex flex-col justify-between gap-2">
                                    <div className="text-xs space-y-1">
                                      <div className="font-black text-red-600">
                                        5. Reject Deal & Refund Buyer (Exact 3% Retained Policy)
                                      </div>
                                      <p className="text-[11px] opacity-85">
                                        Buyer paid{' '}
                                        <span className="font-bold">
                                          {formatMoneyFromMinor(dl.buyerTotalMinor, 'BDT', dl.currency)}
                                        </span>{' '}
                                        → Refunds{' '}
                                        <span className="font-extrabold">
                                          {formatMoneyFromMinor(refundPreview.buyerRefundMinor, 'BDT', dl.currency)}
                                        </span>{' '}
                                        to Buyer Wallet · Platform retains{' '}
                                        <span className="font-extrabold">
                                          {formatMoneyFromMinor(
                                            refundPreview.platformRetainedCommissionMinor,
                                            'BDT',
                                            dl.currency
                                          )}
                                        </span>{' '}
                                        (3% commission) · Seller receives 0.
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={busyDealAction !== null}
                                      onClick={() => handleAdminRejectAndRefundDeal(dl)}
                                      className="bx-btn w-full py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919]"
                                    >
                                      {busyDealAction === 'refund'
                                        ? 'Processing Refund…'
                                        : `Reject Deal & Refund Buyer ${formatMoneyFromMinor(refundPreview.buyerRefundMinor, 'BDT', dl.currency)}`}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {paginatedDeals.totalPages > 1 && (
                <div className="bx-card p-3 flex items-center justify-between text-xs font-bold">
                  <span>
                    Showing {paginatedDeals.startIndex}–{paginatedDeals.endIndex} of {paginatedDeals.totalItems}
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={paginatedDeals.page <= 1}
                      onClick={() => setDealsPage((p) => Math.max(1, p - 1))}
                      className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Prev
                    </button>
                    <span>
                      Page {paginatedDeals.page} / {paginatedDeals.totalPages}
                    </span>
                    <button
                      type="button"
                      disabled={paginatedDeals.page >= paginatedDeals.totalPages}
                      onClick={() => setDealsPage((p) => Math.min(paginatedDeals.totalPages, p + 1))}
                      className="bx-btn bx-btn-ghost px-2.5 py-1 inline-flex items-center gap-1 disabled:opacity-40"
                    >
                      Next
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 7. MARKETPLACE FEES & COMMISSION ENGINE */}
          {section === 'commissions' && (
            <AdminCommissionsSection
              buyerFeeEnabled={buyerFeeEnabled}
              setBuyerFeeEnabled={setBuyerFeeEnabled}
              buyerFeePct={buyerFeePct}
              setBuyerFeePct={setBuyerFeePct}
              sellerFeeEnabled={sellerFeeEnabled}
              setSellerFeeEnabled={setSellerFeeEnabled}
              sellerFeePct={sellerFeePct}
              setSellerFeePct={setSellerFeePct}
              usdRate={usdRate}
              setUsdRate={setUsdRate}
              calcSampleBdt={calcSampleBdt}
              setCalcSampleBdt={setCalcSampleBdt}
              liveSample={liveSample}
              liveSampleRefund={liveSampleRefund}
              onSubmit={handleSaveCommissions}
            />
          )}

          {/* 8. CATEGORIES, MONETIZATION & GAMING TITLES */}
          {section === 'categories' && (
            <AdminCategoriesSection
              customProtEnabled={customProtEnabled}
              setCustomProtEnabled={setCustomProtEnabled}
              protYt={protYt}
              setProtYt={setProtYt}
              protFb={protFb}
              setProtFb={setProtFb}
              protDef={protDef}
              setProtDef={setProtDef}
              gamingText={gamingText}
              setGamingText={setGamingText}
              disabledMonIds={disabledMonIds}
              setDisabledMonIds={setDisabledMonIds}
              onSubmit={handleSaveCategoriesConfig}
            />
          )}

          {/* 9. SUPPORT CONTACTS, BRANDING, NOTICE BANNER & LANGUAGES */}
          {section === 'support' && (
            <AdminSupportAndBrandingSection
              supWa={supWa}
              setSupWa={setSupWa}
              supTg={supTg}
              setSupTg={setSupTg}
              supEmail={supEmail}
              setSupEmail={setSupEmail}
              siteNameInput={siteNameInput}
              setSiteNameInput={setSiteNameInput}
              logoUrlInput={logoUrlInput}
              setLogoUrlInput={setLogoUrlInput}
              brandTaglineInput={brandTaglineInput}
              setBrandTaglineInput={setBrandTaglineInput}
              noticeBannerEnabledInput={noticeBannerEnabledInput}
              setNoticeBannerEnabledInput={setNoticeBannerEnabledInput}
              noticeBannerTextInput={noticeBannerTextInput}
              setNoticeBannerTextInput={setNoticeBannerTextInput}
              enabledLanguagesInput={enabledLanguagesInput}
              setEnabledLanguagesInput={setEnabledLanguagesInput}
              onSaveSupportContacts={handleSaveSupportContacts}
              onSaveBrandingAndNotice={handleSaveBrandingAndNotice}
            />
          )}

          {/* 10. COMPLETE PAYMENT MANAGEMENT SYSTEM */}
          {section === 'payments' && (
            <div className="space-y-6 max-w-6xl">
              <AdminPaymentManagement
                getIdToken={async () => (auth.currentUser ? await auth.currentUser.getIdToken() : '')}
              />
            </div>
          )}

          {/* 11. SUPERADMIN ROLE MANAGEMENT & AUDIT LOGS */}
          {section === 'roles' && (
            <div className="space-y-6">
              <div className="bx-card p-6 space-y-5">
                <div>
                  <h1 className="text-xl font-black">Superadmin &amp; Admin Governance</h1>
                  <p className="text-xs opacity-75 mt-1">
                    Bootstrapped Superadmin Email: <strong>{BOOTSTRAPPED_SUPERADMIN_EMAIL}</strong> (enforced directly in Firestore Security Rules). Pending or rejected invitations never grant administrator permissions until explicitly accepted by the invited user.
                  </p>
                </div>

                {isSuperAdmin ? (
                  <form onSubmit={handleSendAdminInvitation} className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                    <div className="text-xs font-black uppercase">Invite or Assign Administrator Role</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <input
                        type="text"
                        required
                        value={targetRoleUid}
                        onChange={(e) => setTargetRoleUid(e.target.value)}
                        placeholder="Target Firebase User UID *"
                        className="bx-input px-3 py-2 text-xs font-mono"
                      />
                      <input
                        type="text"
                        value={targetInviteName}
                        onChange={(e) => setTargetInviteName(e.target.value)}
                        placeholder="Display Name (optional)"
                        maxLength={80}
                        className="bx-input px-3 py-2 text-xs"
                      />
                      <input
                        type="email"
                        value={targetInviteEmail}
                        onChange={(e) => setTargetInviteEmail(e.target.value)}
                        placeholder="Email (optional)"
                        maxLength={160}
                        className="bx-input px-3 py-2 text-xs"
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select
                        value={targetRoleLevel}
                        onChange={(e) => setTargetRoleLevel(e.target.value as 'admin' | 'superadmin')}
                        className="bx-input px-3 py-2 text-xs font-bold"
                      >
                        <option value="admin">Admin</option>
                        <option value="superadmin">Superadmin</option>
                      </select>
                      <button
                        type="submit"
                        disabled={Boolean(busyItemKey)}
                        className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                      >
                        Send Role Invitation
                      </button>
                      <button
                        type="button"
                        disabled={Boolean(busyItemKey) || !targetRoleUid.trim()}
                        onClick={(e) => void handleGrantAdminRole(e as unknown as React.FormEvent)}
                        className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold disabled:opacity-60"
                      >
                        Direct Grant (Instant)
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="text-xs font-bold text-amber-600">Only Superadmins can invite, grant, or revoke admin roles.</p>
                )}

                <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Admin Governance Sections">
                  {(
                    [
                      { id: 'pending', label: `Pending Invitations (${governanceQueue.counts.pending})` },
                      { id: 'accepted', label: `Accepted / Active (${governanceQueue.counts.accepted})` },
                      { id: 'rejected', label: `Rejected (${governanceQueue.counts.rejected})` },
                    ] as { id: AdminRoleBucket; label: string }[]
                  ).map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={roleBucket === tab.id}
                      onClick={() => setRoleBucket(tab.id)}
                      className={`px-3 py-1.5 text-xs font-extrabold border transition-colors whitespace-nowrap shrink-0 ${
                        roleBucket === tab.id
                          ? 'bg-[#FF6500] text-white border-[#191919]'
                          : 'bg-[var(--bx-surface-alt)] border-[var(--bx-border)] hover:bg-[var(--bx-surface)]'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                  <input
                    type="search"
                    value={roleSearch}
                    onChange={(e) => setRoleSearch(e.target.value)}
                    placeholder="Search UID, name, email, role…"
                    aria-label="Search admin governance records"
                    className="bx-input w-full pl-8 pr-3 py-2 text-xs"
                  />
                </div>

                {roleBucket === 'pending' && (
                  <div className="space-y-2">
                    {governanceQueue.pendingInvites.length === 0 ? (
                      <p className="text-xs opacity-75">No pending admin invitations.</p>
                    ) : (
                      governanceQueue.pendingInvites.map((inv) => (
                        <div key={inv.id} className="p-3 border border-[var(--bx-border)] flex flex-wrap items-center justify-between gap-2 text-xs font-bold">
                          <div className="space-y-0.5">
                            <div>
                              <UserProfileLink
                                uid={inv.targetUid}
                                name={inv.targetName || inv.targetUid}
                                onOpenProfile={onOpenPublicProfile}
                                className="font-extrabold"
                              />{' '}
                              · Role: <span className="text-[#FF6500]">{inv.role.toUpperCase()}</span>
                              {inv.targetEmail && <span className="opacity-75"> · {inv.targetEmail}</span>}
                            </div>
                            <div className="text-[11px] opacity-70 font-mono">
                              UID: {inv.targetUid} · Sent {new Date(inv.createdAtMs).toLocaleString()}
                            </div>
                          </div>
                          {isSuperAdmin && (
                            <button
                              type="button"
                              disabled={busyItemKey === `rev_inv:${inv.id}`}
                              onClick={() => void handleRevokePendingInvitation(inv)}
                              className="text-red-600 underline font-extrabold disabled:opacity-50"
                            >
                              Revoke Invite
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {roleBucket === 'accepted' && (
                  <div className="space-y-2">
                    {governanceQueue.acceptedAdmins.length === 0 ? (
                      <p className="text-xs opacity-75">No active admin records match this search.</p>
                    ) : (
                      governanceQueue.acceptedAdmins.map((r) => (
                        <div key={r.uid} className="p-3 border border-[var(--bx-border)] flex flex-wrap items-center justify-between gap-2 text-xs font-bold">
                          <div>
                            <UserProfileLink
                              uid={r.uid}
                              name={r.displayName || r.uid}
                              onOpenProfile={onOpenPublicProfile}
                              className="font-extrabold"
                            />{' '}
                            · Role: <span className="text-emerald-700 dark:text-emerald-400">{r.role.toUpperCase()}</span>
                            {r.email && <span className="opacity-75"> · {r.email}</span>}
                            <div className="text-[11px] opacity-70 font-mono">UID: {r.uid}</div>
                          </div>
                          {isSuperAdmin && (
                            <button
                              type="button"
                              disabled={busyItemKey === `revoke:${r.uid}`}
                              onClick={() => handleRevokeAdminRole(r.uid)}
                              className="text-red-600 underline font-extrabold disabled:opacity-50"
                            >
                              Revoke
                            </button>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}

                {roleBucket === 'rejected' && (
                  <div className="space-y-2">
                    {governanceQueue.rejectedInvites.length === 0 ? (
                      <p className="text-xs opacity-75">No declined admin invitations.</p>
                    ) : (
                      governanceQueue.rejectedInvites.map((inv) => (
                        <div key={inv.id} className="p-3 border border-[var(--bx-border)] space-y-1 text-xs font-bold">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <UserProfileLink
                                uid={inv.targetUid}
                                name={inv.targetName || inv.targetUid}
                                onOpenProfile={onOpenPublicProfile}
                                className="font-extrabold"
                              />{' '}
                              · Invited Role: {inv.role.toUpperCase()}
                            </div>
                            <span className="text-[11px] text-red-600 uppercase">Declined</span>
                          </div>
                          {inv.rejectionReason && (
                            <p className="text-[11px] opacity-80">Reason: {inv.rejectionReason}</p>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {isSuperAdmin && (
                <div className="bx-card p-6 space-y-3" data-testid="superadmin-listing-image-migration">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-black">Legacy Listing Image Storage Migration</h2>
                      <p className="text-xs text-amber-700 dark:text-amber-400 font-bold mt-1">
                        Backup first before migrating. Moves old inline data:image/ photos from Firestore listings to Firebase Storage and preserves originals in listingImageBackups.
                      </p>
                    </div>
                    <button
                      type="button"
                      data-testid="move-old-listing-images-btn"
                      disabled={migratingListingImages}
                      onClick={() => void handleMigrateListingImages()}
                      className="bx-btn bx-btn-primary px-4 py-2.5 text-xs font-extrabold whitespace-nowrap shrink-0 disabled:opacity-60"
                    >
                      {migratingListingImages
                        ? 'Migrating Listing Images…'
                        : 'Move old listing images to Storage'}
                    </button>
                  </div>
                  {listingMigrationProgress && (
                    <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs font-bold space-y-1">
                      <div>{listingMigrationProgress.statusText}</div>
                      <div className="opacity-75 tabular-nums">
                        Processed: {listingMigrationProgress.processed} · Failed: {listingMigrationProgress.failed} · Skipped: {listingMigrationProgress.skipped}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="bx-card p-6 space-y-3">
                <h2 className="text-base font-black">Immutable Audit Trail ({auditLogs.length})</h2>
                <div className="max-h-80 overflow-y-auto space-y-2">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs">
                      <div className="flex justify-between font-black">
                        <span>{log.action}</span>
                        <span className="opacity-70">{new Date(log.createdAtMs).toLocaleString()}</span>
                      </div>
                      <p className="opacity-80 mt-0.5">{log.details}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 12. UNIFIED CONVERSATIONAL AI ASSISTANT, AUTONOMOUS WEBSITE AUDIT & SAFE CODE GOVERNANCE */}
          {section === 'aidev' && (
            <AdminAiAssistantWorkspace
              adminUid={adminUid}
              settings={settings}
              proposals={proposals}
              auditLogs={auditLogs}
              allListings={allListings}
              deals={deals}
              reportedDealsCount={reportedDealsCount}
              healthSnapshot={healthSnapshot}
              enablingCloudService={enablingCloudService}
              onToggleEmergencyStop={handleToggleEmergencyStop}
              onRefreshSystemHealth={fetchSystemHealth}
              onEnableCloudService={handleEnableCloudServiceFromHealth}
              onWriteAuditLog={writeAuditLog}
              onFlash={onFlash}
              firebaseAuthProvidersUrl={DEFAULT_FIREBASE_AUTH_PROVIDERS_URL}
              firebaseAuthDomainsUrl={DEFAULT_FIREBASE_AUTH_DOMAINS_URL}
              tokenServiceActivationUrl={DEFAULT_TOKEN_SERVICE_ACTIVATION_URL}
            />
          )}

          {/* ANNOUNCEMENTS & USER ALERTS COMPOSER */}
          {section === 'notifications' && (
            <AdminAnnouncementsSection
              notifMode={notifMode}
              setNotifMode={setNotifMode}
              notifTargetUid={notifTargetUid}
              setNotifTargetUid={setNotifTargetUid}
              notifCategory={notifCategory}
              setNotifCategory={setNotifCategory}
              notifSeverity={notifSeverity}
              setNotifSeverity={setNotifSeverity}
              notifTitle={notifTitle}
              setNotifTitle={setNotifTitle}
              notifPreview={notifPreview}
              setNotifPreview={setNotifPreview}
              notifBody={notifBody}
              setNotifBody={setNotifBody}
              notifDestination={notifDestination}
              setNotifDestination={setNotifDestination}
              notifPersistBanner={notifPersistBanner}
              setNotifPersistBanner={setNotifPersistBanner}
              sendingAdminNotif={sendingAdminNotif}
              announcements={announcements}
              onPublishAdminAlert={handlePublishAdminAlert}
              onArchiveAnnouncement={(annId) => void handleArchiveAnnouncement(annId)}
            />
          )}

          {section === 'notification_management' && (
            <AdminNotificationManagement onFlash={onFlash} />
          )}

          {section === 'trust_safety' && (
            <AdminTrustSafetyCenter
              isSuperAdmin={isSuperAdmin}
              onFlash={(_type, text) => onFlash(text)}
            />
          )}
          </Suspense>
        </div>
      </div>

      {/* Deal Delete Confirmation Modal */}
      {dealDeleteTarget && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deal-delete-dialog-title"
          data-testid="deal-delete-confirmation-modal"
          onClick={(e) => {
            if (e.target === e.currentTarget && deletingDealId !== dealDeleteTarget.id) {
              setDealDeleteTarget(null);
              setDealDeleteReason('');
              setDealDeleteError(null);
            }
          }}
        >
          <div className="bx-card w-full max-w-lg p-6 border-2 border-red-600 bg-[var(--bx-surface)] shadow-2xl space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="space-y-1.5">
                <div className="inline-flex items-center gap-2 text-xs font-black uppercase tracking-wider text-red-600">
                  <Trash2 className="w-4 h-4 shrink-0" />
                  <span>Deal Deletion ({resolveDisplayDealCode(dealDeleteTarget) || dealDeleteTarget.id})</span>
                </div>
                <h2 id="deal-delete-dialog-title" className="text-lg font-black leading-snug">
                  Are you sure you want to delete this deal?
                </h2>
              </div>
              <button
                type="button"
                disabled={deletingDealId === dealDeleteTarget.id}
                onClick={() => {
                  setDealDeleteTarget(null);
                  setDealDeleteReason('');
                  setDealDeleteError(null);
                }}
                className="bx-icon-btn shrink-0 disabled:opacity-50"
                aria-label="Close delete confirmation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs space-y-1">
              <div className="font-black truncate">
                {dealDeleteTarget.listingTitle?.trim() || 'Untitled Deal Listing'}
              </div>
              <div className="opacity-85">
                Buyer: <span className="font-bold">{dealDeleteTarget.buyerName?.trim() || 'Unknown'}</span> · Seller:{' '}
                <span className="font-bold">{dealDeleteTarget.sellerName?.trim() || 'Unknown'}</span>
              </div>
              <div className="opacity-75">
                This action removes the deal room from active queues while preserving all{' '}
                <span className="font-mono">walletLedger</span> entries, payment sessions, and user wallet balances, and records this action in the admin audit trail.
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="deal-delete-audit-reason"
                className="block text-xs font-black"
              >
                Optional Audit Reason
              </label>
              <input
                id="deal-delete-audit-reason"
                type="text"
                value={dealDeleteReason}
                maxLength={400}
                onChange={(e) => setDealDeleteReason(e.target.value)}
                placeholder="e.g. Duplicate listing, fraudulent deal, policy violation"
                className="bx-input w-full px-3 py-2.5 text-xs"
              />
            </div>

            {dealDeleteError && (
              <div
                role="alert"
                className="p-3 border border-red-600 bg-red-50 dark:bg-red-950/30 text-xs font-bold text-red-700 dark:text-red-300"
              >
                {dealDeleteError}
              </div>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2.5 pt-1">
              <button
                type="button"
                disabled={deletingDealId === dealDeleteTarget.id}
                onClick={() => {
                  setDealDeleteTarget(null);
                  setDealDeleteReason('');
                  setDealDeleteError(null);
                }}
                className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingDealId === dealDeleteTarget.id}
                onClick={() => void handleConfirmDeleteDeal()}
                className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919] disabled:opacity-60"
              >
                {deletingDealId === dealDeleteTarget.id ? 'Deleting…' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
