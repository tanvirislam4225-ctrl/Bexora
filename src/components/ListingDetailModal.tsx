import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteField,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CreditCard,
  ExternalLink,
  Heart,
  Lock,
  MessageSquare,
  RotateCcw,
  Share2,
  ShieldCheck,
  UserCheck,
  UserPlus,
} from 'lucide-react';
import {
  BidRecord,
  CurrencyCode,
  MarketplaceListing,
  PrivateUser,
  PublicProfile,
  PublicSettings,
} from '../types';
import {
  auth,
  db,
  extractUserFacingFirestoreError,
  handleFirestoreError,
  OperationType,
} from '../lib/firebase';
import {
  calculateAcceptedBidDealFinancials,
  formatAccountAge,
  formatMoneyFromMinor,
  getActiveBids,
  getBidStatusLabel,
  getCategoryMetricLabel,
  getHighestActiveBidMinor,
  getMonetizationLabel,
  getProtectionDurationHours,
  isBidAcceptedAwaitingPaymentStatus,
  PLATFORM_CATALOG,
  validateBidSubmission,
} from '../lib/marketplaceLogic';
import {
  appendDealAuditEvent,
  emitUserNotification,
} from '../lib/notificationService';
import { executeShareListing } from '../lib/engagementLogic';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface ListingDetailModalProps {
  listing: MarketplaceListing;
  onClose: () => void;
  userUid: string | null;
  profile: PublicProfile | null;
  privateUser: PrivateUser | null;
  settings: PublicSettings;
  displayCurrency: CurrencyCode;
  initialDraftBidAmount?: string;
  onStartBuyNowCheckout: (listing: MarketplaceListing) => void;
  onStartDealCheckout: (dealId: string, listingTitle: string) => void;
  onRequireAuthForBuyNow: (listing: MarketplaceListing) => void;
  onRequireAuthForBid: (listing: MarketplaceListing, draftBidAmount: string) => void;
  onRequireAuthForChat: (
    targetUid: string,
    targetName: string,
    listing: MarketplaceListing
  ) => void;
  onStartChatWithUser: (targetUid: string, targetName: string, listing: MarketplaceListing) => void;
  onOpenPublicProfile: (uid: string) => void;
  onDealOpened: (dealId: string, msg: string) => void;
  onFlash: (msg: string) => void;
  isFavorited?: boolean;
  onToggleFavorite?: (listing: MarketplaceListing) => void;
  isFollowingSeller?: boolean;
  sellerFollowerCount?: number;
  onToggleFollowSeller?: (seller: {
    uid: string;
    displayName: string;
    username: string;
    nidVerified: boolean;
  }) => void;
}

