import React, { useEffect, useRef, useState } from 'react';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { AlertTriangle, CheckCircle2, Loader2, ShieldAlert, Trash2, X } from 'lucide-react';
import type { MarketplaceListing } from '../types';
import { auth, db, extractUserFacingFirestoreError } from '../lib/firebase';
import {
  evaluateListingDeletionEligibility,
  LISTING_DELETE_BLOCKED_ACTIVE_DEAL,
  LISTING_DELETE_CONFIRM_COPY,
  type ListingDeletionPreflightResult,
} from '../lib/listingAndBidManagementLogic';
import { sanitizeSafeImageSrc } from '../lib/marketplaceLogic';
import { PLATFORM_BANNER_BG, PlatformIcon } from './Icons';

interface DeleteListingModalProps {
  listing: MarketplaceListing | null;
  userUid: string | null;
  onClose: () => void;
  onDeleted: (listingId: string, successMessage: string) => void;
}

export const DeleteListingModal: React.FC<DeleteListingModalProps> = ({
  listing,
  userUid,
  onClose,
  onDeleted,
}) => {
  const [checking, setChecking] = useState(false);
  const [preflight, setPreflight] = useState<ListingDeletionPreflightResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [deletedSuccess, setDeletedSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!listing || !userUid) {
      setPreflight(null);
      setDeletedSuccess(false);
      setErrorMsg('');
      return;
    }

    let active = true;
    setChecking(true);
    setDeletedSuccess(false);
    setErrorMsg('');

    const runPreflight = async () => {
      try {
        const idToken = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => '') : '';
        if (idToken) {
          const resp = await fetch(`/api/listings/${encodeURIComponent(listing.id)}/delete-preflight`, {
            headers: {
              Accept: 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
          });
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const payload = (await resp.json()) as Partial<ListingDeletionPreflightResult> & {
              ok?: boolean;
              error?: string;
            };
            if (active && typeof payload.eligible === 'boolean') {
              setPreflight({
                eligible: payload.eligible,
                blockingCode: payload.blockingCode,
                title:
                  payload.title ||
                  (payload.eligible
                    ? LISTING_DELETE_CONFIRM_COPY.title
                    : LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title),
                message:
                  payload.message ||
                  (payload.eligible
                    ? LISTING_DELETE_CONFIRM_COPY.message
                    : LISTING_DELETE_BLOCKED_ACTIVE_DEAL.message),
                pendingBidsCount: Number(payload.pendingBidsCount || 0),
              });
              setChecking(false);
              return;
            }
          }
        }
      } catch {
        // Fallback to direct Firestore preflight evaluation
      }

      try {
        const [bidsSnap, dealsSnap] = await Promise.all([
          getDocs(
            query(collection(db, 'bids'), where('listingId', '==', listing.id), limit(100))
          ).catch(() => null),
          getDocs(
            query(
              collection(db, 'deals'),
              where('sellerId', '==', userUid),
              where('listingId', '==', listing.id),
              limit(25)
            )
          ).catch(() => null),
        ]);

        const bids = bidsSnap
          ? bidsSnap.docs.map((d) => ({
              id: d.id,
              status: String(d.data().status || ''),
              dealId: d.data().dealId ? String(d.data().dealId) : undefined,
            }))
          : [];
        const deals = dealsSnap
          ? dealsSnap.docs.map((d) => ({
              id: d.id,
              status: String(d.data().status || ''),
            }))
          : [];

        const computed = evaluateListingDeletionEligibility({
          isOwner: listing.sellerId === userUid,
          listingStatus: listing.status,
          activeDealId: listing.activeDealId,
          deals,
          bids,
        });
        if (active) setPreflight(computed);
      } catch (err) {
        if (active) {
          setErrorMsg(extractUserFacingFirestoreError(err, 'Could not verify listing status.'));
        }
      } finally {
        if (active) setChecking(false);
      }
    };

    void runPreflight();
    return () => {
      active = false;
    };
  }, [listing, userUid]);

  useEffect(() => {
    if (!listing) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submittingRef.current) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [listing, onClose]);

  if (!listing) return null;

  const safeThumb =
    listing.images && listing.images.length > 0 ? sanitizeSafeImageSrc(listing.images[0]) : '';

  const handleConfirmDelete = async () => {
    if (!userUid || submittingRef.current || !preflight?.eligible) return;
    submittingRef.current = true;
    setSubmitting(true);
    setErrorMsg('');

    try {
      let deletedViaServer = false;
      const idToken = auth.currentUser ? await auth.currentUser.getIdToken().catch(() => '') : '';
      if (idToken) {
        try {
          const resp = await fetch(`/api/listings/${encodeURIComponent(listing.id)}/delete`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify({ confirmed: true }),
          });
          const ct = resp.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const data = (await resp.json()) as {
              ok?: boolean;
              eligible?: boolean;
              title?: string;
              message?: string;
              error?: string;
            };
            if (resp.ok && data.ok) {
              deletedViaServer = true;
            } else if (resp.status === 409 || data.eligible === false) {
              setPreflight({
                eligible: false,
                title: data.title || LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
                message: data.message || data.error || LISTING_DELETE_BLOCKED_ACTIVE_DEAL.message,
                pendingBidsCount: preflight.pendingBidsCount,
              });
              return;
            }
          }
        } catch {
          // Fall through to client Firestore cleanup if backend endpoint is unreachable
        }
      }

      if (!deletedViaServer) {
        const freshSnap = await getDoc(doc(db, 'listings', listing.id));
        if (freshSnap.exists()) {
          const freshData = freshSnap.data();
          if (freshData.sellerId !== userUid) {
            throw new Error('Only the verified listing owner can delete this listing.');
          }
          if (
            freshData.status === 'reserved' ||
            freshData.status === 'sold' ||
            freshData.status === 'suspended' ||
            freshData.activeDealId
          ) {
            setPreflight({
              eligible: false,
              title: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.title,
              message: LISTING_DELETE_BLOCKED_ACTIVE_DEAL.message,
              pendingBidsCount: preflight.pendingBidsCount,
            });
            return;
          }

          // Cancel any open pending bids before deleting the listing
          const pendingBidsSnap = await getDocs(
            query(
              collection(db, 'bids'),
              where('listingId', '==', listing.id),
              where('status', '==', 'pending'),
              limit(100)
            )
          ).catch(() => null);
          if (pendingBidsSnap && !pendingBidsSnap.empty) {
            await Promise.all(
              pendingBidsSnap.docs.map((bDoc) =>
                updateDoc(doc(db, 'bids', bDoc.id), {
                  status: 'cancelled',
                  updatedAt: serverTimestamp(),
                }).catch(() => {})
              )
            );
          }

          await deleteDoc(doc(db, 'listings', listing.id));
          await deleteDoc(doc(db, 'listingEvidence', listing.id)).catch(() => {});
        }
      }

      setDeletedSuccess(true);
      window.setTimeout(() => {
        onDeleted(listing.id, LISTING_DELETE_CONFIRM_COPY.successBanner);
      }, 650);
    } catch (err) {
      setErrorMsg(extractUserFacingFirestoreError(err, 'Failed to delete listing.'));
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="bx-delete-listing-modal-title"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
      onClick={() => {
        if (!submitting && !deletedSuccess) onClose();
      }}
    >
      <div
        className="bx-card w-full max-w-md overflow-hidden p-5 sm:p-6 space-y-4 transition-all duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Close Row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className="w-10 h-10 rounded-xl grid place-items-center shrink-0"
              style={
                deletedSuccess
                  ? { background: 'var(--green-soft)', color: 'var(--green)' }
                  : preflight && !preflight.eligible
                  ? { background: 'var(--yellow-soft)', color: 'var(--orange)' }
                  : { background: 'var(--red-soft)', color: 'var(--red)' }
              }
            >
              {deletedSuccess ? (
                <CheckCircle2 className="w-5 h-5" />
              ) : preflight && !preflight.eligible ? (
                <ShieldAlert className="w-5 h-5" />
              ) : (
                <AlertTriangle className="w-5 h-5" />
              )}
            </div>
            <h2
              id="bx-delete-listing-modal-title"
              className="text-base sm:text-lg font-black tracking-tight"
            >
              {deletedSuccess
                ? LISTING_DELETE_CONFIRM_COPY.successBanner
                : checking
                ? 'CHECKING LISTING SAFETY…'
                : preflight?.title || LISTING_DELETE_CONFIRM_COPY.title}
            </h2>
          </div>

          {!submitting && !deletedSuccess && (
            <button
              type="button"
              onClick={onClose}
              aria-label="Close delete listing dialog"
              className="bx-btn bx-btn-sm !p-2"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Asset Preview Strip */}
        <div
          className="flex items-center gap-3 rounded-xl border p-3"
          style={{ background: 'var(--surface-2)', borderColor: 'var(--border-soft)' }}
        >
          <div
            className="w-16 h-12 rounded-lg overflow-hidden flex items-center justify-center shrink-0 border"
            style={{
              background: PLATFORM_BANNER_BG[listing.platform],
              borderColor: 'var(--border-soft)',
            }}
          >
            {safeThumb ? (
              <img
                src={safeThumb}
                alt={listing.title}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="text-white">
                <PlatformIcon id={listing.platform} size={22} />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-extrabold truncate">{listing.title}</div>
            <div className="text-[11px] font-semibold opacity-75 truncate">
              {listing.subcategory} · ID: {listing.id.slice(0, 12)}
            </div>
          </div>
        </div>

        {/* Body State */}
        {checking ? (
          <div className="py-4 flex items-center justify-center gap-2 text-xs font-bold opacity-80">
            <Loader2 className="w-4 h-4 animate-spin text-[#FF6500]" />
            <span>Verifying active deals, escrow locks, and pending bids…</span>
          </div>
        ) : deletedSuccess ? (
          <div
            className="rounded-xl border p-4 text-xs sm:text-sm font-bold leading-relaxed"
            style={{
              background: 'var(--green-soft)',
              borderColor: 'var(--green)',
              color: 'var(--green)',
            }}
          >
            Your asset listing has been permanently removed from your dashboard and marketplace search.
          </div>
        ) : preflight && !preflight.eligible ? (
          <>
            <p
              className="text-xs sm:text-sm font-semibold leading-relaxed whitespace-pre-line"
              style={{ color: 'var(--text-2)' }}
            >
              {preflight.message}
            </p>
            <div className="flex justify-end pt-1">
              <button type="button" onClick={onClose} className="bx-btn bx-btn-primary">
                Understood
              </button>
            </div>
          </>
        ) : (
          <>
            <p
              className="text-xs sm:text-sm font-semibold leading-relaxed whitespace-pre-line"
              style={{ color: 'var(--text-2)' }}
            >
              {LISTING_DELETE_CONFIRM_COPY.message}
            </p>

            {preflight && preflight.pendingBidsCount > 0 && (
              <div
                className="rounded-xl border p-3 text-xs font-bold leading-snug"
                style={{
                  background: 'var(--yellow-soft)',
                  borderColor: 'var(--orange)',
                  color: '#6E5600',
                }}
              >
                Note: {preflight.pendingBidsCount} open unaccepted bid(s) on this listing will be
                automatically closed and bidders notified that the listing was removed.
              </div>
            )}

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
                Cancel
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleConfirmDelete()}
                className="bx-btn bx-btn-danger"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Trash2 className="w-4 h-4" />
                )}
                <span>{submitting ? 'Deleting…' : 'Confirm Delete'}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
