import React, { useEffect, useMemo, useRef, useState } from 'react';
import { collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  CreditCard,
  Loader2,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  CurrencyCode,
  DealRecord,
  DepositRequestRecord,
  PrivateUser,
  PublicProfile,
  PublicSettings,
  WithdrawalRequestRecord,
} from '../types';
import {
  DEFAULT_WITHDRAWAL_METHODS,
  WithdrawalMethodSetting,
} from '../lib/countryCurrencyCatalog';
import { db, fetchWithFreshBearerToken } from '../lib/firebase';
import { buildApiUrl } from '../lib/apiClient';
import { formatMoneyFromMinor } from '../lib/marketplaceLogic';
import { summarizeUserPendingSellerDeals } from '../lib/adminFinanceLogic';
import { emitUserNotification } from '../lib/notificationService';
import {
  MAX_WALLET_TOPUP_BDT,
  MIN_WALLET_TOPUP_BDT,
  normalizeGatewayPaymentMethods,
  sanitizeCustomerGatewayError,
  validateWalletTopupAmountBdt,
} from '../lib/walletTopupAndReservationLogic';
import type { UserRestrictionRecord } from '../types/moderation';

interface WalletModalProps {
  onClose: () => void;
  returnToCheckoutLabel?: string | null;
  onReturnToCheckout?: () => void;
  userUid: string;
  profile: PublicProfile;
  privateUser: PrivateUser;
  settings: PublicSettings;
  deposits: DepositRequestRecord[];
  withdrawals: WithdrawalRequestRecord[];
  deals?: DealRecord[];
  displayCurrency: CurrencyCode;
  onFlash: (msg: string) => void;
  moderationRestriction?: UserRestrictionRecord | null;
  onOpenSafetyAppeals?: () => void;
  initialMode?: 'deposit' | 'withdraw' | 'history';
  pendingTopupSessionId?: string | null;
  pendingTopupStatus?: string | null;
  pendingTopupTransactionId?: string | null;
  onClearTopupReturn?: () => void;
}

const TOPUP_PRESETS_BDT = [500, 1000, 2500, 5000, 10000] as const;

