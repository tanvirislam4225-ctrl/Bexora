import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  CurrencyCode,
  DealRecord,
  MarketplaceListing,
  PrivateUser,
  PublicProfile,
  PublicSettings,
} from '../types';
import { auth, db, extractUserFacingFirestoreError } from '../lib/firebase';
import {
  formatMoneyFromMinor,
  isDealUnpaidStatus,
  PLATFORM_CATALOG,
} from '../lib/marketplaceLogic';
import {
  buildAcceptedDealCheckoutQuote,
  buildListingBuyNowQuote,
  canCheckoutDeal,
  computeCheckoutWalletState,
  formatCheckoutShortfallNotice,
  normalizeWordPressDiscovery,
  WordPressGatewayDiscoveryState,
} from '../lib/checkoutAndIntentLogic';
import {
  appendDealAuditEvent,
  emitPaidDealRoomCreatedAlerts,
  emitUserNotification,
} from '../lib/notificationService';
import { PlatformIcon } from './Icons';

interface CheckoutViewProps {
  mode: 'buy_now' | 'accepted_bid_deal';
  listing: MarketplaceListing | null;
  deal: DealRecord | null;
  loadingTarget?: boolean;
  userUid: string | null;
  profile: PublicProfile | null;
  privateUser: PrivateUser | null;
  settings: PublicSettings;
  displayCurrency: CurrencyCode;
  wpReturnSessionId?: string | null;
  onBack: () => void;
  onRequireAuthForCheckout: () => void;
  onOpenWalletForTopUp: () => void;
  onDealFunded: (dealId: string, message: string) => void;
  onFlash: (msg: string) => void;
}

type SelectedCheckoutMethod =
  | { type: 'wallet' }
  | { type: 'wordpress_gateway'; gatewayId: string };

