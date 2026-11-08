import React, { useCallback, useEffect, useState } from 'react';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  UserCheck,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { auth, db, fetchWithFreshBearerToken } from '../lib/firebase';
import { formatMoneyFromMinor } from '../lib/marketplaceLogic';
import { CurrencyCode } from '../types';

export interface AdminUsersDirectoryProps {
  adminUid: string;
  isSuperAdmin: boolean;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpenModerationTab: () => void;
  onFlash: (msg: string) => void;
}

interface AdminDirectoryUserItem {
  uid: string;
  displayName: string;
  username: string;
  avatarUrl: string;
  location: string;
  email: string;
  phone: string;
  phoneCountryCode: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  nidVerified: boolean;
  nidStatus: string;
  accountStatus: 'active' | 'warned' | 'restricted' | 'suspended' | 'banned';
  rawModerationStatus: string;
  activeStrikes: number;
  walletBalanceMinor: number;
  reservedBalanceMinor: number;
  completedSales: number;
  completedPurchases: number;
  totalListings: number;
  activeListings: number;
  buyerDealsCount: number;
  sellerDealsCount: number;
  activeDealsCount: number;
  createdAtMs: number;
  lastSignInAtMs: number | null;
}

interface DirectorySummary {
  totalUsers: number;
  activeUsers: number;
  suspendedUsers: number;
  bannedUsers: number;
  verifiedUsers: number;
  unverifiedUsers: number;
  recentlyRegistered7d: number;
}

interface InspectedUserProfile {
  basicInfo: {
    uid: string;
    displayName: string;
    username: string;
    avatarUrl: string;
    bio: string;
    location: string;
    createdAtMs: number | null;
    email: string;
    emailVerified: boolean;
    phone: string;
    phoneCountryCode: string;
    phoneVerified: boolean;
    nidStatus: string;
    nidVerified: boolean;
    adminRoleAssigned: string | null;
    authProviders: string[];
    authDisabled: boolean;
  };
  marketplaceInfo: {
    totalListings: number;
    activeListings: number;
    pendingListings: number;
    rejectedListings: number;
    soldListings: number;
    totalPurchases: number;
    totalSales: number;
    completedDealsCount: number;
    cancelledOrRefundedDealsCount: number;
    activeDealsCount: number;
    listings: Array<{
      id: string;
      title: string;
      platform: string;
      subcategory: string;
      priceMinor: number;
      currency: string;
      status: string;
      imagesCount: number;
      createdAtMs: number;
    }>;
    recentDeals: Array<{
      id: string;
      listingTitle: string;
      role: 'buyer' | 'seller';
      baseAmountMinor: number;
      currency: string;
      status: string;
      createdAtMs: number;
    }>;
  };
  walletInfo: {
    walletBalanceMinor: number;
    reservedBalanceMinor: number;
    pendingDepositsCount: number;
    approvedDepositsCount: number;
    pendingWithdrawalsCount: number;
    paidWithdrawalsCount: number;
    ledgerEntries: Array<{
      id: string;
      kind: string;
      amountMinor: number;
      currency: string;
      referenceId: string;
      note: string;
      createdAtMs: number;
    }>;
  };
  securityModerationInfo: {
    accountStatus: string;
    activeStrikes: number;
    totalHistoricalStrikes: number;
    financialHoldActive: boolean;
    reason: string;
    latestWarningTitle: string;
    reportsAgainstCount: number;
    openReportsAgainstCount: number;
    reportsSubmittedCount: number;
    appealsCount: number;
    reportsAgainst: Array<{
      id: string;
      trackingRef: string;
      category: string;
      surface: string;
      status: string;
      createdAtMs: number;
    }>;
    appeals: Array<{
      id: string;
      trackingRef: string;
      status: string;
      explanation: string;
      createdAtMs: number;
    }>;
  };
  activityInfo: {
    lastSignInAtMs: number | null;
    recentAuditEvents: Array<{
      id: string;
      action: string;
      targetType: string;
      targetId: string;
      details: string;
      createdAtMs: number;
    }>;
  };
}

interface DeletePreflightState {
  loading: boolean;
  error: string | null;
  eligible: boolean;
  blockers: string[];
  summary: {
    uid: string;
    displayName: string;
    username: string;
    email: string;
    listingsCount: number;
    activeDealsCount: number;
    walletBalanceMinor: number;
    reservedBalanceMinor: number;
    pendingObligationsCount: number;
  } | null;
}

function formatDateShort(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return 'Not recorded';
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return 'Not recorded';
  }
}

function formatDateTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return 'Not recorded';
  try {
    return new Date(ms).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'Not recorded';
  }
}

function getStatusTextClass(status: string): string {
  switch (status) {
    case 'banned':
    case 'permanent_ban':
      return 'text-red-600 dark:text-red-400';
    case 'suspended':
    case 'protective_suspension':
    case 'temporary_suspension':
    case 'restricted':
      return 'text-amber-600 dark:text-amber-400';
    case 'warned':
      return 'text-orange-600 dark:text-orange-400';
    default:
      return 'text-emerald-700 dark:text-emerald-400';
  }
}

