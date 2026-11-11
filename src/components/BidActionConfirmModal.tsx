import React, { useEffect, useRef, useState } from 'react';
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { AlertTriangle, Loader2, RotateCcw, X, XCircle } from 'lucide-react';
import type { BidRecord, CurrencyCode } from '../types';
import { auth, db, extractUserFacingFirestoreError } from '../lib/firebase';
import {
  BUYER_WITHDRAW_BID_COPY,
  SELLER_REJECT_BID_COPY,
} from '../lib/listingAndBidManagementLogic';
import { formatMoneyFromMinor } from '../lib/marketplaceLogic';
import { emitUserNotification } from '../lib/notificationService';

interface BidActionConfirmModalProps {
  mode: 'withdraw' | 'reject';
  bid: BidRecord | null;
  listingTitle: string;
  sellerId?: string;
  displayCurrency: CurrencyCode;
  usdToBdtRate: number;
  onClose: () => void;
  onCompleted: (bidId: string, nextStatus: 'withdrawn' | 'rejected', bannerMessage: string) => void;
}

export const BidActionConfirmModal: React.FC<BidActionConfirmModalProps> = ({
  mode,
  bid,
  listingTitle,
  sellerId,
  displayCurrency,
  usdToBdtRate,
  onClose,
  onCompleted,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const busyRef = useRef(false);

  useEffect(() => {
    setErrorMsg('');
    setSubmitting(false);
    busyRef.current = false;
  }, [bid?.id, mode]);

  useEffect(() => {
    if (!bid) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [bid, onClose]);

  if (!bid) return null;

  const copy = mode === 'withdraw' ? BUYER_WITHDRAW_BID_COPY : SELLER_REJECT_BID_COPY;
  const formattedOffer = formatMoneyFromMinor(
    bid.amountMinor,
    displayCurrency,
    bid.currency,
    usdToBdtRate
  );

  const handleConfirm = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setSubmitting(true);
    setErrorMsg('');

    try {
      const currentUid = auth.currentUser?.uid || '';
      if (!currentUid) {
        throw new Error('Please sign in again to complete this bid action.');
      }

      let completedOnServer = false;
      const idToken = await auth.currentUser?.getIdToken().catch(() => '');
      if (idToken) {
        try {
          const endpoint =
            mode === 'withdraw'
              ? `/api/bids/${encodeURIComponent(bid.id)}/withdraw`
              : `/api/bids/${encodeURIComponent(bid.id)}/reject`;
          const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({}),
          });
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const payload = (await resp.json()) as { ok?: boolean; error?: string; message?: string };
            if (resp.ok && payload.ok) {
              completedOnServer = true;
            } else if (resp.status === 403 || resp.status === 409 || resp.status === 404) {
              throw new Error(payload.error || 'This bid can no longer be modified.');
            }
          }
        } catch (err) {
          if (
            err instanceof Error &&
            (err.message.includes('no longer') ||
              err.message.includes('Only ') ||
              err.message.includes('authorized'))
          ) {
            throw err;
          }
          // Otherwise fall through to atomic client Firestore transaction
        }
      }

      if (!completedOnServer) {
        const bidRef = doc(db, 'bids', bid.id);
        await runTransaction(db, async (tx) => {
          const bSnap = await tx.get(bidRef);
          if (!bSnap.exists()) {
            throw new Error('Bid record not found.');
          }
          const bData = bSnap.data();
          if (bData.status !== 'pending' || bData.dealId) {
            throw new Error(
              'Only active pending bids that are not tied to an accepted deal can be updated.'
            );
          }
          if (mode === 'withdraw') {
            if (bData.buyerId !== currentUid) {
              throw new Error('You can only withdraw your own bid.');
            }
            tx.update(bidRef, {
              status: 'withdrawn',
              updatedAt: serverTimestamp(),
            });
          } else {
            const resolvedSellerId = String(bData.sellerId || sellerId || '');
            if (resolvedSellerId !== currentUid) {
              throw new Error('Only the verified listing owner can reject bids on this listing.');
            }
            tx.update(bidRef, {
              status: 'rejected',
              updatedAt: serverTimestamp(),
            });
          }
        });

        const exactOfferFmt = formatMoneyFromMinor(bid.amountMinor, bid.currency, bid.currency);
        if (mode === 'withdraw') {
          await Promise.all([
            emitUserNotification({
              recipientId: currentUid,
              eventKey: `bid_withdrawn_buyer_${bid.id}`,
              category: 'bid',
              severity: 'info',
              title: 'Bid Withdrawn',
              preview: `Your ${exactOfferFmt} bid on "${listingTitle}" was withdrawn.`,
              body: `You withdrew your pending offer of ${exactOfferFmt} on "${listingTitle}". It is no longer counted as an active bid.`,
              refType: 'listing',
              refId: bid.listingId,
              referenceLabel: listingTitle.slice(0, 80),
              destination: `listing:${bid.listingId}`,
            }).catch(() => {}),
            bid.sellerId
              ? emitUserNotification({
                  recipientId: bid.sellerId,
                  eventKey: `bid_withdrawn_seller_${bid.id}`,
                  category: 'bid',
                  severity: 'info',
                  title: 'Buyer Withdrew a Pending Bid',
                  preview: `${bid.buyerName} withdrew their ${exactOfferFmt} bid on "${listingTitle}".`,
                  body: `${bid.buyerName} (@${bid.buyerUsername}) withdrew their pending ${exactOfferFmt} offer on "${listingTitle}".`,
                  refType: 'listing',
                  refId: bid.listingId,
                  referenceLabel: listingTitle.slice(0, 80),
                  destination: `listing:${bid.listingId}`,
                }).catch(() => {})
              : Promise.resolve(),
          ]);
        } else {
          await emitUserNotification({
            recipientId: bid.buyerId,
            eventKey: `bid_rejected_buyer_${bid.id}`,
            category: 'bid',
            severity: 'warning',
            alertKind: 'important',
            title: SELLER_REJECT_BID_COPY.buyerNotificationTitle,
            preview: `${SELLER_REJECT_BID_COPY.buyerNotificationBody} (${exactOfferFmt} on "${listingTitle}")`,
            body: `${SELLER_REJECT_BID_COPY.buyerNotificationBody} Asset: "${listingTitle}" · Offer: ${exactOfferFmt}. If the listing remains active, you may submit a new offer anytime.`,
            refType: 'listing',
            refId: bid.listingId,
            referenceLabel: listingTitle.slice(0, 80),
            destination: `listing:${bid.listingId}`,
          }).catch(() => {});
        }
      }

      onCompleted(
        bid.id,
        mode === 'withdraw' ? 'withdrawn' : 'rejected',
        copy.successBanner
      );
    } catch (err) {
      setErrorMsg(
        extractUserFacingFirestoreError(
          err,
          mode === 'withdraw' ? 'Could not withdraw bid.' : 'Could not reject bid.'
        )
      );
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bx-bid-action-modal-title"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div
        className="bx-card w-full max-w-md p-5 sm:p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className="w-10 h-10 rounded-xl grid place-items-center shrink-0"
              style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
            >
              <AlertTriangle className="w-5 h-5" />
            </div>
            <h2
              id="bx-bid-action-modal-title"
              className="text-base sm:text-lg font-black tracking-tight"
            >
              {copy.title}
            </h2>
          </div>

          {!submitting && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close bid confirmation dialog"
              className="bx-btn bx-btn-sm !p-2"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Offer Summary Strip */}
        <div
          className="rounded-xl border p-3 space-y-1 text-xs"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border-soft)' }}
        >
          <div className="font-extrabold truncate">{listingTitle}</div>
          <div className="flex items-center justify-between gap-2 font-bold tabular-nums">
            <span style={{ color: 'var(--text-2)' }}>
              {mode === 'withdraw' ? 'Your Pending Offer:' : `Bidder: ${bid.buyerName} (@${bid.buyerUsername})`}
            </span>
            <span className="text-sm font-black" style={{ color: 'var(--orange)' }}>
              {formattedOffer}
            </span>
          </div>
        </div>

        <p
          className="text-xs sm:text-sm font-semibold leading-relaxed whitespace-pre-line"
          style={{ color: 'var(--text-2)' }}
        >
          {copy.message}
        </p>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl p-3 text-xs font-bold"
            style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
          >
            {errorMsg}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2.5 pt-2">
          <button
            type="button"
            disabled={submitting}
            onClick={onClose}
            className="bx-btn"
          >
            {copy.cancelLabel}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleConfirm()}
            className="bx-btn bx-btn-danger"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : mode === 'withdraw' ? (
              <RotateCcw className="w-4 h-4" />
            ) : (
              <XCircle className="w-4 h-4" />
            )}
            <span>{submitting ? 'Processing…' : copy.confirmLabel}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