export const CheckoutView: React.FC<CheckoutViewProps> = ({
  mode,
  listing,
  deal,
  loadingTarget = false,
  userUid,
  profile,
  privateUser,
  settings,
  displayCurrency,
  wpReturnSessionId,
  onBack,
  onRequireAuthForCheckout,
  onOpenWalletForTopUp,
  onDealFunded,
  onFlash,
}) => {
  const [selectedMethod, setSelectedMethod] = useState<SelectedCheckoutMethod>({ type: 'wallet' });
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // WordPress Multi-Gateway Discovery State
  const [loadingGateways, setLoadingGateways] = useState(true);
  const [wpDiscovery, setWpDiscovery] = useState<WordPressGatewayDiscoveryState>(() =>
    normalizeWordPressDiscovery({
      enabledInSettings: Boolean(settings.wordpressPaymentEnabled),
      siteUrl: settings.wordpressSiteUrl || '',
      bridgeEndpoint: settings.wordpressBridgeEndpoint || '/wp-json/bexora/v1',
      liveVerified: false,
      webhookSecretConfigured: false,
    })
  );

  // Optional WordPress Return Session Verification State
  const [verifyingSession, setVerifyingSession] = useState(false);
  const [sessionVerificationNotice, setSessionVerificationNotice] = useState<{
    tone: 'info' | 'warning' | 'success';
    text: string;
  } | null>(null);

  const loadWordPressGateways = useCallback(async () => {
    setLoadingGateways(true);
    try {
      const resp = await fetch('/api/payments/wordpress/methods');
      if (resp.ok) {
        const data = await resp.json();
        if (data && typeof data === 'object' && Array.isArray(data.methods)) {
          setWpDiscovery(data as WordPressGatewayDiscoveryState);
          return;
        }
      }
      // Static-hosting fallback: derive safe unverified state from public settings (never fakes live readiness)
      setWpDiscovery(
        normalizeWordPressDiscovery({
          enabledInSettings: Boolean(settings.wordpressPaymentEnabled),
          siteUrl: settings.wordpressSiteUrl || '',
          bridgeEndpoint: settings.wordpressBridgeEndpoint || '/wp-json/bexora/v1',
          liveVerified: false,
          webhookSecretConfigured: false,
          errorHint:
            'Live WordPress payment server verification is not active in this environment. Use your BEXORA Wallet Balance to complete checkout immediately.',
        })
      );
    } catch {
      setWpDiscovery(
        normalizeWordPressDiscovery({
          enabledInSettings: Boolean(settings.wordpressPaymentEnabled),
          siteUrl: settings.wordpressSiteUrl || '',
          bridgeEndpoint: settings.wordpressBridgeEndpoint || '/wp-json/bexora/v1',
          liveVerified: false,
          webhookSecretConfigured: false,
        })
      );
    } finally {
      setLoadingGateways(false);
    }
  }, [
    settings.wordpressPaymentEnabled,
    settings.wordpressSiteUrl,
    settings.wordpressBridgeEndpoint,
  ]);

  useEffect(() => {
    void loadWordPressGateways();
  }, [loadWordPressGateways]);

  // Verify WordPress return session if buyer returned from an external WordPress checkout URL
  useEffect(() => {
    if (!wpReturnSessionId) {
      setSessionVerificationNotice(null);
      return;
    }
    let cancelled = false;
    setVerifyingSession(true);
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (auth.currentUser) {
          const idToken = await auth.currentUser.getIdToken(false).catch(() => '');
          if (idToken) headers.Authorization = `Bearer ${idToken}`;
        }
        const resp = await fetch(
          `/api/payments/wordpress/verify-session?sessionId=${encodeURIComponent(wpReturnSessionId)}`,
          { headers }
        );
        const data = await resp.json().catch(() => null);
        if (cancelled) return;
        if (resp.ok && data?.verified === true && data?.status === 'paid') {
          setSessionVerificationNotice({
            tone: 'success',
            text:
              data.message ||
              'WordPress live payment verified! Confirming your 3-Party Escrow Deal Room…',
          });
        } else {
          setSessionVerificationNotice({
            tone: 'warning',
            text:
              data?.message ||
              'External WordPress payment has not been cryptographically verified as paid yet. No funds were marked settled—complete payment or pay immediately with BEXORA Wallet Balance.',
          });
        }
      } catch {
        if (!cancelled) {
          setSessionVerificationNotice({
            tone: 'warning',
            text:
              'Could not verify external payment status. Unverified sessions never mark an order as paid.',
          });
        }
      } finally {
        if (!cancelled) setVerifyingSession(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [wpReturnSessionId]);

  const quote = useMemo(() => {
    if (mode === 'accepted_bid_deal' && deal) {
      return buildAcceptedDealCheckoutQuote(deal, listing);
    }
    if (mode === 'buy_now' && listing) {
      return buildListingBuyNowQuote(listing, settings);
    }
    return null;
  }, [mode, deal, listing, settings]);

  const walletState = useMemo(() => {
    if (!quote) return null;
    return computeCheckoutWalletState(
      privateUser?.walletBalanceMinor || 0,
      quote,
      settings.usdToBdtRate
    );
  }, [quote, privateUser?.walletBalanceMinor, settings.usdToBdtRate]);

  const dealEligibility = useMemo(() => {
    if (mode !== 'accepted_bid_deal') return { eligible: true };
    return canCheckoutDeal(deal, userUid);
  }, [mode, deal, userUid]);

  const isSellerSelfPurchase = Boolean(userUid && quote && quote.sellerId === userUid);
  const buyNowUnavailable =
    mode === 'buy_now' && Boolean(listing && listing.status !== 'active');

  const handleWalletEscrowCheckout = async () => {
    setErrorMessage('');
    if (!userUid || !profile || !privateUser) {
      onRequireAuthForCheckout();
      return;
    }
    if (!quote || !walletState) return;

    if (isSellerSelfPurchase) {
      setErrorMessage('You cannot purchase your own listing.');
      return;
    }

    if (mode === 'buy_now' && (!listing || listing.status !== 'active')) {
      setErrorMessage('This listing is currently reserved or sold and unavailable for Buy Now.');
      return;
    }

    if (mode === 'accepted_bid_deal' && !dealEligibility.eligible) {
      setErrorMessage(dealEligibility.reason || 'This deal is not eligible for payment.');
      return;
    }

    if (!walletState.hasSufficientBalance) {
      setErrorMessage(
        formatCheckoutShortfallNotice(
          walletState.shortfallMinor,
          displayCurrency,
          settings.usdToBdtRate
        )
      );
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'buy_now' && listing) {
        const dealId = `deal_${listing.id}_${Date.now()}`
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 120);
        const ledgerId = `led_pay_${dealId}`;
        const paidAtMs = Date.now();
        const requiredWalletDebitBdtMinor = walletState.requiredInWalletCurrencyMinor;

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
            throw new Error('Payment has already been processed for this order.');
          }
          if (!listingSnap.exists() || listingSnap.data()?.status !== 'active') {
            throw new Error('This listing has just been reserved or sold.');
          }

          const currentBalance = Number(buyerSnap.data()?.walletBalanceMinor) || 0;
          if (currentBalance < requiredWalletDebitBdtMinor) {
            throw new Error('Insufficient BEXORA Wallet balance for this purchase.');
          }

          tx.update(buyerPrivRef, {
            walletBalanceMinor: currentBalance - requiredWalletDebitBdtMinor,
            updatedAt: serverTimestamp(),
          });

          tx.set(dealRef, {
            listingId: listing.id,
            listingTitle: quote.title,
            platform: quote.platform,
            originalListingPriceMinor: quote.originalListingPriceMinor,
            buyerId: userUid,
            buyerName: profile.displayName,
            sellerId: quote.sellerId,
            sellerName: quote.sellerName,
            baseAmountMinor: quote.baseAmountMinor,
            buyerFeePct: quote.buyerFeePct,
            sellerFeePct: quote.sellerFeePct,
            buyerFeeMinor: quote.buyerFeeMinor,
            sellerFeeMinor: quote.sellerFeeMinor,
            buyerTotalMinor: quote.buyerTotalMinor,
            sellerPayoutMinor: quote.sellerPayoutMinor,
            platformCommissionMinor: quote.platformCommissionMinor,
            refundBuyerMinor: quote.refundBuyerMinor,
            refundPlatformRetainedMinor: quote.refundPlatformRetainedMinor,
            currency: quote.currency,
            protectionDurationHours: quote.protectionDurationHours,
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
            amountMinor: quote.buyerTotalMinor,
            currency: quote.currency,
            referenceId: dealId,
            note: `Escrow Buy Now checkout for ${quote.title.slice(0, 80)}`,
            createdAt: serverTimestamp(),
          });
        });

        const formattedTotal = formatMoneyFromMinor(
          quote.buyerTotalMinor,
          quote.currency,
          quote.currency
        );

        await Promise.all([
          appendDealAuditEvent({
            dealId,
            actorId: userUid,
            actorName: profile.displayName,
            actorRole: 'buyer',
            eventType: 'deal_funded_buy_now',
            summary: `Buyer funded ${formattedTotal} via BEXORA Wallet Checkout (Buy Now). Private 3-party Deal Room activated.`,
          }),
          emitPaidDealRoomCreatedAlerts({
            dealId,
            listingTitle: quote.title,
            buyerId: userUid,
            buyerName: profile.displayName,
            sellerId: quote.sellerId,
            totalFormatted: formattedTotal,
            paymentSummary: `Buy Now escrow checkout (${formattedTotal})`,
          }),
          emitUserNotification({
            recipientId: userUid,
            eventKey: `wallet_escrow_debit_${dealId}`,
            category: 'wallet',
            severity: 'info',
            title: 'Wallet Debited for Escrow Purchase',
            preview: `${formattedTotal} locked in escrow for "${quote.title}".`,
            body: `${formattedTotal} was debited from your BEXORA Wallet to fund Escrow Deal #${dealId.slice(0, 10)} for "${quote.title}".`,
            refType: 'wallet',
            refId: ledgerId,
            referenceLabel: `Ledger #${ledgerId.slice(0, 12)}`,
            destination: 'wallet',
          }),
        ]);

        onDealFunded(
          dealId,
          'Escrow funded! Your 3-Party Deal Room is active — await Seller Asset Transfer Proof.'
        );
        return;
      }

      if (mode === 'accepted_bid_deal' && deal) {
        const ledgerId = `led_pay_${deal.id}`;
        const paidAtMs = Date.now();
        const requiredWalletDebitBdtMinor = walletState.requiredInWalletCurrencyMinor;

        await runTransaction(db, async (tx) => {
          const dealRef = doc(db, 'deals', deal.id);
          const privRef = doc(db, 'privateUsers', userUid);
          const listingRef = doc(db, 'listings', deal.listingId);
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
          if (bal < requiredWalletDebitBdtMinor) {
            throw new Error('Insufficient BEXORA Wallet balance.');
          }

          const acceptedBidId = dSnap.data()?.acceptedBidId
            ? String(dSnap.data()?.acceptedBidId)
            : deal.acceptedBidId;

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
            walletBalanceMinor: bal - requiredWalletDebitBdtMinor,
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
            activeDealId: deal.id,
            updatedAt: serverTimestamp(),
          });

          tx.set(ledgerRef, {
            userId: userUid,
            kind: 'escrow_debit',
            amountMinor: deal.buyerTotalMinor,
            currency: deal.currency,
            referenceId: deal.id,
            note: `Accepted-bid escrow checkout (${formatMoneyFromMinor(
              deal.baseAmountMinor,
              deal.currency,
              deal.currency
            )} + ${deal.buyerFeePct}% fee)`,
            createdAt: serverTimestamp(),
          });
        });

        const baseFmt = formatMoneyFromMinor(deal.baseAmountMinor, deal.currency, deal.currency);
        const totalFmt = formatMoneyFromMinor(deal.buyerTotalMinor, deal.currency, deal.currency);

        await Promise.all([
          appendDealAuditEvent({
            dealId: deal.id,
            actorId: userUid,
            actorName: profile.displayName,
            actorRole: 'buyer',
            eventType: 'accepted_bid_paid',
            summary: `Buyer paid exact accepted bid ${baseFmt} + ${deal.buyerFeePct}% fee (${totalFmt} total, Ledger ${ledgerId}). Private 3-party Deal Room activated.`,
          }),
          emitPaidDealRoomCreatedAlerts({
            dealId: deal.id,
            listingTitle: deal.listingTitle,
            buyerId: userUid,
            buyerName: deal.buyerName,
            sellerId: deal.sellerId,
            totalFormatted: totalFmt,
            paymentSummary: `accepted bid (${baseFmt} + ${deal.buyerFeePct}% fee = ${totalFmt})`,
          }),
        ]);

        onDealFunded(
          deal.id,
          'Escrow payment confirmed! Private 3-Party Deal Room is active — awaiting Seller Asset Transfer Proof.'
        );
      }
    } catch (err) {
      setErrorMessage(
        extractUserFacingFirestoreError(err, 'Checkout payment could not be completed.')
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleWordPressLiveCheckout = async (gatewayId: string) => {
    setErrorMessage('');
    if (!userUid || !profile || !auth.currentUser) {
      onRequireAuthForCheckout();
      return;
    }
    if (!quote) return;

    if (wpDiscovery.statusCode !== 'live_ready') {
      setErrorMessage(
        'WordPress live payment gateway is not yet verified active. Please complete your purchase using BEXORA Wallet Balance.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const idToken = await auth.currentUser.getIdToken(false);
      const returnUrl = `${window.location.origin}${window.location.pathname}?view=checkout&${
        mode === 'accepted_bid_deal' && deal
          ? `dealId=${encodeURIComponent(deal.id)}`
          : `listingId=${encodeURIComponent(quote.listingId)}`
      }`;

      const resp = await fetch('/api/payments/wordpress/create-session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({
          mode,
          listingId: mode === 'buy_now' ? quote.listingId : undefined,
          dealId: mode === 'accepted_bid_deal' ? quote.dealId : undefined,
          gatewayId,
          returnUrl,
        }),
      });

      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.redirectUrl) {
        throw new Error(
          data?.error ||
            'Could not initiate live WordPress payment session. No funds were charged—you can pay safely via BEXORA Wallet Balance.'
        );
      }

      const redirectUrl = String(data.redirectUrl);
      const parsedRedirect = new URL(redirectUrl);
      if (parsedRedirect.protocol !== 'https:') {
        throw new Error('WordPress live payment redirect must use HTTPS.');
      }

      onFlash('Redirecting to verified WordPress payment gateway…');
      window.location.assign(parsedRedirect.toString());
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? err.message
          : 'Unable to start external WordPress gateway session.'
      );
      setSubmitting(false);
    }
  };

  if (loadingTarget) {
    return (
      <section className="bx-wrap py-12">
        <div className="bx-card p-10 text-center space-y-3 max-w-xl mx-auto">
          <Loader2 className="w-8 h-8 animate-spin mx-auto text-[var(--orange)]" />
          <h1 className="text-xl font-extrabold">Preparing Secure Escrow Checkout…</h1>
          <p className="bx-hint">Loading real-time asset pricing, fee breakdown, and payment gateways.</p>
        </div>
      </section>
    );
  }

  if (!quote) {
    return (
      <section className="bx-wrap py-12">
        <div className="bx-card p-8 sm:p-10 text-center space-y-4 max-w-xl mx-auto">
          <AlertCircle className="w-10 h-10 mx-auto text-[var(--orange)]" />
          <h1 className="text-xl font-extrabold">Checkout Item Unavailable</h1>
          <p className="bx-hint">
            The selected listing or reserved deal could not be found, or may have already been settled.
          </p>
          <button type="button" onClick={onBack} className="bx-btn bx-btn-primary">
            <ArrowLeft className="w-4 h-4" />
            <span>Return to Marketplace</span>
          </button>
        </div>
      </section>
    );
  }

  const platformDef = PLATFORM_CATALOG[quote.platform];
  const activeGatewayObj =
    selectedMethod.type === 'wordpress_gateway'
      ? wpDiscovery.methods.find((m) => m.id === selectedMethod.gatewayId && m.selectable) || null
      : null;

  return (
    <section className="bx-wrap py-6 sm:py-8 space-y-6" aria-label="Secure Escrow Checkout">
      {/* Top Full-Screen Navigation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 pb-4 border-b-2 border-[var(--bx-border)]">
        <div className="flex flex-col items-start sm:flex-row sm:items-center gap-3">
          <button type="button" onClick={onBack} className="bx-btn bx-btn-sm">
            <ArrowLeft className="w-4 h-4" />
            <span>{mode === 'accepted_bid_deal' ? 'Back to Deal Room' : 'Back to Listing'}</span>
          </button>
          <div>
            <p
              className="text-[11px] font-extrabold uppercase tracking-wider"
              style={{ color: 'var(--orange)' }}
            >
              BEXORA Protected Escrow Checkout
            </p>
            <h1 className="text-xl sm:text-2xl font-black tracking-tight">
              {mode === 'accepted_bid_deal'
                ? 'Complete Accepted-Bid Payment'
                : 'Complete Asset Purchase'}
            </h1>
          </div>
        </div>

        <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl bx-soft text-xs font-extrabold">
          <Lock className="w-4 h-4 text-[var(--green)]" />
          <span>Funds Locked Until Buyer Approves Transfer + {quote.protectionDurationHours}h Hold</span>
        </div>
      </div>

      {/* WordPress Return Session Verification Banner */}
      {(verifyingSession || sessionVerificationNotice) && (
        <div
          className="bx-card p-4 flex items-start gap-3 text-xs font-bold"
          style={{
            background:
              sessionVerificationNotice?.tone === 'success'
                ? 'var(--green-soft)'
                : 'var(--surface-2)',
            borderColor:
              sessionVerificationNotice?.tone === 'success' ? 'var(--green)' : 'var(--orange)',
          }}
          role="status"
        >
          {verifyingSession ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin shrink-0 mt-0.5 text-[var(--orange)]" />
              <span>Verifying WordPress gateway payment signature with server…</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[var(--orange)]" />
              <span>{sessionVerificationNotice?.text}</span>
            </>
          )}
        </div>
      )}

      {/* Logged-Out Visitor Continuation Prompt */}
      {!userUid && (
        <div
          className="bx-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
          style={{ background: 'var(--yellow-soft)', color: '#191919' }}
        >
          <div className="space-y-1">
            <h2 className="text-base font-black">Sign in or create an account to complete this purchase</h2>
            <p className="text-xs font-semibold opacity-90">
              You will automatically return straight to this exact checkout screen after signing in.
            </p>
          </div>
          <button
            type="button"
            onClick={onRequireAuthForCheckout}
            className="bx-btn bx-btn-primary shrink-0"
          >
            <span>Sign In / Create Account to Continue</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {errorMessage && (
        <div
          className="p-4 rounded-xl text-xs font-bold flex items-start gap-2.5 border-2"
          style={{
            background: 'var(--red-soft)',
            color: 'var(--red)',
            borderColor: 'var(--red)',
          }}
          role="alert"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{errorMessage}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* LEFT COLUMN (7 Cols): Payment Method Selection & Action */}
        <div className="lg:col-span-7 space-y-6">
          {/* Payment Method 1: BEXORA Wallet Balance (Active & Immediate) */}
          <div className="bx-card p-5 sm:p-6 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <Wallet className="w-5 h-5 text-[var(--orange)]" />
                <div>
                  <h2 className="text-base sm:text-lg font-extrabold">
                    1. Pay with BEXORA Wallet Balance
                  </h2>
                  <p className="bx-hint">
                    Instant atomic escrow lock — activates your private 3-Party Deal Room immediately.
                  </p>
                </div>
              </div>
              <span
                className="px-2.5 py-1 rounded-lg text-[11px] font-black uppercase"
                style={{ background: 'var(--green-soft)', color: 'var(--green)' }}
              >
                Active
              </span>
            </div>

            <label
              className="block p-4 rounded-xl border-2 cursor-pointer transition-colors space-y-3"
              style={{
                borderColor:
                  selectedMethod.type === 'wallet' ? 'var(--orange)' : 'var(--border-soft)',
                background:
                  selectedMethod.type === 'wallet' ? 'var(--surface-2)' : 'var(--surface)',
              }}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <input
                    type="radio"
                    name="checkout-payment-method"
                    checked={selectedMethod.type === 'wallet'}
                    onChange={() => {
                      setSelectedMethod({ type: 'wallet' });
                      setErrorMessage('');
                    }}
                    className="w-4 h-4 accent-[#FF6500]"
                  />
                  <span className="font-extrabold text-sm">BEXORA Escrow Wallet</span>
                </div>
                {userUid && privateUser ? (
                  <span className="text-sm font-black tabular-nums">
                    Available:{' '}
                    {formatMoneyFromMinor(
                      privateUser.walletBalanceMinor,
                      displayCurrency,
                      'BDT',
                      settings.usdToBdtRate
                    )}
                  </span>
                ) : (
                  <span className="text-xs font-bold opacity-75">Sign in to view balance</span>
                )}
              </div>

              {userUid && privateUser && walletState && (
                <div className="pt-2 border-t text-xs tabular-nums space-y-2" style={{ borderColor: 'var(--border-soft)' }}>
                  <div className="flex justify-between">
                    <span style={{ color: 'var(--text-2)' }}>Required Escrow Lock:</span>
                    <strong>
                      {formatMoneyFromMinor(
                        walletState.requiredInWalletCurrencyMinor,
                        displayCurrency,
                        'BDT',
                        settings.usdToBdtRate
                      )}
                    </strong>
                  </div>

                  {walletState.hasSufficientBalance ? (
                    <div className="flex justify-between" style={{ color: 'var(--green)' }}>
                      <span className="font-bold">Wallet Balance After Purchase:</span>
                      <strong>
                        {formatMoneyFromMinor(
                          walletState.remainingAfterPurchaseMinor,
                          displayCurrency,
                          'BDT',
                          settings.usdToBdtRate
                        )}
                      </strong>
                    </div>
                  ) : (
                    <div
                      className="p-3 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2.5"
                      style={{ background: 'var(--surface)', border: '1.5px solid var(--orange)' }}
                    >
                      <span className="font-bold" style={{ color: 'var(--orange)' }}>
                        {formatCheckoutShortfallNotice(
                          walletState.shortfallMinor,
                          displayCurrency,
                          settings.usdToBdtRate
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={onOpenWalletForTopUp}
                        className="bx-btn bx-btn-primary bx-btn-sm shrink-0"
                      >
                        <Wallet className="w-3.5 h-3.5" />
                        <span>Add Balance to Wallet</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </label>
          </div>

          {/* Payment Method 2: WordPress Live Multi-Gateway Bridge */}
          <div className="bx-card p-5 sm:p-6 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <CreditCard className="w-5 h-5 text-[var(--purple)]" />
                <div>
                  <h2 className="text-base sm:text-lg font-extrabold">
                    2. Live Payment Methods (WordPress Payment Bridge)
                  </h2>
                  <p className="bx-hint">
                    Supports cards, mobile banking, and international gateways connected via WordPress.
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="px-2.5 py-1 rounded-lg text-[11px] font-black uppercase"
                  style={{
                    background:
                      wpDiscovery.statusCode === 'live_ready'
                        ? 'var(--green-soft)'
                        : 'var(--purple-soft)',
                    color:
                      wpDiscovery.statusCode === 'live_ready'
                        ? 'var(--green)'
                        : 'var(--purple)',
                  }}
                >
                  {wpDiscovery.statusCode === 'live_ready'
                    ? `${wpDiscovery.methods.length} Live Ready`
                    : 'Awaiting Live Connection'}
                </span>
                <button
                  type="button"
                  onClick={() => void loadWordPressGateways()}
                  disabled={loadingGateways}
                  className="bx-icon-btn !w-8 !h-8"
                  aria-label="Refresh live payment methods"
                  title="Refresh live payment methods"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingGateways ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {loadingGateways ? (
              <div className="p-4 rounded-xl bx-soft flex items-center gap-2.5 text-xs font-bold">
                <Loader2 className="w-4 h-4 animate-spin text-[var(--purple)]" />
                <span>Checking WordPress live payment gateway availability…</span>
              </div>
            ) : wpDiscovery.statusCode === 'live_ready' && wpDiscovery.methods.length > 0 ? (
              <div className="space-y-2.5">
                {wpDiscovery.methods.map((gw) => {
                  const isSelected =
                    selectedMethod.type === 'wordpress_gateway' &&
                    selectedMethod.gatewayId === gw.id;
                  return (
                    <label
                      key={gw.id}
                      className="block p-4 rounded-xl border-2 cursor-pointer transition-colors space-y-1.5"
                      style={{
                        borderColor: isSelected ? 'var(--purple)' : 'var(--border-soft)',
                        background: isSelected ? 'var(--purple-soft)' : 'var(--surface)',
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2.5">
                          <input
                            type="radio"
                            name="checkout-payment-method"
                            checked={isSelected}
                            onChange={() => {
                              setSelectedMethod({
                                type: 'wordpress_gateway',
                                gatewayId: gw.id,
                              });
                              setErrorMessage('');
                            }}
                            className="w-4 h-4 accent-[#793A91]"
                          />
                          <span className="font-extrabold text-sm">{gw.title}</span>
                        </div>
                        <span className="text-[11px] font-extrabold px-2 py-0.5 rounded bx-soft">
                          {gw.providerBadge || 'Live Gateway'}
                        </span>
                      </div>
                      <p className="bx-hint pl-6">{gw.description}</p>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="p-4 rounded-xl bx-soft space-y-2.5">
                <div className="flex items-start gap-2.5 text-xs">
                  <Globe className="w-4 h-4 shrink-0 mt-0.5 text-[var(--purple)]" />
                  <div className="space-y-1">
                    <p className="font-bold leading-relaxed">{wpDiscovery.userMessage}</p>
                    <p className="bx-hint">
                      Integrity Guarantee: Live payment methods activate automatically once WordPress REST/WooCommerce gateways and cryptographic webhook verification are connected. Unconfigured gateways never simulate fake payment completions.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Primary Confirm & Escrow Lock Action Card */}
          <div className="bx-card p-5 sm:p-6 space-y-3">
            {isSellerSelfPurchase ? (
              <div className="p-3.5 rounded-xl bx-soft text-xs font-bold text-center">
                You are the seller of this asset and cannot purchase your own listing.
              </div>
            ) : buyNowUnavailable ? (
              <div className="p-3.5 rounded-xl bx-soft text-xs font-bold text-center">
                This listing is currently reserved or sold and unavailable for Buy Now checkout.
              </div>
            ) : mode === 'accepted_bid_deal' && userUid && !dealEligibility.eligible ? (
              <div className="p-3.5 rounded-xl bx-soft text-xs font-bold text-center">
                {dealEligibility.reason}
              </div>
            ) : !userUid ? (
              <button
                type="button"
                onClick={onRequireAuthForCheckout}
                className="bx-btn bx-btn-primary w-full text-base py-3.5 justify-center"
              >
                <span>Sign In or Create Account to Complete Purchase</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : selectedMethod.type === 'wordpress_gateway' && activeGatewayObj ? (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleWordPressLiveCheckout(activeGatewayObj.id)}
                className="bx-btn bx-btn-purple w-full text-base py-3.5 justify-center"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ExternalLink className="w-4 h-4" />
                )}
                <span>
                  {submitting
                    ? 'Opening Verified Live Gateway…'
                    : `Continue to ${activeGatewayObj.title} — ${formatMoneyFromMinor(
                        quote.buyerTotalMinor,
                        displayCurrency,
                        quote.currency,
                        settings.usdToBdtRate
                      )}`}
                </span>
              </button>
            ) : walletState && !walletState.hasSufficientBalance ? (
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={onOpenWalletForTopUp}
                  className="bx-btn bx-btn-primary w-full text-base py-3.5 justify-center"
                >
                  <Wallet className="w-4 h-4" />
                  <span>Add Balance to BEXORA Wallet to Complete Purchase</span>
                </button>
                <p className="bx-hint text-center">
                  After submitting or receiving your wallet balance, click &ldquo;Return to Checkout&rdquo; to finish locking escrow.
                </p>
              </div>
            ) : (
              <button
                type="button"
                disabled={submitting}
                onClick={() => void handleWalletEscrowCheckout()}
                className="bx-btn bx-btn-yellow w-full text-base py-3.5 justify-center"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-5 h-5" />
                )}
                <span>
                  {submitting
                    ? 'Locking Funds in BEXORA Escrow…'
                    : `Confirm & Lock ${formatMoneyFromMinor(
                        quote.buyerTotalMinor,
                        displayCurrency,
                        quote.currency,
                        settings.usdToBdtRate
                      )} in BEXORA Escrow`}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN (5 Cols): Sticky Order & Escrow Protection Summary */}
        <aside className="lg:col-span-5 lg:sticky lg:top-20 space-y-5">
          <div className="bx-card p-5 sm:p-6 space-y-4">
            <div className="flex items-start gap-3 pb-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
              <div className="w-12 h-12 rounded-xl bx-soft grid place-items-center shrink-0">
                <PlatformIcon id={quote.platform} size={28} />
              </div>
              <div className="min-w-0">
                <span className="text-xs font-extrabold uppercase" style={{ color: 'var(--orange)' }}>
                  {platformDef?.name || quote.platform} · {quote.subcategory}
                </span>
                <h2 className="text-base font-extrabold leading-snug mt-0.5">{quote.title}</h2>
                <p className="bx-hint mt-0.5">
                  Seller: <strong>{quote.sellerName}</strong>
                  {quote.sellerVerified ? ' · NID Verified' : ''}
                </p>
              </div>
            </div>

            <div className="space-y-2.5 text-sm tabular-nums">
              {quote.originalListingPriceMinor !== quote.baseAmountMinor && (
                <div className="flex justify-between text-xs">
                  <span style={{ color: 'var(--text-2)' }}>Original Listed Price</span>
                  <span className="line-through opacity-70">
                    {formatMoneyFromMinor(
                      quote.originalListingPriceMinor,
                      displayCurrency,
                      quote.currency,
                      settings.usdToBdtRate
                    )}
                  </span>
                </div>
              )}

              <div className="flex justify-between">
                <span style={{ color: 'var(--text-2)' }}>
                  {mode === 'accepted_bid_deal' ? 'Accepted Bid Price' : 'Asset Price'}
                </span>
                <strong>
                  {formatMoneyFromMinor(
                    quote.baseAmountMinor,
                    displayCurrency,
                    quote.currency,
                    settings.usdToBdtRate
                  )}
                </strong>
              </div>

              <div className="flex justify-between">
                <span style={{ color: 'var(--text-2)' }}>
                  BEXORA Buyer Escrow Fee ({quote.buyerFeePct}%)
                </span>
                <strong>
                  {formatMoneyFromMinor(
                    quote.buyerFeeMinor,
                    displayCurrency,
                    quote.currency,
                    settings.usdToBdtRate
                  )}
                </strong>
              </div>

              <div className="h-px my-1" style={{ background: 'var(--border-soft)' }} />

              <div className="flex justify-between text-lg font-black">
                <span>Total Payable</span>
                <span style={{ color: 'var(--orange)' }}>
                  {formatMoneyFromMinor(
                    quote.buyerTotalMinor,
                    displayCurrency,
                    quote.currency,
                    settings.usdToBdtRate
                  )}
                </span>
              </div>
            </div>

            <div className="p-3.5 rounded-xl bx-soft space-y-2 text-xs">
              <div className="font-extrabold flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-[var(--green)] shrink-0" />
                <span>3-Party Escrow Protection Included</span>
              </div>
              <ul className="space-y-1.5 pl-1" style={{ color: 'var(--text-2)' }}>
                <li>
                  • Seller receives <strong>৳0</strong> upfront—funds stay locked in BEXORA Escrow.
                </li>
                <li>
                  • Seller must upload verified Asset Transfer Proof inside the private Deal Room.
                </li>
                <li>
                  • Immutable{' '}
                  <strong>
                    {quote.platform === 'youtube'
                      ? `7-Day (${quote.protectionDurationHours}h)`
                      : `${quote.protectionDurationHours}-Hour`}
                  </strong>{' '}
                  security hold starts only after you inspect &amp; approve receipt.
                </li>
                <li>
                  • Admin Dispute Refund Policy: Buyer receives{' '}
                  <strong>
                    {formatMoneyFromMinor(
                      quote.refundBuyerMinor,
                      displayCurrency,
                      quote.currency,
                      settings.usdToBdtRate
                    )}
                  </strong>{' '}
                  back if transfer fails verification.
                </li>
              </ul>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
};