export const AdminUsersDirectory: React.FC<AdminUsersDirectoryProps> = ({
  adminUid,
  isSuperAdmin,
  displayCurrency,
  usdToBdtRate,
  onOpenModerationTab,
  onFlash,
}) => {
  // Search & Filter State
  const [searchInput, setSearchInput] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const [accountStatus, setAccountStatus] = useState('all');
  const [emailVerifiedFilter, setEmailVerifiedFilter] = useState('all');
  const [phoneVerifiedFilter, setPhoneVerifiedFilter] = useState('all');
  const [sellerStatusFilter, setSellerStatusFilter] = useState('all');
  const [buyerActivityFilter, setBuyerActivityFilter] = useState('all');
  const [registeredDays, setRegisteredDays] = useState<number>(0);
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(15);

  // Directory Data State
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<DirectorySummary>({
    totalUsers: 0,
    activeUsers: 0,
    suspendedUsers: 0,
    bannedUsers: 0,
    verifiedUsers: 0,
    unverifiedUsers: 0,
    recentlyRegistered7d: 0,
  });
  const [users, setUsers] = useState<AdminDirectoryUserItem[]>([]);
  const [totalMatched, setTotalMatched] = useState<number>(0);
  const [totalPages, setTotalPages] = useState<number>(1);

  // Profile Inspection Modal State
  const [inspectTargetUid, setInspectTargetUid] = useState<string | null>(null);
  const [inspectLoading, setInspectLoading] = useState<boolean>(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspectedProfile, setInspectedProfile] = useState<InspectedUserProfile | null>(null);
  const [inspectTab, setInspectTab] = useState<
    'contact' | 'marketplace' | 'wallet' | 'moderation' | 'activity'
  >('contact');

  // Superadmin Permanent Delete Modal State
  const [deleteTargetUser, setDeleteTargetUser] = useState<AdminDirectoryUserItem | null>(null);
  const [deletePreflight, setDeletePreflight] = useState<DeletePreflightState>({
    loading: false,
    error: null,
    eligible: false,
    blockers: [],
    summary: null,
  });
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [deleteReason, setDeleteReason] = useState('');
  const [retainEmailSecurityBlock, setRetainEmailSecurityBlock] = useState(false);
  const [deletingUser, setDeletingUser] = useState(false);
  const [deleteSubmitError, setDeleteSubmitError] = useState<string | null>(null);

  const loadDirectoryFallbackFromFirestore = useCallback(async () => {
    const [pubSnap, privSnap, restSnap, listSnap, dealSnap] = await Promise.all([
      getDocs(query(collection(db, 'publicProfiles'), limit(300))),
      getDocs(query(collection(db, 'privateUsers'), limit(300))),
      getDocs(query(collection(db, 'userRestrictions'), limit(300))),
      getDocs(query(collection(db, 'listings'), limit(400))),
      getDocs(query(collection(db, 'deals'), limit(400))),
    ]);

    const pubMap = new Map<string, Record<string, unknown>>();
    pubSnap.docs.forEach((d) => pubMap.set(d.id, d.data() as Record<string, unknown>));
    const privMap = new Map<string, Record<string, unknown>>();
    privSnap.docs.forEach((d) => privMap.set(d.id, d.data() as Record<string, unknown>));
    const restMap = new Map<string, Record<string, unknown>>();
    restSnap.docs.forEach((d) => restMap.set(d.id, d.data() as Record<string, unknown>));

    const listStats = new Map<string, { total: number; active: number }>();
    listSnap.docs.forEach((d) => {
      const ld = d.data();
      const sid = String(ld.sellerId || '');
      if (!sid) return;
      const cur = listStats.get(sid) || { total: 0, active: 0 };
      cur.total += 1;
      if (ld.status === 'active' || ld.status === 'reserved') cur.active += 1;
      listStats.set(sid, cur);
    });

    const dealStats = new Map<string, { buyerDeals: number; sellerDeals: number; activeDeals: number }>();
    const termSet = new Set(['settled', 'refunded', 'cancelled']);
    dealSnap.docs.forEach((d) => {
      const dl = d.data();
      const bid = String(dl.buyerId || '');
      const sid = String(dl.sellerId || '');
      const active = !termSet.has(String(dl.status || ''));
      if (bid) {
        const cur = dealStats.get(bid) || { buyerDeals: 0, sellerDeals: 0, activeDeals: 0 };
        cur.buyerDeals += 1;
        if (active) cur.activeDeals += 1;
        dealStats.set(bid, cur);
      }
      if (sid) {
        const cur = dealStats.get(sid) || { buyerDeals: 0, sellerDeals: 0, activeDeals: 0 };
        cur.sellerDeals += 1;
        if (active) cur.activeDeals += 1;
        dealStats.set(sid, cur);
      }
    });

    const allUids = new Set<string>([...pubMap.keys(), ...privMap.keys()]);
    const nowMs = Date.now();
    const sevenDaysAgo = nowMs - 7 * 24 * 3_600_000;

    const allRows: AdminDirectoryUserItem[] = Array.from(allUids).map((uid) => {
      const pub = pubMap.get(uid) || {};
      const priv = privMap.get(uid) || {};
      const rest = restMap.get(uid) || {};
      const lStat = listStats.get(uid) || { total: 0, active: 0 };
      const dStat = dealStats.get(uid) || { buyerDeals: 0, sellerDeals: 0, activeDeals: 0 };
      const rawStatus = String(rest.accountStatus || 'active');
      let mappedStatus: AdminDirectoryUserItem['accountStatus'] = 'active';
      if (rawStatus === 'permanent_ban') mappedStatus = 'banned';
      else if (rawStatus === 'protective_suspension' || rawStatus === 'temporary_suspension')
        mappedStatus = 'suspended';
      else if (rawStatus === 'restricted') mappedStatus = 'restricted';
      else if (rawStatus === 'warned') mappedStatus = 'warned';

      const email = String(priv.email || '').trim();
      const phone = String(priv.phone || '').trim();
      const pubCreated = (pub.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() || 0;
      const privCreated = (priv.createdAt as { toMillis?: () => number } | undefined)?.toMillis?.() || 0;

      return {
        uid,
        displayName: String(pub.displayName || email.split('@')[0] || 'Member'),
        username: String(pub.username || ''),
        avatarUrl: typeof pub.avatarUrl === 'string' ? pub.avatarUrl : '',
        location: String(pub.location || ''),
        email,
        phone,
        phoneCountryCode: String(priv.phoneCountryCode || ''),
        emailVerified: Boolean(priv.emailVerified),
        phoneVerified: Boolean(priv.phoneVerified),
        nidVerified: Boolean(pub.nidVerified || priv.nidStatus === 'verified'),
        nidStatus: String(priv.nidStatus || 'not_verified'),
        accountStatus: mappedStatus,
        rawModerationStatus: rawStatus,
        activeStrikes: Number(rest.activeStrikes || 0),
        walletBalanceMinor: Number(priv.walletBalanceMinor || 0),
        reservedBalanceMinor: Number(priv.reservedBalanceMinor || 0),
        completedSales: Number(pub.completedSales || 0),
        completedPurchases: Number(pub.completedPurchases || 0),
        totalListings: lStat.total,
        activeListings: lStat.active,
        buyerDealsCount: dStat.buyerDeals,
        sellerDealsCount: dStat.sellerDeals,
        activeDealsCount: dStat.activeDeals,
        createdAtMs: pubCreated || privCreated || 0,
        lastSignInAtMs: null,
      };
    });

    setSummary({
      totalUsers: allRows.length,
      activeUsers: allRows.filter((u) => u.accountStatus === 'active' || u.accountStatus === 'warned').length,
      suspendedUsers: allRows.filter(
        (u) => u.accountStatus === 'suspended' || u.accountStatus === 'restricted'
      ).length,
      bannedUsers: allRows.filter((u) => u.accountStatus === 'banned').length,
      verifiedUsers: allRows.filter((u) => u.emailVerified || u.phoneVerified || u.nidVerified).length,
      unverifiedUsers: allRows.filter((u) => !u.emailVerified && !u.phoneVerified && !u.nidVerified).length,
      recentlyRegistered7d: allRows.filter((u) => u.createdAtMs >= sevenDaysAgo).length,
    });

    const qLower = appliedQuery.trim().toLowerCase();
    const qDigits = qLower.replace(/\D/g, '');
    const filtered = allRows
      .filter((u) => {
        if (qLower) {
          const pDigits = u.phone.replace(/\D/g, '');
          const hit =
            u.uid.toLowerCase().includes(qLower) ||
            u.username.toLowerCase().includes(qLower.replace(/^@/, '')) ||
            u.displayName.toLowerCase().includes(qLower) ||
            u.email.toLowerCase().includes(qLower) ||
            u.phone.toLowerCase().includes(qLower) ||
            (qDigits.length >= 5 && pDigits.includes(qDigits));
          if (!hit) return false;
        }
        if (accountStatus !== 'all' && u.accountStatus !== accountStatus) return false;
        if (emailVerifiedFilter === 'verified' && !u.emailVerified) return false;
        if (emailVerifiedFilter === 'unverified' && u.emailVerified) return false;
        if (phoneVerifiedFilter === 'verified' && !u.phoneVerified) return false;
        if (phoneVerifiedFilter === 'unverified' && u.phoneVerified) return false;
        if (sellerStatusFilter === 'has_listings' && u.totalListings === 0) return false;
        if (sellerStatusFilter === 'verified_seller' && !u.nidVerified) return false;
        if (sellerStatusFilter === 'no_listings' && u.totalListings > 0) return false;
        if (
          buyerActivityFilter === 'has_purchases' &&
          u.completedPurchases === 0 &&
          u.buyerDealsCount === 0
        ) {
          return false;
        }
        if (registeredDays > 0 && u.createdAtMs < nowMs - registeredDays * 24 * 3_600_000) {
          return false;
        }
        return true;
      })
      .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));

    const tPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    const safePage = Math.max(1, Math.min(tPages, page));
    const start = (safePage - 1) * pageSize;
    setTotalMatched(filtered.length);
    setTotalPages(tPages);
    setUsers(filtered.slice(start, start + pageSize));
  }, [
    appliedQuery,
    accountStatus,
    emailVerifiedFilter,
    phoneVerifiedFilter,
    sellerStatusFilter,
    buyerActivityFilter,
    registeredDays,
    page,
    pageSize,
  ]);

  const fetchUsersDirectory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fbUser = auth.currentUser;
      if (!fbUser) {
        await loadDirectoryFallbackFromFirestore();
        return;
      }
      const params = new URLSearchParams({
        q: appliedQuery,
        accountStatus,
        emailVerified: emailVerifiedFilter,
        phoneVerified: phoneVerifiedFilter,
        sellerStatus: sellerStatusFilter,
        buyerActivity: buyerActivityFilter,
        registeredDays: String(registeredDays),
        page: String(page),
        pageSize: String(pageSize),
      });

      const resp = await fetchWithFreshBearerToken(`/api/admin/users?${params.toString()}`);

      if (!resp.ok) {
        await loadDirectoryFallbackFromFirestore();
        return;
      }

      const json = (await resp.json()) as {
        ok?: boolean;
        summary?: DirectorySummary;
        pagination?: { page: number; pageSize: number; totalMatched: number; totalPages: number };
        users?: AdminDirectoryUserItem[];
        error?: string;
      };

      if (!json.ok || !Array.isArray(json.users)) {
        await loadDirectoryFallbackFromFirestore();
        return;
      }

      if (json.summary) setSummary(json.summary);
      setUsers(json.users);
      setTotalMatched(json.pagination?.totalMatched ?? json.users.length);
      setTotalPages(json.pagination?.totalPages ?? 1);
    } catch {
      try {
        await loadDirectoryFallbackFromFirestore();
      } catch {
        setError('Could not load registered users right now.');
      }
    } finally {
      setLoading(false);
    }
  }, [
    appliedQuery,
    accountStatus,
    emailVerifiedFilter,
    phoneVerifiedFilter,
    sellerStatusFilter,
    buyerActivityFilter,
    registeredDays,
    page,
    pageSize,
    loadDirectoryFallbackFromFirestore,
  ]);

  useEffect(() => {
    void fetchUsersDirectory();
  }, [fetchUsersDirectory]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(1);
    setAppliedQuery(searchInput.trim());
  };

  const handleResetFilters = () => {
    setSearchInput('');
    setAppliedQuery('');
    setAccountStatus('all');
    setEmailVerifiedFilter('all');
    setPhoneVerifiedFilter('all');
    setSellerStatusFilter('all');
    setBuyerActivityFilter('all');
    setRegisteredDays(0);
    setPage(1);
  };

  const hasActiveFilters =
    Boolean(appliedQuery) ||
    accountStatus !== 'all' ||
    emailVerifiedFilter !== 'all' ||
    phoneVerifiedFilter !== 'all' ||
    sellerStatusFilter !== 'all' ||
    buyerActivityFilter !== 'all' ||
    registeredDays > 0;

  const handleCopyText = async (label: string, value: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      onFlash(`Copied ${label} to clipboard.`);
    } catch {
      onFlash(`${label}: ${value}`);
    }
  };

  // Open Full Profile Inspection Modal
  const handleInspectUser = async (targetUid: string) => {
    setInspectTargetUid(targetUid);
    setInspectTab('contact');
    setInspectLoading(true);
    setInspectError(null);
    setInspectedProfile(null);

    try {
      const fbUser = auth.currentUser;
      if (fbUser) {
        const resp = await fetchWithFreshBearerToken(
          `/api/admin/users/${encodeURIComponent(targetUid)}/inspect`
        );
        const json = (await resp.json()) as {
          ok?: boolean;
          profile?: InspectedUserProfile;
          error?: string;
        };
        if (resp.ok && json.ok && json.profile) {
          setInspectedProfile(json.profile);
          setInspectLoading(false);
          return;
        }
      }

      // Direct Firestore fallback if API route unreachable
      const [pubSnap, privSnap, restSnap, listSnap] = await Promise.all([
        getDoc(doc(db, 'publicProfiles', targetUid)),
        getDoc(doc(db, 'privateUsers', targetUid)),
        getDoc(doc(db, 'userRestrictions', targetUid)),
        getDocs(query(collection(db, 'listings'), where('sellerId', '==', targetUid), limit(50))),
      ]);
      const pub = pubSnap.exists() ? pubSnap.data() : {};
      const priv = privSnap.exists() ? privSnap.data() : {};
      const rest = restSnap.exists() ? restSnap.data() : {};

      await addDoc(collection(db, 'auditLogs'), {
        actorId: adminUid,
        action: 'ADMIN_USER_PROFILE_INSPECTED',
        targetType: 'user',
        targetId: targetUid,
        details: 'Admin inspected user profile via Firestore fallback.',
        createdAt: serverTimestamp(),
      }).catch(() => undefined);

      const listingsArr = listSnap.docs.map((d) => {
        const ld = d.data();
        return {
          id: d.id,
          title: String(ld.title || ''),
          platform: String(ld.platform || ''),
          subcategory: String(ld.subcategory || ''),
          priceMinor: Number(ld.priceMinor || 0),
          currency: String(ld.currency || 'BDT'),
          status: String(ld.status || ''),
          imagesCount: Array.isArray(ld.images) ? ld.images.length : 0,
          createdAtMs: ld.createdAt?.toMillis ? ld.createdAt.toMillis() : 0,
        };
      });

      setInspectedProfile({
        basicInfo: {
          uid: targetUid,
          displayName: String(pub.displayName || 'Member'),
          username: String(pub.username || ''),
          avatarUrl: typeof pub.avatarUrl === 'string' ? pub.avatarUrl : '',
          bio: String(pub.bio || ''),
          location: String(pub.location || ''),
          createdAtMs: pub.createdAt?.toMillis ? pub.createdAt.toMillis() : null,
          email: String(priv.email || ''),
          emailVerified: Boolean(priv.emailVerified),
          phone: String(priv.phone || ''),
          phoneCountryCode: String(priv.phoneCountryCode || ''),
          phoneVerified: Boolean(priv.phoneVerified),
          nidStatus: String(priv.nidStatus || 'not_verified'),
          nidVerified: Boolean(pub.nidVerified || priv.nidStatus === 'verified'),
          adminRoleAssigned: null,
          authProviders: [],
          authDisabled: false,
        },
        marketplaceInfo: {
          totalListings: listingsArr.length,
          activeListings: listingsArr.filter((l) => l.status === 'active').length,
          pendingListings: listingsArr.filter((l) => l.status === 'pending').length,
          rejectedListings: listingsArr.filter((l) => l.status === 'rejected').length,
          soldListings: listingsArr.filter((l) => l.status === 'sold').length,
          totalPurchases: Number(pub.completedPurchases || 0),
          totalSales: Number(pub.completedSales || 0),
          completedDealsCount: 0,
          cancelledOrRefundedDealsCount: 0,
          activeDealsCount: 0,
          listings: listingsArr,
          recentDeals: [],
        },
        walletInfo: {
          walletBalanceMinor: Number(priv.walletBalanceMinor || 0),
          reservedBalanceMinor: Number(priv.reservedBalanceMinor || 0),
          pendingDepositsCount: 0,
          approvedDepositsCount: 0,
          pendingWithdrawalsCount: 0,
          paidWithdrawalsCount: 0,
          ledgerEntries: [],
        },
        securityModerationInfo: {
          accountStatus: String(rest.accountStatus || 'active'),
          activeStrikes: Number(rest.activeStrikes || 0),
          totalHistoricalStrikes: Number(rest.totalHistoricalStrikes || 0),
          financialHoldActive: Boolean(rest.financialHoldActive),
          reason: String(rest.reason || ''),
          latestWarningTitle: String(rest.latestWarningTitle || ''),
          reportsAgainstCount: 0,
          openReportsAgainstCount: 0,
          reportsSubmittedCount: 0,
          appealsCount: 0,
          reportsAgainst: [],
          appeals: [],
        },
        activityInfo: {
          lastSignInAtMs: null,
          recentAuditEvents: [],
        },
      });
    } catch {
      setInspectError('Failed to load complete user profile record.');
    } finally {
      setInspectLoading(false);
    }
  };

  // Open Superadmin Permanent Delete Modal & Run Preflight
  const handleOpenPermanentDelete = async (userRow: AdminDirectoryUserItem) => {
    setDeleteTargetUser(userRow);
    setConfirmPhrase('');
    setDeleteReason('');
    setRetainEmailSecurityBlock(false);
    setDeleteSubmitError(null);
    setDeletePreflight({
      loading: true,
      error: null,
      eligible: false,
      blockers: [],
      summary: null,
    });

    try {
      const fbUser = auth.currentUser;
      if (!fbUser) {
        setDeletePreflight({
          loading: false,
          error: 'Superadmin session required.',
          eligible: false,
          blockers: ['Superadmin authentication required.'],
          summary: null,
        });
        return;
      }
      const resp = await fetchWithFreshBearerToken(
        `/api/admin/users/${encodeURIComponent(userRow.uid)}/delete-preflight`
      );
      const json = (await resp.json()) as {
        ok?: boolean;
        eligible?: boolean;
        blockers?: string[];
        summary?: DeletePreflightState['summary'];
        error?: string;
      };
      if (!resp.ok || !json.ok) {
        setDeletePreflight({
          loading: false,
          error: json.error || 'Could not verify account deletion eligibility.',
          eligible: false,
          blockers: json.blockers || [],
          summary: json.summary || null,
        });
        return;
      }
      setDeletePreflight({
        loading: false,
        error: null,
        eligible: Boolean(json.eligible),
        blockers: Array.isArray(json.blockers) ? json.blockers : [],
        summary: json.summary || null,
      });
    } catch {
      setDeletePreflight({
        loading: false,
        error: 'Network error while checking account obligations.',
        eligible: false,
        blockers: [],
        summary: null,
      });
    }
  };

  const handleConfirmPermanentDelete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deleteTargetUser || !deletePreflight.eligible) return;

    if (confirmPhrase.trim() !== 'DELETE USER') {
      setDeleteSubmitError('Type DELETE USER in uppercase to confirm permanent account deletion.');
      return;
    }
    if (deleteReason.trim().length < 6) {
      setDeleteSubmitError('Enter a clear administrative reason (at least 6 characters).');
      return;
    }

    setDeletingUser(true);
    setDeleteSubmitError(null);
    try {
      const fbUser = auth.currentUser;
      if (!fbUser) {
        setDeleteSubmitError('Superadmin authentication expired. Please refresh and try again.');
        setDeletingUser(false);
        return;
      }
      const resp = await fetchWithFreshBearerToken(
        `/api/admin/users/${encodeURIComponent(deleteTargetUser.uid)}/permanent-delete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            confirmPhrase: confirmPhrase.trim(),
            reason: deleteReason.trim(),
            retainEmailSecurityBlock,
          }),
        }
      );
      const json = (await resp.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        blockers?: string[];
      };

      if (!resp.ok || !json.ok) {
        setDeleteSubmitError(
          json.error ||
            (Array.isArray(json.blockers) && json.blockers[0]) ||
            'Could not complete permanent user deletion.'
        );
        setDeletingUser(false);
        return;
      }

      const deletedHandle = deleteTargetUser.username
        ? `@${deleteTargetUser.username}`
        : deleteTargetUser.uid;
      setDeleteTargetUser(null);
      onFlash(`USER ACCOUNT PERMANENTLY DELETED (${deletedHandle}).`);
      await fetchUsersDirectory();
    } catch {
      setDeleteSubmitError('Network error while deleting user account.');
    } finally {
      setDeletingUser(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bx-card p-5 sm:p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight flex items-center gap-2">
            <Users className="w-5 h-5 text-[#FF6500]" />
            All Registered Users
          </h1>
          <p className="text-xs opacity-75 mt-1">
            Verified directory of BEXORA accounts, contact verification states, wallet balances, and marketplace obligations. Private contact details are restricted to verified administrators and audit-logged.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchUsersDirectory()}
          disabled={loading}
          className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-extrabold inline-flex items-center gap-2 self-start sm:self-auto"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh Directory
        </button>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-3 tabular-nums">
        <div className="bx-card p-3.5">
          <div className="text-[11px] opacity-70 font-semibold">Total Users</div>
          <div className="text-xl font-black mt-1">{summary.totalUsers}</div>
        </div>
        <div className="bx-card p-3.5">
          <div className="text-[11px] opacity-70 font-semibold">Active</div>
          <div className="text-xl font-black mt-1 text-emerald-600">{summary.activeUsers}</div>
        </div>
        <div className="bx-card p-3.5">
          <div className="text-[11px] opacity-70 font-semibold">Suspended</div>
          <div className="text-xl font-black mt-1 text-amber-600">{summary.suspendedUsers}</div>
        </div>
        <div className="bx-card p-3.5">
          <div className="text-[11px] opacity-70 font-semibold">Banned</div>
          <div className="text-xl font-black mt-1 text-red-600">{summary.bannedUsers}</div>
        </div>
        <div className="bx-card p-3.5">
          <div className="text-[11px] opacity-70 font-semibold">Verified</div>
          <div className="text-xl font-black mt-1">{summary.verifiedUsers}</div>
        </div>
        <div className="bx-card p-3.5">
          <div className="text-[11px] opacity-70 font-semibold">Unverified</div>
          <div className="text-xl font-black mt-1 opacity-80">{summary.unverifiedUsers}</div>
        </div>
        <div className="bx-card p-3.5 col-span-2 sm:col-span-1">
          <div className="text-[11px] opacity-70 font-semibold">New (7 Days)</div>
          <div className="text-xl font-black mt-1 text-[#FF6500]">{summary.recentlyRegistered7d}</div>
        </div>
      </div>

      {/* Search & Multi-Filter Controls */}
      <div className="bx-card p-4 sm:p-5 space-y-4">
        <form onSubmit={handleSearchSubmit} className="flex flex-col sm:flex-row gap-2.5">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-50 pointer-events-none" />
            <input
              type="search"
              aria-label="Search registered users"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by @username, display name, UID, email, or phone (+88017... / 017...)"
              className="bx-input w-full pl-9 pr-3 py-2.5 text-xs font-semibold"
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="bx-btn bx-btn-primary px-4 py-2.5 text-xs font-extrabold"
            >
              Search
            </button>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="bx-btn bx-btn-ghost px-3 py-2.5 text-xs font-bold"
              >
                Reset
              </button>
            )}
          </div>
        </form>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-xs">
          <label className="space-y-1">
            <span className="block text-[11px] font-semibold opacity-70">Account Status</span>
            <select
              value={accountStatus}
              onChange={(e) => {
                setAccountStatus(e.target.value);
                setPage(1);
              }}
              className="bx-input w-full px-2.5 py-2 text-xs font-semibold"
            >
              <option value="all">All Statuses</option>
              <option value="active">Active</option>
              <option value="warned">Warned</option>
              <option value="restricted">Restricted</option>
              <option value="suspended">Suspended</option>
              <option value="banned">Banned</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="block text-[11px] font-semibold opacity-70">Email Verification</span>
            <select
              value={emailVerifiedFilter}
              onChange={(e) => {
                setEmailVerifiedFilter(e.target.value);
                setPage(1);
              }}
              className="bx-input w-full px-2.5 py-2 text-xs font-semibold"
            >
              <option value="all">Any Email State</option>
              <option value="verified">Email Verified</option>
              <option value="unverified">Email Unverified</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="block text-[11px] font-semibold opacity-70">Phone OTP State</span>
            <select
              value={phoneVerifiedFilter}
              onChange={(e) => {
                setPhoneVerifiedFilter(e.target.value);
                setPage(1);
              }}
              className="bx-input w-full px-2.5 py-2 text-xs font-semibold"
            >
              <option value="all">Any Phone State</option>
              <option value="verified">Phone OTP Verified</option>
              <option value="unverified">Phone Unverified</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="block text-[11px] font-semibold opacity-70">Seller Activity</span>
            <select
              value={sellerStatusFilter}
              onChange={(e) => {
                setSellerStatusFilter(e.target.value);
                setPage(1);
              }}
              className="bx-input w-full px-2.5 py-2 text-xs font-semibold"
            >
              <option value="all">All Accounts</option>
              <option value="has_listings">Has Listings</option>
              <option value="verified_seller">NID Verified Seller</option>
              <option value="no_listings">No Listings</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="block text-[11px] font-semibold opacity-70">Buyer Activity</span>
            <select
              value={buyerActivityFilter}
              onChange={(e) => {
                setBuyerActivityFilter(e.target.value);
                setPage(1);
              }}
              className="bx-input w-full px-2.5 py-2 text-xs font-semibold"
            >
              <option value="all">All Buyers</option>
              <option value="has_purchases">Has Deals / Purchases</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="block text-[11px] font-semibold opacity-70">Joined Window</span>
            <select
              value={registeredDays}
              onChange={(e) => {
                setRegisteredDays(Number(e.target.value));
                setPage(1);
              }}
              className="bx-input w-full px-2.5 py-2 text-xs font-semibold"
            >
              <option value={0}>All Time</option>
              <option value={7}>Last 7 Days</option>
              <option value={30}>Last 30 Days</option>
              <option value={90}>Last 90 Days</option>
            </select>
          </label>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="bx-card p-4 border-red-600 text-red-600 text-xs font-bold flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => void fetchUsersDirectory()}
            className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold"
          >
            Retry
          </button>
        </div>
      )}

      {/* Users Directory List / Table */}
      <div className="bx-card overflow-hidden">
        <div className="px-4 py-3 border-b border-[var(--bx-border)] flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="font-bold">
            Showing <span className="tabular-nums">{users.length}</span> of{' '}
            <span className="tabular-nums">{totalMatched}</span> matched accounts
          </div>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-[11px] opacity-80">
              <span>Rows:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(1);
                }}
                className="bx-input px-2 py-1 text-xs font-bold"
              >
                <option value={15}>15</option>
                <option value={25}>25</option>
              </select>
            </label>
          </div>
        </div>

        {loading ? (
          <div className="p-8 text-center text-xs font-semibold opacity-70">
            Loading registered user accounts…
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center space-y-2">
            <div className="text-sm font-bold">No matching user accounts found</div>
            <p className="text-xs opacity-70">
              Adjust your search query or clear active directory filters.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--bx-border)]">
            {users.map((u) => {
              const initials = (u.displayName || u.username || 'U').slice(0, 2).toUpperCase();
              const isSelf = u.uid === adminUid;
              return (
                <div
                  key={u.uid}
                  className="p-4 hover:bg-[var(--bx-surface-alt)] transition-colors flex flex-col xl:flex-row xl:items-center justify-between gap-4"
                >
                  {/* Identity + Contact */}
                  <div className="flex items-start gap-3 min-w-0 flex-1">
                    {u.avatarUrl ? (
                      <img
                        src={u.avatarUrl}
                        alt={u.displayName}
                        className="w-10 h-10 object-cover border border-[var(--bx-border)] shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex items-center justify-center text-xs font-black shrink-0">
                        {initials}
                      </div>
                    )}

                    <div className="min-w-0 space-y-1 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-black truncate">{u.displayName}</span>
                        {u.username && (
                          <span className="text-xs opacity-75 font-mono">@{u.username}</span>
                        )}
                        <span aria-hidden="true" className="text-xs opacity-40">
                          ·
                        </span>
                        <span className={`text-xs font-bold capitalize ${getStatusTextClass(u.accountStatus)}`}>
                          {u.accountStatus}
                        </span>
                        {u.activeStrikes > 0 && (
                          <>
                            <span aria-hidden="true" className="text-xs opacity-40">
                              ·
                            </span>
                            <span className="text-xs font-bold text-red-600 tabular-nums">
                              {u.activeStrikes}/3 Strikes
                            </span>
                          </>
                        )}
                      </div>

                      {/* Restricted Admin-Only Contact & Verification Line */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs opacity-85">
                        <span className="font-mono break-all">
                          {u.email || 'No email recorded'}
                        </span>
                        <span className="text-[11px] opacity-75">
                          ({u.emailVerified ? 'Email Verified' : 'Email Unverified'})
                        </span>
                        <span aria-hidden="true" className="opacity-40">
                          ·
                        </span>
                        <span className="font-mono">
                          {u.phone || 'No phone on file'}
                          {u.phoneCountryCode ? ` [${u.phoneCountryCode}]` : ''}
                        </span>
                        <span
                          className={`text-[11px] font-semibold ${
                            u.phoneVerified ? 'text-emerald-600' : 'text-amber-600'
                          }`}
                        >
                          ({u.phone ? (u.phoneVerified ? 'OTP Verified' : 'Unverified Format Only') : 'Unlinked'})
                        </span>
                      </div>

                      {/* UID + Joined + NID */}
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] opacity-70">
                        <button
                          type="button"
                          onClick={() => void handleCopyText('User UID', u.uid)}
                          className="inline-flex items-center gap-1 font-mono hover:text-[#FF6500]"
                          title="Copy UID"
                        >
                          <span>UID: {u.uid}</span>
                          <Copy className="w-3 h-3" />
                        </button>
                        <span aria-hidden="true">·</span>
                        <span>Joined {formatDateShort(u.createdAtMs)}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          NID: {u.nidVerified ? 'Verified' : u.nidStatus.replace(/_/g, ' ')}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Financial & Marketplace Metrics + Actions */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between xl:justify-end gap-4 shrink-0 pt-2 xl:pt-0 border-t xl:border-t-0 border-[var(--bx-border)]">
                    <div className="grid grid-cols-3 gap-4 text-xs tabular-nums">
                      <div>
                        <div className="text-[11px] opacity-65">Wallet</div>
                        <div className="font-black">
                          {formatMoneyFromMinor(
                            u.walletBalanceMinor,
                            displayCurrency,
                            'BDT',
                            usdToBdtRate
                          )}
                        </div>
                        {u.reservedBalanceMinor > 0 && (
                          <div className="text-[10px] text-amber-600 font-semibold">
                            +{formatMoneyFromMinor(u.reservedBalanceMinor, displayCurrency, 'BDT', usdToBdtRate)} escrow
                          </div>
                        )}
                      </div>
                      <div>
                        <div className="text-[11px] opacity-65">Listings</div>
                        <div className="font-black">
                          {u.activeListings} live / {u.totalListings}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] opacity-65">Deals</div>
                        <div className="font-black">
                          {u.completedSales}S · {u.completedPurchases}B
                          {u.activeDealsCount > 0 ? ` (${u.activeDealsCount} open)` : ''}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleInspectUser(u.uid)}
                        className="bx-btn bx-btn-ghost px-3 py-2 text-xs font-extrabold inline-flex items-center gap-1.5"
                      >
                        <Eye className="w-3.5 h-3.5" />
                        View Profile
                      </button>
                      <button
                        type="button"
                        onClick={onOpenModerationTab}
                        className="bx-btn bx-btn-ghost px-2.5 py-2 text-xs font-bold inline-flex items-center gap-1"
                        title="Open Trust & Safety enforcement controls"
                      >
                        <ShieldAlert className="w-3.5 h-3.5" />
                        Safety
                      </button>
                      {isSuperAdmin && !isSelf && (
                        <button
                          type="button"
                          onClick={() => void handleOpenPermanentDelete(u)}
                          className="bx-btn px-3 py-2 text-xs font-extrabold bg-red-600 text-white border border-[#191919] hover:bg-red-700 inline-flex items-center gap-1.5"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Delete User
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination Footer */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-[var(--bx-border)] flex items-center justify-between gap-3 text-xs tabular-nums">
            <div>
              Page <span className="font-black">{page}</span> of{' '}
              <span className="font-black">{totalPages}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                Previous
              </button>
              <button
                type="button"
                disabled={page >= totalPages || loading}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-bold inline-flex items-center gap-1 disabled:opacity-40"
              >
                Next
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ===================================================================== */}
      {/* MODAL 1: COMPLETE USER PROFILE INSPECTION                             */}
      {/* ===================================================================== */}
      {inspectTargetUid && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Inspect Registered User Profile"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
        >
          <div className="bx-card w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-[var(--bx-border)] flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-bold text-[#FF6500]">
                  Restricted Admin User Record (Audit Logged)
                </div>
                <h2 className="text-lg font-black">
                  {inspectedProfile
                    ? `${inspectedProfile.basicInfo.displayName} ${
                        inspectedProfile.basicInfo.username
                          ? `(@${inspectedProfile.basicInfo.username})`
                          : ''
                      }`
                    : `Inspecting User ${inspectTargetUid}`}
                </h2>
              </div>
              <button
                type="button"
                aria-label="Close user inspection modal"
                onClick={() => {
                  setInspectTargetUid(null);
                  setInspectedProfile(null);
                }}
                className="bx-btn bx-btn-ghost p-2"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {inspectLoading ? (
              <div className="p-10 text-center text-xs font-semibold opacity-75">
                Loading verified database records for {inspectTargetUid}…
              </div>
            ) : inspectError || !inspectedProfile ? (
              <div className="p-8 text-center space-y-3">
                <p className="text-xs font-bold text-red-600">
                  {inspectError || 'User profile could not be loaded.'}
                </p>
                <button
                  type="button"
                  onClick={() => setInspectTargetUid(null)}
                  className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-bold"
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                {/* Interactive Inspection Section Tabs */}
                <div className="px-4 sm:px-5 pt-3 border-b border-[var(--bx-border)] flex flex-wrap gap-1.5">
                  {(
                    [
                      { id: 'contact', label: 'Identity & Contact' },
                      {
                        id: 'marketplace',
                        label: `Marketplace (${inspectedProfile.marketplaceInfo.totalListings})`,
                      },
                      { id: 'wallet', label: 'Wallet & Ledger' },
                      {
                        id: 'moderation',
                        label: `Safety & Strikes (${inspectedProfile.securityModerationInfo.activeStrikes})`,
                      },
                      { id: 'activity', label: 'Audit Activity' },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setInspectTab(t.id)}
                      className={`px-3 py-2 text-xs font-bold border-b-2 transition-colors ${
                        inspectTab === t.id
                          ? 'border-[#FF6500] text-[#FF6500]'
                          : 'border-transparent opacity-75 hover:opacity-100'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="p-4 sm:p-6 overflow-y-auto space-y-5 text-xs">
                  {inspectTab === 'contact' && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-1">
                          <div className="opacity-65">User UID</div>
                          <div className="font-mono font-bold break-all">
                            {inspectedProfile.basicInfo.uid}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="opacity-65">Account Registration Date</div>
                          <div className="font-bold">
                            {formatDateTime(inspectedProfile.basicInfo.createdAtMs)}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="opacity-65">Email Address (Admin-Only PII)</div>
                          <div className="font-mono font-bold break-all">
                            {inspectedProfile.basicInfo.email || 'Not provided'}
                          </div>
                          <div className="text-[11px] opacity-75">
                            Verification:{' '}
                            {inspectedProfile.basicInfo.emailVerified
                              ? 'Verified'
                              : 'Unverified'}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="opacity-65">Phone Number (E.164 & Country)</div>
                          <div className="font-mono font-bold">
                            {inspectedProfile.basicInfo.phone || 'Not provided'}
                            {inspectedProfile.basicInfo.phoneCountryCode
                              ? ` (${inspectedProfile.basicInfo.phoneCountryCode})`
                              : ''}
                          </div>
                          <div
                            className={`text-[11px] font-semibold ${
                              inspectedProfile.basicInfo.phoneVerified
                                ? 'text-emerald-600'
                                : 'text-amber-600'
                            }`}
                          >
                            {inspectedProfile.basicInfo.phone
                              ? inspectedProfile.basicInfo.phoneVerified
                                ? 'SMS OTP Verified'
                                : 'Format Validated Only — SMS OTP Not Completed'
                              : 'No phone linked'}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="opacity-65">National ID (NID) Status</div>
                          <div className="font-bold inline-flex items-center gap-1.5">
                            {inspectedProfile.basicInfo.nidVerified ? (
                              <>
                                <UserCheck className="w-3.5 h-3.5 text-emerald-600" />
                                <span>Verified Identity</span>
                              </>
                            ) : (
                              <span>{inspectedProfile.basicInfo.nidStatus.replace(/_/g, ' ')}</span>
                            )}
                          </div>
                        </div>
                        <div className="space-y-1">
                          <div className="opacity-65">Location & Role</div>
                          <div className="font-bold">
                            {inspectedProfile.basicInfo.location || 'Location not set'} · Role:{' '}
                            {inspectedProfile.basicInfo.adminRoleAssigned || 'Standard Member'}
                          </div>
                        </div>
                      </div>

                      {inspectedProfile.basicInfo.bio && (
                        <div className="pt-3 border-t border-[var(--bx-border)] space-y-1">
                          <div className="opacity-65">Public Bio</div>
                          <p className="whitespace-pre-line">{inspectedProfile.basicInfo.bio}</p>
                        </div>
                      )}
                    </div>
                  )}

                  {inspectTab === 'marketplace' && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 tabular-nums">
                        <div>
                          <div className="opacity-65">Active Listings</div>
                          <div className="text-base font-black">
                            {inspectedProfile.marketplaceInfo.activeListings}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Pending Review</div>
                          <div className="text-base font-black">
                            {inspectedProfile.marketplaceInfo.pendingListings}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Completed Sales</div>
                          <div className="text-base font-black">
                            {inspectedProfile.marketplaceInfo.totalSales}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Purchases</div>
                          <div className="text-base font-black">
                            {inspectedProfile.marketplaceInfo.totalPurchases}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Active Deals</div>
                          <div className="text-base font-black text-[#FF6500]">
                            {inspectedProfile.marketplaceInfo.activeDealsCount}
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 pt-3 border-t border-[var(--bx-border)]">
                        <div className="font-black">Submitted Listings</div>
                        {inspectedProfile.marketplaceInfo.listings.length === 0 ? (
                          <p className="opacity-70">No listings created by this user.</p>
                        ) : (
                          <div className="divide-y divide-[var(--bx-border)] border border-[var(--bx-border)]">
                            {inspectedProfile.marketplaceInfo.listings.map((l) => (
                              <div
                                key={l.id}
                                className="p-2.5 flex flex-wrap items-center justify-between gap-2"
                              >
                                <div className="min-w-0">
                                  <div className="font-bold truncate">{l.title}</div>
                                  <div className="text-[11px] opacity-70">
                                    {l.platform} · {l.subcategory} · {l.imagesCount} photos · Status:{' '}
                                    {l.status}
                                  </div>
                                </div>
                                <div className="font-mono font-bold tabular-nums">
                                  {formatMoneyFromMinor(
                                    l.priceMinor,
                                    displayCurrency,
                                    l.currency === 'USD' ? 'USD' : 'BDT',
                                    usdToBdtRate
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="space-y-2 pt-3 border-t border-[var(--bx-border)]">
                        <div className="font-black">Recent Deals</div>
                        {inspectedProfile.marketplaceInfo.recentDeals.length === 0 ? (
                          <p className="opacity-70">No deals recorded for this user.</p>
                        ) : (
                          <div className="divide-y divide-[var(--bx-border)] border border-[var(--bx-border)]">
                            {inspectedProfile.marketplaceInfo.recentDeals.map((d) => (
                              <div
                                key={d.id}
                                className="p-2.5 flex flex-wrap items-center justify-between gap-2"
                              >
                                <div>
                                  <div className="font-bold">{d.listingTitle || d.id}</div>
                                  <div className="text-[11px] opacity-70">
                                    Role: {d.role} · Status: {d.status} ·{' '}
                                    {formatDateShort(d.createdAtMs)}
                                  </div>
                                </div>
                                <div className="font-mono font-bold tabular-nums">
                                  {formatMoneyFromMinor(
                                    d.baseAmountMinor,
                                    displayCurrency,
                                    d.currency === 'USD' ? 'USD' : 'BDT',
                                    usdToBdtRate
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {inspectTab === 'wallet' && (
                    <div className="space-y-5">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 tabular-nums">
                        <div>
                          <div className="opacity-65 flex items-center gap-1">
                            <Wallet className="w-3.5 h-3.5" /> Available Wallet
                          </div>
                          <div className="text-base font-black mt-0.5">
                            {formatMoneyFromMinor(
                              inspectedProfile.walletInfo.walletBalanceMinor,
                              displayCurrency,
                              'BDT',
                              usdToBdtRate
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Reserved Escrow</div>
                          <div className="text-base font-black mt-0.5">
                            {formatMoneyFromMinor(
                              inspectedProfile.walletInfo.reservedBalanceMinor,
                              displayCurrency,
                              'BDT',
                              usdToBdtRate
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Deposits</div>
                          <div className="text-base font-black mt-0.5">
                            {inspectedProfile.walletInfo.approvedDepositsCount} approved ·{' '}
                            {inspectedProfile.walletInfo.pendingDepositsCount} pending
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Withdrawals</div>
                          <div className="text-base font-black mt-0.5">
                            {inspectedProfile.walletInfo.paidWithdrawalsCount} paid ·{' '}
                            {inspectedProfile.walletInfo.pendingWithdrawalsCount} pending
                          </div>
                        </div>
                      </div>

                      <div className="space-y-2 pt-3 border-t border-[var(--bx-border)]">
                        <div className="font-black">Wallet Ledger Entries</div>
                        {inspectedProfile.walletInfo.ledgerEntries.length === 0 ? (
                          <p className="opacity-70">No wallet ledger transactions recorded.</p>
                        ) : (
                          <div className="divide-y divide-[var(--bx-border)] border border-[var(--bx-border)]">
                            {inspectedProfile.walletInfo.ledgerEntries.map((entry) => (
                              <div
                                key={entry.id}
                                className="p-2.5 flex flex-wrap items-center justify-between gap-2"
                              >
                                <div>
                                  <div className="font-bold">{entry.kind.replace(/_/g, ' ')}</div>
                                  <div className="text-[11px] opacity-70">
                                    {entry.note || entry.referenceId || entry.id} ·{' '}
                                    {formatDateTime(entry.createdAtMs)}
                                  </div>
                                </div>
                                <div className="font-mono font-bold tabular-nums">
                                  {formatMoneyFromMinor(
                                    entry.amountMinor,
                                    displayCurrency,
                                    'BDT',
                                    usdToBdtRate
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {inspectTab === 'moderation' && (
                    <div className="space-y-4">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 tabular-nums">
                        <div>
                          <div className="opacity-65">Moderation State</div>
                          <div
                            className={`font-black mt-0.5 ${getStatusTextClass(
                              inspectedProfile.securityModerationInfo.accountStatus
                            )}`}
                          >
                            {inspectedProfile.securityModerationInfo.accountStatus.replace(
                              /_/g,
                              ' '
                            )}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Active Strikes</div>
                          <div className="font-black mt-0.5">
                            {inspectedProfile.securityModerationInfo.activeStrikes} / 3 (Total:{' '}
                            {inspectedProfile.securityModerationInfo.totalHistoricalStrikes})
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Financial Hold</div>
                          <div className="font-black mt-0.5">
                            {inspectedProfile.securityModerationInfo.financialHoldActive
                              ? 'Active Hold'
                              : 'None'}
                          </div>
                        </div>
                        <div>
                          <div className="opacity-65">Reports Against</div>
                          <div className="font-black mt-0.5">
                            {inspectedProfile.securityModerationInfo.openReportsAgainstCount} open /{' '}
                            {inspectedProfile.securityModerationInfo.reportsAgainstCount} total
                          </div>
                        </div>
                      </div>

                      {inspectedProfile.securityModerationInfo.reason && (
                        <div className="p-3 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
                          <div className="font-bold">Latest Restriction Reason</div>
                          <p className="mt-1 opacity-85">
                            {inspectedProfile.securityModerationInfo.reason}
                          </p>
                        </div>
                      )}
                    </div>
                  )}

                  {inspectTab === 'activity' && (
                    <div className="space-y-4">
                      <div>
                        <span className="opacity-65">Last Firebase Auth Sign-In: </span>
                        <span className="font-bold">
                          {formatDateTime(inspectedProfile.activityInfo.lastSignInAtMs)}
                        </span>
                      </div>

                      <div className="space-y-2 pt-2 border-t border-[var(--bx-border)]">
                        <div className="font-black">Recent Audit Events</div>
                        {inspectedProfile.activityInfo.recentAuditEvents.length === 0 ? (
                          <p className="opacity-70">No recent audit events recorded for this UID.</p>
                        ) : (
                          <div className="divide-y divide-[var(--bx-border)] border border-[var(--bx-border)]">
                            {inspectedProfile.activityInfo.recentAuditEvents.map((ev) => (
                              <div key={ev.id} className="p-2.5 space-y-0.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="font-mono font-bold">{ev.action}</span>
                                  <span className="text-[11px] opacity-65">
                                    {formatDateTime(ev.createdAtMs)}
                                  </span>
                                </div>
                                <div className="opacity-80">{ev.details}</div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ===================================================================== */}
      {/* MODAL 2: SUPERADMIN PERMANENT USER DELETION SAFEGUARD                 */}
      {/* ===================================================================== */}
      {deleteTargetUser && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Permanently Delete User Account"
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-3 sm:p-6 overflow-y-auto"
        >
          <div className="bx-card w-full max-w-xl overflow-hidden">
            <div className="p-4 sm:p-5 border-b border-[var(--bx-border)] flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-red-600">
                <AlertTriangle className="w-5 h-5 shrink-0" />
                <h2 className="text-base sm:text-lg font-black">PERMANENTLY DELETE USER</h2>
              </div>
              <button
                type="button"
                aria-label="Close permanent user delete modal"
                disabled={deletingUser}
                onClick={() => setDeleteTargetUser(null)}
                className="bx-btn bx-btn-ghost p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 sm:p-6 space-y-4 text-xs">
              {/* Target Account Summary */}
              <div className="p-3.5 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-1">
                <div className="font-black text-sm">
                  {deleteTargetUser.displayName}{' '}
                  {deleteTargetUser.username ? `(@${deleteTargetUser.username})` : ''}
                </div>
                <div className="font-mono opacity-80 break-all">UID: {deleteTargetUser.uid}</div>
                <div className="font-mono opacity-80 break-all">
                  Email: {deleteTargetUser.email || 'None'}
                </div>
              </div>

              {deletePreflight.loading ? (
                <div className="py-6 text-center font-semibold opacity-75">
                  Checking active escrow deals, wallet balances, disputes, and moderation investigations…
                </div>
              ) : deletePreflight.error ? (
                <div className="p-3.5 border border-red-600 text-red-600 font-bold">
                  {deletePreflight.error}
                </div>
              ) : !deletePreflight.eligible ? (
                <div className="space-y-3">
                  <div className="p-3.5 border border-red-600 bg-red-600/10 space-y-2">
                    <div className="font-black text-red-600">
                      USER CANNOT BE PERMANENTLY DELETED RIGHT NOW
                    </div>
                    <p className="opacity-90">
                      To protect marketplace funds, escrow obligations, and active investigations, resolve all blockers below before deleting this account (use Suspend or Ban in Trust & Safety if immediate access restriction is needed):
                    </p>
                    <ul className="list-disc pl-5 space-y-1 font-semibold">
                      {deletePreflight.blockers.map((b, idx) => (
                        <li key={idx}>{b}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => {
                        setDeleteTargetUser(null);
                        onOpenModerationTab();
                      }}
                      className="bx-btn bx-btn-ghost px-4 py-2 text-xs font-bold"
                    >
                      Open Trust & Safety Instead
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTargetUser(null)}
                      className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleConfirmPermanentDelete} className="space-y-4">
                  <div className="p-3 border border-emerald-600/40 bg-emerald-600/5 flex items-start gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <div className="font-bold text-emerald-700 dark:text-emerald-400">
                        Zero Active Financial or Escrow Obligations
                      </div>
                      <p className="opacity-80 mt-0.5">
                        Firebase Auth credentials, public/private profile records, username handle, and non-transactional listings ({deletePreflight.summary?.listingsCount ?? 0}) will be permanently removed. Historical settled audit/ledger records remain intact.
                      </p>
                    </div>
                  </div>

                  <label className="flex items-start gap-2.5 p-3 border border-[var(--bx-border)] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={retainEmailSecurityBlock}
                      onChange={(e) => setRetainEmailSecurityBlock(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-bold block">
                        Block this email from future re-registration (Fraud / Abuse Blocklist)
                      </span>
                      <span className="opacity-75 block mt-0.5">
                        Leave unchecked to completely free this email address in Firebase Authentication so the user can cleanly register a new account later.
                      </span>
                    </span>
                  </label>

                  <label className="block space-y-1">
                    <span className="font-bold">Mandatory Administrative Deletion Reason</span>
                    <textarea
                      required
                      rows={2}
                      value={deleteReason}
                      onChange={(e) => setDeleteReason(e.target.value)}
                      placeholder="Explain why this account is being permanently deleted (recorded in immutable auditLogs)…"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </label>

                  <label className="block space-y-1">
                    <span className="font-bold">
                      Type <span className="font-mono text-red-600">DELETE USER</span> to confirm
                    </span>
                    <input
                      type="text"
                      required
                      value={confirmPhrase}
                      onChange={(e) => setConfirmPhrase(e.target.value)}
                      placeholder="DELETE USER"
                      className="bx-input w-full px-3 py-2 text-xs font-mono font-bold"
                    />
                  </label>

                  {deleteSubmitError && (
                    <div className="p-2.5 border border-red-600 text-red-600 font-bold">
                      {deleteSubmitError}
                    </div>
                  )}

                  <div className="flex items-center justify-end gap-2.5 pt-2">
                    <button
                      type="button"
                      disabled={deletingUser}
                      onClick={() => setDeleteTargetUser(null)}
                      className="bx-btn bx-btn-ghost px-4 py-2.5 text-xs font-bold"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={deletingUser || confirmPhrase.trim() !== 'DELETE USER'}
                      className="bx-btn px-4 py-2.5 text-xs font-extrabold bg-red-600 text-white border border-[#191919] hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" />
                      {deletingUser ? 'Deleting Account…' : 'Confirm Permanent Delete'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