export const ListingDetailModal: React.FC<ListingDetailModalProps> = ({
  listing,
  onClose,
  userUid,
  profile,
  privateUser,
  settings,
  displayCurrency,
  initialDraftBidAmount = '',
  onStartBuyNowCheckout,
  onStartDealCheckout,
  onRequireAuthForBuyNow,
  onRequireAuthForBid,
  onRequireAuthForChat,
  onStartChatWithUser,
  onOpenPublicProfile,
  onDealOpened,
  onFlash,
  isFavorited = false,
  onToggleFavorite,
  isFollowingSeller = false,
  sellerFollowerCount,
  onToggleFollowSeller,
}) => {
  void privateUser;
  const [selectedImg, setSelectedImg] = useState(0);
  const [bids, setBids] = useState<BidRecord[]>([]);
  const [bidAmount, setBidAmount] = useState(initialDraftBidAmount);
  const [bidError, setBidError] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [withdrawingBidId, setWithdrawingBidId] = useState<string | null>(null);
  const [shareFeedback, setShareFeedback] = useState<'idle' | 'copied' | 'shared'>('idle');
  const submittingBidRef = useRef(false);
  const withdrawingBidRef = useRef<string | null>(null);
  const viewCountedRef = useRef<string | null>(null);
  const shareFeedbackTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setShareFeedback('idle');
    return () => {
      if (shareFeedbackTimerRef.current) {
        window.clearTimeout(shareFeedbackTimerRef.current);
      }
    };
  }, [listing.id]);

  useEffect(() => {
    if (initialDraftBidAmount) {
      setBidAmount((prev) => (prev ? prev : initialDraftBidAmount));
    }
  }, [initialDraftBidAmount]);

  const isSellerOwner = Boolean(userUid && userUid === listing.sellerId);
  const platformDef = PLATFORM_CATALOG[listing.platform];
  const metricLabel = getCategoryMetricLabel(listing.platform, listing.subcategory);

  const activeBids = useMemo(() => getActiveBids(bids), [bids]);
  const highestActiveBidMinor = useMemo(() => getHighestActiveBidMinor(bids), [bids]);

  // Subscribe to real bids for this listing
  useEffect(() => {
    const q = query(collection(db, 'bids'), where('listingId', '==', listing.id));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: BidRecord[] = snap.docs.map((d) => {
          const data = d.data();
          return {
            id: d.id,
            listingId: data.listingId,
            sellerId: data.sellerId,
            buyerId: data.buyerId,
            buyerName: data.buyerName,
            buyerUsername: data.buyerUsername,
            buyerVerified: Boolean(data.buyerVerified),
            amountMinor: Number(data.amountMinor) || 0,
            currency: data.currency || 'BDT',
            status: data.status || 'pending',
            dealId: data.dealId ? String(data.dealId) : undefined,
            createdAtMs: data.createdAt?.toMillis?.() || Date.now(),
          };
        });
        list.sort((a, b) => b.amountMinor - a.amountMinor);
        setBids(list);
      },
      (err) => {
        console.warn('Bids listener notice:', err.message);
      }
    );
    return () => unsub();
  }, [listing.id]);

  // Increment view count once atomically ONLY for authenticated non-owner viewers
  useEffect(() => {
    if (
      auth.currentUser &&
      userUid &&
      userUid !== listing.sellerId &&
      listing.status === 'active' &&
      viewCountedRef.current !== listing.id
    ) {
      viewCountedRef.current = listing.id;
      const listingRef = doc(db, 'listings', listing.id);
      runTransaction(db, async (tx) => {
        const snap = await tx.get(listingRef);
        if (!snap.exists() || snap.data()?.status !== 'active') return;
        const currentViews = Number(snap.data()?.views) || 0;
        tx.update(listingRef, { views: currentViews + 1 });
      }).catch(() => {});
    }
  }, [listing.id, listing.sellerId, listing.status, userUid]);

  const acceptedBidRecord = useMemo(
    () =>
      bids.find(
        (b) =>
          isBidAcceptedAwaitingPaymentStatus(b.status) ||
          b.status === 'paid' ||
          (listing.activeDealId && b.dealId === listing.activeDealId)
      ) || null,
    [bids, listing.activeDealId]
  );

  const resolvedAcceptedBidMinor =
    listing.acceptedBidAmountMinor || acceptedBidRecord?.amountMinor || 0;
  const resolvedActiveDealId = listing.activeDealId || acceptedBidRecord?.dealId || undefined;

  const effectiveBasePriceMinor =
    listing.status === 'reserved' && resolvedAcceptedBidMinor > 0
      ? resolvedAcceptedBidMinor
      : listing.priceMinor;

  const breakdown = calculateAcceptedBidDealFinancials(
    effectiveBasePriceMinor,
    settings,
    listing.priceMinor
  );

  const isReservedBuyer = Boolean(
    userUid &&
      ((listing.reservedBuyerId && listing.reservedBuyerId === userUid) ||
        (acceptedBidRecord && acceptedBidRecord.buyerId === userUid))
  );

  const visibleBids = useMemo(() => {
    if (isSellerOwner) return bids;
    return bids.filter(
      (b) =>
        b.status === 'pending' ||
        isBidAcceptedAwaitingPaymentStatus(b.status) ||
        b.status === 'paid' ||
        (userUid && b.buyerId === userUid)
    );
  }, [bids, isSellerOwner, userUid]);

  const handleBuyNow = () => {
    if (!userUid) {
      onRequireAuthForBuyNow(listing);
      return;
    }
    if (isSellerOwner) {
      onFlash('You cannot buy your own listing.');
      return;
    }
    if (listing.status !== 'active') {
      onFlash('This listing is currently reserved or sold and unavailable for Buy Now.');
      return;
    }
    onStartBuyNowCheckout(listing);
  };

  const handleShareListing = async () => {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    const pathname = typeof window !== 'undefined' ? window.location.pathname : '/';
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;

    const fallbackCopyText = (text: string): boolean => {
      if (typeof document === 'undefined') return false;
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.className = 'fixed opacity-0 pointer-events-none -left-[9999px] top-0';
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        document.body.removeChild(textarea);
      }
      return copied;
    };

    const result = await executeShareListing(
      {
        listingId: listing.id,
        title: listing.title,
        origin,
        pathname,
      },
      {
        canShare:
          nav && typeof nav.canShare === 'function'
            ? (data) => nav.canShare(data)
            : undefined,
        share:
          nav && typeof nav.share === 'function'
            ? (data) => nav.share(data)
            : undefined,
        writeClipboardText:
          nav?.clipboard && typeof nav.clipboard.writeText === 'function'
            ? (text) => nav.clipboard.writeText(text)
            : undefined,
        fallbackCopyText,
      }
    );

    if (result.method === 'cancelled') {
      return;
    }
    if (result.method === 'failed') {
      onFlash('Unable to share or copy listing link on this device.');
      return;
    }

    if (shareFeedbackTimerRef.current) {
      window.clearTimeout(shareFeedbackTimerRef.current);
    }
    setShareFeedback(result.method === 'web_share' ? 'shared' : 'copied');
    shareFeedbackTimerRef.current = window.setTimeout(() => {
      setShareFeedback('idle');
    }, 2500);

    if (result.method === 'web_share') {
      onFlash(`Shared "${listing.title}" (ID: ${listing.id}).`);
    } else {
      onFlash(`Listing link copied: "${listing.title}" (ID: ${listing.id}).`);
    }
  };

  const handleSubmitBid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingBidRef.current) return;
    setBidError('');
    if (!userUid || !profile) {
      onRequireAuthForBid(listing, bidAmount);
      return;
    }
    if (isSellerOwner) {
      setBidError('Sellers cannot bid on their own listing.');
      return;
    }
    const val = Number(bidAmount);
    if (!Number.isFinite(val) || val <= 0) {
      setBidError('Enter a valid positive bid amount.');
      return;
    }
    const amountMinor = Math.round(val * 100);
    const check = validateBidSubmission(amountMinor, bids, userUid);
    if (!check.valid) {
      setBidError(check.error || 'Invalid bid.');
      return;
    }

    submittingBidRef.current = true;
    setBusyAction(true);
    try {
      let createdBidId = '';
      try {
        const bidDoc = await addDoc(collection(db, 'bids'), {
          listingId: listing.id,
          sellerId: listing.sellerId,
          buyerId: userUid,
          buyerName: profile.displayName,
          buyerUsername: profile.username,
          buyerVerified: Boolean(profile.nidVerified),
          amountMinor,
          currency: listing.currency,
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        createdBidId = bidDoc.id;
      } catch (innerErr) {
        handleFirestoreError(innerErr, OperationType.CREATE, 'bids');
      }

      if (createdBidId) {
        const formattedBid = formatMoneyFromMinor(amountMinor, listing.currency, listing.currency);
        await Promise.all([
          emitUserNotification({
            recipientId: listing.sellerId,
            eventKey: `new_bid_seller_${createdBidId}`,
            category: 'bid',
            severity: 'info',
            title: `New Bid: ${formattedBid}`,
            preview: `${profile.displayName} placed a ${formattedBid} bid on "${listing.title}".`,
            body: `${profile.displayName} (@${profile.username}) placed a new bid of ${formattedBid} on your listing "${listing.title}". Open the listing to accept or reject this offer.`,
            refType: 'listing',
            refId: listing.id,
            referenceLabel: listing.title.slice(0, 80),
            destination: `listing:${listing.id}`,
          }),
          emitUserNotification({
            recipientId: userUid,
            eventKey: `new_bid_buyer_${createdBidId}`,
            category: 'bid',
            severity: 'success',
            title: `Bid Placed: ${formattedBid}`,
            preview: `Your offer of ${formattedBid} on "${listing.title}" is active.`,
            body: `Your bid of ${formattedBid} on "${listing.title}" has been recorded. You will be notified if the seller accepts or rejects your offer, or you can withdraw it anytime while pending.`,
            refType: 'listing',
            refId: listing.id,
            referenceLabel: listing.title.slice(0, 80),
            destination: `listing:${listing.id}`,
          }),
        ]);
      }

      setBidAmount('');
      onFlash('Bid placed successfully.');
    } catch (err) {
      setBidError(extractUserFacingFirestoreError(err, 'Failed to place bid.'));
    } finally {
      submittingBidRef.current = false;
      setBusyAction(false);
    }
  };

  const handleWithdrawBid = async (bid: BidRecord) => {
    if (!userUid || bid.buyerId !== userUid || bid.status !== 'pending') return;
    if (withdrawingBidRef.current) return;

    withdrawingBidRef.current = bid.id;
    setWithdrawingBidId(bid.id);
    setBusyAction(true);
    setBidError('');

    // Optimistic state update so the withdrawn bid disappears immediately from active bids & highest bid
    setBids((prev) =>
      prev.map((item) => (item.id === bid.id ? { ...item, status: 'withdrawn' } : item))
    );

    try {
      const bidRef = doc(db, 'bids', bid.id);
      await runTransaction(db, async (tx) => {
        const bSnap = await tx.get(bidRef);
        if (!bSnap.exists()) {
          throw new Error('Bid record not found.');
        }
        const bData = bSnap.data();
        if (bData.buyerId !== userUid) {
          throw new Error('You can only withdraw your own bid.');
        }
        if (bData.status !== 'pending') {
          throw new Error('Only pending bids can be withdrawn.');
        }
        tx.update(bidRef, {
          status: 'withdrawn',
          updatedAt: serverTimestamp(),
        });
      });
      const withdrawnAmount = formatMoneyFromMinor(bid.amountMinor, bid.currency, bid.currency);
      await Promise.all([
        emitUserNotification({
          recipientId: userUid,
          eventKey: `bid_withdrawn_buyer_${bid.id}`,
          category: 'bid',
          severity: 'info',
          title: 'Bid Withdrawn',
          preview: `Your ${withdrawnAmount} bid on "${listing.title}" was withdrawn.`,
          body: `You withdrew your pending bid of ${withdrawnAmount} on "${listing.title}". It is no longer counted among active bids.`,
          refType: 'listing',
          refId: listing.id,
          referenceLabel: listing.title.slice(0, 80),
          destination: `listing:${listing.id}`,
        }),
        emitUserNotification({
          recipientId: listing.sellerId,
          eventKey: `bid_withdrawn_seller_${bid.id}`,
          category: 'bid',
          severity: 'info',
          title: 'Buyer Withdrew a Pending Bid',
          preview: `${bid.buyerName} withdrew their ${withdrawnAmount} bid on "${listing.title}".`,
          body: `${bid.buyerName} (@${bid.buyerUsername}) withdrew their pending ${withdrawnAmount} offer on "${listing.title}". Active bid rankings have updated automatically.`,
          refType: 'listing',
          refId: listing.id,
          referenceLabel: listing.title.slice(0, 80),
          destination: `listing:${listing.id}`,
        }),
      ]);
      onFlash('Your bid has been withdrawn.');
    } catch (err) {
      // Revert optimistic status if transaction failed
      setBids((prev) =>
        prev.map((item) => (item.id === bid.id ? { ...item, status: bid.status } : item))
      );
      onFlash(extractUserFacingFirestoreError(err, 'Could not withdraw bid.'));
    } finally {
      withdrawingBidRef.current = null;
      setWithdrawingBidId(null);
      setBusyAction(false);
    }
  };

  const handleSellerRejectBid = async (bid: BidRecord) => {
    if (!isSellerOwner || bid.status !== 'pending') return;
    setBusyAction(true);
    try {
      await updateDoc(doc(db, 'bids', bid.id), {
        status: 'rejected',
        updatedAt: serverTimestamp(),
      });
      const rejectedAmount = formatMoneyFromMinor(bid.amountMinor, bid.currency, bid.currency);
      await emitUserNotification({
        recipientId: bid.buyerId,
        eventKey: `bid_rejected_buyer_${bid.id}`,
        category: 'bid',
        severity: 'warning',
        title: 'Bid Declined by Seller',
        preview: `Your ${rejectedAmount} bid on "${listing.title}" was declined.`,
        body: `The seller declined your ${rejectedAmount} bid on "${listing.title}". If the listing is still active, you may submit a higher offer or explore similar assets in the marketplace.`,
        refType: 'listing',
        refId: listing.id,
        referenceLabel: listing.title.slice(0, 80),
        destination: `listing:${listing.id}`,
      });
      onFlash('Bid rejected and recorded in history.');
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Could not reject bid.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleSellerAcceptBid = async (bid: BidRecord) => {
    if (!isSellerOwner || bid.status !== 'pending' || !userUid) return;
    setBusyAction(true);
    try {
      const dealId = `deal_${listing.id}_${bid.id.slice(0, 8)}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
      const bidFinancials = calculateAcceptedBidDealFinancials(
        bid.amountMinor,
        settings,
        listing.priceMinor
      );
      const protectionHours = getProtectionDurationHours(listing.platform, settings);

      await runTransaction(db, async (tx) => {
        const listingRef = doc(db, 'listings', listing.id);
        const bidRef = doc(db, 'bids', bid.id);
        const dealRef = doc(db, 'deals', dealId);

        const [lSnap, bSnap, dSnap] = await Promise.all([
          tx.get(listingRef),
          tx.get(bidRef),
          tx.get(dealRef),
        ]);
        if (!lSnap.exists() || lSnap.data()?.status !== 'active') {
          throw new Error('This listing already has an active reservation or completed sale.');
        }
        if (!bSnap.exists() || bSnap.data()?.status !== 'pending') {
          throw new Error('This bid is no longer open for acceptance.');
        }
        if (dSnap.exists() && dSnap.data()?.status !== 'cancelled') {
          throw new Error('A persistent deal already exists for this accepted bid.');
        }

        tx.update(bidRef, {
          status: 'accepted_pending_payment',
          dealId,
          updatedAt: serverTimestamp(),
        });

        tx.set(dealRef, {
          listingId: listing.id,
          listingTitle: listing.title,
          platform: listing.platform,
          acceptedBidId: bid.id,
          originalListingPriceMinor: listing.priceMinor,
          buyerId: bid.buyerId,
          buyerName: bid.buyerName,
          sellerId: listing.sellerId,
          sellerName: listing.sellerName,
          baseAmountMinor: bidFinancials.baseAmountMinor,
          buyerFeePct: bidFinancials.buyerFeePct,
          sellerFeePct: bidFinancials.sellerFeePct,
          buyerFeeMinor: bidFinancials.buyerFeeMinor,
          sellerFeeMinor: bidFinancials.sellerFeeMinor,
          buyerTotalMinor: bidFinancials.buyerTotalMinor,
          sellerPayoutMinor: bidFinancials.sellerPayoutMinor,
          platformCommissionMinor: bidFinancials.platformCommissionMinor,
          refundBuyerMinor: bidFinancials.refundBuyerMinor,
          refundPlatformRetainedMinor: bidFinancials.refundPlatformRetainedMinor,
          currency: listing.currency,
          protectionDurationHours: protectionHours,
          confirmedAtMs: 0,
          originalDeadlineMs: 0,
          unresolvedReportCount: 0,
          transferSubmissionCount: 0,
          status: 'accepted_pending_payment',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        tx.update(listingRef, {
          status: 'reserved',
          activeDealId: dealId,
          acceptedBidAmountMinor: bid.amountMinor,
          reservedBuyerId: bid.buyerId,
          updatedAt: serverTimestamp(),
        });
      });

      const acceptedFmt = formatMoneyFromMinor(bid.amountMinor, bid.currency, bid.currency);
      const totalPayableFmt = formatMoneyFromMinor(
        bidFinancials.buyerTotalMinor,
        bid.currency,
        bid.currency
      );
      await Promise.all([
        appendDealAuditEvent({
          dealId,
          actorId: userUid,
          actorName: listing.sellerName,
          actorRole: 'seller',
          eventType: 'bid_accepted_pending_payment',
          summary: `Seller accepted ${bid.buyerName}'s bid of ${acceptedFmt} (+ ${bidFinancials.buyerFeePct}% fee = ${totalPayableFmt} payable). Listing reserved pending buyer payment.`,
        }),
        emitUserNotification({
          recipientId: bid.buyerId,
          eventKey: `bid_accepted_buyer_${dealId}`,
          category: 'deal',
          severity: 'success',
          title: `Bid Accepted (${acceptedFmt}) — Pay ${totalPayableFmt} in Deal Room`,
          preview: `Seller accepted your ${acceptedFmt} bid on "${listing.title}". Listing is reserved for you.`,
          body: `${listing.sellerName} accepted your exact ${acceptedFmt} bid on "${listing.title}"! With the ${bidFinancials.buyerFeePct}% buyer fee, your total escrow payment is ${totalPayableFmt}. Open Deal #${dealId.slice(0, 10)} to complete wallet payment and activate the 3-party Deal Room.`,
          refType: 'deal',
          refId: dealId,
          referenceLabel: `Deal #${dealId.slice(0, 10)}`,
          destination: `deal:${dealId}`,
        }),
        emitUserNotification({
          recipientId: userUid,
          eventKey: `bid_accepted_seller_${dealId}`,
          category: 'deal',
          severity: 'success',
          title: 'Bid Accepted — Listing Reserved Pending Payment',
          preview: `Accepted ${bid.buyerName}'s ${acceptedFmt} bid on "${listing.title}".`,
          body: `You accepted ${bid.buyerName}'s bid of ${acceptedFmt} on "${listing.title}". Both your listing and the accepted bid remain preserved with status "Reserved — Pending Buyer Payment". Do NOT transfer any credentials until the buyer completes wallet escrow payment.`,
          refType: 'deal',
          refId: dealId,
          referenceLabel: `Deal #${dealId.slice(0, 10)}`,
          destination: `deal:${dealId}`,
        }),
      ]);

      onFlash(
        `Bid of ${formatMoneyFromMinor(
          bid.amountMinor,
          displayCurrency,
          listing.currency,
          settings.usdToBdtRate
        )} accepted! Listing is now Reserved Pending Buyer Payment.`
      );
    } catch (err) {
      onFlash(extractUserFacingFirestoreError(err, 'Failed to accept bid.'));
    } finally {
      setBusyAction(false);
    }
  };

  const handleCancelUnpaidReservation = async () => {
    if (!userUid || listing.status !== 'reserved') return;
    if (!isSellerOwner && !isReservedBuyer) return;

    setBusyAction(true);
    try {
      const activeDealId = resolvedActiveDealId;
      await runTransaction(db, async (tx) => {
        const listingRef = doc(db, 'listings', listing.id);
        const lSnap = await tx.get(listingRef);
        if (!lSnap.exists() || lSnap.data()?.status !== 'reserved') {
          throw new Error('Listing is no longer in reserved state.');
        }

        if (activeDealId) {
          const dealRef = doc(db, 'deals', activeDealId);
          const payLedgerRef = doc(db, 'walletLedger', `led_pay_${activeDealId}`);
          const [dSnap, payLedSnap] = await Promise.all([
            tx.get(dealRef),
            tx.get(payLedgerRef),
          ]);

          if (payLedSnap.exists()) {
            throw new Error('Buyer payment has already been completed; reservation cannot be cancelled.');
          }
          if (dSnap.exists()) {
            const dData = dSnap.data();
            if (!['accepted_pending_payment', 'awaiting_payment'].includes(String(dData.status || ''))) {
              throw new Error('Deal is already funded or closed and cannot be cancelled as unpaid.');
            }
            const acceptedBidId = dData.acceptedBidId ? String(dData.acceptedBidId) : acceptedBidRecord?.id || '';
            if (acceptedBidId) {
              const bidRef = doc(db, 'bids', acceptedBidId);
              const bSnap = await tx.get(bidRef);
              if (
                bSnap.exists() &&
                ['accepted_pending_payment', 'accepted'].includes(String(bSnap.data()?.status || ''))
              ) {
                tx.update(bidRef, {
                  status: 'expired',
                  updatedAt: serverTimestamp(),
                });
              }
            }
            tx.update(dealRef, {
              status: 'cancelled',
              updatedAt: serverTimestamp(),
            });
          }
        } else if (acceptedBidRecord?.id) {
          const bidRef = doc(db, 'bids', acceptedBidRecord.id);
          const bSnap = await tx.get(bidRef);
          if (
            bSnap.exists() &&
            ['accepted_pending_payment', 'accepted'].includes(String(bSnap.data()?.status || ''))
          ) {
            tx.update(bidRef, {
              status: 'expired',
              updatedAt: serverTimestamp(),
            });
          }
        }

        tx.update(listingRef, {
          status: 'active',
          activeDealId: deleteField(),
          acceptedBidAmountMinor: deleteField(),
          reservedBuyerId: deleteField(),
          updatedAt: serverTimestamp(),
        });
      });

      if (activeDealId) {
        await appendDealAuditEvent({
          dealId: activeDealId,
          actorId: userUid,
          actorName: profile?.displayName || 'Participant',
          actorRole: isSellerOwner ? 'seller' : 'buyer',
          eventType: 'unpaid_reservation_cancelled',
          summary: `Unpaid accepted-bid reservation was cancelled prior to payment. Listing restored to active status.`,
        });
      }

      onFlash('Unpaid reservation cancelled. Listing is active again for new bids and purchases.');
    } catch (err) {
      onFlash(extractUserFacingFirestoreError(err, 'Could not cancel unpaid reservation.'));
    } finally {
      setBusyAction(false);
    }
  };

  return (
    <section className="bx-wrap py-6 sm:py-8 space-y-6" aria-label={listing.title}>
      {/* Top Breadcrumb & Back Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onClose}
          className="bx-btn bx-btn-sm inline-flex items-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Marketplace</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleShareListing()}
            aria-label={`Share listing ${listing.title} (ID: ${listing.id})`}
            className={`bx-btn bx-btn-sm whitespace-nowrap shrink-0 ${
              shareFeedback !== 'idle'
                ? '!border-[var(--green)] !text-[var(--green)] !bg-[var(--green-soft)]'
                : ''
            }`}
          >
            {shareFeedback !== 'idle' ? (
              <Check className="w-4 h-4" />
            ) : (
              <Share2 className="w-4 h-4" />
            )}
            <span>
              {shareFeedback === 'copied'
                ? 'Link Copied'
                : shareFeedback === 'shared'
                  ? 'Shared'
                  : 'Share Listing'}
            </span>
          </button>
          {onToggleFavorite && (
            <button
              type="button"
              onClick={() => onToggleFavorite(listing)}
              aria-pressed={isFavorited}
              aria-label={
                isFavorited
                  ? `Remove ${listing.title} from favorites`
                  : `Save ${listing.title} to favorites`
              }
              className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
              style={
                isFavorited
                  ? {
                      background: '#FFE4E6',
                      borderColor: '#E11D48',
                      color: '#BE123C',
                    }
                  : undefined
              }
            >
              <Heart className={`w-4 h-4 ${isFavorited ? 'fill-current' : ''}`} />
              <span>{isFavorited ? 'Saved in Favorites' : 'Save to Favorites'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Full-Screen 2-Column Listing Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN (7 cols): Title, Media Gallery, Metrics, URL, Monetization, Description, Seller */}
        <div className="lg:col-span-7 space-y-5">
          <div className="bx-card p-5 sm:p-6 space-y-5">
            {/* Title Header */}
            <div className="pb-4 border-b space-y-1.5" style={{ borderColor: 'var(--border-soft)' }}>
              {listing.status === 'reserved' && (
                <p className="text-xs font-extrabold mb-1" style={{ color: 'var(--orange)' }}>
                  Reserved — Pending Buyer Payment (
                  {formatMoneyFromMinor(
                    effectiveBasePriceMinor,
                    displayCurrency,
                    listing.currency,
                    settings.usdToBdtRate
                  )}{' '}
                  accepted bid)
                </p>
              )}
              <h1 className="text-xl sm:text-2xl lg:text-3xl font-black leading-snug">
                {listing.title}
              </h1>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold text-[var(--text-2)]">
                <span className="font-bold text-[var(--orange)]">
                  {listing.subcategory
                    .toLowerCase()
                    .startsWith(platformDef.name.toLowerCase())
                    ? listing.subcategory
                    : `${platformDef.name} · ${listing.subcategory}`}
                </span>
                <span aria-hidden="true">·</span>
                <span>{getProtectionDurationHours(listing.platform, settings)}h Escrow Protection</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono select-all">Listing ID: {listing.id}</span>
              </div>
            </div>

            {/* Media Gallery */}
            <div className="space-y-2.5">
              <div
                className="aspect-[16/9] rounded-xl overflow-hidden flex items-center justify-center border"
                style={{
                  background: PLATFORM_BANNER_BG[listing.platform],
                  borderColor: 'var(--border-soft)',
                }}
              >
                {listing.images && listing.images[selectedImg] ? (
                  <img
                    src={listing.images[selectedImg]}
                    alt={listing.title}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-white">
                    <PlatformIcon id={listing.platform} size={56} />
                    <span className="text-xs font-extrabold uppercase">{listing.subcategory}</span>
                  </div>
                )}
              </div>

              {listing.images && listing.images.length > 1 && (
                <div className="grid grid-cols-4 sm:flex sm:items-center gap-2 sm:overflow-x-auto pb-1">
                  {listing.images.map((src, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedImg(idx)}
                      className="w-full sm:w-20 aspect-[16/10] rounded-lg overflow-hidden border-2 shrink-0"
                      style={{
                        borderColor: idx === selectedImg ? 'var(--orange)' : 'var(--border-soft)',
                      }}
                    >
                      <img src={src} alt={`Thumbnail ${idx + 1}`} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Key Metrics Strip */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 tabular-nums">
              <div className="p-3 rounded-xl bx-soft">
                <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                  Account Age
                </span>
                <strong className="text-sm font-extrabold">
                  {formatAccountAge(listing.ageYears, listing.ageMonths)}
                </strong>
              </div>
              {listing.platform === 'gaming' ? (
                <>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                      Game
                    </span>
                    <strong className="text-sm font-extrabold truncate block">
                      {listing.gameName || 'Gaming'}
                    </strong>
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                      Game UID
                    </span>
                    <strong className="text-sm font-extrabold truncate block">
                      {listing.gameUid || '—'}
                    </strong>
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                      Level
                    </span>
                    <strong className="text-sm font-extrabold">{listing.gameLevel ?? listing.metricValue}</strong>
                  </div>
                </>
              ) : (
                <>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                      {metricLabel}
                    </span>
                    <strong className="text-sm font-extrabold">
                      {listing.metricValue.toLocaleString('en-US')}
                    </strong>
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                      Monthly Revenue
                    </span>
                    <strong className="text-sm font-extrabold">
                      {listing.monthlyRevenueMinor > 0
                        ? formatMoneyFromMinor(
                            listing.monthlyRevenueMinor,
                            displayCurrency,
                            listing.currency,
                            settings.usdToBdtRate
                          )
                        : '—'}
                    </strong>
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="text-[11px] font-bold uppercase block" style={{ color: 'var(--text-2)' }}>
                      Protection Policy
                    </span>
                    <strong className="text-sm font-extrabold">
                      {getProtectionDurationHours(listing.platform, settings)}h Escrow
                    </strong>
                  </div>
                </>
              )}
            </div>

            {/* Public Direct Account/Page URL — Visible to ALL Visitors including Logged-Out */}
            {listing.accountUrl && (
              <div className="p-3.5 rounded-xl bx-soft flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-xs font-extrabold block" style={{ color: 'var(--text-2)' }}>
                    Public Asset URL (Domain Matched · Seller Declared)
                  </span>
                  <a
                    href={listing.accountUrl}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="inline-flex items-center gap-1.5 text-sm font-bold underline break-all mt-0.5"
                    style={{ color: 'var(--orange)' }}
                  >
                    <span>{listing.accountUrl}</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                </div>
              </div>
            )}

            {/* Monetization Breakdown */}
            {listing.monetizationStatus !== 'not_applicable' && (
              <div className="space-y-2">
                <h2 className="text-sm font-extrabold">Monetization Status</h2>
                {listing.monetizationStatus === 'non-monetized' ? (
                  <div className="p-3 rounded-xl bx-soft text-xs font-semibold">
                    Non-Monetized — Seller declares no active monetization programs on this asset.
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {listing.claimedOptions.map((optId) => {
                      const isVerified = listing.verifiedOptions.includes(optId);
                      return (
                        <div
                          key={optId}
                          className="p-2.5 rounded-xl bx-soft flex items-center justify-between gap-2 text-xs font-bold"
                        >
                          <span>{getMonetizationLabel(optId)}</span>
                          <span
                            style={{
                              color: isVerified ? 'var(--green)' : 'var(--orange)',
                            }}
                          >
                            {isVerified ? 'Active — Verified' : 'Seller Claimed (Pending Verification)'}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Description */}
            <div>
              <h2 className="text-sm font-extrabold mb-1.5">Asset Description</h2>
              <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-2)' }}>
                {listing.description}
              </p>
            </div>

            {/* Seller Card + Follow Seller + Direct Message Action */}
            <div className="p-4 rounded-xl bx-soft flex items-center justify-between gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => onOpenPublicProfile(listing.sellerId)}
                className="flex items-center gap-3 text-left hover:underline"
              >
                <div
                  className="w-10 h-10 rounded-full grid place-items-center font-extrabold text-sm text-white shrink-0"
                  style={{ background: 'var(--purple)' }}
                >
                  {(listing.sellerName || 'S').slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-1.5 font-extrabold text-sm">
                    <span>{listing.sellerName}</span>
                    {listing.sellerVerified && (
                      <ShieldCheck className="w-4 h-4" style={{ color: 'var(--green)' }} />
                    )}
                  </div>
                  <span className="bx-hint">
                    @{listing.sellerUsername}
                    {typeof sellerFollowerCount === 'number'
                      ? ` · ${sellerFollowerCount.toLocaleString('en-US')} follower${sellerFollowerCount === 1 ? '' : 's'}`
                      : ''}{' '}
                    · View Public Profile
                  </span>
                </div>
              </button>

              {!isSellerOwner && (
                <div className="flex flex-wrap items-center gap-2">
                  {onToggleFollowSeller && (
                    <button
                      type="button"
                      onClick={() =>
                        onToggleFollowSeller({
                          uid: listing.sellerId,
                          displayName: listing.sellerName,
                          username: listing.sellerUsername,
                          nidVerified: listing.sellerVerified,
                        })
                      }
                      aria-pressed={isFollowingSeller}
                      aria-label={
                        isFollowingSeller
                          ? `Unfollow seller ${listing.sellerName}`
                          : `Follow seller ${listing.sellerName}`
                      }
                      className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                      style={
                        isFollowingSeller
                          ? {
                              background: 'var(--surface)',
                              borderColor: 'var(--green)',
                              color: 'var(--green)',
                            }
                          : undefined
                      }
                    >
                      {isFollowingSeller ? (
                        <UserCheck className="w-4 h-4" />
                      ) : (
                        <UserPlus className="w-4 h-4" />
                      )}
                      <span>{isFollowingSeller ? 'Following' : 'Follow Seller'}</span>
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => {
                      if (!userUid) {
                        onRequireAuthForChat(listing.sellerId, listing.sellerName, listing);
                        return;
                      }
                      onStartChatWithUser(listing.sellerId, listing.sellerName, listing);
                    }}
                    className="bx-btn bx-btn-sm whitespace-nowrap shrink-0"
                  >
                    <MessageSquare className="w-4 h-4" />
                    <span>Message Seller</span>
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (5 cols): Escrow Purchase / Checkout Card & Live Bidding Room */}
        <div className="lg:col-span-5 lg:sticky lg:top-20 space-y-5">
          {/* Transparent Commission & Escrow Purchase Module */}
          <div className="bx-card p-5 sm:p-6 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
              <h2 className="text-base font-extrabold">Escrow Purchase Summary</h2>
              <span className="bx-hint">3-Party Protected</span>
            </div>

            <div className="space-y-2 text-sm tabular-nums">
              {listing.status === 'reserved' && resolvedAcceptedBidMinor > 0 && (
                <div className="flex justify-between text-xs pb-1">
                  <span style={{ color: 'var(--text-2)' }}>Original Listing Price</span>
                  <span className="line-through opacity-75">
                    {formatMoneyFromMinor(
                      listing.priceMinor,
                      displayCurrency,
                      listing.currency,
                      settings.usdToBdtRate
                    )}
                  </span>
                </div>
              )}
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-2)' }}>
                  {listing.status === 'reserved' && resolvedAcceptedBidMinor > 0
                    ? 'Accepted Bid Price'
                    : 'Base Asset Price'}
                </span>
                <strong>
                  {formatMoneyFromMinor(
                    breakdown.baseAmountMinor,
                    displayCurrency,
                    listing.currency,
                    settings.usdToBdtRate
                  )}
                </strong>
              </div>
              <div className="flex justify-between">
                <span style={{ color: 'var(--text-2)' }}>
                  Buyer Platform Fee ({breakdown.buyerFeePct}%)
                </span>
                <strong>
                  {formatMoneyFromMinor(
                    breakdown.buyerFeeMinor,
                    displayCurrency,
                    listing.currency,
                    settings.usdToBdtRate
                  )}
                </strong>
              </div>
              <div className="h-px my-1" style={{ background: 'var(--border-soft)' }} />
              <div className="flex justify-between text-base font-extrabold">
                <span>Total Buyer Payment</span>
                <span>
                  {formatMoneyFromMinor(
                    breakdown.buyerTotalMinor,
                    displayCurrency,
                    listing.currency,
                    settings.usdToBdtRate
                  )}
                </span>
              </div>
              {isSellerOwner && (
                <p className="bx-hint pt-1">
                  Seller Payout Preview: Agreed price minus {breakdown.sellerFeePct}% seller fee ={' '}
                  <strong>
                    {formatMoneyFromMinor(
                      breakdown.sellerPayoutMinor,
                      displayCurrency,
                      listing.currency,
                      settings.usdToBdtRate
                    )}
                  </strong>{' '}
                  net payout after security countdown completion.
                </p>
              )}
            </div>

            {/* Reserved Pending Payment Status Banner & Direct Actions */}
            {listing.status === 'reserved' && (
              <div
                className="p-4 rounded-xl border space-y-3"
                style={{
                  background: 'var(--surface-2)',
                  borderColor: 'var(--orange)',
                }}
              >
                <div className="flex items-start gap-2.5">
                  <Lock className="w-4 h-4 shrink-0 mt-0.5" style={{ color: 'var(--orange)' }} />
                  <div className="space-y-1 text-xs">
                    <div className="font-extrabold text-sm" style={{ color: 'var(--orange)' }}>
                      Reserved — Pending Buyer Payment
                    </div>
                    <p style={{ color: 'var(--text-2)' }}>
                      {isReservedBuyer
                        ? `Your bid was accepted! Proceed to Checkout to pay the exact agreed total (${formatMoneyFromMinor(
                            breakdown.buyerTotalMinor,
                            displayCurrency,
                            listing.currency,
                            settings.usdToBdtRate
                          )}) and lock funds in Escrow.`
                        : isSellerOwner
                        ? 'You accepted a bid on this listing. Both the listing and the accepted bid remain preserved while awaiting buyer payment. Conflicting Buy Now purchases and duplicate bid acceptances are locked.'
                        : 'A buyer bid has been accepted on this listing and is currently awaiting escrow payment. Conflicting purchases are locked while this reservation is active.'}
                    </p>
                  </div>
                </div>

                {(isReservedBuyer || isSellerOwner) && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {resolvedActiveDealId && (
                      <button
                        type="button"
                        disabled={busyAction}
                        onClick={() => {
                          if (isReservedBuyer) {
                            onStartDealCheckout(resolvedActiveDealId, listing.title);
                          } else {
                            onDealOpened(resolvedActiveDealId, 'Opened reserved Deal Room.');
                          }
                        }}
                        className="bx-btn bx-btn-primary bx-btn-sm"
                      >
                        <span>
                          {isReservedBuyer
                            ? `Pay Accepted Bid (${formatMoneyFromMinor(
                                breakdown.buyerTotalMinor,
                                displayCurrency,
                                listing.currency,
                                settings.usdToBdtRate
                              )})`
                            : 'Open Reserved Deal Room'}
                        </span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busyAction}
                      onClick={handleCancelUnpaidReservation}
                      className="bx-btn bx-btn-sm bx-btn-danger"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Cancel Unpaid Reservation &amp; Restore Listing</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {!isSellerOwner && listing.status === 'active' && (
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={handleBuyNow}
                  className="bx-btn bx-btn-yellow w-full text-base justify-center"
                >
                  <CreditCard className="w-4 h-4" />
                  <span>
                    Buy Now —{' '}
                    {formatMoneyFromMinor(
                      breakdown.buyerTotalMinor,
                      displayCurrency,
                      listing.currency,
                      settings.usdToBdtRate
                    )}
                  </span>
                </button>
                <p className="bx-hint text-center">
                  Opens secure Escrow Checkout (BEXORA Wallet Balance &amp; Live Payment Methods)
                </p>
              </div>
            )}
          </div>

          {/* Role-Based Bidding Room & Preserved Bid History */}
          <div className="bx-card p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-extrabold">
                {isSellerOwner
                  ? `Seller Bid Management & History (${visibleBids.length})`
                  : `Live Bidding Room (${visibleBids.length})`}
              </h2>
              <span className="bx-hint">
                {listing.status === 'reserved' && resolvedAcceptedBidMinor > 0
                  ? `Accepted bid: ${formatMoneyFromMinor(
                      resolvedAcceptedBidMinor,
                      displayCurrency,
                      listing.currency,
                      settings.usdToBdtRate
                    )}`
                  : highestActiveBidMinor > 0
                  ? `Highest active bid: ${formatMoneyFromMinor(
                      highestActiveBidMinor,
                      displayCurrency,
                      listing.currency,
                      settings.usdToBdtRate
                    )}`
                  : 'No arbitrary minimum increment'}
              </span>
            </div>

            {!isSellerOwner && listing.status === 'active' && (
              <form onSubmit={handleSubmitBid} className="flex flex-col sm:flex-row gap-2">
                <label htmlFor="bx-listing-bid-input" className="sr-only">
                  Enter your bid in {listing.currency}
                </label>
                <input
                  id="bx-listing-bid-input"
                  type="number"
                  min="1"
                  step="any"
                  inputMode="decimal"
                  value={bidAmount}
                  onChange={(e) => {
                    setBidAmount(e.target.value);
                    setBidError('');
                  }}
                  placeholder={`Enter your bid in ${listing.currency}`}
                  className="bx-input flex-1"
                />
                <button type="submit" disabled={busyAction} className="bx-btn bx-btn-primary">
                  Place Bid
                </button>
              </form>
            )}

            {bidError && (
              <p className="text-xs font-bold" style={{ color: 'var(--red)' }}>
                {bidError}
              </p>
            )}

            {visibleBids.length === 0 ? (
              <p className="bx-hint">No bids recorded on this listing yet.</p>
            ) : (
              <div className="space-y-2">
                {visibleBids.map((b) => {
                  const isOwnBid = Boolean(userUid && b.buyerId === userUid);
                  const isWithdrawingThis = withdrawingBidId === b.id;
                  const isAcceptedAwaitingPay = isBidAcceptedAwaitingPaymentStatus(b.status);
                  const linkedDealId =
                    b.dealId || (isAcceptedAwaitingPay ? listing.activeDealId : undefined);
                  const bidTotalWithFee = calculateAcceptedBidDealFinancials(
                    b.amountMinor,
                    settings,
                    listing.priceMinor
                  );

                  return (
                    <div
                      key={b.id}
                      className="p-3 rounded-xl border flex flex-wrap items-center justify-between gap-3"
                      style={{
                        background: 'var(--surface-2)',
                        borderColor:
                          isAcceptedAwaitingPay || b.status === 'paid'
                            ? 'var(--orange)'
                            : 'var(--border-soft)',
                      }}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className="w-8 h-8 rounded-full grid place-items-center text-xs font-extrabold text-white shrink-0"
                          style={{ background: isOwnBid ? 'var(--orange)' : 'var(--purple)' }}
                        >
                          {(b.buyerName || 'B').slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => onOpenPublicProfile(b.buyerId)}
                            className="text-xs font-extrabold hover:underline flex items-center gap-1"
                          >
                            <span>{b.buyerName}</span>
                            <span style={{ color: 'var(--text-3)' }}>@{b.buyerUsername}</span>
                            {isOwnBid && <span style={{ color: 'var(--orange)' }}>(You)</span>}
                            {b.buyerVerified && (
                              <ShieldCheck className="w-3.5 h-3.5" style={{ color: 'var(--green)' }} />
                            )}
                          </button>
                          <div className="text-xs tabular-nums font-bold">
                            {formatMoneyFromMinor(
                              b.amountMinor,
                              displayCurrency,
                              b.currency,
                              settings.usdToBdtRate
                            )}{' '}
                            <span
                              style={{
                                color:
                                  isAcceptedAwaitingPay || b.status === 'paid'
                                    ? 'var(--orange)'
                                    : 'var(--text-3)',
                              }}
                            >
                              · {getBidStatusLabel(b.status)}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* Context-Sensitive Role Controls */}
                      <div className="flex flex-wrap items-center gap-2">
                        {isOwnBid && b.status === 'pending' && (
                          <button
                            type="button"
                            disabled={busyAction || isWithdrawingThis}
                            onClick={() => handleWithdrawBid(b)}
                            className="bx-btn bx-btn-sm bx-btn-danger"
                          >
                            {isWithdrawingThis ? 'Withdrawing…' : 'Withdraw'}
                          </button>
                        )}

                        {isOwnBid && (isAcceptedAwaitingPay || b.status === 'paid') && linkedDealId && (
                          <button
                            type="button"
                            onClick={() => {
                              if (isAcceptedAwaitingPay) {
                                onStartDealCheckout(linkedDealId, listing.title);
                              } else {
                                onDealOpened(linkedDealId, 'Opened funded 3-Party Deal Room.');
                              }
                            }}
                            className="bx-btn bx-btn-sm bx-btn-primary"
                          >
                            <span>
                              {isAcceptedAwaitingPay
                                ? `Pay Accepted Bid (${formatMoneyFromMinor(
                                    bidTotalWithFee.buyerTotalMinor,
                                    displayCurrency,
                                    b.currency,
                                    settings.usdToBdtRate
                                  )})`
                                : 'Open Deal Room'}
                            </span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {isSellerOwner && (
                          <>
                            <button
                              type="button"
                              onClick={() => onStartChatWithUser(b.buyerId, b.buyerName, listing)}
                              className="bx-btn bx-btn-sm"
                            >
                              <MessageSquare className="w-3.5 h-3.5" />
                              <span>Message</span>
                            </button>
                            {(isAcceptedAwaitingPay || b.status === 'paid') && linkedDealId && (
                              <button
                                type="button"
                                onClick={() =>
                                  onDealOpened(linkedDealId, 'Opened Deal Room for accepted bid.')
                                }
                                className="bx-btn bx-btn-sm bx-btn-primary"
                              >
                                <span>Open Deal Room</span>
                                <ArrowRight className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {b.status === 'pending' && listing.status === 'active' && (
                              <>
                                <button
                                  type="button"
                                  disabled={busyAction}
                                  onClick={() => handleSellerAcceptBid(b)}
                                  className="bx-btn bx-btn-sm bx-btn-primary"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  <span>Accept Bid</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={busyAction}
                                  onClick={() => handleSellerRejectBid(b)}
                                  className="bx-btn bx-btn-sm bx-btn-danger"
                                >
                                  Reject
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
