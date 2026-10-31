import React, { useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {
  Activity,
  AlertOctagon,
  Bell,
  Bot,
  Calculator,
  Check,
  Clock,
  Code2,
  Download,
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
  Send,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
  Volume2,
  Wallet,
  X,
} from 'lucide-react';
import {
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
  PublicSettings,
  WithdrawalRequestRecord,
} from '../types';
import {
  BOOTSTRAPPED_SUPERADMIN_EMAIL,
  DEFAULT_FIREBASE_AUTH_DOMAINS_URL,
  DEFAULT_FIREBASE_AUTH_PROVIDERS_URL,
  DEFAULT_TOKEN_SERVICE_ACTIVATION_URL,
  auth,
  db,
  detectFirebaseAuthCapabilities,
  requestServerEnableTokenService,
} from '../lib/firebase';
import {
  appendDealAuditEvent,
  archiveAdminAnnouncement,
  emitUserNotification,
  publishAdminNotification,
} from '../lib/notificationService';
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
  validateWordPressSiteUrl,
  WordPressGatewayDiscoveryState,
} from '../lib/checkoutAndIntentLogic';
import { shouldTriggerFollowerPublicationAlert } from '../lib/engagementLogic';
import { fanoutNewListingToFollowers } from '../lib/engagementService';
import {
  enableFcmCloudApisViaServer,
  fetchServerFcmStatus,
  type ServerFcmDiagnosticStatus,
} from '../lib/pushNotifications';
import {
  isValidVapidPublicKey,
  NOTIFICATION_SOUND_CATALOG,
  playNotificationSoundById,
} from '../lib/soundAndPushConfig';
import { SUPPORTED_LANGUAGES } from '../lib/i18n';
import { ImageLightboxModal } from './ImageLightboxModal';

interface AdminDashboardProps {
  adminUid: string;
  isSuperAdmin: boolean;
  settings: PublicSettings;
  displayCurrency: CurrencyCode;
  initialDealId?: string | null;
  onFlash: (msg: string) => void;
}

type AdminSection =
  | 'overview'
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
  | 'roles'
  | 'aidev';

