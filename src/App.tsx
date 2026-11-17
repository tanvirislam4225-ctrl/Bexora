import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import {
  collection,
  deleteDoc,
  doc,
  enableNetwork,
  getDoc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  CheckCircle2,
  Lock,
  MailCheck,
  RefreshCw,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import {
  AdminInvitationRecord,
  AnnouncementRecord,
  BidRecord,
  ConversationRecord,
  CurrencyCode,
  DealRecord,
  DepositRequestRecord,
  FavoriteRecord,
  InfoTopicId,
  LanguageCode,
  MarketplaceListing,
  NotificationRecord,
  PlatformId,
  PrivateUser,
  PublicActivityItem,
  PublicProfile,
  PublicSettings,
  RecentSearchRecord,
  SellerFollowRecord,
  ThemeMode,
  UserNotificationPreferences,
  WithdrawalRequestRecord,
} from './types';
import {
  attemptSilentGoogleSessionRefresh,
  auth,
  BOOTSTRAPPED_SUPERADMIN_EMAIL,
  clearRecoverableSessionOnLogout,
  consumePendingAuthRedirectResult,
  consumeStaleTokenSessionClearedNotice,
  db,
  detectFirebaseAuthCapabilities,
  dismissRecoverableSessionPrompt,
  ensureUserProfileInitialized,
  extendCurrentUserSessionInteractive,
  extractUserFacingFirestoreError,
  fetchWithFreshBearerToken,
  FirebaseAuthCapabilities,
  formatFirebaseAuthError,
  getValidFirebaseIdToken,
  hasPendingRecoverableSession,
  isTokenServiceDisabledError,
  markAuthenticatedSessionActive,
  prepareFirestoreAuthSession,
  recoverFirestoreFromTokenServiceError,
  safeRefreshCurrentUserToken,
  safeSendEmailVerification,
  syncProactiveRefreshWithCapabilities,
  testFirestoreConnection,
} from './lib/firebase';
import {
  resolveNavbarAuthState,
  shouldShowProtectedRouteLoading,
} from './lib/authDomainAndPersistenceLogic';
import {
  clearCachedUser,
  hasFirebaseAuthUserKey,
  readCachedUser,
  shouldCheckAuthRedirectResult,
  writeCachedUser,
  type CachedUser,
} from './lib/cachedUser';
import { DEFAULT_PUBLIC_SETTINGS } from './lib/marketplaceLogic';
import {
  computeUnreadNotificationCount,
  evaluateDealDeadlineNotification,
  isFollowedSellerNewListingNotification,
  SafeInternalDestination,
  sanitizeNotificationDestination,
  sortNotificationsNewestFirst,
} from './lib/notificationLogic';
import {
  clearAllUserNotificationsInFirestore,
  deleteNotificationInFirestore,
  dismissNotificationsLocally,
  emitDealAdminNotification,
  emitUserNotification,
  getLocallyDismissedNotificationIds,
  markAllNotificationsReadInFirestore,
  markLocalAnnouncementRead,
  markNotificationReadInFirestore,
  mergeAnnouncementsIntoFeed,
} from './lib/notificationService';
import { clearAllMarketplaceFiltersAndSearch } from './lib/marketplaceFilterLogic';
import {
  setRuntimeFallbackVapidPublicKey,
  subscribeForegroundPushMessages,
  syncActiveWebPushTokenForSession,
  unlinkCurrentDevicePushTokenOnLogout,
} from './lib/pushNotifications';
import {
  attachAudioUnlockListeners,
  dispatchForegroundNotificationAlert,
  loadLocalNotificationPreferences,
  normalizeNotificationPreferences,
  NotificationArrivalTracker,
  saveLocalNotificationPreferences,
} from './lib/soundAndPushConfig';
import {
  AppRouteState,
  AuthScreenMode,
  buildSearchForRoute,
  canResumeAuthIntent,
  deserializePendingAuthIntent,
  FullScreenPage,
  parseRouteFromSearch,
  PendingAuthIntent,
  resolveCanonicalPathnameForNavigation,
  sanitizeRouteId,
  serializePendingAuthIntent,
} from './lib/checkoutAndIntentLogic';
import { isRtlLanguage, t } from './lib/i18n';
import { usePWAInstall } from './hooks/usePWAInstall';
import { BexoraLogo } from './components/Icons';
import { BottomNav, Navbar } from './components/Navbar';
import type { FirebaseAuthActionParams } from './components/FirebaseAuthActionModal';
import {
  EMPTY_FILTERS,
  MarketplaceFilterState,
} from './components/FilterPanel';
import { HomePageView } from './components/HomePageView';
import { MarketplacePageView } from './components/MarketplacePageView';
import {
  DashboardStatsSkeleton,
  DetailPageSkeleton,
  PageShellSkeleton,
} from './components/LoadingSkeletons';
import { buildApiUrl, dedupedRequest } from './lib/apiClient';
import {
  getListingReservationExpiryMs,
  isListingReservationActive,
  normalizeGatewayPaymentMethods,
} from './lib/walletTopupAndReservationLogic';
import {
  buildRouteScrollKey,
  doesRouteRequireImmediateSecondarySubs,
  NavigationDataCache,
  prefetchRouteView,
  RouteScrollMemory,
} from './lib/navigationCache';
import { NotificationCenter } from './components/NotificationCenter';
import { MarketplaceFooter } from './components/MarketplaceFooter';
import { initializeUserPresenceSession } from './lib/userPresenceService';
import { usePresence } from './lib/presenceService';
import { canUserFollowSeller, resolveSellerFollowerCount } from './lib/engagementLogic';
import {
  FollowTargetSellerSummary,
  removeFavoriteListingInFirestore,
  toggleFavoriteListingInFirestore,
  toggleFollowSellerInFirestore,
  unfollowSellerByIdInFirestore,
} from './lib/engagementService';
import {
  createRecentSearchRecord,
  loadGuestRecentSearches,
  MAX_RECENT_SEARCHES,
  RecentSearchInput,
  saveGuestRecentSearches,
  upsertRecentSearchList,
} from './lib/recentSearchLogic';
import {
  fetchMyModerationStatus,
  type MyModerationStatusResponse,
  type ReportModalTarget,
} from './lib/moderationClient';
import { AdminErrorBoundary } from './components/AdminErrorBoundary';
import { lazyWithRetry } from './lib/chunkRetry';
import type { UserRestrictionRecord } from './types/moderation';

const AuthModal = lazyWithRetry(() =>
  import('./components/AuthModal').then((m) => ({ default: m.AuthModal })),
);
const FirebaseAuthActionModal = lazyWithRetry(() =>
  import('./components/FirebaseAuthActionModal').then((m) => ({
    default: m.FirebaseAuthActionModal,
  })),
);
const CreateListingModal = lazyWithRetry(() =>
  import('./components/CreateListingModal').then((m) => ({ default: m.CreateListingModal })),
);
const ListingDetailModal = lazyWithRetry(() =>
  import('./components/ListingDetailModal').then((m) => ({ default: m.ListingDetailModal })),
);
const CheckoutView = lazyWithRetry(() =>
  import('./components/CheckoutView').then((m) => ({ default: m.CheckoutView })),
);
const ChatView = lazyWithRetry(() =>
  import('./components/ChatView').then((m) => ({ default: m.ChatView })),
);
const DealsView = lazyWithRetry(() =>
  import('./components/DealsView').then((m) => ({ default: m.DealsView })),
);
const WalletModal = lazyWithRetry(() =>
  import('./components/WalletModal').then((m) => ({ default: m.WalletModal })),
);
const ProfileView = lazyWithRetry(() =>
  import('./components/ProfileView').then((m) => ({ default: m.ProfileView })),
);
const TopSellersView = lazyWithRetry(() =>
  import('./components/TopSellersView').then((m) => ({ default: m.TopSellersView })),
);
const FavoritesView = lazyWithRetry(() =>
  import('./components/FavoritesView').then((m) => ({ default: m.FavoritesView })),
);
const MyBidsView = lazyWithRetry(() =>
  import('./components/MyBidsView').then((m) => ({ default: m.MyBidsView })),
);
const FollowingView = lazyWithRetry(() =>
  import('./components/FollowingView').then((m) => ({ default: m.FollowingView })),
);
const AdminDashboard = lazyWithRetry(() =>
  import('./components/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
);
const FloatingSupportWidget = lazyWithRetry(() =>
  import('./components/FloatingSupportWidget').then((m) => ({ default: m.FloatingSupportWidget })),
);
const PWAInstallBanner = lazyWithRetry(() =>
  import('./components/PWAInstallBanner').then((m) => ({ default: m.PWAInstallBanner })),
);
const NotificationPermissionOnboarding = lazyWithRetry(() =>
  import('./components/NotificationPermissionOnboarding').then((m) => ({
    default: m.NotificationPermissionOnboarding,
  })),
);
const RecentSearchesView = lazyWithRetry(() =>
  import('./components/RecentSearchesView').then((m) => ({ default: m.RecentSearchesView })),
);
const ReviewsView = lazyWithRetry(() =>
  import('./components/ReviewsView').then((m) => ({ default: m.ReviewsView })),
);
const InfoCenterView = lazyWithRetry(() =>
  import('./components/InfoCenterView').then((m) => ({ default: m.InfoCenterView })),
);
const ModerationStatusBannerAndAppealModal = lazyWithRetry(() =>
  import('./components/ModerationStatusBannerAndAppealModal').then((m) => ({
    default: m.ModerationStatusBannerAndAppealModal,
  })),
);
const ReportUserModal = lazyWithRetry(() =>
  import('./components/ReportUserModal').then((m) => ({ default: m.ReportUserModal })),
);
const PopupNotificationHost = lazyWithRetry(() =>
  import('./components/PopupNotificationHost').then((m) => ({
    default: m.PopupNotificationHost,
  })),
);

const PENDING_AUTH_INTENT_STORAGE_KEY = 'bx_pending_auth_intent';

function mapListingDocument(id: string, ld: Record<string, unknown>): MarketplaceListing {
  return {
    id,
    sellerId: String(ld.sellerId || ''),
    sellerName: String(ld.sellerName || ''),
    sellerUsername: String(ld.sellerUsername || ''),
    sellerVerified: Boolean(ld.sellerVerified),
    platform: ld.platform as PlatformId,
    subcategory: String(ld.subcategory || ''),
    title: String(ld.title || ''),
    description: String(ld.description || ''),
    priceMinor: Number(ld.priceMinor || 0),
    currency: (ld.currency as CurrencyCode) || 'BDT',
    monetizationStatus: ld.monetizationStatus as MarketplaceListing['monetizationStatus'],
    claimedOptions: Array.isArray(ld.claimedOptions) ? (ld.claimedOptions as string[]) : [],
    verifiedOptions: Array.isArray(ld.verifiedOptions) ? (ld.verifiedOptions as string[]) : [],
    verificationState: ld.verificationState as MarketplaceListing['verificationState'],
    ageYears: Number(ld.ageYears || 0),
    ageMonths: Number(ld.ageMonths || 0),
    metricValue: Number(ld.metricValue || 0),
    monthlyRevenueMinor: Number(ld.monthlyRevenueMinor || 0),
    accountUrl: String(ld.accountUrl || ''),
    urlValidationStatus:
      (ld.urlValidationStatus as MarketplaceListing['urlValidationStatus']) || 'not_applicable',
    gameName: ld.gameName ? String(ld.gameName) : undefined,
    gameUid: ld.gameUid ? String(ld.gameUid) : undefined,
    gameLevel: ld.gameLevel !== undefined ? Number(ld.gameLevel) : undefined,
    images: Array.isArray(ld.images) ? (ld.images as string[]) : [],
    activeDealId: ld.activeDealId ? String(ld.activeDealId) : undefined,
    acceptedBidAmountMinor: ld.acceptedBidAmountMinor
      ? Number(ld.acceptedBidAmountMinor)
      : undefined,
    reservedBuyerId: ld.reservedBuyerId ? String(ld.reservedBuyerId) : undefined,
    reservedUntilMs: ld.reservedUntilMs ? Number(ld.reservedUntilMs) : undefined,
    reservationExpiresAtMs: ld.reservationExpiresAtMs ? Number(ld.reservationExpiresAtMs) : undefined,
    reservationSessionId: ld.reservationSessionId ? String(ld.reservationSessionId) : undefined,
    status: ld.status as MarketplaceListing['status'],
    rejectionReason: ld.rejectionReason ? String(ld.rejectionReason) : undefined,
    views: Number(ld.views || 0),
    firstPublishedAtMs: ld.firstPublishedAtMs ? Number(ld.firstPublishedAtMs) : undefined,
    createdAtMs: (ld.createdAt as { toMillis?: () => number })?.toMillis
      ? (ld.createdAt as { toMillis: () => number }).toMillis()
      : Date.now(),
  };
}

const LISTINGS_CACHE_KEY = 'bx_listings_v1';
const LISTINGS_CACHE_MAX_BYTES = 200 * 1024;
const INITIAL_LISTINGS_PAGE_SIZE = 24;

function readCachedListings(): MarketplaceListing[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(LISTINGS_CACHE_KEY);
    if (!raw || raw.length > LISTINGS_CACHE_MAX_BYTES) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is MarketplaceListing =>
        Boolean(item && typeof item === 'object' && typeof item.id === 'string' && typeof item.title === 'string')
    );
  } catch {
    return [];
  }
}

function writeCachedListings(listings: MarketplaceListing[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const slim = listings.slice(0, INITIAL_LISTINGS_PAGE_SIZE).map((item) => {
      const firstImg = Array.isArray(item.images) && item.images[0] ? String(item.images[0]) : '';
      const safeCachedImg =
        firstImg.startsWith('https://') || (firstImg.startsWith('data:image/') && firstImg.length <= 24_000)
          ? [firstImg]
          : [];
      return {
        id: item.id,
        sellerId: item.sellerId,
        sellerName: item.sellerName,
        sellerUsername: item.sellerUsername,
        sellerVerified: item.sellerVerified,
        platform: item.platform,
        subcategory: item.subcategory,
        title: item.title,
        description: '',
        priceMinor: item.priceMinor,
        currency: item.currency,
        monetizationStatus: item.monetizationStatus,
        claimedOptions: item.claimedOptions.slice(0, 6),
        verifiedOptions: item.verifiedOptions.slice(0, 6),
        verificationState: item.verificationState,
        ageYears: item.ageYears,
        ageMonths: item.ageMonths,
        metricValue: item.metricValue,
        monthlyRevenueMinor: item.monthlyRevenueMinor,
        accountUrl: '',
        urlValidationStatus: item.urlValidationStatus,
        gameName: item.gameName,
        gameUid: item.gameUid,
        gameLevel: item.gameLevel,
        images: safeCachedImg,
        acceptedBidAmountMinor: item.acceptedBidAmountMinor,
        status: item.status,
        views: item.views,
        firstPublishedAtMs: item.firstPublishedAtMs,
        createdAtMs: item.createdAtMs,
      } satisfies MarketplaceListing;
    });

    while (slim.length > 0) {
      const json = JSON.stringify(slim);
      if (json.length <= LISTINGS_CACHE_MAX_BYTES) {
        window.localStorage.setItem(LISTINGS_CACHE_KEY, json);
        return;
      }
      slim.pop();
    }
    window.localStorage.removeItem(LISTINGS_CACHE_KEY);
  } catch {
    // Non-fatal if storage quota is restricted
  }
}

function mapDealDocument(id: string, dl: Record<string, unknown>): DealRecord {
  return {
    id,
    dealCode: dl.dealCode ? String(dl.dealCode) : undefined,
    listingId: String(dl.listingId || ''),
    listingTitle: String(dl.listingTitle || ''),
    platform: dl.platform as PlatformId,
    acceptedBidId: dl.acceptedBidId ? String(dl.acceptedBidId) : undefined,
    buyerId: String(dl.buyerId || ''),
    buyerName: String(dl.buyerName || ''),
    sellerId: String(dl.sellerId || ''),
    sellerName: String(dl.sellerName || ''),
    originalListingPriceMinor:
      dl.originalListingPriceMinor !== undefined ? Number(dl.originalListingPriceMinor) : undefined,
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
      dl.refundPlatformRetainedMinor !== undefined
        ? Number(dl.refundPlatformRetainedMinor)
        : undefined,
    currency: (dl.currency as CurrencyCode) || 'BDT',
    protectionDurationHours: Number(dl.protectionDurationHours || 40),
    confirmedAtMs: Number(dl.confirmedAtMs || 0),
    originalDeadlineMs: Number(dl.originalDeadlineMs || 0),
    unresolvedReportCount: Number(dl.unresolvedReportCount || 0),
    paymentLedgerId: dl.paymentLedgerId ? String(dl.paymentLedgerId) : undefined,
    paidAtMs: dl.paidAtMs ? Number(dl.paidAtMs) : undefined,
    transferSubmissionCount: dl.transferSubmissionCount
      ? Number(dl.transferSubmissionCount)
      : undefined,
    latestTransferSubmissionId: dl.latestTransferSubmissionId
      ? String(dl.latestTransferSubmissionId)
      : undefined,
    latestRejectionReason: dl.latestRejectionReason ? String(dl.latestRejectionReason) : undefined,
    refundLedgerId: dl.refundLedgerId ? String(dl.refundLedgerId) : undefined,
    settlementLedgerId: dl.settlementLedgerId ? String(dl.settlementLedgerId) : undefined,
    adminHoldNote: dl.adminHoldNote ? String(dl.adminHoldNote) : undefined,
    moderationPaused: Boolean(dl.moderationPaused),
    moderationPauseReason: dl.moderationPauseReason ? String(dl.moderationPauseReason) : undefined,
    settledAtMs: dl.settledAtMs ? Number(dl.settledAtMs) : undefined,
    refundedAtMs: dl.refundedAtMs ? Number(dl.refundedAtMs) : undefined,
    isDeleted: Boolean(dl.isDeleted),
    deletedAtMs: dl.deletedAtMs ? Number(dl.deletedAtMs) : undefined,
    deletedBy: dl.deletedBy ? String(dl.deletedBy) : undefined,
    deletionReason: dl.deletionReason ? String(dl.deletionReason) : undefined,
    status: dl.status as DealRecord['status'],
    createdAtMs: (dl.createdAt as { toMillis?: () => number })?.toMillis
      ? ldOrCreatedMillis(dl.createdAt)
      : Date.now(),
  };
}

function ldOrCreatedMillis(val: unknown): number {
  return (val as { toMillis: () => number }).toMillis();
}

