import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import {
  collection,
  doc,
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
  ArrowRight,
  CheckCircle2,
  Filter,
  Lock,
  MailCheck,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react';
import {
  AnnouncementRecord,
  BidRecord,
  ConversationRecord,
  CurrencyCode,
  DealRecord,
  DepositRequestRecord,
  LanguageCode,
  MarketplaceListing,
  NotificationRecord,
  PlatformId,
  PrivateUser,
  PublicProfile,
  PublicSettings,
  ThemeMode,
  UserNotificationPreferences,
  WithdrawalRequestRecord,
} from './types';
import {
  attemptSilentGoogleSessionRefresh,
  auth,
  BOOTSTRAPPED_SUPERADMIN_EMAIL,
  consumeStaleTokenSessionClearedNotice,
  db,
  detectFirebaseAuthCapabilities,
  ensureUserProfileInitialized,
  extendCurrentUserSessionInteractive,
  extractUserFacingFirestoreError,
  FirebaseAuthCapabilities,
  formatFirebaseAuthError,
  isTokenServiceDisabledError,
  prepareFirestoreAuthSession,
  recoverFirestoreFromTokenServiceError,
  safeRefreshCurrentUserToken,
  safeSendEmailVerification,
  syncProactiveRefreshWithCapabilities,
  testFirestoreConnection,
} from './lib/firebase';
import {
  computeSessionRenewalSchedule,
  DEFAULT_PUBLIC_SETTINGS,
  getProtectionDurationHours,
  PLATFORM_CATALOG,
  PLATFORM_LIST,
} from './lib/marketplaceLogic';
import {
  evaluateDealDeadlineNotification,
  SafeInternalDestination,
  sanitizeNotificationDestination,
  sortNotificationsNewestFirst,
} from './lib/notificationLogic';
import {
  emitDealAdminNotification,
  emitUserNotification,
  markAllNotificationsReadInFirestore,
  markLocalAnnouncementRead,
  markNotificationReadInFirestore,
  mergeAnnouncementsIntoFeed,
} from './lib/notificationService';
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
import { isRtlLanguage, t } from './lib/i18n';
import { usePWAInstall } from './hooks/usePWAInstall';
import { BexoraLogo, PlatformIcon } from './components/Icons';
import { BottomNav, Navbar, NavPage } from './components/Navbar';
import { AuthModal } from './components/AuthModal';
import {
  FirebaseAuthActionModal,
  FirebaseAuthActionParams,
} from './components/FirebaseAuthActionModal';
import { ListingCard } from './components/ListingCard';
import {
  EMPTY_FILTERS,
  FilterPanel,
  MarketplaceFilterState,
} from './components/FilterPanel';
import { CreateListingModal } from './components/CreateListingModal';
import { ListingDetailModal } from './components/ListingDetailModal';
import { ChatView } from './components/ChatView';
import { DealsView } from './components/DealsView';
import { WalletModal } from './components/WalletModal';
import { ProfileView } from './components/ProfileView';
import { TopSellersView } from './components/TopSellersView';
import { AdminDashboard } from './components/AdminDashboard';
import { FloatingSupportWidget } from './components/FloatingSupportWidget';
import { PWAInstallBanner } from './components/PWAInstallBanner';
import { NotificationCenter } from './components/NotificationCenter';

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

  // Navigation & Modal State
  const [page, setPage] = useState<NavPage>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('autostart') === '1') return 'market';
    return 'home';
  });
  const [publicProfileTargetUid, setPublicProfileTargetUid] = useState<string | null>(null);
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authModalInitialMode, setAuthModalInitialMode] = useState<'login' | 'register' | 'forgot'>('login');
  const [authAction, setAuthAction] = useState<FirebaseAuthActionParams | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const mode = params.get('mode');
    const oobCode = params.get('oobCode');
    if ((mode === 'verifyEmail' || mode === 'resetPassword') && oobCode) {
      return { mode, oobCode };
    }
    return null;
  });
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [selectedListing, setSelectedListing] = useState<MarketplaceListing | null>(null);
  const [initialConvId, setInitialConvId] = useState<string | null>(null);
  const [initialDealId, setInitialDealId] = useState<string | null>(null);
  const [adminInitialDealId, setAdminInitialDealId] = useState<string | null>(null);
  const [mobileFilterOpen, setMobileFilterOpen] = useState(false);
  const [pendingDeepLinkRaw, setPendingDeepLinkRaw] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('dest');
  });

  // Unlock HTML5 Audio playback on first user interaction in accordance with browser autoplay policy
  useEffect(() => {
    attachAudioUnlockListeners();
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
      url.searchParams.delete('dest');
      mutated = true;
    }
    if (mutated) {
      window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
    }
  }, [authAction]);

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
  const [fbUser, setFbUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profileBootstrapped, setProfileBootstrapped] = useState(false);
  const [authTokenEpoch, setAuthTokenEpoch] = useState(0);
  const [signingOut, setSigningOut] = useState(false);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [privateUser, setPrivateUser] = useState<PrivateUser | null>(null);
  const [adminRole, setAdminRole] = useState<'none' | 'admin' | 'superadmin'>('none');

  // Public & Authenticated Data State
  const [settings, setSettings] = useState<PublicSettings>(DEFAULT_PUBLIC_SETTINGS);
  const [activeListings, setActiveListings] = useState<MarketplaceListing[]>([]);
  const [myListings, setMyListings] = useState<MarketplaceListing[]>([]);
  const [myBids, setMyBids] = useState<BidRecord[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [deals, setDeals] = useState<DealRecord[]>([]);
  const [deposits, setDeposits] = useState<DepositRequestRecord[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalRequestRecord[]>([]);
  const [personalNotifications, setPersonalNotifications] = useState<NotificationRecord[]>([]);
  const [activeAnnouncements, setActiveAnnouncements] = useState<AnnouncementRecord[]>([]);
  const [notificationsLoading, setNotificationsLoading] = useState(false);
  const [notificationsError, setNotificationsError] = useState<string | null>(null);
  const [notifReloadEpoch, setNotifReloadEpoch] = useState(0);
  const [announcementReadEpoch, setAnnouncementReadEpoch] = useState(0);
  const [notificationPrefs, setNotificationPrefs] = useState<UserNotificationPreferences>(() =>
    loadLocalNotificationPreferences(null)
  );
  const notificationPrefsRef = useRef<UserNotificationPreferences>(notificationPrefs);
  const arrivalTrackerRef = useRef<NotificationArrivalTracker>(new NotificationArrivalTracker());
  const [isOffline, setIsOffline] = useState<boolean>(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );

  useEffect(() => {
    notificationPrefsRef.current = notificationPrefs;
  }, [notificationPrefs]);

  useEffect(() => {
    setNotificationPrefs(loadLocalNotificationPreferences(fbUser?.uid ?? null));
  }, [fbUser?.uid]);

  // Search & Filter State
  const [searchQuery, setSearchQuery] = useState('');
  const [draftFilters, setDraftFilters] = useState<MarketplaceFilterState>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<MarketplaceFilterState>(EMPTY_FILTERS);

  const isBusyModal = Boolean(
    showAuthModal || authAction || showCreateModal || showWalletModal || selectedListing
  );
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

  useEffect(() => {
    if (verifyCooldownSec <= 0) return;
    const tId = window.setInterval(() => {
      setVerifyCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(tId);
  }, [verifyCooldownSec]);

  useEffect(() => {
    const onOnline = () => setIsOffline(false);
    const onOffline = () => setIsOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (!fbUser || !profileBootstrapped || signingOut) return;
    void syncActiveWebPushTokenForSession(fbUser.uid, settings.fcmVapidPublicKey);
    return subscribeForegroundPushMessages((payload) => {
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
  }, [fbUser, profileBootstrapped, signingOut, settings.fcmVapidPublicKey, showFlash]);

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
        setAuthModalInitialMode('login');
        setShowAuthModal(true);
      }
    } catch (err) {
      showFlash(formatFirebaseAuthError(err));
    } finally {
      setReconnectingSession(false);
    }
  }, [showFlash]);

  // Startup Auth Session Sanitization -> Firestore Connectivity Check -> Public Listeners
  useEffect(() => {
    let cancelled = false;
    let unsubSettings: (() => void) | null = null;
    let unsubListings: (() => void) | null = null;
    let unsubAnnouncements: (() => void) | null = null;

    detectFirebaseAuthCapabilities().then((caps) => {
      if (!cancelled) setAuthCaps(caps);
    });

    (async () => {
      await prepareFirestoreAuthSession();
      if (cancelled) return;
      const clearedMsg = consumeStaleTokenSessionClearedNotice();
      if (clearedMsg) {
        setStaleSessionNotice(clearedMsg);
      }

      void testFirestoreConnection();

      unsubSettings = onSnapshot(
        doc(db, 'publicConfig', 'settings'),
        (snap) => {
          if (snap.exists()) {
            const d = snap.data();
            setSettings({
              buyerFeeEnabled: d.buyerFeeEnabled !== undefined ? Boolean(d.buyerFeeEnabled) : true,
              buyerFeePct: Number(d.buyerFeePct ?? 5),
              sellerFeeEnabled: Boolean(d.sellerFeeEnabled),
              sellerFeePct: Number(d.sellerFeePct ?? 0),
              usdToBdtRate: Number(d.usdToBdtRate ?? 120),
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

      unsubListings = onSnapshot(
        query(collection(db, 'listings'), where('status', 'in', ['active', 'reserved']), limit(120)),
        (snap) => {
          const list: MarketplaceListing[] = snap.docs.map((docSnap) => {
            const ld = docSnap.data();
            return {
              id: docSnap.id,
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
              reservedBuyerId: ld.reservedBuyerId ? String(ld.reservedBuyerId) : undefined,
              status: ld.status,
              views: Number(ld.views || 0),
              createdAtMs: ld.createdAt?.toMillis ? ld.createdAt.toMillis() : Date.now(),
            };
          });
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setActiveListings(list);
        },
        (err) => {
          if (isTokenServiceDisabledError(err)) {
            void recoverFirestoreFromTokenServiceError();
            return;
          }
          console.error('Active listings subscription error:', err);
        }
      );
      unsubAnnouncements = onSnapshot(
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
    })();

    return () => {
      cancelled = true;
      unsubSettings?.();
      unsubListings?.();
      unsubAnnouncements?.();
    };
  }, []);

  // Auth Session Listener & Deduplicated User Profile Initialization
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (u) => {
      if (!u) {
        arrivalTrackerRef.current.reset();
        setProfileBootstrapped(false);
        setFbUser(null);
        setAuthReady(true);
        setProfile(null);
        setPrivateUser(null);
        setAdminRole('none');
        setMyListings([]);
        setMyBids([]);
        setConversations([]);
        setDeals([]);
        setDeposits([]);
        setWithdrawals([]);
        setPersonalNotifications([]);
        setNotificationsLoading(false);
        setNotificationsError(null);
        return;
      }

      // Gate internal ProactiveRefresh immediately so disabled securetoken.googleapis.com is never hit at minute 55
      void detectFirebaseAuthCapabilities().then((caps) => {
        syncProactiveRefreshWithCapabilities(u, caps.tokenServiceEnabled);
      });

      // Verify cached token validity without forcing an unnecessary securetoken.googleapis.com refresh
      try {
        await u.getIdToken(false);
      } catch (tokenErr) {
        if (isTokenServiceDisabledError(tokenErr)) {
          setStaleSessionNotice(
            'Your previous session expired. Reconnect with one click to continue.'
          );
          setTokenBannerDismissed(false);
          await recoverFirestoreFromTokenServiceError();
          return;
        }
      }

      setStaleSessionNotice(null);
      setSessionExtendPromptVisible(false);
      setFbUser(u);
      setAuthReady(true);

      try {
        await ensureUserProfileInitialized(u);
      } catch (err) {
        console.warn('Profile bootstrap notice:', err);
      } finally {
        setProfileBootstrapped(true);
      }
    });

    return () => unsubAuth();
  }, []);

  // 3-Stage Session Continuity Engine:
  // 1) Minute 52 (8m before expiry): Silent Google Identity Services + Identity Toolkit auto-refresh (0 popups, 0 securetoken calls).
  // 2) Minute 57.5 (2.5m before expiry): Non-intrusive 1-click "Reconnect Session" bar if silent GIS wasn't available.
  // 3) Minute 59:15 (45s before expiry, ahead of Firebase's 30s StsTokenManager.isExpired buffer): Safe pre-expiry recovery so Firestore never drops offline.
  useEffect(() => {
    if (!fbUser || !authCaps || authCaps.tokenServiceEnabled) return;
    let cancelled = false;
    const timers: number[] = [];

    (async () => {
      try {
        syncProactiveRefreshWithCapabilities(fbUser, false);
        const tokenResult = await fbUser.getIdTokenResult(false);
        if (cancelled) return;
        const expMs = Date.parse(tokenResult.expirationTime);
        const schedule = computeSessionRenewalSchedule(expMs, Date.now());
        let silentlyRenewed = false;

        timers.push(
          window.setTimeout(async () => {
            if (cancelled) return;
            const latestCaps = await detectFirebaseAuthCapabilities(true);
            if (cancelled) return;
            setAuthCaps(latestCaps);
            if (latestCaps.tokenServiceEnabled) {
              syncProactiveRefreshWithCapabilities(fbUser, true);
              silentlyRenewed = true;
              return;
            }
            const ok = await attemptSilentGoogleSessionRefresh(fbUser);
            if (!cancelled && ok) {
              silentlyRenewed = true;
              setSessionExtendPromptVisible(false);
              setAuthTokenEpoch((n) => n + 1);
            }
          }, schedule.silentIdpRefreshDelayMs)
        );

        timers.push(
          window.setTimeout(async () => {
            if (cancelled || silentlyRenewed) return;
            const latestCaps = await detectFirebaseAuthCapabilities(true);
            if (cancelled) return;
            setAuthCaps(latestCaps);
            if (latestCaps.tokenServiceEnabled) return;
            setTokenBannerDismissed(false);
            setSessionExtendPromptVisible(true);
          }, schedule.promptExtendDelayMs)
        );

        timers.push(
          window.setTimeout(async () => {
            if (cancelled || silentlyRenewed) return;
            const latestCaps = await detectFirebaseAuthCapabilities(true);
            if (cancelled) return;
            setAuthCaps(latestCaps);
            if (latestCaps.tokenServiceEnabled) return;
            // Re-verify expiration in case user already renewed interactively
            if (auth.currentUser) {
              const freshRes = await auth.currentUser.getIdTokenResult(false).catch(() => null);
              const freshExp = freshRes ? Date.parse(freshRes.expirationTime) : 0;
              if (freshExp - Date.now() > 60_000) {
                setSessionExtendPromptVisible(false);
                setAuthTokenEpoch((n) => n + 1);
                return;
              }
            }
            const msg =
              'Your 60-minute security session finished. Click Reconnect Session to continue right where you left off.';
            setSessionExtendPromptVisible(false);
            setStaleSessionNotice(msg);
            setTokenBannerDismissed(false);
            await recoverFirestoreFromTokenServiceError(msg);
          }, schedule.safePreExpiryGuardDelayMs)
        );
      } catch (err) {
        if (isTokenServiceDisabledError(err) && !cancelled) {
          await recoverFirestoreFromTokenServiceError();
        }
      }
    })();

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [fbUser, authCaps, authTokenEpoch]);

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

  // Authenticated User Real-Time Subscriptions (gated until profile bootstrap & detached cleanly on logout)
  useEffect(() => {
    if (!fbUser || !profileBootstrapped || signingOut) return;
    const uid = fbUser.uid;
    const unsubs: (() => void)[] = [];

    // Check bootstrapped superadmin + /admins/{uid}
    const isBootstrapped =
      Boolean(fbUser.emailVerified) &&
      fbUser.email?.toLowerCase() === BOOTSTRAPPED_SUPERADMIN_EMAIL.toLowerCase();

    if (isBootstrapped) {
      setAdminRole('superadmin');
    } else {
      unsubs.push(
        onSnapshot(
          doc(db, 'admins', uid),
          (snap) => {
            if (snap.exists()) {
              setAdminRole(snap.data().role === 'superadmin' ? 'superadmin' : 'admin');
            } else {
              setAdminRole('none');
            }
          },
          () => setAdminRole('none')
        )
      );
    }

    unsubs.push(
      onSnapshot(
        doc(db, 'publicProfiles', uid),
        (snap) => {
          if (snap.exists()) {
            const d = snap.data();
            setProfile({
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
        query(collection(db, 'listings'), where('sellerId', '==', uid)),
        (snap) => {
          const list: MarketplaceListing[] = snap.docs.map((docSnap) => {
            const ld = docSnap.data();
            return {
              id: docSnap.id,
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
              reservedBuyerId: ld.reservedBuyerId ? String(ld.reservedBuyerId) : undefined,
              status: ld.status,
              rejectionReason: ld.rejectionReason,
              views: Number(ld.views || 0),
              createdAtMs: ld.createdAt?.toMillis ? ld.createdAt.toMillis() : Date.now(),
            };
          });
          list.sort((a, b) => b.createdAtMs - a.createdAtMs);
          setMyListings(list);
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'bids'), where('buyerId', '==', uid)),
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

    // Conversations as Buyer or Seller
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
        query(collection(db, 'conversations'), where('buyerId', '==', uid)),
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
        query(collection(db, 'conversations'), where('sellerId', '==', uid)),
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
              updatedAtMs: cd.updatedAt?.toMillis ? cd.updatedAt.toMillis() : Date.now(),
            };
          });
          syncConvs();
        },
        () => {}
      )
    );

    // Deals as Buyer or Seller
    let buyerDeals: DealRecord[] = [];
    let sellerDeals: DealRecord[] = [];
    const syncDeals = () => {
      const map = new Map<string, DealRecord>();
      [...buyerDeals, ...sellerDeals].forEach((d) => map.set(d.id, d));
      setDeals(Array.from(map.values()).sort((a, b) => b.createdAtMs - a.createdAtMs));
    };

    const parseDeal = (id: string, dl: Record<string, unknown>): DealRecord => ({
      id,
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
        dl.refundPlatformRetainedMinor !== undefined ? Number(dl.refundPlatformRetainedMinor) : undefined,
      currency: (dl.currency as CurrencyCode) || 'BDT',
      protectionDurationHours: Number(dl.protectionDurationHours || 40),
      confirmedAtMs: Number(dl.confirmedAtMs || 0),
      originalDeadlineMs: Number(dl.originalDeadlineMs || 0),
      unresolvedReportCount: Number(dl.unresolvedReportCount || 0),
      paymentLedgerId: dl.paymentLedgerId ? String(dl.paymentLedgerId) : undefined,
      paidAtMs: dl.paidAtMs ? Number(dl.paidAtMs) : undefined,
      transferSubmissionCount: dl.transferSubmissionCount ? Number(dl.transferSubmissionCount) : undefined,
      latestTransferSubmissionId: dl.latestTransferSubmissionId ? String(dl.latestTransferSubmissionId) : undefined,
      latestRejectionReason: dl.latestRejectionReason ? String(dl.latestRejectionReason) : undefined,
      refundLedgerId: dl.refundLedgerId ? String(dl.refundLedgerId) : undefined,
      settlementLedgerId: dl.settlementLedgerId ? String(dl.settlementLedgerId) : undefined,
      adminHoldNote: dl.adminHoldNote ? String(dl.adminHoldNote) : undefined,
      settledAtMs: dl.settledAtMs ? Number(dl.settledAtMs) : undefined,
      refundedAtMs: dl.refundedAtMs ? Number(dl.refundedAtMs) : undefined,
      status: dl.status as DealRecord['status'],
      createdAtMs: (dl.createdAt as { toMillis?: () => number })?.toMillis
        ? (dl.createdAt as { toMillis: () => number }).toMillis()
        : Date.now(),
    });

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deals'), where('buyerId', '==', uid)),
        (snap) => {
          buyerDeals = snap.docs.map((d) => parseDeal(d.id, d.data()));
          syncDeals();
        },
        () => {}
      )
    );
    unsubs.push(
      onSnapshot(
        query(collection(db, 'deals'), where('sellerId', '==', uid)),
        (snap) => {
          sellerDeals = snap.docs.map((d) => parseDeal(d.id, d.data()));
          syncDeals();
        },
        () => {}
      )
    );

    unsubs.push(
      onSnapshot(
        query(collection(db, 'deposits'), where('userId', '==', uid)),
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
        query(collection(db, 'withdrawals'), where('userId', '==', uid)),
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

    setNotificationsLoading(true);
    setNotificationsError(null);
    unsubs.push(
      onSnapshot(
        query(collection(db, 'notifications'), where('recipientId', '==', uid), limit(150)),
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
          const arrival = arrivalTrackerRef.current.processSnapshot(uid, parsed);
          if (arrival.shouldAlert) {
            void dispatchForegroundNotificationAlert(arrival.alertKind, notificationPrefsRef.current);
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
  }, [fbUser, profileBootstrapped, signingOut, authTokenEpoch, notifReloadEpoch]);

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
          if (spec.eventKey.startsWith('deal_window_elapsed_') && deal.unresolvedReportCount === 0) {
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

  // Keep open ListingDetailModal synchronized with live Firestore status updates (e.g. active <-> reserved)
  useEffect(() => {
    if (!selectedListing) return;
    const updated =
      activeListings.find((l) => l.id === selectedListing.id) ||
      myListings.find((l) => l.id === selectedListing.id);
    if (
      updated &&
      (updated.status !== selectedListing.status ||
        updated.activeDealId !== selectedListing.activeDealId ||
        updated.acceptedBidAmountMinor !== selectedListing.acceptedBidAmountMinor ||
        updated.reservedBuyerId !== selectedListing.reservedBuyerId)
    ) {
      setSelectedListing(updated);
    }
  }, [activeListings, myListings, selectedListing]);

  const combinedNotifications = useMemo(() => {
    void announcementReadEpoch;
    return mergeAnnouncementsIntoFeed(
      personalNotifications,
      activeAnnouncements,
      fbUser?.uid ?? null
    );
  }, [personalNotifications, activeAnnouncements, fbUser?.uid, announcementReadEpoch]);

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

  const handleNavigateNotificationDestination = useCallback(
    async (dest: SafeInternalDestination) => {
      if (dest.kind === 'wallet') {
        if (!fbUser) {
          setAuthModalInitialMode('login');
          setShowAuthModal(true);
          return;
        }
        setShowWalletModal(true);
        return;
      }

      if (dest.kind === 'deal' && dest.targetId) {
        setInitialDealId(dest.targetId);
        setPage('deals');
        return;
      }

      if (dest.kind === 'view' && dest.view === 'admin' && dest.targetId) {
        setAdminInitialDealId(dest.targetId);
        setPage('admin');
        return;
      }

      if (dest.kind === 'chat' && dest.targetId) {
        setInitialConvId(dest.targetId);
        setPage('chat');
        return;
      }

      if (dest.kind === 'listing' && dest.targetId) {
        const localMatch =
          activeListings.find((l) => l.id === dest.targetId) ||
          myListings.find((l) => l.id === dest.targetId);
        if (localMatch) {
          setSelectedListing(localMatch);
          return;
        }
        try {
          const snap = await getDoc(doc(db, 'listings', dest.targetId));
          if (snap.exists()) {
            const ld = snap.data();
            setSelectedListing({
              id: snap.id,
              sellerId: String(ld.sellerId || ''),
              sellerName: String(ld.sellerName || ''),
              sellerUsername: String(ld.sellerUsername || ''),
              sellerVerified: Boolean(ld.sellerVerified),
              platform: ld.platform,
              subcategory: String(ld.subcategory || ''),
              title: String(ld.title || ''),
              description: String(ld.description || ''),
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
              accountUrl: String(ld.accountUrl || ''),
              urlValidationStatus: ld.urlValidationStatus || 'not_applicable',
              gameName: ld.gameName,
              gameUid: ld.gameUid,
              gameLevel: ld.gameLevel,
              images: ld.images || [],
              activeDealId: ld.activeDealId,
              acceptedBidAmountMinor: ld.acceptedBidAmountMinor ? Number(ld.acceptedBidAmountMinor) : undefined,
              reservedBuyerId: ld.reservedBuyerId ? String(ld.reservedBuyerId) : undefined,
              status: ld.status,
              rejectionReason: ld.rejectionReason,
              views: Number(ld.views || 0),
              createdAtMs: ld.createdAt?.toMillis ? ld.createdAt.toMillis() : Date.now(),
            });
            return;
          }
        } catch {
          // Fallback to market view if listing is inaccessible
        }
        setPage('market');
        return;
      }

      if (dest.view) {
        setPage(dest.view);
      }
    },
    [fbUser, activeListings, myListings]
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
      safeDest.view === 'chat';
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

  // Reliable Logout Flow (unlinks device push token & detaches authenticated listeners BEFORE revoking Firebase Auth token)
  const handleLogout = useCallback(async () => {
    const outgoingUid = fbUser?.uid ?? auth.currentUser?.uid ?? null;
    setSigningOut(true);
    arrivalTrackerRef.current.reset();
    setProfileBootstrapped(false);
    setAdminRole('none');
    setSelectedListing(null);
    setShowWalletModal(false);
    setShowCreateModal(false);
    setPersonalNotifications([]);
    setPage('home');
    try {
      await unlinkCurrentDevicePushTokenOnLogout(outgoingUid);
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      await signOut(auth);
      setProfile(null);
      setPrivateUser(null);
      showFlash('You have been signed out safely.');
    } catch (err) {
      showFlash(err instanceof Error ? err.message : 'Could not complete sign-out. Please try again.');
    } finally {
      setSigningOut(false);
    }
  }, [fbUser?.uid, showFlash]);

  // Open Public Profile Visitor View
  const handleOpenPublicProfile = useCallback((targetUid: string) => {
    setSelectedListing(null);
    setPublicProfileTargetUid(targetUid);
    setPage('public-profile');
  }, []);

  // Deterministic Pre-Deal Chat Starter
  const handleStartChatWithUser = useCallback(
    async (targetUid: string, targetName: string, listing?: MarketplaceListing) => {
      if (!fbUser || !profile) {
        setShowAuthModal(true);
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
        setSelectedListing(null);
        setInitialConvId(convId);
        setPage('chat');
      } catch (err) {
        showFlash(err instanceof Error ? err.message : 'Failed to open chat.');
      }
    },
    [fbUser, profile, showFlash]
  );

  //Listing filter computation
  const filterListingsWithState = useCallback(
    (source: MarketplaceListing[], f: MarketplaceFilterState, qText: string) => {
      const qLower = qText.trim().toLowerCase();
      return source
        .filter((item) => {
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

  const handleOpenListingDetail = useCallback((l: MarketplaceListing) => {
    setSelectedListing(l);
  }, []);

  const handleQuickCategorySelect = (p: PlatformId) => {
    const next: MarketplaceFilterState = {
      ...EMPTY_FILTERS,
      platform: p,
    };
    setDraftFilters(next);
    setAppliedFilters(next);
    setPage('market');
  };

  const isAdmin = adminRole === 'admin' || adminRole === 'superadmin';

  return (
    <div className="min-h-screen flex flex-col bg-[var(--bx-bg)] text-[var(--bx-text)] pb-16 md:pb-0">
      {/* Global Header */}
      <Navbar
        page={page}
        onNavigate={(p) => setPage(p)}
        theme={theme}
        onToggleTheme={toggleTheme}
        language={language}
        onChangeLanguage={setLanguage}
        currency={currency}
        onChangeCurrency={setCurrency}
        userUid={fbUser?.uid ?? null}
        profile={profile}
        isAdmin={isAdmin}
        signingOut={signingOut}
        onOpenAuth={() => {
          setAuthModalInitialMode('login');
          setShowAuthModal(true);
        }}
        onOpenCreateListing={() => {
          if (!fbUser) {
            setAuthModalInitialMode('login');
            setShowAuthModal(true);
            return;
          }
          setShowCreateModal(true);
        }}
        onOpenWallet={() => {
          if (!fbUser) {
            setAuthModalInitialMode('login');
            setShowAuthModal(true);
            return;
          }
          setShowWalletModal(true);
        }}
        onLogout={handleLogout}
        isInstalled={pwa.isInstalled}
        onTriggerInstall={() => {
          pwa.triggerInstall();
        }}
        notificationSlot={
          <NotificationCenter
            userUid={fbUser?.uid ?? null}
            notifications={combinedNotifications}
            loading={notificationsLoading}
            error={notificationsError}
            isOffline={isOffline}
            fallbackVapidKey={settings.fcmVapidPublicKey}
            preferences={notificationPrefs}
            onUpdatePreferences={handleUpdateNotificationPreferences}
            onRetry={() => setNotifReloadEpoch((n) => n + 1)}
            onMarkOneRead={handleMarkSingleNotificationRead}
            onMarkAllRead={handleMarkAllNotificationsRead}
            onNavigateDestination={(dest) => {
              void handleNavigateNotificationDestination(dest);
            }}
            onOpenAuth={() => {
              setAuthModalInitialMode('login');
              setShowAuthModal(true);
            }}
          />
        }
      />

      {/* Global Toast Notification */}
      {toastMsg && (
        <div
          role="status"
          aria-live="polite"
          className="fixed top-20 right-4 z-50 max-w-md bx-card px-4 py-3 flex items-center gap-2.5 bg-[#FFD400] text-[#191919]"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="text-xs font-extrabold">{toastMsg}</span>
        </div>
      )}

      {/* Contextual Session Continuity Bar (shown ONLY when an active or previous user session needs 1-click renewal) */}
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
                  ? 'Your active session will refresh shortly. Click Reconnect Session to extend for another 60 minutes without interruption.'
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
                <span>{reconnectingSession ? 'Reconnecting…' : 'Reconnect Session'}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setTokenBannerDismissed(true);
                  setSessionExtendPromptVisible(false);
                }}
                className="bx-icon-btn !w-7 !h-7"
                aria-label="Dismiss session renewal notice"
              >
                <X className="w-3.5 h-3.5" />
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
                className="bx-icon-btn !w-7 !h-7"
                aria-label="Dismiss email verification reminder"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1">
        {/* HOME PAGE */}
        {page === 'home' && (
          <div className="space-y-12 pb-12">
            {/* Hero Section */}
            <section className="border-b-2 border-[var(--bx-border)] bg-[var(--bx-surface)]">
              <div className="max-w-7xl mx-auto px-4 py-12 lg:py-16 grid grid-cols-1 lg:grid-cols-12 gap-8 items-center">
                <div className="lg:col-span-7 space-y-6">
                  <div className="inline-flex items-center gap-2 px-3 py-1 text-xs font-black uppercase tracking-wider bg-[#FFD400] text-[#191919] border-2 border-[#191919]">
                    <ShieldCheck className="w-4 h-4" />
                    {t(language, 'hero_eyebrow')}
                  </div>

                  <h1 className="text-3xl sm:text-5xl font-black tracking-tight leading-[1.08]">
                    {t(language, 'hero_title')}
                  </h1>

                  <p className="text-base sm:text-lg opacity-85 max-w-2xl leading-relaxed">
                    {t(language, 'hero_sub')}
                  </p>

                  {/* Search Bar */}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      setPage('market');
                    }}
                    className="flex flex-col sm:flex-row gap-3 max-w-2xl"
                  >
                    <div className="relative flex-1">
                      <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 opacity-60" />
                      <input
                        type="search"
                        aria-label={t(language, 'search_placeholder')}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder={t(language, 'search_placeholder')}
                        className="bx-input w-full pl-10 pr-4 py-3 text-sm font-semibold"
                      />
                    </div>
                    <button
                      type="submit"
                      className="bx-btn bx-btn-primary px-6 py-3 text-sm font-extrabold inline-flex items-center justify-center gap-2"
                    >
                      <span>Explore Assets</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  </form>

                  <div className="flex flex-wrap items-center gap-3 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        if (!fbUser) setShowAuthModal(true);
                        else setShowCreateModal(true);
                      }}
                      className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                    >
                      <Plus className="w-4 h-4 text-[#FF6500]" />
                      {t(language, 'btn_sell')}
                    </button>
                    <span className="text-xs font-bold opacity-75">
                      Escrow Hold · Immutable Protection Windows · Evidence-Reviewed Monetization
                    </span>
                  </div>
                </div>

                {/* Right-side Escrow & Verification Architecture Card */}
                <div className="lg:col-span-5">
                  <div className="bx-card p-6 space-y-4">
                    <div className="flex items-center justify-between border-b-2 border-[var(--bx-border)] pb-3">
                      <div className="flex items-center gap-2">
                        <Lock className="w-5 h-5 text-[#FF6500]" />
                        <h2 className="text-base font-black">How BEXORA Escrow Works</h2>
                      </div>
                      <span className="text-[11px] font-black uppercase px-2 py-0.5 bg-[#793A91] text-white">
                        Protected
                      </span>
                    </div>

                    <ol className="space-y-3 text-xs font-bold">
                      <li className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex gap-3">
                        <span className="w-6 h-6 shrink-0 bg-[#FF6500] text-white font-black flex items-center justify-center">
                          1
                        </span>
                        <div>
                          <div className="font-black text-sm">Verify Before Bidding</div>
                          <p className="opacity-80 font-medium mt-0.5">
                            Inspect public domain-matched asset links, account age, and Admin-verified monetization status.
                          </p>
                        </div>
                      </li>
                      <li className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex gap-3">
                        <span className="w-6 h-6 shrink-0 bg-[#FF6500] text-white font-black flex items-center justify-center">
                          2
                        </span>
                        <div>
                          <div className="font-black text-sm">Escrow Lock & Guided Transfer</div>
                          <p className="opacity-80 font-medium mt-0.5">
                            Funds stay locked in BEXORA Escrow while ownership credentials are transferred inside the Deal Room.
                          </p>
                        </div>
                      </li>
                      <li className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex gap-3">
                        <span className="w-6 h-6 shrink-0 bg-[#FF6500] text-white font-black flex items-center justify-center">
                          3
                        </span>
                        <div>
                          <div className="font-black text-sm">Category Protection Countdown</div>
                          <p className="opacity-80 font-medium mt-0.5">
                            7-day protection for YouTube channels ({getProtectionDurationHours('youtube', settings)}h) and {getProtectionDurationHours('facebook', settings)}h for Facebook & standard-transfer assets.
                          </p>
                        </div>
                      </li>
                    </ol>
                  </div>
                </div>
              </div>
            </section>

            {/* Responsive 8-Category Grid */}
            <section className="max-w-7xl mx-auto px-4 space-y-5">
              <div className="flex items-end justify-between">
                <div>
                  <h2 className="text-xl sm:text-2xl font-black tracking-tight">Browse by Asset Category</h2>
                  <p className="text-xs sm:text-sm opacity-75">
                    Select any platform to launch category-specific filters and monetization rules.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDraftFilters(EMPTY_FILTERS);
                    setAppliedFilters(EMPTY_FILTERS);
                    setPage('market');
                  }}
                  className="text-xs font-black text-[#FF6500] hover:underline"
                >
                  View All Categories →
                </button>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3">
                {PLATFORM_LIST.map((pId) => {
                  const def = PLATFORM_CATALOG[pId];
                  const count = activeListings.filter((l) => l.platform === pId).length;
                  return (
                    <button
                      key={pId}
                      type="button"
                      onClick={() => handleQuickCategorySelect(pId)}
                      className="bx-cat-card bx-card p-3.5 flex flex-col items-start justify-between gap-3 text-left hover:-translate-y-0.5 transition-transform"
                    >
                      <PlatformIcon id={pId} size={32} />
                      <div className="w-full min-w-0">
                        <div className="font-black text-xs sm:text-sm truncate">{def.name}</div>
                        <div className="text-[11px] font-bold opacity-70">
                          {count} {count === 1 ? 'listing' : 'listings'}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {/* Live Marketplace Feed on Home */}
            <section className="max-w-7xl mx-auto px-4 space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-xl sm:text-2xl font-black tracking-tight">Latest Verified Listings</h2>
                  <p className="text-xs sm:text-sm opacity-75">
                    Real seller submissions approved by BEXORA Moderation.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPage('market')}
                  className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                >
                  <SlidersHorizontal className="w-3.5 h-3.5" />
                  Advanced Filters
                </button>
              </div>

              {activeListings.length === 0 ? (
                <div className="bx-card p-10 text-center space-y-4">
                  <Sparkles className="w-8 h-8 text-[#FF6500] mx-auto" />
                  <h3 className="text-lg font-black">{t(language, 'no_listings')}</h3>
                  <p className="text-sm opacity-75 max-w-md mx-auto">
                    BEXORA never populates fake or placeholder listings. Be the first verified seller to publish a YouTube channel, Facebook page, website, domain, or gaming asset.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (!fbUser) setShowAuthModal(true);
                      else setShowCreateModal(true);
                    }}
                    className="bx-btn bx-btn-primary px-6 py-2.5 text-xs font-extrabold"
                  >
                    {t(language, 'btn_sell')}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {activeListings.slice(0, 6).map((item) => (
                    <ListingCard
                      key={item.id}
                      listing={item}
                      displayCurrency={currency}
                      usdToBdtRate={settings.usdToBdtRate}
                      onOpen={handleOpenListingDetail}
                      onOpenSellerProfile={handleOpenPublicProfile}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {/* MARKETPLACE PAGE */}
        {page === 'market' && (
          <div className="max-w-7xl mx-auto px-4 py-8 space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b-2 border-[var(--bx-border)] pb-5">
              <div>
                <h1 className="text-2xl sm:text-3xl font-black tracking-tight">{t(language, 'nav_market')}</h1>
                <p className="text-xs sm:text-sm opacity-75">
                  Showing {filteredMarketplaceListings.length} active digital asset{filteredMarketplaceListings.length === 1 ? '' : 's'}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <div className="relative flex-1 sm:w-72">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-60" />
                  <input
                    type="search"
                    aria-label="Search marketplace listings"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder={t(language, 'search_placeholder')}
                    className="bx-input w-full pl-9 pr-3 py-2 text-xs font-semibold"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setMobileFilterOpen((v) => !v)}
                  className="lg:hidden bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                >
                  <Filter className="w-3.5 h-3.5" />
                  Filters
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Desktop Sidebar or Mobile Collapsible Filter Panel */}
              <div className={`lg:col-span-4 xl:col-span-3 ${mobileFilterOpen ? 'block' : 'hidden lg:block'}`}>
                <FilterPanel
                  draft={draftFilters}
                  setDraft={setDraftFilters}
                  onApply={() => {
                    setAppliedFilters(draftFilters);
                    setMobileFilterOpen(false);
                  }}
                  onReset={() => {
                    setDraftFilters(EMPTY_FILTERS);
                    setAppliedFilters(EMPTY_FILTERS);
                    setSearchQuery('');
                  }}
                  matchCount={draftMatchCount}
                  currency={currency}
                  gamingTitles={settings.gamingTitles}
                  disabledMonetizationIds={settings.disabledMonetizationIds}
                />
              </div>

              {/* Listings Grid */}
              <div className="lg:col-span-8 xl:col-span-9">
                {filteredMarketplaceListings.length === 0 ? (
                  <div className="bx-card p-10 text-center space-y-4">
                    <h2 className="text-lg font-black">{t(language, 'no_listings')}</h2>
                    <p className="text-xs sm:text-sm opacity-75 max-w-md mx-auto">
                      No active assets match your current category or numeric range criteria. Adjust your filters or list a verified asset for sale.
                    </p>
                    <div className="flex flex-wrap justify-center gap-3">
                      <button
                        type="button"
                        onClick={() => {
                          setDraftFilters(EMPTY_FILTERS);
                          setAppliedFilters(EMPTY_FILTERS);
                          setSearchQuery('');
                        }}
                        className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-extrabold"
                      >
                        Reset All Filters
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (!fbUser) setShowAuthModal(true);
                          else setShowCreateModal(true);
                        }}
                        className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold"
                      >
                        {t(language, 'btn_sell')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                    {filteredMarketplaceListings.map((item) => (
                      <ListingCard
                        key={item.id}
                        listing={item}
                        displayCurrency={currency}
                        usdToBdtRate={settings.usdToBdtRate}
                        onOpen={handleOpenListingDetail}
                        onOpenSellerProfile={handleOpenPublicProfile}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* TOP SELLERS PAGE */}
        {page === 'sellers' && <TopSellersView onOpenPublicProfile={handleOpenPublicProfile} />}

        {/* PRE-DEAL MESSENGER CHAT PAGE */}
        {page === 'chat' && (
          <ChatView
            userUid={fbUser?.uid ?? null}
            profile={profile}
            conversations={conversations}
            initialConvId={initialConvId}
            onRequireAuth={() => setShowAuthModal(true)}
            onFlash={showFlash}
          />
        )}

        {/* ESCROW DEALS PAGE */}
        {page === 'deals' && (
          <DealsView
            userUid={fbUser?.uid ?? null}
            profile={profile}
            privateUser={privateUser}
            deals={deals}
            initialDealId={initialDealId}
            settings={settings}
            displayCurrency={currency}
            onRequireAuth={() => setShowAuthModal(true)}
            onOpenWallet={() => setShowWalletModal(true)}
            onFlash={showFlash}
          />
        )}

        {/* OWNER PROFILE PAGE */}
        {page === 'profile' && (
          <>
            {!authReady ? (
              <div className="max-w-3xl mx-auto px-4 py-12 text-center text-sm font-bold opacity-75">
                Checking authentication session…
              </div>
            ) : !fbUser || !profile || !privateUser ? (
              <div className="max-w-md mx-auto px-4 py-14">
                <div className="bx-card p-8 text-center space-y-4">
                  <div className="flex justify-center">
                    <BexoraLogo compact />
                  </div>
                  <h1 className="text-xl font-black">Sign in to manage your BEXORA Profile</h1>
                  <p className="text-xs opacity-80">
                    Access your listings, wallet balance, email & phone verification, password security, and private NID verification.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowAuthModal(true)}
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
                displayCurrency={currency}
                usdToBdtRate={settings.usdToBdtRate}
                onOpenListing={handleOpenListingDetail}
                onOpenListingById={(listingId) =>
                  handleNavigateNotificationDestination({
                    raw: `listing:${listingId}`,
                    kind: 'listing',
                    targetId: listingId,
                    ctaLabel: 'View Listing',
                  })
                }
                onOpenDeal={(dealId) => {
                  setInitialDealId(dealId);
                  setPage('deals');
                }}
                onOpenWallet={() => setShowWalletModal(true)}
                onOpenPublicSelf={() => handleOpenPublicProfile(fbUser.uid)}
                onAuthTokenRefreshed={handleRefreshAuthToken}
                onFlash={showFlash}
              />
            )}
          </>
        )}

        {/* PUBLIC VISITOR PROFILE PAGE */}
        {page === 'public-profile' && publicProfileTargetUid && (
          <ProfileView
            mode="visitor"
            targetUid={publicProfileTargetUid}
            viewerUid={fbUser?.uid ?? null}
            displayCurrency={currency}
            usdToBdtRate={settings.usdToBdtRate}
            onBack={() => setPage('market')}
            onOpenListing={handleOpenListingDetail}
            onMessageSeller={(sellerUid, sellerName, listing) =>
              handleStartChatWithUser(sellerUid, sellerName, listing)
            }
          />
        )}

        {/* ADMIN CONSOLE PAGE */}
        {page === 'admin' && (
          <>
            {!fbUser || !isAdmin ? (
              <div className="max-w-lg mx-auto px-4 py-14">
                <div className="bx-card p-8 text-center space-y-3">
                  <Lock className="w-8 h-8 text-red-600 mx-auto" />
                  <h1 className="text-xl font-black">Administrator Access Required</h1>
                  <p className="text-xs opacity-80">
                    This console is restricted to verified BEXORA Administrators and the bootstrapped Superadmin account.
                  </p>
                  <button
                    type="button"
                    onClick={() => setPage('home')}
                    className="bx-btn bx-btn-primary px-5 py-2 text-xs font-extrabold"
                  >
                    Return Home
                  </button>
                </div>
              </div>
            ) : (
              <AdminDashboard
                adminUid={fbUser.uid}
                isSuperAdmin={adminRole === 'superadmin'}
                settings={settings}
                displayCurrency={currency}
                initialDealId={adminInitialDealId}
                onFlash={showFlash}
              />
            )}
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t-2 border-[var(--bx-border)] bg-[var(--bx-surface)] pt-8 pb-24 md:py-8 mt-12">
        <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
          <div className="flex items-center gap-2.5">
            <BexoraLogo compact />
            <span className="opacity-70">· Buy & Sell Verifiable Digital Assets</span>
          </div>
          <div className="flex flex-wrap items-center gap-4 font-bold opacity-80">
            <button type="button" onClick={() => setPage('market')} className="hover:underline">
              Marketplace
            </button>
            <button type="button" onClick={() => setPage('sellers')} className="hover:underline">
              Top Sellers
            </button>
            <button type="button" onClick={() => setPage('deals')} className="hover:underline">
              Escrow Protection
            </button>
            {!pwa.isInstalled && (
              <button
                type="button"
                onClick={() => pwa.triggerInstall()}
                className="text-[#FF6500] font-extrabold hover:underline"
              >
                Install App
              </button>
            )}
          </div>
        </div>
      </footer>

      {/* Mobile Bottom Nav */}
      <BottomNav
        page={page}
        onNavigate={(p) => setPage(p)}
        language={language}
      />

      {/* Floating Support Widget */}
      <FloatingSupportWidget settings={settings} />

      {/* Smart PWA Install Banner & Guide */}
      <PWAInstallBanner
        showBanner={pwa.showDelayedBanner}
        showManualGuide={pwa.showManualGuide}
        isIOS={pwa.isIOS}
        onInstall={() => pwa.triggerInstall()}
        onDismissBanner={pwa.dismissBanner}
        onCloseManualGuide={() => pwa.setShowManualGuide(false)}
      />

      {/* MODALS */}
      {authAction && (
        <FirebaseAuthActionModal
          action={authAction}
          onClose={() => setAuthAction(null)}
          onVerifiedEmail={async () => {
            await handleRefreshAuthToken();
            showFlash('Email address verified via Firebase Authentication!');
          }}
          onOpenSignIn={() => {
            setAuthModalInitialMode('login');
            setShowAuthModal(true);
          }}
          onOpenForgotPassword={() => {
            setAuthModalInitialMode('forgot');
            setShowAuthModal(true);
          }}
        />
      )}

      {showAuthModal && (
        <AuthModal
          initialMode={authModalInitialMode}
          onClose={() => setShowAuthModal(false)}
          onSuccess={(msg) => {
            setShowAuthModal(false);
            showFlash(msg);
          }}
        />
      )}

      {showCreateModal && (
        <CreateListingModal
          onClose={() => setShowCreateModal(false)}
          userUid={fbUser?.uid ?? null}
          profile={profile}
          settings={settings}
          onRequireAuth={() => {
            setShowCreateModal(false);
            setShowAuthModal(true);
          }}
          onCreated={(msg) => {
            setShowCreateModal(false);
            showFlash(msg);
            setPage('profile');
          }}
        />
      )}

      {selectedListing && (
        <ListingDetailModal
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
          userUid={fbUser?.uid ?? null}
          profile={profile}
          privateUser={privateUser}
          settings={settings}
          displayCurrency={currency}
          onRequireAuth={() => setShowAuthModal(true)}
          onOpenWallet={() => {
            setSelectedListing(null);
            setShowWalletModal(true);
          }}
          onStartChatWithUser={(targetUid, targetName, listing) =>
            handleStartChatWithUser(targetUid, targetName, listing)
          }
          onOpenPublicProfile={handleOpenPublicProfile}
          onDealOpened={(dealId, msg) => {
            setSelectedListing(null);
            setInitialDealId(dealId);
            showFlash(msg);
            setPage('deals');
          }}
          onFlash={showFlash}
        />
      )}

      {showWalletModal && fbUser && profile && privateUser && (
        <WalletModal
          onClose={() => setShowWalletModal(false)}
          userUid={fbUser.uid}
          profile={profile}
          privateUser={privateUser}
          settings={settings}
          deposits={deposits}
          withdrawals={withdrawals}
          displayCurrency={currency}
          onFlash={showFlash}
        />
      )}
    </div>
  );
}