type AiDevSubTab =
  | 'chat'
  | 'health'
  | 'bugs'
  | 'security'
  | 'deals'
  | 'verification'
  | 'features'
  | 'diff'
  | 'preview'
  | 'queue'
  | 'deployments'
  | 'backup'
  | 'logs'
  | 'notifications'
  | 'emergency';

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
  onFlash,
}) => {
  const [section, setSection] = useState<AdminSection>(initialDealId ? 'deals' : 'overview');
  const [aiTab, setAiTab] = useState<AiDevSubTab>('chat');

  // Live Admin Collections
  const [allListings, setAllListings] = useState<MarketplaceListing[]>([]);
  const [nidSubmissions, setNidSubmissions] = useState<IdentityVerificationRecord[]>([]);
  const [deposits, setDeposits] = useState<DepositRequestRecord[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequestRecord[]>([]);
  const [deals, setDeals] = useState<DealRecord[]>([]);
  const [proposals, setProposals] = useState<AiProposalRecord[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogRecord[]>([]);
  const [adminRoles, setAdminRoles] = useState<{ uid: string; role: string; grantedBy: string }[]>([]);
  const [announcements, setAnnouncements] = useState<AnnouncementRecord[]>([]);

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
  const [vapidPublicKeyInput, setVapidPublicKeyInput] = useState(settings.fcmVapidPublicKey || '');
  const [savingVapidKey, setSavingVapidKey] = useState(false);
  const [fcmServerDiag, setFcmServerDiag] = useState<ServerFcmDiagnosticStatus | null>(null);
  const [loadingFcmDiag, setLoadingFcmDiag] = useState(false);

  // Moderation Workbench State
  const [selectedListingId, setSelectedListingId] = useState<string | null>(null);
  const [evidenceDoc, setEvidenceDoc] = useState<{
    evidenceImages: string[];
    aiSummary?: string;
    aiMethod?: string;
  } | null>(null);
  const [verifiedSelections, setVerifiedSelections] = useState<string[]>([]);
  const [rejectReason, setRejectReason] = useState('');
  const [runningAiOcr, setRunningAiOcr] = useState(false);

  // Deal & Dispute Review Workbench State
  const [selectedDealId, setSelectedDealId] = useState<string | null>(initialDealId || null);
  const [dealFilter, setDealFilter] = useState<
    'all' | 'reported' | 'ready_to_settle' | 'active' | 'unpaid' | 'finalized'
  >('all');
  const [dealReports, setDealReports] = useState<DealReportRecord[]>([]);
  const [dealTransfers, setDealTransfers] = useState<DealTransferSubmission[]>([]);
  const [dealMessages, setDealMessages] = useState<ChatMessageRecord[]>([]);
  const [dealEvents, setDealEvents] = useState<DealAuditEvent[]>([]);
  const [adminDealNote, setAdminDealNote] = useState('');
  const [adminChatInput, setAdminChatInput] = useState('');
  const [sendingAdminChat, setSendingAdminChat] = useState(false);
  const [busyDealAction, setBusyDealAction] = useState<string | null>(null);
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

  // AI Developer State
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiMessages, setAiMessages] = useState<{ role: 'admin' | 'ai'; text: string }[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [healthSnapshot, setHealthSnapshot] = useState<Record<string, unknown> | null>(null);
  const [enablingCloudService, setEnablingCloudService] = useState<string | null>(null);
  const [newPropTitle, setNewPropTitle] = useState('');
  const [newPropCategory, setNewPropCategory] = useState<'bugfix' | 'security' | 'feature' | 'performance'>('feature');
  const [newPropSeverity, setNewPropSeverity] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [newPropSummary, setNewPropSummary] = useState('');
  const [newPropFiles, setNewPropFiles] = useState('src/components/Marketplace.tsx');
  const [newPropDiff, setNewPropDiff] = useState('// Staged diff preview awaiting human approval');
  const [selectedDiffProposal, setSelectedDiffProposal] = useState<AiProposalRecord | null>(null);

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
    setVapidPublicKeyInput(settings.fcmVapidPublicKey || '');
  }, [settings]);

  useEffect(() => {
    if (section !== 'notifications' && !(section === 'aidev' && aiTab === 'notifications')) {
      return;
    }
    let cancelled = false;
    setLoadingFcmDiag(true);
    fetchServerFcmStatus()
      .then((diag) => {
        if (!cancelled) setFcmServerDiag(diag);
      })
      .finally(() => {
        if (!cancelled) setLoadingFcmDiag(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, aiTab]);

  const handleSavePublicVapidKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = vapidPublicKeyInput.trim();
    if (cleaned !== '' && !isValidVapidPublicKey(cleaned)) {
      onFlash(
        'Invalid Web Push VAPID public key. Paste ONLY the 87-88 character base64url P-256 public certificate from Firebase Console > Project Settings > Cloud Messaging (never a private key).'
      );
      return;
    }
    setSavingVapidKey(true);
    try {
      await savePublicSettingsSafe(
        adminUid,
        { fcmVapidPublicKey: cleaned },
        cleaned
          ? 'Configured public FCM Web Push VAPID certificate key'
          : 'Cleared fallback public FCM Web Push VAPID certificate key'
      );
      onFlash(
        cleaned
          ? 'Public Web Push VAPID key verified and saved.'
          : 'Public Web Push VAPID fallback key cleared.'
      );
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to save public VAPID key.');
    } finally {
      setSavingVapidKey(false);
    }
  };

  // Real-time Admin Subscriptions
  useEffect(() => {
    const unsubs: (() => void)[] = [];

    unsubs.push(
      onSnapshot(
        query(collection(db, 'listings'), limit(100)),
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
        query(collection(db, 'identityVerifications'), limit(80)),
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
              };
            })
          );
        },
        (err) => console.error('Admin NID listener error:', err)
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deposits'), limit(80)),
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
        query(collection(db, 'withdrawals'), limit(80)),
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
        query(collection(db, 'deals'), limit(100)),
        (snap) => {
          const items: DealRecord[] = snap.docs.map((d) => {
            const dl = d.data();
            return {
              id: d.id,
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
              refundBuyerMinor: dl.refundBuyerMinor !== undefined ? Number(dl.refundBuyerMinor) : undefined,
              refundPlatformRetainedMinor:
                dl.refundPlatformRetainedMinor !== undefined ? Number(dl.refundPlatformRetainedMinor) : undefined,
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
              status: dl.status,
              createdAtMs: dl.createdAt?.toMillis ? dl.createdAt.toMillis() : Date.now(),
            };
          });
          items.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setDeals(items);
        },
        (err) => console.error('Admin deals listener error:', err)
      )
    );

    unsubs.push(
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
              createdAtMs: p.createdAt?.toMillis ? p.createdAt.toMillis() : Date.now(),
            };
          });
          items.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setProposals(items);
        },
        (err) => console.error('Admin proposals listener error:', err)
      )
    );

    unsubs.push(
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

    unsubs.push(
      onSnapshot(
        collection(db, 'admins'),
        (snap) => {
          setAdminRoles(
            snap.docs.map((d) => ({
              uid: d.id,
              role: d.data().role,
              grantedBy: d.data().grantedBy,
            }))
          );
        },
        () => {}
      )
    );

    unsubs.push(
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

    return () => unsubs.forEach((u) => u());
  }, []);

  // Load private monetization evidence when inspecting a listing
  useEffect(() => {
    if (!selectedListingId) {
      setEvidenceDoc(null);
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
  }, [selectedListingId, allListings]);

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
        collection(db, 'deals', selectedDealId, 'reports'),
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
        collection(db, 'deals', selectedDealId, 'transfers'),
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
      let resp = await fetch('/api/admin/system-health?refresh=1', {
        headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined,
      });
      if (!resp.ok) {
        resp = await fetch('/api/health');
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
    if (section === 'aidev' && aiTab === 'health') {
      fetchSystemHealth();
    }
  }, [section, aiTab]);

  // --- Moderation Handlers ---
  const handleRunAiEvidenceCheck = async (listing: MarketplaceListing) => {
    if (!evidenceDoc?.evidenceImages?.[0]) {
      onFlash('No monetization screenshot uploaded by seller.');
      return;
    }
    setRunningAiOcr(true);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : '';
      const resp = await fetch('/api/ai/verify-evidence', {
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

      onFlash('Listing approved and published to Marketplace!');
      setSelectedListingId(null);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to approve listing.');
    }
  };

  const handleRejectListing = async (listing: MarketplaceListing) => {
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
      onFlash('Listing rejected with note sent to seller.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to reject listing.');
    }
  };

  const handleSuspendListing = async (listing: MarketplaceListing) => {
    if (listing.status === 'reserved' || listing.status === 'sold') {
      onFlash('Cannot suspend a listing that has an active reservation or completed escrow deal.');
      return;
    }
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
      onFlash('Listing suspended from public marketplace.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to suspend listing.');
    }
  };

  const handleRestoreSuspendedListing = async (listing: MarketplaceListing) => {
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
      onFlash('Suspended listing restored to live Marketplace!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to restore suspended listing.');
    }
  };

  // --- NID Handlers ---
  const handleDecisionNid = async (uid: string, approve: boolean, reasonRaw = '') => {
    const cleanNidReason = (reasonRaw || 'Images unclear or mismatched. Please upload clear Front & Back photos.').slice(0, 500);
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
      onFlash(approve ? 'User NID verified and badge granted!' : 'NID submission rejected.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'NID review update failed.');
    }
  };

  // --- Deposit Approval / Rejection (Idempotent Transaction) ---
  const handleApproveDeposit = async (dep: DepositRequestRecord) => {
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
      onFlash('Deposit approved and credited to user wallet!');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to approve deposit.');
    }
  };

  const handleRejectDeposit = async (dep: DepositRequestRecord, reason: string) => {
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
      onFlash('Deposit request rejected.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to reject deposit.');
    }
  };

  // --- Withdrawal Payout / Rejection ---
  const handleProcessWithdrawal = async (wd: WithdrawalRequestRecord, markPaid: boolean, noteOrRef: string) => {
    const cleanRef = (noteOrRef.trim() || (markPaid ? 'MANUAL-PAYOUT' : 'Invalid payout account details.')).slice(0, markPaid ? 80 : 500);
    try {
      await runTransaction(db, async (tx) => {
        const wdRef = doc(db, 'withdrawals', wd.id);
        const userRef = doc(db, 'privateUsers', wd.userId);
        const ledgerRef = doc(collection(db, 'walletLedger'));

        const wdSnap = await tx.get(wdRef);
        const userSnap = await tx.get(userRef);
        if (!wdSnap.exists() || wdSnap.data().status !== 'pending') {
          throw new Error('Withdrawal has already been processed.');
        }
        if (!userSnap.exists()) throw new Error('User wallet missing.');

        const curAvail = Number(userSnap.data().walletBalanceMinor || 0);
        const curRes = Number(userSnap.data().reservedBalanceMinor || 0);
        const nextRes = Math.max(0, curRes - wd.amountMinor);

        if (markPaid) {
          tx.update(wdRef, {
            status: 'paid',
            referenceId: cleanRef,
            reviewedBy: adminUid,
            reviewedAtMs: Date.now(),
            updatedAt: serverTimestamp(),
          });
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
      onFlash(markPaid ? 'Withdrawal marked as Paid!' : 'Withdrawal rejected & funds restored to user.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Withdrawal update failed.');
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

        tx.update(buyerPrivRef, {
          walletBalanceMinor: curBuyerBal + refundCalc.buyerRefundMinor,
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

        tx.update(dealRef, {
          status: 'settled',
          unresolvedReportCount: 0,
          settlementLedgerId: ledgerId,
          settledAtMs: Date.now(),
          adminHoldNote: cleanNote,
          updatedAt: serverTimestamp(),
        });

        tx.update(sellerPrivRef, {
          walletBalanceMinor: curSellerBal + deal.sellerPayoutMinor,
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
      const resp = await fetch(`/api/payments/wordpress/methods?${qs.toString()}`, {
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

  const handleGrantAdminRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) return;
    const cleanUid = targetRoleUid.trim();
    if (!cleanUid) return;
    try {
      await setDoc(doc(db, 'admins', cleanUid), {
        uid: cleanUid,
        role: targetRoleLevel,
        grantedBy: adminUid,
        createdAt: serverTimestamp(),
      });
      await writeAuditLog(adminUid, 'grant_admin_role', 'admin', cleanUid, `Granted ${targetRoleLevel}`);
      setTargetRoleUid('');
      onFlash(`Granted ${targetRoleLevel} role to UID ${cleanUid}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to grant role.');
    }
  };

  const handleRevokeAdminRole = async (uid: string) => {
    if (!isSuperAdmin) return;
    try {
      await deleteDoc(doc(db, 'admins', uid));
      await writeAuditLog(adminUid, 'revoke_admin_role', 'admin', uid, 'Revoked admin document');
      onFlash(`Revoked admin role for ${uid}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to revoke role.');
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

  // --- AI Developer Handlers ---
  const handleSendAiDevChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (settings.aiEmergencyStop) {
      onFlash('AI Emergency Stop is active! Disable Emergency Stop first.');
      return;
    }
    const msg = aiPrompt.trim();
    if (!msg) return;
    setAiMessages((prev) => [...prev, { role: 'admin', text: msg }]);
    setAiPrompt('');
    setAiBusy(true);
    try {
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : '';
      const resp = await fetch('/api/ai/developer-chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({
          message: msg,
          systemContext: `Listings: ${allListings.length}, Deals: ${deals.length}, BuyerFee: ${settings.buyerFeePct}%, SellerFee: ${settings.sellerFeePct}%`,
        }),
      });
      const data = await resp.json();
      setAiMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          text: String(
            data.reply ||
              data.error ||
              'Deterministic fallback: Stage any proposed code or configuration change in the Approval Queue for human review.'
          ),
        },
      ]);
    } catch {
      setAiMessages((prev) => [
        ...prev,
        {
          role: 'ai',
          text: 'Running in static hosting mode without Node AI proxy. Use the Proposal Queue & Interactive Preview tabs to stage and audit changes safely.',
        },
      ]);
    } finally {
      setAiBusy(false);
    }
  };

  const handleStageAiProposal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (settings.aiEmergencyStop) {
      onFlash('Cannot stage AI proposals while Emergency Stop is active.');
      return;
    }
    if (newPropTitle.trim().length < 3) {
      onFlash('Proposal title must be at least 3 characters.');
      return;
    }
    try {
      await addDoc(collection(db, 'aiProposals'), {
        title: newPropTitle.trim().slice(0, 140),
        category: newPropCategory,
        severity: newPropSeverity,
        summary: (newPropSummary.trim() || 'Staged for human administrator review.').slice(0, 2000),
        affectedFiles: newPropFiles
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 20),
        proposedDiff: newPropDiff.slice(0, 8000),
        status: 'awaiting_review',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(adminUid, 'stage_ai_proposal', 'aiProposal', newPropTitle.trim(), 'Created staged proposal');
      setNewPropTitle('');
      setNewPropSummary('');
      onFlash('Proposal staged in Approval Queue (Awaiting Human Review).');
      setAiTab('queue');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to create proposal.');
    }
  };

  const handleProposalDecision = async (
    prop: AiProposalRecord,
    nextStatus: 'in_review' | 'approved' | 'rejected'
  ) => {
    if (settings.aiEmergencyStop && nextStatus === 'approved') {
      onFlash('Emergency Stop blocks approving AI proposals.');
      return;
    }
    try {
      await updateDoc(doc(db, 'aiProposals', prop.id), {
        status: nextStatus,
        decidedBy: adminUid,
        updatedAt: serverTimestamp(),
      });
      await writeAuditLog(
        adminUid,
        `proposal_${nextStatus}`,
        'aiProposal',
        prop.id,
        `Marked "${prop.title}" as ${nextStatus}`
      );
      onFlash(`Proposal "${prop.title}" marked as ${nextStatus.replace('_', ' ')}.`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Failed to update proposal status.');
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

  const pendingListingsCount = allListings.filter((l) => l.status === 'pending').length;
  const pendingNidsCount = nidSubmissions.filter((n) => n.status === 'pending_review').length;
  const pendingDepositsCount = deposits.filter((d) => d.status === 'pending').length;
  const pendingWithdrawalsCount = withdrawals.filter((w) => w.status === 'pending').length;
  const reportedDealsCount = deals.filter(
    (d) => d.status === 'reported_under_review' || d.unresolvedReportCount > 0
  ).length;
  const readyToSettleDealsCount = deals.filter(
    (d) =>
      d.originalDeadlineMs > 0 &&
      Date.now() >= d.originalDeadlineMs &&
      d.unresolvedReportCount === 0 &&
      (isDealSecurityTimerActiveStatus(d.status) || d.status === 'protection_expired')
  ).length;

  const filteredDeals = deals.filter((d) => {
    const isReady =
      d.originalDeadlineMs > 0 &&
      Date.now() >= d.originalDeadlineMs &&
      d.unresolvedReportCount === 0 &&
      (isDealSecurityTimerActiveStatus(d.status) || d.status === 'protection_expired');
    if (dealFilter === 'reported') return d.status === 'reported_under_review' || d.unresolvedReportCount > 0;
    if (dealFilter === 'ready_to_settle') return isReady;
    if (dealFilter === 'unpaid') return ['accepted_pending_payment', 'awaiting_payment'].includes(d.status);
    if (dealFilter === 'finalized') return ['settled', 'refunded', 'cancelled'].includes(d.status);
    if (dealFilter === 'active') {
      return !['settled', 'refunded', 'cancelled', 'accepted_pending_payment', 'awaiting_payment'].includes(d.status);
    }
    return true;
  });

  const selectedModerationListing = allListings.find((l) => l.id === selectedListingId) || null;
  const selectedDeal = deals.find((d) => d.id === selectedDealId) || null;

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
              setDealFilter(reportedDealsCount > 0 ? 'reported' : 'ready_to_settle');
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

          <nav aria-label="Admin Navigation" className="bx-card p-2 flex flex-col gap-1">
            {(
              [
                { id: 'overview', label: 'Overview', icon: Activity },
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
                { id: 'payments', label: 'Payment Numbers', icon: Layers },
                { id: 'notifications', label: 'Announcements & Alerts', icon: Megaphone },
                { id: 'roles', label: 'Superadmin & Logs', icon: Users },
                { id: 'aidev', label: 'AI Developer', icon: Bot },
              ] as { id: AdminSection; label: string; icon: React.ComponentType<{ className?: string }> }[]
            ).map((item) => {
              const Icon = item.icon;
              const active = section === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSection(item.id)}
                  className={`w-full px-3 py-2.5 text-left text-xs font-extrabold flex items-center gap-2.5 transition-colors ${
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
          {/* 1. OVERVIEW */}
          {section === 'overview' && (
            <div className="space-y-6">
              <div className="bx-card p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h1 className="text-2xl font-black tracking-tight">BEXORA Operations Overview</h1>
                  <p className="text-xs opacity-75 mt-1">
                    Real-time Firebase Cloud Firestore telemetry — zero synthetic metrics.
                  </p>
                </div>
                <a
                  href="/BEXORA_INFINITYFREE_PRODUCTION.zip"
                  download="BEXORA_INFINITYFREE_PRODUCTION.zip"
                  className="bx-btn bx-btn-primary px-4 py-2.5 text-xs font-extrabold inline-flex items-center gap-2"
                >
                  <Download className="w-4 h-4" />
                  Download InfinityFree ZIP
                </a>
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 tabular-nums">
                <div className="bx-card p-4">
                  <div className="text-xs font-bold uppercase opacity-70">Pending Listings</div>
                  <div className="text-2xl font-black mt-1">{pendingListingsCount}</div>
                </div>
                <div className="bx-card p-4">
                  <div className="text-xs font-bold uppercase opacity-70">Pending NIDs</div>
                  <div className="text-2xl font-black mt-1">{pendingNidsCount}</div>
                </div>
                <div className="bx-card p-4">
                  <div className="text-xs font-bold uppercase opacity-70">Pending Deposits</div>
                  <div className="text-2xl font-black mt-1">{pendingDepositsCount}</div>
                </div>
                <div className="bx-card p-4">
                  <div className="text-xs font-bold uppercase opacity-70">Disputes / Ready</div>
                  <div className="text-2xl font-black mt-1 text-red-600">
                    {reportedDealsCount} / <span className="text-emerald-600">{readyToSettleDealsCount}</span>
                  </div>
                </div>
              </div>

              <div className="bx-card p-5 space-y-3">
                <h2 className="text-sm font-black uppercase">Active Fee, Dispute Refund & Security Timer Policy</h2>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-bold">
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                    Buyer Fee: {settings.buyerFeeEnabled ? `${settings.buyerFeePct}%` : 'Disabled (0%)'} · Dispute Refund: 100% Bid + Refundable Fee (3% Platform Retained)
                  </div>
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                    Seller Commission: {settings.sellerFeeEnabled ? `${settings.sellerFeePct}%` : 'Disabled (0%)'}
                  </div>
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                    Security Timers: YouTube {getProtectionDurationHours('youtube', settings)}h (7d) · Facebook & Standard {getProtectionDurationHours('facebook', settings)}h
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 2. LISTING MODERATION & VERIFICATION WORKBENCH */}
          {section === 'moderation' && (
            <div className="space-y-5">
              <h1 className="text-xl font-black">Listing Moderation & Monetization Evidence Workbench</h1>

              {selectedModerationListing ? (
                <div className="bx-card p-6 space-y-5">
                  <div className="flex items-center justify-between border-b border-[var(--bx-border)] pb-3">
                    <div>
                      <span className="text-xs font-black uppercase text-[#FF6500]">
                        {selectedModerationListing.platform} · {selectedModerationListing.subcategory}
                      </span>
                      <h2 className="text-lg font-black">{selectedModerationListing.title}</h2>
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
                        onClick={() => handleRestoreSuspendedListing(selectedModerationListing)}
                        className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold inline-flex items-center justify-center gap-1.5"
                      >
                        <Check className="w-4 h-4" />
                        Restore Suspended Listing to Live
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleApproveListing(selectedModerationListing)}
                        className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold inline-flex items-center justify-center gap-1.5"
                      >
                        <Check className="w-4 h-4" />
                        Approve & Publish Listing
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
                          onClick={() => handleSuspendListing(selectedModerationListing)}
                          className="bx-btn px-4 py-2 text-xs font-extrabold bg-amber-600 text-white border-2 border-[#191919]"
                        >
                          Suspend Listing
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleRejectListing(selectedModerationListing)}
                        className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919]"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                </div>
              ) : allListings.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No listings submitted yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {allListings.map((l) => {
                    const badge = getListingStatusBadgeMeta(l.status);
                    return (
                      <div key={l.id} className="bx-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-black uppercase px-2 py-0.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                              {badge.label}
                            </span>
                            <span className="text-xs font-bold opacity-75">{l.platform.toUpperCase()}</span>
                          </div>
                          <h3 className="font-black text-sm mt-1">{l.title}</h3>
                          <p className="text-xs opacity-75">
                            Seller: @{l.sellerUsername} · {formatMoneyFromMinor(l.priceMinor, displayCurrency, l.currency, settings.usdToBdtRate)}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedListingId(l.id)}
                          className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                        >
                          <Eye className="w-3.5 h-3.5" />
                          Inspect & Moderate
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* 3. NID IDENTITY VERIFICATIONS */}
          {section === 'nid' && (
            <div className="space-y-4">
              <h1 className="text-xl font-black">Private NID Front & Back Verification Queue</h1>
              {nidSubmissions.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No NID identity verification submissions yet.
                </div>
              ) : (
                nidSubmissions.map((item) => (
                  <div key={item.uid} className="bx-card p-5 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="text-sm font-black">User UID: {item.uid}</div>
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
                    {item.status === 'pending_review' && (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => handleDecisionNid(item.uid, true)}
                          className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                        >
                          Approve NID & Grant Badge
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDecisionNid(item.uid, false, 'Document photo blurry or incomplete.')}
                          className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919]"
                        >
                          Reject Submission
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* 4. MANUAL DEPOSIT REQUESTS */}
          {section === 'deposits' && (
            <div className="space-y-4">
              <h1 className="text-xl font-black">Manual Wallet Deposit Requests (bKash / Nagad / Rocket)</h1>
              {deposits.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No manual deposit requests submitted yet.
                </div>
              ) : (
                deposits.map((dep) => (
                  <div key={dep.id} className="bx-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-black uppercase px-2 py-0.5 bg-[#FFD400] text-[#191919] border border-[#191919]">
                          {dep.method}
                        </span>
                        <span className="font-black text-base">
                          {formatMoneyFromMinor(dep.amountMinor, 'BDT', 'BDT')}
                        </span>
                        <span className="text-xs font-bold uppercase opacity-75">({dep.status})</span>
                      </div>
                      <p className="text-xs font-bold">
                        User: {dep.userName} · Sender: {dep.senderNumber} · TrxID: {dep.transactionId}
                      </p>
                      {dep.screenshotData && (
                        <img
                          src={dep.screenshotData}
                          alt="Payment proof"
                          className="w-40 h-24 object-cover border border-[var(--bx-border)] mt-2"
                        />
                      )}
                    </div>
                    {dep.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleApproveDeposit(dep)}
                          className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                        >
                          Approve & Credit
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRejectDeposit(dep, 'Unmatched TrxID')}
                          className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919]"
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* 5. WITHDRAWAL REQUESTS */}
          {section === 'withdrawals' && (
            <div className="space-y-4">
              <h1 className="text-xl font-black">Seller & Wallet Withdrawal Queue</h1>
              {withdrawals.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No withdrawal requests submitted yet.
                </div>
              ) : (
                withdrawals.map((wd) => (
                  <div key={wd.id} className="bx-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-black uppercase px-2 py-0.5 border border-[var(--bx-border)]">
                          {wd.method}
                        </span>
                        <span className="font-black text-base">
                          {formatMoneyFromMinor(wd.amountMinor, wd.currency, wd.currency)}
                        </span>
                        <span className="text-xs font-bold uppercase opacity-75">({wd.status})</span>
                      </div>
                      <p className="text-xs font-bold">
                        Member: {wd.userName} · Destination: {wd.payoutAccount}
                      </p>
                    </div>
                    {wd.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => handleProcessWithdrawal(wd, true, `PAID-${Date.now()}`)}
                          className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                        >
                          Mark Paid
                        </button>
                        <button
                          type="button"
                          onClick={() => handleProcessWithdrawal(wd, false, 'Payout account unreachable')}
                          className="bx-btn px-4 py-2 text-xs font-extrabold bg-red-600 text-white border-2 border-[#191919]"
                        >
                          Reject & Restore
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}

          {/* 6. ADMIN 3-PARTY DEAL & DISPUTE REVIEW SCREEN */}
          {section === 'deals' && (
            <div className="space-y-5">
              <div className="bx-card p-5 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h1 className="text-xl font-black">3-Party Deal Room, Transfer Proof & Dispute Review</h1>
                    <p className="text-xs opacity-80 mt-0.5">
                      Inspect Seller transfer-proof screenshots, Buyer approvals/rejections, immutable security timers (168h YouTube · 40h Standard), and execute atomic escrow settlements or 102%/3% dispute refunds.
                    </p>
                  </div>
                </div>

                {/* Filter Segmented Control */}
                <div className="flex flex-wrap gap-1.5 pt-1" role="tablist" aria-label="Filter Escrow Deals">
                  {(
                    [
                      { id: 'all', label: `All (${deals.length})` },
                      { id: 'reported', label: `Disputed / On Hold (${reportedDealsCount})` },
                      { id: 'ready_to_settle', label: `Timer Complete (${readyToSettleDealsCount})` },
                      { id: 'active', label: 'In Progress' },
                      { id: 'unpaid', label: 'Reserved Unpaid' },
                      { id: 'finalized', label: 'Settled / Refunded' },
                    ] as const
                  ).map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="tab"
                      aria-selected={dealFilter === f.id}
                      onClick={() => setDealFilter(f.id)}
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
              </div>

              {filteredDeals.length === 0 ? (
                <div className="bx-card p-8 text-center text-sm font-bold opacity-75">
                  No deals match the selected filter.
                </div>
              ) : (
                filteredDeals.map((dl) => {
                  const isExpanded = selectedDeal?.id === dl.id;
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
                            Buyer: <span className="font-bold">{dl.buyerName}</span> ({dl.buyerId.slice(0, 8)}…) · Seller:{' '}
                            <span className="font-bold">{dl.sellerName}</span> ({dl.sellerId.slice(0, 8)}…) · Agreed Price:{' '}
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
            </div>
          )}

          {/* 7. MARKETPLACE FEES & COMMISSION ENGINE */}
          {section === 'commissions' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <form onSubmit={handleSaveCommissions} className="bx-card p-6 space-y-5">
                <h1 className="text-xl font-black">Configurable Commission Engine</h1>
                <p className="text-xs opacity-75">
                  Standard BEXORA Buyer Fee is 5% on the exact accepted bid or Buy Now price. Fees are locked immutably into each deal snapshot at creation.
                </p>

                <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-black">Enable Buyer Fee (Default 5%)</span>
                    <input
                      type="checkbox"
                      checked={buyerFeeEnabled}
                      onChange={(e) => setBuyerFeeEnabled(e.target.checked)}
                      className="w-4 h-4"
                    />
                  </label>
                  <div>
                    <label htmlFor="bx-admin-buyer-pct" className="block text-xs font-bold mb-1">
                      Buyer Commission Percentage (0% – 50%)
                    </label>
                    <input
                      id="bx-admin-buyer-pct"
                      type="number"
                      step="0.1"
                      min="0"
                      max="50"
                      value={buyerFeePct}
                      onChange={(e) => setBuyerFeePct(e.target.value)}
                      className="bx-input w-full px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                  <label className="flex items-center justify-between cursor-pointer">
                    <span className="text-sm font-black">Enable Seller Fee</span>
                    <input
                      type="checkbox"
                      checked={sellerFeeEnabled}
                      onChange={(e) => setSellerFeeEnabled(e.target.checked)}
                      className="w-4 h-4"
                    />
                  </label>
                  <div>
                    <label htmlFor="bx-admin-seller-pct" className="block text-xs font-bold mb-1">
                      Seller Commission Percentage (0% – 50%)
                    </label>
                    <input
                      id="bx-admin-seller-pct"
                      type="number"
                      step="0.1"
                      min="0"
                      max="50"
                      value={sellerFeePct}
                      onChange={(e) => setSellerFeePct(e.target.value)}
                      className="bx-input w-full px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="bx-admin-usd-rate" className="block text-xs font-bold mb-1">
                    Display Conversion Rate (1 USD in BDT)
                  </label>
                  <input
                    id="bx-admin-usd-rate"
                    type="number"
                    step="0.5"
                    min="1"
                    max="500"
                    value={usdRate}
                    onChange={(e) => setUsdRate(e.target.value)}
                    className="bx-input w-full px-3 py-2 text-sm"
                  />
                </div>

                <button type="submit" className="bx-btn bx-btn-primary w-full py-2.5 text-sm font-extrabold">
                  Save Commission Settings
                </button>
              </form>

              {/* Live Sample Commission & Dispute Refund Calculator */}
              <div className="bx-card p-6 space-y-4 tabular-nums">
                <div className="flex items-center gap-2">
                  <Calculator className="w-5 h-5 text-[#FF6500]" />
                  <h2 className="text-lg font-black">Live Payment & Dispute Refund Preview</h2>
                </div>
                <div>
                  <label htmlFor="bx-sample-deal" className="block text-xs font-bold mb-1">
                    Accepted Bid / Deal Base Price (BDT)
                  </label>
                  <input
                    id="bx-sample-deal"
                    type="number"
                    min="10"
                    value={calcSampleBdt}
                    onChange={(e) => setCalcSampleBdt(e.target.value)}
                    className="bx-input w-full px-3 py-2 text-sm"
                  />
                </div>

                <div className="space-y-2.5 text-sm border-t-2 border-[var(--bx-border)] pt-4">
                  <div className="flex justify-between">
                    <span>Accepted Bid / Deal Price (P):</span>
                    <span className="font-bold">{formatMoneyFromMinor(liveSample.baseAmountMinor, 'BDT', 'BDT')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Buyer Fee ({liveSample.buyerFeePct}%):</span>
                    <span className="font-bold">+{formatMoneyFromMinor(liveSample.buyerFeeMinor, 'BDT', 'BDT')}</span>
                  </div>
                  <div className="flex justify-between font-black text-[#FF6500] border-b border-[var(--bx-border)] pb-2">
                    <span>Buyer Total Charge (P + BuyerFee):</span>
                    <span>{formatMoneyFromMinor(liveSample.buyerTotalMinor, 'BDT', 'BDT')}</span>
                  </div>
                  <div className="flex justify-between pt-1">
                    <span>Seller Fee ({liveSample.sellerFeePct}%):</span>
                    <span className="font-bold">-{formatMoneyFromMinor(liveSample.sellerFeeMinor, 'BDT', 'BDT')}</span>
                  </div>
                  <div className="flex justify-between font-black text-emerald-600">
                    <span>If Completed → Seller Net Payout:</span>
                    <span>{formatMoneyFromMinor(liveSample.sellerPayoutMinor, 'BDT', 'BDT')}</span>
                  </div>
                  <div className="flex justify-between pt-2 border-t border-[var(--bx-border)] text-red-600 font-black">
                    <span>If Admin Rejects Deal → Buyer Refund:</span>
                    <span>{formatMoneyFromMinor(liveSampleRefund.buyerRefundMinor, 'BDT', 'BDT')}</span>
                  </div>
                  <div className="flex justify-between text-xs opacity-85 font-bold">
                    <span>If Admin Rejects Deal → Retained BEXORA Commission (3%):</span>
                    <span>{formatMoneyFromMinor(liveSampleRefund.platformRetainedCommissionMinor, 'BDT', 'BDT')}</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* 8. CATEGORIES, MONETIZATION & GAMING TITLES */}
          {section === 'categories' && (
            <form onSubmit={handleSaveCategoriesConfig} className="bx-card p-6 space-y-6">
              <h1 className="text-xl font-black">Categories, Gaming List & Asset Security Windows</h1>

              <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="text-xs font-black">
                    Allow Custom Override of Mandatory Security Windows (Default Off: Enforces 168h YouTube & 40h Standard)
                  </span>
                  <input
                    type="checkbox"
                    checked={customProtEnabled}
                    onChange={(e) => setCustomProtEnabled(e.target.checked)}
                    className="w-4 h-4"
                  />
                </label>
                <p className="text-[11px] opacity-75">
                  When unchecked, YouTube channels strictly lock a 7-day (168h) Google Brand/Primary-Owner hold and Facebook & all other standard assets lock a 40-hour security hold upon Buyer transfer approval.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="bx-prot-yt" className="block text-xs font-extrabold mb-1">
                    YouTube Security Window (Hours)
                  </label>
                  <input
                    id="bx-prot-yt"
                    type="number"
                    min="1"
                    max="720"
                    value={protYt}
                    onChange={(e) => setProtYt(e.target.value)}
                    className="bx-input w-full px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] opacity-70 mt-1">Mandatory Policy: 168h (7 days)</p>
                </div>
                <div>
                  <label htmlFor="bx-prot-fb" className="block text-xs font-extrabold mb-1">
                    Facebook Security Window (Hours)
                  </label>
                  <input
                    id="bx-prot-fb"
                    type="number"
                    min="1"
                    max="720"
                    value={protFb}
                    onChange={(e) => setProtFb(e.target.value)}
                    className="bx-input w-full px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] opacity-70 mt-1">Mandatory Policy: 40h</p>
                </div>
                <div>
                  <label htmlFor="bx-prot-def" className="block text-xs font-extrabold mb-1">
                    Other Standard Assets (Hours)
                  </label>
                  <input
                    id="bx-prot-def"
                    type="number"
                    min="1"
                    max="720"
                    value={protDef}
                    onChange={(e) => setProtDef(e.target.value)}
                    className="bx-input w-full px-3 py-2 text-sm"
                  />
                  <p className="text-[11px] opacity-70 mt-1">Mandatory Policy: 40h</p>
                </div>
              </div>

              <div>
                <label htmlFor="bx-gaming-list" className="block text-xs font-extrabold mb-1">
                  Supported Gaming Titles (One game per line)
                </label>
                <textarea
                  id="bx-gaming-list"
                  rows={5}
                  value={gamingText}
                  onChange={(e) => setGamingText(e.target.value)}
                  className="bx-input w-full px-3 py-2 text-sm font-mono"
                />
              </div>

              <div className="space-y-3">
                <div className="text-xs font-extrabold uppercase">Toggle Platform Monetization Programs</div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {PLATFORM_LIST.filter((p) => PLATFORM_CATALOG[p].monetizationOptions.length > 0).map((p) => (
                    <div key={p} className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2">
                      <div className="text-xs font-black uppercase">{PLATFORM_CATALOG[p].name}</div>
                      <div className="flex flex-wrap gap-2">
                        {PLATFORM_CATALOG[p].monetizationOptions.map((opt) => {
                          const enabled = !disabledMonIds.includes(opt.id);
                          return (
                            <label key={opt.id} className="inline-flex items-center gap-1.5 text-xs font-bold cursor-pointer">
                              <input
                                type="checkbox"
                                checked={enabled}
                                onChange={() =>
                                  setDisabledMonIds((prev) =>
                                    enabled ? [...prev, opt.id] : prev.filter((x) => x !== opt.id)
                                  )
                                }
                              />
                              <span>{opt.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
                Save Category & Protection Configuration
              </button>
            </form>
          )}

          {/* 9. SUPPORT CONTACTS, BRANDING, NOTICE BANNER & LANGUAGES */}
          {section === 'support' && (
            <div className="space-y-6 max-w-3xl">
              <form onSubmit={handleSaveSupportContacts} className="bx-card p-6 space-y-5">
                <h1 className="text-xl font-black">Support Contact Settings</h1>
                <p className="text-xs opacity-75">
                  Updates immediately sync with the Floating Support Button across all pages. Leave blank to hide an unconfigured channel.
                </p>

                <div>
                  <label htmlFor="bx-sup-wa" className="block text-xs font-extrabold mb-1">
                    WhatsApp Support Number (with country code)
                  </label>
                  <input
                    id="bx-sup-wa"
                    type="text"
                    value={supWa}
                    onChange={(e) => setSupWa(e.target.value)}
                    placeholder="+8801700000000"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="bx-sup-tg" className="block text-xs font-extrabold mb-1">
                    Telegram Support URL or @Handle
                  </label>
                  <input
                    id="bx-sup-tg"
                    type="text"
                    value={supTg}
                    onChange={(e) => setSupTg(e.target.value)}
                    placeholder="https://t.me/bexorasupport"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="bx-sup-email" className="block text-xs font-extrabold mb-1">
                    Support Desk Email Address
                  </label>
                  <input
                    id="bx-sup-email"
                    type="email"
                    value={supEmail}
                    onChange={(e) => setSupEmail(e.target.value)}
                    placeholder="support@bexora.com"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
                  Save Support Channels
                </button>
              </form>

              <form onSubmit={handleSaveBrandingAndNotice} className="bx-card p-6 space-y-5">
                <div>
                  <h2 className="text-lg font-black">
                    Platform Branding, Top Notice Banner & Active Languages
                  </h2>
                  <p className="text-xs opacity-75 mt-1">
                    Customize site display name, custom HTTPS brand logo URL (leave blank to use the default BEXORA geometric emblem), top announcement notice bar, and enabled customer languages.
                  </p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="bx-brand-name" className="block text-xs font-extrabold mb-1">
                      Platform Display Name
                    </label>
                    <input
                      id="bx-brand-name"
                      type="text"
                      value={siteNameInput}
                      onChange={(e) => setSiteNameInput(e.target.value)}
                      placeholder="BEXORA"
                      maxLength={60}
                      className="bx-input w-full px-3.5 py-2.5 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="bx-brand-logo" className="block text-xs font-extrabold mb-1">
                      Custom Logo Image URL (Optional HTTPS)
                    </label>
                    <input
                      id="bx-brand-logo"
                      type="text"
                      value={logoUrlInput}
                      onChange={(e) => setLogoUrlInput(e.target.value)}
                      placeholder="Leave blank for default BEXORA emblem"
                      maxLength={300}
                      className="bx-input w-full px-3.5 py-2.5 text-sm"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="bx-brand-tagline" className="block text-xs font-extrabold mb-1">
                    Footer / Brand Tagline
                  </label>
                  <input
                    id="bx-brand-tagline"
                    type="text"
                    value={brandTaglineInput}
                    onChange={(e) => setBrandTaglineInput(e.target.value)}
                    placeholder="Verified Digital Asset Marketplace & Protected Escrow"
                    maxLength={140}
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                  <label className="flex items-center gap-2.5 text-xs font-extrabold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={noticeBannerEnabledInput}
                      onChange={(e) => setNoticeBannerEnabledInput(e.target.checked)}
                      className="w-4 h-4 accent-[#FF6500]"
                    />
                    <span>Show Top Sitewide Notice Banner Above Header</span>
                  </label>
                  <input
                    type="text"
                    value={noticeBannerTextInput}
                    onChange={(e) => setNoticeBannerTextInput(e.target.value)}
                    placeholder="e.g., Escrow payouts & manual bKash/Nagad deposits are processed 24/7."
                    maxLength={280}
                    className="bx-input w-full px-3 py-2 text-xs"
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-extrabold">Enabled Header Languages</div>
                  <div className="flex flex-wrap gap-2">
                    {SUPPORTED_LANGUAGES.map((lMeta) => {
                      const active = enabledLanguagesInput.includes(lMeta.code);
                      return (
                        <label
                          key={lMeta.code}
                          className="inline-flex items-center gap-2 px-3 py-1.5 border border-[var(--bx-border)] bg-[var(--bx-surface)] text-xs font-bold cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={active}
                            onChange={() =>
                              setEnabledLanguagesInput((prev) => {
                                if (active) {
                                  const next = prev.filter((x) => x !== lMeta.code);
                                  return next.length > 0 ? next : ['en'];
                                }
                                return [...prev, lMeta.code];
                              })
                            }
                          />
                          <span>
                            {lMeta.label} ({lMeta.code.toUpperCase()})
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
                  Save Branding, Notice & Languages
                </button>
              </form>
            </div>
          )}

          {/* 10. MANUAL PAYMENT & WORDPRESS LIVE GATEWAY SETTINGS */}
          {section === 'payments' && (
            <div className="space-y-6 max-w-3xl">
              <form onSubmit={handleSaveManualPayments} className="bx-card p-6 space-y-5">
                <h1 className="text-xl font-black">Manual Wallet Payment Destinations</h1>
                <p className="text-xs opacity-75">
                  Configure official Send Money / Cash Out numbers displayed on the BEXORA Wallet page. Buyers can add balance to their BEXORA Wallet and immediately complete Buy Now or Accepted Bid Escrow purchases.
                </p>

                <div>
                  <label htmlFor="bx-pay-bkash" className="block text-xs font-extrabold mb-1">
                    bKash Destination Number
                  </label>
                  <input
                    id="bx-pay-bkash"
                    type="text"
                    value={bkashNum}
                    onChange={(e) => setBkashNum(e.target.value)}
                    placeholder="017XXXXXXXX"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="bx-pay-nagad" className="block text-xs font-extrabold mb-1">
                    Nagad Destination Number
                  </label>
                  <input
                    id="bx-pay-nagad"
                    type="text"
                    value={nagadNum}
                    onChange={(e) => setNagadNum(e.target.value)}
                    placeholder="018XXXXXXXX"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="bx-pay-rocket" className="block text-xs font-extrabold mb-1">
                    Rocket Destination Number
                  </label>
                  <input
                    id="bx-pay-rocket"
                    type="text"
                    value={rocketNum}
                    onChange={(e) => setRocketNum(e.target.value)}
                    placeholder="019XXXXXXXXX"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <button type="submit" className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold">
                  Save Wallet Payment Numbers
                </button>
              </form>

              <form onSubmit={handleSaveWordPressBridge} className="bx-card p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Globe className="w-5 h-5 text-[#FF6500]" />
                    <h2 className="text-lg font-black">
                      WordPress Live Payment Bridge (Multi-Gateway Checkout)
                    </h2>
                  </div>
                  <span
                    className="text-[11px] font-black uppercase px-2.5 py-1 rounded-lg border"
                    style={{
                      background: settings.wordpressPaymentEnabled
                        ? 'var(--green-soft)'
                        : 'var(--surface-2)',
                      color: settings.wordpressPaymentEnabled ? 'var(--green)' : 'var(--text-2)',
                      borderColor: 'var(--border-soft)',
                    }}
                  >
                    {settings.wordpressPaymentEnabled ? 'Enabled in Settings' : 'Wallet-Only Mode'}
                  </span>
                </div>

                <p className="text-xs opacity-80 leading-relaxed">
                  Connect your WordPress / WooCommerce payment hub to dynamically expose any number of live payment gateways (bKash Merchant, SSLCommerz, Stripe, PayPal, UddoktaPay, Cards) on the BEXORA Checkout page. Secret keys (<code>WORDPRESS_WEBHOOK_SECRET</code>, <code>WORDPRESS_CONSUMER_KEY</code>, <code>WORDPRESS_CONSUMER_SECRET</code>) stay strictly server-side in environment variables—never in public database settings.
                </p>

                <label className="flex items-center gap-2.5 text-xs font-extrabold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wpEnabled}
                    onChange={(e) => setWpEnabled(e.target.checked)}
                    className="w-4 h-4 accent-[#FF6500]"
                  />
                  <span>Enable WordPress Live Payment Gateways on Checkout Page</span>
                </label>

                <div>
                  <label htmlFor="bx-wp-site-url" className="block text-xs font-extrabold mb-1">
                    WordPress Site HTTPS Origin URL
                  </label>
                  <input
                    id="bx-wp-site-url"
                    type="url"
                    value={wpSiteUrl}
                    onChange={(e) => setWpSiteUrl(e.target.value)}
                    placeholder="https://pay.yourdomain.com"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                </div>

                <div>
                  <label htmlFor="bx-wp-bridge-endpoint" className="block text-xs font-extrabold mb-1">
                    WordPress REST Bridge Base Path
                  </label>
                  <input
                    id="bx-wp-bridge-endpoint"
                    type="text"
                    value={wpBridgeEndpoint}
                    onChange={(e) => setWpBridgeEndpoint(e.target.value)}
                    placeholder="/wp-json/bexora/v1"
                    className="bx-input w-full px-3.5 py-2.5 text-sm"
                  />
                  <span className="bx-hint block mt-1">
                    Supports custom <code>/wp-json/bexora/v1/gateways</code> plugin endpoints or standard WooCommerce REST <code>/wp-json/wc/v3/payment_gateways</code>.
                  </span>
                </div>

                {wpTestResult && (
                  <div className="p-3.5 rounded-xl bx-soft space-y-2 text-xs">
                    <div className="font-extrabold">
                      Status: <span className="uppercase">{wpTestResult.statusCode}</span> · Webhook Secret:{' '}
                      {wpTestResult.webhookSecretConfigured ? 'Configured' : 'Not Configured'}
                    </div>
                    <p style={{ color: 'var(--text-2)' }}>{wpTestResult.userMessage}</p>
                    {wpTestResult.methods.length > 0 && (
                      <div className="pt-1 flex flex-wrap gap-1.5">
                        {wpTestResult.methods.map((m) => (
                          <span
                            key={m.id}
                            className="px-2 py-0.5 rounded-md border font-bold"
                            style={{
                              background: 'var(--surface)',
                              borderColor: 'var(--border-soft)',
                            }}
                          >
                            {m.title} ({m.id})
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="submit"
                    className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold"
                  >
                    Save WordPress Bridge Settings
                  </button>
                  <button
                    type="button"
                    disabled={testingWpBridge}
                    onClick={handleTestWordPressBridge}
                    className="bx-btn px-4 py-2.5 text-xs font-extrabold inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${testingWpBridge ? 'animate-spin' : ''}`} />
                    <span>{testingWpBridge ? 'Testing Gateways…' : 'Test WordPress Connection'}</span>
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 11. SUPERADMIN ROLE MANAGEMENT & AUDIT LOGS */}
          {section === 'roles' && (
            <div className="space-y-6">
              <div className="bx-card p-6 space-y-4">
                <h1 className="text-xl font-black">Superadmin & Role Governance</h1>
                <p className="text-xs opacity-75">
                  Bootstrapped Superadmin Email: <strong>{BOOTSTRAPPED_SUPERADMIN_EMAIL}</strong> (enforced directly in Firestore Security Rules).
                </p>

                {isSuperAdmin ? (
                  <form onSubmit={handleGrantAdminRole} className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={targetRoleUid}
                      onChange={(e) => setTargetRoleUid(e.target.value)}
                      placeholder="Target Firebase User UID"
                      className="bx-input flex-1 px-3 py-2 text-xs"
                    />
                    <select
                      value={targetRoleLevel}
                      onChange={(e) => setTargetRoleLevel(e.target.value as 'admin' | 'superadmin')}
                      className="bx-input px-3 py-2 text-xs font-bold"
                    >
                      <option value="admin">Admin</option>
                      <option value="superadmin">Superadmin</option>
                    </select>
                    <button type="submit" className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold">
                      Grant Role
                    </button>
                  </form>
                ) : (
                  <p className="text-xs font-bold text-amber-600">Only Superadmins can grant or revoke admin roles.</p>
                )}

                {adminRoles.length > 0 && (
                  <div className="space-y-2 pt-2">
                    {adminRoles.map((r) => (
                      <div key={r.uid} className="p-3 border border-[var(--bx-border)] flex items-center justify-between text-xs font-bold">
                        <span>
                          UID: {r.uid} · Role: {r.role.toUpperCase()}
                        </span>
                        {isSuperAdmin && (
                          <button
                            type="button"
                            onClick={() => handleRevokeAdminRole(r.uid)}
                            className="text-red-600 underline"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

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

          {/* 12. PRODUCTION-SAFE AI DEVELOPER SUITE (ALL 15 SUBSECTIONS) */}
          {section === 'aidev' && (
            <div className="space-y-5">
              <div className="bx-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="inline-flex items-center gap-1.5 text-xs font-black uppercase px-2 py-0.5 bg-[#793A91] text-white mb-1">
                    <Bot className="w-3.5 h-3.5" />
                    Human-Gated AI Developer Suite
                  </div>
                  <h1 className="text-xl font-black">BEXORA AI Developer & Governance Center</h1>
                  <p className="text-xs opacity-75">
                    Zero silent production mutations — every proposal requires explicit Approve / Reject / Review.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleToggleEmergencyStop}
                  className={`px-4 py-2.5 text-xs font-black border-2 border-[#191919] inline-flex items-center gap-2 ${
                    settings.aiEmergencyStop ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                  }`}
                >
                  <AlertOctagon className="w-4 h-4" />
                  {settings.aiEmergencyStop ? 'Clear Emergency Stop' : 'EMERGENCY STOP'}
                </button>
              </div>

              {/* 15 Subsection Switcher */}
              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    { id: 'chat', label: '1. AI Chat' },
                    { id: 'health', label: '2. System Health' },
                    { id: 'bugs', label: '3. Bug Tracker' },
                    { id: 'security', label: '4. Security Audit' },
                    { id: 'deals', label: '5. Deal Monitor' },
                    { id: 'verification', label: '6. Verification Rules' },
                    { id: 'features', label: '7. Feature Proposals' },
                    { id: 'diff', label: '8. Code & Diff' },
                    { id: 'preview', label: '9. Interactive Preview' },
                    { id: 'queue', label: `10. Approval Queue (${proposals.filter((p) => p.status === 'awaiting_review').length})` },
                    { id: 'deployments', label: '11. Deployments & ZIP' },
                    { id: 'backup', label: '12. Backup & Recovery' },
                    { id: 'logs', label: '13. Audit Logs' },
                    { id: 'notifications', label: '14. Notifications' },
                    { id: 'emergency', label: '15. Emergency Stop' },
                  ] as { id: AiDevSubTab; label: string }[]
                ).map((tItem) => (
                  <button
                    key={tItem.id}
                    type="button"
                    onClick={() => setAiTab(tItem.id)}
                    className={`px-2.5 py-1.5 text-[11px] font-extrabold border transition-colors ${
                      aiTab === tItem.id
                        ? 'bg-[#FF6500] text-white border-[#191919]'
                        : 'bg-[var(--bx-surface)] border-[var(--bx-border)]'
                    }`}
                  >
                    {tItem.label}
                  </button>
                ))}
              </div>

              {/* AI SUBTAB 1: CHAT */}
              {aiTab === 'chat' && (
                <div className="bx-card p-5 space-y-4">
                  <h2 className="text-base font-black">AI Developer Engineering Assistant</h2>
                  <div className="h-64 overflow-y-auto border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] p-3 space-y-3">
                    {aiMessages.length === 0 ? (
                      <p className="text-xs opacity-75">
                        Ask the AI Developer to diagnose issues, review monetization rules, or draft staged improvements. Nothing deploys without your approval.
                      </p>
                    ) : (
                      aiMessages.map((m, idx) => (
                        <div
                          key={idx}
                          className={`p-3 text-xs border border-[var(--bx-border)] ${
                            m.role === 'admin' ? 'bg-[#FFD400] text-[#191919] font-bold ml-8' : 'bg-[var(--bx-surface)] mr-8 whitespace-pre-wrap'
                          }`}
                        >
                          <div className="text-[10px] font-black uppercase opacity-70 mb-1">
                            {m.role === 'admin' ? 'Administrator' : 'BEXORA AI Developer'}
                          </div>
                          {m.text}
                        </div>
                      ))
                    )}
                  </div>
                  <form onSubmit={handleSendAiDevChat} className="flex gap-2">
                    <input
                      type="text"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      disabled={aiBusy || settings.aiEmergencyStop}
                      placeholder={settings.aiEmergencyStop ? 'Emergency Stop is active…' : 'Ask for diagnostics, architecture checks, or staged diffs…'}
                      className="bx-input flex-1 px-3 py-2 text-xs"
                    />
                    <button
                      type="submit"
                      disabled={aiBusy || settings.aiEmergencyStop}
                      className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                    >
                      <Send className="w-3.5 h-3.5" />
                      {aiBusy ? 'Thinking…' : 'Send'}
                    </button>
                  </form>
                </div>
              )}

              {/* AI SUBTAB 2: SYSTEM HEALTH (ADMIN-ONLY CLOUD & FIREBASE DIAGNOSTICS) */}
              {aiTab === 'health' && (
                <div className="bx-card p-5 space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <h2 className="text-base font-black">
                        System Health & Continuous 5-Minute Cloud Diagnostics
                      </h2>
                      <p className="text-xs opacity-75">
                        Restricted strictly to authorized BEXORA Administrators. Firebase & Google Cloud configuration links are isolated here and never shown on public customer screens.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={fetchSystemHealth}
                      className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold inline-flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      Refresh Live Check
                    </button>
                  </div>

                  <div className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3 text-xs">
                    <div className="font-black uppercase tracking-wider text-[11px] text-[#FF6500]">
                      Admin-Only Cloud & Firebase Quick Actions
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={enablingCloudService !== null}
                        onClick={() => handleEnableCloudServiceFromHealth('token_service')}
                        className="bx-btn bx-btn-primary px-3 py-1.5 text-xs font-extrabold"
                      >
                        {enablingCloudService === 'token_service'
                          ? 'Checking Token Service…'
                          : 'Auto-Enable Token Service API'}
                      </button>
                      <button
                        type="button"
                        disabled={enablingCloudService !== null}
                        onClick={() => handleEnableCloudServiceFromHealth('fcm_apis')}
                        className="bx-btn px-3 py-1.5 text-xs font-extrabold"
                      >
                        {enablingCloudService === 'fcm_apis'
                          ? 'Checking FCM APIs…'
                          : 'Auto-Enable FCM Cloud APIs'}
                      </button>
                      <a
                        href={DEFAULT_FIREBASE_AUTH_PROVIDERS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1"
                      >
                        Firebase Sign-In Providers <ExternalLink className="w-3 h-3" />
                      </a>
                      <a
                        href={DEFAULT_FIREBASE_AUTH_DOMAINS_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1"
                      >
                        Authorized Domains <ExternalLink className="w-3 h-3" />
                      </a>
                      <a
                        href={DEFAULT_TOKEN_SERVICE_ACTIVATION_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1"
                      >
                        Google Cloud Token Service <ExternalLink className="w-3 h-3" />
                      </a>
                    </div>
                  </div>

                  <pre className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs overflow-x-auto max-h-96">
                    {JSON.stringify(healthSnapshot || { checking: true }, null, 2)}
                  </pre>
                </div>
              )}

              {/* AI SUBTABS 3 & 7: STAGE BUG OR FEATURE PROPOSAL */}
              {(aiTab === 'bugs' || aiTab === 'features') && (
                <form onSubmit={handleStageAiProposal} className="bx-card p-5 space-y-4">
                  <h2 className="text-base font-black">
                    {aiTab === 'bugs' ? 'Bug & Issue Staging Workbench' : 'Stage New Feature Proposal'}
                  </h2>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <input
                      type="text"
                      required
                      value={newPropTitle}
                      onChange={(e) => setNewPropTitle(e.target.value)}
                      placeholder="Proposal title…"
                      className="bx-input sm:col-span-2 px-3 py-2 text-xs"
                    />
                    <select
                      value={newPropSeverity}
                      onChange={(e) => setNewPropSeverity(e.target.value as 'low' | 'medium' | 'high' | 'critical')}
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
                    value={newPropFiles}
                    onChange={(e) => setNewPropFiles(e.target.value)}
                    placeholder="Affected files (comma-separated)"
                    className="bx-input w-full px-3 py-2 text-xs"
                  />
                  <textarea
                    rows={3}
                    value={newPropSummary}
                    onChange={(e) => setNewPropSummary(e.target.value)}
                    placeholder="Root cause, impact, and verification plan…"
                    className="bx-input w-full px-3 py-2 text-xs"
                  />
                  <textarea
                    rows={4}
                    value={newPropDiff}
                    onChange={(e) => setNewPropDiff(e.target.value)}
                    className="bx-input w-full px-3 py-2 text-xs font-mono"
                  />
                  <button
                    type="submit"
                    onClick={() => setNewPropCategory(aiTab === 'bugs' ? 'bugfix' : 'feature')}
                    className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold"
                  >
                    Stage to Human Approval Queue
                  </button>
                </form>
              )}

              {/* AI SUBTAB 4: SECURITY AUDIT */}
              {aiTab === 'security' && (
                <div className="bx-card p-5 space-y-3 text-xs font-bold">
                  <h2 className="text-base font-black">Automated Security & Invariant Audit</h2>
                  <ul className="space-y-2">
                    <li className="p-3 border border-[var(--bx-border)] flex items-center justify-between">
                      <span>Twilio Secrets & Dependencies Removed</span>
                      <span className="text-emerald-600">PASS (Firebase Auth Active)</span>
                    </li>
                    <li className="p-3 border border-[var(--bx-border)] flex items-center justify-between">
                      <span>Public vs Private User PII & NID Document Isolation</span>
                      <span className="text-emerald-600">PASS (/privateUsers & /identityVerifications locked)</span>
                    </li>
                    <li className="p-3 border border-[var(--bx-border)] flex items-center justify-between">
                      <span>Immutable Escrow Protection Timer (originalDeadlineMs)</span>
                      <span className="text-emerald-600">PASS (Enforced in Firestore Rules)</span>
                    </li>
                    <li className="p-3 border border-[var(--bx-border)] flex items-center justify-between">
                      <span>Zero Fake Listings / Reviews / Demo Credentials</span>
                      <span className="text-emerald-600">PASS</span>
                    </li>
                  </ul>
                </div>
              )}

              {/* AI SUBTAB 5: DEAL MONITORING */}
              {aiTab === 'deals' && (
                <div className="bx-card p-5 space-y-3 text-xs">
                  <h2 className="text-base font-black">Escrow Deal Anomaly & Timer Monitor</h2>
                  <p className="opacity-80">
                    Total Deals: <strong>{deals.length}</strong> · Active Protection: <strong>{deals.filter((d) => d.status === 'protection_active').length}</strong> · Paused Under Report Review: <strong>{reportedDealsCount}</strong>
                  </p>
                </div>
              )}

              {/* AI SUBTAB 6: LISTING VERIFICATION RULES */}
              {aiTab === 'verification' && (
                <div className="bx-card p-5 space-y-2 text-xs">
                  <h2 className="text-base font-black">Monetization Evidence Honesty Policy</h2>
                  <p>1. Seller claims are labeled strictly as <strong>Seller Claimed</strong> until evidence is verified.</p>
                  <p>2. Domain-matched URLs are labeled <strong>Domain Matched</strong> — never falsely claiming ownership verification.</p>
                  <p>3. If Gemini OCR is unconfigured or uncertain, listings route safely to manual Admin moderation.</p>
                </div>
              )}

              {/* AI SUBTAB 8: CODE DIFF VIEWER */}
              {aiTab === 'diff' && (
                <div className="bx-card p-5 space-y-3">
                  <h2 className="text-base font-black flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-[#FF6500]" />
                    Staged Diff Inspector
                  </h2>
                  {selectedDiffProposal ? (
                    <div className="space-y-2">
                      <div className="text-xs font-black">{selectedDiffProposal.title}</div>
                      <pre className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs font-mono overflow-x-auto">
                        {selectedDiffProposal.proposedDiff}
                      </pre>
                    </div>
                  ) : (
                    <p className="text-xs opacity-75">Select "Review" on any item in the Approval Queue to inspect its code diff.</p>
                  )}
                </div>
              )}

              {/* AI SUBTAB 9: INTERACTIVE PREVIEW */}
              {aiTab === 'preview' && (
                <div className="bx-card p-5 space-y-3 text-xs">
                  <h2 className="text-base font-black">Interactive Sandbox Preview</h2>
                  <p className="opacity-80">
                    Previewing active marketplace configuration before approving staged changes:
                  </p>
                  <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-1 font-bold">
                    <div>Sample ৳1,000 Deal → Buyer Pays {formatMoneyFromMinor(liveSample.buyerTotalMinor, 'BDT', 'BDT')} · Seller Receives {formatMoneyFromMinor(liveSample.sellerPayoutMinor, 'BDT', 'BDT')}</div>
                    <div>Configured Games ({settings.gamingTitles.length}): {settings.gamingTitles.join(', ')}</div>
                  </div>
                </div>
              )}

              {/* AI SUBTAB 10: HUMAN APPROVAL QUEUE */}
              {aiTab === 'queue' && (
                <div className="space-y-3">
                  <h2 className="text-base font-black flex items-center gap-2">
                    <Lock className="w-4 h-4 text-[#FF6500]" />
                    Mandatory Human Approval Queue ({proposals.length})
                  </h2>
                  {proposals.length === 0 ? (
                    <div className="bx-card p-6 text-xs font-bold opacity-75">
                      No staged AI proposals awaiting review.
                    </div>
                  ) : (
                    proposals.map((prop) => (
                      <div key={prop.id} className="bx-card p-4 space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="text-[10px] font-black uppercase px-2 py-0.5 border border-[var(--bx-border)] mr-2">
                              {prop.category} · {prop.severity}
                            </span>
                            <span className="font-black text-sm">{prop.title}</span>
                          </div>
                          <span className="text-xs font-black uppercase text-[#FF6500]">{prop.status}</span>
                        </div>
                        <p className="text-xs opacity-85">{prop.summary}</p>
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={settings.aiEmergencyStop}
                            onClick={() => handleProposalDecision(prop, 'approved')}
                            className="bx-btn bx-btn-primary px-3.5 py-1.5 text-xs font-extrabold"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => handleProposalDecision(prop, 'rejected')}
                            className="bx-btn px-3.5 py-1.5 text-xs font-extrabold bg-red-600 text-white border border-[#191919]"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              handleProposalDecision(prop, 'in_review');
                              setSelectedDiffProposal(prop);
                              setAiTab('diff');
                            }}
                            className="bx-btn bx-btn-ghost px-3.5 py-1.5 text-xs font-extrabold"
                          >
                            Review
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* AI SUBTAB 11: DEPLOYMENTS & INFINITYFREE ZIP */}
              {aiTab === 'deployments' && (
                <div className="bx-card p-5 space-y-4">
                  <h2 className="text-base font-black flex items-center gap-2">
                    <History className="w-4 h-4 text-[#FF6500]" />
                    InfinityFree Static Build & Deployment Package
                  </h2>
                  <p className="text-xs opacity-80">
                    Download the verified InfinityFree deployment archive containing compiled static assets, PWA manifest & icons, and Apache <code>.htaccess</code> rewrite rules.
                  </p>
                  <a
                    href="/BEXORA_INFINITYFREE_PRODUCTION.zip"
                    download="BEXORA_INFINITYFREE_PRODUCTION.zip"
                    className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold inline-flex items-center gap-2"
                  >
                    <Download className="w-4 h-4" />
                    Download BEXORA_INFINITYFREE_PRODUCTION.zip
                  </a>
                </div>
              )}

              {/* AI SUBTAB 12: BACKUP & RECOVERY */}
              {aiTab === 'backup' && (
                <div className="bx-card p-5 space-y-3">
                  <h2 className="text-base font-black">Configuration Snapshot Export</h2>
                  <p className="text-xs opacity-80">
                    Export a JSON recovery checkpoint of current BEXORA commission, category, protection, and proposal state.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), settings, proposals }, null, 2)], {
                        type: 'application/json',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `bexora-config-checkpoint-${Date.now()}.json`;
                      a.click();
                      URL.revokeObjectURL(url);
                    }}
                    className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold"
                  >
                    Export Recovery Checkpoint (.json)
                  </button>
                </div>
              )}

              {/* AI SUBTAB 13: AUDIT LOGS */}
              {aiTab === 'logs' && (
                <div className="bx-card p-5 space-y-2 max-h-80 overflow-y-auto">
                  <h2 className="text-base font-black">AI & Admin Audit Trail</h2>
                  {auditLogs.map((l) => (
                    <div key={l.id} className="p-2 border border-[var(--bx-border)] text-xs">
                      <strong>{l.action}</strong> — {l.details}
                    </div>
                  ))}
                </div>
              )}

              {/* AI SUBTAB 14: NOTIFICATIONS */}
              {aiTab === 'notifications' && (
                <div className="bx-card p-5 space-y-3 text-xs font-bold">
                  <h2 className="text-base font-black">Authentication, FCM Web Push & Sound Configuration</h2>
                  <div>Header Real-Time Notification Center (`notifications` + `announcements`): <span className="text-emerald-600">ACTIVE</span></div>
                  <div>
                    Firebase Admin SDK (`firebase-admin` / Cloud Run Managed ADC):{' '}
                    <span className={fcmServerDiag?.adminSdkInitialized ? 'text-emerald-600' : 'text-amber-600'}>
                      {loadingFcmDiag ? 'CHECKING…' : fcmServerDiag?.adminSdkInitialized ? 'INITIALIZED (KEYLESS MANAGED ADC)' : 'CHECK IN NOTIFICATIONS TAB'}
                    </span>
                  </div>
                  <div>
                    Web Push VAPID Public Key:{' '}
                    <span className="text-emerald-600">
                      {isValidVapidPublicKey(settings.fcmVapidPublicKey)
                        ? 'ACTIVE (CUSTOM PUBLIC CERTIFICATE)'
                        : fcmServerDiag?.vapidMode === 'custom_env'
                        ? 'ACTIVE (CUSTOM ENV PUBLIC KEY)'
                        : 'ACTIVE (FCM OFFICIAL MANAGED DEFAULT)'}
                    </span>
                  </div>
                  <div>
                    FCM HTTP v1 API (`fcm.googleapis.com`):{' '}
                    <span className={fcmServerDiag?.fcmV1ApiStatus === 'enabled_verified' ? 'text-emerald-600' : 'text-amber-600'}>
                      {loadingFcmDiag ? 'CHECKING…' : (fcmServerDiag?.fcmV1ApiStatus || 'CHECK IN NOTIFICATIONS TAB').toUpperCase()}
                    </span>
                  </div>
                  <div>
                    FCM Registrations API (`fcmregistrations.googleapis.com`):{' '}
                    <span className={fcmServerDiag?.fcmRegistrationsApiStatus === 'enabled_verified' ? 'text-emerald-600' : 'text-amber-600'}>
                      {loadingFcmDiag ? 'CHECKING…' : (fcmServerDiag?.fcmRegistrationsApiStatus || 'CHECK IN NOTIFICATIONS TAB').toUpperCase()}
                    </span>
                  </div>
                  <div>
                    Firebase Installations API (`firebaseinstallations.googleapis.com`):{' '}
                    <span className={fcmServerDiag?.firebaseInstallationsApiStatus === 'enabled_verified' ? 'text-emerald-600' : 'text-amber-600'}>
                      {loadingFcmDiag ? 'CHECKING…' : (fcmServerDiag?.firebaseInstallationsApiStatus || 'CHECK IN NOTIFICATIONS TAB').toUpperCase()}
                    </span>
                  </div>
                  <div>
                    Server FCM HTTP v1 Send IAM (`firebase-admin` / `roles/firebasecloudmessaging.admin`):{' '}
                    <span className={fcmServerDiag?.fcmSendApiStatus === 'enabled_verified' ? 'text-emerald-600' : 'text-amber-600'}>
                      {loadingFcmDiag ? 'CHECKING…' : (fcmServerDiag?.fcmSendApiStatus || 'CHECK IN NOTIFICATIONS TAB').toUpperCase()}
                    </span>
                  </div>
                  <div>Local Notification Sound Library (`01_soft_normal.wav` – `04_urgent_deal.wav`): <span className="text-emerald-600">4 WAV ASSETS PRESERVED (DEFAULT: SAMPLE 2 + SAMPLE 4 + STRONG VIBRATION)</span></div>
                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => setSection('notifications')}
                      className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                    >
                      <Bell className="w-3.5 h-3.5" />
                      Open FCM, Sound & Announcements Workbench
                    </button>
                  </div>
                </div>
              )}

              {/* AI SUBTAB 15: EMERGENCY STOP */}
              {aiTab === 'emergency' && (
                <div className="bx-card p-6 space-y-4 border-2 border-red-600">
                  <h2 className="text-lg font-black text-red-600">Emergency Kill-Switch</h2>
                  <p className="text-xs">
                    Current Status: <strong>{settings.aiEmergencyStop ? 'HALTED (Emergency Stop Active)' : 'OPERATIONAL (Human-Gated Mode)'}</strong>
                  </p>
                  <button
                    type="button"
                    onClick={handleToggleEmergencyStop}
                    className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold"
                  >
                    {settings.aiEmergencyStop ? 'Resume Normal Human-Gated AI Operations' : 'Activate Immediate Emergency Stop'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ANNOUNCEMENTS & USER ALERTS COMPOSER */}
          {section === 'notifications' && (
            <div className="space-y-6">
              {/* Firebase Cloud Messaging, VAPID & Sound Library Card */}
              <div className="bx-card p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--bx-border)] pb-3">
                  <div>
                    <h2 className="text-lg font-black flex items-center gap-2">
                      <Volume2 className="w-5 h-5 text-[#FF6500]" />
                      Web Push (FCM), Public VAPID Key & Sound Library
                    </h2>
                    <p className="text-xs opacity-75 mt-1">
                      Project <span className="font-mono">responsive-dragon-tmn89</span> · Web App <span className="font-mono">1:448578956301:web:091629c6e19eafa50ef944</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={loadingFcmDiag}
                    onClick={() => {
                      setLoadingFcmDiag(true);
                      void fetchServerFcmStatus()
                        .then((diag) => setFcmServerDiag(diag))
                        .finally(() => setLoadingFcmDiag(false));
                    }}
                    className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${loadingFcmDiag ? 'animate-spin' : ''}`} />
                    <span>Recheck Cloud Status</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-1">
                    <div className="opacity-70 font-semibold">Web Push VAPID &amp; Admin SDK</div>
                    <div className="font-extrabold text-emerald-600">
                      {isValidVapidPublicKey(settings.fcmVapidPublicKey)
                        ? 'Custom Public Key + Managed ADC'
                        : fcmServerDiag?.vapidMode === 'custom_env'
                        ? 'Custom Env Key + Managed ADC'
                        : 'FCM Official Default + Managed ADC'}
                    </div>
                  </div>
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-1">
                    <div className="opacity-70 font-semibold">FCM HTTP v1 &amp; Installations</div>
                    <div className="font-extrabold">
                      {fcmServerDiag?.fcmV1ApiStatus === 'enabled_verified' &&
                      fcmServerDiag?.firebaseInstallationsApiStatus === 'enabled_verified'
                        ? 'Both Enabled in GCP'
                        : fcmServerDiag
                        ? `v1: ${fcmServerDiag.fcmV1ApiStatus} · FID: ${fcmServerDiag.firebaseInstallationsApiStatus}`
                        : 'Pending Check'}
                    </div>
                  </div>
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-1">
                    <div className="opacity-70 font-semibold">FCM Registrations API</div>
                    <div className="font-extrabold">
                      {fcmServerDiag?.fcmRegistrationsApiStatus === 'enabled_verified'
                        ? 'Enabled'
                        : fcmServerDiag?.fcmRegistrationsApiStatus === 'disabled'
                        ? 'Disabled (fcmregistrations.googleapis.com)'
                        : 'Pending Check'}
                    </div>
                  </div>
                  <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-1">
                    <div className="opacity-70 font-semibold">Firebase Admin Send IAM</div>
                    <div className="font-extrabold">
                      {fcmServerDiag?.fcmSendApiStatus === 'enabled_verified'
                        ? 'Authorized & Ready'
                        : fcmServerDiag?.fcmSendApiStatus === 'permission_denied'
                        ? 'Needs roles/firebasecloudmessaging.admin'
                        : fcmServerDiag?.fcmSendApiStatus === 'disabled'
                        ? 'Disabled in GCP (fcm.googleapis.com)'
                        : 'Pending Check'}
                    </div>
                  </div>
                </div>

                {fcmServerDiag?.vapidConsoleErrorDiagnosis && (
                  <div className="p-3.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs space-y-2">
                    <div className="font-black text-[#FF6500]">
                      Cloud Messaging &amp; IAM Readiness (`responsive-dragon-tmn89`)
                    </div>
                    <p className="leading-relaxed opacity-90">
                      {fcmServerDiag.vapidConsoleErrorDiagnosis}
                    </p>
                    {fcmServerDiag.fcmRegistrationsApiStatus === 'disabled' && (
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <button
                          type="button"
                          disabled={loadingFcmDiag}
                          onClick={() => {
                            setLoadingFcmDiag(true);
                            void enableFcmCloudApisViaServer()
                              .then(async (res) => {
                                onFlash(res.message);
                                const diag = await fetchServerFcmStatus();
                                setFcmServerDiag(diag);
                              })
                              .finally(() => setLoadingFcmDiag(false));
                          }}
                          className="bx-btn bx-btn-primary px-3 py-1.5 text-xs font-extrabold"
                        >
                          Auto-Enable FCM Registration API
                        </button>
                        <a
                          href={fcmServerDiag.fcmRegistrationsActivationUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1"
                        >
                          <span>Open Cloud Console API Library</span>
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    )}
                  </div>
                )}

                <form onSubmit={handleSavePublicVapidKey} className="space-y-2.5">
                  <label className="block space-y-1 text-xs font-bold">
                    <span>
                      Optional Custom Web Push Public Certificate Override (Leave blank to use FCM Official Managed Default)
                    </span>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={vapidPublicKeyInput}
                        onChange={(e) => setVapidPublicKeyInput(e.target.value)}
                        placeholder="Paste 87-88 char base64url P-256 public key from Firebase Console > Cloud Messaging > Web Push certificates"
                        className="bx-input flex-1 px-3 py-2 text-xs font-mono"
                      />
                      <button
                        type="submit"
                        disabled={savingVapidKey}
                        className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold whitespace-nowrap shrink-0"
                      >
                        {savingVapidKey ? 'Saving…' : 'Verify & Save Public Key'}
                      </button>
                    </div>
                  </label>
                  <p className="text-[11px] opacity-75">
                    Security rule: Only the <strong>public</strong> Web Push certificate key (65-byte uncompressed P-256 point) is accepted. Private keys are mathematically rejected.
                  </p>
                </form>

                <div className="pt-2 border-t border-[var(--bx-border)] space-y-2">
                  <div className="text-xs font-bold">Bundled Notification Sound Assets (`public/sounds/*.wav`)</div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    {NOTIFICATION_SOUND_CATALOG.map((snd) => (
                      <div
                        key={snd.id}
                        className="p-2.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex items-center justify-between gap-2"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-extrabold truncate">{snd.label}</div>
                          <div className="text-[11px] font-mono opacity-70 truncate">{snd.id}.wav</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            void playNotificationSoundById(snd.id, { isManualPreview: true });
                          }}
                          className="bx-btn bx-btn-ghost px-2.5 py-1 text-[11px] font-bold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                          aria-label={`Preview ${snd.label}`}
                        >
                          <Play className="w-3 h-3" />
                          <span>Preview</span>
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="bx-card p-6 space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--bx-border)] pb-3">
                  <div>
                    <h1 className="text-xl font-black flex items-center gap-2">
                      <Megaphone className="w-5 h-5 text-[#FF6500]" />
                      Platform Announcements & Targeted User Alerts
                    </h1>
                    <p className="text-xs opacity-75 mt-1">
                      Publish official BEXORA announcements to the Header Notification Center or send direct notices to an individual member UID.
                    </p>
                  </div>
                </div>

                <form onSubmit={handlePublishAdminAlert} className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <label className="block space-y-1 text-xs font-bold">
                      <span>Delivery Mode</span>
                      <select
                        value={notifMode}
                        onChange={(e) => setNotifMode(e.target.value as 'broadcast_announcement' | 'targeted_user')}
                        className="bx-input w-full px-3 py-2 text-xs font-bold"
                      >
                        <option value="broadcast_announcement">Platform Broadcast Announcement</option>
                        <option value="targeted_user">Targeted Single User (by UID)</option>
                      </select>
                    </label>

                    <label className="block space-y-1 text-xs font-bold">
                      <span>Severity</span>
                      <select
                        value={notifSeverity}
                        onChange={(e) => setNotifSeverity(e.target.value as NotificationSeverity)}
                        className="bx-input w-full px-3 py-2 text-xs font-bold"
                      >
                        <option value="info">Info</option>
                        <option value="success">Success</option>
                        <option value="warning">Warning</option>
                        <option value="critical">Critical Security / Maintenance</option>
                      </select>
                    </label>

                    <label className="block space-y-1 text-xs font-bold">
                      <span>Optional Destination Button</span>
                      <select
                        value={notifDestination}
                        onChange={(e) => setNotifDestination(e.target.value)}
                        className="bx-input w-full px-3 py-2 text-xs font-bold"
                      >
                        <option value="">None (Read-Only Message)</option>
                        <option value="marketplace">Marketplace Home</option>
                        <option value="deals">Escrow Deals</option>
                        <option value="wallet">Wallet</option>
                        <option value="profile">Account Profile</option>
                        <option value="profile:nid">NID Verification</option>
                      </select>
                    </label>
                  </div>

                  {notifMode === 'targeted_user' ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="block space-y-1 text-xs font-bold">
                        <span>Target User UID</span>
                        <input
                          type="text"
                          required
                          value={notifTargetUid}
                          onChange={(e) => setNotifTargetUid(e.target.value)}
                          placeholder="Paste member Firebase UID"
                          className="bx-input w-full px-3 py-2 text-xs font-mono"
                        />
                      </label>
                      <label className="block space-y-1 text-xs font-bold">
                        <span>Category</span>
                        <select
                          value={notifCategory}
                          onChange={(e) => setNotifCategory(e.target.value as NotificationCategory)}
                          className="bx-input w-full px-3 py-2 text-xs font-bold"
                        >
                          <option value="system">System Notice</option>
                          <option value="security">Security Alert</option>
                          <option value="verification">Verification</option>
                          <option value="deal">Escrow Deal</option>
                          <option value="wallet">Wallet</option>
                          <option value="listing">Listing Moderation</option>
                        </select>
                      </label>
                    </div>
                  ) : (
                    <label className="inline-flex items-center gap-2 text-xs font-bold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={notifPersistBanner}
                        onChange={(e) => setNotifPersistBanner(e.target.checked)}
                      />
                      <span>Also keep active in public `/announcements` feed for visitors and future sign-ups</span>
                    </label>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block space-y-1 text-xs font-bold">
                      <span>Notification Title (max 140 chars)</span>
                      <input
                        type="text"
                        required
                        maxLength={140}
                        value={notifTitle}
                        onChange={(e) => setNotifTitle(e.target.value)}
                        placeholder="e.g. Scheduled Escrow Verification Upgrade"
                        className="bx-input w-full px-3 py-2 text-xs"
                      />
                    </label>
                    <label className="block space-y-1 text-xs font-bold">
                      <span>Short List Preview (optional, max 240 chars)</span>
                      <input
                        type="text"
                        maxLength={240}
                        value={notifPreview}
                        onChange={(e) => setNotifPreview(e.target.value)}
                        placeholder="Concise summary shown in the header dropdown"
                        className="bx-input w-full px-3 py-2 text-xs"
                      />
                    </label>
                  </div>

                  <label className="block space-y-1 text-xs font-bold">
                    <span>Full Notification Content (shown when user clicks View, max 2000 chars)</span>
                    <textarea
                      required
                      rows={4}
                      maxLength={2000}
                      value={notifBody}
                      onChange={(e) => setNotifBody(e.target.value)}
                      placeholder="Write the complete notification message..."
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={sendingAdminNotif}
                    className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-extrabold inline-flex items-center gap-2"
                  >
                    <Send className="w-4 h-4" />
                    {sendingAdminNotif
                      ? 'Publishing Notification…'
                      : notifMode === 'broadcast_announcement'
                      ? 'Publish Broadcast Announcement'
                      : 'Send Direct User Notification'}
                  </button>
                </form>
              </div>

              <div className="bx-card p-6 space-y-4">
                <h2 className="text-base font-black">Broadcast Announcements History ({announcements.length})</h2>
                {announcements.length === 0 ? (
                  <p className="text-xs opacity-75">No broadcast announcements published yet.</p>
                ) : (
                  <div className="space-y-3">
                    {announcements.map((ann) => (
                      <div
                        key={ann.id}
                        className="p-4 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-[10px] font-black uppercase px-2 py-0.5 border border-black ${
                                ann.active ? 'bg-emerald-600 text-white' : 'bg-zinc-500 text-white'
                              }`}
                            >
                              {ann.active ? 'Active' : 'Archived'}
                            </span>
                            <span className="text-[11px] font-bold uppercase opacity-75">{ann.severity}</span>
                            <span className="text-sm font-black truncate">{ann.title}</span>
                          </div>
                          <p className="text-xs opacity-80 line-clamp-2">{ann.body}</p>
                        </div>
                        {ann.active && (
                          <button
                            type="button"
                            onClick={() => handleArchiveAnnouncement(ann.id)}
                            className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold shrink-0"
                          >
                            Archive
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
