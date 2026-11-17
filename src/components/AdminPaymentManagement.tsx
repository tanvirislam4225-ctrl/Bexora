import React, { useEffect, useState, useMemo } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  CheckCircle2,
  CreditCard,
  Globe,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import {
  COUNTRIES_CATALOG,
  CountryCurrencyItem,
  filterCountries,
  DEFAULT_WITHDRAWAL_METHODS,
  WithdrawalMethodSetting,
  convertCurrency,
} from '../lib/countryCurrencyCatalog';
import type { GatewayPaymentMethodSetting } from '../types';
import {
  DEFAULT_GATEWAY_DISPLAY_METHODS,
  moveGatewayDisplayMethod,
  normalizeGatewayPaymentMethods,
  toggleGatewayDisplayMethod,
  upsertGatewayDisplayMethod,
} from '../lib/walletTopupAndReservationLogic';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { buildApiUrl } from '../lib/apiClient';

interface AdminPaymentManagementProps {
  getIdToken: () => Promise<string>;
}

export function AdminPaymentManagement({ getIdToken }: AdminPaymentManagementProps) {
  // 3 Primary Sub-Options: 1) Withdraw, 2) Checkout Gateways, 3) Currency
  const [subOption, setSubOption] = useState<'withdraw' | 'gateways' | 'currency'>('withdraw');

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
  // 2. LIVE GATEWAY CHECKOUT LABELS STATE
  // -------------------------------------------------------------
  const [gatewayMethods, setGatewayMethods] = useState<GatewayPaymentMethodSetting[]>(
    DEFAULT_GATEWAY_DISPLAY_METHODS
  );
  const [showAddGatewayModal, setShowAddGatewayModal] = useState(false);
  const [newGatewayForm, setNewGatewayForm] = useState({
    name: '',
    badge: 'Instant Pay',
    color: '#FF6500',
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
        if (Array.isArray(d.gatewayPaymentMethods) && d.gatewayPaymentMethods.length > 0) {
          setGatewayMethods(normalizeGatewayPaymentMethods(d.gatewayPaymentMethods));
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
      const res = await fetch(buildApiUrl('/api/admin/payments/settings'), {
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

  const handleSaveGatewayPaymentSettings = async () => {
    setSaving(true);
    try {
      const normalized = normalizeGatewayPaymentMethods(gatewayMethods);
      setGatewayMethods(normalized);
      const token = await getIdToken();

      const resp = await fetch(buildApiUrl('/api/admin/payments/settings'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          gatewayPaymentMethods: normalized,
        }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error || 'Backend failed to save gateway display settings.');
      }

      await setDoc(
        doc(db, 'publicConfig', 'settings'),
        {
          gatewayPaymentMethods: normalized,
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );

      notify('Live Checkout Gateway payment labels saved! Enabled labels appear dynamically in Checkout & Wallet.');
    } catch (err) {
      notify(err instanceof Error ? err.message : 'Failed to save gateway display labels.', true);
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

      await fetch(buildApiUrl('/api/admin/payments/settings'), {
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
              setSubOption('gateways');
              setSelectedCountry(null);
            }}
            className={`py-3 px-3 sm:px-4 rounded-xl text-xs sm:text-sm font-black transition-all flex flex-col sm:flex-row items-center justify-center gap-2 text-center ${
              subOption === 'gateways'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'hover:bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <CreditCard className="w-4 h-4 shrink-0" />
            <span>2. Checkout Gateways</span>
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
      {/* SUB-OPTION 2: LIVE CHECKOUT GATEWAY DISPLAY LABELS            */}
      {/* ------------------------------------------------------------- */}
      {subOption === 'gateways' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-white">
                Live Checkout Payment Method Labels
              </h2>
              <p className="text-xs text-[var(--text-2)]">
                Add, rename, enable/disable, or reorder the payment labels displayed under Live Payment Gateway in Checkout &amp; Wallet.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowAddGatewayModal(true)}
                className="bx-btn px-3 py-2 text-xs font-black bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-white flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>Add Payment Label</span>
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveGatewayPaymentSettings}
                className="bx-btn bx-btn-primary px-5 py-2 text-xs font-black flex items-center gap-2"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                <span>Save Gateway Labels</span>
              </button>
            </div>
          </div>

          <div className="space-y-3">
            {gatewayMethods.map((m, idx) => (
              <div
                key={m.id}
                className={`bx-card p-4 border-2 transition-all space-y-3 ${
                  m.enabled
                    ? 'border-[var(--accent)]/40 bg-[var(--surface-2)]/30'
                    : 'border-[var(--border-soft)] opacity-65'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-3 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={m.enabled}
                      onChange={() => setGatewayMethods((prev) => toggleGatewayDisplayMethod(prev, m.id))}
                      className="w-5 h-5 accent-[var(--accent)] rounded cursor-pointer"
                    />
                    <span
                      className="w-3 h-3 rounded-full shrink-0 border border-white/20"
                      style={{ background: m.color || '#FF6500' }}
                    />
                    <div>
                      <span className="text-sm font-black text-white block">{m.name}</span>
                      <span className="text-[11px] text-[var(--text-2)]">
                        {m.enabled ? 'Visible on Checkout & Wallet' : 'Hidden from Checkout & Wallet'}
                      </span>
                    </div>
                  </label>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={idx === 0}
                      onClick={() => setGatewayMethods((prev) => moveGatewayDisplayMethod(prev, m.id, 'up'))}
                      className="p-1.5 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] disabled:opacity-40"
                      title="Move Up"
                      aria-label={`Move ${m.name} up`}
                    >
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      disabled={idx === gatewayMethods.length - 1}
                      onClick={() => setGatewayMethods((prev) => moveGatewayDisplayMethod(prev, m.id, 'down'))}
                      className="p-1.5 rounded-lg bg-[var(--surface-2)] hover:bg-[var(--surface-3)] disabled:opacity-40"
                      title="Move Down"
                      aria-label={`Move ${m.name} down`}
                    >
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setGatewayMethods((prev) =>
                          prev
                            .filter((x) => x.id !== m.id)
                            .map((item, nextOrder) => ({ ...item, order: nextOrder }))
                        );
                      }}
                      className="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg"
                      title="Remove Label"
                      aria-label={`Remove ${m.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[var(--border-soft)]">
                  <div>
                    <label className="block text-[11px] font-extrabold mb-1 text-white">
                      Display Name
                    </label>
                    <input
                      type="text"
                      value={m.name}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGatewayMethods((prev) =>
                          prev.map((item) => (item.id === m.id ? { ...item, name: val } : item))
                        );
                      }}
                      className="bx-input w-full px-3 py-1.5 text-xs font-bold"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-extrabold mb-1 text-white">
                      Badge Subtitle
                    </label>
                    <input
                      type="text"
                      value={m.badge}
                      onChange={(e) => {
                        const val = e.target.value;
                        setGatewayMethods((prev) =>
                          prev.map((item) => (item.id === m.id ? { ...item, badge: val } : item))
                        );
                      }}
                      className="bx-input w-full px-3 py-1.5 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] font-extrabold mb-1 text-white">
                      Accent Color (Hex)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={/^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : '#FF6500'}
                        onChange={(e) => {
                          const val = e.target.value;
                          setGatewayMethods((prev) =>
                            prev.map((item) => (item.id === m.id ? { ...item, color: val } : item))
                          );
                        }}
                        className="w-9 h-8 rounded border border-[var(--border-soft)] bg-transparent cursor-pointer shrink-0"
                        aria-label={`Accent color for ${m.name}`}
                      />
                      <input
                        type="text"
                        value={m.color}
                        onChange={(e) => {
                          const val = e.target.value;
                          setGatewayMethods((prev) =>
                            prev.map((item) => (item.id === m.id ? { ...item, color: val } : item))
                          );
                        }}
                        className="bx-input w-full px-3 py-1.5 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {showAddGatewayModal && (
            <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bx-card p-6 max-w-md w-full space-y-4 border border-[var(--accent)]/40">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-black text-white">Add Live Gateway Payment Label</h3>
                  <button
                    type="button"
                    onClick={() => setShowAddGatewayModal(false)}
                    className="p-1 text-[var(--text-2)] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-extrabold mb-1">Display Name</label>
                    <input
                      type="text"
                      value={newGatewayForm.name}
                      onChange={(e) => setNewGatewayForm({ ...newGatewayForm, name: e.target.value })}
                      placeholder="e.g. Upay, Visa / Mastercard, Apple Pay"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-extrabold mb-1">Badge Subtitle</label>
                    <input
                      type="text"
                      value={newGatewayForm.badge}
                      onChange={(e) => setNewGatewayForm({ ...newGatewayForm, badge: e.target.value })}
                      placeholder="e.g. Mobile Wallet or Instant Cards"
                      className="bx-input w-full px-3 py-2 text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-extrabold mb-1">Accent Color</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="color"
                        value={newGatewayForm.color}
                        onChange={(e) => setNewGatewayForm({ ...newGatewayForm, color: e.target.value })}
                        className="w-10 h-9 rounded border border-[var(--border-soft)] bg-transparent cursor-pointer"
                      />
                      <input
                        type="text"
                        value={newGatewayForm.color}
                        onChange={(e) => setNewGatewayForm({ ...newGatewayForm, color: e.target.value })}
                        className="bx-input w-full px-3 py-2 text-xs font-mono"
                      />
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setShowAddGatewayModal(false)}
                    className="bx-btn px-4 py-2 text-xs bg-[var(--surface-2)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!newGatewayForm.name.trim()) {
                        notify('Gateway display name is required.', true);
                        return;
                      }
                      const cleanId = `${newGatewayForm.name
                        .trim()
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36).slice(-4)}`;
                      setGatewayMethods((prev) =>
                        upsertGatewayDisplayMethod(prev, {
                          id: cleanId,
                          name: newGatewayForm.name.trim(),
                          badge: newGatewayForm.badge.trim() || 'Instant Pay',
                          color: newGatewayForm.color,
                          enabled: true,
                        })
                      );
                      setShowAddGatewayModal(false);
                      setNewGatewayForm({ name: '', badge: 'Instant Pay', color: '#FF6500' });
                      notify('Label added. Click "Save Gateway Labels" to publish to Checkout & Wallet.');
                    }}
                    className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black"
                  >
                    Add Label
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
