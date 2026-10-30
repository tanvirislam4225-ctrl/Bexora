import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  addDoc,
  collection,
  deleteField,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from 'firebase/firestore';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileCheck2,
  ImagePlus,
  Lock,
  RotateCcw,
  Send,
  ShieldCheck,
  Star,
  Trash2,
  Wallet,
  XCircle,
  ZoomIn,
} from 'lucide-react';
import {
  ChatMessageRecord,
  CurrencyCode,
  DealAuditEvent,
  DealRecord,
  DealReportCategory,
  DealReportRecord,
  DealTransferSubmission,
  PrivateUser,
  PublicProfile,
  PublicSettings,
} from '../types';
import {
  db,
  extractUserFacingFirestoreError,
  validateAndProcessImageFile,
} from '../lib/firebase';
import {
  calculateDisputeRefundBreakdown,
  computeRemainingProtectionMs,
  DEAL_REPORT_CATEGORIES,
  detectSensitiveOrOffPlatformContent,
  formatMoneyFromMinor,
  getDealReportCategoryLabel,
  getDealStatusLabel,
  getPlatformTransferChecklist,
  isDealAwaitingSellerTransferStatus,
  isDealReportableStatus,
  isDealSecurityTimerActiveStatus,
  isDealTerminalStatus,
  isDealTransferSubmittedStatus,
  isDealUnpaidStatus,
  PLATFORM_CATALOG,
  validateBuyerTransferRejection,
  validateDealReportInput,
} from '../lib/marketplaceLogic';
import {
  appendDealAuditEvent,
  emitDealAdminNotification,
  emitPaidDealRoomCreatedAlerts,
  emitUserNotification,
} from '../lib/notificationService';
import { ImageLightboxModal, LightboxImageItem } from './ImageLightboxModal';
import { SellerAssetTransferBox } from './SellerAssetTransferBox';

const ProtectionCountdown: React.FC<{
  originalDeadlineMs: number;
  pausedForReview: boolean;
  unresolvedReportCount: number;
}> = ({ originalDeadlineMs, pausedForReview, unresolvedReportCount }) => {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const remMs = computeRemainingProtectionMs(originalDeadlineMs, nowMs);
  const totalSec = Math.floor(remMs / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const elapsedNoDisputes = remMs === 0 && !pausedForReview && unresolvedReportCount === 0;

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-4 gap-2 tabular-nums">
        {[
          [days, 'Days'],
          [hours, 'Hours'],
          [mins, 'Min'],
          [secs, 'Sec'],
        ].map(([val, label]) => (
          <div key={String(label)} className="p-2.5 rounded-xl bx-soft text-center">
            <strong className="block text-lg sm:text-xl font-extrabold font-mono">
              {String(val).padStart(2, '0')}
            </strong>
            <span className="text-[10px] font-extrabold uppercase" style={{ color: 'var(--text-2)' }}>
              {label}
            </span>
          </div>
        ))}
      </div>
      <p className="bx-hint">
        Immutable Security Deadline: <strong>{new Date(originalDeadlineMs).toLocaleString()}</strong>.
        {pausedForReview
          ? ' Escrow payout release is paused while your report is under BEXORA Administrator review — the original deadline is never extended.'
          : elapsedNoDisputes
          ? ' Security countdown has completed with 0 unresolved disputes. This deal is flagged Ready for Final Administrator Payout Settlement.'
          : ' Reports, page reloads, or review pauses never extend this deadline.'}
      </p>
    </div>
  );
};

interface DealsViewProps {
  userUid: string | null;
  profile: PublicProfile | null;
  privateUser: PrivateUser | null;
  deals: DealRecord[];
  settings: PublicSettings;
  displayCurrency: CurrencyCode;
  initialDealId: string | null;
  onRequireAuth: () => void;
  onOpenWallet: () => void;
  onFlash: (msg: string) => void;
}

