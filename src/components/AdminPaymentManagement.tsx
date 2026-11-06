import React, { useEffect, useState, useMemo } from 'react';
import {
  CreditCard,
  Plus,
  RefreshCw,
  Search,
  Check,
  X,
  AlertTriangle,
  ExternalLink,
  Copy,
  ToggleLeft,
  ToggleRight,
  DollarSign,
  ShieldCheck,
  Clock,
  ArrowRight,
  Layers,
  Edit2,
  Trash2,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import type { ManualPaymentMethod, LivePaymentLink, ManualPaymentRequest } from '../lib/paymentManagementLogic';
import { validateLivePaymentLinkInput } from '../lib/paymentManagementLogic';

interface AdminPaymentManagementProps {
  getIdToken: () => Promise<string>;
}

export function AdminPaymentManagement({ getIdToken }: AdminPaymentManagementProps) {
  const [activeTab, setActiveTab] = useState<'manual' | 'live_links' | 'requests'>('manual');
  const [loading, setLoading] = useState<boolean>(false);
  const [actionSuccess, setActionSuccess] = useState<string>('');
  const [actionError, setActionError] = useState<string>('');

  // -------------------------------------------------------------
  // TAB 1: MANUAL PAYMENT METHODS STATE
  // -------------------------------------------------------------
  const [manualMethods, setManualMethods] = useState<ManualPaymentMethod[]>([]);
  const [isAddingMethod, setIsAddingMethod] = useState<boolean>(false);
  const [editingMethodId, setEditingMethodId] = useState<string | null>(null);
  const [methodFormData, setMethodFormData] = useState({
    name: '',
    type: 'bkash' as ManualPaymentMethod['type'],
    accountNumber: '',
    accountHolder: '',
    instructions: '',
    logoUrl: '',
    displayOrder: 1,
    enabled: true,
  });

  // -------------------------------------------------------------
  // TAB 2: LIVE PAYMENT LINKS STATE
  // -------------------------------------------------------------
  const [liveLinks, setLiveLinks] = useState<LivePaymentLink[]>([]);
  const [totalLinksCount, setTotalLinksCount] = useState<number>(0);
  const [linksPage, setLinksPage] = useState<number>(1);
  const [linksPageSize] = useState<number>(50);
  const [linksTotalPages, setLinksTotalPages] = useState<number>(1);
  const [searchSerial, setSearchSerial] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');

  const [usdtRate, setUsdtRate] = useState<number>(125);
  const [livePaymentLinksEnabled, setLivePaymentLinksEnabled] = useState<boolean>(true);
  const [manualPaymentEnabled, setManualPaymentEnabled] = useState<boolean>(true);
  const [isSavingSettings, setIsSavingSettings] = useState<boolean>(false);

  // New Link Input Form
  const [newLinkSerial, setNewLinkSerial] = useState<string>('');
  const [newLinkUrl, setNewLinkUrl] = useState<string>('');
  const [newLinkEnabled, setNewLinkEnabled] = useState<boolean>(true);
  const [isSubmittingLink, setIsSubmittingLink] = useState<boolean>(false);

  // -------------------------------------------------------------
  // TAB 3: MANUAL VERIFICATION REQUESTS STATE
  // -------------------------------------------------------------
  const [requests, setRequests] = useState<ManualPaymentRequest[]>([]);
  const [requestsFilter, setRequestsFilter] = useState<'pending' | 'confirmed' | 'rejected' | 'all'>('pending');
  const [rejectingRequestId, setRejectingRequestId] = useState<string | null>(null);
  const [rejectionReasonInput, setRejectionReasonInput] = useState<string>('');
  const [isConfirmingId, setIsConfirmingId] = useState<string | null>(null);

  // Helper for flash messages
  const notify = (msg: string, isErr = false) => {
    if (isErr) {
      setActionError(msg);
      setTimeout(() => setActionError(''), 6000);
    } else {
      setActionSuccess(msg);
      setTimeout(() => setActionSuccess(''), 5000);
    }
  };

  // -------------------------------------------------------------
  // API FETCHERS
  // -------------------------------------------------------------
  const fetchSettingsAndManualMethods = async () => {
    setLoading(true);
    try {
      const token = await getIdToken();
      // Public / settings
      const cfgRes = await fetch('/api/payments/public-config');
      if (cfgRes.ok) {
        const cfgData = await cfgRes.json();
        if (cfgData.usdtToBdtRate) setUsdtRate(cfgData.usdtToBdtRate);
        if (typeof cfgData.livePaymentLinksEnabled === 'boolean') setLivePaymentLinksEnabled(cfgData.livePaymentLinksEnabled);
        if (typeof cfgData.manualPaymentEnabled === 'boolean') setManualPaymentEnabled(cfgData.manualPaymentEnabled);
      }

      // Admin manual methods
      const mRes = await fetch('/api/admin/payments/manual-methods', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (mRes.ok) {
        const mData = await mRes.json();
        setManualMethods(mData.methods || []);
      }
    } catch {
      notify('Failed to load manual payment methods.', true);
    } finally {
      setLoading(false);
    }
  };

  const fetchLiveLinks = async (page = linksPage, search = searchSerial, status = statusFilter) => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(linksPageSize),
        statusFilter: status,
      });
      if (search.trim()) params.set('searchSerial', search.trim());

      const res = await fetch(`/api/admin/payments/live-links?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setLiveLinks(data.links || []);
        setTotalLinksCount(data.totalCount || 0);
        setLinksPage(data.page || 1);
        setLinksTotalPages(data.totalPages || 1);
      } else {
        notify('Failed to load live payment links.', true);
      }
    } catch {
      notify('Network error fetching live payment links.', true);
    } finally {
      setLoading(false);
    }
  };

  const fetchRequests = async (status = requestsFilter) => {
    setLoading(true);
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/manual-requests?status=${status}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setRequests(data.requests || []);
      }
    } catch {
      notify('Failed to load manual payment requests.', true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'manual') {
      void fetchSettingsAndManualMethods();
    } else if (activeTab === 'live_links') {
      void fetchLiveLinks(1);
    } else if (activeTab === 'requests') {
      void fetchRequests(requestsFilter);
    }
  }, [activeTab]);

  // Count pending requests for tab badge
  const pendingRequestsCount = useMemo(() => {
    return requests.filter((r) => r.status === 'pending').length;
  }, [requests]);

  // -------------------------------------------------------------
  // TAB 1: MANUAL METHODS ACTIONS
  // -------------------------------------------------------------
  const handleSaveMethod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!methodFormData.name.trim() || !methodFormData.accountNumber.trim()) {
      notify('Method Name and Account Number are required.', true);
      return;
    }

    try {
      const token = await getIdToken();
      let res: Response;
      if (editingMethodId) {
        res = await fetch(`/api/admin/payments/manual-methods/${editingMethodId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(methodFormData),
        });
      } else {
        res = await fetch('/api/admin/payments/manual-methods', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(methodFormData),
        });
      }

      const data = await res.json();
      if (res.ok && data.ok) {
        notify(editingMethodId ? 'Manual payment method updated!' : 'Manual payment method added!');
        setIsAddingMethod(false);
        setEditingMethodId(null);
        setMethodFormData({
          name: '',
          type: 'bkash',
          accountNumber: '',
          accountHolder: '',
          instructions: '',
          logoUrl: '',
          displayOrder: manualMethods.length + 1,
          enabled: true,
        });
        void fetchSettingsAndManualMethods();
      } else {
        notify(data.error || 'Failed to save method.', true);
      }
    } catch {
      notify('Network error saving payment method.', true);
    }
  };

  const handleToggleMethodStatus = async (method: ManualPaymentMethod) => {
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/manual-methods/${method.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ enabled: !method.enabled }),
      });
      if (res.ok) {
        notify(`Method ${!method.enabled ? 'Enabled' : 'Disabled'}`);
        void fetchSettingsAndManualMethods();
      }
    } catch {
      notify('Failed to update method status.', true);
    }
  };

  const handleDeleteMethod = async (id: string, name: string) => {
    if (!window.confirm(`Are you sure you want to delete "${name}"?`)) return;
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/manual-methods/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        notify('Payment method deleted.');
        void fetchSettingsAndManualMethods();
      }
    } catch {
      notify('Failed to delete method.', true);
    }
  };

  const startEditMethod = (m: ManualPaymentMethod) => {
    setEditingMethodId(m.id);
    setMethodFormData({
      name: m.name,
      type: m.type,
      accountNumber: m.accountNumber,
      accountHolder: m.accountHolder || '',
      instructions: m.instructions || '',
      logoUrl: m.logoUrl || '',
      displayOrder: m.displayOrder || 1,
      enabled: m.enabled,
    });
    setIsAddingMethod(true);
  };

  // -------------------------------------------------------------
  // TAB 2: LIVE PAYMENT LINKS ACTIONS
  // -------------------------------------------------------------
  const handleSaveSettings = async () => {
    if (usdtRate < 1) {
      notify('USDT rate must be at least 1 BDT.', true);
      return;
    }
    setIsSavingSettings(true);
    try {
      const token = await getIdToken();
      const res = await fetch('/api/admin/payments/settings', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          usdtToBdtRate: usdtRate,
          livePaymentLinksEnabled,
          manualPaymentEnabled,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        notify('Payment settings and USDT exchange rate saved successfully!');
      } else {
        notify(data.error || 'Failed to save settings.', true);
      }
    } catch {
      notify('Network error saving settings.', true);
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleAddLiveLink = async (e: React.FormEvent) => {
    e.preventDefault();
    const validation = validateLivePaymentLinkInput(newLinkSerial, newLinkUrl);
    if (!validation.valid) {
      notify(validation.error, true);
      return;
    }

    setIsSubmittingLink(true);
    try {
      const token = await getIdToken();
      const res = await fetch('/api/admin/payments/live-links', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          serialNumber: validation.serialNumber,
          paymentUrl: validation.paymentUrl,
          enabled: newLinkEnabled,
        }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        notify(`Live link for Serial #${validation.serialNumber} (${validation.serialNumber} BDT) saved!`);
        setNewLinkSerial('');
        setNewLinkUrl('');
        setNewLinkEnabled(true);
        void fetchLiveLinks(1);
      } else {
        notify(data.error || 'Failed to add live payment link.', true);
      }
    } catch {
      notify('Network error adding live payment link.', true);
    } finally {
      setIsSubmittingLink(false);
    }
  };

  const handleToggleLiveLink = async (link: LivePaymentLink) => {
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/live-links/${link.serialNumber}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ enabled: !link.enabled }),
      });
      if (res.ok) {
        notify(`Serial #${link.serialNumber} is now ${!link.enabled ? 'Active' : 'Disabled'}`);
        void fetchLiveLinks();
      }
    } catch {
      notify('Failed to update live link status.', true);
    }
  };

  const handleDeleteLiveLink = async (serial: number) => {
    if (!window.confirm(`Delete payment link for Serial #${serial} (${serial} BDT)?`)) return;
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/live-links/${serial}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        notify(`Live link Serial #${serial} deleted.`);
        void fetchLiveLinks();
      }
    } catch {
      notify('Failed to delete live link.', true);
    }
  };

  // -------------------------------------------------------------
  // TAB 3: VERIFICATION REQUESTS ACTIONS
  // -------------------------------------------------------------
  const handleConfirmRequest = async (req: ManualPaymentRequest) => {
    if (!window.confirm(`Confirm payment of ${req.currency === 'BDT' ? `${req.expectedAmountMinor / 100} BDT` : `${(req.expectedAmountMinor / 100).toFixed(2)} USD`} for deal "${req.listingTitle}"?\n\nThis will instantly activate the Escrow Deal Room.`)) {
      return;
    }

    setIsConfirmingId(req.id);
    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/manual-requests/${req.id}/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        notify(`Payment verified! Deal room activated with Ledger ID: ${data.ledgerId}`);
        void fetchRequests();
      } else {
        notify(data.error || 'Failed to verify payment.', true);
      }
    } catch {
      notify('Network error verifying payment.', true);
    } finally {
      setIsConfirmingId(null);
    }
  };

  const handleRejectRequest = async () => {
    if (!rejectingRequestId) return;
    const reason = rejectionReasonInput.trim();
    if (!reason) {
      notify('Please provide a reason for rejecting this payment.', true);
      return;
    }

    try {
      const token = await getIdToken();
      const res = await fetch(`/api/admin/payments/manual-requests/${rejectingRequestId}/reject`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        notify('Payment proof rejected and buyer notified.');
        setRejectingRequestId(null);
        setRejectionReasonInput('');
        void fetchRequests();
      } else {
        notify(data.error || 'Failed to reject payment request.', true);
      }
    } catch {
      notify('Network error rejecting payment.', true);
    }
  };

  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    notify(`${label} copied to clipboard!`);
  };

  return (
    <div className="space-y-6">
      {/* Top Banner / Notifications */}
      {actionSuccess && (
        <div className="p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
            <span>{actionSuccess}</span>
          </div>
          <button onClick={() => setActionSuccess('')} className="p-1 hover:opacity-75">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {actionError && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs font-bold flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-rose-400" />
            <span>{actionError}</span>
          </div>
          <button onClick={() => setActionError('')} className="p-1 hover:opacity-75">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Primary Tab Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-soft)] pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('manual')}
            className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
              activeTab === 'manual'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            <span>1. Manual Payment Numbers</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('live_links')}
            className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 ${
              activeTab === 'live_links'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>2. Live Payment Links (Reusable)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('requests')}
            className={`px-4 py-2 rounded-xl text-xs font-black transition-all flex items-center gap-2 relative ${
              activeTab === 'requests'
                ? 'bg-[var(--accent)] text-white shadow-md shadow-[var(--accent)]/20'
                : 'bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>3. Payment Verification Requests</span>
            {pendingRequestsCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full text-[10px] font-black bg-amber-500 text-slate-950">
                {pendingRequestsCount}
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={() => {
            if (activeTab === 'manual') void fetchSettingsAndManualMethods();
            else if (activeTab === 'live_links') void fetchLiveLinks();
            else void fetchRequests();
          }}
          className="p-2 rounded-xl bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white transition-colors"
          title="Refresh Data"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* ------------------------------------------------------------- */}
      {/* TAB 1: MANUAL PAYMENT NUMBERS                                */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'manual' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-black text-white">Manual Payment Numbers</h2>
              <p className="text-xs text-[var(--text-2)]">
                Manage personal/merchant mobile banking accounts and crypto wallets displayed to buyers during Manual Payment checkout.
              </p>
            </div>
            {!isAddingMethod && (
              <button
                type="button"
                onClick={() => {
                  setEditingMethodId(null);
                  setMethodFormData({
                    name: '',
                    type: 'bkash',
                    accountNumber: '',
                    accountHolder: '',
                    instructions: '',
                    logoUrl: '',
                    displayOrder: manualMethods.length + 1,
                    enabled: true,
                  });
                  setIsAddingMethod(true);
                }}
                className="bx-btn bx-btn-primary px-4 py-2 text-xs font-black flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>Add Payment Method</span>
              </button>
            )}
          </div>

          {/* Add / Edit Form Modal or Inline */}
          {isAddingMethod && (
            <div className="bx-card p-6 border-2 border-[var(--accent)]/40 space-y-4">
              <div className="flex items-center justify-between border-b border-[var(--border-soft)] pb-3">
                <h3 className="text-sm font-black text-white">
                  {editingMethodId ? 'Edit Manual Payment Method' : 'Add New Manual Payment Method'}
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setIsAddingMethod(false);
                    setEditingMethodId(null);
                  }}
                  className="p-1 rounded-lg hover:bg-[var(--surface-2)] text-[var(--text-2)]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <form onSubmit={handleSaveMethod} className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Method Name <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={methodFormData.name}
                      onChange={(e) => setMethodFormData({ ...methodFormData, name: e.target.value })}
                      placeholder="e.g. bKash Personal, Nagad Merchant"
                      className="bx-input w-full px-3.5 py-2 text-xs"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Method Type
                    </label>
                    <select
                      value={methodFormData.type}
                      onChange={(e) => setMethodFormData({ ...methodFormData, type: e.target.value as ManualPaymentMethod['type'] })}
                      className="bx-input w-full px-3.5 py-2 text-xs"
                    >
                      <option value="bkash">bKash</option>
                      <option value="nagad">Nagad</option>
                      <option value="rocket">Rocket</option>
                      <option value="binance">Binance Pay / USDT</option>
                      <option value="bank">Bank Transfer</option>
                      <option value="custom">Custom Other</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Account / Wallet Number <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={methodFormData.accountNumber}
                      onChange={(e) => setMethodFormData({ ...methodFormData, accountNumber: e.target.value })}
                      placeholder="018XXXXXXXX or USDT TRC20 Address"
                      className="bx-input w-full px-3.5 py-2 text-xs font-mono"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Account Holder Name / Desk Note
                    </label>
                    <input
                      type="text"
                      value={methodFormData.accountHolder}
                      onChange={(e) => setMethodFormData({ ...methodFormData, accountHolder: e.target.value })}
                      placeholder="e.g. Bexora Escrow Desk"
                      className="bx-input w-full px-3.5 py-2 text-xs"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-xs font-extrabold mb-1">
                      Payment Instructions for Buyer
                    </label>
                    <textarea
                      rows={2}
                      value={methodFormData.instructions}
                      onChange={(e) => setMethodFormData({ ...methodFormData, instructions: e.target.value })}
                      placeholder="e.g. Send Money (Personal) and enter your Transaction ID (TrxID) below."
                      className="bx-input w-full px-3.5 py-2 text-xs"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold mb-1">
                      Display Order
                    </label>
                    <input
                      type="number"
                      value={methodFormData.displayOrder}
                      onChange={(e) => setMethodFormData({ ...methodFormData, displayOrder: parseInt(e.target.value, 10) || 1 })}
                      className="bx-input w-full px-3.5 py-2 text-xs"
                    />
                  </div>

                  <div className="flex items-center gap-2 pt-6">
                    <label className="flex items-center gap-2 text-xs font-extrabold cursor-pointer">
                      <input
                        type="checkbox"
                        checked={methodFormData.enabled}
                        onChange={(e) => setMethodFormData({ ...methodFormData, enabled: e.target.checked })}
                        className="w-4 h-4 accent-[var(--accent)]"
                      />
                      <span>Active / Available for Checkout</span>
                    </label>
                  </div>
                </div>

                <div className="flex items-center gap-2 justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => {
                      setIsAddingMethod(false);
                      setEditingMethodId(null);
                    }}
                    className="bx-btn px-4 py-2 text-xs font-extrabold bg-[var(--surface-2)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="bx-btn bx-btn-primary px-5 py-2 text-xs font-black"
                  >
                    {editingMethodId ? 'Update Method' : 'Save Method'}
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* Methods List */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {manualMethods.map((m) => (
              <div
                key={m.id}
                className={`bx-card p-5 space-y-3 border transition-all ${
                  m.enabled ? 'border-[var(--border-soft)]' : 'border-dashed border-[var(--border-soft)] opacity-60'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <span className="w-8 h-8 rounded-lg bg-[var(--surface-2)] border border-[var(--border-soft)] flex items-center justify-center text-xs font-black uppercase text-[var(--accent)]">
                      {m.type.slice(0, 2)}
                    </span>
                    <div>
                      <h4 className="text-sm font-black text-white">{m.name}</h4>
                      <p className="text-[11px] text-[var(--text-2)] capitalize">{m.type} Method • Order: {m.displayOrder}</p>
                    </div>
                  </div>

                  <span
                    className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full border ${
                      m.enabled
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20'
                    }`}
                  >
                    {m.enabled ? 'Active' : 'Disabled'}
                  </span>
                </div>

                {/* Account Details */}
                <div className="p-2.5 rounded-lg bg-[var(--surface-2)]/60 border border-[var(--border-soft)] flex items-center justify-between gap-2">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-[var(--text-2)] block">Account Number</span>
                    <span className="text-xs font-black font-mono text-white select-all">{m.accountNumber}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => copyToClipboard(m.accountNumber, 'Account Number')}
                    className="p-1.5 rounded bg-[var(--surface-1)] hover:bg-[var(--accent)] hover:text-white transition-colors text-[var(--text-2)]"
                    title="Copy Account Number"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>
                </div>

                {m.accountHolder && (
                  <p className="text-xs text-[var(--text-2)]">
                    <strong className="text-white">Holder / Note:</strong> {m.accountHolder}
                  </p>
                )}

                {m.instructions && (
                  <p className="text-[11px] text-[var(--text-2)] italic bg-[var(--surface-2)]/30 p-2 rounded border border-[var(--border-soft)]">
                    &quot;{m.instructions}&quot;
                  </p>
                )}

                {/* Card Controls */}
                <div className="flex items-center justify-between pt-2 border-t border-[var(--border-soft)]">
                  <button
                    type="button"
                    onClick={() => handleToggleMethodStatus(m)}
                    className="text-xs font-bold flex items-center gap-1.5 hover:text-white text-[var(--text-2)] transition-colors"
                  >
                    {m.enabled ? (
                      <>
                        <ToggleRight className="w-4 h-4 text-emerald-400" />
                        <span>Enabled</span>
                      </>
                    ) : (
                      <>
                        <ToggleLeft className="w-4 h-4 text-zinc-500" />
                        <span>Disabled</span>
                      </>
                    )}
                  </button>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => startEditMethod(m)}
                      className="p-1.5 rounded-lg hover:bg-[var(--surface-2)] text-[var(--text-2)] hover:text-white transition-colors"
                      title="Edit Method"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteMethod(m.id, m.name)}
                      className="p-1.5 rounded-lg hover:bg-rose-500/10 text-rose-400 transition-colors"
                      title="Delete Method"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 2: LIVE PAYMENT LINKS (REUSABLE)                          */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'live_links' && (
        <div className="space-y-6">
          {/* Header & Global Settings */}
          <div className="bx-card p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-black text-white">USDT Exchange Rate & Reusable Link Rules</h2>
                <p className="text-xs text-[var(--text-2)]">
                  Permanent links mapping directly to exact BDT payable amounts: <code className="text-amber-400 font-bold">Serial Number == Exact Payable BDT Amount</code>.
                </p>
              </div>
              <span className="text-[11px] font-black uppercase px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Zero Fallback Tolerance
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              <div className="p-3.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border-soft)] space-y-2">
                <label htmlFor="bx-usdt-rate" className="block text-xs font-extrabold text-white">
                  1 USDT / USD to BDT Exchange Rate
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-black text-[var(--text-2)]">1 USDT =</span>
                  <input
                    id="bx-usdt-rate"
                    type="number"
                    min="1"
                    step="0.01"
                    value={usdtRate}
                    onChange={(e) => setUsdtRate(parseFloat(e.target.value) || 1)}
                    className="bx-input w-28 px-3 py-1.5 text-xs font-black text-white"
                  />
                  <span className="text-xs font-black text-[var(--text-2)]">BDT</span>
                </div>
                <p className="text-[10px] text-[var(--text-2)]">
                  e.g. 5 USDT @ 125 = 625 BDT (matches Serial #625).
                </p>
              </div>

              <div className="p-3.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border-soft)] space-y-2">
                <span className="block text-xs font-extrabold text-white">Feature Toggles</span>
                <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={livePaymentLinksEnabled}
                    onChange={(e) => setLivePaymentLinksEnabled(e.target.checked)}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  <span>Live Payment Links Enabled</span>
                </label>
                <label className="flex items-center gap-2 text-xs font-bold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={manualPaymentEnabled}
                    onChange={(e) => setManualPaymentEnabled(e.target.checked)}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  <span>Manual Payment Enabled</span>
                </label>
              </div>

              <div className="flex flex-col justify-end">
                <button
                  type="button"
                  onClick={handleSaveSettings}
                  disabled={isSavingSettings}
                  className="bx-btn bx-btn-primary px-5 py-2.5 text-xs font-black flex items-center justify-center gap-2"
                >
                  {isSavingSettings ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  <span>Save Exchange Rate & Settings</span>
                </button>
              </div>
            </div>
          </div>

          {/* Add New Live Link Form */}
          <form onSubmit={handleAddLiveLink} className="bx-card p-5 space-y-4 border border-[var(--accent)]/30">
            <h3 className="text-sm font-black text-white flex items-center gap-2">
              <Plus className="w-4 h-4 text-[var(--accent)]" />
              <span>Add or Update Reusable Live Payment Link</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
              <div className="md:col-span-3">
                <label htmlFor="bx-serial-input" className="block text-xs font-extrabold mb-1">
                  Serial Number (BDT Amount) <span className="text-rose-500">*</span>
                </label>
                <input
                  id="bx-serial-input"
                  type="number"
                  min="1"
                  step="1"
                  value={newLinkSerial}
                  onChange={(e) => setNewLinkSerial(e.target.value)}
                  placeholder="e.g. 10, 145, 625"
                  className="bx-input w-full px-3.5 py-2 text-xs font-bold font-mono"
                  required
                />
              </div>

              <div className="md:col-span-6">
                <label htmlFor="bx-link-url" className="block text-xs font-extrabold mb-1">
                  Permanent Gateway HTTPS URL <span className="text-rose-500">*</span>
                </label>
                <input
                  id="bx-link-url"
                  type="url"
                  value={newLinkUrl}
                  onChange={(e) => setNewLinkUrl(e.target.value)}
                  placeholder="https://pay.example.com/checkout/bexora_625"
                  className="bx-input w-full px-3.5 py-2 text-xs font-mono"
                  required
                />
              </div>

              <div className="md:col-span-3 flex items-center gap-3">
                <label className="flex items-center gap-1.5 text-xs font-bold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newLinkEnabled}
                    onChange={(e) => setNewLinkEnabled(e.target.checked)}
                    className="w-4 h-4 accent-[var(--accent)]"
                  />
                  <span>Active</span>
                </label>

                <button
                  type="submit"
                  disabled={isSubmittingLink}
                  className="bx-btn bx-btn-primary flex-1 py-2 text-xs font-black flex items-center justify-center gap-1.5"
                >
                  {isSubmittingLink ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                  <span>Save Link</span>
                </button>
              </div>
            </div>
            {newLinkSerial && parseInt(newLinkSerial, 10) > 0 && (
              <p className="text-[11px] text-[var(--accent)] font-bold">
                Mapped to exact purchase amount: {parseInt(newLinkSerial, 10)} BDT ({((parseInt(newLinkSerial, 10)) / usdtRate).toFixed(2)} USDT @ rate {usdtRate})
              </p>
            )}
          </form>

          {/* Large-Scale Search and Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-2)]" />
                <input
                  type="text"
                  value={searchSerial}
                  onChange={(e) => setSearchSerial(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void fetchLiveLinks(1, searchSerial, statusFilter);
                  }}
                  placeholder="Search by Serial Number or BDT amount..."
                  className="bx-input w-full pl-9 pr-3.5 py-2 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={() => void fetchLiveLinks(1, searchSerial, statusFilter)}
                className="bx-btn px-3 py-2 text-xs font-bold bg-[var(--surface-2)]"
              >
                Search
              </button>
              {searchSerial && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchSerial('');
                    void fetchLiveLinks(1, '', statusFilter);
                  }}
                  className="p-2 text-xs text-[var(--text-2)] hover:text-white"
                  title="Clear search"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => {
                  const val = e.target.value as 'all' | 'active' | 'disabled';
                  setStatusFilter(val);
                  void fetchLiveLinks(1, searchSerial, val);
                }}
                className="bx-input px-3 py-2 text-xs"
              >
                <option value="all">All Statuses ({totalLinksCount})</option>
                <option value="active">Active Only</option>
                <option value="disabled">Disabled Only</option>
              </select>
            </div>
          </div>

          {/* Paginated Links Table */}
          <div className="bx-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[var(--surface-2)] text-[var(--text-2)] uppercase font-extrabold text-[10px] border-b border-[var(--border-soft)]">
                  <tr>
                    <th className="px-4 py-3">Serial #</th>
                    <th className="px-4 py-3">Exact Amount</th>
                    <th className="px-4 py-3">Payment URL</th>
                    <th className="px-4 py-3 text-center">Times Used</th>
                    <th className="px-4 py-3 text-center">Status</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-soft)] font-medium">
                  {liveLinks.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-[var(--text-2)]">
                        No live payment links found matching your criteria. Add one above!
                      </td>
                    </tr>
                  ) : (
                    liveLinks.map((link) => (
                      <tr key={link.serialNumber} className="hover:bg-[var(--surface-2)]/40 transition-colors">
                        <td className="px-4 py-3">
                          <span className="font-mono font-black text-amber-400 text-sm">
                            #{link.serialNumber}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="font-extrabold text-white">
                            {link.amountBdt} BDT
                          </span>
                          <span className="text-[10px] text-[var(--text-2)] block">
                            ≈ {(link.amountBdt / usdtRate).toFixed(2)} USDT
                          </span>
                        </td>
                        <td className="px-4 py-3 max-w-xs">
                          <div className="flex items-center gap-1.5 font-mono text-[11px] truncate">
                            <a
                              href={link.paymentUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[var(--accent)] hover:underline truncate"
                            >
                              {link.paymentUrl}
                            </a>
                            <button
                              type="button"
                              onClick={() => copyToClipboard(link.paymentUrl, 'Payment URL')}
                              className="p-1 hover:text-white text-[var(--text-2)] shrink-0"
                              title="Copy URL"
                            >
                              <Copy className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-center font-bold font-mono">
                          {link.usageCount || 0}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => handleToggleLiveLink(link)}
                            className={`inline-flex items-center gap-1 text-[10px] font-black uppercase px-2 py-0.5 rounded-full border transition-all ${
                              link.enabled
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-zinc-500/10 text-zinc-400 border-zinc-500/30'
                            }`}
                          >
                            {link.enabled ? 'Active' : 'Disabled'}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleDeleteLiveLink(link.serialNumber)}
                            className="p-1.5 rounded hover:bg-rose-500/10 text-rose-400 transition-colors"
                            title="Delete Link"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination Controls */}
            {linksTotalPages > 1 && (
              <div className="p-3.5 border-t border-[var(--border-soft)] flex items-center justify-between text-xs">
                <span className="text-[var(--text-2)]">
                  Showing page <strong className="text-white">{linksPage}</strong> of{' '}
                  <strong className="text-white">{linksTotalPages}</strong> ({totalLinksCount} total records)
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={linksPage <= 1}
                    onClick={() => void fetchLiveLinks(linksPage - 1)}
                    className="bx-btn px-3 py-1.5 text-xs bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    disabled={linksPage >= linksTotalPages}
                    onClick={() => void fetchLiveLinks(linksPage + 1)}
                    className="bx-btn px-3 py-1.5 text-xs bg-[var(--surface-2)] disabled:opacity-40"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------- */}
      {/* TAB 3: PAYMENT VERIFICATION REQUESTS                          */}
      {/* ------------------------------------------------------------- */}
      {activeTab === 'requests' && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-black text-white">Manual Payment Verification Requests</h2>
              <p className="text-xs text-[var(--text-2)]">
                Review submitted Transaction IDs (TrxID) for buyer escrow deposits. Approving an entry atomically starts the Escrow Deal Room.
              </p>
            </div>

            <div className="flex items-center gap-1.5 bg-[var(--surface-2)] p-1 rounded-xl">
              {(['pending', 'confirmed', 'rejected', 'all'] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => {
                    setRequestsFilter(st);
                    void fetchRequests(st);
                  }}
                  className={`px-3 py-1 rounded-lg text-xs font-black capitalize transition-all ${
                    requestsFilter === st
                      ? 'bg-[var(--accent)] text-white shadow-sm'
                      : 'text-[var(--text-2)] hover:text-white'
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>

          {/* Requests Queue */}
          <div className="space-y-3">
            {requests.length === 0 ? (
              <div className="bx-card p-12 text-center text-[var(--text-2)] space-y-2">
                <ShieldCheck className="w-10 h-10 mx-auto text-emerald-400 opacity-60" />
                <p className="text-sm font-bold text-white">No payment verification requests</p>
                <p className="text-xs">There are no {requestsFilter} manual payment proofs in the system.</p>
              </div>
            ) : (
              requests.map((req) => (
                <div
                  key={req.id}
                  className="bx-card p-5 space-y-4 border border-[var(--border-soft)] hover:border-[var(--accent)]/40 transition-colors"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-black text-white text-sm">
                          {req.listingTitle}
                        </span>
                        <span className="text-[10px] font-mono text-[var(--text-2)]">
                          (Deal: {req.dealId})
                        </span>
                      </div>
                      <p className="text-xs text-[var(--text-2)] mt-0.5">
                        Buyer: <strong className="text-white">{req.buyerName}</strong> ({req.buyerEmail || req.buyerUid})
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <span
                        className={`text-[10px] font-black uppercase px-2.5 py-1 rounded-full border ${
                          req.status === 'confirmed'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            : req.status === 'rejected'
                            ? 'bg-rose-500/10 text-rose-400 border-rose-500/30'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                        }`}
                      >
                        {req.status === 'confirmed' ? 'Verified & Funded' : req.status === 'rejected' ? 'Rejected' : 'Pending Verification'}
                      </span>
                      <span className="text-[11px] text-[var(--text-2)] font-mono">
                        {new Date(req.createdAtMs).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Financial & Proof Breakdown */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 p-3.5 rounded-xl bg-[var(--surface-2)]/60 border border-[var(--border-soft)]">
                    <div>
                      <span className="text-[10px] font-bold text-[var(--text-2)] uppercase block">Expected Amount</span>
                      <span className="text-sm font-black text-white">
                        {req.currency === 'BDT'
                          ? `${req.expectedAmountMinor / 100} BDT`
                          : `${(req.expectedAmountMinor / 100).toFixed(2)} USD (${req.convertedAmountBdt || 0} BDT)`}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] font-bold text-[var(--text-2)] uppercase block">Payment Method</span>
                      <span className="text-xs font-extrabold text-white">{req.methodName}</span>
                      {req.accountNumber && (
                        <span className="text-[10px] font-mono text-[var(--text-2)] block truncate">
                          To: {req.accountNumber}
                        </span>
                      )}
                    </div>

                    <div>
                      <span className="text-[10px] font-bold text-[var(--text-2)] uppercase block">Submitted TrxID / Reference</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs font-black font-mono text-amber-400 bg-amber-400/10 px-2 py-0.5 rounded border border-amber-400/20 select-all">
                          {req.submittedTrxId}
                        </span>
                        <button
                          type="button"
                          onClick={() => copyToClipboard(req.submittedTrxId, 'Transaction ID')}
                          className="p-1 text-[var(--text-2)] hover:text-white"
                          title="Copy TrxID"
                        >
                          <Copy className="w-3 h-3" />
                        </button>
                      </div>
                    </div>

                    <div>
                      <span className="text-[10px] font-bold text-[var(--text-2)] uppercase block">Sender Number / Account</span>
                      <span className="text-xs font-mono text-white">
                        {req.senderNumberOrAccount || 'Not provided'}
                      </span>
                    </div>
                  </div>

                  {/* If Rejected */}
                  {req.status === 'rejected' && req.rejectionReason && (
                    <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300">
                      <strong>Rejection Reason:</strong> {req.rejectionReason}
                    </div>
                  )}

                  {/* Actions for Pending */}
                  {req.status === 'pending' && (
                    <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--border-soft)]">
                      <button
                        type="button"
                        onClick={() => {
                          setRejectingRequestId(req.id);
                          setRejectionReasonInput('Transaction ID could not be verified in BEXORA payment records.');
                        }}
                        className="bx-btn px-4 py-2 text-xs font-extrabold bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/30 flex items-center gap-1.5"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Reject</span>
                      </button>

                      <button
                        type="button"
                        disabled={isConfirmingId === req.id}
                        onClick={() => handleConfirmRequest(req)}
                        className="bx-btn bx-btn-primary px-5 py-2 text-xs font-black flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500"
                      >
                        {isConfirmingId === req.id ? (
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5" />
                        )}
                        <span>Confirm & Activate Escrow</span>
                      </button>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Rejection Modal */}
          {rejectingRequestId && (
            <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bx-card p-6 max-w-md w-full space-y-4 border border-rose-500/40">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-black text-rose-400 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    <span>Reject Manual Payment</span>
                  </h3>
                  <button
                    type="button"
                    onClick={() => setRejectingRequestId(null)}
                    className="p-1 text-[var(--text-2)] hover:text-white"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <p className="text-xs text-[var(--text-2)]">
                  Please specify why this payment could not be confirmed. The buyer will receive a notification and will be prompted to re-submit or use another payment method.
                </p>

                <textarea
                  rows={3}
                  value={rejectionReasonInput}
                  onChange={(e) => setRejectionReasonInput(e.target.value)}
                  placeholder="Enter rejection reason..."
                  className="bx-input w-full p-3 text-xs"
                />

                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setRejectingRequestId(null)}
                    className="bx-btn px-4 py-2 text-xs font-bold bg-[var(--surface-2)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleRejectRequest}
                    className="bx-btn px-4 py-2 text-xs font-black bg-rose-600 text-white hover:bg-rose-500"
                  >
                    Confirm Rejection
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