export default function App() {
  // Persisted UI Preferences
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('bx_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [language, setLanguage] = useState<LanguageCode>(() => {
    const saved = localStorage.getItem('bx_lang') as LanguageCode | null;
    return saved && ['en', 'bn', 'hi', 'ar', 'ur'].includes(saved) ? saved : 'en';
  });
  const [currency, setCurrency] = useState<CurrencyCode>(() => {
    const saved = localStorage.getItem('bx_currency');
    return saved === 'USD' ? 'USD' : 'BDT';
  });

  // Full-Screen Website Route State & URL Synchronization
  const [route, setRoute] = useState<AppRouteState>(() =>
    parseRouteFromSearch(window.location.search, window.location.pathname)
  );
  const page: FullScreenPage = route.page;

  const [wpReturnSessionId, setWpReturnSessionId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return sanitizeRouteId(params.get('wp_session')) || null;
  });

  const [spReturnSessionId, setSpReturnSessionId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return sanitizeRouteId(params.get('sp_session')) || null;
  });

  const [spTopupSessionId, setSpTopupSessionId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return sanitizeRouteId(params.get('sp_topup_session')) || null;
  });

  const [spPaymentStatus, setSpPaymentStatus] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('payment_status') || null;
  });

  const [spTransactionId, setSpTransactionId] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return sanitizeRouteId(params.get('transaction_id') || params.get('transactionId')) || null;
  });

  const [pendingAuthIntent, setPendingAuthIntent] = useState<PendingAuthIntent | null>(() => {
    try {
      return deserializePendingAuthIntent(sessionStorage.getItem(PENDING_AUTH_INTENT_STORAGE_KEY));
    } catch {
      return null;
    }
  });
  const [resumedBidDraft, setResumedBidDraft] = useState<{
    listingId: string;
    amount: string;
  } | null>(null);
  const [walletReturnRoute, setWalletReturnRoute] = useState<{
    checkoutListingId?: string;
    checkoutDealId?: string;
  } | null>(null);

  const setAndPersistPendingIntent = useCallback((intent: PendingAuthIntent | null) => {
    setPendingAuthIntent(intent);
    try {
      const serialized = serializePendingAuthIntent(intent);
      if (serialized) {
        sessionStorage.setItem(PENDING_AUTH_INTENT_STORAGE_KEY, serialized);
      } else {
        sessionStorage.removeItem(PENDING_AUTH_INTENT_STORAGE_KEY);
      }
    } catch {
      // sessionStorage unavailable in restricted mode; React state still holds intent
    }
  }, []);

  const routeRef = useRef<AppRouteState>(route);
  const scrollMemoryRef = useRef<RouteScrollMemory>(new RouteScrollMemory(40));
  const listingCacheRef = useRef<NavigationDataCache<MarketplaceListing>>(
    new NavigationDataCache<MarketplaceListing>(45_000, 80)
  );

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  const navigateRoute = useCallback(
    (next: AppRouteState, opts?: { replace?: boolean; preserveScroll?: boolean }) => {
      if (typeof window !== 'undefined') {
        scrollMemoryRef.current.save(buildRouteScrollKey(routeRef.current), window.scrollY);
      }
      routeRef.current = next;
      setRoute(next);
      const targetPathname = resolveCanonicalPathnameForNavigation(window.location.pathname, next);
      const nextSearch =
        targetPathname !== '/' && next.page === 'info'
          ? ''
          : buildSearchForRoute(next, window.location.search);
      const nextUrl = `${targetPathname}${nextSearch}${window.location.hash}`;
      const curUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      if (nextUrl !== curUrl) {
        if (opts?.replace) {
          window.history.replaceState({}, document.title, nextUrl);
        } else {
          window.history.pushState({}, document.title, nextUrl);
        }
      }
      if (!opts?.preserveScroll) {
        window.scrollTo({ top: 0, behavior: 'auto' });
      }
    },
    []
  );

  const navigatePage = useCallback(
    (nextPage: FullScreenPage) => {
      if (nextPage !== 'wallet') {
        setWalletReturnRoute(null);
      }
      navigateRoute({ page: nextPage });
    },
    [navigateRoute]
  );

  const requireAuthWithIntent = useCallback(
    (intent: PendingAuthIntent, authMode: AuthScreenMode = 'login') => {
      setAndPersistPendingIntent(intent);
      navigateRoute({ page: 'auth', authMode });
    },
    [setAndPersistPendingIntent, navigateRoute]
  );

  const [authAction, setAuthAction] = useState<FirebaseAuthActionParams | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const oobCode = params.get('oobCode');
    if ((mode === 'verifyEmail' || mode === 'resetPassword') && oobCode) {
      return { mode, oobCode };
    }
    return null;
  });
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [pendingDeepLinkRaw, setPendingDeepLinkRaw] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('dest');
  });

  // Unlock HTML5 Audio playback on first user interaction in accordance with browser autoplay policy
  useEffect(() => {
    attachAudioUnlockListeners();
  }, []);

  // Sync browser Back/Forward history navigation & restore scroll positions
  useEffect(() => {
    const onPopState = () => {
      scrollMemoryRef.current.save(buildRouteScrollKey(routeRef.current), window.scrollY);
      const parsed = parseRouteFromSearch(window.location.search, window.location.pathname);
      routeRef.current = parsed;
      setRoute(parsed);
      const params = new URLSearchParams(window.location.search);
      setWpReturnSessionId(sanitizeRouteId(params.get('wp_session')) || null);
      const targetScrollY = scrollMemoryRef.current.get(buildRouteScrollKey(parsed));
      window.requestAnimationFrame(() => {
        window.scrollTo({ top: targetScrollY, behavior: 'auto' });
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Clean Firebase email action & notification deep-link query params from address bar once captured
  useEffect(() => {
    const url = new URL(window.location.href);
    let mutated = false;
    if (authAction) {
      url.searchParams.delete('mode');
      url.searchParams.delete('oobCode');
      url.searchParams.delete('apiKey');
      url.searchParams.delete('continueUrl');
      url.searchParams.delete('lang');
      mutated = true;
    }
    if (url.searchParams.has('dest')) {
      const normalizedSearch = buildSearchForRoute(route, '');
      window.history.replaceState({}, document.title, url.pathname + normalizedSearch + url.hash);
      return;
    }
    if (mutated) {
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    }
  }, [authAction, route]);

  // Toast Notification
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const showFlash = useCallback((msg: string) => {
    setToastMsg(msg);
  }, []);

  useEffect(() => {
    if (!toastMsg) return;
    const id = window.setTimeout(() => setToastMsg(null), 4200);
    return () => window.clearTimeout(id);
  }, [toastMsg]);

  // Apply Theme & RTL Direction
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('bx_theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('dir', isRtlLanguage(language) ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', language);
    localStorage.setItem('bx_lang', language);
  }, [language]);

  useEffect(() => {
    localStorage.setItem('bx_currency', currency);
  }, [currency]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => (prev === 'light' ? 'dark' : 'light'));
  }, []);

  // Auth & User State
  const [cachedUser, setCachedUser] = useState<CachedUser | null>(() => readCachedUser());
  const [hasFbAuthKey, setHasFbAuthKey] = useState<boolean>(() => hasFirebaseAuthUserKey());
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profileBootstrapped, setProfileBootstrapped] = useState(false);
  const [authTokenEpoch, setAuthTokenEpoch] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [privateUser, setPrivateUser] = useState<PrivateUser | null>(null);
  const [adminRole, setAdminRole] = useState<'none' | 'admin' | 'superadmin'>('none');
  const [adminRoleStatus, setAdminRoleStatus] = useState<'idle' | 'checking' | 'resolved' | 'error'>('idle');
  const [adminRoleError, setAdminRoleError] = useState<string | null>(null);
  const [adminAccessRetryEpoch, setAdminAccessRetryEpoch] = useState(0);
  const [pendingAdminInvitation, setPendingAdminInvitation] = useState<AdminInvitationRecord | null>(null);

  // Public & Authenticated Data State
  const [settings, setSettings] = useState<PublicSettings>(DEFAULT_PUBLIC_SETTINGS);
  const [listingLimit, setListingLimit] = useState<number>(INITIAL_LISTINGS_PAGE_SIZE);
  const [activeListings, setActiveListings] = useState<MarketplaceListing[]>(() =>
    readCachedListings()
  );
  const [listingsHydrated, setListingsHydrated] = useState(false);
  const [myListings, setMyListings] = useState<MarketplaceListing[]>([]);
  const [myBids, setMyBids] = useState<BidRecord[]>([]);
  const [favorites, setFavorites] = useState<FavoriteRecord[]>([]);
  const [followedSellers, setFollowedSellers] = useState<SellerFollowRecord[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [deals, setDeals] = useState<DealRecord[]>([]);
  const [deposits, setDeposits] = useState<DepositRequestRecord[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequestRecord[]>([]);
  const [publicActivities, setPublicActivities] = useState<PublicActivityItem[]>([]);
  const [recentSearches, setRecentSearches] = useState<RecentSearchRecord[]>(() =>
    loadGuestRecentSearches()
  );
  const [personalNotifications, setPersonalNotifications] = useState<NotificationRecord[]>([]);
  const [activeAnnouncements, setActiveAnnouncements] = useState<AnnouncementRecord[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notifReloadEpoch, setNotifReloadEpoch] = useState(0);
  const [notifOpenSignal, setNotifOpenSignal] = useState(0);
  const [announcementReadEpoch, setAnnouncementReadEpoch] = useState(0);
  const [dismissedNotifEpoch, setDismissedNotifEpoch] = useState(0);
  const [notificationPrefs, setNotificationPrefs] = useState<UserNotificationPreferences>(() =>
    loadLocalNotificationPreferences(null)
  );
  const notificationPrefsRef = useRef<UserNotificationPreferences>(notificationPrefs);
  const arrivalTrackerRef = useRef<NotificationArrivalTracker>(new NotificationArrivalTracker());
  const [isOffline, setIsOffline] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [justReconnected, setJustReconnected] = useState(false);
  const wasOfflineRef = useRef<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  const [deferredSubsReady, setDeferredSubsReady] = useState<boolean>(() =>
    doesRouteRequireImmediateSecondarySubs(route.page)
  );

  useEffect(() => {
    notificationPrefsRef.current = notificationPrefs;
  }, [notificationPrefs]);

  useEffect(() => {
    setNotificationPrefs(loadLocalNotificationPreferences(fbUser?.uid ?? null));
  }, [fbUser?.uid]);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [draftFilters, setDraftFilters] = useState<MarketplaceFilterState>(() =>
    route.platformFilter ? { ...EMPTY_FILTERS, platform: route.platformFilter } : EMPTY_FILTERS
  );
  const [appliedFilters, setAppliedFilters] = useState<MarketplaceFilterState>(() =>
    route.platformFilter ? { ...EMPTY_FILTERS, platform: route.platformFilter } : EMPTY_FILTERS
  );

  // On-demand direct-URL / deep-link entity state
  const [fetchedListing, setFetchedListing] = useState<MarketplaceListing | null>(null);
  const [loadingTargetListing, setLoadingTargetListing] = useState(false);
  const [listingSellerFollowerCount, setListingSellerFollowerCount] = useState<number | undefined>(
    undefined
  );
  const [fetchedDeal, setFetchedDeal] = useState<DealRecord | null>(null);
  const [loadingTargetDeal, setLoadingTargetDeal] = useState(false);

  const isBusyModal = Boolean(authAction || (page !== 'home' && page !== 'market'));
  const pwa = usePWAInstall(isBusyModal);

  // Auth Capability & Session Continuity State
  const [authCaps, setAuthCaps] = useState<FirebaseAuthCapabilities | null>(null);
  const [reconnectingSession, setReconnectingSession] = useState(false);
  const [sessionExtendPromptVisible, setSessionExtendPromptVisible] = useState(false);
  const [tokenBannerDismissed, setTokenBannerDismissed] = useState(false);
  const [staleSessionNotice, setStaleSessionNotice] = useState<string | null>(null);
  const [emailBannerDismissed, setEmailBannerDismissed] = useState(false);
  const [verifyCooldownSec, setVerifyCooldownSec] = useState(0);
  const [sendingBannerVerify, setSendingBannerVerify] = useState(false);
  const [checkingBannerVerify, setCheckingBannerVerify] = useState(false);

  // 24/7 Trust & Safety Account Standing, Reporting & Appeals State
  const [reportModalTarget, setReportModalTarget] = useState<ReportModalTarget | null>(null);
  const [safetyAppealsModalOpen, setSafetyAppealsModalOpen] = useState(false);
  const [firestoreRestriction, setFirestoreRestriction] = useState<UserRestrictionRecord | null>(null);
  const [moderationStatus, setModerationStatus] = useState<MyModerationStatusResponse | null>(null);
  const [walletInitialMode, setWalletInitialMode] = useState<'deposit' | 'withdraw' | 'history'>('deposit');

  const refreshModerationStatus = useCallback(async () => {
    if (!auth.currentUser) return;
    try {
      const res = await fetchMyModerationStatus();
      setModerationStatus(res);
    } catch {
      // Non-blocking fallback to live Firestore userRestrictions snapshot
    }
  }, []);

  useEffect(() => {
    if (verifyCooldownSec <= 0) return;
    const tId = window.setInterval(() => {
      setVerifyCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(tId);
  }, [verifyCooldownSec]);

  useEffect(() => {
    let reconnectTimer: number | null = null;
    const onOnline = () => {
      setIsOffline(false);
      void enableNetwork(db).catch(() => {});
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        setJustReconnected(true);
        if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
        reconnectTimer = window.setTimeout(() => {
          setJustReconnected(false);
        }, 3500);
      }
    };
    const onOffline = () => {
      wasOfflineRef.current = true;
      setIsOffline(true);
      setJustReconnected(false);
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    };
  }, []);

  useEffect(() => {
    if (!fbUser || signingOut) {
      setDeferredSubsReady(doesRouteRequireImmediateSecondarySubs(page));
      return;
    }
    if (doesRouteRequireImmediateSecondarySubs(page)) {
      setDeferredSubsReady(true);
      return;
    }
    if (deferredSubsReady) return;

    const winWithIdle = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const enableSecondary = () => setDeferredSubsReady(true);
    if (typeof winWithIdle.requestIdleCallback === 'function') {
      idleId = winWithIdle.requestIdleCallback(enableSecondary, { timeout: 800 });
    } else {
      timeoutId = window.setTimeout(enableSecondary, 800);
    }
    return () => {
      if (idleId !== null && typeof winWithIdle.cancelIdleCallback === 'function') {
        winWithIdle.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [fbUser?.uid, signingOut, page, deferredSubsReady]);

  useEffect(() => {
    if (!fbUser || !profileBootstrapped || signingOut) return;
    const winWithIdle = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const runInitialPushSync = () => {
      void syncActiveWebPushTokenForSession(fbUser.uid, settings.fcmVapidPublicKey);
    };
    if (typeof winWithIdle.requestIdleCallback === 'function') {
      idleId = winWithIdle.requestIdleCallback(runInitialPushSync, { timeout: 3000 });
    } else {
      timeoutId = window.setTimeout(runInitialPushSync, 3000);
    }
    const onWindowFocusOrVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void syncActiveWebPushTokenForSession(fbUser.uid, settings.fcmVapidPublicKey);
      }
    };
    window.addEventListener('focus', onWindowFocusOrVisible);
    document.addEventListener('visibilitychange', onWindowFocusOrVisible);
    const unsubFg = subscribeForegroundPushMessages((payload) => {
      // If payload carries a Firestore notificationId, the live `/notifications` onSnapshot
      // listener + NotificationArrivalTracker already updates the bell badge and plays the
      // exact chime/vibration once — skip duplicate foreground toast & sound here.
      if (payload?.data?.notificationId) {
        return;
      }
      const title = payload?.notification?.title || payload?.data?.title || 'New BEXORA Notification';
      showFlash(title);
      const kind = payload?.data?.alertKind === 'deal_room_created' ? 'deal_room_created' : 'normal';
      void dispatchForegroundNotificationAlert(kind, notificationPrefsRef.current);
    }, settings.fcmVapidPublicKey);
    return () => {
      if (idleId !== null && typeof winWithIdle.cancelIdleCallback === 'function') {
        winWithIdle.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener('focus', onWindowFocusOrVisible);
      document.removeEventListener('visibilitychange', onWindowFocusOrVisible);
      unsubFg();
    };
  }, [fbUser, profileBootstrapped, signingOut, settings.fcmVapidPublicKey, showFlash]);

  const [idleUiReady, setIdleUiReady] = useState(false);
  const prefetchAuthModal = useCallback(() => {
    void import('./components/AuthModal');
  }, []);

  useEffect(() => {
    const winWithIdle = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const activateIdleUi = () => {
      setIdleUiReady(true);
      prefetchAuthModal();
    };
    if (typeof winWithIdle.requestIdleCallback === 'function') {
      idleId = winWithIdle.requestIdleCallback(activateIdleUi, { timeout: 2500 });
    } else {
      timeoutId = window.setTimeout(activateIdleUi, 2500);
    }
    return () => {
      if (idleId !== null && typeof winWithIdle.cancelIdleCallback === 'function') {
        winWithIdle.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [prefetchAuthModal]);

  // Defer real-time presence tracking until after first paint (logged-in users only)
  const [presenceReady, setPresenceReady] = useState(false);
  useEffect(() => {
    if (!fbUser || signingOut) {
      setPresenceReady(false);
      return;
    }
    const winWithIdle = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    const activate = () => setPresenceReady(true);
    if (typeof winWithIdle.requestIdleCallback === 'function') {
      idleId = winWithIdle.requestIdleCallback(activate, { timeout: 3000 });
    } else {
      timeoutId = window.setTimeout(activate, 3000);
    }
    return () => {
      if (idleId !== null && typeof winWithIdle.cancelIdleCallback === 'function') {
        winWithIdle.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [fbUser?.uid, signingOut]);

  usePresence(presenceReady && fbUser && !signingOut ? fbUser.uid : null);
  useEffect(() => {
    if (!presenceReady || !fbUser || signingOut) return;
    const unsubPresence = initializeUserPresenceSession(fbUser.uid);
    return () => {
      unsubPresence();
    };
  }, [presenceReady, fbUser?.uid, signingOut]);

  const handleReconnectSession = useCallback(async () => {
    setReconnectingSession(true);
    try {
      const outcome = await extendCurrentUserSessionInteractive();
      if (outcome === 'renewed') {
        setSessionExtendPromptVisible(false);
        setStaleSessionNotice(null);
        setTokenBannerDismissed(false);
        setAuthTokenEpoch((n) => n + 1);
        showFlash('Session renewed for another 60 minutes!');
      } else {
        navigateRoute({ page: 'auth', authMode: 'login' });
      }
    } catch (err) {
      showFlash(formatFirebaseAuthError(err));
    } finally {
      setReconnectingSession(false);
    }
  }, [showFlash, navigateRoute]);

  // Public Firestore Listeners (Immediate) & Deferred Idle Diagnostics
  useEffect(() => {
    let cancelled = false;

    const unsubSettings = onSnapshot(
      doc(db, 'publicConfig', 'settings'),
      (snap) => {
        if (snap.exists()) {
          const d = snap.data();
          setSettings({
            buyerFeeEnabled: d.buyerFeeEnabled !== undefined ? Boolean(d.buyerFeeEnabled) : true,
            buyerFeePct: Number(d.buyerFeePct ?? 5),
            sellerFeeEnabled: Boolean(d.sellerFeeEnabled),
            sellerFeePct: Number(d.sellerFeePct ?? 0),
            usdToBdtRate: Number(d.usdToBdtRate ?? d.usdtToBdtRate ?? DEFAULT_PUBLIC_SETTINGS.usdToBdtRate),
            usdtToBdtRate: Number(d.usdtToBdtRate ?? d.usdToBdtRate ?? DEFAULT_PUBLIC_SETTINGS.usdToBdtRate),
            activeCountryCode: String(d.activeCountryCode ?? 'BD'),
            countryRates: d.countryRates && typeof d.countryRates === 'object' ? d.countryRates : DEFAULT_PUBLIC_SETTINGS.countryRates,
            withdrawalMethods: Array.isArray(d.withdrawalMethods) ? d.withdrawalMethods : DEFAULT_PUBLIC_SETTINGS.withdrawalMethods,
            manualPaymentConfig: Array.isArray(d.manualPaymentConfig) ? d.manualPaymentConfig : DEFAULT_PUBLIC_SETTINGS.manualPaymentConfig,
            gatewayPaymentMethods: normalizeGatewayPaymentMethods(d.gatewayPaymentMethods),
            supportWhatsapp: String(d.supportWhatsapp ?? ''),
            supportTelegram: String(d.supportTelegram ?? ''),
            supportEmail: String(d.supportEmail ?? ''),
            bkashNumber: String(d.bkashNumber ?? ''),
            nagadNumber: String(d.nagadNumber ?? ''),
            rocketNumber: String(d.rocketNumber ?? ''),
            aiEmergencyStop: Boolean(d.aiEmergencyStop),
            disabledMonetizationIds: Array.isArray(d.disabledMonetizationIds) ? d.disabledMonetizationIds : [],
            gamingTitles:
              Array.isArray(d.gamingTitles) && d.gamingTitles.length > 0
                ? d.gamingTitles
                : DEFAULT_PUBLIC_SETTINGS.gamingTitles,
            protectionHoursYoutube: Number(d.protectionHoursYoutube ?? 168),
            protectionHoursFacebook: Number(d.protectionHoursFacebook ?? 40),
            protectionHoursDefault: Number(d.protectionHoursDefault ?? 40),
            customProtectionWindowsEnabled: Boolean(d.customProtectionWindowsEnabled),
            fcmVapidPublicKey: d.fcmVapidPublicKey ? String(d.fcmVapidPublicKey) : '',
            wordpressPaymentEnabled: Boolean(d.wordpressPaymentEnabled),
            wordpressSiteUrl: d.wordpressSiteUrl ? String(d.wordpressSiteUrl) : '',
            wordpressBridgeEndpoint: d.wordpressBridgeEndpoint
              ? String(d.wordpressBridgeEndpoint)
              : '/wp-json/bexora/v1',
            siteName: d.siteName ? String(d.siteName) : 'BEXORA',
            brandTagline: d.brandTagline
              ? String(d.brandTagline)
              : 'Buy & Sell Verifiable Digital Assets',
            logoUrl: d.logoUrl ? String(d.logoUrl) : '',
            noticeBannerEnabled: Boolean(d.noticeBannerEnabled),
            noticeBannerText: d.noticeBannerText ? String(d.noticeBannerText) : '',
            enabledLanguages:
              Array.isArray(d.enabledLanguages) && d.enabledLanguages.length > 0
                ? (d.enabledLanguages as LanguageCode[])
                : DEFAULT_PUBLIC_SETTINGS.enabledLanguages,
          });
          setRuntimeFallbackVapidPublicKey(d.fcmVapidPublicKey ? String(d.fcmVapidPublicKey) : '');
        }
      },
      (err) => {
        if (isTokenServiceDisabledError(err)) {
          void recoverFirestoreFromTokenServiceError();
        }
      }
    );

    const unsubAnnouncements = onSnapshot(
      query(collection(db, 'announcements'), where('active', '==', true), limit(30)),
      (snap) => {
        const items: AnnouncementRecord[] = snap.docs
          .map((docSnap) => {
            const ad = docSnap.data();
            return {
              id: docSnap.id,
              title: String(ad.title || ''),
              preview: String(ad.preview || ad.title || ''),
              body: String(ad.body || ''),
              severity: (ad.severity || 'info') as AnnouncementRecord['severity'],
              destination: String(ad.destination || ''),
              active: Boolean(ad.active),
              authorId: String(ad.authorId || ''),
              createdAtMs: Number(
                ad.createdAtMs || (ad.createdAt?.toMillis ? ad.createdAt.toMillis() : Date.now())
              ),
            };
          })
          .sort((a, b) => b.createdAtMs - a.createdAtMs);
        setActiveAnnouncements(items);
      },
      () => {
        // Non-fatal if offline
      }
    );

    const runIdleChecks = () => {
      if (cancelled) return;
      void detectFirebaseAuthCapabilities().then((caps) => {
        if (!cancelled) setAuthCaps(caps);
      });
      void prepareFirestoreAuthSession().then(() => {
        if (cancelled) return;
        const clearedMsg = consumeStaleTokenSessionClearedNotice();
        if (clearedMsg && !auth.currentUser) {
          setStaleSessionNotice(clearedMsg);
        }
      });
      void testFirestoreConnection();
    };

    const winWithIdle = window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
      cancelIdleCallback?: (id: number) => void;
    };
    let idleId: number | null = null;
    let timeoutId: number | null = null;
    if (typeof winWithIdle.requestIdleCallback === 'function') {
      idleId = winWithIdle.requestIdleCallback(runIdleChecks, { timeout: 3000 });
    } else {
      timeoutId = window.setTimeout(runIdleChecks, 3000);
    }

    return () => {
      cancelled = true;
      unsubSettings();
      unsubAnnouncements();
      if (idleId !== null && typeof winWithIdle.cancelIdleCallback === 'function') {
        winWithIdle.cancelIdleCallback(idleId);
      }
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  // Paginated Public Active Listings Listener (Immediate, 24 per page)
  const expiredReservationPingedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const unsubListings = onSnapshot(
      query(
        collection(db, 'listings'),
        where('status', 'in', ['active', 'reserved']),
        limit(listingLimit)
      ),
      (snap) => {
        const list: MarketplaceListing[] = snap.docs.map((docSnap) =>
          mapListingDocument(docSnap.id, docSnap.data())
        );
        list.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setActiveListings(list);
        setListingsHydrated(true);
        writeCachedListings(list);

        // Lazily release expired 15-minute checkout reservations back to active
        const now = Date.now();
        for (const item of list) {
          if (item.status === 'reserved' && !item.activeDealId) {
            const expMs = getListingReservationExpiryMs(item);
            if (expMs > 0 && now >= expMs) {
              const key = `${item.id}:${expMs}`;
              if (!expiredReservationPingedRef.current.has(key)) {
                expiredReservationPingedRef.current.add(key);
                void fetch(
                  buildApiUrl(`/api/listings/${encodeURIComponent(item.id)}/expire-reservation`),
                  { method: 'POST' }
                ).catch(() => {});
              }
            }
          }
        }
      },
      (err) => {
        setListingsHydrated(true);
        if (isTokenServiceDisabledError(err)) {
          void recoverFirestoreFromTokenServiceError();
          return;
        }
        console.error('Active listings subscription error:', err);
      }
    );
    return () => unsubListings();
  }, [listingLimit]);

  // Auth Session Listener & Non-Blocking Background Profile Initialization
  useEffect(() => {
    let active = true;
    const unsubAuth = onAuthStateChanged(auth, (u) => {
      if (!u) {
        const shouldCheckRedirect = shouldCheckAuthRedirectResult();
        if (shouldCheckRedirect) {
          void (async () => {
            const redirectedUser = await consumePendingAuthRedirectResult();
            if (!active) return;
            if (redirectedUser || auth.currentUser) {
              return;
            }
            if (hasPendingRecoverableSession()) {
              const caps = await detectFirebaseAuthCapabilities();
              if (!active) return;
              if (caps.tokenServiceStatus === 'disabled') {
                await prepareFirestoreAuthSession();
                if (!active) return;
                if (auth.currentUser) {
                  return;
                }
              }
              const fallbackMsg = consumeStaleTokenSessionClearedNotice();
              if (fallbackMsg) {
                setStaleSessionNotice(fallbackMsg);
              }
            }
            clearCachedUser();
            setCachedUser(null);
            setHasFbAuthKey(false);
            arrivalTrackerRef.current.reset();
            setProfileBootstrapped(false);
            setFbUser(null);
            setAuthReady(true);
            setProfile(null);
            setPrivateUser(null);
            setAdminRole('none');
            setAdminRoleStatus('idle');
            setAdminRoleError(null);
            setPendingAdminInvitation(null);
            setMyListings([]);
            setMyBids([]);
            setFavorites([]);
            setFollowedSellers([]);
            setConversations([]);
            setDeals([]);
            setDeposits([]);
            setWithdrawals([]);
            setPersonalNotifications([]);
            setNotificationsLoading(false);
            setNotificationsError(null);
            setFirestoreRestriction(null);
            setModerationStatus(null);
          })();
          return;
        }

        clearCachedUser();
        setCachedUser(null);
        setHasFbAuthKey(false);
        arrivalTrackerRef.current.reset();
        setProfileBootstrapped(false);
        setFbUser(null);
        setAuthReady(true);
        setProfile(null);
        setPrivateUser(null);
        setAdminRole('none');
        setAdminRoleStatus('idle');
        setAdminRoleError(null);
        setPendingAdminInvitation(null);
        setMyListings([]);
        setMyBids([]);
        setFavorites([]);
        setFollowedSellers([]);
        setConversations([]);
        setDeals([]);
        setDeposits([]);
        setWithdrawals([]);
        setPersonalNotifications([]);
        setNotificationsLoading(false);
        setNotificationsError(null);
        setFirestoreRestriction(null);
        setModerationStatus(null);
        return;
      }

      // Immediately confirm auth state so UI & listeners never block on token/profile network checks
      markAuthenticatedSessionActive(u);
      setHasFbAuthKey(true);
      setStaleSessionNotice(null);
      setSessionExtendPromptVisible(false);
      setFbUser(u);
      setAuthReady(true);
      syncProactiveRefreshWithCapabilities(u, authCaps?.tokenServiceStatus);

      void Promise.allSettled([
        getValidFirebaseIdToken(false),
        ensureUserProfileInitialized(u),
      ]).then((results) => {
        if (!active) return;
        const profileResult = results[1];
        if (profileResult.status === 'rejected') {
          console.warn('Profile bootstrap notice:', profileResult.reason);
        }
        if (!auth.currentUser) {
          clearCachedUser();
          setCachedUser(null);
          setHasFbAuthKey(false);
          const fallbackMsg = consumeStaleTokenSessionClearedNotice();
          if (fallbackMsg) {
            setStaleSessionNotice(fallbackMsg);
            setTokenBannerDismissed(false);
          }
          setFbUser(null);
          setProfileBootstrapped(false);
          return;
        }
        setProfileBootstrapped(true);
      });
    });

    return () => {
      active = false;
      unsubAuth();
    };
  }, []);

  // Persistent Session Wake & Network Continuity:
  // Keeps users signed in permanently across multi-hour/multi-day sleep, tab backgrounding, and Wi-Fi reconnects
  // by refreshing expired 60-minute ID tokens via `browserLocalPersistence` without ever forcing automatic logout.
  useEffect(() => {
    if (!fbUser || signingOut) return;
    let cancelled = false;
    let wakeRefreshBusy = false;
    let lastWakeRefreshAt = 0;

    const refreshTokenSilentlyOnWake = async () => {
      const now = Date.now();
      if (cancelled || wakeRefreshBusy || !auth.currentUser) return;
      if (now - lastWakeRefreshAt < 60_000) return; // Throttle to at most once per minute
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      wakeRefreshBusy = true;
      lastWakeRefreshAt = now;
      try {
        syncProactiveRefreshWithCapabilities(auth.currentUser, authCaps?.tokenServiceStatus);
        const token = await getValidFirebaseIdToken(false);
        if (cancelled) return;
        if (token && auth.currentUser) {
          setSessionExtendPromptVisible(false);
          setStaleSessionNotice(null);
        } else if (!auth.currentUser) {
          const msg = consumeStaleTokenSessionClearedNotice();
          if (msg) {
            setStaleSessionNotice(msg);
            setTokenBannerDismissed(false);
          }
        } else if (authCaps?.tokenServiceStatus === 'disabled' && auth.currentUser) {
          await attemptSilentGoogleSessionRefresh(auth.currentUser);
        }
      } finally {
        wakeRefreshBusy = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshTokenSilentlyOnWake();
      }
    };
    const onWindowFocus = () => {
      void refreshTokenSilentlyOnWake();
    };
    const onBrowserOnline = () => {
      void refreshTokenSilentlyOnWake();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('online', onBrowserOnline);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onWindowFocus);
      window.removeEventListener('online', onBrowserOnline);
    };
  }, [fbUser, signingOut, authCaps?.tokenServiceStatus]);

  const handleRefreshAuthToken = useCallback(async () => {
    if (!auth.currentUser) return;
    await safeRefreshCurrentUserToken();
    setFbUser(auth.currentUser);
    setAuthTokenEpoch((n) => n + 1);
  }, []);

  const handleBannerSendVerificationEmail = useCallback(async () => {
    if (!auth.currentUser || verifyCooldownSec > 0) return;
    setSendingBannerVerify(true);
    try {
      await safeSendEmailVerification(auth.currentUser);
      setVerifyCooldownSec(60);
      showFlash(
        `Verification link sent to ${auth.currentUser.email || 'your email'}! Check your inbox and Spam folder.`
      );
    } catch (err) {
      showFlash(formatFirebaseAuthError(err));
    } finally {
      setSendingBannerVerify(false);
    }
  }, [verifyCooldownSec, showFlash]);

  const handleBannerCheckVerificationStatus = useCallback(async () => {
    if (!auth.currentUser) return;
    setCheckingBannerVerify(true);
    try {
      const res = await safeRefreshCurrentUserToken();
      setFbUser(auth.currentUser);
      setAuthTokenEpoch((n) => n + 1);
      if (!res.emailVerified) {
        showFlash('Email is not verified yet. Open the verification link sent to your inbox first.');
        return;
      }
      if (res.tokenRefreshed) {
        try {
          await updateDoc(doc(db, 'privateUsers', auth.currentUser.uid), {
            emailVerified: true,
            updatedAt: serverTimestamp(),
          });
        } catch {
          // Non-fatal if profile doc not yet ready
        }
      }
      await emitUserNotification({
        recipientId: auth.currentUser.uid,
        eventKey: 'email_verified_confirmed',
        category: 'verification',
        severity: 'success',
        title: 'Email Address Verified',
        preview: 'Your email address is verified via Firebase Authentication.',
        body: `Your BEXORA account email (${auth.currentUser.email || 'primary email'}) is verified.`,
        refType: 'profile',
        refId: auth.currentUser.uid,
        referenceLabel: auth.currentUser.email || 'Account Email',
        destination: 'profile',
      });
      setEmailBannerDismissed(true);
      showFlash(
        res.tokenServiceBlocked
          ? 'Email verified! Sign out and back in once to refresh your verified session token.'
          : 'Email verified and session token refreshed!'
      );
    } catch (err) {
      showFlash(formatFirebaseAuthError(err));
    } finally {
      setCheckingBannerVerify(false);
    }
  }, [showFlash]);

  // Dedicated Admin Access Verification + Pending Admin Invitation Listener
  useEffect(() => {
    if (!fbUser || signingOut) {
      setAdminRole('none');
      setAdminRoleStatus('idle');
      setAdminRoleError(null);
      setPendingAdminInvitation(null);
      return;
    }

    let active = true;
    const uid = fbUser.uid;
    const isBootstrapped =
      Boolean(fbUser.emailVerified) &&
      fbUser.email?.toLowerCase() === BOOTSTRAPPED_SUPERADMIN_EMAIL.toLowerCase();

    setAdminRoleError(null);
    if (isBootstrapped) {
      setAdminRole('superadmin');
      setAdminRoleStatus('resolved');
    } else {
      setAdminRoleStatus('checking');
    }

    const unsubs: (() => void)[] = [];

    if (!isBootstrapped) {
      unsubs.push(
        onSnapshot(
          doc(db, 'admins', uid),
          (snap) => {
            if (!active) return;
            if (snap.exists()) {
              setAdminRole(snap.data().role === 'superadmin' ? 'superadmin' : 'admin');
            } else {
              setAdminRole('none');
            }
            setAdminRoleStatus('resolved');
            setAdminRoleError(null);
          },
          () => {
            void (async () => {
              try {
                const { ok, status, json } = await dedupedRequest(
                  `GET:/api/admin/access:${uid}`,
                  async () => {
                    const resp = await fetchWithFreshBearerToken('/api/admin/access');
                    const parsed = (await resp.json().catch(() => null)) as {
                      ok?: boolean;
                      isAdmin?: boolean;
                      role?: 'none' | 'admin' | 'superadmin';
                      error?: string;
                    } | null;
                    return { ok: resp.ok, status: resp.status, json: parsed };
                  }
                );
                if (!active) return;
                if (ok && json?.ok) {
                  setAdminRole(
                    json.role === 'superadmin'
                      ? 'superadmin'
                      : json.role === 'admin' || json.isAdmin
                      ? 'admin'
                      : 'none'
                  );
                  setAdminRoleStatus('resolved');
                  setAdminRoleError(null);
                } else {
                  setAdminRole('none');
                  setAdminRoleStatus('error');
                  setAdminRoleError(
                    json?.error || `Could not verify administrator permissions (${status}).`
                  );
                }
              } catch (err) {
                if (!active) return;
                setAdminRole('none');
                setAdminRoleStatus('error');
                setAdminRoleError(
                  err instanceof Error
                    ? err.message
                    : 'Network error verifying administrator permissions.'
                );
              }
            })();
          }
        )
      );
    }

    unsubs.push(
      onSnapshot(
        doc(db, 'adminInvitations', `inv_${uid}`),
        (snap) => {
          if (!active) return;
          if (!snap.exists()) {
            setPendingAdminInvitation(null);
            return;
          }
          const d = snap.data();
          if (d.status !== 'pending') {
            setPendingAdminInvitation(null);
            return;
          }
          setPendingAdminInvitation({
            id: snap.id,
            targetUid: String(d.targetUid || uid),
            targetName: d.targetName ? String(d.targetName) : undefined,
            targetEmail: d.targetEmail ? String(d.targetEmail) : undefined,
            role: d.role === 'superadmin' ? 'superadmin' : 'admin',
            permissions: Array.isArray(d.permissions)
              ? d.permissions.map((p: unknown) => String(p))
              : [],
            status: 'pending',
            invitedBy: String(d.invitedBy || ''),
            invitedByName: d.invitedByName ? String(d.invitedByName) : undefined,
            createdAtMs: Number(
              d.createdAtMs || (d.createdAt?.toMillis ? d.createdAt.toMillis() : Date.now())
            ),
          });
        },
        () => {
          if (active) setPendingAdminInvitation(null);
        }
      )
    );

    return () => {
      active = false;
      unsubs.forEach((u) => u());
    };
  }, [fbUser?.uid, fbUser?.email, fbUser?.emailVerified, signingOut, adminAccessRetryEpoch]);

  // Authenticated User Real-Time Subscriptions (start immediately once fbUser exists; detached cleanly on logout)
  useEffect(() => {
    if (!fbUser || signingOut) return;
    const uid = fbUser.uid;
    const unsubs: (() => void)[] = [];

    unsubs.push(
      onSnapshot(
        doc(db, 'publicProfiles', uid),
        (snap) => {
          if (snap.exists()) {
            const d = snap.data();
            const nextProfile: PublicProfile = {
              uid: d.uid,
              displayName: d.displayName,
              username: d.username,
              bio: d.bio || '',
              avatarUrl: d.avatarUrl,
              coverUrl: d.coverUrl,
              location: d.location,
              nidVerified: Boolean(d.nidVerified),
              completedTrader: Boolean(d.completedTrader),
              completedSales: Number(d.completedSales || 0),
              completedPurchases: Number(d.completedPurchases || 0),
              ratingSum: Number(d.ratingSum || 0),
              ratingCount: Number(d.ratingCount || 0),
              followerCount:
                typeof d.followerCount === 'number' && Number.isFinite(d.followerCount)
                  ? Math.max(0, Math.floor(d.followerCount))
                  : 0,
              hidePublicActivityName: Boolean(d.hidePublicActivityName),
            };
            setProfile(nextProfile);
            writeCachedUser(nextProfile);
            setCachedUser({
              uid: String(nextProfile.uid || uid),
              displayName: String(nextProfile.displayName || ''),
              username: String(nextProfile.username || ''),
              avatarUrl: String(nextProfile.avatarUrl || ''),
            });
          }
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        doc(db, 'privateUsers', uid),
        (snap) => {
          if (snap.exists()) {
            const d = snap.data();
            const syncedPrefs = d.notificationPrefs
              ? normalizeNotificationPreferences(d.notificationPrefs)
              : undefined;
            if (syncedPrefs) {
              saveLocalNotificationPreferences(uid, syncedPrefs);
              setNotificationPrefs(syncedPrefs);
            }
            setPrivateUser({
              uid: d.uid,
              email: d.email || '',
              phone: d.phone || '',
              phoneCountryCode: d.phoneCountryCode ? String(d.phoneCountryCode) : undefined,
              phoneFormatValidated: Boolean(d.phoneFormatValidated || d.phone),
              emailVerified: Boolean(d.emailVerified),
              phoneVerified: Boolean(d.phoneVerified),
              nidStatus: d.nidStatus || 'not_verified',
              nidRejectionReason: d.nidRejectionReason,
              walletBalanceMinor: Number(d.walletBalanceMinor || 0),
              reservedBalanceMinor: Number(d.reservedBalanceMinor || 0),
              notificationPrefs: syncedPrefs,
            });
          }
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        doc(db, 'userRestrictions', uid),
        (snap) => {
          if (snap.exists()) {
            const rd = snap.data() as UserRestrictionRecord;
            setFirestoreRestriction({ ...rd, userId: uid });
            void refreshModerationStatus();
          } else {
            setFirestoreRestriction(null);
          }
        },
        () => {}
      )
    );
    void refreshModerationStatus();

    unsubs.push(
      onSnapshot(
        query(collection(db, 'privateUsers', uid, 'recentSearches'), limit(25)),
        (snap) => {
          const loaded: RecentSearchRecord[] = [];
          for (const d of snap.docs) {
            const sd = d.data();
            const rec = createRecentSearchRecord(
              {
                query: typeof sd.query === 'string' ? sd.query : '',
                platform: typeof sd.platform === 'string' ? (sd.platform as PlatformId) : '',
                subcategory: typeof sd.subcategory === 'string' ? sd.subcategory : '',
                monetization: typeof sd.monetization === 'string' ? sd.monetization : 'all',
                verifiedOnly: Boolean(sd.verifiedOnly),
                sortBy: typeof sd.sortBy === 'string' ? sd.sortBy : 'newest',
              },
              Number(sd.searchedAtMs) > 0 ? Number(sd.searchedAtMs) : Date.now()
            );
            if (rec) {
              loaded.push({ ...rec, id: d.id });
            }
          }
          loaded.sort((a, b) => b.searchedAtMs - a.searchedAtMs);
          setRecentSearches(loaded.slice(0, MAX_RECENT_SEARCHES));
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'favorites'), where('userId', '==', uid), limit(120)),
        (snap) => {
          const list: FavoriteRecord[] = snap.docs.map((docSnap) => {
            const fd = docSnap.data();
            return {
              id: docSnap.id,
              userId: String(fd.userId || ''),
              listingId: String(fd.listingId || ''),
              sellerId: String(fd.sellerId || ''),
              sellerName: String(fd.sellerName || 'Seller'),
              sellerUsername: String(fd.sellerUsername || 'seller'),
              title: String(fd.title || 'Digital Asset'),
              platform: (fd.platform as PlatformId) || 'youtube',
              subcategory: String(fd.subcategory || ''),
              priceMinor: Number(fd.priceMinor || 0),
              currency: (fd.currency as CurrencyCode) || 'BDT',
              thumbnailUrl: fd.thumbnailUrl ? String(fd.thumbnailUrl) : undefined,
              createdAtMs: Number(
                fd.createdAtMs || (fd.createdAt?.toMillis ? fd.createdAt.toMillis() : Date.now())
              ),
            };
          });
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setFavorites(list);
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'sellerFollows'), where('followerId', '==', uid), limit(120)),
        (snap) => {
          const list: SellerFollowRecord[] = snap.docs.map((docSnap) => {
            const sd = docSnap.data();
            return {
              id: docSnap.id,
              followerId: String(sd.followerId || ''),
              sellerId: String(sd.sellerId || ''),
              sellerName: String(sd.sellerName || 'Seller'),
              sellerUsername: String(sd.sellerUsername || 'seller'),
              sellerAvatarUrl: sd.sellerAvatarUrl ? String(sd.sellerAvatarUrl) : undefined,
              sellerVerified: Boolean(sd.sellerVerified),
              createdAtMs: Number(
                sd.createdAtMs || (sd.createdAt?.toMillis ? sd.createdAt.toMillis() : Date.now())
              ),
            };
          });
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setFollowedSellers(list);
        },
        () => {}
      )
    );

    setNotificationsLoading(true);
    setNotificationsError(null);
    unsubs.push(
      onSnapshot(
        query(collection(db, 'notifications'), where('recipientId', '==', uid), limit(50)),
        (snap) => {
          const parsed: NotificationRecord[] = snap.docs.map((d) => {
            const nd = d.data();
            return {
              id: d.id,
              recipientId: String(nd.recipientId || ''),
              actorId: String(nd.actorId || ''),
              actorRole: (nd.actorRole || 'user') as NotificationRecord['actorRole'],
              category: (nd.category || 'system') as NotificationRecord['category'],
              severity: (nd.severity || 'info') as NotificationRecord['severity'],
              alertKind:
                nd.alertKind === 'deal_room_created' ||
                nd.alertKind === 'admin_alert' ||
                nd.alertKind === 'normal'
                  ? nd.alertKind
                  : undefined,
              title: String(nd.title || ''),
              preview: String(nd.preview || nd.title || ''),
              body: String(nd.body || nd.preview || ''),
              refType: (nd.refType || 'none') as NotificationRecord['refType'],
              refId: String(nd.refId || ''),
              referenceLabel: String(nd.referenceLabel || ''),
              destination: String(nd.destination || ''),
              read: Boolean(nd.read),
              readAtMs: nd.readAt?.toMillis ? nd.readAt.toMillis() : undefined,
              createdAtMs: Number(
                nd.createdAtMs || (nd.createdAt?.toMillis ? nd.createdAt.toMillis() : Date.now())
              ),
            };
          });
          const prefsNow = notificationPrefsRef.current;
          const arrival = arrivalTrackerRef.current.processSnapshot(uid, parsed);
          if (arrival.shouldAlert) {
            void dispatchForegroundNotificationAlert(arrival.alertKind, prefsNow);
          }
          setPersonalNotifications(sortNotificationsNewestFirst(parsed));
          setNotificationsLoading(false);
          setNotificationsError(null);
        },
        (err) => {
          setNotificationsLoading(false);
          if (isTokenServiceDisabledError(err)) {
            void recoverFirestoreFromTokenServiceError();
            return;
          }
          setNotificationsError(extractUserFacingFirestoreError(err, 'Unable to load notifications.'));
        }
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [fbUser?.uid, signingOut, notifReloadEpoch]);

  // Tier 2 Secondary Authenticated Subscriptions (deferred after initial render or immediately when entering workspace pages)
  useEffect(() => {
    if (!fbUser || signingOut || !deferredSubsReady) return;
    const uid = fbUser.uid;
    const unsubs: (() => void)[] = [];

    unsubs.push(
      onSnapshot(
        query(collection(db, 'listings'), where('sellerId', '==', uid), limit(100)),
        (snap) => {
          const list: MarketplaceListing[] = snap.docs.map((docSnap) =>
            mapListingDocument(docSnap.id, docSnap.data())
          );
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setMyListings(list);
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'bids'), where('buyerId', '==', uid), limit(100)),
        (snap) => {
          const list: BidRecord[] = snap.docs.map((docSnap) => {
            const bd = docSnap.data();
            return {
              id: docSnap.id,
              listingId: String(bd.listingId || ''),
              sellerId: String(bd.sellerId || ''),
              buyerId: String(bd.buyerId || ''),
              buyerName: String(bd.buyerName || ''),
              buyerUsername: String(bd.buyerUsername || ''),
              buyerVerified: Boolean(bd.buyerVerified),
              amountMinor: Number(bd.amountMinor || 0),
              currency: (bd.currency as CurrencyCode) || 'BDT',
              status: (bd.status as BidRecord['status']) || 'pending',
              dealId: bd.dealId ? String(bd.dealId) : undefined,
              createdAtMs: bd.createdAt?.toMillis ? bd.createdAt.toMillis() : Date.now(),
            };
          });
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setMyBids(list);
        },
        () => {}
      )
    );

    // Conversations as Buyer or Seller (bounded)
    let buyerConvs: ConversationRecord[] = [];
    let sellerConvs: ConversationRecord[] = [];
    const syncConvs = () => {
      const map = new Map<string, ConversationRecord>();
      [...buyerConvs, ...sellerConvs].forEach((c) => map.set(c.id, c));
      const merged = Array.from(map.values()).sort((a, b) => b.updatedAtMs - a.updatedAtMs);
      setConversations(merged);
    };

    unsubs.push(
      onSnapshot(
        query(collection(db, 'conversations'), where('buyerId', '==', uid), limit(60)),
        (snap) => {
          buyerConvs = snap.docs.map((d) => {
            const cd = d.data();
            return {
              id: d.id,
              buyerId: cd.buyerId,
              sellerId: cd.sellerId,
              buyerName: cd.buyerName,
              sellerName: cd.sellerName,
              listingId: cd.listingId,
              listingTitle: cd.listingTitle,
              lastMessage: cd.lastMessage,
              safetyAcceptedByBuyer: Boolean(cd.safetyAcceptedByBuyer),
              safetyAcceptedBySeller: Boolean(cd.safetyAcceptedBySeller),
              moderationPaused: Boolean(cd.moderationPaused),
              moderationPauseReason: cd.moderationPauseReason
                ? String(cd.moderationPauseReason)
                : undefined,
              updatedAtMs: cd.updatedAt?.toMillis ? cd.updatedAt.toMillis() : Date.now(),
            };
          });
          syncConvs();
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'conversations'), where('sellerId', '==', uid), limit(60)),
        (snap) => {
          sellerConvs = snap.docs.map((d) => {
            const cd = d.data();
            return {
              id: d.id,
              buyerId: cd.buyerId,
              sellerId: cd.sellerId,
              buyerName: cd.buyerName,
              sellerName: cd.sellerName,
              listingId: cd.listingId,
              listingTitle: cd.listingTitle,
              lastMessage: cd.lastMessage,
              safetyAcceptedByBuyer: Boolean(cd.safetyAcceptedByBuyer),
              safetyAcceptedBySeller: Boolean(cd.safetyAcceptedBySeller),
              moderationPaused: Boolean(cd.moderationPaused),
              moderationPauseReason: cd.moderationPauseReason
                ? String(cd.moderationPauseReason)
                : undefined,
              updatedAtMs: cd.updatedAt?.toMillis ? cd.updatedAt.toMillis() : Date.now(),
            };
          });
          syncConvs();
        },
        () => {}
      )
    );

    // Deals as Buyer or Seller (bounded)
    let buyerDeals: DealRecord[] = [];
    let sellerDeals: DealRecord[] = [];
    const syncDeals = () => {
      const map = new Map<string, DealRecord>();
      [...buyerDeals, ...sellerDeals].forEach((d) => {
        if (!d.isDeleted) {
          map.set(d.id, d);
        }
      });
      setDeals(Array.from(map.values()).sort((a, b) => b.createdAtMs - a.createdAtMs));
    };

    const parseDeal = mapDealDocument;

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deals'), where('buyerId', '==', uid), limit(80)),
        (snap) => {
          buyerDeals = snap.docs.map((d) => parseDeal(d.id, d.data()));
          syncDeals();
        },
        () => {}
      )
    );
    unsubs.push(
      onSnapshot(
        query(collection(db, 'deals'), where('sellerId', '==', uid), limit(80)),
        (snap) => {
          sellerDeals = snap.docs.map((d) => parseDeal(d.id, d.data()));
          syncDeals();
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deposits'), where('userId', '==', uid), limit(80)),
        (snap) => {
          setDeposits(
            snap.docs
              .map((d) => {
                const dd = d.data();
                return {
                  id: d.id,
                  userId: dd.userId,
                  userName: dd.userName,
                  method: dd.method,
                  amountMinor: Number(dd.amountMinor || 0),
                  currency: 'BDT' as const,
                  senderNumber: dd.senderNumber,
                  transactionId: dd.transactionId,
                  screenshotData: dd.screenshotData,
                  status: dd.status,
                  rejectionReason: dd.rejectionReason,
                  createdAtMs: dd.createdAt?.toMillis ? dd.createdAt.toMillis() : Date.now(),
                };
              })
              .sort((a, b) => b.createdAtMs - a.createdAtMs)
          );
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'withdrawals'), where('userId', '==', uid), limit(80)),
        (snap) => {
          setWithdrawals(
            snap.docs
              .map((d) => {
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
                  createdAtMs: wd.createdAt?.toMillis ? wd.createdAt.toMillis() : Date.now(),
                };
              })
              .sort((a, b) => b.createdAtMs - a.createdAtMs)
          );
        },
        () => {}
      )
    );

    return () => unsubs.forEach((u) => u());
  }, [fbUser?.uid, signingOut, deferredSubsReady]);

  const autoReleaseDealIdsRef = useRef<Set<string>>(new Set());

  // Idempotent Escrow Protection Deadline Reminder Check (expiring within 6h & expired)
  useEffect(() => {
    if (!fbUser || deals.length === 0) return;
    const currentUid = fbUser.uid;

    const checkDealDeadlines = () => {
      const now = Date.now();
      for (const deal of deals) {
        const spec = evaluateDealDeadlineNotification(deal, now);
        if (spec && spec.recipientIds.includes(currentUid)) {
          void emitUserNotification({
            recipientId: currentUid,
            eventKey: spec.eventKey,
            actorId: currentUid,
            actorRole: 'user',
            category: 'deal',
            severity: spec.severity,
            title: spec.title,
            preview: spec.preview,
            body: spec.body,
            refType: spec.refType,
            refId: spec.refId,
            referenceLabel: spec.referenceLabel,
            destination: spec.destination,
          });
          if (spec.eventKey.startsWith('deal_protection_expired_') && deal.unresolvedReportCount === 0) {
            if (!autoReleaseDealIdsRef.current.has(deal.id)) {
              autoReleaseDealIdsRef.current.add(deal.id);
              void fetchWithFreshBearerToken(
                `/api/deals/${encodeURIComponent(deal.id)}/release-if-ready`,
                { method: 'POST' }
              ).catch(() => {
                // Non-fatal: server background sweep / admin settlement remains active
              });
            }
            void emitDealAdminNotification({
              dealId: deal.id,
              eventKey: `admin_ready_settlement_${deal.id}`,
              category: 'deal',
              severity: 'success',
              title: 'Escrow Timer Completed — Ready for Final Settlement',
              preview: `"${deal.listingTitle}" passed its security period with 0 open disputes.`,
              body: `Deal ${deal.id} ("${deal.listingTitle}") has completed its ${deal.protectionDurationHours}h security period with zero unresolved reports and is ready for final seller payout release.`,
              referenceLabel: `Deal · ${deal.listingTitle}`,
            });
          }
        }
      }
    };

    checkDealDeadlines();
    const intervalId = window.setInterval(checkDealDeadlines, 5 * 60 * 1000);
    return () => window.clearInterval(intervalId);
  }, [fbUser, deals]);

  // Direct-URL & Live Resolution for Target Listing (Listing Page or Buy Now Checkout)
  const targetListingId =
    route.page === 'listing'
      ? route.listingId
      : route.page === 'checkout'
      ? route.checkoutListingId
      : undefined;

  const resolvedTargetListing = useMemo(() => {
    if (!targetListingId) return null;
    return (
      activeListings.find((l) => l.id === targetListingId) ||
      myListings.find((l) => l.id === targetListingId) ||
      (fetchedListing && fetchedListing.id === targetListingId ? fetchedListing : null)
    );
  }, [targetListingId, activeListings, myListings, fetchedListing]);

  useEffect(() => {
    if (!targetListingId) {
      setLoadingTargetListing(false);
      return;
    }
    const localMatch =
      activeListings.find((l) => l.id === targetListingId) ||
      myListings.find((l) => l.id === targetListingId);
    if (localMatch) {
      listingCacheRef.current.set(`listing:${targetListingId}`, localMatch);
      setLoadingTargetListing(false);
      return;
    }
    const cached = listingCacheRef.current.get(`listing:${targetListingId}`);
    if (cached) {
      setFetchedListing(cached);
      setLoadingTargetListing(false);
    } else {
      setLoadingTargetListing(true);
    }
    let cancelled = false;
    getDoc(doc(db, 'listings', targetListingId))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const mapped = mapListingDocument(snap.id, snap.data());
          listingCacheRef.current.set(`listing:${targetListingId}`, mapped);
          setFetchedListing(mapped);
        } else if (!cached) {
          setFetchedListing(null);
        }
      })
      .catch(() => {
        if (!cancelled && !cached) setFetchedListing(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingTargetListing(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetListingId, activeListings, myListings]);

  // Live seller follower count subscription when viewing a Listing Detail page
  useEffect(() => {
    const sellerId = page === 'listing' ? resolvedTargetListing?.sellerId : undefined;
    if (!sellerId) {
      setListingSellerFollowerCount(undefined);
      return;
    }
    const unsub = onSnapshot(
      doc(db, 'publicProfiles', sellerId),
      (snap) => {
        if (snap.exists()) {
          setListingSellerFollowerCount(resolveSellerFollowerCount(snap.data() as PublicProfile));
        } else {
          setListingSellerFollowerCount(0);
        }
      },
      () => {}
    );
    return () => unsub();
  }, [page, resolvedTargetListing?.sellerId]);

  // Direct-URL & Live Resolution for Target Checkout Deal
  const targetCheckoutDealId = route.page === 'checkout' ? route.checkoutDealId : undefined;

  const resolvedCheckoutDeal = useMemo(() => {
    if (!targetCheckoutDealId) return null;
    return (
      deals.find((d) => d.id === targetCheckoutDealId) ||
      (fetchedDeal && fetchedDeal.id === targetCheckoutDealId ? fetchedDeal : null)
    );
  }, [targetCheckoutDealId, deals, fetchedDeal]);

  const resolvedDealAssociatedListing = useMemo(() => {
    if (!resolvedCheckoutDeal) return null;
    return (
      activeListings.find((l) => l.id === resolvedCheckoutDeal.listingId) ||
      myListings.find((l) => l.id === resolvedCheckoutDeal.listingId) ||
      (fetchedListing && fetchedListing.id === resolvedCheckoutDeal.listingId
        ? fetchedListing
        : null)
    );
  }, [resolvedCheckoutDeal, activeListings, myListings, fetchedListing]);

  useEffect(() => {
    if (!targetCheckoutDealId || !authReady || !fbUser) {
      setLoadingTargetDeal(false);
      return;
    }
    if (deals.some((d) => d.id === targetCheckoutDealId)) {
      setLoadingTargetDeal(false);
      return;
    }
    let cancelled = false;
    setLoadingTargetDeal(true);
    getDoc(doc(db, 'deals', targetCheckoutDealId))
      .then((snap) => {
        if (cancelled) return;
        if (snap.exists()) {
          const mapped = mapDealDocument(snap.id, snap.data());
          setFetchedDeal(mapped.isDeleted ? null : mapped);
        } else {
          setFetchedDeal(null);
        }
      })
      .catch(() => {
        if (!cancelled) setFetchedDeal(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingTargetDeal(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetCheckoutDealId, authReady, fbUser, deals]);

  const combinedNotifications = useMemo(() => {
    void announcementReadEpoch;
    void dismissedNotifEpoch;
    const scopeKey = fbUser?.uid || 'guest';
    const merged = mergeAnnouncementsIntoFeed(
      personalNotifications,
      activeAnnouncements,
      fbUser?.uid ?? null
    );
    const dismissedIds = getLocallyDismissedNotificationIds(scopeKey);
    if (dismissedIds.size === 0) return merged;
    return merged.filter((item) => !dismissedIds.has(item.id));
  }, [
    personalNotifications,
    activeAnnouncements,
    fbUser?.uid,
    announcementReadEpoch,
    dismissedNotifEpoch,
  ]);

  const unreadNotificationCount = useMemo(
    () => computeUnreadNotificationCount(combinedNotifications),
    [combinedNotifications]
  );

  const favoriteListingIds = useMemo(
    () => new Set(favorites.map((f) => f.listingId)),
    [favorites]
  );

  const followedSellerIds = useMemo(
    () => new Set(followedSellers.map((f) => f.sellerId)),
    [followedSellers]
  );

  const handleMarkSingleNotificationRead = useCallback(
    async (item: NotificationRecord) => {
      if (item.isAnnouncementMirror && item.refId) {
        markLocalAnnouncementRead(fbUser?.uid || 'guest', item.refId);
        setAnnouncementReadEpoch((n) => n + 1);
        return;
      }
      await markNotificationReadInFirestore(item);
    },
    [fbUser?.uid]
  );

  const handleMarkAllNotificationsRead = useCallback(async () => {
    const scopeKey = fbUser?.uid || 'guest';
    for (const item of combinedNotifications) {
      if (!item.read && item.isAnnouncementMirror && item.refId) {
        markLocalAnnouncementRead(scopeKey, item.refId);
      }
    }
    setAnnouncementReadEpoch((n) => n + 1);

    if (fbUser) {
      await markAllNotificationsReadInFirestore(fbUser.uid, personalNotifications);
    }
  }, [fbUser, combinedNotifications, personalNotifications]);

  const handleDismissNotification = useCallback(
    async (item: NotificationRecord) => {
      const scopeKey = fbUser?.uid || 'guest';
      if (!fbUser || item.isAnnouncementMirror) {
        dismissNotificationsLocally(scopeKey, [item.id]);
        setDismissedNotifEpoch((n) => n + 1);
        return;
      }
      await deleteNotificationInFirestore(item);
      dismissNotificationsLocally(scopeKey, [item.id]);
      setDismissedNotifEpoch((n) => n + 1);
    },
    [fbUser]
  );

  const handleClearAllNotifications = useCallback(async () => {
    const scopeKey = fbUser?.uid || 'guest';
    if (combinedNotifications.length === 0) return;
    if (!fbUser) {
      const ids = combinedNotifications.map((item) => item.id).filter(Boolean);
      dismissNotificationsLocally(scopeKey, ids);
      setDismissedNotifEpoch((n) => n + 1);
      return;
    }
    const { dismissedMirrorIds } = await clearAllUserNotificationsInFirestore(
      fbUser.uid,
      combinedNotifications
    );
    const allClearedIds = [
      ...dismissedMirrorIds,
      ...combinedNotifications
        .filter((item) => !item.isAnnouncementMirror && item.recipientId === fbUser.uid)
        .map((item) => item.id),
    ];
    if (allClearedIds.length > 0) {
      dismissNotificationsLocally(scopeKey, allClearedIds);
      setDismissedNotifEpoch((n) => n + 1);
    }
  }, [fbUser, combinedNotifications]);

  const handleNavigateNotificationDestination = useCallback(
    async (dest: SafeInternalDestination) => {
      if (dest.kind === 'wallet') {
        if (!fbUser) {
          requireAuthWithIntent({
            kind: 'open_page',
            targetPage: 'wallet',
            returnPage: page,
            createdAtMs: Date.now(),
          });
          return;
        }
        setWalletReturnRoute(null);
        navigateRoute({ page: 'wallet' });
        return;
      }

      if (dest.kind === 'deal' && dest.targetId) {
        if (!fbUser) {
          requireAuthWithIntent({
            kind: 'open_page',
            targetPage: 'deals',
            dealId: dest.targetId,
            returnPage: page,
            createdAtMs: Date.now(),
          });
          return;
        }
        navigateRoute({ page: 'deals', dealId: dest.targetId });
        return;
      }

      if (dest.kind === 'view' && dest.view === 'admin' && dest.targetId) {
        navigateRoute({ page: 'admin', dealId: dest.targetId });
        return;
      }

      if (dest.kind === 'chat' && dest.targetId) {
        if (!fbUser) {
          requireAuthWithIntent({
            kind: 'open_page',
            targetPage: 'chat',
            convId: dest.targetId,
            returnPage: page,
            createdAtMs: Date.now(),
          });
          return;
        }
        navigateRoute({ page: 'chat', convId: dest.targetId });
        return;
      }

      if (dest.kind === 'listing' && dest.targetId) {
        navigateRoute({ page: 'listing', listingId: dest.targetId });
        return;
      }

      if (dest.kind === 'seller' && dest.targetId) {
        navigateRoute({ page: 'public-profile', sellerUid: dest.targetId });
        return;
      }

      if (dest.view) {
        navigateRoute({ page: dest.view });
      }
    },
    [fbUser, page, navigateRoute, requireAuthWithIntent]
  );

  const handleUpdateNotificationPreferences = useCallback(
    (nextRaw: UserNotificationPreferences) => {
      const uid = fbUser?.uid ?? null;
      const saved = saveLocalNotificationPreferences(uid, nextRaw);
      setNotificationPrefs(saved);
      if (uid && profileBootstrapped && !signingOut) {
        void updateDoc(doc(db, 'privateUsers', uid), {
          notificationPrefs: saved,
          updatedAt: serverTimestamp(),
        }).catch(() => {
          // Local preferences remain saved if offline
        });
      }
    },
    [fbUser?.uid, profileBootstrapped, signingOut]
  );

  // Process validated ?dest=... deep link from Web Push click (rejects external URLs)
  useEffect(() => {
    if (!pendingDeepLinkRaw) return;
    const safeDest = sanitizeNotificationDestination(pendingDeepLinkRaw);
    if (!safeDest) {
      setPendingDeepLinkRaw(null);
      return;
    }
    const requiresAuth =
      safeDest.kind === 'wallet' ||
      safeDest.kind === 'deal' ||
      safeDest.kind === 'chat' ||
      safeDest.view === 'admin' ||
      safeDest.view === 'profile' ||
      safeDest.view === 'deals' ||
      safeDest.view === 'chat' ||
      safeDest.view === 'favorites' ||
      safeDest.view === 'my-bids' ||
      safeDest.view === 'following';
    if (requiresAuth && !authReady) {
      return;
    }
    setPendingDeepLinkRaw(null);
    void handleNavigateNotificationDestination(safeDest);
  }, [pendingDeepLinkRaw, authReady, handleNavigateNotificationDestination]);

  // Listen for Service Worker notificationclick postMessage when an existing BEXORA tab is focused
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onSwMessage = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== 'BEXORA_NOTIFICATION_CLICK') return;
      const safeDest = sanitizeNotificationDestination(String(data.destination || ''));
      if (safeDest) {
        void handleNavigateNotificationDestination(safeDest);
      }
      const clickedNotifId = String(data.notificationId || '').trim();
      if (clickedNotifId && fbUser) {
        const match = personalNotifications.find((n) => n.id === clickedNotifId && !n.read);
        if (match) {
          void markNotificationReadInFirestore(match);
        }
      }
    };
    navigator.serviceWorker.addEventListener('message', onSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', onSwMessage);
    };
  }, [fbUser, personalNotifications, handleNavigateNotificationDestination]);

  // Reliable Logout Flow (clears staged recoverable session, unlinks device push token & detaches authenticated listeners BEFORE revoking Firebase Auth token)
  const handleLogout = useCallback(async () => {
    const outgoingUid = fbUser?.uid ?? auth.currentUser?.uid ?? null;
    setSigningOut(true);
    clearCachedUser();
    setCachedUser(null);
    setHasFbAuthKey(false);
    clearRecoverableSessionOnLogout();
    setStaleSessionNotice(null);
    setSessionExtendPromptVisible(false);
    arrivalTrackerRef.current.reset();
    setProfileBootstrapped(false);
    setAdminRole('none');
    setAdminRoleStatus('idle');
    setAdminRoleError(null);
    setPendingAdminInvitation(null);
    setWalletReturnRoute(null);
    setAndPersistPendingIntent(null);
    setPersonalNotifications([]);
    setFavorites([]);
    setFollowedSellers([]);
    setMyListings([]);
    setMyBids([]);
    setConversations([]);
    setDeals([]);
    setDeposits([]);
    setWithdrawals([]);
    setFetchedDeal(null);
    setFirestoreRestriction(null);
    setModerationStatus(null);
    setSafetyAppealsModalOpen(false);
    setReportModalTarget(null);
    navigateRoute({ page: 'home' }, { replace: true });
    try {
      await unlinkCurrentDevicePushTokenOnLogout(outgoingUid);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      await signOut(auth);
      clearCachedUser();
      setCachedUser(null);
      setHasFbAuthKey(false);
      clearRecoverableSessionOnLogout();
      setProfile(null);
      setPrivateUser(null);
      showFlash('You have been signed out safely.');
    } catch (err) {
      showFlash(err instanceof Error ? err.message : 'Could not complete sign-out. Please try again.');
    } finally {
      setSigningOut(false);
    }
  }, [fbUser?.uid, showFlash, navigateRoute, setAndPersistPendingIntent]);

  // Toggle Listing Favorite (Persists to `/favorites/fav_${uid}_${listingId}` or prompts auth seamlessly)
  const handleToggleFavorite = useCallback(
    async (listing: MarketplaceListing) => {
      if (!fbUser) {
        requireAuthWithIntent({
          kind: 'toggle_favorite',
          listingId: listing.id,
          listingTitle: listing.title,
          returnPage: page,
          createdAtMs: Date.now(),
        });
        return;
      }
      const currentlySaved = favoriteListingIds.has(listing.id);
      try {
        const res = await toggleFavoriteListingInFirestore(fbUser.uid, listing, currentlySaved);
        showFlash(
          res.saved
            ? `Saved "${listing.title}" to Favorites.`
            : `Removed "${listing.title}" from Favorites.`
        );
      } catch (err) {
        showFlash(
          extractUserFacingFirestoreError(err, 'Could not update Favorites. Please try again.')
        );
      }
    },
    [fbUser, favoriteListingIds, page, requireAuthWithIntent, showFlash]
  );

  const handleRemoveFavoriteById = useCallback(
    async (listingId: string, title: string) => {
      if (!fbUser) return;
      try {
        await removeFavoriteListingInFirestore(fbUser.uid, listingId);
        showFlash(`Removed "${title}" from Favorites.`);
      } catch (err) {
        showFlash(
          extractUserFacingFirestoreError(err, 'Could not remove item from Favorites.')
        );
      }
    },
    [fbUser, showFlash]
  );

  // Toggle Seller Follow (Atomic `/sellerFollows` + `publicProfiles.followerCount` transaction)
  const handleToggleFollowSeller = useCallback(
    async (seller: FollowTargetSellerSummary) => {
      if (!fbUser) {
        requireAuthWithIntent({
          kind: 'follow_seller',
          sellerUid: seller.uid,
          sellerName: seller.displayName,
          listingId: page === 'listing' ? resolvedTargetListing?.id : undefined,
          returnPage: page,
          createdAtMs: Date.now(),
        });
        return;
      }
      if (!canUserFollowSeller(fbUser.uid, seller.uid)) {
        showFlash('You cannot follow your own seller profile.');
        return;
      }
      const currentlyFollowing = followedSellerIds.has(seller.uid);
      try {
        const res = await toggleFollowSellerInFirestore(fbUser.uid, seller, currentlyFollowing);
        showFlash(
          res.following
            ? `Following ${seller.displayName}! You'll receive instant alerts when they publish new listings.`
            : `Unfollowed ${seller.displayName}.`
        );
      } catch (err) {
        showFlash(
          extractUserFacingFirestoreError(err, 'Could not update seller follow status.')
        );
      }
    },
    [fbUser, followedSellerIds, page, resolvedTargetListing?.id, requireAuthWithIntent, showFlash]
  );

  const handleUnfollowSellerById = useCallback(
    async (sellerUid: string, sellerName: string) => {
      if (!fbUser) return;
      try {
        await unfollowSellerByIdInFirestore(fbUser.uid, sellerUid);
        showFlash(`Unfollowed ${sellerName}.`);
      } catch (err) {
        showFlash(extractUserFacingFirestoreError(err, 'Could not unfollow seller.'));
      }
    },
    [fbUser, showFlash]
  );

  // Open Public Profile Visitor View
  const handleOpenPublicProfile = useCallback(
    (targetUid: string) => {
      navigateRoute({ page: 'public-profile', sellerUid: targetUid });
    },
    [navigateRoute]
  );

  // Deterministic Pre-Deal Chat Starter
  const handleStartChatWithUser = useCallback(
    async (targetUid: string, targetName: string, listing?: MarketplaceListing) => {
      if (!fbUser || !profile) {
        requireAuthWithIntent({
          kind: 'message_seller',
          targetUid,
          targetName,
          listingId: listing?.id,
          listingTitle: listing?.title,
          returnPage: page,
          createdAtMs: Date.now(),
        });
        return;
      }
      if (targetUid === fbUser.uid) {
        showFlash('You cannot open a pre-deal chat with your own account.');
        return;
      }

      const listingId = listing?.id || 'general';
      const listingTitle = listing?.title || 'Marketplace Inquiry';
      const isSellerInitiating = listing ? listing.sellerId === fbUser.uid : false;
      const buyerId = isSellerInitiating ? targetUid : fbUser.uid;
      const sellerId = isSellerInitiating ? fbUser.uid : targetUid;
      const buyerName = isSellerInitiating ? targetName : profile.displayName;
      const sellerName = isSellerInitiating ? profile.displayName : targetName;

      const convId = `${listingId}_${buyerId}_${sellerId}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
      try {
        const convRef = doc(db, 'conversations', convId);
        const existing = await getDoc(convRef);
        if (!existing.exists()) {
          await setDoc(convRef, {
            buyerId,
            sellerId,
            buyerName: buyerName.slice(0, 80),
            sellerName: sellerName.slice(0, 80),
            listingId: listingId.slice(0, 128),
            listingTitle: listingTitle.slice(0, 120),
            lastMessage: 'Conversation opened',
            safetyAcceptedByBuyer: false,
            safetyAcceptedBySeller: false,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }
        navigateRoute({ page: 'chat', convId });
      } catch (err) {
        showFlash(err instanceof Error ? err.message : 'Failed to open chat.');
      }
    },
    [fbUser, profile, page, showFlash, navigateRoute, requireAuthWithIntent]
  );

  // Seamless Post-Authentication Action Continuation (runs once Auth + Firestore profile & wallet hydrate)
  const readyToResumeAuth = canResumeAuthIntent({
    authReady,
    userUid: fbUser?.uid ?? null,
    profileBootstrapped,
    hasProfile: Boolean(profile),
    hasPrivateUser: Boolean(privateUser),
    signingOut,
  });

  useEffect(() => {
    if (!readyToResumeAuth) return;

    if (pendingAuthIntent) {
      const intent = pendingAuthIntent;
      setAndPersistPendingIntent(null);

      if (intent.kind === 'buy_now') {
        navigateRoute({ page: 'checkout', checkoutListingId: intent.listingId }, { replace: true });
        return;
      }
      if (intent.kind === 'place_bid') {
        if (intent.draftBidAmount) {
          setResumedBidDraft({
            listingId: intent.listingId,
            amount: intent.draftBidAmount,
          });
        }
        navigateRoute({ page: 'listing', listingId: intent.listingId }, { replace: true });
        showFlash('Signed in! Review and submit your saved bid below.');
        return;
      }
      if (intent.kind === 'pay_deal') {
        navigateRoute({ page: 'checkout', checkoutDealId: intent.dealId }, { replace: true });
        return;
      }
      if (intent.kind === 'message_seller') {
        const knownListing = intent.listingId
          ? activeListings.find((l) => l.id === intent.listingId) ||
            myListings.find((l) => l.id === intent.listingId) ||
            (fetchedListing && fetchedListing.id === intent.listingId ? fetchedListing : undefined)
          : undefined;
        if (intent.listingId && !knownListing) {
          getDoc(doc(db, 'listings', intent.listingId))
            .then((snap) => {
              const loaded = snap.exists() ? mapListingDocument(snap.id, snap.data()) : undefined;
              void handleStartChatWithUser(intent.targetUid, intent.targetName, loaded);
            })
            .catch(() => {
              void handleStartChatWithUser(intent.targetUid, intent.targetName);
            });
        } else {
          void handleStartChatWithUser(intent.targetUid, intent.targetName, knownListing);
        }
        return;
      }
      if (intent.kind === 'toggle_favorite' && fbUser) {
        const currentUid = fbUser.uid;
        const knownListing =
          activeListings.find((l) => l.id === intent.listingId) ||
          myListings.find((l) => l.id === intent.listingId) ||
          (fetchedListing && fetchedListing.id === intent.listingId ? fetchedListing : undefined);
        const finishSave = async (target?: MarketplaceListing) => {
          if (target) {
            try {
              const res = await toggleFavoriteListingInFirestore(currentUid, target, false);
              showFlash(
                res.saved
                  ? `Signed in and saved "${target.title}" to Favorites!`
                  : `"${target.title}" updated in Favorites.`
              );
            } catch {
              // Non-fatal
            }
          }
          if (intent.returnPage === 'listing') {
            navigateRoute({ page: 'listing', listingId: intent.listingId }, { replace: true });
          } else {
            navigateRoute(
              {
                page:
                  intent.returnPage && intent.returnPage !== 'auth'
                    ? intent.returnPage
                    : 'favorites',
              },
              { replace: true }
            );
          }
        };
        if (knownListing) {
          void finishSave(knownListing);
        } else {
          getDoc(doc(db, 'listings', intent.listingId))
            .then((snap) =>
              finishSave(snap.exists() ? mapListingDocument(snap.id, snap.data()) : undefined)
            )
            .catch(() => finishSave(undefined));
        }
        return;
      }
      if (intent.kind === 'follow_seller' && fbUser) {
        const currentUid = fbUser.uid;
        if (canUserFollowSeller(currentUid, intent.sellerUid)) {
          void toggleFollowSellerInFirestore(
            currentUid,
            {
              uid: intent.sellerUid,
              displayName: intent.sellerName,
              username: 'seller',
              nidVerified: false,
            },
            false
          )
            .then((res) => {
              showFlash(
                res.following
                  ? `Signed in and following ${intent.sellerName}!`
                  : `Following updated for ${intent.sellerName}.`
              );
            })
            .catch(() => {});
        }
        if (intent.listingId && intent.returnPage === 'listing') {
          navigateRoute({ page: 'listing', listingId: intent.listingId }, { replace: true });
        } else if (intent.returnPage === 'sellers') {
          navigateRoute({ page: 'sellers' }, { replace: true });
        } else {
          navigateRoute({ page: 'public-profile', sellerUid: intent.sellerUid }, { replace: true });
        }
        return;
      }
      if (intent.kind === 'open_page') {
        navigateRoute(
          {
            page: intent.targetPage,
            dealId: intent.dealId,
            convId: intent.convId,
          },
          { replace: true }
        );
        return;
      }
    }

    if (route.page === 'auth') {
      navigateRoute({ page: 'market' }, { replace: true });
    }
  }, [
    readyToResumeAuth,
    pendingAuthIntent,
    fbUser,
    route.page,
    activeListings,
    myListings,
    fetchedListing,
    navigateRoute,
    setAndPersistPendingIntent,
    handleStartChatWithUser,
    showFlash,
  ]);

  const handleCloseAuthPage = useCallback(() => {
    const intent = pendingAuthIntent;
    if (intent) {
      setAndPersistPendingIntent(null);
      if (intent.kind === 'place_bid') {
        if (intent.draftBidAmount) {
          setResumedBidDraft({
            listingId: intent.listingId,
            amount: intent.draftBidAmount,
          });
        }
        navigateRoute({ page: 'listing', listingId: intent.listingId });
        return;
      }
      if (intent.kind === 'buy_now') {
        navigateRoute({ page: 'listing', listingId: intent.listingId });
        return;
      }
      if (intent.kind === 'toggle_favorite' && intent.returnPage === 'listing') {
        navigateRoute({ page: 'listing', listingId: intent.listingId });
        return;
      }
      if (intent.kind === 'follow_seller') {
        if (intent.listingId && intent.returnPage === 'listing') {
          navigateRoute({ page: 'listing', listingId: intent.listingId });
          return;
        }
        if (intent.returnPage === 'public-profile') {
          navigateRoute({ page: 'public-profile', sellerUid: intent.sellerUid });
          return;
        }
      }
      if (intent.kind === 'message_seller' && intent.listingId) {
        navigateRoute({ page: 'listing', listingId: intent.listingId });
        return;
      }
      if (intent.returnPage && intent.returnPage !== 'auth') {
        navigateRoute({ page: intent.returnPage });
        return;
      }
    }
    navigateRoute({ page: 'market' });
  }, [pendingAuthIntent, setAndPersistPendingIntent, navigateRoute]);

  // Listing filter computation
  const filterListingsWithState = useCallback(
    (source: MarketplaceListing[], f: MarketplaceFilterState, qText: string) => {
      const qLower = qText.trim().toLowerCase();
      return source
        .filter((item) => {
          if (item.status === 'reserved' || isListingReservationActive(item)) {
            return false;
          }
          if (qLower) {
            const hay = `${item.title} ${item.description} ${item.subcategory} ${item.gameName || ''} ${item.sellerUsername}`.toLowerCase();
            if (!hay.includes(qLower)) return false;
          }
          if (f.platform !== 'all' && item.platform !== f.platform) return false;
          if (f.subcategory !== 'all' && item.subcategory !== f.subcategory) return false;
          if (f.verifiedSeller && !item.sellerVerified) return false;

          if (f.platform !== 'gaming' && f.platform !== 'domain') {
            if (f.monetization === 'monetized' && item.monetizationStatus !== 'monetized') return false;
            if (f.monetization === 'non-monetized' && item.monetizationStatus !== 'non-monetized') return false;
            if (f.monetization === 'verified-only' && item.verifiedOptions.length === 0) return false;
            if (f.methods.length > 0) {
              const combined = new Set([...item.claimedOptions, ...item.verifiedOptions]);
              if (!f.methods.some((m) => combined.has(m))) return false;
            }
          }

          if (f.minPrice !== '') {
            const minMinor = Number(f.minPrice) * 100;
            if (Number.isFinite(minMinor) && item.priceMinor < minMinor) return false;
          }
          if (f.maxPrice !== '') {
            const maxMinor = Number(f.maxPrice) * 100;
            if (Number.isFinite(maxMinor) && item.priceMinor > maxMinor) return false;
          }

          if (f.platform === 'gaming') {
            if (f.gameName !== 'all' && item.gameName !== f.gameName) return false;
            if (f.gameUidQuery.trim() && !(item.gameUid || '').toLowerCase().includes(f.gameUidQuery.trim().toLowerCase())) {
              return false;
            }
            if (f.minLevel !== '' && (item.gameLevel || 0) < Number(f.minLevel)) return false;
            if (f.maxLevel !== '' && (item.gameLevel || 0) > Number(f.maxLevel)) return false;
          } else {
            if (f.minMetric !== '' && item.metricValue < Number(f.minMetric)) return false;
            if (f.maxMetric !== '' && item.metricValue > Number(f.maxMetric)) return false;
            if (f.minRevenue !== '' && item.monthlyRevenueMinor < Number(f.minRevenue) * 100) return false;
            if (f.maxRevenue !== '' && item.monthlyRevenueMinor > Number(f.maxRevenue) * 100) return false;
          }

          return true;
        })
        .sort((a, b) => {
          if (f.sort === 'oldest') return a.createdAtMs - b.createdAtMs;
          if (f.sort === 'price-asc') return a.priceMinor - b.priceMinor;
          if (f.sort === 'price-desc') return b.priceMinor - a.priceMinor;
          if (f.sort === 'popular') return b.views - a.views;
          return b.createdAtMs - a.createdAtMs;
        });
    },
    []
  );

  const draftMatchCount = useMemo(
    () => filterListingsWithState(activeListings, draftFilters, searchQuery).length,
    [activeListings, draftFilters, searchQuery, filterListingsWithState]
  );

  const filteredMarketplaceListings = useMemo(
    () => filterListingsWithState(activeListings, appliedFilters, searchQuery),
    [activeListings, appliedFilters, searchQuery, filterListingsWithState]
  );

  const handleOpenListingDetail = useCallback(
    (l: MarketplaceListing) => {
      setFetchedListing(l);
      navigateRoute({ page: 'listing', listingId: l.id });
    },
    [navigateRoute]
  );

  const handleListingViewCountUpdated = useCallback((listingId: string, newViews: number) => {
    setActiveListings((prev) =>
      prev.map((item) => (item.id === listingId ? { ...item, views: newViews } : item))
    );
    setFetchedListing((prev) => (prev && prev.id === listingId ? { ...prev, views: newViews } : prev));
  }, []);

  // Sync guest recent searches when signed out
  useEffect(() => {
    if (!fbUser) {
      setRecentSearches(loadGuestRecentSearches());
    }
  }, [fbUser]);

  const recordRecentSearch = useCallback(
    async (input: RecentSearchInput) => {
      const rec = createRecentSearchRecord(input, Date.now());
      if (!rec) return;

      if (fbUser) {
        setRecentSearches((prev) => upsertRecentSearchList(prev, rec, MAX_RECENT_SEARCHES));
        try {
          await setDoc(doc(db, 'privateUsers', fbUser.uid, 'recentSearches', rec.id), {
            query: rec.query,
            platform: rec.platform,
            subcategory: rec.subcategory,
            monetization: rec.monetization,
            verifiedOnly: rec.verifiedOnly,
            sortBy: rec.sortBy,
            summaryLabel: rec.summaryLabel,
            searchedAtMs: rec.searchedAtMs,
            updatedAt: serverTimestamp(),
          });
          // Prune excess beyond MAX_RECENT_SEARCHES
          const overflow = recentSearches
            .filter((item) => item.id !== rec.id)
            .slice(MAX_RECENT_SEARCHES - 1);
          for (const old of overflow) {
            void deleteDoc(doc(db, 'privateUsers', fbUser.uid, 'recentSearches', old.id)).catch(
              () => {}
            );
          }
        } catch {
          // Non-fatal persistence fallback
        }
      } else {
        setRecentSearches((prev) => {
          const next = upsertRecentSearchList(prev, rec, MAX_RECENT_SEARCHES);
          saveGuestRecentSearches(next);
          return next;
        });
      }
    },
    [fbUser, recentSearches]
  );

  const handleDeleteRecentSearch = useCallback(
    async (searchId: string) => {
      if (fbUser) {
        setRecentSearches((prev) => prev.filter((item) => item.id !== searchId));
        try {
          await deleteDoc(doc(db, 'privateUsers', fbUser.uid, 'recentSearches', searchId));
        } catch {
          // Non-fatal
        }
      } else {
        setRecentSearches((prev) => {
          const next = prev.filter((item) => item.id !== searchId);
          saveGuestRecentSearches(next);
          return next;
        });
      }
    },
    [fbUser]
  );

  const handleClearAllRecentSearches = useCallback(async () => {
    if (fbUser) {
      const toDelete = [...recentSearches];
      setRecentSearches([]);
      await Promise.all(
        toDelete.map((item) =>
          deleteDoc(doc(db, 'privateUsers', fbUser.uid, 'recentSearches', item.id)).catch(() => {})
        )
      );
      showFlash('Cleared your recent search history.');
    } else {
      setRecentSearches([]);
      saveGuestRecentSearches([]);
      showFlash('Cleared recent searches in this browser.');
    }
  }, [fbUser, recentSearches, showFlash]);

  const handleExecuteRecentSearch = useCallback(
    (rec: RecentSearchRecord) => {
      const nextFilters: MarketplaceFilterState = {
        ...EMPTY_FILTERS,
        platform: rec.platform ? rec.platform : 'all',
        subcategory: rec.subcategory ? rec.subcategory : 'all',
        monetization:
          rec.monetization === 'monetized' || rec.monetization === 'non-monetized'
            ? rec.monetization
            : 'all',
        verifiedSeller: Boolean(rec.verifiedOnly),
        sort:
          rec.sortBy === 'oldest' ||
          rec.sortBy === 'price-asc' ||
          rec.sortBy === 'price-desc' ||
          rec.sortBy === 'popular'
            ? rec.sortBy
            : 'newest',
      };
      setSearchQuery(rec.query);
      setDraftFilters(nextFilters);
      setAppliedFilters(nextFilters);
      void recordRecentSearch({
        query: rec.query,
        platform: rec.platform,
        subcategory: rec.subcategory,
        monetization: rec.monetization,
        verifiedOnly: rec.verifiedOnly,
        sortBy: rec.sortBy,
      });
      navigateRoute({
        page: 'market',
        platformFilter: rec.platform ? rec.platform : undefined,
      });
    },
    [navigateRoute, recordRecentSearch]
  );

  const handleQuickCategorySelect = (p: PlatformId) => {
    const next: MarketplaceFilterState = {
      ...EMPTY_FILTERS,
      platform: p,
    };
    setDraftFilters(next);
    setAppliedFilters(next);
    void recordRecentSearch({
      query: searchQuery,
      platform: p,
    });
    navigateRoute({ page: 'market', platformFilter: p });
  };

  const isAdmin = adminRole === 'admin' || adminRole === 'superadmin';

  const navbarAuthStatus = resolveNavbarAuthState({
    authReady,
    signingOut,
    hasFbUser: Boolean(fbUser),
    hasProfile: Boolean(profile),
    profileBootstrapped,
    hasCachedUser: Boolean(cachedUser),
    hasFirebaseAuthKey: hasFbAuthKey,
  });

  return (
    <div className="min-h-screen w-full flex flex-col bg-[var(--bx-bg)] text-[var(--bx-text)] pb-20 lg:pb-0">
      {/* Global Header */}
      <Navbar
        page={page}
        onNavigate={navigatePage}
        onPrefetchRoute={prefetchRouteView}
        theme={theme}
        onToggleTheme={toggleTheme}
        language={language}
        onChangeLanguage={setLanguage}
        currency={currency}
        onChangeCurrency={setCurrency}
        userUid={fbUser?.uid ?? null}
        profile={profile}
        cachedUser={cachedUser}
        hasCachedUser={Boolean(cachedUser)}
        authStatus={navbarAuthStatus}
        isAdmin={isAdmin}
        signingOut={signingOut}
        onOpenAuth={() => {
          setAndPersistPendingIntent(null);
          navigateRoute({ page: 'auth', authMode: 'login' });
        }}
        onPrefetchAuth={prefetchAuthModal}
        onOpenCreateListing={() => {
          if (!fbUser) {
            requireAuthWithIntent({
              kind: 'open_page',
              targetPage: 'sell',
              returnPage: page,
              createdAtMs: Date.now(),
            });
            return;
          }
          navigateRoute({ page: 'sell' });
        }}
        onOpenWallet={(mode = 'deposit') => {
          setWalletInitialMode(mode);
          if (!fbUser) {
            requireAuthWithIntent({
              kind: 'open_page',
              targetPage: 'wallet',
              returnPage: page,
              createdAtMs: Date.now(),
            });
            return;
          }
          setWalletReturnRoute(null);
          navigateRoute({ page: 'wallet' });
        }}
        onOpenPublicSelf={() => {
          if (fbUser) {
            handleOpenPublicProfile(fbUser.uid);
          }
        }}
        onOpenSafetyAndAppeals={() => {
          void refreshModerationStatus();
          setSafetyAppealsModalOpen(true);
        }}
        onLogout={handleLogout}
        isInstalled={pwa.isInstalled}
        onTriggerInstall={() => {
          pwa.triggerInstall();
        }}
        siteName={settings.siteName}
        logoUrl={settings.logoUrl}
        enabledLanguages={settings.enabledLanguages}
        notificationSlot={
          <NotificationCenter
            userUid={fbUser?.uid ?? null}
            notifications={combinedNotifications}
            loading={notificationsLoading}
            error={notificationsError}
            isOffline={isOffline}
            onRetry={() => setNotifReloadEpoch((n) => n + 1)}
            onMarkOneRead={handleMarkSingleNotificationRead}
            onMarkAllRead={handleMarkAllNotificationsRead}
            onDismiss={handleDismissNotification}
            onClearAll={handleClearAllNotifications}
            onNavigateDestination={(dest) => {
              void handleNavigateNotificationDestination(dest);
            }}
            onOpenAuth={() => {
              setAndPersistPendingIntent(null);
              navigateRoute({ page: 'auth', authMode: 'login' });
            }}
            externalOpenSignal={notifOpenSignal}
          />
        }
      />

      {/* Automatic Browser Notification Permission Onboarding (Case A: default permission) */}
      {idleUiReady && (
        <Suspense fallback={null}>
          <NotificationPermissionOnboarding
            fallbackVapidKey={settings.fcmVapidPublicKey}
            onFlash={showFlash}
          />
        </Suspense>
      )}

      {/* Live Offline / Connection Restored Real-Time Sync Indicator */}
      {(isOffline || justReconnected) && (
        <div
          role="status"
          aria-live="polite"
          className={`border-b-2 px-4 py-2 text-xs font-extrabold ${
            isOffline
              ? 'border-[var(--red)] bg-[var(--surface-2)] text-[var(--red)]'
              : 'border-[var(--green)] bg-[var(--surface-2)] text-[var(--green)]'
          }`}
        >
          <div className="max-w-7xl mx-auto flex items-center justify-center gap-2">
            {isOffline ? (
              <>
                <WifiOff className="w-4 h-4 shrink-0" />
                <span>You are offline — showing cached data. Changes will sync when reconnected.</span>
              </>
            ) : (
              <>
                <Wifi className="w-4 h-4 shrink-0" />
                <span>Connection restored — real-time sync active.</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Optional Admin-Configured Top Platform Notice Banner */}
      {settings.noticeBannerEnabled && settings.noticeBannerText?.trim() && (
        <div
          role="region"
          aria-label="Platform announcement banner"
          className="border-b-2 border-[var(--border-strong)] bg-[#FFD400] text-[#191919] px-4 py-2 text-center text-xs font-extrabold"
        >
          <div className="max-w-7xl mx-auto">{settings.noticeBannerText.trim()}</div>
        </div>
      )}

      {/* Global Toast Notification */}
      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-20 sm:bottom-6 left-4 right-4 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 z-50 max-w-md mx-auto bx-card px-4 py-3 flex items-center gap-2.5 bg-[#FFD400] text-[#191919]"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="text-xs font-extrabold">{toastMsg}</span>
        </div>
      )}

      {/* Contextual Session Continuity Bar (shown ONLY if browser privacy rules blocked silent background renewal) */}
      {!tokenBannerDismissed && (sessionExtendPromptVisible || Boolean(staleSessionNotice)) && (
        <div
          role="region"
          aria-label="Session renewal notice"
          className="border-b-2 border-[var(--orange)] bg-[var(--surface-2)] px-4 py-2.5"
        >
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <AlertCircle className="w-4 h-4 shrink-0 text-[var(--orange)]" />
              <span className="font-bold leading-relaxed">
                {sessionExtendPromptVisible
                  ? 'Keep your active session open — click Extend Session to continue without interruption.'
                  : staleSessionNotice}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleReconnectSession}
                disabled={reconnectingSession}
                className="bx-btn bx-btn-primary bx-btn-sm inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${reconnectingSession ? 'animate-spin' : ''}`} />
                <span>
                  {reconnectingSession
                    ? 'Continuing…'
                    : sessionExtendPromptVisible
                      ? 'Extend Session'
                      : 'Continue Session'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  dismissRecoverableSessionPrompt();
                  setStaleSessionNotice(null);
                  setTokenBannerDismissed(true);
                  setSessionExtendPromptVisible(false);
                }}
                className="bx-icon-btn !w-10 !h-10 sm:!w-8 sm:!h-8"
                aria-label="Dismiss session renewal notice"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Non-Blocking Email Verification Bar for Signed-In Unverified Accounts */}
      {fbUser && !fbUser.emailVerified && !emailBannerDismissed && (
        <div
          role="region"
          aria-label="Email verification status"
          className="border-b-2 border-[var(--border-strong)] bg-[var(--yellow-soft)] px-4 py-2.5"
        >
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-3 text-xs text-[var(--text)]">
            <div className="flex items-center gap-2 min-w-0">
              <MailCheck className="w-4 h-4 shrink-0 text-[var(--orange)]" />
              <span className="font-bold leading-snug">
                <strong>Verify your email ({fbUser.email}):</strong> Check your inbox or Spam folder and click the Firebase verification link.
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleBannerSendVerificationEmail}
                disabled={sendingBannerVerify || verifyCooldownSec > 0}
                className="bx-btn bx-btn-primary bx-btn-sm inline-flex items-center gap-1.5"
              >
                <span>
                  {sendingBannerVerify
                    ? 'Sending…'
                    : verifyCooldownSec > 0
                      ? `Resend in ${verifyCooldownSec}s`
                      : 'Resend Verification Email'}
                </span>
              </button>
              <button
                type="button"
                onClick={handleBannerCheckVerificationStatus}
                disabled={checkingBannerVerify}
                className="bx-btn bx-btn-sm inline-flex items-center gap-1.5"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${checkingBannerVerify ? 'animate-spin' : ''}`} />
                <span>{checkingBannerVerify ? 'Checking…' : "I've Verified — Refresh"}</span>
              </button>
              <button
                type="button"
                onClick={() => setEmailBannerDismissed(true)}
                className="bx-icon-btn !w-10 !h-10 sm:!w-8 sm:!h-8"
                aria-label="Dismiss email verification reminder"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Trust & Safety Standing, Warnings & Account Appeal Center */}
      {fbUser && (
        <Suspense fallback={null}>
          <ModerationStatusBannerAndAppealModal
            currentUser={
              profile || {
                uid: fbUser.uid,
                displayName: fbUser.displayName,
              }
            }
            restriction={moderationStatus?.restriction || firestoreRestriction}
            activeStrikes={moderationStatus?.activeStrikes || []}
            appeals={moderationStatus?.appeals || []}
            myReports={moderationStatus?.myReports || []}
            modalOpen={safetyAppealsModalOpen}
            onOpenModal={() => {
              void refreshModerationStatus();
              setSafetyAppealsModalOpen(true);
            }}
            onCloseModal={() => setSafetyAppealsModalOpen(false)}
            onRefreshStatus={refreshModerationStatus}
          />
        </Suspense>
      )}

      {/* Main Content Area — All Pages Render as Full-Screen Website Views */}
      <main className="flex-1 w-full">
        <Suspense fallback={<PageShellSkeleton label="Loading page…" />}>
        {authAction ? (
          <FirebaseAuthActionModal
            action={authAction}
            onClose={() => setAuthAction(null)}
            onVerifiedEmail={async () => {
              await handleRefreshAuthToken();
              showFlash('Email address verified via Firebase Authentication!');
            }}
            onOpenSignIn={() => {
              setAuthAction(null);
              navigateRoute({ page: 'auth', authMode: 'login' });
            }}
            onOpenForgotPassword={() => {
              setAuthAction(null);
              navigateRoute({ page: 'auth', authMode: 'forgot' });
            }}
          />
        ) : (
          <>
            {/* HOME PAGE */}
            {page === 'home' && (
              <HomePageView
                language={language}
                currency={currency}
                settings={settings}
                searchQuery={searchQuery}
                activeListings={activeListings}
                listingsHydrated={listingsHydrated}
                favoriteListingIds={favoriteListingIds}
                onSearchQueryChange={setSearchQuery}
                onSubmitSearch={() => {
                  void recordRecentSearch({
                    query: searchQuery,
                    platform: appliedFilters.platform !== 'all' ? appliedFilters.platform : '',
                    subcategory:
                      appliedFilters.subcategory !== 'all' ? appliedFilters.subcategory : '',
                    monetization: appliedFilters.monetization,
                    verifiedOnly: appliedFilters.verifiedSeller,
                    sortBy: appliedFilters.sort,
                  });
                  navigateRoute({ page: 'market' });
                }}
                onOpenMarket={(resetFilters) => {
                  if (resetFilters) {
                    setDraftFilters(EMPTY_FILTERS);
                    setAppliedFilters(EMPTY_FILTERS);
                  }
                  navigateRoute({ page: 'market' });
                }}
                onQuickCategorySelect={handleQuickCategorySelect}
                onOpenSell={() => {
                  if (!fbUser) {
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'sell',
                      returnPage: 'home',
                      createdAtMs: Date.now(),
                    });
                  } else {
                    navigateRoute({ page: 'sell' });
                  }
                }}
                onOpenListingDetail={handleOpenListingDetail}
                onOpenPublicProfile={handleOpenPublicProfile}
                onToggleFavorite={(l) => void handleToggleFavorite(l)}
                onActivitiesChange={setPublicActivities}
                onPrefetchRoute={(p) => prefetchRouteView(p)}
              />
            )}

            {/* MARKETPLACE PAGE */}
            {page === 'market' && (
              <MarketplacePageView
                language={language}
                currency={currency}
                settings={settings}
                searchQuery={searchQuery}
                draftFilters={draftFilters}
                appliedFilters={appliedFilters}
                draftMatchCount={draftMatchCount}
                filteredListings={filteredMarketplaceListings}
                activeListingsCount={activeListings.length}
                listingLimit={listingLimit}
                listingsHydrated={listingsHydrated}
                mobileFilterOpen={mobileFilterOpen}
                recentSearches={recentSearches}
                favoriteListingIds={favoriteListingIds}
                onSearchQueryChange={setSearchQuery}
                onSetDraftFilters={setDraftFilters}
                onSetAppliedFilters={setAppliedFilters}
                onSetMobileFilterOpen={setMobileFilterOpen}
                onRecordRecentSearch={() => {
                  void recordRecentSearch({
                    query: searchQuery,
                    platform: draftFilters.platform !== 'all' ? draftFilters.platform : '',
                    subcategory:
                      draftFilters.subcategory !== 'all' ? draftFilters.subcategory : '',
                    monetization: draftFilters.monetization,
                    verifiedOnly: draftFilters.verifiedSeller,
                    sortBy: draftFilters.sort,
                  });
                }}
                onExecuteRecentSearch={handleExecuteRecentSearch}
                onManageRecentSearches={() => navigateRoute({ page: 'recent-searches' })}
                onLoadMoreListings={() => setListingLimit((n) => n + INITIAL_LISTINGS_PAGE_SIZE)}
                onOpenListingDetail={handleOpenListingDetail}
                onOpenPublicProfile={handleOpenPublicProfile}
                onToggleFavorite={(l) => void handleToggleFavorite(l)}
                onOpenSell={() => {
                  if (!fbUser) {
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'sell',
                      returnPage: 'market',
                      createdAtMs: Date.now(),
                    });
                  } else {
                    navigateRoute({ page: 'sell' });
                  }
                }}
                onPrefetchRoute={(p) => prefetchRouteView(p)}
              />
            )}

            {/* FULL-SCREEN LISTING DETAIL & LIVE BIDDING PAGE */}
            {page === 'listing' && (
              <>
                {loadingTargetListing && !resolvedTargetListing ? (
                  <DetailPageSkeleton title="Loading Digital Asset Listing…" />
                ) : !resolvedTargetListing ? (
                  <div className="bx-wrap py-12">
                    <div className="bx-card p-8 max-w-lg mx-auto text-center space-y-4">
                      <AlertCircle className="w-8 h-8 mx-auto text-[#FF6500]" />
                      <h1 className="text-xl font-black">Listing Unavailable</h1>
                      <p className="bx-hint">
                        This digital asset listing could not be found or is no longer publicly available.
                      </p>
                      <button
                        type="button"
                        onClick={() => navigateRoute({ page: 'market' })}
                        className="bx-btn bx-btn-primary"
                      >
                        Browse Marketplace
                      </button>
                    </div>
                  </div>
                ) : (
                  <ListingDetailModal
                    listing={resolvedTargetListing}
                    onClose={() => navigateRoute({ page: 'market' })}
                    userUid={fbUser?.uid ?? null}
                    profile={profile}
                    privateUser={privateUser}
                    settings={settings}
                    displayCurrency={currency}
                    initialDraftBidAmount={
                      resumedBidDraft && resumedBidDraft.listingId === resolvedTargetListing.id
                        ? resumedBidDraft.amount
                        : ''
                    }
                    onStartBuyNowCheckout={(targetListing) => {
                      navigateRoute({ page: 'checkout', checkoutListingId: targetListing.id });
                    }}
                    onStartDealCheckout={(dealId, listingTitle) => {
                      if (!fbUser) {
                        requireAuthWithIntent({
                          kind: 'pay_deal',
                          dealId,
                          listingTitle,
                          returnPage: 'listing',
                          createdAtMs: Date.now(),
                        });
                        return;
                      }
                      navigateRoute({ page: 'checkout', checkoutDealId: dealId });
                    }}
                    onRequireAuthForBuyNow={(targetListing) => {
                      requireAuthWithIntent({
                        kind: 'buy_now',
                        listingId: targetListing.id,
                        listingTitle: targetListing.title,
                        returnPage: 'listing',
                        createdAtMs: Date.now(),
                      });
                    }}
                    onRequireAuthForBid={(targetListing, draftBidAmount) => {
                      if (draftBidAmount) {
                        setResumedBidDraft({
                          listingId: targetListing.id,
                          amount: draftBidAmount,
                        });
                      }
                      requireAuthWithIntent({
                        kind: 'place_bid',
                        listingId: targetListing.id,
                        listingTitle: targetListing.title,
                        draftBidAmount,
                        currency: targetListing.currency,
                        returnPage: 'listing',
                        createdAtMs: Date.now(),
                      });
                    }}
                    onRequireAuthForChat={(targetUid, targetName, targetListing) => {
                      requireAuthWithIntent({
                        kind: 'message_seller',
                        targetUid,
                        targetName,
                        listingId: targetListing.id,
                        listingTitle: targetListing.title,
                        returnPage: 'listing',
                        createdAtMs: Date.now(),
                      });
                    }}
                    onStartChatWithUser={(targetUid, targetName, targetListing) =>
                      handleStartChatWithUser(targetUid, targetName, targetListing)
                    }
                    onOpenPublicProfile={handleOpenPublicProfile}
                    onDealOpened={(dealId, msg) => {
                      showFlash(msg);
                      navigateRoute({ page: 'deals', dealId });
                    }}
                    onFlash={showFlash}
                    isFavorited={favoriteListingIds.has(resolvedTargetListing.id)}
                    onToggleFavorite={(l) => void handleToggleFavorite(l)}
                    isFollowingSeller={followedSellerIds.has(resolvedTargetListing.sellerId)}
                    sellerFollowerCount={listingSellerFollowerCount}
                    onToggleFollowSeller={(s) => void handleToggleFollowSeller(s)}
                    onReportListingOrSeller={(target) => setReportModalTarget(target)}
                    onEditListing={(targetListing) =>
                      navigateRoute({ page: 'sell', editListingId: targetListing.id })
                    }
                    onListingDeleted={() => navigateRoute({ page: 'profile', profileTab: 'listings' })}
                    onViewCountUpdated={handleListingViewCountUpdated}
                  />
                )}
              </>
            )}

            {/* FULL-SCREEN ESCROW CHECKOUT & MULTI-GATEWAY PURCHASE PAGE */}
            {page === 'checkout' && (
              <CheckoutView
                mode={route.checkoutDealId ? 'accepted_bid_deal' : 'buy_now'}
                listing={
                  route.checkoutDealId ? resolvedDealAssociatedListing : resolvedTargetListing
                }
                deal={route.checkoutDealId ? resolvedCheckoutDeal : null}
                loadingTarget={
                  route.checkoutDealId
                    ? !authReady || loadingTargetDeal
                    : loadingTargetListing
                }
                userUid={fbUser?.uid ?? null}
                profile={profile}
                privateUser={privateUser}
                settings={settings}
                displayCurrency={currency}
                wpReturnSessionId={wpReturnSessionId}
                spReturnSessionId={spReturnSessionId}
                spPaymentStatus={spPaymentStatus}
                spTransactionId={spTransactionId}
                onBack={() => {
                  if (route.checkoutDealId) {
                    navigateRoute({ page: 'deals', dealId: route.checkoutDealId });
                  } else if (route.checkoutListingId) {
                    navigateRoute({ page: 'listing', listingId: route.checkoutListingId });
                  } else {
                    navigateRoute({ page: 'market' });
                  }
                }}
                onRequireAuthForCheckout={() => {
                  if (route.checkoutDealId) {
                    requireAuthWithIntent({
                      kind: 'pay_deal',
                      dealId: route.checkoutDealId,
                      listingTitle: resolvedCheckoutDeal?.listingTitle || 'Reserved Asset',
                      returnPage: 'checkout',
                      createdAtMs: Date.now(),
                    });
                  } else if (route.checkoutListingId) {
                    requireAuthWithIntent({
                      kind: 'buy_now',
                      listingId: route.checkoutListingId,
                      listingTitle: resolvedTargetListing?.title || 'Selected Asset',
                      returnPage: 'listing',
                      createdAtMs: Date.now(),
                    });
                  } else {
                    navigateRoute({ page: 'auth', authMode: 'login' });
                  }
                }}
                onOpenWalletForTopUp={() => {
                  if (!fbUser) {
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'wallet',
                      returnPage: 'checkout',
                      createdAtMs: Date.now(),
                    });
                    return;
                  }
                  setWalletReturnRoute({
                    checkoutListingId: route.checkoutListingId,
                    checkoutDealId: route.checkoutDealId,
                  });
                  navigateRoute({ page: 'wallet' });
                }}
                onDealFunded={(dealId, msg) => {
                  setWalletReturnRoute(null);
                  setWpReturnSessionId(null);
                  showFlash(msg);
                  navigateRoute({ page: 'deals', dealId });
                }}
                onFlash={showFlash}
              />
            )}

            {/* FULL-SCREEN AUTHENTICATION PAGE */}
            {page === 'auth' && (
              <AuthModal
                initialMode={route.authMode || 'login'}
                pendingIntent={pendingAuthIntent}
                onModeChange={(nextMode) => {
                  navigateRoute(
                    { page: 'auth', authMode: nextMode },
                    { replace: true, preserveScroll: true }
                  );
                }}
                onClose={handleCloseAuthPage}
                onSuccess={(msg) => {
                  showFlash(msg);
                }}
              />
            )}

            {/* FULL-SCREEN WALLET PAGE */}
            {page === 'wallet' && (
              <>
                {shouldShowProtectedRouteLoading({
                  authReady,
                  signingOut,
                  hasFbUser: Boolean(fbUser),
                  needsProfile: true,
                  hasProfile: Boolean(profile),
                  needsPrivateUser: true,
                  hasPrivateUser: Boolean(privateUser),
                }) ? (
                  <PageShellSkeleton label="Loading your BEXORA Wallet…" />
                ) : !fbUser || !profile || !privateUser ? (
                  <div className="bx-wrap py-12">
                    <div className="bx-card p-8 max-w-md mx-auto text-center space-y-4">
                      <div className="flex justify-center">
                        <BexoraLogo compact />
                      </div>
                      <h1 className="text-xl font-black">Sign in to open your BEXORA Wallet</h1>
                      <p className="bx-hint">
                        Add balance, manage escrow funds, and track verified deposits and withdrawals.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          requireAuthWithIntent({
                            kind: 'open_page',
                            targetPage: 'wallet',
                            returnPage: 'home',
                            createdAtMs: Date.now(),
                          })
                        }
                        className="bx-btn bx-btn-primary w-full justify-center"
                      >
                        Sign In / Create Account
                      </button>
                    </div>
                  </div>
                ) : (
                  <WalletModal
                    onClose={() => navigateRoute({ page: 'market' })}
                    returnToCheckoutLabel={
                      walletReturnRoute ? 'Return to Saved Checkout' : null
                    }
                    onReturnToCheckout={
                      walletReturnRoute
                        ? () => {
                            const ret = walletReturnRoute;
                            setWalletReturnRoute(null);
                            navigateRoute({
                              page: 'checkout',
                              checkoutListingId: ret.checkoutListingId,
                              checkoutDealId: ret.checkoutDealId,
                            });
                          }
                        : undefined
                    }
                    userUid={fbUser.uid}
                    profile={profile}
                    privateUser={privateUser}
                    settings={settings}
                    deposits={deposits}
                    withdrawals={withdrawals}
                    deals={deals}
                    displayCurrency={currency}
                    moderationRestriction={moderationStatus?.restriction || firestoreRestriction}
                    onOpenSafetyAppeals={() => {
                      void refreshModerationStatus();
                      setSafetyAppealsModalOpen(true);
                    }}
                    initialMode={walletInitialMode}
                    pendingTopupSessionId={spTopupSessionId}
                    pendingTopupStatus={spPaymentStatus}
                    pendingTopupTransactionId={spTransactionId}
                    onClearTopupReturn={() => {
                      setSpTopupSessionId(null);
                      setSpPaymentStatus(null);
                      setSpTransactionId(null);
                      const url = new URL(window.location.href);
                      url.searchParams.delete('sp_topup_session');
                      url.searchParams.delete('payment_status');
                      url.searchParams.delete('transaction_id');
                      url.searchParams.delete('transactionId');
                      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
                    }}
                    onFlash={showFlash}
                  />
                )}
              </>
            )}

            {/* FULL-SCREEN SELL ASSET PAGE */}
            {page === 'sell' && (
              <>
                {shouldShowProtectedRouteLoading({
                  authReady,
                  signingOut,
                  hasFbUser: Boolean(fbUser),
                  needsProfile: true,
                  hasProfile: Boolean(profile),
                }) ? (
                  <PageShellSkeleton label="Preparing Seller Listing Studio…" />
                ) : !fbUser || !profile ? (
                  <div className="bx-wrap py-12">
                    <div className="bx-card p-8 max-w-md mx-auto text-center space-y-4">
                      <div className="flex justify-center">
                        <BexoraLogo compact />
                      </div>
                      <h1 className="text-xl font-black">Sign in to Sell a Digital Asset</h1>
                      <p className="bx-hint">
                        Publish verified YouTube channels, Facebook pages, websites, domains, and gaming accounts with BEXORA 3-party Escrow protection.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          requireAuthWithIntent({
                            kind: 'open_page',
                            targetPage: 'sell',
                            returnPage: 'home',
                            createdAtMs: Date.now(),
                          })
                        }
                        className="bx-btn bx-btn-primary w-full justify-center"
                      >
                        Sign In / Create Account
                      </button>
                    </div>
                  </div>
                ) : (
                  <CreateListingModal
                    onClose={() => navigateRoute({ page: route.editListingId ? 'profile' : 'market' })}
                    userUid={fbUser.uid}
                    profile={profile}
                    settings={settings}
                    editingListing={
                      route.editListingId
                        ? myListings.find((l) => l.id === route.editListingId) || null
                        : null
                    }
                    onRequireAuth={() =>
                      requireAuthWithIntent({
                        kind: 'open_page',
                        targetPage: 'sell',
                        returnPage: 'sell',
                        createdAtMs: Date.now(),
                      })
                    }
                    onCreated={(msg) => {
                      showFlash(msg);
                      navigateRoute({ page: 'profile' });
                    }}
                  />
                )}
              </>
            )}

            {/* TOP SELLERS PAGE */}
            {page === 'sellers' && (
              <TopSellersView
                onOpenPublicProfile={handleOpenPublicProfile}
                viewerUid={fbUser?.uid ?? null}
                followedSellerIds={followedSellerIds}
                onToggleFollowSeller={(seller) => void handleToggleFollowSeller(seller)}
              />
            )}

            {/* FAVORITES PAGE */}
            {page === 'favorites' &&
              (shouldShowProtectedRouteLoading({
                authReady,
                signingOut,
                hasFbUser: Boolean(fbUser),
              }) ? (
                <PageShellSkeleton label="Loading your Favorites…" />
              ) : (
                <FavoritesView
                  userUid={fbUser?.uid ?? null}
                  favorites={favorites}
                  liveListings={activeListings}
                  displayCurrency={currency}
                  usdToBdtRate={settings.usdToBdtRate}
                  onOpenListingById={(listingId) =>
                    navigateRoute({ page: 'listing', listingId })
                  }
                  onOpenPublicProfile={handleOpenPublicProfile}
                  onRemoveFavorite={handleRemoveFavoriteById}
                  onBrowseMarketplace={() => navigateRoute({ page: 'market' })}
                  onRequireAuth={() =>
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'favorites',
                      returnPage: 'favorites',
                      createdAtMs: Date.now(),
                    })
                  }
                />
              ))}

            {/* MY BIDS PAGE */}
            {page === 'my-bids' &&
              (shouldShowProtectedRouteLoading({
                authReady,
                signingOut,
                hasFbUser: Boolean(fbUser),
              }) ? (
                <PageShellSkeleton label="Loading your Bids…" />
              ) : (
                <MyBidsView
                  userUid={fbUser?.uid ?? null}
                  liveListings={activeListings}
                  displayCurrency={currency}
                  usdToBdtRate={settings.usdToBdtRate}
                  onOpenListingById={(listingId) =>
                    navigateRoute({ page: 'listing', listingId })
                  }
                  onOpenPublicProfile={handleOpenPublicProfile}
                  onOpenDealRoom={(dealId) => navigateRoute({ page: 'deals', dealId })}
                  onStartDealCheckout={(dealId, listingTitle) => {
                    if (!fbUser) {
                      requireAuthWithIntent({
                        kind: 'pay_deal',
                        dealId,
                        listingTitle,
                        returnPage: 'my-bids',
                        createdAtMs: Date.now(),
                      });
                      return;
                    }
                    navigateRoute({ page: 'checkout', checkoutDealId: dealId });
                  }}
                  onBrowseMarketplace={() => navigateRoute({ page: 'market' })}
                  onRequireAuth={() =>
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'my-bids',
                      returnPage: 'my-bids',
                      createdAtMs: Date.now(),
                    })
                  }
                  onFlash={showFlash}
                />
              ))}

            {/* FOLLOWING SELLERS PAGE */}
            {page === 'following' &&
              (shouldShowProtectedRouteLoading({
                authReady,
                signingOut,
                hasFbUser: Boolean(fbUser),
              }) ? (
                <PageShellSkeleton label="Loading Followed Sellers…" />
              ) : (
                <FollowingView
                  userUid={fbUser?.uid ?? null}
                  follows={followedSellers}
                  liveListings={activeListings}
                  favoriteListingIds={favoriteListingIds}
                  displayCurrency={currency}
                  usdToBdtRate={settings.usdToBdtRate}
                  onOpenPublicProfile={handleOpenPublicProfile}
                  onUnfollowSeller={handleUnfollowSellerById}
                  onOpenListing={handleOpenListingDetail}
                  onToggleFavorite={(l) => void handleToggleFavorite(l)}
                  onExploreTopSellers={() => navigateRoute({ page: 'sellers' })}
                  onRequireAuth={() =>
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'following',
                      returnPage: 'following',
                      createdAtMs: Date.now(),
                    })
                  }
                />
              ))}

            {/* PRE-DEAL MESSENGER CHAT PAGE */}
            {page === 'chat' &&
              (shouldShowProtectedRouteLoading({
                authReady,
                signingOut,
                hasFbUser: Boolean(fbUser),
                needsProfile: true,
                hasProfile: Boolean(profile),
              }) ? (
                <PageShellSkeleton label="Loading Pre-Deal Messenger…" />
              ) : (
                <ChatView
                  userUid={fbUser?.uid ?? null}
                  profile={profile}
                  conversations={conversations}
                  initialConvId={route.convId || null}
                  onOpenPublicProfile={handleOpenPublicProfile}
                  onRequireAuth={() =>
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'chat',
                      convId: route.convId,
                      returnPage: 'chat',
                      createdAtMs: Date.now(),
                    })
                  }
                  onReportConversation={(target) => setReportModalTarget(target)}
                  onFlash={showFlash}
                />
              ))}

            {/* ESCROW DEALS PAGE */}
            {page === 'deals' &&
              (shouldShowProtectedRouteLoading({
                authReady,
                signingOut,
                hasFbUser: Boolean(fbUser),
                needsProfile: true,
                hasProfile: Boolean(profile),
                needsPrivateUser: true,
                hasPrivateUser: Boolean(privateUser),
              }) ? (
                <PageShellSkeleton label="Loading Escrow Deal Rooms…" />
              ) : (
                <DealsView
                  userUid={fbUser?.uid ?? null}
                  profile={profile}
                  privateUser={privateUser}
                  deals={deals}
                  initialDealId={route.dealId || null}
                  settings={settings}
                  displayCurrency={currency}
                  onOpenPublicProfile={handleOpenPublicProfile}
                  onRequireAuth={() =>
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'deals',
                      dealId: route.dealId,
                      returnPage: 'deals',
                      createdAtMs: Date.now(),
                    })
                  }
                  onOpenWallet={() => {
                    setWalletReturnRoute(null);
                    navigateRoute({ page: 'wallet' });
                  }}
                  onOpenDealCheckout={(dealId) => {
                    navigateRoute({ page: 'checkout', checkoutDealId: dealId });
                  }}
                  onReportDealCounterparty={(target) => setReportModalTarget(target)}
                  onFlash={showFlash}
                />
              ))}

            {/* OWNER PROFILE PAGE */}
            {page === 'profile' && (
              <>
                {shouldShowProtectedRouteLoading({
                  authReady,
                  signingOut,
                  hasFbUser: Boolean(fbUser),
                  needsProfile: true,
                  hasProfile: Boolean(profile),
                  needsPrivateUser: true,
                  hasPrivateUser: Boolean(privateUser),
                }) ? (
                  <PageShellSkeleton label="Loading your BEXORA Profile…" />
                ) : !fbUser || !profile || !privateUser ? (
                  <div className="max-w-md mx-auto px-4 py-14">
                    <div className="bx-card p-8 text-center space-y-4">
                      <div className="flex justify-center">
                        <BexoraLogo compact />
                      </div>
                      <h1 className="text-xl font-black">Sign in to manage your BEXORA Profile</h1>
                      <p className="text-xs opacity-80">
                        Access your listings, wallet balance, email &amp; phone verification, password security, and private NID verification.
                      </p>
                      <button
                        type="button"
                        onClick={() =>
                          requireAuthWithIntent({
                            kind: 'open_page',
                            targetPage: 'profile',
                            returnPage: 'profile',
                            createdAtMs: Date.now(),
                          })
                        }
                        className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold"
                      >
                        Sign In / Create Account
                      </button>
                    </div>
                  </div>
                ) : (
                  <ProfileView
                    mode="owner"
                    userUid={fbUser.uid}
                    profile={profile}
                    privateUser={privateUser}
                    myListings={myListings}
                    myBids={myBids}
                    activeListings={activeListings}
                    favorites={favorites}
                    followedSellers={followedSellers}
                    deals={deals}
                    unreadNotificationCount={unreadNotificationCount}
                    favoriteListingIds={favoriteListingIds}
                    onToggleFavorite={(l) => void handleToggleFavorite(l)}
                    displayCurrency={currency}
                    usdToBdtRate={settings.usdToBdtRate}
                    onOpenListing={handleOpenListingDetail}
                    onEditListing={(listing) =>
                      navigateRoute({ page: 'sell', editListingId: listing.id })
                    }
                    onOpenListingById={(listingId) =>
                      navigateRoute({ page: 'listing', listingId })
                    }
                    onOpenDeal={(dealId) => {
                      navigateRoute({ page: 'deals', dealId });
                    }}
                    onOpenFavoritesPage={() => navigateRoute({ page: 'favorites' })}
                    onOpenMyBidsPage={() => navigateRoute({ page: 'my-bids' })}
                    onOpenFollowingPage={() => navigateRoute({ page: 'following' })}
                    onOpenDealsPage={() => navigateRoute({ page: 'deals' })}
                    onOpenNotificationCenter={() => setNotifOpenSignal((n) => n + 1)}
                    onOpenWallet={() => {
                      setWalletReturnRoute(null);
                      navigateRoute({ page: 'wallet' });
                    }}
                    onOpenPublicSelf={() => handleOpenPublicProfile(fbUser.uid)}
                    onOpenPublicProfile={handleOpenPublicProfile}
                    pendingAdminInvitation={pendingAdminInvitation}
                    onOpenSafetyAndAppeals={() => {
                      void refreshModerationStatus();
                      setSafetyAppealsModalOpen(true);
                    }}
                    onLogout={handleLogout}
                    signingOut={signingOut}
                    onAuthTokenRefreshed={handleRefreshAuthToken}
                    onFlash={showFlash}
                    initialTab={route.profileTab}
                  />
                )}
              </>
            )}

            {/* PUBLIC VISITOR PROFILE PAGE */}
            {page === 'public-profile' && route.sellerUid && (
              <ProfileView
                mode="visitor"
                targetUid={route.sellerUid}
                viewerUid={fbUser?.uid ?? null}
                isFollowingSeller={followedSellerIds.has(route.sellerUid)}
                onToggleFollowSeller={(s) => void handleToggleFollowSeller(s)}
                favoriteListingIds={favoriteListingIds}
                onToggleFavorite={(l) => void handleToggleFavorite(l)}
                displayCurrency={currency}
                usdToBdtRate={settings.usdToBdtRate}
                onBack={() => navigateRoute({ page: 'market' })}
                onOpenListing={handleOpenListingDetail}
                onOpenPublicProfile={handleOpenPublicProfile}
                onMessageSeller={(sellerUid, sellerName, listing) =>
                  handleStartChatWithUser(sellerUid, sellerName, listing)
                }
                onReportUser={(target) => setReportModalTarget(target)}
              />
            )}

            {/* ADMIN CONSOLE PAGE */}
            {page === 'admin' && (
              <>
                {shouldShowProtectedRouteLoading({
                  authReady,
                  signingOut,
                  hasFbUser: Boolean(fbUser),
                  needsProfileBootstrapped: true,
                  profileBootstrapped,
                }) || (Boolean(fbUser) && (adminRoleStatus === 'checking' || adminRoleStatus === 'idle')) ? (
                  <div className="bx-wrap py-8">
                    <DashboardStatsSkeleton cards={6} />
                  </div>
                ) : fbUser && adminRoleStatus === 'error' && !isAdmin ? (
                  <div className="max-w-lg mx-auto px-4 py-14">
                    <div className="bx-card p-8 text-center space-y-3">
                      <AlertCircle className="w-8 h-8 text-amber-600 mx-auto" />
                      <h1 className="text-xl font-black">Unable to Verify Admin Permissions</h1>
                      <p className="text-xs opacity-80">
                        {adminRoleError || 'A temporary network or authentication check prevented loading your admin role.'}
                      </p>
                      <div className="flex flex-wrap justify-center gap-2.5 pt-1">
                        <button
                          type="button"
                          onClick={() => setAdminAccessRetryEpoch((n) => n + 1)}
                          className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                        >
                          <RefreshCw className="w-3.5 h-3.5" />
                          Retry Verification
                        </button>
                        <button
                          type="button"
                          onClick={() => navigateRoute({ page: 'home' })}
                          className="bx-btn px-5 py-2 text-xs font-extrabold"
                        >
                          Return Home
                        </button>
                      </div>
                    </div>
                  </div>
                ) : !fbUser || !isAdmin ? (
                  <div className="max-w-lg mx-auto px-4 py-14">
                    <div className="bx-card p-8 text-center space-y-3">
                      <Lock className="w-8 h-8 text-red-600 mx-auto" />
                      <h1 className="text-xl font-black">Administrator Access Required</h1>
                      <p className="text-xs opacity-80">
                        This console is restricted to verified BEXORA Administrators and the bootstrapped Superadmin account.
                      </p>
                      <div className="flex flex-wrap justify-center gap-2.5 pt-1">
                        {!fbUser && (
                          <button
                            type="button"
                            onClick={() =>
                              requireAuthWithIntent({
                                kind: 'open_page',
                                targetPage: 'admin',
                                dealId: route.dealId,
                                returnPage: 'home',
                                createdAtMs: Date.now(),
                              })
                            }
                            className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold"
                          >
                            Sign In as Administrator
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => navigateRoute({ page: 'home' })}
                          className="bx-btn px-5 py-2 text-xs font-extrabold"
                        >
                          Return Home
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <AdminErrorBoundary
                    onRetry={() => setAdminAccessRetryEpoch((n) => n + 1)}
                    onBackHome={() => navigateRoute({ page: 'home' })}
                  >
                    <Suspense
                      fallback={
                        <div className="bx-wrap py-8">
                          <DashboardStatsSkeleton cards={6} />
                        </div>
                      }
                    >
                      <AdminDashboard
                        adminUid={fbUser.uid}
                        isSuperAdmin={adminRole === 'superadmin'}
                        settings={settings}
                        displayCurrency={currency}
                        initialDealId={route.dealId || null}
                        onOpenPublicProfile={handleOpenPublicProfile}
                        onFlash={showFlash}
                      />
                    </Suspense>
                  </AdminErrorBoundary>
                )}
              </>
            )}
            {/* RECENT SEARCHES PAGE */}
            {page === 'recent-searches' && (
              <RecentSearchesView
                isAuthenticated={Boolean(fbUser)}
                recentSearches={recentSearches}
                onExecuteRecentSearch={handleExecuteRecentSearch}
                onDeleteRecentSearch={handleDeleteRecentSearch}
                onClearAllRecentSearches={handleClearAllRecentSearches}
                onBrowseCategory={handleQuickCategorySelect}
                onBrowseMarketplace={() => navigateRoute({ page: 'market' })}
              />
            )}

            {/* REVIEWS & RATINGS PAGE */}
            {page === 'reviews' && (
              <ReviewsView
                userUid={fbUser?.uid ?? null}
                userEmailVerified={Boolean(fbUser?.emailVerified || privateUser?.emailVerified)}
                userDisplayName={profile?.displayName || fbUser?.displayName || 'Member'}
                isAdmin={isAdmin}
                onOpenPublicProfile={handleOpenPublicProfile}
                onOpenDealsPage={() => navigateRoute({ page: 'deals' })}
                onBrowseMarketplace={() => navigateRoute({ page: 'market' })}
                onRequireAuth={() =>
                  requireAuthWithIntent({
                    kind: 'open_page',
                    targetPage: 'reviews',
                    returnPage: 'reviews',
                    createdAtMs: Date.now(),
                  })
                }
                onReportReviewer={(target) => setReportModalTarget(target)}
                onFlash={showFlash}
              />
            )}

            {/* TRUST, SAFETY & LEGAL POLICY CENTER */}
            {page === 'info' && (
              <InfoCenterView
                activeTopic={route.infoTopic || 'escrow-protection'}
                settings={settings}
                onSelectTopic={(topic: InfoTopicId) =>
                  navigateRoute({ page: 'info', infoTopic: topic })
                }
                onBrowseMarketplace={() => navigateRoute({ page: 'market' })}
                onOpenSellAsset={() => {
                  if (!fbUser) {
                    requireAuthWithIntent({
                      kind: 'open_page',
                      targetPage: 'sell',
                      returnPage: 'info',
                      createdAtMs: Date.now(),
                    });
                  } else {
                    navigateRoute({ page: 'sell' });
                  }
                }}
                onOpenDealsPage={() => navigateRoute({ page: 'deals' })}
              />
            )}
          </>
        )}
        </Suspense>
      </main>

      {/* Complete Data-Driven Marketplace Footer */}
      <MarketplaceFooter
        settings={settings}
        activeListings={activeListings}
        publicActivities={publicActivities}
        isAuthenticated={Boolean(fbUser)}
        isPwaInstalled={pwa.isInstalled}
        onTriggerPwaInstall={() => pwa.triggerInstall()}
        onNavigateHome={() => navigateRoute({ page: 'home' })}
        onBrowseMarketplace={() => {
          setDraftFilters(EMPTY_FILTERS);
          setAppliedFilters(EMPTY_FILTERS);
          navigateRoute({ page: 'market' });
        }}
        onBrowseCategory={handleQuickCategorySelect}
        onOpenTopSellers={() => navigateRoute({ page: 'sellers' })}
        onOpenFavorites={() => navigateRoute({ page: 'favorites' })}
        onOpenMyListings={() => {
          if (!fbUser) {
            requireAuthWithIntent({
              kind: 'open_page',
              targetPage: 'profile',
              returnPage: 'home',
              createdAtMs: Date.now(),
            });
          } else {
            navigateRoute({ page: 'profile', profileTab: 'listings' });
          }
        }}
        onOpenMyBids={() => navigateRoute({ page: 'my-bids' })}
        onOpenFollowing={() => navigateRoute({ page: 'following' })}
        onOpenSellAsset={() => {
          if (!fbUser) {
            requireAuthWithIntent({
              kind: 'open_page',
              targetPage: 'sell',
              returnPage: 'home',
              createdAtMs: Date.now(),
            });
          } else {
            navigateRoute({ page: 'sell' });
          }
        }}
        onOpenRecentSearches={() => navigateRoute({ page: 'recent-searches' })}
        onOpenReviews={() => navigateRoute({ page: 'reviews' })}
        onOpenInfoTopic={(topic) => navigateRoute({ page: 'info', infoTopic: topic })}
      />

      {/* Mobile Bottom Nav */}
      <BottomNav
        page={page}
        onNavigate={navigatePage}
        onPrefetchRoute={prefetchRouteView}
        language={language}
        cachedUser={cachedUser}
        hasCachedUser={Boolean(cachedUser)}
        authStatus={navbarAuthStatus}
      />

      {/* Floating Support Widget */}
      {idleUiReady && (
        <Suspense fallback={null}>
          <FloatingSupportWidget settings={settings} />
        </Suspense>
      )}

      {/* Smart PWA Install Banner & Guide */}
      {idleUiReady && (
        <Suspense fallback={null}>
          <PWAInstallBanner
            showBanner={pwa.showDelayedBanner}
            showManualGuide={pwa.showManualGuide}
            isIOS={pwa.isIOS}
            onInstall={() => pwa.triggerInstall()}
            onDismissBanner={pwa.dismissBanner}
            onCloseManualGuide={() => pwa.setShowManualGuide(false)}
          />
        </Suspense>
      )}

      {/* Confidential User-to-User Trust & Safety Report Modal */}
      {reportModalTarget && (
        <Suspense fallback={null}>
          <ReportUserModal
            target={reportModalTarget}
            currentUser={
              fbUser
                ? profile || {
                    uid: fbUser.uid,
                    displayName: fbUser.displayName,
                  }
                : null
            }
            onClose={() => setReportModalTarget(null)}
            onRequireAuth={() => {
              setReportModalTarget(null);
              navigateRoute({ page: 'auth', authMode: 'login' });
            }}
            onSubmitted={(referenceCode) => {
              void refreshModerationStatus();
              showFlash(`Confidential report submitted (${referenceCode}).`);
            }}
          />
        </Suspense>
      )}

      {/* Global & Targeted Popup Notification Campaigns */}
      <Suspense fallback={null}>
        <PopupNotificationHost
          userUid={fbUser?.uid ?? null}
          onNavigateDestination={(destination) => {
            const cleaned = String(destination || '').trim();
            if (!cleaned || cleaned === '/') {
              navigateRoute({ page: 'home' });
              return;
            }
            if (cleaned.startsWith('/info/')) {
              const topic = cleaned.slice('/info/'.length).split(/[?#]/)[0] as InfoTopicId;
              navigateRoute({ page: 'info', infoTopic: topic || 'escrow-protection' });
              return;
            }
            if (cleaned.startsWith('/listing/')) {
              const listingId = sanitizeRouteId(cleaned.slice('/listing/'.length).split(/[?#]/)[0]);
              if (listingId) {
                navigateRoute({ page: 'listing', listingId });
                return;
              }
            }
            const routeSlug = cleaned.replace(/^\/+/, '').split(/[?#]/)[0];
            const routeMap: Record<string, AppRouteState> = {
              market: { page: 'market' },
              marketplace: { page: 'market' },
              sell: { page: 'sell' },
              deals: { page: 'deals' },
              wallet: { page: 'wallet' },
              messages: { page: 'chat' },
              chat: { page: 'chat' },
              profile: { page: 'profile' },
              sellers: { page: 'sellers' },
              favorites: { page: 'favorites' },
              'my-bids': { page: 'my-bids' },
              following: { page: 'following' },
              reviews: { page: 'reviews' },
              'recent-searches': { page: 'recent-searches' },
              admin: { page: 'admin' },
            };
            const matched = routeMap[routeSlug];
            if (matched) {
              navigateRoute(matched);
            } else {
              navigateRoute({ page: 'market' });
            }
          }}
        />
      </Suspense>
    </div>
  );
}