export const DealsView: React.FC<DealsViewProps> = ({
  userUid,
  profile,
  privateUser,
  deals,
  settings,
  displayCurrency,
  initialDealId,
  onRequireAuth,
  onOpenWallet,
  onFlash,
}) => {
  const [selectedDealId, setSelectedDealId] = useState<string | null>(initialDealId);
  const [messages, setMessages] = useState<ChatMessageRecord[]>([]);
  const [transfers, setTransfers] = useState<DealTransferSubmission[]>([]);
  const [reports, setReports] = useState<DealReportRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<DealAuditEvent[]>([]);

  const [chatText, setChatText] = useState('');

  // Buyer Rejection State
  const [showRejectBox, setShowRejectBox] = useState(false);
  const [rejectionReason, setRejectionReason] = useState('');

  // Structured Report Form State
  const [showReportForm, setShowReportForm] = useState(false);
  const [reportCategory, setReportCategory] = useState<DealReportCategory>('ownership_not_transferred');
  const [reportReason, setReportReason] = useState('');
  const [reportEvidence, setReportEvidence] = useState<string[]>([]);
  const [processingReportImg, setProcessingReportImg] = useState(false);
  const reportFileInputRef = useRef<HTMLInputElement | null>(null);

  // Lightbox Inspection State
  const [lightboxItems, setLightboxItems] = useState<LightboxImageItem[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [lightboxTitle, setLightboxTitle] = useState('Evidence Inspection');

  // Post-settlement Review State
  const [reviewScore, setReviewScore] = useState(5);
  const [reviewComment, setReviewComment] = useState('');

  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');

  useEffect(() => {
    if (initialDealId) {
      setSelectedDealId(initialDealId);
    } else if (!selectedDealId && deals.length > 0) {
      setSelectedDealId(deals[0].id);
    }
  }, [initialDealId, deals.length, selectedDealId]);

  const activeDeal = useMemo(
    () => deals.find((d) => d.id === selectedDealId) || (deals.length > 0 ? deals[0] : null),
    [deals, selectedDealId]
  );

  useEffect(() => {
    if (!activeDeal || !userUid) {
      setMessages([]);
      setTransfers([]);
      setReports([]);
      setAuditEvents([]);
      return;
    }

    const mq = query(collection(db, 'deals', activeDeal.id, 'messages'), orderBy('createdAt', 'asc'));
    const tq = query(collection(db, 'deals', activeDeal.id, 'transfers'), orderBy('version', 'desc'));
    const rq = query(collection(db, 'deals', activeDeal.id, 'reports'), orderBy('createdAt', 'desc'));
    const eq = query(collection(db, 'deals', activeDeal.id, 'events'), orderBy('createdAt', 'desc'));

    const unsubM = onSnapshot(
      mq,
      (snap) => {
        setMessages(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              senderId: String(data.senderId || ''),
              senderName: String(data.senderName || ''),
              senderRole: data.senderRole as ChatMessageRecord['senderRole'],
              kind: data.kind || 'text',
              text: String(data.text || ''),
              mediaData: data.mediaData,
              createdAtMs: data.createdAt?.toMillis?.() || Date.now(),
            };
          })
        );
      },
      () => {}
    );

    const unsubT = onSnapshot(
      tq,
      (snap) => {
        setTransfers(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              dealId: String(data.dealId || activeDeal.id),
              sellerId: String(data.sellerId || ''),
              sellerName: String(data.sellerName || ''),
              version: Number(data.version || 1),
              screenshots: Array.isArray(data.screenshots) ? data.screenshots : [],
              transferNote: String(data.transferNote || ''),
              completedSteps: Array.isArray(data.completedSteps) ? data.completedSteps : [],
              status: (data.status || 'submitted') as DealTransferSubmission['status'],
              buyerDecisionBy: data.buyerDecisionBy ? String(data.buyerDecisionBy) : undefined,
              buyerDecisionReason: data.buyerDecisionReason ? String(data.buyerDecisionReason) : undefined,
              decidedAtMs: data.decidedAtMs ? Number(data.decidedAtMs) : undefined,
              submittedAtMs: data.submittedAtMs ? Number(data.submittedAtMs) : undefined,
              createdAtMs: data.createdAt?.toMillis?.() || Number(data.submittedAtMs) || Date.now(),
            };
          })
        );
      },
      () => {}
    );

    const unsubR = onSnapshot(
      rq,
      (snap) => {
        setReports(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              dealId: String(data.dealId || activeDeal.id),
              dealReference: data.dealReference ? String(data.dealReference) : undefined,
              reporterId: String(data.reporterId || ''),
              reporterName: data.reporterName ? String(data.reporterName) : undefined,
              reporterRole: data.reporterRole as 'buyer' | 'seller',
              category: data.category as DealReportCategory | undefined,
              reason: String(data.reason || ''),
              evidenceImages: Array.isArray(data.evidenceImages) ? data.evidenceImages : [],
              status: data.status as DealReportRecord['status'],
              adminDecisionNote: data.adminDecisionNote ? String(data.adminDecisionNote) : undefined,
              decidedBy: data.decidedBy ? String(data.decidedBy) : undefined,
              decidedAtMs: data.decidedAtMs ? Number(data.decidedAtMs) : undefined,
              createdAtMs: data.createdAt?.toMillis?.() || Date.now(),
            };
          })
        );
      },
      () => {}
    );

    const unsubE = onSnapshot(
      eq,
      (snap) => {
        setAuditEvents(
          snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              dealId: String(data.dealId || activeDeal.id),
              actorId: String(data.actorId || ''),
              actorName: String(data.actorName || ''),
              actorRole: (data.actorRole || 'system') as DealAuditEvent['actorRole'],
              eventType: String(data.eventType || ''),
              summary: String(data.summary || ''),
              createdAtMs: Number(data.createdAtMs || data.createdAt?.toMillis?.() || Date.now()),
            };
          })
        );
      },
      () => {}
    );

    return () => {
      unsubM();
      unsubT();
      unsubR();
      unsubE();
    };
  }, [activeDeal?.id, userUid]);

  if (!userUid || !profile) {
    return (
      <div className="bx-wrap py-12">
        <div className="bx-card p-8 text-center max-w-md mx-auto space-y-3">
          <ShieldCheck className="w-10 h-10 mx-auto" style={{ color: 'var(--orange)' }} />
          <h2 className="text-xl font-extrabold">3-Party Escrow Deal Rooms</h2>
          <p className="bx-hint">
            Sign in to view your accepted bids, pay exact escrow amounts, inspect seller transfer screenshots, and track security timers.
          </p>
          <button type="button" onClick={onRequireAuth} className="bx-btn bx-btn-primary">
            Sign In
          </button>
        </div>
      </div>
    );
  }

  const isBuyer = activeDeal ? activeDeal.buyerId === userUid : false;
  const isSeller = activeDeal ? activeDeal.sellerId === userUid : false;

  const openLightbox = (items: LightboxImageItem[], startIndex: number, title: string) => {
    setLightboxItems(items);
    setLightboxTitle(title);
    setLightboxIndex(startIndex);
  };

  // PART 2: Exact Accepted-Bid Payment (Bid + 5% Buyer Fee)
  const handlePayAcceptedDeal = async () => {
    if (!activeDeal || !isBuyer || !privateUser) return;
    if (privateUser.walletBalanceMinor < activeDeal.buyerTotalMinor) {
      setErrMsg(
        `Insufficient wallet balance. Required: ${formatMoneyFromMinor(
          activeDeal.buyerTotalMinor,
          displayCurrency,
          activeDeal.currency,
          settings.usdToBdtRate
        )}. Available: ${formatMoneyFromMinor(
          privateUser.walletBalanceMinor,
          displayCurrency,
          'BDT',
          settings.usdToBdtRate
        )}.`
      );
      return;
    }

    setBusy(true);
    setErrMsg('');
    try {
      const ledgerId = `led_pay_${activeDeal.id}`;
      const paidAtMs = Date.now();

      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', activeDeal.id);
        const privRef = doc(db, 'privateUsers', userUid);
        const listingRef = doc(db, 'listings', activeDeal.listingId);
        const ledgerRef = doc(db, 'walletLedger', ledgerId);

        const [dSnap, pSnap, lSnap, ledSnap] = await Promise.all([
          tx.get(dealRef),
          tx.get(privRef),
          tx.get(listingRef),
          tx.get(ledgerRef),
        ]);

        if (ledSnap.exists()) {
          throw new Error('This deal has already been paid. Duplicate payment blocked.');
        }
        if (!dSnap.exists() || !isDealUnpaidStatus(String(dSnap.data()?.status || ''))) {
          throw new Error('This deal is not awaiting payment.');
        }
        if (!lSnap.exists()) {
          throw new Error('Associated listing record not found.');
        }

        const bal = Number(pSnap.data()?.walletBalanceMinor) || 0;
        if (bal < activeDeal.buyerTotalMinor) {
          throw new Error('Insufficient wallet balance.');
        }

        const acceptedBidId = dSnap.data()?.acceptedBidId
          ? String(dSnap.data()?.acceptedBidId)
          : activeDeal.acceptedBidId;

        if (acceptedBidId) {
          const bidRef = doc(db, 'bids', acceptedBidId);
          const bSnap = await tx.get(bidRef);
          if (bSnap.exists()) {
            tx.update(bidRef, {
              status: 'paid',
              updatedAt: serverTimestamp(),
            });
          }
        }

        tx.update(privRef, {
          walletBalanceMinor: bal - activeDeal.buyerTotalMinor,
          updatedAt: serverTimestamp(),
        });

        tx.update(dealRef, {
          status: 'paid_deal_room_active',
          paymentLedgerId: ledgerId,
          paidAtMs,
          updatedAt: serverTimestamp(),
        });

        tx.update(listingRef, {
          status: 'sold',
          activeDealId: activeDeal.id,
          updatedAt: serverTimestamp(),
        });

        tx.set(ledgerRef, {
          userId: userUid,
          kind: 'escrow_debit',
          amountMinor: activeDeal.buyerTotalMinor,
          currency: activeDeal.currency,
          referenceId: activeDeal.id,
          note: `Accepted-bid escrow payment (${formatMoneyFromMinor(
            activeDeal.baseAmountMinor,
            activeDeal.currency,
            activeDeal.currency
          )} + ${activeDeal.buyerFeePct}% fee)`,
          createdAt: serverTimestamp(),
        });
      });

      const baseFmt = formatMoneyFromMinor(
        activeDeal.baseAmountMinor,
        activeDeal.currency,
        activeDeal.currency
      );
      const totalFmt = formatMoneyFromMinor(
        activeDeal.buyerTotalMinor,
        activeDeal.currency,
        activeDeal.currency
      );

      await Promise.all([
        appendDealAuditEvent({
          dealId: activeDeal.id,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: 'buyer',
          eventType: 'accepted_bid_paid',
          summary: `Buyer paid exact accepted bid ${baseFmt} + ${activeDeal.buyerFeePct}% fee (${totalFmt} total, Ledger ${ledgerId}). Private 3-party Deal Room activated.`,
        }),
        emitPaidDealRoomCreatedAlerts({
          dealId: activeDeal.id,
          listingTitle: activeDeal.listingTitle,
          buyerId: userUid,
          buyerName: activeDeal.buyerName,
          sellerId: activeDeal.sellerId,
          totalFormatted: totalFmt,
          paymentSummary: `accepted bid (${baseFmt} + ${activeDeal.buyerFeePct}% fee = ${totalFmt})`,
        }),
      ]);

      onFlash('Escrow payment confirmed! Private 3-Party Deal Room is active — awaiting Seller Asset Transfer Proof.');
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Payment could not be completed.'));
    } finally {
      setBusy(false);
    }
  };

  // PART 1: Cancel Unpaid Reservation & Restore Listing
  const handleCancelUnpaidDeal = async () => {
    if (!activeDeal || !isDealUnpaidStatus(activeDeal.status) || (!isBuyer && !isSeller)) return;
    setBusy(true);
    setErrMsg('');
    try {
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', activeDeal.id);
        const listingRef = doc(db, 'listings', activeDeal.listingId);
        const ledgerRef = doc(db, 'walletLedger', `led_pay_${activeDeal.id}`);

        const [dSnap, lSnap, ledSnap] = await Promise.all([
          tx.get(dealRef),
          tx.get(listingRef),
          tx.get(ledgerRef),
        ]);

        if (ledSnap.exists()) {
          throw new Error('Payment has already been processed; deal cannot be cancelled as unpaid.');
        }
        if (!dSnap.exists() || !isDealUnpaidStatus(String(dSnap.data()?.status || ''))) {
          throw new Error('Deal is no longer unpaid.');
        }

        const acceptedBidId = dSnap.data()?.acceptedBidId
          ? String(dSnap.data()?.acceptedBidId)
          : activeDeal.acceptedBidId;

        if (acceptedBidId) {
          const bidRef = doc(db, 'bids', acceptedBidId);
          const bSnap = await tx.get(bidRef);
          if (bSnap.exists() && ['accepted_pending_payment', 'accepted'].includes(String(bSnap.data()?.status || ''))) {
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

        if (lSnap.exists() && lSnap.data()?.status === 'reserved') {
          tx.update(listingRef, {
            status: 'active',
            activeDealId: deleteField(),
            acceptedBidAmountMinor: deleteField(),
            reservedBuyerId: deleteField(),
            updatedAt: serverTimestamp(),
          });
        }
      });

      const counterpartyId = isBuyer ? activeDeal.sellerId : activeDeal.buyerId;
      await Promise.all([
        appendDealAuditEvent({
          dealId: activeDeal.id,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: isBuyer ? 'buyer' : 'seller',
          eventType: 'unpaid_deal_cancelled',
          summary: `Unpaid accepted-bid reservation was cancelled by ${isBuyer ? 'buyer' : 'seller'}. Listing restored to active marketplace status.`,
        }),
        emitUserNotification({
          recipientId: counterpartyId,
          eventKey: `deal_unpaid_cancelled_${activeDeal.id}`,
          category: 'deal',
          severity: 'warning',
          title: 'Unpaid Reservation Cancelled — Listing Restored',
          preview: `"${activeDeal.listingTitle}" reservation was released back to active status.`,
          body: `The unpaid accepted-bid reservation on "${activeDeal.listingTitle}" (Deal #${activeDeal.id.slice(0, 10)}) was cancelled prior to payment. The listing is active on the marketplace again.`,
          refType: 'listing',
          refId: activeDeal.listingId,
          referenceLabel: activeDeal.listingTitle.slice(0, 80),
          destination: `listing:${activeDeal.listingId}`,
        }),
      ]);

      onFlash('Unpaid reservation cancelled and listing restored to active status.');
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Could not cancel unpaid reservation.'));
    } finally {
      setBusy(false);
    }
  };

  // PART 4: Seller Submits Official Asset Transfer Proof (2-3 Screenshots + Checklist + Note)
  const handleSellerSubmitTransfer = async (payload: {
    screenshots: string[];
    transferNote: string;
    completedSteps: string[];
  }) => {
    if (!activeDeal || !isSeller) return;
    setBusy(true);
    setErrMsg('');
    try {
      const submissionRef = doc(collection(db, 'deals', activeDeal.id, 'transfers'));
      let savedVersion = 1;

      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', activeDeal.id);
        const dSnap = await tx.get(dealRef);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        const dData = dSnap.data()!;
        if (!isDealAwaitingSellerTransferStatus(String(dData.status || ''))) {
          throw new Error('This deal is not currently awaiting seller transfer submission.');
        }

        const nextVersion = (Number(dData.transferSubmissionCount) || 0) + 1;
        savedVersion = nextVersion;
        const nowMs = Date.now();

        tx.set(submissionRef, {
          dealId: activeDeal.id,
          sellerId: userUid,
          sellerName: profile.displayName,
          version: nextVersion,
          screenshots: payload.screenshots,
          transferNote: payload.transferNote,
          completedSteps: payload.completedSteps,
          status: 'submitted',
          submittedAtMs: nowMs,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        tx.update(dealRef, {
          status: 'transfer_submitted',
          transferSubmissionCount: nextVersion,
          latestTransferSubmissionId: submissionRef.id,
          updatedAt: serverTimestamp(),
        });
      });

      await Promise.all([
        appendDealAuditEvent({
          dealId: activeDeal.id,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: 'seller',
          eventType: 'seller_transfer_submitted',
          summary: `Seller submitted Asset Transfer Proof v${savedVersion} (${payload.screenshots.length} screenshots, ${payload.completedSteps.length} checklist steps). Awaiting buyer verification.`,
        }),
        emitUserNotification({
          recipientId: activeDeal.buyerId,
          eventKey: `transfer_submitted_buyer_${activeDeal.id}_v${savedVersion}`,
          category: 'deal',
          severity: 'info',
          title: 'Asset Transfer Submitted — Review & Verify',
          preview: `${activeDeal.sellerName} uploaded ${payload.screenshots.length} transfer proof screenshots for "${activeDeal.listingTitle}".`,
          body: `${activeDeal.sellerName} submitted Asset Transfer Proof (v${savedVersion}) for "${activeDeal.listingTitle}". Open Deal #${activeDeal.id.slice(0, 10)}, inspect the screenshots carefully, verify full asset access, and choose Approve Transfer or Reject Transfer.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
        emitUserNotification({
          recipientId: userUid,
          eventKey: `transfer_submitted_seller_${activeDeal.id}_v${savedVersion}`,
          category: 'deal',
          severity: 'success',
          title: `Transfer Proof v${savedVersion} Recorded`,
          preview: `Buyer has been notified to verify "${activeDeal.listingTitle}".`,
          body: `Your Asset Transfer Proof (v${savedVersion}) with ${payload.screenshots.length} screenshots has been immutably saved in Deal #${activeDeal.id.slice(0, 10)}. The buyer has been notified to inspect and approve receipt.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
      ]);

      onFlash(`Asset Transfer Proof (v${savedVersion}) submitted! Buyer has been notified to review and approve.`);
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Failed to submit transfer proof.'));
      throw err;
    } finally {
      setBusy(false);
    }
  };

  // PART 5 & 6: Buyer Approves Transfer -> Starts Asset-Specific Security Timer (168h YouTube / 40h Standard)
  const handleBuyerApproveTransfer = async () => {
    if (!activeDeal || !isBuyer) return;
    setBusy(true);
    setErrMsg('');
    try {
      let confirmedHours = activeDeal.protectionDurationHours;
      let approvedSubmissionId = activeDeal.latestTransferSubmissionId || transfers[0]?.id || '';

      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', activeDeal.id);
        const dSnap = await tx.get(dealRef);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        const data = dSnap.data()!;
        if (Number(data.originalDeadlineMs) > 0) {
          throw new Error('Transfer has already been approved and the security timer is locked.');
        }
        if (!isDealTransferSubmittedStatus(String(data.status || ''))) {
          throw new Error('Awaiting seller transfer proof before buyer approval.');
        }

        const nowMs = Date.now();
        const durationHours =
          Number(data.protectionDurationHours) ||
          (activeDeal.platform === 'youtube' ? 168 : 40);
        confirmedHours = durationHours;
        const deadlineMs = nowMs + durationHours * 3_600_000;

        const latestSubId = data.latestTransferSubmissionId
          ? String(data.latestTransferSubmissionId)
          : approvedSubmissionId;
        approvedSubmissionId = latestSubId;

        if (latestSubId) {
          const subRef = doc(db, 'deals', activeDeal.id, 'transfers', latestSubId);
          const subSnap = await tx.get(subRef);
          if (subSnap.exists()) {
            tx.update(subRef, {
              status: 'approved',
              buyerDecisionBy: userUid,
              decidedAtMs: nowMs,
              updatedAt: serverTimestamp(),
            });
          }
        }

        tx.update(dealRef, {
          status: 'security_period_active',
          confirmedAtMs: nowMs,
          originalDeadlineMs: deadlineMs,
          updatedAt: serverTimestamp(),
        });
      });

      await Promise.all([
        appendDealAuditEvent({
          dealId: activeDeal.id,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: 'buyer',
          eventType: 'buyer_transfer_approved',
          summary: `Buyer approved asset transfer. Immutable ${confirmedHours}-hour security countdown started.`,
        }),
        emitUserNotification({
          recipientId: activeDeal.sellerId,
          eventKey: `deal_confirmed_seller_${activeDeal.id}`,
          category: 'deal',
          severity: 'success',
          title: `Buyer Approved Transfer — ${confirmedHours}h Security Timer Started`,
          preview: `${activeDeal.buyerName} approved receipt of "${activeDeal.listingTitle}".`,
          body: `${activeDeal.buyerName} approved the asset transfer for "${activeDeal.listingTitle}" (Deal #${activeDeal.id.slice(0, 10)}). The ${confirmedHours}-hour security countdown is now running before final seller payout release.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
        emitUserNotification({
          recipientId: userUid,
          eventKey: `deal_confirmed_buyer_${activeDeal.id}`,
          category: 'deal',
          severity: 'info',
          title: `Security Protection Timer Active (${confirmedHours}h)`,
          preview: `Escrow remains locked for ${confirmedHours} hours on "${activeDeal.listingTitle}".`,
          body: `You approved receipt of "${activeDeal.listingTitle}" (Deal #${activeDeal.id.slice(0, 10)}). Your ${confirmedHours}-hour security protection period is active. If any unauthorized recovery or issue occurs, submit a Report immediately inside the Deal Room.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
        emitDealAdminNotification({
          dealId: activeDeal.id,
          eventKey: `admin_buyer_approved_${activeDeal.id}`,
          category: 'deal',
          severity: 'info',
          title: `Buyer Approved Transfer (${confirmedHours}h Timer Active)`,
          preview: `"${activeDeal.listingTitle}" entered its ${confirmedHours}h security period.`,
          body: `Buyer ${activeDeal.buyerName} approved Seller ${activeDeal.sellerName}'s transfer on Deal #${activeDeal.id.slice(0, 10)}. Security timer (${confirmedHours}h) is now running.`,
          referenceLabel: `Deal · ${activeDeal.listingTitle}`,
        }),
      ]);

      onFlash(`Transfer approved! Immutable ${confirmedHours}-hour security protection timer started.`);
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Could not approve transfer.'));
    } finally {
      setBusy(false);
    }
  };

  // PART 5: Buyer Rejects Transfer Proof (Requires Reason, Preserves Evidence, Notifies Seller + Admin)
  const handleBuyerRejectTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDeal || !isBuyer) return;

    const validation = validateBuyerTransferRejection(rejectionReason);
    if (!validation.valid) {
      setErrMsg(validation.error || 'Enter a clear rejection reason.');
      return;
    }

    setBusy(true);
    setErrMsg('');
    try {
      let rejectedVersion = activeDeal.transferSubmissionCount || 1;
      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', activeDeal.id);
        const dSnap = await tx.get(dealRef);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        const data = dSnap.data()!;
        if (String(data.status || '') !== 'transfer_submitted') {
          throw new Error('Only a submitted transfer awaiting buyer review can be rejected.');
        }

        const nowMs = Date.now();
        rejectedVersion = Number(data.transferSubmissionCount) || 1;
        const latestSubId = data.latestTransferSubmissionId
          ? String(data.latestTransferSubmissionId)
          : transfers[0]?.id || '';

        if (latestSubId) {
          const subRef = doc(db, 'deals', activeDeal.id, 'transfers', latestSubId);
          const subSnap = await tx.get(subRef);
          if (subSnap.exists()) {
            tx.update(subRef, {
              status: 'rejected',
              buyerDecisionBy: userUid,
              buyerDecisionReason: validation.cleanReason,
              decidedAtMs: nowMs,
              updatedAt: serverTimestamp(),
            });
          }
        }

        tx.update(dealRef, {
          status: 'transfer_rejected',
          latestRejectionReason: validation.cleanReason,
          updatedAt: serverTimestamp(),
        });
      });

      await Promise.all([
        appendDealAuditEvent({
          dealId: activeDeal.id,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: 'buyer',
          eventType: 'buyer_transfer_rejected',
          summary: `Buyer rejected Transfer Proof v${rejectedVersion}. Reason: "${validation.cleanReason}"`,
        }),
        emitUserNotification({
          recipientId: activeDeal.sellerId,
          eventKey: `transfer_rejected_seller_${activeDeal.id}_v${rejectedVersion}`,
          category: 'dispute',
          severity: 'warning',
          title: 'Buyer Rejected Transfer Proof — Action Required',
          preview: `Buyer rejected Transfer v${rejectedVersion} on "${activeDeal.listingTitle}".`,
          body: `${activeDeal.buyerName} rejected Transfer Submission v${rejectedVersion} for "${activeDeal.listingTitle}". Reason: "${validation.cleanReason}". Open Deal #${activeDeal.id.slice(0, 10)} to correct the handover and upload updated proof, or request Admin review.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
        emitDealAdminNotification({
          dealId: activeDeal.id,
          eventKey: `admin_transfer_rejected_${activeDeal.id}_v${rejectedVersion}`,
          category: 'dispute',
          severity: 'warning',
          title: 'Buyer Rejected Asset Transfer Proof',
          preview: `"${activeDeal.listingTitle}" Transfer v${rejectedVersion} was rejected by buyer.`,
          body: `Buyer ${activeDeal.buyerName} rejected Seller ${activeDeal.sellerName}'s Transfer Proof v${rejectedVersion} on Deal #${activeDeal.id.slice(0, 10)}. Reason: "${validation.cleanReason}".`,
          referenceLabel: `Deal · ${activeDeal.listingTitle}`,
        }),
      ]);

      setRejectionReason('');
      setShowRejectBox(false);
      onFlash('Transfer proof rejected. Seller and BEXORA Admin have been notified; escrow remains safely locked.');
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Could not record transfer rejection.'));
    } finally {
      setBusy(false);
    }
  };

  const handleAddReportEvidence = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const remaining = 3 - reportEvidence.length;
    if (remaining <= 0) {
      setErrMsg('Maximum 3 supporting evidence images per report.');
      return;
    }
    setProcessingReportImg(true);
    setErrMsg('');
    try {
      const processed: string[] = [];
      for (const f of files.slice(0, remaining)) {
        processed.push(await validateAndProcessImageFile(f));
      }
      setReportEvidence((prev) => [...prev, ...processed].slice(0, 3));
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : 'Could not process evidence screenshot.');
    } finally {
      setProcessingReportImg(false);
    }
  };

  // PART 7: Structured Issue Report -> Notifies Admin + Counterparty, Pauses Settlement Without Extending Deadline
  const handleFileReport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDeal) return;

    const check = validateDealReportInput({
      category: reportCategory,
      reason: reportReason,
      evidenceImages: reportEvidence,
    });
    if (!check.valid) {
      setErrMsg(check.error || 'Please complete the report form.');
      return;
    }

    setBusy(true);
    setErrMsg('');
    try {
      const reportRef = doc(collection(db, 'deals', activeDeal.id, 'reports'));
      const dealRefLabel = `Deal #${activeDeal.id} · ${activeDeal.listingTitle}`.slice(0, 140);

      await runTransaction(db, async (tx) => {
        const dealRef = doc(db, 'deals', activeDeal.id);
        const dSnap = await tx.get(dealRef);
        if (!dSnap.exists()) throw new Error('Deal not found.');
        const curCount = Number(dSnap.data()?.unresolvedReportCount) || 0;

        tx.set(reportRef, {
          dealId: activeDeal.id,
          dealReference: dealRefLabel,
          reporterId: userUid,
          reporterName: profile.displayName,
          reporterRole: isBuyer ? 'buyer' : 'seller',
          category: check.category,
          reason: check.cleanReason,
          evidenceImages: check.cleanEvidence,
          status: 'open',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        // Preserves confirmedAtMs and originalDeadlineMs strictly unchanged!
        tx.update(dealRef, {
          status: 'reported_under_review',
          unresolvedReportCount: curCount + 1,
          updatedAt: serverTimestamp(),
        });
      });

      const categoryLabel = getDealReportCategoryLabel(check.category);
      const counterpartyUid = isBuyer ? activeDeal.sellerId : activeDeal.buyerId;

      await Promise.all([
        appendDealAuditEvent({
          dealId: activeDeal.id,
          actorId: userUid,
          actorName: profile.displayName,
          actorRole: isBuyer ? 'buyer' : 'seller',
          eventType: 'deal_reported',
          summary: `${isBuyer ? 'Buyer' : 'Seller'} filed dispute report (${categoryLabel}). Escrow settlement paused pending BEXORA Admin review; original deadline unchanged.`,
        }),
        emitDealAdminNotification({
          dealId: activeDeal.id,
          eventKey: `admin_dispute_report_${reportRef.id}`,
          category: 'dispute',
          severity: 'critical',
          title: `Dispute Report: ${categoryLabel}`,
          preview: `${profile.displayName} (${isBuyer ? 'Buyer' : 'Seller'}) reported "${activeDeal.listingTitle}".`,
          body: `${profile.displayName} (${isBuyer ? 'Buyer' : 'Seller'}) submitted a dispute report on Deal #${activeDeal.id.slice(0, 10)} ("${activeDeal.listingTitle}"). Category: ${categoryLabel}. Reason: "${check.cleanReason}". Escrow payout release is paused awaiting your review.`,
          referenceLabel: `Dispute · ${activeDeal.listingTitle}`,
        }),
        emitUserNotification({
          recipientId: counterpartyUid,
          eventKey: `deal_report_counterparty_${reportRef.id}`,
          category: 'dispute',
          severity: 'warning',
          title: `Dispute Report Opened (${categoryLabel})`,
          preview: `A report was submitted for "${activeDeal.listingTitle}" — under admin review.`,
          body: `The ${isBuyer ? 'buyer' : 'seller'} submitted a formal report (${categoryLabel}) on "${activeDeal.listingTitle}" (Deal #${activeDeal.id.slice(0, 10)}). Escrow payout release is paused while BEXORA Administration reviews all evidence.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
        emitUserNotification({
          recipientId: userUid,
          eventKey: `deal_report_self_${reportRef.id}`,
          category: 'dispute',
          severity: 'info',
          title: 'Dispute Report Logged — Under Admin Review',
          preview: `Escrow settlement paused for "${activeDeal.listingTitle}" pending admin decision.`,
          body: `Your report (${categoryLabel}) on "${activeDeal.listingTitle}" (Deal #${activeDeal.id.slice(0, 10)}) has been delivered to BEXORA Administration. Settlement is paused while your evidence is reviewed.`,
          refType: 'deal',
          refId: activeDeal.id,
          referenceLabel: `Deal #${activeDeal.id.slice(0, 10)}`,
          destination: `deal:${activeDeal.id}`,
        }),
      ]);

      setReportReason('');
      setReportEvidence([]);
      setShowReportForm(false);
      onFlash('Report submitted to BEXORA Admin Review. Escrow settlement is paused; original deadline remains unchanged.');
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Failed to submit report.'));
    } finally {
      setBusy(false);
    }
  };

  const handleSendDealMessage = async () => {
    if (!activeDeal || !chatText.trim()) return;
    const safety = detectSensitiveOrOffPlatformContent(chatText);
    if (safety.blocked) {
      setErrMsg(safety.reason || 'Message blocked for safety.');
      return;
    }
    setBusy(true);
    setErrMsg('');
    try {
      await addDoc(collection(db, 'deals', activeDeal.id, 'messages'), {
        senderId: userUid,
        senderName: profile.displayName,
        senderRole: isBuyer ? 'buyer' : isSeller ? 'seller' : 'admin',
        kind: 'text',
        text: chatText.trim().slice(0, 1500),
        createdAt: serverTimestamp(),
      });
      setChatText('');
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Failed to send deal message.'));
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDeal || !isBuyer || activeDeal.status !== 'settled') return;
    if (reviewComment.trim().length < 3) {
      setErrMsg('Write a short honest review (at least 3 characters).');
      return;
    }
    setBusy(true);
    setErrMsg('');
    try {
      const revId = `rev_${activeDeal.id}`;
      await runTransaction(db, async (tx) => {
        const revRef = doc(db, 'reviews', revId);
        const sellerPubRef = doc(db, 'publicProfiles', activeDeal.sellerId);
        const [rSnap, sSnap] = await Promise.all([tx.get(revRef), tx.get(sellerPubRef)]);
        if (rSnap.exists()) {
          throw new Error('You have already submitted a verified review for this deal.');
        }

        tx.set(revRef, {
          dealId: activeDeal.id,
          sellerId: activeDeal.sellerId,
          reviewerId: userUid,
          reviewerName: profile.displayName,
          score: reviewScore,
          comment: reviewComment.trim().slice(0, 600),
          createdAt: serverTimestamp(),
        });

        if (sSnap.exists()) {
          const curSum = Number(sSnap.data()?.ratingSum) || 0;
          const curCount = Number(sSnap.data()?.ratingCount) || 0;
          tx.update(sellerPubRef, {
            ratingSum: curSum + reviewScore,
            ratingCount: curCount + 1,
            updatedAt: serverTimestamp(),
          });
        }
      });
      setReviewComment('');
      onFlash('Verified transaction review published!');
    } catch (err) {
      setErrMsg(extractUserFacingFirestoreError(err, 'Could not publish review.'));
    } finally {
      setBusy(false);
    }
  };

  const activeRefundBreakdown = activeDeal
    ? calculateDisputeRefundBreakdown(activeDeal)
    : null;

  return (
    <div className="bx-wrap py-6">
      <div className="mb-4">
        <p className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--orange)' }}>
          Protected 3-Party Escrow
        </p>
        <h1 className="text-2xl font-extrabold">Private Deal Rooms ({deals.length})</h1>
      </div>

      {deals.length === 0 ? (
        <div className="bx-card p-10 text-center space-y-2">
          <Clock className="w-10 h-10 mx-auto" style={{ color: 'var(--text-3)' }} />
          <h2 className="text-lg font-extrabold">No deals yet</h2>
          <p className="bx-hint">
            Accepted bids and wallet-funded purchases automatically open a private 3-Party Deal Room (Buyer · Seller · BEXORA Admin) here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5 items-start">
          {/* Deal Selector Sidebar */}
          <aside className="bx-card p-3 space-y-2">
            {deals.map((d) => {
              const selected = d.id === activeDeal?.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => {
                    setSelectedDealId(d.id);
                    setErrMsg('');
                    setShowRejectBox(false);
                    setShowReportForm(false);
                  }}
                  className="w-full p-3 rounded-xl text-left transition-colors space-y-1.5"
                  style={{
                    background: selected ? 'var(--surface-2)' : 'transparent',
                    border: selected ? '1.5px solid var(--border-strong)' : '1.5px solid transparent',
                  }}
                >
                  <div className="font-extrabold text-sm truncate">{d.listingTitle}</div>
                  <div className="flex items-center justify-between text-xs tabular-nums gap-2">
                    <span className="font-bold shrink-0">
                      {formatMoneyFromMinor(d.buyerTotalMinor, displayCurrency, d.currency, settings.usdToBdtRate)}
                    </span>
                    <span className="font-bold truncate" style={{ color: 'var(--orange)' }}>
                      {getDealStatusLabel(d.status)}
                    </span>
                  </div>
                </button>
              );
            })}
          </aside>

          {/* 3-Party Deal Room Main View */}
          {activeDeal && (
            <section className="bx-card p-5 sm:p-6 space-y-6">
              {/* Header & 3-Party Participants */}
              <div className="flex flex-wrap items-start justify-between gap-3 pb-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
                    <span className="font-mono">Ref #{activeDeal.id}</span>
                    <span aria-hidden="true">·</span>
                    <span>{PLATFORM_CATALOG[activeDeal.platform]?.name || activeDeal.platform}</span>
                    <span aria-hidden="true">·</span>
                    <span>Private 3-Party Room</span>
                  </div>
                  <h2 className="text-lg sm:text-xl font-extrabold">{activeDeal.listingTitle}</h2>
                  <p className="bx-hint">
                    Buyer: <strong>{activeDeal.buyerName}</strong> {isBuyer ? '(You)' : ''} · Seller:{' '}
                    <strong>{activeDeal.sellerName}</strong> {isSeller ? '(You)' : ''} · Oversight:{' '}
                    <strong>BEXORA Admin</strong>
                  </p>
                </div>
                <div className="text-right">
                  <span className="inline-block text-xs font-extrabold px-3 py-1.5 rounded-lg bx-soft">
                    {getDealStatusLabel(activeDeal.status)}
                  </span>
                </div>
              </div>

              {errMsg && (
                <div
                  className="p-3.5 rounded-xl text-xs font-bold"
                  style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
                  role="alert"
                >
                  {errMsg}
                </div>
              )}

              {/* Locked Financial Breakdown & Refund Policy Card */}
              <div className="space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs tabular-nums">
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="block" style={{ color: 'var(--text-2)' }}>
                      {activeDeal.acceptedBidId ? 'Accepted Bid Price' : 'Agreed Asset Price'}
                    </span>
                    <strong className="text-sm font-extrabold">
                      {formatMoneyFromMinor(activeDeal.baseAmountMinor, displayCurrency, activeDeal.currency, settings.usdToBdtRate)}
                    </strong>
                    {activeDeal.originalListingPriceMinor &&
                      activeDeal.originalListingPriceMinor !== activeDeal.baseAmountMinor && (
                        <span className="block text-[11px] line-through opacity-65 mt-0.5">
                          Listed:{' '}
                          {formatMoneyFromMinor(
                            activeDeal.originalListingPriceMinor,
                            displayCurrency,
                            activeDeal.currency,
                            settings.usdToBdtRate
                          )}
                        </span>
                      )}
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="block" style={{ color: 'var(--text-2)' }}>
                      Buyer Total (+{activeDeal.buyerFeePct}% Fee)
                    </span>
                    <strong className="text-sm font-extrabold">
                      {formatMoneyFromMinor(activeDeal.buyerTotalMinor, displayCurrency, activeDeal.currency, settings.usdToBdtRate)}
                    </strong>
                    <span className="block text-[11px] opacity-75 mt-0.5">
                      Fee:{' '}
                      {formatMoneyFromMinor(
                        activeDeal.buyerFeeMinor,
                        displayCurrency,
                        activeDeal.currency,
                        settings.usdToBdtRate
                      )}
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="block" style={{ color: 'var(--text-2)' }}>
                      Seller Net Payout
                    </span>
                    <strong className="text-sm font-extrabold">
                      {formatMoneyFromMinor(activeDeal.sellerPayoutMinor, displayCurrency, activeDeal.currency, settings.usdToBdtRate)}
                    </strong>
                    <span className="block text-[11px] opacity-75 mt-0.5">
                      Released after security timer
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bx-soft">
                    <span className="block" style={{ color: 'var(--text-2)' }}>
                      Security Countdown
                    </span>
                    <strong className="text-sm font-extrabold">
                      {activeDeal.platform === 'youtube'
                        ? `7 Days (${activeDeal.protectionDurationHours}h)`
                        : `${activeDeal.protectionDurationHours} Hours`}
                    </strong>
                    <span className="block text-[11px] opacity-75 mt-0.5">
                      Starts on Buyer Approval
                    </span>
                  </div>
                </div>

                {/* Transparent Ledger & Dispute Refund Policy Line */}
                {activeRefundBreakdown && (
                  <div className="p-3 rounded-xl bx-soft flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums">
                    <span style={{ color: 'var(--text-2)' }}>
                      Admin Dispute Rejection Policy: Buyer receives{' '}
                      <strong>
                        {formatMoneyFromMinor(
                          activeRefundBreakdown.buyerRefundMinor,
                          displayCurrency,
                          activeDeal.currency,
                          settings.usdToBdtRate
                        )}
                      </strong>{' '}
                      (100% asset price + 2% fee return) · Platform retains{' '}
                      <strong>
                        {formatMoneyFromMinor(
                          activeRefundBreakdown.platformRetainedCommissionMinor,
                          displayCurrency,
                          activeDeal.currency,
                          settings.usdToBdtRate
                        )}
                      </strong>{' '}
                      (3% service commission).
                    </span>
                    {activeDeal.paymentLedgerId && (
                      <span className="font-mono text-[11px] opacity-75">
                        Ledger: {activeDeal.paymentLedgerId}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* STAGE 1: UNPAID ACCEPTED BID — EXACT WALLET PAYMENT */}
              {isDealUnpaidStatus(activeDeal.status) && (
                <div className="p-4 sm:p-5 rounded-xl border space-y-4" style={{ borderColor: 'var(--orange)', background: 'var(--surface)' }}>
                  <div className="flex items-start gap-3">
                    <Lock className="w-5 h-5 shrink-0 mt-0.5" style={{ color: 'var(--orange)' }} />
                    <div className="space-y-1">
                      <h3 className="text-sm font-extrabold">
                        {isBuyer
                          ? 'Complete Exact Accepted-Bid Escrow Payment'
                          : 'Awaiting Buyer Wallet Escrow Payment'}
                      </h3>
                      <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
                        {isBuyer
                          ? `Your accepted bid of ${formatMoneyFromMinor(
                              activeDeal.baseAmountMinor,
                              displayCurrency,
                              activeDeal.currency,
                              settings.usdToBdtRate
                            )} plus ${activeDeal.buyerFeePct}% buyer fee (${formatMoneyFromMinor(
                              activeDeal.buyerFeeMinor,
                              displayCurrency,
                              activeDeal.currency,
                              settings.usdToBdtRate
                            )}) equals ${formatMoneyFromMinor(
                              activeDeal.buyerTotalMinor,
                              displayCurrency,
                              activeDeal.currency,
                              settings.usdToBdtRate
                            )} total payable. Your current wallet balance is ${formatMoneyFromMinor(
                              privateUser?.walletBalanceMinor || 0,
                              displayCurrency,
                              'BDT',
                              settings.usdToBdtRate
                            )}.`
                          : 'Do NOT transfer credentials or admin access yet. Wait until this Deal Room updates to "Paid — Deal Room Active" confirming BEXORA Escrow holds the buyer funds.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5">
                    {isBuyer && (
                      <>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={handlePayAcceptedDeal}
                          className="bx-btn bx-btn-yellow"
                        >
                          <Wallet className="w-4 h-4" />
                          <span>
                            {busy
                              ? 'Locking Funds in Escrow…'
                              : `Pay Exact Total (${formatMoneyFromMinor(
                                  activeDeal.buyerTotalMinor,
                                  displayCurrency,
                                  activeDeal.currency,
                                  settings.usdToBdtRate
                                )})`}
                          </span>
                        </button>
                        {(privateUser?.walletBalanceMinor || 0) < activeDeal.buyerTotalMinor && (
                          <button
                            type="button"
                            onClick={onOpenWallet}
                            className="bx-btn bx-btn-primary bx-btn-sm"
                          >
                            Deposit Funds to Wallet
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={handleCancelUnpaidDeal}
                      className="bx-btn bx-btn-danger bx-btn-sm"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Cancel Unpaid Reservation &amp; Restore Listing</span>
                    </button>
                  </div>
                </div>
              )}

              {/* STAGE 2: FUNDED — SELLER ASSET TRANSFER BOX (SELLER ONLY) OR WAITING NOTICE (BUYER) */}
              {isDealAwaitingSellerTransferStatus(activeDeal.status) && (
                <>
                  {isSeller ? (
                    <SellerAssetTransferBox
                      deal={activeDeal}
                      busy={busy}
                      onSubmitTransfer={handleSellerSubmitTransfer}
                    />
                  ) : (
                    <div className="p-4 rounded-xl bx-soft space-y-2">
                      <div className="flex items-center gap-2 text-sm font-extrabold">
                        <ShieldCheck className="w-4 h-4" style={{ color: 'var(--green)' }} />
                        <span>
                          {activeDeal.status === 'transfer_rejected'
                            ? 'Transfer Rejected — Waiting for Seller to Resubmit Updated Proof'
                            : 'Escrow Funded — Waiting for Seller Asset Transfer Proof'}
                        </span>
                      </div>
                      <p className="bx-hint">
                        Your payment is safely locked in BEXORA Escrow. Coordinate handover details in the 3-Party Deal Chat below while <strong>{activeDeal.sellerName}</strong> completes the transfer and uploads 2–3 verification screenshots. The security timer will NOT start until you inspect and approve the transfer.
                      </p>
                      {activeDeal.status === 'transfer_rejected' && activeDeal.latestRejectionReason && (
                        <p className="text-xs font-semibold pt-1" style={{ color: 'var(--orange)' }}>
                          Your recorded rejection reason: &ldquo;{activeDeal.latestRejectionReason}&rdquo;
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* PLATFORM TRANSFER INSTRUCTIONS SUMMARY */}
              {!isDealUnpaidStatus(activeDeal.status) && !isDealTerminalStatus(activeDeal.status) && (
                <div className="p-4 rounded-xl bx-soft space-y-2">
                  <div className="text-xs font-extrabold uppercase tracking-wide" style={{ color: 'var(--text-2)' }}>
                    Required {PLATFORM_CATALOG[activeDeal.platform]?.name || activeDeal.platform} Handover Protocol
                  </div>
                  <ul className="space-y-1 text-xs" style={{ color: 'var(--text-2)' }}>
                    {getPlatformTransferChecklist(activeDeal.platform).map((step, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <span className="font-mono font-bold shrink-0">0{i + 1}.</span>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* TRANSFER PROOF HISTORY & BUYER APPROVE / REJECT PANEL */}
              {(transfers.length > 0 || isDealTransferSubmittedStatus(activeDeal.status)) && (
                <div className="space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-extrabold flex items-center gap-2">
                      <FileCheck2 className="w-4 h-4" style={{ color: 'var(--green)' }} />
                      <span>Seller Transfer Proof Submissions ({transfers.length})</span>
                    </h3>
                    <span className="bx-hint">Click any screenshot to inspect full-size</span>
                  </div>

                  {transfers.map((sub, subIdx) => {
                    const isLatest = subIdx === 0;
                    const galleryItems: LightboxImageItem[] = sub.screenshots.map((src, idx) => ({
                      src,
                      caption: `Transfer Submission v${sub.version} · Screenshot #${idx + 1} by ${sub.sellerName}`,
                    }));

                    return (
                      <div
                        key={sub.id}
                        className="p-4 rounded-xl border space-y-3"
                        style={{
                          background: 'var(--surface)',
                          borderColor: isLatest ? 'var(--border-strong)' : 'var(--border-soft)',
                        }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="font-extrabold">
                            Submission v{sub.version} by {sub.sellerName} ·{' '}
                            <span className="font-normal opacity-75">
                              {new Date(sub.createdAtMs).toLocaleString()}
                            </span>
                          </div>
                          <span
                            className="font-extrabold uppercase"
                            style={{
                              color:
                                sub.status === 'approved'
                                  ? 'var(--green)'
                                  : sub.status === 'rejected'
                                  ? 'var(--red)'
                                  : 'var(--orange)',
                            }}
                          >
                            {sub.status}
                          </span>
                        </div>

                        {sub.screenshots.length > 0 && (
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                            {sub.screenshots.map((src, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() =>
                                  openLightbox(
                                    galleryItems,
                                    idx,
                                    `Transfer Proof v${sub.version} · ${activeDeal.listingTitle}`
                                  )
                                }
                                aria-label={`Enlarge transfer v${sub.version} screenshot ${idx + 1}`}
                                className="group relative h-32 overflow-hidden rounded-lg border text-left"
                                style={{ borderColor: 'var(--border-soft)' }}
                              >
                                <img
                                  src={src}
                                  alt={`Transfer v${sub.version} proof ${idx + 1}`}
                                  referrerPolicy="no-referrer"
                                  className="h-full w-full object-cover transition-transform duration-150 group-hover:scale-[1.03]"
                                />
                                <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded bg-black/75 px-2 py-0.5 text-[10px] font-bold text-white">
                                  <ZoomIn className="w-3 h-3" />
                                  Enlarge
                                </span>
                              </button>
                            ))}
                          </div>
                        )}

                        <div className="text-xs space-y-1.5">
                          <div className="font-bold">Seller Handover Note:</div>
                          <p className="whitespace-pre-line leading-relaxed" style={{ color: 'var(--text-2)' }}>
                            {sub.transferNote}
                          </p>
                        </div>

                        {sub.completedSteps.length > 0 && (
                          <div className="text-xs space-y-1">
                            <div className="font-bold">Confirmed Checklist Steps:</div>
                            <ul className="space-y-0.5" style={{ color: 'var(--text-2)' }}>
                              {sub.completedSteps.map((st, idx) => (
                                <li key={idx}>✓ {st}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {sub.status === 'rejected' && sub.buyerDecisionReason && (
                          <div className="p-2.5 rounded-lg text-xs" style={{ background: 'var(--red-soft)', color: 'var(--red)' }}>
                            <strong>Buyer Rejection Reason:</strong> {sub.buyerDecisionReason}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {/* Buyer Decision Controls */}
                  {isDealTransferSubmittedStatus(activeDeal.status) && (
                    <div className="p-4 rounded-xl bx-soft space-y-3">
                      {isBuyer ? (
                        <>
                          <div className="space-y-1">
                            <div className="text-sm font-extrabold">
                              Verify Access Before Approving Transfer
                            </div>
                            <p className="bx-hint">
                              Inspect the screenshots above and confirm you have received ownership/admin access on{' '}
                              <strong>{PLATFORM_CATALOG[activeDeal.platform]?.name || activeDeal.platform}</strong>. Approving starts the immutable{' '}
                              <strong>
                                {activeDeal.platform === 'youtube'
                                  ? `7-day (${activeDeal.protectionDurationHours}h)`
                                  : `${activeDeal.protectionDurationHours}-hour`}
                              </strong>{' '}
                              security timer. If access is missing or inaccurate, reject with a clear reason.
                            </p>
                          </div>

                          <div className="flex flex-wrap items-center gap-2.5">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={handleBuyerApproveTransfer}
                              className="bx-btn bx-btn-primary"
                            >
                              <CheckCircle2 className="w-4 h-4" />
                              <span>
                                {busy
                                  ? 'Starting Security Timer…'
                                  : `Approve Transfer & Start ${activeDeal.protectionDurationHours}h Security Timer`}
                              </span>
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setShowRejectBox((v) => !v)}
                              className="bx-btn bx-btn-danger"
                            >
                              <XCircle className="w-4 h-4" />
                              <span>Reject Transfer Proof</span>
                            </button>
                          </div>

                          {showRejectBox && (
                            <form onSubmit={handleBuyerRejectTransfer} className="pt-2 space-y-2.5">
                              <label htmlFor="buyer-reject-reason" className="bx-label">
                                Reason for Rejecting Transfer Proof (Required — sent to Seller &amp; Admin)
                              </label>
                              <textarea
                                id="buyer-reject-reason"
                                rows={3}
                                value={rejectionReason}
                                onChange={(e) => setRejectionReason(e.target.value)}
                                placeholder="Explain clearly what access is missing, invalid, or mismatched…"
                                className="bx-textarea"
                              />
                              <div className="flex items-center gap-2">
                                <button type="submit" disabled={busy} className="bx-btn bx-btn-danger bx-btn-sm">
                                  Confirm Transfer Rejection
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setShowRejectBox(false)}
                                  className="bx-btn bx-btn-sm"
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          )}
                        </>
                      ) : (
                        <p className="text-xs font-semibold" style={{ color: 'var(--text-2)' }}>
                          Transfer proof submitted — waiting for <strong>{activeDeal.buyerName}</strong> to inspect screenshots and click Approve Transfer (or Reject with reason).
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* SECURITY PROTECTION COUNTDOWN */}
              {activeDeal.originalDeadlineMs > 0 && (
                <ProtectionCountdown
                  originalDeadlineMs={activeDeal.originalDeadlineMs}
                  pausedForReview={activeDeal.status === 'reported_under_review'}
                  unresolvedReportCount={activeDeal.unresolvedReportCount}
                />
              )}

              {/* TERMINAL SETTLEMENT OR REFUND OUTCOME SUMMARY */}
              {activeDeal.status === 'settled' && (
                <div className="p-4 rounded-xl border space-y-1 text-xs" style={{ borderColor: 'var(--green)', background: 'var(--surface)' }}>
                  <div className="font-extrabold text-sm" style={{ color: 'var(--green)' }}>
                    Deal Completed — Seller Payout Released
                  </div>
                  <p style={{ color: 'var(--text-2)' }}>
                    Net seller payout of{' '}
                    <strong>
                      {formatMoneyFromMinor(
                        activeDeal.sellerPayoutMinor,
                        displayCurrency,
                        activeDeal.currency,
                        settings.usdToBdtRate
                      )}
                    </strong>{' '}
                    was released to {activeDeal.sellerName}&apos;s wallet
                    {activeDeal.settlementLedgerId ? ` (Ledger ${activeDeal.settlementLedgerId})` : ''}.
                  </p>
                  {activeDeal.adminHoldNote && (
                    <p className="pt-1 font-medium">Admin Note: {activeDeal.adminHoldNote}</p>
                  )}
                </div>
              )}

              {activeDeal.status === 'refunded' && (
                <div className="p-4 rounded-xl border space-y-1 text-xs" style={{ borderColor: 'var(--orange)', background: 'var(--surface)' }}>
                  <div className="font-extrabold text-sm" style={{ color: 'var(--orange)' }}>
                    Deal Rejected by Admin — Buyer Refunded Under 102% / 3% Policy
                  </div>
                  <p style={{ color: 'var(--text-2)' }}>
                    Buyer refunded{' '}
                    <strong>
                      {formatMoneyFromMinor(
                        activeDeal.refundBuyerMinor ?? activeRefundBreakdown?.buyerRefundMinor ?? 0,
                        displayCurrency,
                        activeDeal.currency,
                        settings.usdToBdtRate
                      )}
                    </strong>{' '}
                    to wallet · Platform retained{' '}
                    <strong>
                      {formatMoneyFromMinor(
                        activeDeal.refundPlatformRetainedMinor ??
                          activeRefundBreakdown?.platformRetainedCommissionMinor ??
                          0,
                        displayCurrency,
                        activeDeal.currency,
                        settings.usdToBdtRate
                      )}
                    </strong>{' '}
                    commission
                    {activeDeal.refundLedgerId ? ` · Ledger ${activeDeal.refundLedgerId}` : ''}.
                  </p>
                  {activeDeal.adminHoldNote && (
                    <p className="pt-1 font-medium">Admin Decision Note: {activeDeal.adminHoldNote}</p>
                  )}
                </div>
              )}

              {/* PART 7: STRUCTURED ISSUE REPORTING */}
              {isDealReportableStatus(activeDeal.status) && (
                <div className="space-y-3">
                  {!showReportForm ? (
                    <button
                      type="button"
                      onClick={() => setShowReportForm(true)}
                      className="bx-btn bx-btn-danger bx-btn-sm"
                    >
                      <AlertTriangle className="w-4 h-4" />
                      <span>Report Issue / Request Admin Intervention (Pauses Payout Release)</span>
                    </button>
                  ) : (
                    <form onSubmit={handleFileReport} className="p-4 rounded-xl bx-soft space-y-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-sm font-extrabold">Submit Formal Dispute Report to BEXORA Admin</h3>
                        <span className="font-mono text-[11px] opacity-75">Ref #{activeDeal.id.slice(0, 12)}</span>
                      </div>

                      <div className="space-y-1">
                        <label htmlFor="deal-report-category" className="bx-label">
                          Issue Category
                        </label>
                        <select
                          id="deal-report-category"
                          value={reportCategory}
                          onChange={(e) => setReportCategory(e.target.value as DealReportCategory)}
                          className="bx-select"
                        >
                          {DEAL_REPORT_CATEGORIES.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="space-y-1">
                        <label htmlFor="deal-report-reason" className="bx-label">
                          Detailed Explanation (10–1,500 characters)
                        </label>
                        <textarea
                          id="deal-report-reason"
                          rows={3}
                          value={reportReason}
                          onChange={(e) => setReportReason(e.target.value)}
                          placeholder="Describe the exact ownership, access, or recovery issue so BEXORA Administration can verify…"
                          className="bx-textarea"
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-bold">
                            Optional Evidence Screenshots ({reportEvidence.length}/3)
                          </span>
                          {reportEvidence.length < 3 && (
                            <button
                              type="button"
                              disabled={busy || processingReportImg}
                              onClick={() => reportFileInputRef.current?.click()}
                              className="bx-btn bx-btn-sm"
                            >
                              <ImagePlus className="w-3.5 h-3.5" />
                              <span>{processingReportImg ? 'Processing…' : 'Attach Screenshot'}</span>
                            </button>
                          )}
                        </div>
                        <input
                          ref={reportFileInputRef}
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          multiple
                          onChange={handleAddReportEvidence}
                          className="hidden"
                        />
                        {reportEvidence.length > 0 && (
                          <div className="grid grid-cols-3 gap-2">
                            {reportEvidence.map((img, idx) => (
                              <div key={idx} className="relative rounded-lg overflow-hidden border" style={{ borderColor: 'var(--border-soft)' }}>
                                <img src={img} alt={`Report evidence ${idx + 1}`} className="h-24 w-full object-cover" />
                                <button
                                  type="button"
                                  onClick={() => setReportEvidence((prev) => prev.filter((_, i) => i !== idx))}
                                  aria-label={`Remove report screenshot ${idx + 1}`}
                                  className="absolute top-1 right-1 rounded bg-black/75 p-1 text-white"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2 pt-1">
                        <button type="submit" disabled={busy || processingReportImg} className="bx-btn bx-btn-danger bx-btn-sm">
                          Submit Report &amp; Notify Admin
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowReportForm(false)}
                          className="bx-btn bx-btn-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {/* SUBMITTED DISPUTE REPORTS */}
              {reports.length > 0 && (
                <div className="space-y-2">
                  <h3 className="text-xs font-extrabold uppercase" style={{ color: 'var(--red)' }}>
                    Dispute &amp; Issue Reports ({reports.length})
                  </h3>
                  {reports.map((r) => {
                    const evItems: LightboxImageItem[] = (r.evidenceImages || []).map((src, i) => ({
                      src,
                      caption: `Report Evidence #${i + 1} · ${getDealReportCategoryLabel(r.category)}`,
                    }));
                    return (
                      <div
                        key={r.id}
                        className="p-3.5 rounded-xl text-xs space-y-2"
                        style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 font-extrabold">
                          <span>
                            {r.reporterRole.toUpperCase()} Report · {getDealReportCategoryLabel(r.category)}
                          </span>
                          <span>{r.status.replace(/_/g, ' ').toUpperCase()}</span>
                        </div>
                        <p className="whitespace-pre-line">{r.reason}</p>
                        {evItems.length > 0 && (
                          <div className="flex flex-wrap gap-2 pt-1">
                            {evItems.map((ev, idx) => (
                              <button
                                key={idx}
                                type="button"
                                onClick={() => openLightbox(evItems, idx, 'Dispute Report Evidence')}
                                className="h-16 w-24 overflow-hidden rounded border border-red-300"
                              >
                                <img src={ev.src} alt={ev.caption} className="h-full w-full object-cover" />
                              </button>
                            ))}
                          </div>
                        )}
                        {r.adminDecisionNote && (
                          <p className="font-bold pt-1">BEXORA Admin Response: {r.adminDecisionNote}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* VERIFIED REVIEW FORM AFTER SETTLED DEAL */}
              {activeDeal.status === 'settled' && isBuyer && (
                <form onSubmit={handleSubmitReview} className="p-4 rounded-xl bx-soft space-y-3">
                  <h3 className="text-sm font-extrabold flex items-center gap-1.5">
                    <Star className="w-4 h-4" style={{ color: 'var(--orange)' }} />
                    <span>Rate Seller for Completed Deal</span>
                  </h3>
                  <div className="flex items-center gap-2">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setReviewScore(n)}
                        className="px-3 py-1.5 rounded-lg text-xs font-extrabold border"
                        style={{
                          background: reviewScore >= n ? 'var(--yellow)' : 'var(--surface)',
                          color: reviewScore >= n ? '#191919' : 'var(--text-2)',
                          borderColor: 'var(--border-soft)',
                        }}
                      >
                        {n} ★
                      </button>
                    ))}
                  </div>
                  <input
                    type="text"
                    value={reviewComment}
                    onChange={(e) => setReviewComment(e.target.value)}
                    placeholder="Share your experience with this transaction…"
                    className="bx-input"
                  />
                  <button type="submit" disabled={busy} className="bx-btn bx-btn-primary bx-btn-sm">
                    Publish Verified Review
                  </button>
                </form>
              )}

              {/* 3-PARTY DEAL ROOM MESSAGES */}
              <div className="space-y-2.5 pt-3 border-t" style={{ borderColor: 'var(--border-soft)' }}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-extrabold">3-Party Deal Room Chat</h3>
                  <span className="bx-hint">Visible only to Buyer, Seller &amp; BEXORA Admin</span>
                </div>
                <div className="max-h-64 overflow-y-auto space-y-2 p-2.5 rounded-xl bx-soft">
                  {messages.length === 0 ? (
                    <p className="bx-hint text-center py-4">
                      No messages yet. Coordinate handover safely inside this audited room.
                    </p>
                  ) : (
                    messages.map((m) => {
                      const mine = m.senderId === userUid;
                      const isAdminMsg = m.senderRole === 'admin';
                      return (
                        <div
                          key={m.id}
                          className={`max-w-[85%] p-2.5 rounded-xl text-xs ${mine ? 'ml-auto' : 'mr-auto'}`}
                          style={{
                            background: isAdminMsg
                              ? 'var(--purple)'
                              : mine
                              ? 'var(--orange)'
                              : 'var(--surface)',
                            color: isAdminMsg || mine ? '#FFFFFF' : 'var(--text)',
                          }}
                        >
                          <div className="font-extrabold opacity-85 mb-0.5">
                            {m.senderName}
                            {m.senderRole ? ` · ${m.senderRole.toUpperCase()}` : ''}
                          </div>
                          <div className="whitespace-pre-line">{m.text}</div>
                        </div>
                      );
                    })
                  )}
                </div>

                {!isDealTerminalStatus(activeDeal.status) && (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={chatText}
                      onChange={(e) => setChatText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && chatText.trim()) {
                          e.preventDefault();
                          handleSendDealMessage();
                        }
                      }}
                      placeholder="Coordinate asset transfer safely (passwords & external links blocked)…"
                      className="bx-input flex-1"
                    />
                    <button
                      type="button"
                      disabled={!chatText.trim() || busy}
                      onClick={handleSendDealMessage}
                      className="bx-btn bx-btn-primary"
                      aria-label="Send deal message"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {/* CHRONOLOGICAL AUDIT TIMELINE */}
              {auditEvents.length > 0 && (
                <div className="space-y-2 pt-3 border-t" style={{ borderColor: 'var(--border-soft)' }}>
                  <h3 className="text-xs font-extrabold uppercase tracking-wider" style={{ color: 'var(--text-2)' }}>
                    Immutable Deal Audit Log ({auditEvents.length})
                  </h3>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto text-xs">
                    {auditEvents.map((ev) => (
                      <div key={ev.id} className="p-2.5 rounded-lg bx-soft flex flex-wrap items-baseline justify-between gap-2">
                        <div>
                          <span className="font-extrabold">
                            [{ev.actorRole.toUpperCase()}] {ev.actorName}:
                          </span>{' '}
                          <span style={{ color: 'var(--text-2)' }}>{ev.summary}</span>
                        </div>
                        <span className="font-mono text-[11px] opacity-70 shrink-0">
                          {new Date(ev.createdAtMs).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      )}

      <ImageLightboxModal
        images={lightboxItems}
        activeIndex={lightboxIndex}
        title={lightboxTitle}
        onClose={() => setLightboxIndex(null)}
        onChangeIndex={setLightboxIndex}
      />
    </div>
  );
};
