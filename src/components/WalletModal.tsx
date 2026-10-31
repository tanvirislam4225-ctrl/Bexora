import React, { useEffect, useRef, useState } from 'react';
import { addDoc, collection, doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Copy, ShieldCheck, Upload } from 'lucide-react';
import {
  CurrencyCode,
  DepositRequestRecord,
  PrivateUser,
  PublicProfile,
  PublicSettings,
  WithdrawalRequestRecord,
} from '../types';
import { db, validateAndProcessImageFile } from '../lib/firebase';
import { formatMoneyFromMinor } from '../lib/marketplaceLogic';
import { emitUserNotification } from '../lib/notificationService';

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
}) => {
  const [mode, setMode] = useState<'deposit' | 'withdraw' | 'history'>('deposit');
  const [method, setMethod] = useState<'bkash' | 'nagad' | 'rocket'>('bkash');
  const [envPayments, setEnvPayments] = useState({
    bkashNumber: '',
    nagadNumber: '',
    rocketNumber: '',
  });

  // Deposit inputs
  const [amountBdt, setAmountBdt] = useState('');
  const [senderNumber, setSenderNumber] = useState('');
  const [transactionId, setTransactionId] = useState('');
  const [screenshotData, setScreenshotData] = useState('');

  // Withdrawal inputs
  const [withdrawMethod, setWithdrawMethod] = useState<'bkash' | 'nagad' | 'rocket' | 'bank'>('bkash');
  const [payoutAccount, setPayoutAccount] = useState('');
  const [withdrawAmountBdt, setWithdrawAmountBdt] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    fetch('/api/config/payments')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setEnvPayments({
            bkashNumber: data.bkashNumber || '',
            nagadNumber: data.nagadNumber || '',
            rocketNumber: data.rocketNumber || '',
          });
        }
      })
      .catch(() => {
        // Static InfinityFree fallback uses Firestore publicConfig/settings
      });
  }, []);

  const destinationNumbers: Record<'bkash' | 'nagad' | 'rocket', string> = {
    bkash: settings.bkashNumber || envPayments.bkashNumber || '',
    nagad: settings.nagadNumber || envPayments.nagadNumber || '',
    rocket: settings.rocketNumber || envPayments.rocketNumber || '',
  };

  const activeDestination = destinationNumbers[method].trim();

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
    if (!activeDestination) {
      setError(`Manual ${method.toUpperCase()} receiving number is not yet configured by an administrator.`);
      return;
    }

    const amt = Number(amountBdt);
    if (!Number.isFinite(amt) || amt < 10) {
      setError('Minimum manual deposit amount is ৳10.');
      return;
    }
    if (senderNumber.trim().length < 6) {
      setError('Enter the sender account/phone number used to send the payment.');
      return;
    }
    if (transactionId.trim().length < 4) {
      setError('Enter the valid Transaction ID (TrxID) from your payment receipt.');
      return;
    }

    setBusy(true);
    try {
      const payload: Record<string, unknown> = {
        userId: userUid,
        userName: profile.displayName,
        method,
        amountMinor: Math.round(amt * 100),
        currency: 'BDT',
        senderNumber: senderNumber.trim(),
        transactionId: transactionId.trim(),
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (screenshotData) payload.screenshotData = screenshotData;

      const depDoc = await addDoc(collection(db, 'deposits'), payload);
      const depFmt = formatMoneyFromMinor(Math.round(amt * 100), 'BDT', 'BDT');
      await emitUserNotification({
        recipientId: userUid,
        eventKey: `deposit_submitted_${depDoc.id}`,
        category: 'wallet',
        severity: 'info',
        title: `Deposit Request Submitted (${depFmt})`,
        preview: `${method.toUpperCase()} TrxID ${transactionId.trim()} is pending admin verification.`,
        body: `Your manual ${method.toUpperCase()} deposit request for ${depFmt} (TrxID: ${transactionId.trim()}) has been submitted with Pending status. Your wallet balance will update automatically once an administrator verifies the payment.`,
        refType: 'wallet',
        refId: depDoc.id,
        referenceLabel: `${method.toUpperCase()} · ${depFmt}`,
        destination: 'wallet',
      });
      setAmountBdt('');
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
    const amt = Number(withdrawAmountBdt);
    if (!Number.isFinite(amt) || amt < 10) {
      setError('Minimum withdrawal amount is ৳10.');
      return;
    }
    const amtMinor = Math.round(amt * 100);
    if (amtMinor > privateUser.walletBalanceMinor) {
      setError('Requested withdrawal exceeds your available balance.');
      return;
    }
    if (payoutAccount.trim().length < 5) {
      setError('Enter valid payout account details.');
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
          method: withdrawMethod,
          payoutAccount: payoutAccount.trim(),
          amountMinor: amtMinor,
          currency: 'BDT',
          status: 'pending',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });

        tx.set(ledgerRef, {
          userId: userUid,
          kind: 'withdrawal_reserved',
          amountMinor: amtMinor,
          currency: 'BDT',
          referenceId: wRef.id,
          note: `Withdrawal reservation via ${withdrawMethod.toUpperCase()}`,
          createdAt: serverTimestamp(),
        });
      });

      const wdFmt = formatMoneyFromMinor(amtMinor, 'BDT', 'BDT');
      await emitUserNotification({
        recipientId: userUid,
        eventKey: `withdrawal_submitted_${wRef.id}`,
        category: 'wallet',
        severity: 'info',
        title: `Withdrawal Requested (${wdFmt})`,
        preview: `${wdFmt} reserved for ${withdrawMethod.toUpperCase()} payout verification.`,
        body: `Your withdrawal request for ${wdFmt} via ${withdrawMethod.toUpperCase()} (${payoutAccount.trim()}) has been submitted and reserved safely. You will be notified as soon as an administrator completes or reviews your payout.`,
        refType: 'wallet',
        refId: wRef.id,
        referenceLabel: `${withdrawMethod.toUpperCase()} · ${wdFmt}`,
        destination: 'wallet',
      });

      setWithdrawAmountBdt('');
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
          <form onSubmit={handleSubmitDeposit} className="space-y-3.5">
            <div>
              <span className="bx-label">1. Select Manual Payment Channel</span>
              <div className="grid grid-cols-3 gap-2">
                {(['bkash', 'nagad', 'rocket'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMethod(m);
                      setError('');
                    }}
                    className="py-2.5 rounded-xl text-xs font-extrabold uppercase border-2"
                    style={{
                      borderColor: method === m ? 'var(--orange)' : 'var(--border-soft)',
                      background: method === m ? 'var(--orange-soft)' : 'var(--surface)',
                      color: 'var(--text)',
                    }}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            <div className="p-3.5 rounded-xl bx-soft space-y-1.5">
              <span className="text-[11px] font-extrabold uppercase block" style={{ color: 'var(--text-2)' }}>
                Send Money Destination ({method.toUpperCase()})
              </span>
              {activeDestination ? (
                <div className="flex items-center justify-between gap-2">
                  <strong className="text-lg font-extrabold tabular-nums">{activeDestination}</strong>
                  <button
                    type="button"
                    onClick={() => {
                      navigator.clipboard?.writeText(activeDestination);
                      onFlash('Payment number copied!');
                    }}
                    className="bx-btn bx-btn-sm"
                  >
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy</span>
                  </button>
                </div>
              ) : (
                <p className="text-xs font-bold" style={{ color: 'var(--red)' }}>
                  Not configured yet — disabled until an administrator sets the {method.toUpperCase()} number in Admin Panel.
                </p>
              )}
              <p className="bx-hint">
                Send the exact BDT amount manually from your app, then submit the Transaction ID below. Balance increases only after admin verification.
              </p>
            </div>

            <div>
              <label htmlFor="dep-amount" className="bx-label">
                Deposit Amount (BDT)
              </label>
              <input
                id="dep-amount"
                type="number"
                min="10"
                inputMode="numeric"
                value={amountBdt}
                onChange={(e) => setAmountBdt(e.target.value)}
                placeholder="Minimum ৳10"
                className="bx-input"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="dep-sender" className="bx-label">
                  Sender Number
                </label>
                <input
                  id="dep-sender"
                  type="tel"
                  value={senderNumber}
                  onChange={(e) => setSenderNumber(e.target.value)}
                  placeholder="01XXXXXXXXX"
                  className="bx-input"
                />
              </div>
              <div>
                <label htmlFor="dep-txid" className="bx-label">
                  Transaction ID (TrxID)
                </label>
                <input
                  id="dep-txid"
                  type="text"
                  value={transactionId}
                  onChange={(e) => setTransactionId(e.target.value)}
                  placeholder="e.g. B9K2M71QA"
                  className="bx-input"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
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
              {screenshotData && <span className="text-xs font-bold" style={{ color: 'var(--green)' }}>Screenshot attached</span>}
            </div>

            <button
              type="submit"
              disabled={busy || !activeDestination}
              className="bx-btn bx-btn-primary w-full"
            >
              <ArrowDownLeft className="w-4 h-4" />
              <span>{busy ? 'Submitting…' : 'Submit Manual Deposit Request'}</span>
            </button>
          </form>
        )}

        {mode === 'withdraw' && (
          <form onSubmit={handleSubmitWithdrawal} className="space-y-3.5">
            <div>
              <label htmlFor="wd-method" className="bx-label">
                Withdrawal Method
              </label>
              <select
                id="wd-method"
                value={withdrawMethod}
                onChange={(e) => setWithdrawMethod(e.target.value as 'bkash' | 'nagad' | 'rocket' | 'bank')}
                className="bx-select"
              >
                <option value="bkash">bKash</option>
                <option value="nagad">Nagad</option>
                <option value="rocket">Rocket</option>
                <option value="bank">Bank Transfer</option>
              </select>
            </div>

            <div>
              <label htmlFor="wd-account" className="bx-label">
                Payout Account / Number
              </label>
              <input
                id="wd-account"
                type="text"
                value={payoutAccount}
                onChange={(e) => setPayoutAccount(e.target.value)}
                placeholder="01XXXXXXXXX or Bank A/C details"
                className="bx-input"
              />
            </div>

            <div>
              <label htmlFor="wd-amount" className="bx-label">
                Amount to Withdraw (BDT, Min ৳10)
              </label>
              <input
                id="wd-amount"
                type="number"
                min="10"
                inputMode="numeric"
                value={withdrawAmountBdt}
                onChange={(e) => setWithdrawAmountBdt(e.target.value)}
                placeholder="e.g. 500"
                className="bx-input"
              />
            </div>

            <button type="submit" disabled={busy} className="bx-btn bx-btn-primary w-full">
              <ArrowUpRight className="w-4 h-4" />
              <span>{busy ? 'Requesting…' : 'Request Manual Withdrawal'}</span>
            </button>
          </form>
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
