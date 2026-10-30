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
  ArrowRight,
  Check,
  ExternalLink,
  Lock,
  MessageSquare,
  RotateCcw,
  ShieldCheck,
  X,
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
  calculateCommission,
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
  emitPaidDealRoomCreatedAlerts,
  emitUserNotification,
} from '../lib/notificationService';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface ListingDetailModalProps {
  listing: MarketplaceListing;
  onClose: () => void;
  userUid: string | null;
  profile: PublicProfile | null;
  privateUser: PrivateUser | null;
  settings: PublicSettings;
  displayCurrency: CurrencyCode;
  onRequireAuth: () => void;
  onOpenWallet: () => void;
  onStartChatWithUser: (targetUid: string, targetName: string, listing: MarketplaceListing) => void;
  onOpenPublicProfile: (uid: string) => void;
  onDealOpened: (dealId: string, msg: string) => void;
  onFlash: (msg: string) => void;
}

export const ListingDetailModal: React.FC<ListingDetailModalProps> = ({
  listing,
  onClose,
  userUid,
  profile,
  privateUser,
  settings,
  displayCurrency,
  onRequireAuth,
  onOpenWallet,
  onStartChatWithUser,
  onOpenPublicProfile,
  onDealOpened,
  onFlash,
}) => {
  const [selectedImg, setSelectedImg] = useState(0);
  const [bids, setBids] = useState<BidRecord[]>([]);
  const [bidAmount, setBidAmount] = useState('');
  const [bidError, setBidError] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [withdrawingBidId, setWithdrawingBidId] = useState<string | null>(null);
  const submittingBidRef = useRef(false);
  const withdrawingBidRef = useRef<string | null>(null);
  const viewCountedRef = useRef<string | null>(null);

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

  // Close modal on Escape key press for keyboard accessibility
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

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

  const handleBuyNow = async () => {
    if (!userUid || !profile || !privateUser) {
      onRequireAuth();
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
    const buyNowFinancials = calculateAcceptedBidDealFinancials(
      listing.priceMinor,
      settings,
      listing.priceMinor
    );
    if (privateUser.walletBalanceMinor < buyNowFinancials.buyerTotalMinor) {
      onFlash('Insufficient wallet balance. Add funds via Manual Deposit to purchase.');
      onOpenWallet();
      return;
    }

    setBusyAction(true);
    try {
      const dealId = `deal_${listing.id}_${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 120);
      const ledgerId = `led_pay_${dealId}`;
      const protectionHours = getProtectionDurationHours(listing.platform, settings);
      const paidAtMs = Date.now();

      await runTransaction(db, async (tx) => {
        const listingRef = doc(db, 'listings', listing.id);
        const buyerPrivRef = doc(db, 'privateUsers', userUid);
        const dealRef = doc(db, 'deals', dealId);
        const ledgerRef = doc(db, 'walletLedger', ledgerId);

        const [listingSnap, buyerSnap, existingLedSnap] = await Promise.all([
          tx.get(listingRef),
          tx.get(buyerPrivRef),
          tx.get(ledgerRef),
        ]);

        if (existingLedSnap.exists()) {
          throw new Error('Payment has already been processed for this deal.');
        }
        if (!listingSnap.exists() || listingSnap.data()?.status !== 'active') {
          throw new Error('This listing has already been reserved or sold.');
        }

        const currentBalance = Number(buyerSnap.data()?.walletBalanceMinor) || 0;
        if (currentBalance < buyNowFinancials.buyerTotalMinor) {
          throw new Error('Insufficient wallet balance.');
        }

        tx.update(buyerPrivRef, {
          walletBalanceMinor: currentBalance - buyNowFinancials.buyerTotalMinor,
          updatedAt: serverTimestamp(),
        });

        tx.set(dealRef, {
          listingId: listing.id,
          listingTitle: listing.title,
          platform: listing.platform,
          originalListingPriceMinor: listing.priceMinor,
          buyerId: userUid,
          buyerName: profile.displayName,
          sellerId: listing.sellerId,
          sellerName: listing.sellerName,
          baseAmountMinor: buyNowFinancials.baseAmountMinor,
          buyerFeePct: buyNowFinancials.buyerFeePct,
          sellerFeePct: buyNowFinancials.sellerFeePct,
          buyerFeeMinor: buyNowFinancials.buyerFeeMinor,
          sellerFeeMinor: buyNowFinancials.sellerFeeMinor,
          buyerTotalMinor: buyNowFinancials.buyerTotalMinor,
          sellerPayoutMinor: buyNowFinancials.sellerPayoutMinor,
          platformCommissionMinor: buyNowFinancials.platformCommissionMinor,
          refundBuyerMinor: buyNowFinancials.refundBuyerMinor,
          refundPlatformRetainedMinor: buyNowFinancials.refundPlatformRetainedMinor,
          currency: listing.currency,
          protectionDurationHours: protectionHours,
          confirmedAtMs: 0,
          originalDeadlineMs: 0,
          unresolvedReportCount: 0,
          paymentLedgerId: ledgerId,
          paidAtMs,
          transferSubmissionCount: 0,
          status: 'paid_deal_room_active',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        tx.update(listingRef, {
          status: 'sold',
          activeDealId: dealId,
          updatedAt: serverTimestamp(),
        });

        tx.set(ledgerRef, {
          userId: userUid,
          kind: 'escrow_debit',
          amountMinor: buyNowFinancials.buyerTotalMinor,
          currency: listing.currency,
          referenceId: dealId,
          note: `Escrow Buy Now payment for ${listing.title.slice(0, 80)}`,
          createdAt: serverTimestamp(),
        });
      });

      const formattedTotal = formatMoneyFromMinor(
        buyNowFinancials.buyerTotalMinor,
        listing.currency,
        listing.currency
      );
      await Promise.all([
        appendDealAuditEvent({
          dealId,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: 'buyer',
          eventType: 'deal_funded_buy_now',
          summary: `Buyer funded ${formattedTotal} in Escrow (Buy Now). Private 3-party Deal Room activated.`,
        }),
        emitPaidDealRoomCreatedAlerts({
          dealId,
          listingTitle: listing.title,
          buyerId: userUid,
          buyerName: profile.displayName,
          sellerId: listing.sellerId,
          totalFormatted: formattedTotal,
          paymentSummary: `Buy Now escrow payment (${formattedTotal})`,
        }),
        emitUserNotification({
          recipientId: userUid,
          eventKey: `wallet_escrow_debit_${dealId}`,
          category: 'wallet',
          severity: 'info',
          title: 'Wallet Debited for Escrow Purchase',
          preview: `${formattedTotal} locked in escrow for "${listing.title}".`,
          body: `${formattedTotal} was debited from your BEXORA Wallet to fund Escrow Deal #${dealId.slice(0, 10)} for "${listing.title}".`,
          refType: 'wallet',
          refId: ledgerId,
          referenceLabel: `Ledger #${ledgerId.slice(0, 12)}`,
          destination: 'wallet',
        }),
      ]);

      onDealOpened(
        dealId,
        'Escrow funded! Your 3-Party Deal Room is active — await Seller Asset Transfer Proof.'
      );
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Purchase could not be completed.');
    } finally {
      setBusyAction(false);
    }
  };

  const handleSubmitBid = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submittingBidRef.current) return;
    setBidError('');
    if (!userUid || !profile) {
      onRequireAuth();
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
    <div
      className="fixed inset-0 z-50 bg-black/65 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={listing.title}
    >
      <div
        className="bx-card w-full max-w-3xl max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-2xl p-5 sm:p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="min-w-0">
            <p className="text-xs font-semibold" style={{ color: 'var(--orange)' }}>
              {platformDef.name} · {listing.subcategory}
              {listing.status === 'reserved' && (
                <span>
                  {' '}
                  · Reserved — Pending Buyer Payment (
                  {formatMoneyFromMinor(
                    effectiveBasePriceMinor,
                    displayCurrency,
                    listing.currency,
                    settings.usdToBdtRate
                  )}{' '}
                  accepted bid)
                </span>
              )}
            </p>
            <h2 className="text-lg sm:text-xl font-extrabold leading-snug mt-0.5">{listing.title}</h2>
          </div>
          <button type="button" onClick={onClose} className="bx-icon-btn !w-9 !h-9" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Media Gallery */}
        <div className="space-y-2">
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
            <div className="flex items-center gap-2 overflow-x-auto pb-1">
              {listing.images.map((src, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSelectedImg(idx)}
                  className="w-20 aspect-[16/10] rounded-lg overflow-hidden border-2 shrink-0"
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
            <h3 className="text-sm font-extrabold">Monetization Status</h3>
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
          <h3 className="text-sm font-extrabold mb-1.5">Asset Description</h3>
          <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'var(--text-2)' }}>
            {listing.description}
          </p>
        </div>

        {/* Seller Card + Direct Message Action */}
        <div className="p-4 rounded-xl bx-soft flex items-center justify-between gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenPublicProfile(listing.sellerId);
            }}
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
              <span className="bx-hint">@{listing.sellerUsername} · View Public Profile</span>
            </div>
          </button>

          {!isSellerOwner && (
            <button
              type="button"
              onClick={() => {
                if (!userUid) {
                  onRequireAuth();
                  return;
                }
                onStartChatWithUser(listing.sellerId, listing.sellerName, listing);
              }}
              className="bx-btn bx-btn-sm"
            >
              <MessageSquare className="w-4 h-4" />
              <span>Message Seller</span>
            </button>
          )}
        </div>

        {/* Transparent Commission & Escrow Purchase Module */}
        <div className="p-4 rounded-xl bx-soft space-y-2 text-sm tabular-nums">
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
              background: 'var(--surface)',
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
                    ? `Your bid was accepted! Pay the exact agreed total (${formatMoneyFromMinor(
                        breakdown.buyerTotalMinor,
                        displayCurrency,
                        listing.currency,
                        settings.usdToBdtRate
                      )}) in the Deal Room to lock funds in Escrow.`
                    : isSellerOwner
                    ? 'You accepted a bid on this listing. Both the listing and the accepted bid remain preserved while awaiting buyer wallet payment. Conflicting Buy Now purchases and duplicate bid acceptances are locked.'
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
                    onClick={() =>
                      onDealOpened(
                        resolvedActiveDealId,
                        isReservedBuyer
                          ? 'Complete your exact accepted-bid wallet payment to activate the 3-Party Deal Room.'
                          : 'Opened reserved Deal Room.'
                      )
                    }
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
          <button
            type="button"
            disabled={busyAction}
            onClick={handleBuyNow}
            className="bx-btn bx-btn-yellow w-full text-base"
          >
            <span>
              {busyAction
                ? 'Processing Escrow Purchase…'
                : `Buy Now with Wallet — ${formatMoneyFromMinor(
                    breakdown.buyerTotalMinor,
                    displayCurrency,
                    listing.currency,
                    settings.usdToBdtRate
                  )}`}
            </span>
          </button>
        )}

        {/* Role-Based Bidding Room & Preserved Bid History */}
        <div className="p-4 rounded-xl bx-soft space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-extrabold">
              {isSellerOwner
                ? `Seller Bid Management & History (${visibleBids.length})`
                : `Live Bidding Room (${visibleBids.length})`}
            </h3>
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
              <input
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
                const linkedDealId = b.dealId || (isAcceptedAwaitingPay ? listing.activeDealId : undefined);
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
                      background: 'var(--surface)',
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
                          onClick={() => {
                            onClose();
                            onOpenPublicProfile(b.buyerId);
                          }}
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
                          onClick={() =>
                            onDealOpened(
                              linkedDealId,
                              isAcceptedAwaitingPay
                                ? `Pay ${formatMoneyFromMinor(
                                    bidTotalWithFee.buyerTotalMinor,
                                    displayCurrency,
                                    b.currency,
                                    settings.usdToBdtRate
                                  )} in Deal Room.`
                                : 'Opened funded 3-Party Deal Room.'
                            )
                          }
                          className="bx-btn bx-btn-sm bx-btn-primary"
                        >
                          <span>{isAcceptedAwaitingPay ? 'Pay Accepted Bid' : 'Open Deal Room'}</span>
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
                              onClick={() => onDealOpened(linkedDealId, 'Opened Deal Room for accepted bid.')}
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
  );
};