export const WalletModal: React.FC<WalletModalProps> = ({
  onClose,
  returnToCheckoutLabel = null,
  onReturnToCheckout,
  userUid,
  profile,
  privateUser,
  settings,
  deposits,
  withdrawals,
  deals = [],
  displayCurrency,
  onFlash,
  moderationRestriction = null,
  onOpenSafetyAppeals,
  initialMode = 'deposit',
  pendingTopupSessionId = null,
  pendingTopupStatus = null,
  pendingTopupTransactionId = null,
  onClearTopupReturn,
}) => {
  const [mode, setMode] = useState<'deposit' | 'withdraw' | 'history'>(initialMode);

  const pendingSellerSummary = useMemo(
    () => summarizeUserPendingSellerDeals(deals, userUid, settings.usdToBdtRate),
    [deals, userUid, settings.usdToBdtRate]
  );

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);

  const activeGatewayLabels = useMemo(
    () =>
      normalizeGatewayPaymentMethods(settings.gatewayPaymentMethods).filter((m) => m.enabled),
    [settings.gatewayPaymentMethods]
  );

  // Enabled withdrawal methods from settings or defaults
  const enabledWithdrawalMethods: WithdrawalMethodSetting[] = useMemo(() => {
    const list =
      settings.withdrawalMethods && settings.withdrawalMethods.length > 0
        ? settings.withdrawalMethods
        : DEFAULT_WITHDRAWAL_METHODS;
    return list.filter((m) => m.enabled);
  }, [settings.withdrawalMethods]);

  const [selectedWithdrawId, setSelectedWithdrawId] = useState<string>('bkash');

  useEffect(() => {
    if (enabledWithdrawalMethods.length > 0 && !enabledWithdrawalMethods.some((m) => m.id === selectedWithdrawId)) {
      setSelectedWithdrawId(enabledWithdrawalMethods[0].id);
    }
  }, [enabledWithdrawalMethods, selectedWithdrawId]);

  const currentWithdrawMethod =
    enabledWithdrawalMethods.find((m) => m.id === selectedWithdrawId) || enabledWithdrawalMethods[0];

  // Live Gateway Add Balance state
  const [topupAmountInput, setTopupAmountInput] = useState('');
  const [topupVerifyState, setTopupVerifyState] = useState<{
    status: 'idle' | 'verifying' | 'success' | 'cancelled' | 'error';
    message: string;
  }>({ status: 'idle', message: '' });

  // Withdrawal inputs
  const [payoutAccount, setPayoutAccount] = useState('');
  const [withdrawAmountInput, setWithdrawAmountInput] = useState('');

  const [busy, setBusy] = useState(false);
  const submitLockRef = useRef(false);
  const verifiedTopupSessionRef = useRef<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!pendingTopupSessionId) return;
    const dedupKey = `${pendingTopupSessionId}:${pendingTopupStatus || ''}:${pendingTopupTransactionId || ''}`;
    if (verifiedTopupSessionRef.current === dedupKey) return;
    verifiedTopupSessionRef.current = dedupKey;

    if (pendingTopupStatus === 'cancelled') {
      setMode('deposit');
      setTopupVerifyState({
        status: 'cancelled',
        message: 'Wallet top-up was cancelled before payment completion. Your balance was not changed.',
      });
      onClearTopupReturn?.();
      return;
    }

    let cancelled = false;
    setMode('deposit');
    setTopupVerifyState({
      status: 'verifying',
      message: 'Verifying your wallet top-up payment with the gateway…',
    });

    void (async () => {
      try {
        const res = await fetchWithFreshBearerToken(
          buildApiUrl('/api/payments/wallet/verify-session'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sessionId: pendingTopupSessionId,
              transactionId: pendingTopupTransactionId || undefined,
              paymentStatus: pendingTopupStatus || undefined,
            }),
          }
        );
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          isPaid?: boolean;
          credited?: boolean;
          amountBdt?: number;
          message?: string;
        } | null;

        if (cancelled) return;

        if (res.ok && data?.ok && data?.isPaid) {
          const msg =
            data.message ||
            `৳${Number(data.amountBdt || 0).toLocaleString()} added to your BEXORA Wallet.`;
          setTopupVerifyState({ status: 'success', message: msg });
          onFlash(msg);
        } else {
          setTopupVerifyState({
            status: 'error',
            message: sanitizeCustomerGatewayError(
              data?.message || 'Your top-up payment could not be confirmed yet.'
            ),
          });
        }
      } catch (err) {
        if (cancelled) return;
        setTopupVerifyState({
          status: 'error',
          message: sanitizeCustomerGatewayError(
            err instanceof Error ? err.message : 'Unable to verify top-up payment right now.'
          ),
        });
      } finally {
        if (!cancelled) {
          onClearTopupReturn?.();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    pendingTopupSessionId,
    pendingTopupStatus,
    pendingTopupTransactionId,
    onClearTopupReturn,
    onFlash,
  ]);

  const handleStartLiveTopup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockRef.current || busy) return;
    setError('');
    setTopupVerifyState({ status: 'idle', message: '' });

    const validation = validateWalletTopupAmountBdt(topupAmountInput);
    if (!validation.valid) {
      setError(validation.error || 'Enter a valid BDT top-up amount.');
      return;
    }

    submitLockRef.current = true;
    setBusy(true);
    try {
      const res = await fetchWithFreshBearerToken(
        buildApiUrl('/api/payments/wallet/create-session'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amountBdt: validation.amountBdt,
          }),
        }
      );

      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        paymentUrl?: string;
        message?: string;
        error?: string;
      } | null;

      if (!res.ok || !data?.ok || !data?.paymentUrl) {
        setError(sanitizeCustomerGatewayError(data?.message || data?.error));
        return;
      }

      window.location.assign(data.paymentUrl);
    } catch (err) {
      setError(
        sanitizeCustomerGatewayError(
          err instanceof Error ? err.message : 'Unable to connect to live payment gateway.'
        )
      );
    } finally {
      submitLockRef.current = false;
      setBusy(false);
    }
  };


  const handleSubmitWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitLockRef.current) return;
    setError('');
    if (!currentWithdrawMethod) {
      setError('Please select an active withdrawal method.');
      return;
    }
    const amt = Number(withdrawAmountInput);
    if (!Number.isFinite(amt) || amt <= 0) {
      setError('Please enter a valid withdrawal amount.');
      return;
    }

    const minLimit = currentWithdrawMethod.minLimit ?? 10;
    const isCrypto = currentWithdrawMethod.currency === 'USDT';
    const effectiveRate = settings.usdtToBdtRate || settings.usdToBdtRate || 125;
    const amtMinor = isCrypto ? Math.round(amt * effectiveRate * 100) : Math.round(amt * 100);

    if (amt < minLimit) {
      const sym = isCrypto ? 'USDT ' : '৳';
      setError(
        `Minimum withdrawal amount for ${currentWithdrawMethod.name} is ${sym}${minLimit}. You entered ${sym}${amt}.`
      );
      return;
    }

    if (amtMinor > privateUser.walletBalanceMinor) {
      setError('Requested withdrawal exceeds your available balance.');
      return;
    }
    if (payoutAccount.trim().length < 4) {
      setError('Enter valid payout account details or wallet address.');
      return;
    }

    submitLockRef.current = true;
    setBusy(true);
    try {
      const wRef = doc(collection(db, 'withdrawals'));
      const ledgerRef = doc(db, 'walletLedger', `led_wd_${wRef.id}`);
      await runTransaction(db, async (tx) => {
        const privRef = doc(db, 'privateUsers', userUid);
        const pSnap = await tx.get(privRef);
        const curBal = Number(pSnap.data()?.walletBalanceMinor) || 0;
        const curRes = Number(pSnap.data()?.reservedBalanceMinor) || 0;
        if (curBal < amtMinor) {
          throw new Error('Insufficient available balance.');
        }

        tx.update(privRef, {
          walletBalanceMinor: curBal - amtMinor,
          reservedBalanceMinor: curRes + amtMinor,
          updatedAt: serverTimestamp(),
        });

        tx.set(wRef, {
          userId: userUid,
          userName: profile.displayName,
          method: currentWithdrawMethod.id,
          methodName: currentWithdrawMethod.name,
          payoutAccount: payoutAccount.trim(),
          amountMinor: amtMinor,
          originalAmount: amt,
          currency: isCrypto ? 'USDT' : 'BDT',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        tx.set(ledgerRef, {
          userId: userUid,
          kind: 'withdrawal_reserved',
          amountMinor: amtMinor,
          currency: isCrypto ? 'USDT' : 'BDT',
          referenceId: wRef.id,
          note: `Withdrawal reservation via ${currentWithdrawMethod.name}`,
          createdAt: serverTimestamp(),
        });
      });

      const wdFmt = isCrypto ? `${amt} USDT` : formatMoneyFromMinor(amtMinor, 'BDT', 'BDT');
      await emitUserNotification({
        recipientId: userUid,
        eventKey: `withdrawal_submitted_${wRef.id}`,
        category: 'wallet',
        severity: 'info',
        title: `Withdrawal Requested (${wdFmt})`,
        preview: `${wdFmt} reserved for ${currentWithdrawMethod.name} payout verification.`,
        body: `Your withdrawal request for ${wdFmt} via ${currentWithdrawMethod.name} (${payoutAccount.trim()}) has been submitted and reserved safely. You will be notified as soon as an administrator completes or reviews your payout.`,
        refType: 'wallet',
        refId: wRef.id,
        referenceLabel: `${currentWithdrawMethod.name} · ${wdFmt}`,
        destination: 'wallet',
      });

      setWithdrawAmountInput('');
      setPayoutAccount('');
      onFlash('Withdrawal request submitted & funds safely reserved awaiting admin payout.');
      setMode('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Withdrawal request failed.');
    } finally {
      submitLockRef.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="bx-wrap py-6 sm:py-8 space-y-6" aria-label="BEXORA Wallet">
      {/* Top Navigation & Optional Return-to-Checkout Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onReturnToCheckout ? (
          <button
            type="button"
            onClick={onReturnToCheckout}
            className="bx-btn bx-btn-primary bx-btn-sm inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{returnToCheckoutLabel || 'Return to Checkout'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onClose}
            className="bx-btn bx-btn-sm inline-flex items-center gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Marketplace</span>
          </button>
        )}

        <span className="bx-hint">
          Verified Escrow Wallet · Instant Checkout Balance
        </span>
      </div>

      {/* Full-Screen 2-Column Wallet Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Balance Card & Escrow Notes */}
        <div className="lg:col-span-5 space-y-4">
          <div
            className="p-6 rounded-2xl text-white space-y-1.5 tabular-nums border"
            style={{ background: 'var(--orange)', borderColor: 'var(--border-strong)' }}
          >
            <span className="text-xs font-extrabold uppercase tracking-wider opacity-90">
              Available Wallet Balance
            </span>
            <div className="text-3xl sm:text-4xl font-black">
              {formatMoneyFromMinor(
                privateUser.walletBalanceMinor,
                displayCurrency,
                'BDT',
                settings.usdToBdtRate
              )}
            </div>
            {privateUser.reservedBalanceMinor > 0 && (
              <p className="text-xs opacity-95 font-semibold pt-1">
                Reserved for pending withdrawal:{' '}
                {formatMoneyFromMinor(
                  privateUser.reservedBalanceMinor,
                  displayCurrency,
                  'BDT',
                  settings.usdToBdtRate
                )}
              </p>
            )}
          </div>

          <div
            data-testid="wallet-pending-seller-balance-card"
            className="bx-card p-5 space-y-2.5 tabular-nums border-2"
            style={{ borderColor: 'var(--border-strong)' }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-extrabold uppercase tracking-wider text-[var(--text-2)]">
                <Clock className="w-3.5 h-3.5 text-[var(--orange)]" />
                Pending Seller Balance (Escrow Hold)
              </span>
              <span className="text-[11px] font-black uppercase text-[var(--orange)]">
                Locked
              </span>
            </div>
            <div className="text-2xl font-black text-[var(--text)]">
              {formatMoneyFromMinor(
                pendingSellerSummary.totalPendingBdtMinor,
                displayCurrency,
                'BDT',
                settings.usdToBdtRate
              )}
            </div>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
              {pendingSellerSummary.activePendingCount > 0
                ? `${pendingSellerSummary.activePendingCount} active escrow sale${pendingSellerSummary.activePendingCount === 1 ? '' : 's'} awaiting security period completion. Cannot be withdrawn until automatically released to Available Wallet Balance with 0 disputes.`
                : 'Completed sales waiting out the security countdown appear here before automatic release into your Available Wallet Balance.'}
            </p>
            {pendingSellerSummary.deals.length > 0 && (
              <div className="pt-2 border-t border-[var(--border-soft)] space-y-1.5">
                {pendingSellerSummary.deals.slice(0, 4).map((d) => (
                  <div key={d.dealId} className="flex items-center justify-between gap-2 text-[11px]">
                    <span className="truncate font-bold text-[var(--text)]">{d.listingTitle}</span>
                    <span className="shrink-0 font-extrabold text-[var(--text-2)]">
                      {formatMoneyFromMinor(d.payoutBdtMinor, displayCurrency, 'BDT', settings.usdToBdtRate)}
                      {d.isDisputed ? ' · Hold (Dispute)' : d.isReadyForRelease ? ' · Releasing' : ''}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bx-card p-5 space-y-3 text-xs">
            <div className="flex items-center gap-2 font-extrabold text-sm">
              <ShieldCheck className="w-4 h-4" style={{ color: 'var(--green)' }} />
              <span>How Wallet Balance Powers Escrow</span>
            </div>
            <p style={{ color: 'var(--text-2)' }}>
              Your BEXORA Wallet balance can be used immediately at Checkout for Buy Now purchases and Accepted Bid Deal Rooms without waiting for external gateway redirects.
            </p>
            {onReturnToCheckout && (
              <button
                type="button"
                onClick={onReturnToCheckout}
                className="bx-btn bx-btn-yellow w-full justify-center"
              >
                <ArrowLeft className="w-4 h-4" />
                <span>{returnToCheckoutLabel || 'Return to Your Saved Checkout'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Right Column: Add Balance / Withdraw / History Card */}
        <div className="lg:col-span-7">
          <div className="bx-card p-5 sm:p-6 space-y-5">
            <h1 className="text-xl font-black">BEXORA Wallet &amp; Balance</h1>

            {/* Segmented Tabs */}
            <div className="grid grid-cols-3 gap-1.5 p-1.5 rounded-xl bx-soft">
          {[
            ['deposit', 'Add Balance'],
            ['withdraw', 'Withdraw'],
            ['history', `History (${deposits.length + withdrawals.length})`],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => {
                setMode(id as 'deposit' | 'withdraw' | 'history');
                setError('');
              }}
              className="py-2 rounded-lg text-xs font-extrabold transition-colors"
              style={{
                background: mode === id ? 'var(--surface)' : 'transparent',
                color: mode === id ? 'var(--text)' : 'var(--text-2)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {error && (
          <div
            className="p-3 rounded-xl text-xs font-bold"
            style={{ background: 'var(--red-soft)', color: 'var(--red)' }}
            role="alert"
          >
            {error}
          </div>
        )}

        {mode === 'deposit' && (
          <div className="space-y-4">
            {topupVerifyState.status !== 'idle' && (
              <div
                role={topupVerifyState.status === 'error' ? 'alert' : 'status'}
                className="p-3.5 rounded-xl border text-xs font-bold flex items-start gap-2.5"
                style={{
                  background:
                    topupVerifyState.status === 'success'
                      ? 'var(--green-soft)'
                      : topupVerifyState.status === 'error'
                        ? 'var(--red-soft)'
                        : 'var(--yellow-soft)',
                  borderColor:
                    topupVerifyState.status === 'success'
                      ? 'var(--green)'
                      : topupVerifyState.status === 'error'
                        ? 'var(--red)'
                        : 'var(--orange)',
                  color:
                    topupVerifyState.status === 'success'
                      ? 'var(--green)'
                      : topupVerifyState.status === 'error'
                        ? 'var(--red)'
                        : 'var(--text)',
                }}
              >
                {topupVerifyState.status === 'verifying' ? (
                  <Loader2 className="w-4 h-4 shrink-0 animate-spin mt-0.5" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                )}
                <span>{topupVerifyState.message}</span>
              </div>
            )}

            <form onSubmit={handleStartLiveTopup} className="space-y-4">
              <div
                className="p-4 rounded-2xl border space-y-2"
                style={{
                  background: 'var(--surface-subtle)',
                  borderColor: 'var(--border-soft)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-xs font-black uppercase tracking-wide">
                    <CreditCard className="w-4 h-4" style={{ color: 'var(--orange)' }} />
                    <span>Live Payment Gateway Top-Up</span>
                  </div>
                  <span
                    className="text-[10px] font-black uppercase px-2 py-0.5 rounded"
                    style={{ background: 'var(--green-soft)', color: 'var(--green)' }}
                  >
                    Instant Credit
                  </span>
                </div>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
                  Enter your BDT amount and complete checkout securely via the BEXORA Live Payment Gateway. Your wallet balance credits automatically once verified.
                </p>
                {activeGatewayLabels.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {activeGatewayLabels.map((label) => (
                      <span
                        key={label.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-extrabold"
                        style={{
                          borderColor: `${label.color}55`,
                          background: 'var(--surface)',
                        }}
                      >
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ background: label.color }}
                        />
                        <span>{label.name}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <span className="bx-label">Quick Select Amount (BDT)</span>
                <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                  {TOPUP_PRESETS_BDT.map((preset) => {
                    const active = Number(topupAmountInput) === preset;
                    return (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => {
                          setTopupAmountInput(String(preset));
                          setError('');
                        }}
                        className="py-2 px-2 rounded-xl border text-xs font-black tabular-nums transition-colors"
                        style={{
                          borderColor: active ? 'var(--orange)' : 'var(--border-soft)',
                          background: active ? 'var(--orange-soft)' : 'var(--surface)',
                          color: active ? 'var(--orange)' : 'var(--text)',
                        }}
                      >
                        ৳{preset.toLocaleString()}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label htmlFor="wallet-topup-amount" className="bx-label">
                  Top-Up Amount (BDT · Min ৳{MIN_WALLET_TOPUP_BDT} · Max ৳
                  {MAX_WALLET_TOPUP_BDT.toLocaleString()})
                </label>
                <div className="relative">
                  <span
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-sm font-black"
                    style={{ color: 'var(--text-2)' }}
                  >
                    ৳
                  </span>
                  <input
                    id="wallet-topup-amount"
                    type="number"
                    min={MIN_WALLET_TOPUP_BDT}
                    max={MAX_WALLET_TOPUP_BDT}
                    step="1"
                    inputMode="numeric"
                    value={topupAmountInput}
                    onChange={(e) => {
                      setTopupAmountInput(e.target.value);
                      if (error) setError('');
                    }}
                    placeholder="e.g. 1000"
                    className="bx-input !pl-8 font-bold tabular-nums"
                    disabled={busy}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="bx-btn bx-btn-primary w-full justify-center"
              >
                {busy ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CreditCard className="w-4 h-4" aria-hidden="true" />
                )}
                <span>{busy ? 'Connecting to Payment Gateway…' : 'Add Now'}</span>
              </button>
            </form>
          </div>
        )}

        {mode === 'withdraw' && (
          <div className="space-y-4">
            {(moderationRestriction?.restrictWithdrawals ||
              moderationRestriction?.financialHoldActive) && (
              <div
                role="alert"
                className="p-3.5 rounded-xl border text-xs space-y-2"
                style={{
                  background: 'var(--yellow-soft)',
                  borderColor: 'var(--orange)',
                  color: '#5C4700',
                }}
              >
                <p className="font-extrabold">
                  Withdrawal Requests Temporarily Paused — Balance 100% Preserved
                </p>
                <p className="leading-relaxed">
                  Your available wallet balance (
                  <strong>
                    {formatMoneyFromMinor(
                      privateUser.walletBalanceMinor,
                      displayCurrency,
                      'BDT',
                      settings.usdToBdtRate
                    )}
                  </strong>
                  ) and escrow reserves remain completely intact. New withdrawal payouts are paused
                  pending human Trust &amp; Safety review.
                </p>
                {onOpenSafetyAppeals && (
                  <button
                    type="button"
                    onClick={onOpenSafetyAppeals}
                    className="bx-btn bx-btn-sm font-extrabold"
                  >
                    Open Safety Center &amp; Submit Appeal
                  </button>
                )}
              </div>
            )}

            {enabledWithdrawalMethods.length === 0 ? (
              <div
                className="p-5 rounded-2xl border text-center space-y-2"
                style={{ background: 'var(--surface-subtle)', borderColor: 'var(--border-soft)' }}
              >
                <Wallet className="w-8 h-8 mx-auto opacity-40" />
                <h3 className="text-sm font-bold">Withdrawals Updating</h3>
                <p className="text-xs" style={{ color: 'var(--text-2)' }}>
                  Withdrawal methods are currently being configured by an administrator. Please check back shortly.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmitWithdrawal} className="space-y-4">
                {/* Method selector for enabled options only */}
                <div>
                  <span className="bx-label">1. Select Withdrawal Method</span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {enabledWithdrawalMethods.map((m) => {
                      const isSelected = m.id === currentWithdrawMethod.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            setSelectedWithdrawId(m.id);
                            setError('');
                          }}
                          className="p-3 rounded-xl border text-left transition-all relative flex flex-col justify-between"
                          style={{
                            borderColor: isSelected ? 'var(--orange)' : 'var(--border-soft)',
                            background: isSelected ? 'var(--orange-soft)' : 'var(--surface)',
                          }}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="text-xs font-black truncate">{m.name}</span>
                            {isSelected && <CheckCircle2 className="w-4 h-4 text-orange-500 flex-shrink-0" />}
                          </div>
                          <span className="text-[10px] font-bold opacity-80 block">
                            Min: {m.currency === 'USDT' ? `${m.minLimit} USDT` : `৳${m.minLimit}`}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Method guidelines and limit notice */}
                <div
                  className="p-3.5 rounded-xl border space-y-1.5"
                  style={{ background: 'var(--surface-subtle)', borderColor: 'var(--border-soft)' }}
                >
                  <div className="flex items-center justify-between text-xs font-extrabold">
                    <span>{currentWithdrawMethod.name} Payout</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full" style={{ background: 'var(--surface)' }}>
                      Min: {currentWithdrawMethod.currency === 'USDT' ? `${currentWithdrawMethod.minLimit} USDT` : `৳${currentWithdrawMethod.minLimit}`}
                    </span>
                  </div>
                  {currentWithdrawMethod.instructions && (
                    <p className="text-xs leading-relaxed" style={{ color: 'var(--text-2)' }}>
                      {currentWithdrawMethod.instructions}
                    </p>
                  )}
                </div>

                {/* Account details input */}
                <div>
                  <label htmlFor="wd-account" className="bx-label">
                    Payout Account / Number / Address
                  </label>
                  <input
                    id="wd-account"
                    type="text"
                    value={payoutAccount}
                    onChange={(e) => setPayoutAccount(e.target.value)}
                    placeholder={currentWithdrawMethod.accountPlaceholder || 'Enter your account details'}
                    className="bx-input"
                  />
                </div>

                {/* Amount to withdraw with minimum limit enforcement */}
                <div>
                  <label htmlFor="wd-amount" className="bx-label">
                    Amount to Withdraw (
                    {currentWithdrawMethod.currency === 'USDT'
                      ? `USDT, Minimum ${currentWithdrawMethod.minLimit} USDT`
                      : `BDT, Minimum ৳${currentWithdrawMethod.minLimit}`}
                    )
                  </label>
                  <input
                    id="wd-amount"
                    type="number"
                    min={currentWithdrawMethod.minLimit}
                    step={currentWithdrawMethod.currency === 'USDT' ? '0.01' : '1'}
                    inputMode="decimal"
                    value={withdrawAmountInput}
                    onChange={(e) => setWithdrawAmountInput(e.target.value)}
                    placeholder={`Minimum ${currentWithdrawMethod.currency === 'USDT' ? `${currentWithdrawMethod.minLimit} USDT` : `৳${currentWithdrawMethod.minLimit}`}`}
                    className="bx-input"
                  />
                  {currentWithdrawMethod.currency === 'USDT' && (
                    <span className="bx-hint mt-1 block">
                      Converted at 1 USDT = {settings.usdtToBdtRate || settings.usdToBdtRate || 125} BDT.
                    </span>
                  )}
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="bx-btn bx-btn-primary w-full justify-center"
                >
                  <ArrowUpRight className="w-4 h-4" />
                  <span>
                    {busy
                      ? 'Requesting…'
                      : `Request Withdrawal via ${currentWithdrawMethod.name}`}
                  </span>
                </button>
              </form>
            )}
          </div>
        )}

        {mode === 'history' && (
          <div className="space-y-4">
            <div className="space-y-2">
              <h3 className="text-xs font-extrabold uppercase" style={{ color: 'var(--text-2)' }}>
                Deposit &amp; Top-Up History ({deposits.length})
              </h3>
              {deposits.length === 0 ? (
                <p className="bx-hint">No prior wallet deposit records.</p>
              ) : (
                deposits.map((d) => (
                  <div key={d.id} className="p-3 rounded-xl bx-soft flex items-center justify-between gap-2 text-xs tabular-nums">
                    <div>
                      <strong className="text-sm font-extrabold block">
                        {formatMoneyFromMinor(d.amountMinor, 'BDT', 'BDT')} · {d.method.toUpperCase()}
                      </strong>
                      <span className="bx-hint">TrxID: {d.transactionId}</span>
                      {d.rejectionReason && (
                        <p className="font-bold mt-0.5" style={{ color: 'var(--red)' }}>
                          Reason: {d.rejectionReason}
                        </p>
                      )}
                    </div>
                    <span
                      className="font-extrabold uppercase"
                      style={{
                        color:
                          d.status === 'approved'
                            ? 'var(--green)'
                            : d.status === 'rejected'
                            ? 'var(--red)'
                            : 'var(--orange)',
                      }}
                    >
                      {d.status}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-extrabold uppercase" style={{ color: 'var(--text-2)' }}>
                Withdrawal Requests ({withdrawals.length})
              </h3>
              {withdrawals.length === 0 ? (
                <p className="bx-hint">No withdrawal requests yet.</p>
              ) : (
                withdrawals.map((w) => (
                  <div key={w.id} className="p-3 rounded-xl bx-soft flex items-center justify-between gap-2 text-xs tabular-nums">
                    <div>
                      <strong className="text-sm font-extrabold block">
                        {formatMoneyFromMinor(w.amountMinor, 'BDT', 'BDT')} · {w.method.toUpperCase()}
                      </strong>
                      <span className="bx-hint">To: {w.payoutAccount}</span>
                      {w.referenceId && <span className="bx-hint block">Ref: {w.referenceId}</span>}
                    </div>
                    <span
                      className="font-extrabold uppercase"
                      style={{
                        color:
                          w.status === 'paid'
                            ? 'var(--green)'
                            : w.status === 'rejected'
                            ? 'var(--red)'
                            : 'var(--orange)',
                      }}
                    >
                      {w.status}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
          </div>
        </div>
      </div>
    </section>
  );
};
