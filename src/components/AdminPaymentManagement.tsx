import React, { useEffect, useState, useMemo } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Copy,
  DollarSign,
  Globe,
  Info,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  XCircle,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import {
  COUNTRIES_CATALOG,
  CountryCurrencyItem,
  filterCountries,
  DEFAULT_WITHDRAWAL_METHODS,
  DEFAULT_MANUAL_PAYMENT_METHODS,
  WithdrawalMethodSetting,
  ManualPaymentMethodSetting,
  convertCurrency,
} from '../lib/countryCurrencyCatalog';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';

interface AdminPaymentManagementProps {
  getIdToken: () => Promise<string>;
}

export function AdminPaymentManagement({ getIdToken }: AdminPaymentManagementProps) {
  // 3 Primary Sub-Options mandated by user prompt: 1) Withdraw, 2) Manual Payment, 3) Currency
  const [subOption, setSubOption] = useState<'withdraw' | 'manual' | 'currency'>('withdraw');

  // Flash Notifications
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const notify = (msg: string, isErr = false) => {
    if (isErr) {
      setErrorMsg(msg);
      setTimeout(() => setErrorMsg(''), 6000);
    } else {
      setSuccessMsg(msg);
      setTimeout(() => setSuccessMsg(''), 5000);
    }
  };

  // -------------------------------------------------------------
  // 1. WITHDRAW STATE
  // -------------------------------------------------------------
  const [withdrawalMethods, setWithdrawalMethods] = useState<WithdrawalMethodSetting[]>(DEFAULT_WITHDRAWAL_METHODS);
  const [showAddWithdrawModal, setShowAddWithdrawModal] = useState(false);
  const [newWithdrawForm, setNewWithdrawForm] = useState({
    id: '',
    name: '',
    currency: 'BDT',
    minLimit: 500,
    instructions: '',
    accountPlaceholder: '',
    badge: 'Custom Payout',
  });

  // -------------------------------------------------------------
  // 2. MANUAL PAYMENT (ADD BALANCE) STATE
  // -------------------------------------------------------------
  const [manualMethods, setManualMethods] = useState<ManualPaymentMethodSetting[]>(DEFAULT_MANUAL_PAYMENT_METHODS);
  const [showAddManualModal, setShowAddManualModal] = useState(false);
  const [newManualForm, setNewManualForm] = useState({
    id: '',
    name: '',
    type: 'custom',
    receivingNumber: '',
    accountHolder: '',
    instructions: '1. Transfer the exact amount to the number above.\n2. Note down your Transaction ID.\n3. Enter the TrxID and your sender account number in the verification form.',
    minDeposit: 10,
    badge: 'Manual Gateway',
    color: '#005BAC',
  });

  // -------------------------------------------------------------
  // 3. CURRENCY (COUNTRY-WISE EXCHANGE RATE) STATE
  // -------------------------------------------------------------
  const [countrySearch, setCountrySearch] = useState('');
  const [selectedCountry, setSelectedCountry] = useState<CountryCurrencyItem | null>(null);
  const [activeCountryCode, setActiveCountryCode] = useState('BD');
  const [countryRates, setCountryRates] = useState<Record<string, number>>({
    BD: 125,
    US: 1,
    IN: 86.5,
    GB: 0.78,
    AE: 3.67,
    SA: 3.75,
    EU: 0.92,
  });
  const [countryInputRate, setCountryInputRate] = useState<number>(125);

  // Conversion test inputs
  const [testUsdtAmount, setTestUsdtAmount] = useState<number>(10);
  const [testLocalAmount, setTestLocalAmount] = useState<number>(1250);

  // -------------------------------------------------------------
  // INITIAL DATA LOADING
  // -------------------------------------------------------------
  const loadPaymentSettings = async () => {
    setLoading(true);
    try {
      // Fetch from Firestore publicConfig/settings
      const snap = await getDoc(doc(db, 'publicConfig', 'settings'));
      if (snap.exists()) {
        const d = snap.data();
        if (Array.isArray(d.withdrawalMethods) && d.withdrawalMethods.length > 0) {
          setWithdrawalMethods(d.withdrawalMethods);
        }
        if (Array.isArray(d.manualPaymentConfig) && d.manualPaymentConfig.length > 0) {
          setManualMethods(d.manualPaymentConfig);
        } else if (d.bkashNumber || d.nagadNumber || d.rocketNumber) {
          // Merge legacy numbers into defaults
          setManualMethods((prev) =>
            prev.map((m) => {
              if (m.id === 'bkash' && d.bkashNumber) return { ...m, receivingNumber: String(d.bkashNumber) };
              if (m.id === 'nagad' && d.nagadNumber) return { ...m, receivingNumber: String(d.nagadNumber) };
              if (m.id === 'rocket' && d.rocketNumber) return { ...m, receivingNumber: String(d.rocketNumber) };
              return m;
            })
          );
        }
        if (d.countryRates && typeof d.countryRates === 'object') {
          setCountryRates((prev) => ({ ...prev, ...d.countryRates }));
        }
        if (d.activeCountryCode) {
          setActiveCountryCode(String(d.activeCountryCode));
        }
        if (d.usdToBdtRate || d.usdtToBdtRate) {
          const r = Number(d.usdToBdtRate ?? d.usdtToBdtRate);
          setCountryRates((prev) => ({ ...prev, BD: r }));
        }
      }
    } catch (err) {
      console.error('Error loading payment settings:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadPaymentSettings();
  }, []);

  // When selected country changes, sync rate input
  useEffect(() => {
    if (selectedCountry) {
      const currentRate = countryRates[selectedCountry.code] ?? selectedCountry.defaultRateToUsdt;
      setCountryInputRate(currentRate);
      setTestUsdtAmount(10);
      setTestLocalAmount(Math.round(10 * currentRate * 100) / 100);
    }
  }, [selectedCountry, countryRates]);

  // -------------------------------------------------------------
  // SAVE HANDLERS
  // -------------------------------------------------------------
  const handleSaveWithdrawalSettings = async () => {
    setSaving(true);
    try {
      const token = await getIdToken();
      // Try API route first
      const res = await fetch('/api/admin/payments/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ withdrawalMethods }),
      });

      // Also persist directly to Firestore publicConfig/settings
      await setDoc(
        doc(db, 'publicConfig', 'settings'),
        {
          withdrawalMethods,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      notify('Withdrawal settings & limits saved! Changes are now live on user withdraw pages.');
    } catch (err) {
      notify('Failed to save withdrawal settings.', true);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveManualPaymentSettings = async () => {
    setSaving(true);
    try {
      const token = await getIdToken();
      // Sync legacy top-level numbers
      const bkash = manualMethods.find((m) => m.type === 'bkash');
      const nagad = manualMethods.find((m) => m.type === 'nagad');
      const rocket = manualMethods.find((m) => m.type === 'rocket');

      await fetch('/api/admin/payments/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          manualPaymentConfig: manualMethods,
          bkashNumber: bkash?.receivingNumber || '',
          nagadNumber: nagad?.receivingNumber || '',
          rocketNumber: rocket?.receivingNumber || '',
        }),
      });

      // Also persist directly to Firestore
      await setDoc(
        doc(db, 'publicConfig', 'settings'),
        {
          manualPaymentConfig: manualMethods,
          bkashNumber: bkash?.receivingNumber || '',
          nagadNumber: nagad?.receivingNumber || '',
          rocketNumber: rocket?.receivingNumber || '',
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      notify('Manual Payment (Add Balance) methods saved! Active methods are now displayed to users.');
    } catch (err) {
      notify('Failed to save manual payment settings.', true);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCountryRate = async () => {
    if (!selectedCountry) return;
    if (!Number.isFinite(countryInputRate) || countryInputRate <= 0) {
      notify('Please enter a valid positive exchange rate.', true);
      return;
    }

    setSaving(true);
    try {
      const token = await getIdToken();
      const updatedRates = {
        ...countryRates,
        [selectedCountry.code]: countryInputRate,
      };
      setCountryRates(updatedRates);

      const payload: Record<string, unknown> = {
        countryRates: updatedRates,
      };

      // If this country is Bangladesh or active base, sync usdToBdtRate / usdtToBdtRate site-wide
      if (selectedCountry.code === 'BD' || activeCountryCode === selectedCountry.code) {
        payload.usdToBdtRate = countryInputRate;
        payload.usdtToBdtRate = countryInputRate;
      }

      await fetch('/api/admin/payments/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });

      // Also persist to Firestore
      await setDoc(
        doc(db, 'publicConfig', 'settings'),
        {
          ...payload,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      notify(
        `Exchange rate updated! 1 USDT = ${countryInputRate} ${selectedCountry.currencyCode} is now active site-wide.`
      );
    } catch (err) {
      notify('Failed to save exchange rate.', true);
    } finally {
      setSaving(false);
    }
  };

  const handleSetActiveBaseCountry = async (country: CountryCurrencyItem) => {
    setActiveCountryCode(country.code);
    const rate = countryRates[country.code] ?? country.defaultRateToUsdt;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        activeCountryCode: country.code,
        usdToBdtRate: country.currencyCode === 'BDT' ? rate : countryRates['BD'] || 125,
        usdtToBdtRate: rate,
      };
      await setDoc(
        doc(db, 'publicConfig', 'settings'),
        {
          ...payload,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
      notify(`${country.name} (${country.currencyCode}) is now set as the primary base country!`);
    } catch (err) {
      notify('Failed to set active base country.', true);
    } finally {
      setSaving(false);
    }
  };

  // Filtered countries list
  const filteredCountriesList = useMemo(() => {
    return filterCountries(COUNTRIES_CATALOG, countrySearch);
  }, [countrySearch]);

  const activeCountryObj = useMemo(() => {
    return COUNTRIES_CATALOG.find((c) => c.code === activeCountryCode) || COUNTRIES_CATALOG[0];
  }, [activeCountryCode]);

  return (
    <div className="space-y-6">
      {/* Toast Feedback */}
      {successMsg && (
        <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{successMsg}</span>
          </div>
          <button onClick={() => setSuccessMsg('')} className="p-1 hover:opacity-75">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {errorMsg && (
        <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
          <button onClick={() => setErrorMsg('')} className="p-1 hover:opacity-75">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* 1. PAYMENT MENU — EXACT 3 SUB-OPTIONS */}
      <div className="bx-card p-2 sm:p-2.5">
        <div className="grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => {
              setSubOption('withdraw');
              setSelectedCountry(null);
            }}
            className={`py-3 px-3 sm:px-4 rounded-xl text-xs sm:text-sm font-black transition-all flex flex-col sm:flex-row items-center justify-center gap-2 text-center ${
              subOption === 'withdraw'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'hover:bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <ArrowUpRight className="w-4 h-4 shrink-0" />
            <span>1. Withdraw</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSubOption('manual');
              setSelectedCountry(null);
            }}
            className={`py-3 px-3 sm:px-4 rounded-xl text-xs sm:text-sm font-black transition-all flex flex-col sm:flex-row items-center justify-center gap-2 text-center ${
              subOption === 'manual'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'hover:bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <ArrowDownLeft className="w-4 h-4 shrink-0" />
            <span>2. Manual Payment</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSubOption('currency');
            }}
            className={`py-3 px-3 sm:px-4 rounded-xl text-xs sm:text-sm font-black transition-all flex flex-col sm:flex-row items-center justify-center gap-2 text-center ${
              subOption === 'currency'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'hover:bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <Globe className="w-4 h-4 shrink-0" />
            <span>3. Currency</span>
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* SUB-OPTION 1: WITHDRAW                                        */}
      {/* ------------------------------------------------------------- */}
      {subOption === 'withdraw' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-white">Withdrawal Methods & Minimum Limits</h2>
              <p className="text-xs text-[var(--text-2)]">
                Select which withdrawal options users can choose to withdraw their balance, and set the minimum limit for each.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddWithdrawModal(true)}
                className="bx-btn px-3 py-2 text-xs font-black bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Withdrawal Method</span>
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveWithdrawalSettings}
                className="bx-btn bx-btn-primary px-5 py-2 text-xs font-black flex items-center gap-2"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>Save Withdrawal Settings</span>
              </button>
            </div>
          </div>

          {/* Methods List */}
          <div className="space-y-4">
            {withdrawalMethods.map((m, idx) => {
              const isChecked = m.enabled;
              return (
                <div
                  key={m.id}
                  className={`bx-card p-5 space-y-4 border-2 transition-all ${
                    isChecked
                      ? 'border-[var(--accent)]/40 bg-[var(--surface-2)]/30'
                      : 'border-[var(--border-soft)] opacity-60 bg-[var(--surface-1)]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          const updated = [...withdrawalMethods];
                          updated[idx] = { ...m, enabled: e.target.checked };
                          setWithdrawalMethods(updated);
                        }}
                        className="w-5 h-5 accent-[var(--accent)] rounded cursor-pointer"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-base font-black text-white">{m.name}</span>
                          <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--accent)] border border-[var(--border-soft)]">
                            {m.currency}
                          </span>
                        </div>
                        <span className="text-[11px] text-[var(--text-2)]">
                          {isChecked ? 'Enabled for user withdrawals' : 'Disabled (Users cannot see this method)'}
                        </span>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full border ${
                          isChecked
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30'
                        }`}
                      >
                        {isChecked ? 'Active Payout' : 'Disabled'}
                      </span>
                      {m.id.startsWith('custom_') && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete withdrawal method "${m.name}"?`)) {
                              setWithdrawalMethods(withdrawalMethods.filter((x) => x.id !== m.id));
                            }
                          }}
                          className="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
                          title="Delete Method"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Settings fields (Visible when enabled) */}
                  {isChecked && (
                    <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-3 border-t border-[var(--border-soft)]">
                      <div className="md:col-span-4">
                        <label className="block text-xs font-extrabold mb-1 text-white">
                          Minimum Withdrawal Limit ({m.currency}) <span className="text-rose-500">*</span>
                        </label>
                        <div className="relative">
                          <input
                            type="number"
                            min="1"
                            value={m.minLimit}
                            onChange={(e) => {
                              const val = Math.max(1, parseFloat(e.target.value) || 1);
                              const updated = [...withdrawalMethods];
                              updated[idx] = { ...m, minLimit: val };
                              setWithdrawalMethods(updated);
                            }}
                            className="bx-input w-full px-3 py-2 text-xs font-black font-mono"
                          />
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-black text-[var(--text-2)]">
                            {m.currency}
                          </span>
                        </div>
                        <p className="text-[10px] text-[var(--text-2)] mt-1">
                          Users cannot submit requests below this amount.
                        </p>
                      </div>

                      <div className="md:col-span-4">
                        <label className="block text-xs font-extrabold mb-1 text-white">
                          Account Placeholder Text
                        </label>
                        <input
                          type="text"
                          value={m.accountPlaceholder || ''}
                          onChange={(e) => {
                            const updated = [...withdrawalMethods];
                            updated[idx] = { ...m, accountPlaceholder: e.target.value };
                            setWithdrawalMethods(updated);
                          }}
                          placeholder="e.g. 01XXXXXXXXX"
                          className="bx-input w-full px-3 py-2 text-xs font-mono"
                        />
                      </div>

                      <div className="md:col-span-4">
                        <label className="block text-xs font-extrabold mb-1 text-white">
                          Payout Instructions / Notice
                        </label>
                        <input
                          type="text"
                          value={m.instructions || ''}
                          onChange={(e) => {
                            const updated = [...withdrawalMethods];
                            updated[idx] = { ...m, instructions: e.target.value };
                            setWithdrawalMethods(updated);
                          }}
                          placeholder="e.g. Payout processed within 1-6 hours."
                          className="bx-input w-full px-3 py-2 text-xs"
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add Custom Withdrawal Method Modal */}
          {showAddWithdrawModal && (
            <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bx-card p-6 max-w-md w-full space-y-4 border border-[var(--accent)]/40">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-black text-white">Add New Withdrawal Method</h3>
                  <button onClick={() => setShowAddWithdrawModal(false)} className="p-1 text-[var(--text-2)] hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-extrabold mb-1">Method Name</label>
                    <input
                      type="text"
                      value={newWithdrawForm.name}
                      onChange={(e) => setNewWithdrawForm({ ...newWithdrawForm, name: e.target.value })}
                      placeholder="e.g. Upay Personal, Cellfin, PayPal"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Currency</label>
                    <select
                      value={newWithdrawForm.currency}
                      onChange={(e) => setNewWithdrawForm({ ...newWithdrawForm, currency: e.target.value })}
                      className="bx-input w-full px-3 py-2 text-xs"
                    >
                      <option value="BDT">BDT (৳)</option>
                      <option value="USDT">USDT (₮)</option>
                      <option value="USD">USD ($)</option>
                      <option value="INR">INR (₹)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Minimum Withdrawal Limit</label>
                    <input
                      type="number"
                      min="1"
                      value={newWithdrawForm.minLimit}
                      onChange={(e) => setNewWithdrawForm({ ...newWithdrawForm, minLimit: parseFloat(e.target.value) || 10 })}
                      className="bx-input w-full px-3 py-2 text-xs font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Account Field Placeholder</label>
                    <input
                      type="text"
                      value={newWithdrawForm.accountPlaceholder}
                      onChange={(e) => setNewWithdrawForm({ ...newWithdrawForm, accountPlaceholder: e.target.value })}
                      placeholder="e.g. 01XXXXXXXXX or Wallet Address"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Instructions / Note</label>
                    <input
                      type="text"
                      value={newWithdrawForm.instructions}
                      onChange={(e) => setNewWithdrawForm({ ...newWithdrawForm, instructions: e.target.value })}
                      placeholder="e.g. Processed within 1-6 hours"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddWithdrawModal(false)}
                    className="bx-btn px-4 py-2 text-xs bg-[var(--surface-2)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!newWithdrawForm.name.trim()) {
                        notify('Method name is required.', true);
                        return;
                      }
                      const id = `custom_${Date.now()}`;
                      setWithdrawalMethods([
                        ...withdrawalMethods,
                        {
                          id,
                          name: newWithdrawForm.name.trim(),
                          currency: newWithdrawForm.currency,
                          enabled: true,
                          minLimit: newWithdrawForm.minLimit,
                          instructions: newWithdrawForm.instructions.trim(),
                          accountPlaceholder: newWithdrawForm.accountPlaceholder.trim(),
                        },
                      ]);
                      setShowAddWithdrawModal(false);
                      setNewWithdrawForm({
                        id: '',
                        name: '',
                        currency: 'BDT',
                        minLimit: 500,
                        instructions: '',
                        accountPlaceholder: '',
                        badge: 'Custom Payout',
                      });
                      notify(`Added "${newWithdrawForm.name.trim()}". Remember to click "Save Withdrawal Settings" to make it live!`);
                    }}
                    className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black"
                  >
                    Add Method
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SUB-OPTION 2: MANUAL PAYMENT (HOW USERS ADD BALANCE)          */}
      {/* ------------------------------------------------------------- */}
      {subOption === 'manual' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-white">Manual Payment (Add Balance Destinations)</h2>
              <p className="text-xs text-[var(--text-2)]">
                Check which payment methods are available. Enter your receiving number and step-by-step instructions for each checked method.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddManualModal(true)}
                className="bx-btn px-3 py-2 text-xs font-black bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Payment Method</span>
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveManualPaymentSettings}
                className="bx-btn bx-btn-primary px-5 py-2 text-xs font-black flex items-center gap-2"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>Save Manual Payment Settings</span>
              </button>
            </div>
          </div>

          {/* Methods List */}
          <div className="space-y-4">
            {manualMethods.map((m, idx) => {
              const isChecked = m.enabled;
              return (
                <div
                  key={m.id}
                  className={`bx-card p-5 space-y-4 border-2 transition-all ${
                    isChecked
                      ? 'border-[var(--accent)]/40 bg-[var(--surface-2)]/30'
                      : 'border-[var(--border-soft)] opacity-60 bg-[var(--surface-1)]'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="flex items-center gap-3 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          const updated = [...manualMethods];
                          updated[idx] = { ...m, enabled: e.target.checked };
                          setManualMethods(updated);
                        }}
                        className="w-5 h-5 accent-[var(--accent)] rounded cursor-pointer"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-base font-black text-white">{m.name}</span>
                          {m.badge && (
                            <span className="text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-[var(--surface-2)] text-[var(--accent)] border border-[var(--border-soft)]">
                              {m.badge}
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-[var(--text-2)]">
                          {isChecked ? 'Active on user Add Balance page' : 'Disabled (Hidden on user side)'}
                        </span>
                      </div>
                    </label>

                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full border ${
                          isChecked && m.receivingNumber.trim()
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30'
                        }`}
                      >
                        {isChecked && m.receivingNumber.trim() ? 'Active Receiving Number' : 'Incomplete / Disabled'}
                      </span>
                      {m.id.startsWith('custom_') && (
                        <button
                          type="button"
                          onClick={() => {
                            if (window.confirm(`Delete manual payment method "${m.name}"?`)) {
                              setManualMethods(manualMethods.filter((x) => x.id !== m.id));
                            }
                          }}
                          className="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
                          title="Delete Method"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Input fields appear when method is checked */}
                  {isChecked && (
                    <div className="space-y-4 pt-3 border-t border-[var(--border-soft)]">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-extrabold mb-1 text-white">
                            Receiving Number / Wallet Address <span className="text-rose-500">*</span>
                          </label>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              value={m.receivingNumber}
                              onChange={(e) => {
                                const updated = [...manualMethods];
                                updated[idx] = { ...m, receivingNumber: e.target.value };
                                setManualMethods(updated);
                              }}
                              placeholder="018XXXXXXXX or Binance Pay ID / USDT TRC20"
                              className="bx-input w-full px-3.5 py-2 text-xs font-mono font-bold text-white select-all"
                            />
                            {m.receivingNumber && (
                              <button
                                type="button"
                                onClick={() => {
                                  void navigator.clipboard.writeText(m.receivingNumber);
                                  notify('Receiving number copied to clipboard!');
                                }}
                                className="p-2 rounded-xl bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white shrink-0"
                                title="Test Copy Button"
                              >
                                <Copy className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                          <p className="text-[10px] text-[var(--text-2)] mt-1">
                            Users will see this number with a one-tap Copy button.
                          </p>
                        </div>

                        <div>
                          <label className="block text-xs font-extrabold mb-1 text-white">
                            Account Holder Name / Desk Reference
                          </label>
                          <input
                            type="text"
                            value={m.accountHolder || ''}
                            onChange={(e) => {
                              const updated = [...manualMethods];
                              updated[idx] = { ...m, accountHolder: e.target.value };
                              setManualMethods(updated);
                            }}
                            placeholder="e.g. Bexora Official Escrow Desk"
                            className="bx-input w-full px-3.5 py-2 text-xs"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-extrabold mb-1 text-white">
                          Step-by-Step Instructions on how to Send Money (Editable)
                        </label>
                        <textarea
                          rows={4}
                          value={m.instructions}
                          onChange={(e) => {
                            const updated = [...manualMethods];
                            updated[idx] = { ...m, instructions: e.target.value };
                            setManualMethods(updated);
                          }}
                          placeholder="Write step-by-step instructions for the user..."
                          className="bx-input w-full p-3 text-xs leading-relaxed font-sans"
                        />
                        <span className="text-[10px] text-[var(--text-2)] block mt-0.5">
                          Formatted with numbered steps on the user&apos;s deposit page.
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Add Custom Manual Method Modal */}
          {showAddManualModal && (
            <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bx-card p-6 max-w-lg w-full space-y-4 border border-[var(--accent)]/40">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-black text-white">Add New Manual Payment Method</h3>
                  <button onClick={() => setShowAddManualModal(false)} className="p-1 text-[var(--text-2)] hover:text-white">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-extrabold mb-1">Method Name</label>
                    <input
                      type="text"
                      value={newManualForm.name}
                      onChange={(e) => setNewManualForm({ ...newManualForm, name: e.target.value })}
                      placeholder="e.g. Upay Personal, Cellfin, Cash App"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Receiving Number / Address</label>
                    <input
                      type="text"
                      value={newManualForm.receivingNumber}
                      onChange={(e) => setNewManualForm({ ...newManualForm, receivingNumber: e.target.value })}
                      placeholder="01XXXXXXXXX"
                      className="bx-input w-full px-3 py-2 text-xs font-mono"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Account Holder / Desk Note</label>
                    <input
                      type="text"
                      value={newManualForm.accountHolder}
                      onChange={(e) => setNewManualForm({ ...newManualForm, accountHolder: e.target.value })}
                      placeholder="e.g. Bexora Official"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">Step-by-Step Instructions</label>
                    <textarea
                      rows={3}
                      value={newManualForm.instructions}
                      onChange={(e) => setNewManualForm({ ...newManualForm, instructions: e.target.value })}
                      className="bx-input w-full p-2.5 text-xs"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddManualModal(false)}
                    className="bx-btn px-4 py-2 text-xs bg-[var(--surface-2)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!newManualForm.name.trim() || !newManualForm.receivingNumber.trim()) {
                        notify('Method name and receiving number are required.', true);
                        return;
                      }
                      const id = `custom_${Date.now()}`;
                      setManualMethods([
                        ...manualMethods,
                        {
                          id,
                          name: newManualForm.name.trim(),
                          type: 'custom',
                          enabled: true,
                          receivingNumber: newManualForm.receivingNumber.trim(),
                          accountHolder: newManualForm.accountHolder.trim(),
                          instructions: newManualForm.instructions.trim(),
                          minDeposit: newManualForm.minDeposit,
                          badge: 'Manual Gateway',
                        },
                      ]);
                      setShowAddManualModal(false);
                      setNewManualForm({
                        id: '',
                        name: '',
                        type: 'custom',
                        receivingNumber: '',
                        accountHolder: '',
                        instructions: '1. Transfer the exact amount to the number above.\n2. Note down your Transaction ID.\n3. Enter the TrxID and your sender account number in the verification form.',
                        minDeposit: 10,
                        badge: 'Manual Gateway',
                        color: '#005BAC',
                      });
                      notify(`Added "${newManualForm.name.trim()}". Click "Save Manual Payment Settings" to make it live!`);
                    }}
                    className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black"
                  >
                    Add Method
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* SUB-OPTION 3: CURRENCY (COUNTRY-WISE EXCHANGE RATE)           */}
      {/* ------------------------------------------------------------- */}
      {subOption === 'currency' && (
        <div className="space-y-6">
          {/* Active Base Rate Banner */}
          <div className="bx-card p-5 border-2 border-[var(--accent)]/30 bg-[var(--surface-2)]/30 flex flex-wrap items-center justify-between gap-4">
            <div>
              <span className="text-[10px] font-black uppercase text-[var(--accent)] tracking-wider block">
                Site-Wide Active Conversion Rate
              </span>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-2xl">{activeCountryObj.flagEmoji}</span>
                <div>
                  <h3 className="text-base font-black text-white">
                    1 USDT = <span className="text-[var(--accent)]">{countryRates[activeCountryObj.code] ?? 125}</span> {activeCountryObj.currencyCode} ({activeCountryObj.name})
                  </h3>
                  <p className="text-xs text-[var(--text-2)]">
                    This exchange rate is applied across the whole website for balances, escrow calculations, deposits, and withdrawals.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="px-3 py-1.5 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-black flex items-center gap-1.5">
                <Check className="w-4 h-4" />
                <span>Active Live Rate</span>
              </span>
            </div>
          </div>

          {/* VIEW A: COUNTRY DEDICATED CONVERSION PAGE (when country is selected) */}
          {selectedCountry ? (
            <div className="bx-card p-6 space-y-6 border border-[var(--accent)]/40">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-soft)] pb-4">
                <button
                  type="button"
                  onClick={() => setSelectedCountry(null)}
                  className="bx-btn px-3 py-1.5 text-xs font-extrabold bg-[var(--surface-2)] text-white hover:bg-[var(--surface-3)] inline-flex items-center gap-1.5"
                >
                  <span>← Back to Countries List</span>
                </button>

                <div className="flex items-center gap-2">
                  {activeCountryCode === selectedCountry.code ? (
                    <span className="px-3 py-1 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-black flex items-center gap-1.5">
                      <Check className="w-3.5 h-3.5" />
                      <span>Primary Base Country</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => handleSetActiveBaseCountry(selectedCountry)}
                      className="bx-btn px-3 py-1.5 text-xs font-black bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white"
                    >
                      Set as Primary Base Country
                    </button>
                  )}
                </div>
              </div>

              {/* Country Header */}
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedCountry.flagEmoji}</span>
                <div>
                  <h3 className="text-xl font-black text-white">
                    {selectedCountry.name} Exchange Rate ({selectedCountry.currencyCode})
                  </h3>
                  <p className="text-xs text-[var(--text-2)]">
                    Configure how many {selectedCountry.currencyCode} equals 1 USDT.
                  </p>
                </div>
              </div>

              {/* 2 LARGE BOXES: LOCAL CURRENCY & USDT */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* BOX 1: LOCAL CURRENCY */}
                <div className="p-6 rounded-2xl bg-[var(--surface-2)] border-2 border-[var(--accent)]/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase text-[var(--accent)] tracking-wider">
                      Box 1 · Local Currency ({selectedCountry.currencyCode})
                    </span>
                    <span className="text-lg font-black text-white">{selectedCountry.currencySymbol}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      step="any"
                      min="0.0001"
                      value={countryInputRate}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0;
                        setCountryInputRate(val);
                        setTestLocalAmount(Math.round(testUsdtAmount * val * 100) / 100);
                      }}
                      className="bx-input w-full px-4 py-3 text-2xl font-black font-mono text-white bg-[var(--surface-1)]"
                    />
                    <span className="text-base font-black text-white shrink-0">
                      {selectedCountry.currencyCode}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-2)]">
                    Enter the amount of {selectedCountry.currencyCode} equal to 1 USDT.
                  </p>
                </div>

                {/* BOX 2: USDT */}
                <div className="p-6 rounded-2xl bg-[var(--surface-2)] border-2 border-emerald-500/40 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-black uppercase text-emerald-400 tracking-wider">
                      Box 2 · USDT (Tether Crypto)
                    </span>
                    <span className="text-lg font-black text-emerald-400">₮ / $</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="bx-input w-full px-4 py-3 text-2xl font-black font-mono text-emerald-400 bg-[var(--surface-1)]">
                      1.00
                    </div>
                    <span className="text-base font-black text-white shrink-0">USDT</span>
                  </div>
                  <p className="text-xs text-[var(--text-2)]">
                    Standard dollar-pegged stablecoin base unit.
                  </p>
                </div>
              </div>

              {/* Rate Summary Equation */}
              <div className="p-4 rounded-xl bg-[var(--surface-2)] border border-[var(--border-soft)] flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 font-mono text-sm sm:text-base font-black">
                  <span className="text-emerald-400">1 USDT</span>
                  <span className="text-[var(--text-2)]">=</span>
                  <span className="text-[var(--accent)] font-extrabold">{countryInputRate} {selectedCountry.currencyCode}</span>
                </div>

                <button
                  type="button"
                  disabled={saving}
                  onClick={handleSaveCountryRate}
                  className="bx-btn bx-btn-primary px-6 py-2.5 text-xs font-black flex items-center gap-2"
                >
                  {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>Save Exchange Rate</span>
                </button>
              </div>

              {/* Interactive Live Conversion Preview */}
              <div className="p-5 rounded-2xl bg-[var(--surface-2)]/40 border border-[var(--border-soft)] space-y-3">
                <span className="text-xs font-extrabold text-white block">
                  Interactive Rate Preview
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="p-3.5 rounded-xl bg-[var(--surface-1)] border border-[var(--border-soft)] space-y-1.5">
                    <label className="text-[11px] font-bold text-[var(--text-2)] block">If User Deposits / Holds (USDT):</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={testUsdtAmount}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          setTestUsdtAmount(val);
                          setTestLocalAmount(Math.round(val * countryInputRate * 100) / 100);
                        }}
                        className="bx-input w-28 px-3 py-1.5 text-xs font-bold font-mono"
                      />
                      <span className="text-xs font-bold text-[var(--text-2)]">USDT =</span>
                      <strong className="text-sm font-black text-[var(--accent)]">
                        {Math.round(testUsdtAmount * countryInputRate * 100) / 100} {selectedCountry.currencyCode}
                      </strong>
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-[var(--surface-1)] border border-[var(--border-soft)] space-y-1.5">
                    <label className="text-[11px] font-bold text-[var(--text-2)] block">If User Withdraws / Converts ({selectedCountry.currencyCode}):</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        value={testLocalAmount}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value) || 0;
                          setTestLocalAmount(val);
                          setTestUsdtAmount(countryInputRate > 0 ? Math.round((val / countryInputRate) * 100) / 100 : 0);
                        }}
                        className="bx-input w-28 px-3 py-1.5 text-xs font-bold font-mono"
                      />
                      <span className="text-xs font-bold text-[var(--text-2)]">{selectedCountry.currencyCode} =</span>
                      <strong className="text-sm font-black text-emerald-400">
                        {countryInputRate > 0 ? (testLocalAmount / countryInputRate).toFixed(2) : 0} USDT
                      </strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* VIEW B: COUNTRIES SERIAL LIST & SEARCH BOX */
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative flex-1 max-w-md">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-2)]" />
                  <input
                    type="text"
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    placeholder="Search country, currency, or serial # (e.g. Bangladesh, BDT, India)..."
                    className="bx-input w-full pl-9 pr-3.5 py-2 text-xs"
                  />
                  {countrySearch && (
                    <button
                      type="button"
                      onClick={() => setCountrySearch('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--text-2)] hover:text-white"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                <span className="text-xs text-[var(--text-2)]">
                  Showing <strong>{filteredCountriesList.length}</strong> countries
                </span>
              </div>

              {/* Serial List Table */}
              <div className="bx-card overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-[var(--surface-2)] text-[var(--text-2)] uppercase font-extrabold text-[10px] border-b border-[var(--border-soft)]">
                      <tr>
                        <th className="px-4 py-3 w-16">Serial #</th>
                        <th className="px-4 py-3">Country Name</th>
                        <th className="px-4 py-3">Currency</th>
                        <th className="px-4 py-3">Exchange Rate (vs USDT)</th>
                        <th className="px-4 py-3 text-center">Status</th>
                        <th className="px-4 py-3 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border-soft)] font-medium">
                      {filteredCountriesList.map((country) => {
                        const rate = countryRates[country.code] ?? country.defaultRateToUsdt;
                        const isBase = activeCountryCode === country.code;
                        return (
                          <tr
                            key={country.code}
                            onClick={() => setSelectedCountry(country)}
                            className="hover:bg-[var(--surface-2)]/60 cursor-pointer transition-colors"
                          >
                            <td className="px-4 py-3.5 font-mono font-black text-amber-400">
                              #{country.serial}
                            </td>
                            <td className="px-4 py-3.5">
                              <div className="flex items-center gap-2.5">
                                <span className="text-lg">{country.flagEmoji}</span>
                                <div>
                                  <strong className="text-white block text-sm">{country.name}</strong>
                                  <span className="text-[10px] text-[var(--text-2)] font-mono">{country.code}</span>
                                </div>
                              </div>
                            </td>
                            <td className="px-4 py-3.5">
                              <span className="font-extrabold text-white">
                                {country.currencyCode} ({country.currencySymbol})
                              </span>
                            </td>
                            <td className="px-4 py-3.5 font-mono">
                              <span className="text-xs font-bold text-white">
                                1 USDT = <strong className="text-[var(--accent)] font-black">{rate}</strong> {country.currencyCode}
                              </span>
                            </td>
                            <td className="px-4 py-3.5 text-center">
                              {isBase ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                                  <Check className="w-3 h-3" />
                                  <span>Active Base</span>
                                </span>
                              ) : (
                                <span className="text-[10px] text-[var(--text-2)]">Available</span>
                              )}
                            </td>
                            <td className="px-4 py-3.5 text-right">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedCountry(country);
                                }}
                                className="bx-btn px-3 py-1 text-xs font-extrabold bg-[var(--surface-2)] hover:bg-[var(--accent)] hover:text-white transition-colors"
                              >
                                Set Rate
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
