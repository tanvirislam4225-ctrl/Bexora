import React, { useEffect, useRef, useState } from 'react';
import {
  ConfirmationResult,
  EmailAuthProvider,
  linkWithPhoneNumber,
  reauthenticateWithCredential,
  RecaptchaVerifier,
  updatePassword,
  updateProfile,
} from 'firebase/auth';
import {
  collection,
  deleteField,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ArrowLeft,
  Bell,
  Camera,
  CheckCircle2,
  Clock,
  Eye,
  EyeOff,
  FileCheck2,
  Gavel,
  Heart,
  KeyRound,
  Mail,
  MapPin,
  MessageSquare,
  Phone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Upload,
  UserCheck,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import {
  BidRecord,
  CurrencyCode,
  DealRecord,
  FavoriteRecord,
  IdentityVerificationRecord,
  MarketplaceListing,
  PrivateUser,
  PublicProfile,
  ReviewRecord,
  SellerFollowRecord,
} from '../types';
import {
  auth,
  db,
  detectFirebaseAuthCapabilities,
  extractUserFacingFirestoreError,
  formatFirebaseAuthError,
  safeRefreshCurrentUserToken,
  safeSendEmailVerification,
  validateAndProcessImageFile,
} from '../lib/firebase';
import {
  calculateAverageRating,
  formatMoneyFromMinor,
  getBidStatusLabel,
  getListingStatusBadgeMeta,
  isBidAcceptedAwaitingPaymentStatus,
  normalizeUsername,
  validateStrongPassword,
  validateUsername,
} from '../lib/marketplaceLogic';
import { resolveSellerFollowerCount } from '../lib/engagementLogic';
import type { FollowTargetSellerSummary } from '../lib/engagementService';
import { ListingCard } from './ListingCard';
import { emitUserNotification } from '../lib/notificationService';

interface OwnerProfileProps {
  mode: 'owner';
  userUid: string;
  profile: PublicProfile;
  privateUser: PrivateUser;
  myListings: MarketplaceListing[];
  myBids?: BidRecord[];
  activeListings?: MarketplaceListing[];
  favorites?: ReadonlyArray<FavoriteRecord>;
  followedSellers?: ReadonlyArray<SellerFollowRecord>;
  deals?: ReadonlyArray<DealRecord>;
  unreadNotificationCount?: number;
  favoriteListingIds?: ReadonlySet<string>;
  onToggleFavorite?: (l: MarketplaceListing) => void;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onOpenListing: (l: MarketplaceListing) => void;
  onEditListing?: (l: MarketplaceListing) => void;
  onOpenListingById?: (listingId: string) => void;
  onOpenDeal?: (dealId: string) => void;
  onOpenFavoritesPage?: () => void;
  onOpenMyBidsPage?: () => void;
  onOpenFollowingPage?: () => void;
  onOpenDealsPage?: () => void;
  onOpenNotificationCenter?: () => void;
  onOpenWallet: () => void;
  onOpenPublicSelf: () => void;
  onAuthTokenRefreshed?: () => Promise<void> | void;
  onFlash: (msg: string) => void;
}

interface VisitorProfileProps {
  mode: 'visitor';
  targetUid: string;
  viewerUid: string | null;
  isFollowingSeller?: boolean;
  onToggleFollowSeller?: (seller: FollowTargetSellerSummary) => void;
  favoriteListingIds?: ReadonlySet<string>;
  onToggleFavorite?: (l: MarketplaceListing) => void;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onBack: () => void;
  onOpenListing: (l: MarketplaceListing) => void;
  onMessageSeller: (sellerUid: string, sellerName: string, listing?: MarketplaceListing) => void;
}

export type ProfileViewProps = OwnerProfileProps | VisitorProfileProps;

export const ProfileView: React.FC<ProfileViewProps> = (props) => {
  if (props.mode === 'visitor') {
    return <VisitorProfileSection {...props} />;
  }
  return <OwnerProfileSection {...props} />;
};

const VisitorProfileSection: React.FC<VisitorProfileProps> = ({
  targetUid,
  viewerUid,
  isFollowingSeller = false,
  onToggleFollowSeller,
  favoriteListingIds,
  onToggleFavorite,
  displayCurrency,
  usdToBdtRate,
  onBack,
  onOpenListing,
  onMessageSeller,
}) => {
  const [pubProfile, setPubProfile] = useState<PublicProfile | null>(null);
  const [sellerListings, setSellerListings] = useState<MarketplaceListing[]>([]);
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);

    // Real-time public profile subscription so followerCount updates immediately on Follow/Unfollow
    const unsubPub = onSnapshot(
      doc(db, 'publicProfiles', targetUid),
      (pubSnap) => {
        if (!active) return;
        if (pubSnap.exists()) {
          const d = pubSnap.data();
          setPubProfile({
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
            followerCount: d.followerCount !== undefined ? Number(d.followerCount || 0) : 0,
          });
        } else {
          setPubProfile(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error('Error subscribing to public profile:', err);
        if (active) setLoading(false);
      }
    );

    async function loadListingsAndReviews() {
      try {
        const listQ = query(
          collection(db, 'listings'),
          where('sellerId', '==', targetUid),
          where('status', 'in', ['active', 'reserved'])
        );
        const listSnap = await getDocs(listQ);
        if (!active) return;
        const loadedListings: MarketplaceListing[] = listSnap.docs.map((docSnap) => {
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
        loadedListings.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setSellerListings(loadedListings);

        const revQ = query(collection(db, 'reviews'), where('sellerId', '==', targetUid));
        const revSnap = await getDocs(revQ);
        if (!active) return;
        const loadedReviews: ReviewRecord[] = revSnap.docs.map((rDoc) => {
          const rd = rDoc.data();
          return {
            id: rDoc.id,
            dealId: rd.dealId,
            sellerId: rd.sellerId,
            reviewerId: rd.reviewerId,
            reviewerName: rd.reviewerName,
            score: Number(rd.score || 0),
            comment: rd.comment || '',
            createdAtMs: rd.createdAt?.toMillis ? rd.createdAt.toMillis() : Date.now(),
          };
        });
        loadedReviews.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setReviews(loadedReviews);
      } catch (err) {
        console.error('Error loading public listings/reviews:', err);
      }
    }
    void loadListingsAndReviews();
    return () => {
      active = false;
      unsubPub();
    };
  }, [targetUid]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-12 text-center">
        <p className="font-bold text-sm opacity-75">Loading public seller profile…</p>
      </div>
    );
  }

  if (!pubProfile) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-12">
        <div className="bx-card p-8 text-center space-y-4">
          <h2 className="text-xl font-extrabold">Profile Not Found</h2>
          <p className="text-sm opacity-75">This public profile does not exist or has not been initialized yet.</p>
          <button type="button" onClick={onBack} className="bx-btn bx-btn-primary px-5 py-2.5 text-sm">
            Back to Marketplace
          </button>
        </div>
      </div>
    );
  }

  const ratingSummary = calculateAverageRating(reviews.map((r) => r.score));
  const initials = (pubProfile.displayName || 'M')
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-bold inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" />
          Back
        </button>
        <span className="text-xs font-bold uppercase tracking-wider px-2.5 py-1 border border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
          Public Profile View
        </span>
      </div>

      {/* Public Header Card */}
      <section className="bx-card overflow-hidden">
        <div className="h-28 bg-gradient-to-r from-[#FF6500] via-[#FF8533] to-[#793A91] border-b-2 border-[var(--bx-border)]" />
        <div className="p-6 sm:p-8 -mt-12 flex flex-col sm:flex-row sm:items-end justify-between gap-6">
          <div className="flex flex-col sm:flex-row sm:items-end gap-4">
            <div className="w-24 h-24 rounded-xl border-2 border-[var(--bx-border)] bg-[var(--bx-surface)] overflow-hidden flex items-center justify-center text-2xl font-black shadow-[3px_3px_0_var(--bx-shadow)]">
              {pubProfile.avatarUrl ? (
                <img
                  src={pubProfile.avatarUrl}
                  alt={pubProfile.displayName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span>{initials}</span>
              )}
            </div>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-black tracking-tight">{pubProfile.displayName}</h1>
                {pubProfile.nidVerified && (
                  <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2 py-0.5 bg-emerald-600 text-white border border-black">
                    <ShieldCheck className="w-3.5 h-3.5" />
                    NID Verified
                  </span>
                )}
                {pubProfile.completedTrader && (
                  <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2 py-0.5 bg-[#793A91] text-white border border-black">
                    <UserCheck className="w-3.5 h-3.5" />
                    Completed Trader
                  </span>
                )}
              </div>
              <p className="text-sm font-bold opacity-75">@{pubProfile.username}</p>
              {pubProfile.location && (
                <p className="text-xs opacity-75 inline-flex items-center gap-1">
                  <MapPin className="w-3.5 h-3.5" />
                  {pubProfile.location}
                </p>
              )}
            </div>
          </div>

          {viewerUid !== targetUid && (
            <div className="flex flex-wrap items-center gap-2.5 shrink-0">
              {onToggleFollowSeller && (
                <button
                  type="button"
                  onClick={() =>
                    onToggleFollowSeller({
                      uid: pubProfile.uid,
                      displayName: pubProfile.displayName,
                      username: pubProfile.username,
                      avatarUrl: pubProfile.avatarUrl,
                      nidVerified: pubProfile.nidVerified,
                    })
                  }
                  aria-pressed={isFollowingSeller}
                  aria-label={
                    isFollowingSeller
                      ? `Unfollow seller ${pubProfile.displayName}`
                      : `Follow seller ${pubProfile.displayName}`
                  }
                  className={`bx-btn px-4 py-2.5 text-sm font-extrabold inline-flex items-center gap-2 whitespace-nowrap ${
                    isFollowingSeller ? 'bx-btn-ghost' : 'bx-btn-primary'
                  }`}
                >
                  {isFollowingSeller ? (
                    <>
                      <UserCheck className="w-4 h-4 text-[var(--green)]" />
                      <span>Following</span>
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-4 h-4" />
                      <span>Follow Seller</span>
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                onClick={() => onMessageSeller(pubProfile.uid, pubProfile.displayName, sellerListings[0])}
                className="bx-btn bx-btn-ghost px-4 py-2.5 text-sm font-extrabold inline-flex items-center gap-2 whitespace-nowrap"
              >
                <MessageSquare className="w-4 h-4 text-[#FF6500]" />
                <span>Message Seller</span>
              </button>
            </div>
          )}
        </div>

        <div className="px-6 sm:px-8 pb-6 space-y-6">
          {pubProfile.bio && <p className="text-sm leading-relaxed max-w-3xl">{pubProfile.bio}</p>}

          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2">
            <div className="p-3.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              <div className="text-xs font-bold uppercase opacity-70">Followers</div>
              <div className="text-xl font-black mt-1 tabular-nums">
                {resolveSellerFollowerCount(pubProfile)}
              </div>
            </div>
            <div className="p-3.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              <div className="text-xs font-bold uppercase opacity-70">Completed Sales</div>
              <div className="text-xl font-black mt-1 tabular-nums">{pubProfile.completedSales}</div>
            </div>
            <div className="p-3.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              <div className="text-xs font-bold uppercase opacity-70">Completed Purchases</div>
              <div className="text-xl font-black mt-1 tabular-nums">{pubProfile.completedPurchases}</div>
            </div>
            <div className="p-3.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              <div className="text-xs font-bold uppercase opacity-70">Active Listings</div>
              <div className="text-xl font-black mt-1 tabular-nums">{sellerListings.length}</div>
            </div>
            <div className="p-3.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] col-span-2 sm:col-span-1">
              <div className="text-xs font-bold uppercase opacity-70">Seller Rating</div>
              <div className="text-base font-black mt-1 flex items-center gap-1.5">
                <Star className="w-4 h-4 text-[#FF6500] fill-[#FF6500]" />
                <span>{ratingSummary.label}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Active Public Listings */}
      <section className="space-y-4">
        <h2 className="text-lg font-black tracking-tight">Active Public Listings ({sellerListings.length})</h2>
        {sellerListings.length === 0 ? (
          <div className="bx-card p-8 text-center">
            <p className="text-sm font-bold opacity-75">No active public listings from this seller yet.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {sellerListings.map((item) => (
              <ListingCard
                key={item.id}
                listing={item}
                displayCurrency={displayCurrency}
                usdToBdtRate={usdToBdtRate}
                onOpen={onOpenListing}
                isFavorited={favoriteListingIds ? favoriteListingIds.has(item.id) : false}
                onToggleFavorite={onToggleFavorite}
              />
            ))}
          </div>
        )}
      </section>

      {/* Verified Buyer Reviews */}
      <section className="space-y-4">
        <h2 className="text-lg font-black tracking-tight">Transaction Reviews ({reviews.length})</h2>
        {reviews.length === 0 ? (
          <div className="bx-card p-8 text-center">
            <p className="text-sm font-bold opacity-75">No ratings yet — reviews appear only after settled escrow deals.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {reviews.map((rev) => (
              <div key={rev.id} className="bx-card p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-sm">{rev.reviewerName}</span>
                  <span className="inline-flex items-center gap-1 text-xs font-black text-[#FF6500]">
                    <Star className="w-3.5 h-3.5 fill-[#FF6500]" />
                    {rev.score}.0 / 5
                  </span>
                </div>
                <p className="text-sm opacity-85">{rev.comment}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
};

type OwnerTab = 'overview' | 'listings' | 'bids' | 'reviews' | 'settings' | 'edit' | 'password' | 'nid';

const OwnerProfileSection: React.FC<OwnerProfileProps> = ({
  userUid,
  profile,
  privateUser,
  myListings,
  myBids = [],
  activeListings = [],
  favorites = [],
  followedSellers = [],
  deals = [],
  unreadNotificationCount = 0,
  favoriteListingIds,
  onToggleFavorite,
  displayCurrency,
  usdToBdtRate,
  onOpenListing,
  onEditListing,
  onOpenListingById,
  onOpenDeal,
  onOpenFavoritesPage,
  onOpenMyBidsPage,
  onOpenFollowingPage,
  onOpenDealsPage,
  onOpenNotificationCenter,
  onOpenWallet,
  onOpenPublicSelf,
  onAuthTokenRefreshed,
  onFlash,
}) => {
  const [activeTab, setActiveTab] = useState<OwnerTab>('overview');
  const [listingFilter, setListingFilter] = useState<
    'all' | 'active' | 'reserved' | 'pending' | 'draft' | 'rejected' | 'suspended' | 'sold'
  >('all');
  const [reviews, setReviews] = useState<ReviewRecord[]>([]);

  // Edit Profile State
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [username, setUsername] = useState(profile.username);
  const [bio, setBio] = useState(profile.bio || '');
  const [location, setLocation] = useState(profile.location || '');
  const [avatarUrl, setAvatarUrl] = useState(profile.avatarUrl || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileErr, setProfileErr] = useState('');
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  // Account Settings (Email & Phone Verification)
  const [sendingEmailVer, setSendingEmailVer] = useState(false);
  const [emailCooldownSec, setEmailCooldownSec] = useState(0);
  const [refreshingEmailVer, setRefreshingEmailVer] = useState(false);
  const [phoneInput, setPhoneInput] = useState(privateUser.phone || '');
  const [phoneOtpCode, setPhoneOtpCode] = useState('');
  const [phoneConfirmResult, setPhoneConfirmResult] = useState<ConfirmationResult | null>(null);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [savingContactPhone, setSavingContactPhone] = useState(false);
  const [phoneSmsEnabled, setPhoneSmsEnabled] = useState<boolean | null>(null);
  const [checkingPhoneCaps, setCheckingPhoneCaps] = useState(false);
  const [phoneMsg, setPhoneMsg] = useState('');
  const [phoneErr, setPhoneErr] = useState('');
  const recaptchaVerifierRef = useRef<RecaptchaVerifier | null>(null);

  useEffect(() => {
    setPhoneInput(privateUser.phone || '');
  }, [privateUser.phone]);

  useEffect(() => {
    if (emailCooldownSec <= 0) return;
    const timer = window.setInterval(() => {
      setEmailCooldownSec((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldownSec]);

  useEffect(() => {
    let mounted = true;
    detectFirebaseAuthCapabilities().then((caps) => {
      if (mounted) setPhoneSmsEnabled(caps.phoneSmsEnabled);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Change Password State
  const [currentPwd, setCurrentPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmNewPwd, setConfirmNewPwd] = useState('');
  const [showCurPwd, setShowCurPwd] = useState(false);
  const [showNewPwd, setShowNewPwd] = useState(false);
  const [showConfPwd, setShowConfPwd] = useState(false);
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdErr, setPwdErr] = useState('');

  // NID Front & Back Independent Upload State
  const [existingNidRecord, setExistingNidRecord] = useState<IdentityVerificationRecord | null>(null);
  const [nidFrontData, setNidFrontData] = useState('');
  const [nidBackData, setNidBackData] = useState('');
  const [nidFrontName, setNidFrontName] = useState('');
  const [nidBackName, setNidBackName] = useState('');
  const [nidBusy, setNidBusy] = useState(false);
  const [nidErr, setNidErr] = useState('');
  const nidFrontInputRef = useRef<HTMLInputElement | null>(null);
  const nidBackInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDisplayName(profile.displayName);
    setUsername(profile.username);
    setBio(profile.bio || '');
    setLocation(profile.location || '');
    setAvatarUrl(profile.avatarUrl || '');
  }, [profile]);

  useEffect(() => {
    let active = true;
    async function loadReviewsAndNid() {
      try {
        const revSnap = await getDocs(query(collection(db, 'reviews'), where('sellerId', '==', userUid)));
        if (!active) return;
        const loaded: ReviewRecord[] = revSnap.docs.map((d) => {
          const rd = d.data();
          return {
            id: d.id,
            dealId: rd.dealId,
            sellerId: rd.sellerId,
            reviewerId: rd.reviewerId,
            reviewerName: rd.reviewerName,
            score: Number(rd.score || 0),
            comment: rd.comment || '',
            createdAtMs: rd.createdAt?.toMillis ? rd.createdAt.toMillis() : Date.now(),
          };
        });
        loaded.sort((a, b) => b.createdAtMs - a.createdAtMs);
        setReviews(loaded);

        const nidSnap = await getDoc(doc(db, 'identityVerifications', userUid));
        if (!active) return;
        if (nidSnap.exists()) {
          const nd = nidSnap.data();
          setExistingNidRecord({
            uid: nd.uid,
            frontImageData: nd.frontImageData,
            backImageData: nd.backImageData,
            status: nd.status,
            rejectionReason: nd.rejectionReason,
            reviewedBy: nd.reviewedBy,
          });
          setNidFrontData(nd.frontImageData || '');
          setNidBackData(nd.backImageData || '');
        }
      } catch (err) {
        console.error('Error loading owner profile extras:', err);
      }
    }
    loadReviewsAndNid();
    return () => {
      active = false;
    };
  }, [userUid, privateUser.nidStatus]);

  const ratingSummary = calculateAverageRating(reviews.map((r) => r.score));

  const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setProfileErr('');
    try {
      const processed = await validateAndProcessImageFile(file, 480, 0.8);
      setAvatarUrl(processed);
    } catch (err) {
      setProfileErr(err instanceof Error ? err.message : 'Could not process avatar image.');
    } finally {
      e.target.value = '';
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileErr('');
    const cleanName = displayName.trim();
    if (cleanName.length < 2 || cleanName.length > 80) {
      setProfileErr('Display name must be between 2 and 80 characters.');
      return;
    }
    const unameCheck = validateUsername(username);
    if (!unameCheck.valid) {
      setProfileErr(unameCheck.error || 'Invalid username.');
      return;
    }
    const cleanBio = bio.trim();
    if (cleanBio.length > 500) {
      setProfileErr('Bio must be 500 characters or fewer.');
      return;
    }
    const cleanLocation = location.trim();
    if (cleanLocation.length > 80) {
      setProfileErr('Location must be 80 characters or fewer.');
      return;
    }

    setSavingProfile(true);
    try {
      const oldNorm = normalizeUsername(profile.username);
      const newNorm = unameCheck.normalized;

      await runTransaction(db, async (tx) => {
        const pubRef = doc(db, 'publicProfiles', userUid);
        const pubSnap = await tx.get(pubRef);
        if (!pubSnap.exists()) {
          throw new Error('Public profile record not found.');
        }

        if (newNorm !== oldNorm) {
          const newUnameRef = doc(db, 'usernames', newNorm);
          const newUnameSnap = await tx.get(newUnameRef);
          if (newUnameSnap.exists() && newUnameSnap.data().uid !== userUid) {
            throw new Error(`Username @${newNorm} is already taken. Please choose another.`);
          }
          tx.set(newUnameRef, {
            uid: userUid,
            username: newNorm,
            updatedAt: serverTimestamp(),
          });
          if (oldNorm) {
            tx.delete(doc(db, 'usernames', oldNorm));
          }
        }

        const updatePayload: Record<string, unknown> = {
          displayName: cleanName,
          username: newNorm,
          bio: cleanBio,
          location: cleanLocation,
          updatedAt: serverTimestamp(),
        };
        if (avatarUrl) {
          updatePayload.avatarUrl = avatarUrl;
        }
        tx.update(pubRef, updatePayload);
      });

      if (auth.currentUser) {
        await updateProfile(auth.currentUser, { displayName: cleanName });
      }
      onFlash('Profile & unique username saved successfully.');
    } catch (err) {
      setProfileErr(err instanceof Error ? err.message : 'Failed to update profile.');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSendEmailVerification = async () => {
    if (!auth.currentUser || emailCooldownSec > 0) return;
    setSendingEmailVer(true);
    try {
      await safeSendEmailVerification(auth.currentUser);
      setEmailCooldownSec(60);
      onFlash(
        'Verification email sent via Firebase Authentication! Check your Gmail inbox and Spam folder.'
      );
    } catch (err) {
      onFlash(formatFirebaseAuthError(err));
    } finally {
      setSendingEmailVer(false);
    }
  };

  const handleRefreshEmailVerification = async () => {
    if (!auth.currentUser) return;
    setRefreshingEmailVer(true);
    try {
      const refreshRes = await safeRefreshCurrentUserToken();
      const verified = refreshRes.emailVerified;
      const tokenApiDisabled = refreshRes.tokenServiceBlocked;
      if (verified) {
        if (!privateUser.emailVerified && refreshRes.tokenRefreshed) {
          await updateDoc(doc(db, 'privateUsers', userUid), {
            emailVerified: true,
            updatedAt: serverTimestamp(),
          });
        }
        await emitUserNotification({
          recipientId: userUid,
          eventKey: 'email_verified_confirmed',
          category: 'verification',
          severity: 'success',
          title: 'Email Address Verified',
          preview: 'Your email address is verified and synced with your BEXORA profile.',
          body: `Your email address (${auth.currentUser.email || privateUser.email}) has been verified via Firebase Authentication and linked to your BEXORA security profile.`,
          refType: 'profile',
          refId: userUid,
          referenceLabel: auth.currentUser.email || privateUser.email || 'Account Email',
          destination: 'profile',
        });
        await onAuthTokenRefreshed?.();
      }
      if (!verified) {
        onFlash('Email is still unverified. Click the verification link in your Gmail inbox first.');
      } else if (tokenApiDisabled) {
        onFlash(
          'Email is verified! Sign out and sign back in (or enable Token Service API) to mint a fresh verified token.'
        );
      } else {
        onFlash('Email address is now verified and security token refreshed!');
      }
    } catch (err) {
      onFlash(extractUserFacingFirestoreError(err, formatFirebaseAuthError(err)));
    } finally {
      setRefreshingEmailVer(false);
    }
  };

  const handleSaveContactPhoneOnly = async () => {
    setPhoneErr('');
    setPhoneMsg('');
    const formatted = phoneInput.trim().replace(/[\s-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(formatted)) {
      setPhoneErr('Enter your phone number in international E.164 format (e.g. +8801712345678).');
      return;
    }
    setSavingContactPhone(true);
    try {
      await updateDoc(doc(db, 'privateUsers', userUid), {
        phone: formatted,
        updatedAt: serverTimestamp(),
      });
      setPhoneInput(formatted);
      setPhoneMsg('Contact phone saved privately to your account (unverified until SMS OTP is enabled).');
      onFlash('Contact phone number saved.');
    } catch (err) {
      setPhoneErr(extractUserFacingFirestoreError(err, 'Could not save phone number.'));
    } finally {
      setSavingContactPhone(false);
    }
  };

  const handleRecheckPhoneCapabilities = async () => {
    setCheckingPhoneCaps(true);
    setPhoneErr('');
    try {
      const caps = await detectFirebaseAuthCapabilities(true);
      setPhoneSmsEnabled(caps.phoneSmsEnabled);
      if (caps.phoneSmsEnabled) {
        setPhoneMsg('Firebase Phone Auth SMS is now active! You can request an OTP code below.');
      } else {
        setPhoneMsg('');
      }
    } finally {
      setCheckingPhoneCaps(false);
    }
  };

  const handleSendPhoneVerification = async () => {
    if (!auth.currentUser) return;
    setPhoneErr('');
    setPhoneMsg('');
    const formatted = phoneInput.trim().replace(/[\s-]/g, '');
    if (!/^\+[1-9]\d{7,14}$/.test(formatted)) {
      setPhoneErr('Enter your phone number in international E.164 format (e.g. +8801712345678).');
      return;
    }
    setPhoneBusy(true);
    try {
      if (!recaptchaVerifierRef.current) {
        recaptchaVerifierRef.current = new RecaptchaVerifier(auth, 'bx-phone-recaptcha-container', {
          size: 'invisible',
        });
      }
      const confirmation = await linkWithPhoneNumber(auth.currentUser, formatted, recaptchaVerifierRef.current);
      setPhoneConfirmResult(confirmation);
      setPhoneMsg('SMS verification code sent by Firebase Phone Auth. Enter the 6-digit code below.');
    } catch (err) {
      if (recaptchaVerifierRef.current) {
        recaptchaVerifierRef.current.clear();
        recaptchaVerifierRef.current = null;
      }
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('auth/operation-not-allowed') || raw.includes('auth/billing-not-enabled')) {
        setPhoneSmsEnabled(false);
        setPhoneErr(
          'Firebase Phone Auth SMS is currently disabled on Spark free tier. Enable the Phone provider & Blaze billing in Firebase Console if you want live SMS OTP.'
        );
      } else {
        setPhoneErr(formatFirebaseAuthError(err));
      }
    } finally {
      setPhoneBusy(false);
    }
  };

  const handleConfirmPhoneOtp = async () => {
    if (!phoneConfirmResult) return;
    setPhoneErr('');
    if (phoneOtpCode.trim().length < 6) {
      setPhoneErr('Enter the 6-digit SMS code.');
      return;
    }
    setPhoneBusy(true);
    try {
      await phoneConfirmResult.confirm(phoneOtpCode.trim());
      const refreshRes = await safeRefreshCurrentUserToken();
      const verifiedPhone = phoneInput.trim().replace(/[\s-]/g, '');
      await updateDoc(doc(db, 'privateUsers', userUid), {
        phone: verifiedPhone,
        ...(refreshRes.tokenRefreshed ? { phoneVerified: true } : {}),
        updatedAt: serverTimestamp(),
      });
      await emitUserNotification({
        recipientId: userUid,
        eventKey: `phone_verified_${verifiedPhone.replace(/[^0-9]/g, '')}`,
        category: 'verification',
        severity: 'success',
        title: 'Phone Number Verified via SMS OTP',
        preview: `${verifiedPhone} is now verified on your BEXORA account.`,
        body: `Your mobile number (${verifiedPhone}) was verified via Firebase Phone Authentication SMS OTP and saved privately to your BEXORA account.`,
        refType: 'profile',
        refId: userUid,
        referenceLabel: verifiedPhone,
        destination: 'profile',
      });
      await onAuthTokenRefreshed?.();
      setPhoneConfirmResult(null);
      setPhoneOtpCode('');
      setPhoneMsg('Phone number verified and linked to your BEXORA account!');
      onFlash('Phone number verified!');
    } catch (err) {
      setPhoneErr(extractUserFacingFirestoreError(err, formatFirebaseAuthError(err)));
    } finally {
      setPhoneBusy(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdErr('');
    if (!auth.currentUser || !auth.currentUser.email) {
      setPwdErr('Password change is only available for email-authenticated accounts.');
      return;
    }
    if (!currentPwd) {
      setPwdErr('Enter your current password to verify your identity.');
      return;
    }
    const pwdCheck = validateStrongPassword(newPwd);
    if (!pwdCheck.valid) {
      setPwdErr(pwdCheck.error || 'New password must be at least 8 characters with letters and numbers.');
      return;
    }
    if (newPwd !== confirmNewPwd) {
      setPwdErr('New password and Confirm new password do not match.');
      return;
    }
    if (newPwd === currentPwd) {
      setPwdErr('New password must be different from your current password.');
      return;
    }

    setPwdBusy(true);
    try {
      const credential = EmailAuthProvider.credential(auth.currentUser.email, currentPwd);
      await reauthenticateWithCredential(auth.currentUser, credential);
      await updatePassword(auth.currentUser, newPwd);
      await emitUserNotification({
        recipientId: userUid,
        eventKey: `password_changed_${Date.now()}`,
        category: 'security',
        severity: 'warning',
        title: 'Account Password Changed',
        preview: 'Your BEXORA sign-in password was updated.',
        body: `Your BEXORA account password (${auth.currentUser.email}) was changed via Profile > Change Password. If you did not authorize this change, reset your password immediately and contact BEXORA Support.`,
        refType: 'profile',
        refId: userUid,
        referenceLabel: 'Account Security',
        destination: 'profile',
      });
      setCurrentPwd('');
      setNewPwd('');
      setConfirmNewPwd('');
      onFlash('Password updated securely via Firebase Authentication.');
    } catch (err) {
      setPwdErr(formatFirebaseAuthError(err));
    } finally {
      setPwdBusy(false);
    }
  };

  // Independent NID Front & Back handlers
  const handleSelectNidFront = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setNidErr('');
    try {
      const compressed = await validateAndProcessImageFile(file, 1100, 0.72, 155_000);
      setNidFrontData(compressed);
      setNidFrontName(file.name);
    } catch (err) {
      setNidErr(err instanceof Error ? err.message : 'Failed to process Front NID image.');
    } finally {
      e.target.value = '';
    }
  };

  const handleSelectNidBack = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setNidErr('');
    try {
      const compressed = await validateAndProcessImageFile(file, 1100, 0.72, 155_000);
      setNidBackData(compressed);
      setNidBackName(file.name);
    } catch (err) {
      setNidErr(err instanceof Error ? err.message : 'Failed to process Back NID image.');
    } finally {
      e.target.value = '';
    }
  };

  const handleSubmitNidVerification = async (e: React.FormEvent) => {
    e.preventDefault();
    setNidErr('');
    if (!nidFrontData) {
      setNidErr('Please upload the Front side of your NID document.');
      return;
    }
    if (!nidBackData) {
      setNidErr('Please upload the Back side of your NID document.');
      return;
    }

    setNidBusy(true);
    try {
      await runTransaction(db, async (tx) => {
        const idRef = doc(db, 'identityVerifications', userUid);
        const privRef = doc(db, 'privateUsers', userUid);
        const existingSnap = await tx.get(idRef);

        if (!existingSnap.exists()) {
          tx.set(idRef, {
            uid: userUid,
            frontImageData: nidFrontData,
            backImageData: nidBackData,
            status: 'pending_review',
            submittedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } else {
          const st = existingSnap.data().status;
          if (st !== 'rejected') {
            throw new Error('Your NID submission is already pending review or verified.');
          }
          tx.update(idRef, {
            frontImageData: nidFrontData,
            backImageData: nidBackData,
            status: 'pending_review',
            rejectionReason: deleteField(),
            reviewedBy: deleteField(),
            submittedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        }

        tx.update(privRef, {
          nidStatus: 'pending_review',
          nidRejectionReason: deleteField(),
          updatedAt: serverTimestamp(),
        });
      });

      await emitUserNotification({
        recipientId: userUid,
        eventKey: `nid_submitted_${Date.now()}`,
        category: 'verification',
        severity: 'info',
        title: 'NID Verification Submitted for Review',
        preview: 'Your Front & Back NID documents are queued for administrator verification.',
        body: 'Your National ID (Front & Back) verification package has been securely submitted to the BEXORA Moderation Queue. You will receive a notification as soon as an administrator approves or reviews your submission.',
        refType: 'profile',
        refId: userUid,
        referenceLabel: 'NID Identity Verification',
        destination: 'profile:nid',
      });

      onFlash('NID Front & Back documents submitted privately for Admin Review.');
    } catch (err) {
      setNidErr(extractUserFacingFirestoreError(err, 'Failed to submit NID documents.'));
    } finally {
      setNidBusy(false);
    }
  };

  const filteredListings =
    listingFilter === 'all' ? myListings : myListings.filter((l) => l.status === listingFilter);

  const hasPasswordProvider = Boolean(
    auth.currentUser?.providerData.some((p) => p.providerId === 'password')
  );

  const nidBadgeLabel =
    privateUser.nidStatus === 'verified'
      ? 'Verified'
      : privateUser.nidStatus === 'pending_review'
      ? 'Pending Review'
      : privateUser.nidStatus === 'rejected'
      ? 'Rejected'
      : 'Not Verified';

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-6">
      {/* Top Owner Profile Banner */}
      <section className="bx-card p-6 sm:p-8 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
        <div className="flex items-center gap-4">
          <div className="w-20 h-20 rounded-xl border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] overflow-hidden flex items-center justify-center text-2xl font-black shrink-0">
            {profile.avatarUrl ? (
              <img src={profile.avatarUrl} alt={profile.displayName} className="w-full h-full object-cover" />
            ) : (
              <span>{profile.displayName.slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-black tracking-tight">{profile.displayName}</h1>
              {profile.nidVerified && (
                <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2 py-0.5 bg-emerald-600 text-white border border-black">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  NID Verified
                </span>
              )}
            </div>
            <p className="text-sm font-bold opacity-75">@{profile.username}</p>
            <div className="flex flex-wrap items-center gap-3 text-xs font-bold pt-1">
              <span className="inline-flex items-center gap-1">
                <Star className="w-3.5 h-3.5 text-[#FF6500] fill-[#FF6500]" />
                {ratingSummary.label}
              </span>
              <span>·</span>
              <span>NID Status: {nidBadgeLabel}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="px-4 py-2.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
            <div className="text-[11px] font-bold uppercase opacity-70">Available Wallet</div>
            <div className="text-lg font-black text-[#FF6500]">
              {formatMoneyFromMinor(privateUser.walletBalanceMinor, displayCurrency, 'BDT', usdToBdtRate)}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenWallet}
            className="bx-btn bx-btn-primary px-4 py-2.5 text-xs font-extrabold inline-flex items-center gap-1.5"
          >
            <Wallet className="w-4 h-4" />
            Deposit / Withdraw
          </button>
          <button
            type="button"
            onClick={onOpenPublicSelf}
            className="bx-btn bx-btn-ghost px-4 py-2.5 text-xs font-extrabold"
          >
            View Public Profile
          </button>
        </div>
      </section>

      {/* Owner Sub-Navigation Tabs */}
      <nav aria-label="My Profile Sections" className="flex flex-wrap gap-2 border-b-2 border-[var(--bx-border)] pb-3">
        {(
          [
            { id: 'overview', label: 'Overview' },
            { id: 'listings', label: `My Listings (${myListings.length})` },
            { id: 'bids', label: `My Bids (${myBids.length})` },
            { id: 'reviews', label: `Reviews (${reviews.length})` },
            { id: 'settings', label: 'Account Settings' },
            { id: 'edit', label: 'Edit Profile' },
            { id: 'password', label: 'Change Password' },
            { id: 'nid', label: `NID Verification (${nidBadgeLabel})` },
          ] as { id: OwnerTab; label: string }[]
        ).map((tItem) => (
          <button
            key={tItem.id}
            type="button"
            onClick={() => setActiveTab(tItem.id)}
            className={`px-3.5 py-2 text-xs font-extrabold border-2 transition-colors ${
              activeTab === tItem.id
                ? 'bg-[#FF6500] text-white border-[#191919]'
                : 'bg-[var(--bx-surface)] border-[var(--bx-border)] hover:bg-[var(--bx-surface-alt)]'
            }`}
          >
            {tItem.label}
          </button>
        ))}
      </nav>

      {/* TAB: OVERVIEW */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="bx-card p-5 space-y-2">
              <h2 className="text-sm font-black uppercase tracking-wide opacity-75">Trade Summary</h2>
              <div className="text-2xl font-black tabular-nums">
                {profile.completedSales + profile.completedPurchases}
              </div>
              <p className="text-xs opacity-75">
                {profile.completedSales} Completed Sales · {profile.completedPurchases} Completed Purchases ·{' '}
                {resolveSellerFollowerCount(profile)} Followers
              </p>
            </div>
            <div className="bx-card p-5 space-y-2">
              <h2 className="text-sm font-black uppercase tracking-wide opacity-75">Security &amp; Verification</h2>
              <ul className="text-xs font-bold space-y-1.5">
                <li className="flex items-center justify-between">
                  <span>Email Verification:</span>
                  <span className={privateUser.emailVerified || auth.currentUser?.emailVerified ? 'text-emerald-600' : 'text-amber-600'}>
                    {privateUser.emailVerified || auth.currentUser?.emailVerified ? 'Verified' : 'Unverified'}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span>Phone Verification:</span>
                  <span className={privateUser.phoneVerified ? 'text-emerald-600' : 'text-amber-600'}>
                    {privateUser.phoneVerified ? 'Verified' : 'Unverified'}
                  </span>
                </li>
                <li className="flex items-center justify-between">
                  <span>NID Identity:</span>
                  <span>{nidBadgeLabel}</span>
                </li>
              </ul>
            </div>
            <div className="bx-card p-5 space-y-2">
              <h2 className="text-sm font-black uppercase tracking-wide opacity-75">Escrow Reserve</h2>
              <div className="text-2xl font-black tabular-nums">
                {formatMoneyFromMinor(privateUser.reservedBalanceMinor, displayCurrency, 'BDT', usdToBdtRate)}
              </div>
              <p className="text-xs opacity-75">Reserved for pending withdrawal requests.</p>
            </div>
          </div>

          {/* MY ACTIVITY OVERVIEW (Real Synchronized Counts & Direct Navigation) */}
          <section className="bx-card p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--bx-border)] pb-3">
              <div>
                <h2 className="text-base sm:text-lg font-black tracking-tight">My Activity Overview</h2>
                <p className="text-xs opacity-75">
                  Live summary of your saved Favorites, bids, followed sellers, listings, escrow deals, and unread alerts.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* 1. Saved Favorites */}
              <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide opacity-75 inline-flex items-center gap-1.5">
                      <Heart className="w-3.5 h-3.5 text-[#FF6500]" />
                      Saved Favorites
                    </span>
                    <span className="text-lg font-black tabular-nums">{favorites.length}</span>
                  </div>
                  <p className="text-xs opacity-80 line-clamp-1">
                    {favorites.length > 0
                      ? `Latest: ${favorites[0].title}`
                      : 'Heart any listing to save it privately'}
                  </p>
                </div>
                {onOpenFavoritesPage && (
                  <button
                    type="button"
                    onClick={onOpenFavoritesPage}
                    className="bx-btn bx-btn-ghost bx-btn-sm text-xs font-extrabold justify-center"
                  >
                    Open Favorites →
                  </button>
                )}
              </div>

              {/* 2. Active & Historical Bids */}
              <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide opacity-75 inline-flex items-center gap-1.5">
                      <Gavel className="w-3.5 h-3.5 text-[#FF6500]" />
                      My Bids
                    </span>
                    <span className="text-lg font-black tabular-nums">{myBids.length}</span>
                  </div>
                  <p className="text-xs opacity-80">
                    {myBids.filter((b) => b.status === 'pending').length} Pending ·{' '}
                    {
                      myBids.filter(
                        (b) =>
                          b.status === 'accepted_pending_payment' ||
                          b.status === 'accepted' ||
                          b.status === 'paid'
                      ).length
                    }{' '}
                    Accepted / Deal
                  </p>
                </div>
                {onOpenMyBidsPage && (
                  <button
                    type="button"
                    onClick={onOpenMyBidsPage}
                    className="bx-btn bx-btn-ghost bx-btn-sm text-xs font-extrabold justify-center"
                  >
                    Manage My Bids →
                  </button>
                )}
              </div>

              {/* 3. Followed Sellers */}
              <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide opacity-75 inline-flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5 text-[#FF6500]" />
                      Followed Sellers
                    </span>
                    <span className="text-lg font-black tabular-nums">{followedSellers.length}</span>
                  </div>
                  <p className="text-xs opacity-80 line-clamp-1">
                    {followedSellers.length > 0
                      ? `Following @${followedSellers[0].sellerUsername}${
                          followedSellers.length > 1 ? ` +${followedSellers.length - 1} more` : ''
                        }`
                      : 'Follow verified sellers for instant listing alerts'}
                  </p>
                </div>
                {onOpenFollowingPage && (
                  <button
                    type="button"
                    onClick={onOpenFollowingPage}
                    className="bx-btn bx-btn-ghost bx-btn-sm text-xs font-extrabold justify-center"
                  >
                    Open Following →
                  </button>
                )}
              </div>

              {/* 4. Listing Updates */}
              <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide opacity-75">
                      My Listings
                    </span>
                    <span className="text-lg font-black tabular-nums">{myListings.length}</span>
                  </div>
                  <p className="text-xs opacity-80">
                    {myListings.filter((l) => l.status === 'active').length} Live ·{' '}
                    {myListings.filter((l) => l.status === 'pending').length} In Review ·{' '}
                    {myListings.filter((l) => l.status === 'rejected' || l.status === 'reserved').length}{' '}
                    Action / Reserved
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setActiveTab('listings')}
                  className="bx-btn bx-btn-ghost bx-btn-sm text-xs font-extrabold justify-center"
                >
                  Review My Listings →
                </button>
              </div>

              {/* 5. Escrow Deals */}
              <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide opacity-75 inline-flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5 text-[#FF6500]" />
                      Escrow Deals
                    </span>
                    <span className="text-lg font-black tabular-nums">{deals.length}</span>
                  </div>
                  <p className="text-xs opacity-80">
                    {
                      deals.filter(
                        (d) => d.status !== 'settled' && d.status !== 'refunded' && d.status !== 'cancelled'
                      ).length
                    }{' '}
                    Active · {deals.filter((d) => d.status === 'settled').length} Settled
                  </p>
                </div>
                {onOpenDealsPage && (
                  <button
                    type="button"
                    onClick={onOpenDealsPage}
                    className="bx-btn bx-btn-ghost bx-btn-sm text-xs font-extrabold justify-center"
                  >
                    Open Deal Rooms →
                  </button>
                )}
              </div>

              {/* 6. Unread Notifications */}
              <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] flex flex-col justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-extrabold uppercase tracking-wide opacity-75 inline-flex items-center gap-1.5">
                      <Bell className="w-3.5 h-3.5 text-[#FF6500]" />
                      Unread Alerts
                    </span>
                    <span className="text-lg font-black tabular-nums text-[#FF6500]">
                      {unreadNotificationCount}
                    </span>
                  </div>
                  <p className="text-xs opacity-80">
                    {unreadNotificationCount > 0
                      ? `${unreadNotificationCount} unread notification${
                          unreadNotificationCount === 1 ? '' : 's'
                        } waiting`
                      : 'All caught up in your Notification Center'}
                  </p>
                </div>
                {onOpenNotificationCenter && (
                  <button
                    type="button"
                    onClick={onOpenNotificationCenter}
                    className="bx-btn bx-btn-ghost bx-btn-sm text-xs font-extrabold justify-center"
                  >
                    Open Notifications →
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      )}

      {/* TAB: MY LISTINGS */}
      {activeTab === 'listings' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {(
              ['all', 'active', 'reserved', 'pending', 'draft', 'rejected', 'suspended', 'sold'] as const
            ).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setListingFilter(st)}
                className={`px-3 py-1.5 text-xs font-bold uppercase border ${
                  listingFilter === st
                    ? 'bg-[#FFD400] text-[#191919] border-[#191919]'
                    : 'bg-[var(--bx-surface)] border-[var(--bx-border)]'
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          {filteredListings.length === 0 ? (
            <div className="bx-card p-8 text-center">
              <p className="text-sm font-bold opacity-75">No listings in this status yet.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredListings.map((item) => {
                const badgeMeta = getListingStatusBadgeMeta(item.status);
                return (
                  <div key={item.id} className="space-y-2">
                    <ListingCard
                      listing={item}
                      displayCurrency={displayCurrency}
                      usdToBdtRate={usdToBdtRate}
                      onOpen={onOpenListing}
                      isFavorited={favoriteListingIds ? favoriteListingIds.has(item.id) : false}
                      onToggleFavorite={onToggleFavorite}
                    />
                    <div className="px-3 py-2.5 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-2 text-xs font-bold">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span>Status: {badgeMeta.label}</span>
                        {item.activeDealId &&
                          onOpenDeal &&
                          (item.status === 'reserved' || item.status === 'sold') && (
                            <button
                              type="button"
                              onClick={() => onOpenDeal(item.activeDealId!)}
                              className="text-[#FF6500] hover:underline shrink-0"
                            >
                              Open Deal Room →
                            </button>
                          )}
                      </div>
                      {item.rejectionReason && (
                        <p className="text-red-600 text-[11px] leading-snug break-words">
                          Moderator Note: {item.rejectionReason}
                        </p>
                      )}
                      {onEditListing && (item.status === 'draft' || item.status === 'rejected') && (
                        <button
                          type="button"
                          onClick={() => onEditListing(item)}
                          className="bx-btn bx-btn-primary bx-btn-sm w-full justify-center"
                        >
                          {item.status === 'draft' ? 'Edit & Submit Draft' : 'Edit & Resubmit Listing'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB: MY BIDS */}
      {activeTab === 'bids' && (
        <div className="space-y-4">
          {myBids.length === 0 ? (
            <div className="bx-card p-8 text-center">
              <p className="text-sm font-bold opacity-75">
                You have not placed any bids yet. Open any active marketplace listing to submit an offer.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {myBids.map((b) => {
                const matchedListing =
                  activeListings.find((l) => l.id === b.listingId) ||
                  myListings.find((l) => l.id === b.listingId);
                const acceptedAwaitingPay = isBidAcceptedAwaitingPaymentStatus(b.status);
                const linkedDealId = b.dealId || matchedListing?.activeDealId;

                return (
                  <div
                    key={b.id}
                    className="bx-card p-4 flex flex-wrap items-center justify-between gap-4"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="text-sm font-extrabold truncate">
                        {matchedListing ? matchedListing.title : `Listing #${b.listingId.slice(0, 12)}`}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs font-bold tabular-nums opacity-85">
                        <span>
                          Your Bid:{' '}
                          {formatMoneyFromMinor(b.amountMinor, displayCurrency, b.currency, usdToBdtRate)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className={acceptedAwaitingPay || b.status === 'paid' ? 'text-[#FF6500]' : ''}>
                          {getBidStatusLabel(b.status)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{new Date(b.createdAtMs).toLocaleString()}</span>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {onOpenListingById && (
                        <button
                          type="button"
                          onClick={() => onOpenListingById(b.listingId)}
                          className="bx-btn bx-btn-ghost px-3 py-1.5 text-xs font-extrabold"
                        >
                          View Listing
                        </button>
                      )}
                      {(acceptedAwaitingPay || b.status === 'paid') && linkedDealId && onOpenDeal && (
                        <button
                          type="button"
                          onClick={() => onOpenDeal(linkedDealId)}
                          className="bx-btn bx-btn-primary px-3.5 py-1.5 text-xs font-extrabold"
                        >
                          {acceptedAwaitingPay ? 'Pay Accepted Bid in Deal Room →' : 'Open 3-Party Deal Room →'}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB: REVIEWS */}
      {activeTab === 'reviews' && (
        <div className="space-y-4">
          {reviews.length === 0 ? (
            <div className="bx-card p-8 text-center">
              <p className="text-sm font-bold opacity-75">No ratings yet. Complete escrow sales to earn verified buyer reviews.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {reviews.map((r) => (
                <div key={r.id} className="bx-card p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-extrabold text-sm">{r.reviewerName}</span>
                    <span className="text-xs font-black text-[#FF6500]">{r.score}.0 / 5</span>
                  </div>
                  <p className="text-sm opacity-85">{r.comment}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* TAB: ACCOUNT SETTINGS (EMAIL & PHONE VERIFICATION) */}
      {activeTab === 'settings' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Email Verification Card */}
          <div className="bx-card p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Mail className="w-5 h-5 text-[#FF6500]" />
                <h2 className="text-base font-black">Email Address</h2>
              </div>
              {privateUser.emailVerified || auth.currentUser?.emailVerified ? (
                <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 bg-emerald-600 text-white border border-black">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Verified
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 bg-amber-400 text-black border border-black">
                  <Clock className="w-3.5 h-3.5" />
                  Unverified
                </span>
              )}
            </div>

            <div className="p-3 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-sm font-bold break-all">
              {auth.currentUser?.email || privateUser.email || 'No email linked'}
            </div>

            {!(privateUser.emailVerified || auth.currentUser?.emailVerified) && (
              <div className="space-y-2.5">
                <p className="text-xs opacity-80">
                  Firebase sends a verification link directly to your Gmail / email inbox (check Spam
                  if not visible within 1 minute).
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={sendingEmailVer || emailCooldownSec > 0}
                    onClick={handleSendEmailVerification}
                    className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                  >
                    {sendingEmailVer
                      ? 'Sending…'
                      : emailCooldownSec > 0
                      ? `Resend in ${emailCooldownSec}s`
                      : 'Send Verification Email'}
                  </button>
                  <button
                    type="button"
                    disabled={refreshingEmailVer}
                    onClick={handleRefreshEmailVerification}
                    className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-bold inline-flex items-center gap-1.5"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${refreshingEmailVer ? 'animate-spin' : ''}`} />
                    {refreshingEmailVer ? 'Checking…' : 'I Clicked the Link'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Phone Verification Card (Firebase Phone Auth — Spark/Blaze Aware, Zero 3P SMS) */}
          <div className="bx-card p-6 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Phone className="w-5 h-5 text-[#FF6500]" />
                <h2 className="text-base font-black">Phone Number</h2>
              </div>
              {privateUser.phoneVerified ? (
                <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 bg-emerald-600 text-white border border-black">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Verified
                </span>
              ) : phoneSmsEnabled === false ? (
                <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 bg-slate-200 text-black border border-black">
                  <ShieldAlert className="w-3.5 h-3.5" />
                  SMS OTP Off (Spark Plan)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-xs font-extrabold px-2.5 py-1 bg-amber-400 text-black border border-black">
                  <Clock className="w-3.5 h-3.5" />
                  Unverified
                </span>
              )}
            </div>

            <div id="bx-phone-recaptcha-container" />

            {privateUser.phoneVerified ? (
              <div className="p-3 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-sm font-bold">
                {privateUser.phone}
              </div>
            ) : (
              <div className="space-y-3">
                <div>
                  <label htmlFor="bx-settings-phone" className="block text-xs font-extrabold mb-1">
                    Mobile Number (E.164 Format)
                  </label>
                  <input
                    id="bx-settings-phone"
                    type="tel"
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value)}
                    placeholder="+8801712345678"
                    className="bx-input w-full px-3 py-2 text-sm"
                  />
                </div>

                {phoneSmsEnabled === false ? (
                  <div className="space-y-2.5">
                    <div className="p-3 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] text-xs leading-relaxed">
                      <strong>Free-Tier Notice:</strong> Live SMS OTP is currently off because Firebase
                      Phone Authentication requires enabling the Phone provider and upgrading from
                      Spark (free) to Blaze billing in Firebase Console. You can still save your
                      contact number privately below, and verify via Email + NID for full trading
                      trust.
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={savingContactPhone}
                        onClick={handleSaveContactPhoneOnly}
                        className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                      >
                        {savingContactPhone ? 'Saving…' : 'Save Contact Number'}
                      </button>
                      <button
                        type="button"
                        disabled={checkingPhoneCaps}
                        onClick={handleRecheckPhoneCapabilities}
                        className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-bold inline-flex items-center gap-1.5"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${checkingPhoneCaps ? 'animate-spin' : ''}`} />
                        {checkingPhoneCaps ? 'Checking…' : 'Re-check SMS Status'}
                      </button>
                    </div>
                  </div>
                ) : !phoneConfirmResult ? (
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={phoneBusy}
                      onClick={handleSendPhoneVerification}
                      className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                    >
                      {phoneBusy ? 'Requesting SMS…' : 'Send SMS Code'}
                    </button>
                    <button
                      type="button"
                      disabled={savingContactPhone}
                      onClick={handleSaveContactPhoneOnly}
                      className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-bold"
                    >
                      {savingContactPhone ? 'Saving…' : 'Save Without OTP'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <label htmlFor="bx-settings-phone-otp" className="block text-xs font-extrabold">
                      Enter 6-Digit SMS Code
                    </label>
                    <div className="flex gap-2">
                      <input
                        id="bx-settings-phone-otp"
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={phoneOtpCode}
                        onChange={(e) => setPhoneOtpCode(e.target.value)}
                        placeholder="123456"
                        className="bx-input flex-1 px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        disabled={phoneBusy}
                        onClick={handleConfirmPhoneOtp}
                        className="bx-btn bx-btn-primary px-4 py-2 text-xs font-extrabold"
                      >
                        Confirm OTP
                      </button>
                    </div>
                  </div>
                )}

                {phoneMsg && <p className="text-xs font-bold text-emerald-600">{phoneMsg}</p>}
                {phoneErr && <p className="text-xs font-bold text-red-600">{phoneErr}</p>}
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB: EDIT PROFILE & ATOMIC USERNAME UNIQUENESS */}
      {activeTab === 'edit' && (
        <form onSubmit={handleSaveProfile} className="bx-card p-6 sm:p-8 max-w-2xl space-y-5">
          <h2 className="text-lg font-black">Edit Public Profile & Unique Username</h2>
          {profileErr && (
            <div className="p-3 border-2 border-red-600 bg-red-500/10 text-red-600 text-xs font-bold">
              {profileErr}
            </div>
          )}

          <div className="flex items-center gap-4">
            <div className="w-16 h-16 rounded-xl border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] overflow-hidden flex items-center justify-center font-black">
              {avatarUrl ? (
                <img src={avatarUrl} alt="Avatar preview" className="w-full h-full object-cover" />
              ) : (
                <span>{displayName.slice(0, 2).toUpperCase()}</span>
              )}
            </div>
            <div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/jpeg,image/jpg,image/png,image/webp"
                onChange={handleAvatarUpload}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => avatarInputRef.current?.click()}
                className="bx-btn bx-btn-ghost px-3.5 py-2 text-xs font-bold inline-flex items-center gap-1.5"
              >
                <Camera className="w-4 h-4" />
                Upload Avatar Image
              </button>
              <p className="text-[11px] opacity-70 mt-1">JPEG, PNG, or WebP up to 5 MB.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="bx-edit-displayname" className="block text-xs font-extrabold mb-1">
                Display Name *
              </label>
              <input
                id="bx-edit-displayname"
                type="text"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="bx-input w-full px-3.5 py-2.5 text-sm"
              />
            </div>

            <div>
              <label htmlFor="bx-edit-username" className="block text-xs font-extrabold mb-1">
                Unique Username *
              </label>
              <input
                id="bx-edit-username"
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                className="bx-input w-full px-3.5 py-2.5 text-sm"
              />
              <p className="text-[11px] opacity-70 mt-1">
                Lowercase letters, numbers, underscores (3–24 chars). Keeps all deals & history intact.
              </p>
            </div>
          </div>

          <div>
            <label htmlFor="bx-edit-location" className="block text-xs font-extrabold mb-1">
              Location (Public Optional)
            </label>
            <input
              id="bx-edit-location"
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Dhaka, Bangladesh"
              className="bx-input w-full px-3.5 py-2.5 text-sm"
            />
          </div>

          <div>
            <label htmlFor="bx-edit-bio" className="block text-xs font-extrabold mb-1">
              Public Bio ({bio.length}/500)
            </label>
            <textarea
              id="bx-edit-bio"
              rows={3}
              maxLength={500}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="Describe the digital assets you specialize in…"
              className="bx-input w-full px-3.5 py-2.5 text-sm"
            />
          </div>

          <button
            type="submit"
            disabled={savingProfile}
            className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold"
          >
            {savingProfile ? 'Saving Changes…' : 'Save Profile Changes'}
          </button>
        </form>
      )}

      {/* TAB: CHANGE PASSWORD */}
      {activeTab === 'password' && (
        <div className="bx-card p-6 sm:p-8 max-w-xl space-y-5">
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-[#FF6500]" />
            <h2 className="text-lg font-black">Change Account Password</h2>
          </div>

          {!hasPasswordProvider ? (
            <p className="text-sm opacity-80">
              Your account is authenticated via Google Sign-In and does not use a separate BEXORA password.
            </p>
          ) : (
            <form onSubmit={handleChangePassword} className="space-y-4">
              {pwdErr && (
                <div className="p-3 border-2 border-red-600 bg-red-500/10 text-red-600 text-xs font-bold">
                  {pwdErr}
                </div>
              )}

              <div>
                <label htmlFor="bx-cur-pwd" className="block text-xs font-extrabold mb-1">
                  Current Password *
                </label>
                <div className="relative">
                  <input
                    id="bx-cur-pwd"
                    type={showCurPwd ? 'text' : 'password'}
                    required
                    value={currentPwd}
                    onChange={(e) => setCurrentPwd(e.target.value)}
                    className="bx-input w-full px-3.5 py-2.5 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    aria-label={showCurPwd ? 'Hide current password' : 'Show current password'}
                    onClick={() => setShowCurPwd((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 opacity-75 hover:opacity-100"
                  >
                    {showCurPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="bx-new-pwd" className="block text-xs font-extrabold mb-1">
                  New Password *
                </label>
                <div className="relative">
                  <input
                    id="bx-new-pwd"
                    type={showNewPwd ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={newPwd}
                    onChange={(e) => setNewPwd(e.target.value)}
                    className="bx-input w-full px-3.5 py-2.5 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    aria-label={showNewPwd ? 'Hide new password' : 'Show new password'}
                    onClick={() => setShowNewPwd((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 opacity-75 hover:opacity-100"
                  >
                    {showNewPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label htmlFor="bx-conf-new-pwd" className="block text-xs font-extrabold mb-1">
                  Confirm New Password *
                </label>
                <div className="relative">
                  <input
                    id="bx-conf-new-pwd"
                    type={showConfPwd ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={confirmNewPwd}
                    onChange={(e) => setConfirmNewPwd(e.target.value)}
                    className="bx-input w-full px-3.5 py-2.5 pr-10 text-sm"
                  />
                  <button
                    type="button"
                    aria-label={showConfPwd ? 'Hide confirm new password' : 'Show confirm new password'}
                    onClick={() => setShowConfPwd((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 opacity-75 hover:opacity-100"
                  >
                    {showConfPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={pwdBusy}
                className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold"
              >
                {pwdBusy ? 'Updating Password…' : 'Update Password'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* TAB: NID VERIFICATION (SEPARATE FRONT & BACK UPLOADS) */}
      {activeTab === 'nid' && (
        <div className="bx-card p-6 sm:p-8 max-w-3xl space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black">National ID (NID) Identity Verification</h2>
              <p className="text-xs opacity-75 mt-0.5">
                Documents are encrypted in transit and stored privately for BEXORA Admin review only — never shown publicly.
              </p>
            </div>
            <span className="px-3 py-1 text-xs font-extrabold border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)]">
              Status: {nidBadgeLabel}
            </span>
          </div>

          {privateUser.nidStatus === 'rejected' && (privateUser.nidRejectionReason || existingNidRecord?.rejectionReason) && (
            <div className="p-4 border-2 border-red-600 bg-red-500/10 text-red-600 text-xs font-bold flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <div>Previous Submission Rejected:</div>
                <div className="mt-1">{privateUser.nidRejectionReason || existingNidRecord?.rejectionReason}</div>
              </div>
            </div>
          )}

          {privateUser.nidStatus === 'verified' ? (
            <div className="p-5 border-2 border-emerald-600 bg-emerald-500/10 flex items-center gap-3">
              <FileCheck2 className="w-6 h-6 text-emerald-600 shrink-0" />
              <div className="text-sm font-bold">
                Your identity has been verified by a BEXORA Administrator. Your public profile displays the NID Verified badge.
              </div>
            </div>
          ) : privateUser.nidStatus === 'pending_review' ? (
            <div className="space-y-4">
              <div className="p-4 border-2 border-amber-500 bg-amber-500/10 text-sm font-bold">
                Your NID Front and Back images are currently queued for manual Administrator review. Verified status is granted only after approval.
              </div>
              {nidFrontData && nidBackData && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-3 border-2 border-[var(--bx-border)] space-y-2">
                    <div className="text-xs font-extrabold uppercase">Submitted Front Document</div>
                    <img src={nidFrontData} alt="Submitted NID Front" className="w-full h-40 object-cover rounded border border-[var(--bx-border)]" />
                  </div>
                  <div className="p-3 border-2 border-[var(--bx-border)] space-y-2">
                    <div className="text-xs font-extrabold uppercase">Submitted Back Document</div>
                    <img src={nidBackData} alt="Submitted NID Back" className="w-full h-40 object-cover rounded border border-[var(--bx-border)]" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmitNidVerification} className="space-y-5">
              {nidErr && (
                <div className="p-3 border-2 border-red-600 bg-red-500/10 text-red-600 text-xs font-bold">
                  {nidErr}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                {/* INDEPENDENT FRONT UPLOADER */}
                <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase">1. NID Front Document *</span>
                    {nidFrontData && <span className="text-[11px] font-bold text-emerald-600">Ready</span>}
                  </div>

                  <input
                    ref={nidFrontInputRef}
                    id="bx-nid-front-file"
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/webp"
                    onChange={handleSelectNidFront}
                    className="hidden"
                  />

                  {nidFrontData ? (
                    <div className="space-y-2">
                      <img
                        src={nidFrontData}
                        alt="NID Front Preview"
                        className="w-full h-40 object-cover border border-[var(--bx-border)] bg-black/5"
                      />
                      {nidFrontName && <p className="text-[11px] truncate opacity-75">{nidFrontName}</p>}
                      <button
                        type="button"
                        onClick={() => nidFrontInputRef.current?.click()}
                        className="bx-btn bx-btn-ghost w-full py-2 text-xs font-bold"
                      >
                        Replace Front Image
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => nidFrontInputRef.current?.click()}
                      className="w-full h-40 border-2 border-dashed border-[var(--bx-border)] flex flex-col items-center justify-center gap-2 hover:bg-[var(--bx-surface)] transition-colors"
                    >
                      <Upload className="w-6 h-6 text-[#FF6500]" />
                      <span className="text-xs font-extrabold">Upload Front Image</span>
                      <span className="text-[11px] opacity-70">JPEG, JPG, PNG, WebP (Max 8 MB)</span>
                    </button>
                  )}
                </div>

                {/* INDEPENDENT BACK UPLOADER */}
                <div className="p-4 border-2 border-[var(--bx-border)] bg-[var(--bx-surface-alt)] space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase">2. NID Back Document *</span>
                    {nidBackData && <span className="text-[11px] font-bold text-emerald-600">Ready</span>}
                  </div>

                  <input
                    ref={nidBackInputRef}
                    id="bx-nid-back-file"
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/webp"
                    onChange={handleSelectNidBack}
                    className="hidden"
                  />

                  {nidBackData ? (
                    <div className="space-y-2">
                      <img
                        src={nidBackData}
                        alt="NID Back Preview"
                        className="w-full h-40 object-cover border border-[var(--bx-border)] bg-black/5"
                      />
                      {nidBackName && <p className="text-[11px] truncate opacity-75">{nidBackName}</p>}
                      <button
                        type="button"
                        onClick={() => nidBackInputRef.current?.click()}
                        className="bx-btn bx-btn-ghost w-full py-2 text-xs font-bold"
                      >
                        Replace Back Image
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => nidBackInputRef.current?.click()}
                      className="w-full h-40 border-2 border-dashed border-[var(--bx-border)] flex flex-col items-center justify-center gap-2 hover:bg-[var(--bx-surface)] transition-colors"
                    >
                      <Upload className="w-6 h-6 text-[#FF6500]" />
                      <span className="text-xs font-extrabold">Upload Back Image</span>
                      <span className="text-[11px] opacity-70">JPEG, PNG, WebP (Max 5 MB)</span>
                    </button>
                  )}
                </div>
              </div>

              <button
                type="submit"
                disabled={nidBusy || !nidFrontData || !nidBackData}
                className="bx-btn bx-btn-primary px-6 py-2.5 text-sm font-extrabold"
              >
                {nidBusy ? 'Uploading Documents…' : 'Submit Front & Back for Verification'}
              </button>
            </form>
          )}
        </div>
      )}
    </div>
  );
};
