import React, { useEffect, useMemo, useRef, useState } from 'react';
import { addDoc, collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Check, CheckCircle2, Copy, ShieldCheck, Upload, Wallet } from 'lucide-react';
import {
  CurrencyCode,
  DepositRequestRecord,
  PrivateUser,
  PublicProfile,
  PublicSettings,
  WithdrawalRequestRecord,
} from '../types';
import {
  DEFAULT_WITHDRAWAL_METHODS,
  DEFAULT_MANUAL_PAYMENT_METHODS,
  WithdrawalMethodSetting,
  ManualPaymentMethodSetting,
} from '../lib/countryCurrencyCatalog';
import { db, validateAndProcessImageFile } from '../lib/firebase';
import { formatMoneyFromMinor } from '../lib/marketplaceLogic';
import { emitUserNotification } from '../lib/notificationService';
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
  displayCurrency: CurrencyCode;
  onFlash: (msg: string) => void;
  moderationRestriction?: UserRestrictionRecord | null;
  onOpenSafetyAppeals?: () => void;
  initialMode?: 'deposit' | 'withdraw' | 'history';
}

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
  displayCurrency,
  onFlash,
  moderationRestriction = null,
  onOpenSafetyAppeals,
  initialMode = 'deposit',
}) => {
  const [mode, setMode] = useState<'deposit' | 'withdraw' | 'history'>(initialMode);

  useEffect(() => {
    setMode(initialMode);
  }, [initialMode]);
  // Active manual payment methods from settings or defaults
  const activeManualMethods: ManualPaymentMethodSetting[] = useMemo(() => {
    const list =
      settings.manualPaymentConfig && settings.manualPaymentConfig.length > 0
        ? settings.manualPaymentConfig
        : DEFAULT_MANUAL_PAYMENT_METHODS;
    return list.filter((m) => m.enabled && m.receivingNumber && m.receivingNumber.trim().length > 0);
  }, [settings.manualPaymentConfig]);

  const [selectedManualId, setSelectedManualId] = useState<string>('bkash');

  useEffect(() => {
    if (activeManualMethods.length > 0 && !activeManualMethods.some((m) => m.id === selectedManualId)) {
      setSelectedManualId(activeManualMethods[0].id);
    }
  }, [activeManualMethods, selectedManualId]);

  const currentManualMethod =
    activeManualMethods.find((m) => m.id === selectedManualId) || activeManualMethods[0];

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

  // Deposit inputs
  const [amountInput, setAmountInput] = useState('');
  const [senderNumber, setSenderNumber] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [screenshotData, setScreenshotData] = useState('');

  // Withdrawal inputs
  const [payoutAccount, setPayoutAccount] = useState('');
  const [withdrawAmountInput, setWithdrawAmountInput] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const handleScreenshot = async (files: FileList | null) => {
    if (!files || !files[0]) return;
    setError('');
    try {
      const compressed = await validateAndProcessImageFile(files[0], 800, 0.72);
      setScreenshotData(compressed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid screenshot.');
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSubmitDeposit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!currentManualMethod || !currentManualMethod.receivingNumber) {
      setError('Please select an active payment method configured by an administrator.');
      return;
    }

    const amt = Number(amountInput);
    const minAmt = currentManualMethod.minDeposit ?? 10;
    const isCrypto = currentManualMethod.id === 'binance' || currentManualMethod.type === 'binance';
    const sym = isCrypto ? 'USDT ' : '৳';
    if (!Number.isFinite(amt) || amt < minAmt) {
      setError(`Minimum manual deposit amount for ${currentManualMethod.name} is ${sym}${minAmt}.`);
      return;
    }
    if (senderNumber.trim().length < 4) {
      setError('Enter the sender account/phone or wallet address used to send the payment.');
      return;
    }
    if (transactionId.trim().length < 4) {
      setError('Enter the valid Transaction ID (TrxID) / Order ID from your payment receipt.');
      return;
    }

    setBusy(true);
    try {
      const effectiveRate = settings.usdtToBdtRate || settings.usdToBdtRate || 125;
      const amountMinor = isCrypto ? Math.round(amt * effectiveRate * 100) : Math.round(amt * 100);

      const payload: Record<string, unknown> = {
        userId: userUid,
        userName: profile.displayName,
        method: currentManualMethod.id,
        methodName: currentManualMethod.name,
        amountMinor,
        originalAmount: amt,
        currency: isCrypto ? 'USDT' : 'BDT',
        senderNumber: senderNumber.trim(),
        transactionId: transactionId.trim(),
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (screenshotData) payload.screenshotData = screenshotData;

      const depDoc = await addDoc(collection(db, 'deposits'), payload);
      const depFmt = isCrypto
        ? `${amt} USDT (≈ ৳${Math.round(amt * effectiveRate)})`
        : formatMoneyFromMinor(amountMinor, 'BDT', 'BDT');

      await emitUserNotification({
        recipientId: userUid,
        eventKey: `deposit_submitted_${depDoc.id}`,
        category: 'wallet',
        severity: 'info',
        title: `Deposit Request Submitted (${depFmt})`,
        preview: `${currentManualMethod.name} TrxID ${transactionId.trim()} is pending admin verification.`,
        body: `Your manual ${currentManualMethod.name} deposit request for ${depFmt} (TrxID: ${transactionId.trim()}) has been submitted with Pending status. Your wallet balance will update automatically once an administrator verifies the payment.`,
        refType: 'wallet',
        refId: depDoc.id,
        referenceLabel: `${currentManualMethod.name} · ${depFmt}`,
        destination: 'wallet',
      });
      setAmountInput('');
      setSenderNumber('');
      setTransactionId('');
      setScreenshotData('');
      onFlash('Deposit request submitted with PENDING status. Balance updates only after admin verification.');
      setMode('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit deposit request.');
    } finally {
      setBusy(false);
    }
  };
  const handleSubmitWithdrawal = async (e: React.FormEvent) => {
    e.preventDefault();
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
            {activeManualMethods.length === 0 ? (
              <div
                className="p-5 rounded-2xl border text-center space-y-2"
                style={{ background: 'var(--surface-subtle)', borderColor: 'var(--border-soft)' }}
              >
                <Wallet className="w-8 h-8 mx-auto opacity-40" />
                <h3 className="text-sm font-bold">Manual Deposits Updating</h3>
                <p className="text-xs" style={{ color: 'var(--text-2)' }}>
                  Manual deposit methods are currently being configured by an administrator. Please check back shortly.
                </p>
              </div>
            ) : (
              <form onSubmit={handleSubmitDeposit} className="space-y-4">
                {/* Method selector cards in payment-gateway style */}
                <div>
                  <span className="bx-label">1. Select Payment Method</span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {activeManualMethods.map((m) => {
                      const isSelected = m.id === currentManualMethod.id;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() => {
                            setSelectedManualId(m.id);
                            setError('');
                          }}
                          className="p-3 rounded-xl border text-left transition-all relative flex flex-col justify-between"
                          style={{
                            borderColor: isSelected ? (m.color || 'var(--orange)') : 'var(--border-soft)',
                            background: isSelected ? 'var(--surface-subtle)' : 'var(--surface)',
                            boxShadow: isSelected ? `0 0 0 2px ${m.color || 'var(--orange)'}33` : 'none',
                          }}
                        >
                          <div className="flex items-center justify-between gap-1 mb-1">
                            <span className="text-xs font-black truncate">{m.name}</span>
                            {isSelected && (
                              <CheckCircle2
                                className="w-4 h-4 flex-shrink-0"
                                style={{ color: m.color || 'var(--orange)' }}
                              />
                            )}
                          </div>
                          {m.badge && (
                            <span
                              className="inline-block text-[10px] font-extrabold uppercase px-1.5 py-0.5 rounded w-max"
                              style={{
                                background: isSelected ? `${m.color || 'var(--orange)'}22` : 'var(--border-soft)',
                                color: isSelected ? (m.color || 'var(--orange)') : 'var(--text-2)',
                              }}
                            >
                              {m.badge}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Professional Step-by-Step Payment Instructions & Receiving Number */}
                <div
                  className="p-4 rounded-2xl border space-y-3"
                  style={{
                    background: 'var(--surface-subtle)',
                    borderColor: currentManualMethod.color ? `${currentManualMethod.color}44` : 'var(--border-soft)',
                  }}
                >
                  <div className="flex items-center justify-between gap-2 border-b pb-2.5" style={{ borderColor: 'var(--border-soft)' }}>
                    <div>
                      <span className="text-[11px] font-extrabold uppercase block" style={{ color: 'var(--text-2)' }}>
                        Official Receiving Account ({currentManualMethod.name})
                      </span>
                      {currentManualMethod.accountHolder && (
                        <span className="text-[11px] font-semibold opacity-80 block">
                          {currentManualMethod.accountHolder}
                        </span>
                      )}
                    </div>
                    {currentManualMethod.badge && (
                      <span
                        className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full"
                        style={{
                          background: currentManualMethod.color ? `${currentManualMethod.color}22` : 'var(--surface)',
                          color: currentManualMethod.color || 'var(--orange)',
                        }}
                      >
                        {currentManualMethod.badge}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-3 p-3 rounded-xl bg-[var(--surface)] border border-[var(--border-soft)]">
                    <div className="truncate">
                      <span className="text-[10px] uppercase font-bold tracking-wider block" style={{ color: 'var(--text-2)' }}>
                        Number / Address to Send Money:
                      </span>
                      <strong className="text-base sm:text-lg font-black tracking-wide font-mono block select-all">
                        {currentManualMethod.receivingNumber}
                      </strong>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(currentManualMethod.receivingNumber);
                        onFlash(`${currentManualMethod.name} receiving number copied to clipboard!`);
                      }}
                      className="bx-btn bx-btn-sm inline-flex items-center gap-1.5 flex-shrink-0"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </button>
                  </div>

                  {/* Step-by-step instructions box */}
                  <div className="space-y-1.5 pt-1">
                    <span className="text-[11px] font-black uppercase tracking-wider block" style={{ color: 'var(--text-2)' }}>
                      How to Send Money:
                    </span>
                    <div className="text-xs space-y-1 whitespace-pre-line leading-relaxed" style={{ color: 'var(--text)' }}>
                      {currentManualMethod.instructions}
                    </div>
                  </div>
                </div>

                {/* Form Inputs: Amount, Sender Number, TrxID, Screenshot */}
                <div className="space-y-3">
                  <div>
                    <label htmlFor="dep-amount" className="bx-label">
                      Deposit Amount (
                      {currentManualMethod.id === 'binance' || currentManualMethod.type === 'binance' ? 'USDT' : 'BDT'}
                      , Minimum{' '}
                      {currentManualMethod.id === 'binance' || currentManualMethod.type === 'binance'
                        ? `${currentManualMethod.minDeposit ?? 1} USDT`
                        : `৳${currentManualMethod.minDeposit ?? 10}`}
                      )
                    </label>
                    <input
                      id="dep-amount"
                      type="number"
                      min={currentManualMethod.minDeposit ?? 10}
                      step={currentManualMethod.id === 'binance' || currentManualMethod.type === 'binance' ? '0.01' : '1'}
                      inputMode="decimal"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                      placeholder={`e.g. ${currentManualMethod.minDeposit ?? 500}`}
                      className="bx-input"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="dep-sender" className="bx-label">
                        Sender Account / Phone / Wallet
                      </label>
                      <input
                        id="dep-sender"
                        type="text"
                        value={senderNumber}
                        onChange={(e) => setSenderNumber(e.target.value)}
                        placeholder="e.g. 01XXXXXXXXX or Sender ID"
                        className="bx-input"
                      />
                    </div>
                    <div>
                      <label htmlFor="dep-txid" className="bx-label">
                        Transaction ID (TrxID) / Order ID
                      </label>
                      <input
                        id="dep-txid"
                        type="text"
                        value={transactionId}
                        onChange={(e) => setTransactionId(e.target.value)}
                        placeholder="e.g. 9B2K8QA10"
                        className="bx-input"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-1">
                    <input
                      ref={fileRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onChange={(e) => handleScreenshot(e.target.files)}
                      className="hidden"
                    />
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="bx-btn bx-btn-sm"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>{screenshotData ? 'Replace Receipt Screenshot' : 'Attach Optional Screenshot'}</span>
                    </button>
                    {screenshotData && (
                      <span className="text-xs font-bold inline-flex items-center gap-1" style={{ color: 'var(--green)' }}>
                        <Check className="w-3.5 h-3.5" /> Screenshot attached
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={busy}
                  className="bx-btn bx-btn-primary w-full justify-center"
                >
                  <ArrowDownLeft className="w-4 h-4" />
                  <span>
                    {busy
                      ? 'Submitting Request…'
                      : `Submit Deposit Request (${currentManualMethod.name})`}
                  </span>
                </button>
              </form>
            )}
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
                Deposit Requests ({deposits.length})
              </h3>
              {deposits.length === 0 ? (
                <p className="bx-hint">No manual deposit requests yet.</p>
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
