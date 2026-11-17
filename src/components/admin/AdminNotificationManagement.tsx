import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  CalendarClock,
  Check,
  Edit3,
  Eye,
  Globe,
  Image as ImageIcon,
  Layers,
  Monitor,
  Moon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  UserCheck,
  Users,
  X,
} from 'lucide-react';
import {
  POPUP_FREQUENCY_LABELS,
  POPUP_THEME_LIBRARY,
  computePopupNotificationDashboardStats,
  dhakaInputToUtcMs,
  formatDhakaDateTime,
  getPopupThemePreset,
  mergePopupStyleWithThemeDefaults,
  resolveEffectivePopupStatus,
  sanitizePopupBannerImageUrl,
  utcMsToDhakaInput,
  type PopupNotificationCampaign,
  type PopupNotificationDeliveryMode,
  type PopupNotificationEffectiveStatus,
  type PopupNotificationFrequency,
  type PopupNotificationStoredStatus,
  type PopupNotificationStyleConfig,
  type PopupNotificationTargetUser,
  type PopupNotificationThemeId,
} from '../../lib/popupNotificationLogic';
import { fetchWithFreshBearerToken, validateAndProcessImageFile } from '../../lib/firebase';
import { PopupNotificationModal } from '../PopupNotificationModal';

interface AdminNotificationManagementProps {
  onFlash: (msg: string) => void;
}

interface EditorDraftState {
  editingId: string | null;
  title: string;
  body: string;
  deliveryMode: PopupNotificationDeliveryMode;
  targetUsers: PopupNotificationTargetUser[];
  themeId: PopupNotificationThemeId;
  style: PopupNotificationStyleConfig;
  bannerImageUrl: string;
  frequency: PopupNotificationFrequency;
  scheduleMode: 'immediate' | 'scheduled';
  startDhakaInput: string;
  expiresDhakaInput: string;
}

function createInitialDraft(themeId: PopupNotificationThemeId = 'modern_gradient'): EditorDraftState {
  const preset = getPopupThemePreset(themeId);
  return {
    editingId: null,
    title: preset.defaultTitle,
    body: preset.defaultBody,
    deliveryMode: 'global',
    targetUsers: [],
    themeId,
    style: { ...preset.style },
    bannerImageUrl: '',
    frequency: 'once_per_user',
    scheduleMode: 'immediate',
    startDhakaInput: '',
    expiresDhakaInput: '',
  };
}

function getEffectiveStatusBadge(status: PopupNotificationEffectiveStatus): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'active':
      return {
        label: 'Active',
        className: 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300 border-emerald-600/40',
      };
    case 'scheduled':
      return {
        label: 'Scheduled',
        className: 'bg-sky-600/15 text-sky-700 dark:text-sky-300 border-sky-600/40',
      };
    case 'paused':
      return {
        label: 'Paused',
        className: 'bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-500/50',
      };
    case 'expired':
      return {
        label: 'Expired',
        className: 'bg-red-600/15 text-red-700 dark:text-red-300 border-red-600/40',
      };
    case 'draft':
    default:
      return {
        label: 'Draft',
        className: 'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/35',
      };
  }
}

export const AdminNotificationManagement: React.FC<AdminNotificationManagementProps> = ({
  onFlash,
}) => {
  const [campaigns, setCampaigns] = useState<PopupNotificationCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Table Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | PopupNotificationDeliveryMode>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | PopupNotificationEffectiveStatus>('all');

  // Editor & Modals
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<EditorDraftState>(() => createInitialDraft());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);

  // Live Preview Controls
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [previewBackdropDark, setPreviewBackdropDark] = useState(false);
  const [previewModalCampaign, setPreviewModalCampaign] =
    useState<PopupNotificationCampaign | null>(null);

  // Action Confirmation & Busy State
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PopupNotificationCampaign | null>(null);
  const [deleting, setDeleting] = useState(false);

  // User Picker Search State
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<PopupNotificationTargetUser[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);

  const loadCampaigns = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const resp = await fetchWithFreshBearerToken('/api/admin/popup-notifications');
      const data = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        campaigns?: PopupNotificationCampaign[];
        error?: string;
      } | null;
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error || 'Could not load popup notification campaigns.');
      }
      setCampaigns(Array.isArray(data.campaigns) ? data.campaigns : []);
      setNowMs(Date.now());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Unable to load notifications.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Search users dynamically when Specific User Notification mode is open
  useEffect(() => {
    if (!editorOpen || draft.deliveryMode !== 'targeted') return;
    let cancelled = false;
    const tId = window.setTimeout(() => {
      void (async () => {
        setSearchingUsers(true);
        try {
          const resp = await fetchWithFreshBearerToken(
            `/api/admin/popup-notifications/users?q=${encodeURIComponent(userSearch.trim())}`
          );
          const json = (await resp.json().catch(() => null)) as {
            ok?: boolean;
            users?: PopupNotificationTargetUser[];
          } | null;
          if (!cancelled && json?.ok && Array.isArray(json.users)) {
            setUserResults(json.users);
          }
        } catch {
          // Keep current list cleanly
        } finally {
          if (!cancelled) setSearchingUsers(false);
        }
      })();
    }, 240);
    return () => {
      cancelled = true;
      window.clearTimeout(tId);
    };
  }, [editorOpen, draft.deliveryMode, userSearch]);

  const stats = useMemo(
    () => computePopupNotificationDashboardStats(campaigns, nowMs),
    [campaigns, nowMs]
  );

  const filteredCampaigns = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return campaigns.filter((c) => {
      if (typeFilter !== 'all' && c.deliveryMode !== typeFilter) return false;
      const eff = resolveEffectivePopupStatus(c, nowMs);
      if (statusFilter !== 'all' && eff !== statusFilter) return false;
      if (q) {
        const themeLabel = getPopupThemePreset(c.themeId).label.toLowerCase();
        const matches =
          c.title.toLowerCase().includes(q) ||
          c.body.toLowerCase().includes(q) ||
          themeLabel.includes(q) ||
          c.targetUserIds.some((u) => u.toLowerCase().includes(q));
        if (!matches) return false;
      }
      return true;
    });
  }, [campaigns, typeFilter, statusFilter, searchQuery, nowMs]);

  const openCreateEditor = () => {
    setDraft(createInitialDraft('modern_gradient'));
    setFormError(null);
    setUserSearch('');
    setEditorOpen(true);
  };

  const openEditEditor = (c: PopupNotificationCampaign) => {
    setDraft({
      editingId: c.id,
      title: c.title,
      body: c.body,
      deliveryMode: c.deliveryMode,
      targetUsers:
        c.targetUsers && c.targetUsers.length > 0
          ? c.targetUsers
          : c.targetUserIds.map((uid) => ({
              uid,
              displayName: `Member (${uid.slice(0, 8)})`,
              username: '',
              email: '',
            })),
      themeId: c.themeId,
      style: { ...c.style },
      bannerImageUrl: c.bannerImageUrl || '',
      frequency: c.frequency,
      scheduleMode: c.startAtMs > 0 ? 'scheduled' : 'immediate',
      startDhakaInput: c.startAtMs > 0 ? utcMsToDhakaInput(c.startAtMs) : '',
      expiresDhakaInput: c.expiresAtMs > 0 ? utcMsToDhakaInput(c.expiresAtMs) : '',
    });
    setFormError(null);
    setUserSearch('');
    setEditorOpen(true);
  };

  const handleSelectTheme = (themeId: PopupNotificationThemeId, applySampleCopy = false) => {
    const preset = getPopupThemePreset(themeId);
    setDraft((prev) => ({
      ...prev,
      themeId,
      style: mergePopupStyleWithThemeDefaults(themeId, {
        buttonDestination: prev.style.buttonDestination || preset.style.buttonDestination,
        closeButtonEnabled: prev.style.closeButtonEnabled,
      }),
      title: applySampleCopy || !prev.title.trim() ? preset.defaultTitle : prev.title,
      body: applySampleCopy || !prev.body.trim() ? preset.defaultBody : prev.body,
    }));
  };

  const handleBannerUpload = async (file: File | null) => {
    if (!file) return;
    setUploadingBanner(true);
    setFormError(null);
    try {
      const processed = await validateAndProcessImageFile(file, 960, 0.74, 185_000);
      setDraft((prev) => ({ ...prev, bannerImageUrl: processed }));
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to process banner image.');
    } finally {
      setUploadingBanner(false);
    }
  };

  const toggleTargetUser = (user: PopupNotificationTargetUser) => {
    setDraft((prev) => {
      const exists = prev.targetUsers.some((u) => u.uid === user.uid);
      if (exists) {
        return { ...prev, targetUsers: prev.targetUsers.filter((u) => u.uid !== user.uid) };
      }
      if (prev.targetUsers.length >= 200) {
        setFormError('Maximum 200 targeted recipients per notification.');
        return prev;
      }
      return { ...prev, targetUsers: [...prev.targetUsers, user] };
    });
  };

  const handleSaveCampaign = async (targetStatus: PopupNotificationStoredStatus) => {
    if (saving) return;
    setFormError(null);

    const title = draft.title.trim();
    const body = draft.body.trim();
    if (!title) {
      setFormError('Please enter a notification title.');
      return;
    }
    if (!body) {
      setFormError('Please enter notification description text.');
      return;
    }
    if (draft.deliveryMode === 'targeted' && draft.targetUsers.length === 0) {
      setFormError('Please select at least one recipient user for a Specific User Notification.');
      return;
    }

    const startAtMs =
      draft.scheduleMode === 'scheduled' && draft.startDhakaInput
        ? dhakaInputToUtcMs(draft.startDhakaInput)
        : 0;
    if (draft.scheduleMode === 'scheduled' && draft.startDhakaInput && !startAtMs) {
      setFormError('Invalid Start Date/Time in Asia/Dhaka.');
      return;
    }
    const expiresAtMs = draft.expiresDhakaInput
      ? dhakaInputToUtcMs(draft.expiresDhakaInput)
      : 0;
    if (draft.expiresDhakaInput && !expiresAtMs) {
      setFormError('Invalid Expiration Date/Time in Asia/Dhaka.');
      return;
    }
    if (expiresAtMs > 0 && startAtMs > 0 && expiresAtMs <= startAtMs) {
      setFormError('Expiration Date/Time must be later than the scheduled Start Date/Time.');
      return;
    }

    setSaving(true);
    try {
      const payload = {
        title,
        body,
        deliveryMode: draft.deliveryMode,
        targetUserIds: draft.deliveryMode === 'targeted' ? draft.targetUsers.map((u) => u.uid) : [],
        themeId: draft.themeId,
        style: draft.style,
        bannerImageUrl: sanitizePopupBannerImageUrl(draft.bannerImageUrl),
        frequency: draft.frequency,
        storedStatus: targetStatus,
        startAtMs,
        expiresAtMs,
      };

      const isEdit = Boolean(draft.editingId);
      const url = isEdit
        ? `/api/admin/popup-notifications/${encodeURIComponent(draft.editingId!)}`
        : '/api/admin/popup-notifications';
      const resp = await fetchWithFreshBearerToken(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!resp.ok || !json?.ok) {
        throw new Error(json?.error || 'Could not save notification campaign.');
      }

      setEditorOpen(false);
      await loadCampaigns();
      onFlash(
        targetStatus === 'draft'
          ? 'Notification saved as Draft.'
          : startAtMs > Date.now()
            ? `Notification scheduled for ${formatDhakaDateTime(startAtMs)}.`
            : 'Notification published and live.'
      );
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save notification.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (
    c: PopupNotificationCampaign,
    nextStatus: PopupNotificationStoredStatus
  ) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const resp = await fetchWithFreshBearerToken(
        `/api/admin/popup-notifications/${encodeURIComponent(c.id)}/status`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ storedStatus: nextStatus }),
        }
      );
      const json = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!resp.ok || !json?.ok) {
        throw new Error(json?.error || 'Failed to update notification status.');
      }
      await loadCampaigns();
      onFlash(
        nextStatus === 'active'
          ? `Activated "${c.title}".`
          : nextStatus === 'paused'
            ? `Paused "${c.title}".`
            : `Moved "${c.title}" to Draft.`
      );
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Status update failed.');
    } finally {
      setBusyId(null);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      const resp = await fetchWithFreshBearerToken(
        `/api/admin/popup-notifications/${encodeURIComponent(deleteTarget.id)}`,
        { method: 'DELETE' }
      );
      const json = (await resp.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
      } | null;
      if (!resp.ok || !json?.ok) {
        throw new Error(json?.error || 'Could not delete popup notification.');
      }
      const deletedTitle = deleteTarget.title;
      setDeleteTarget(null);
      await loadCampaigns();
      onFlash(`Deleted popup notification "${deletedTitle}".`);
    } catch (err) {
      onFlash(err instanceof Error ? err.message : 'Unable to delete notification.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bx-card p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[#FF6500] text-xs font-black uppercase tracking-wider">
            <BellRing className="w-4 h-4" />
            <span>Notification Management</span>
          </div>
          <h1 className="text-xl font-black mt-1">
            Website Popup &amp; Targeted User Notifications
          </h1>
          <p className="text-xs opacity-75 mt-1">
            Design themed global popups or confidential user-specific overlays scheduled in Bangladesh Time (Asia/Dhaka).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void loadCampaigns()}
            disabled={loading}
            className="bx-btn bx-btn-sm"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            type="button"
            onClick={openCreateEditor}
            className="bx-btn bx-btn-primary bx-btn-sm"
          >
            <Plus className="w-4 h-4" />
            <span>Create Notification</span>
          </button>
        </div>
      </div>

      {/* 8 KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 tabular-nums">
        {[
          { label: 'Total Notifications', value: stats.total, accent: 'text-[var(--text)]' },
          { label: 'Active Notifications', value: stats.active, accent: 'text-emerald-600 dark:text-emerald-400' },
          { label: 'Scheduled Notifications', value: stats.scheduled, accent: 'text-sky-600 dark:text-sky-400' },
          { label: 'Expired Notifications', value: stats.expired, accent: 'text-red-600 dark:text-red-400' },
          { label: 'Global Notifications', value: stats.globalCount, accent: 'text-[#FF6500]' },
          { label: 'Targeted User Notifications', value: stats.targetedCount, accent: 'text-[#793A91] dark:text-[#C084FC]' },
          { label: 'Total Views', value: stats.totalViews, accent: 'text-[var(--text)]' },
          { label: 'Total Dismissals', value: stats.totalDismissals, accent: 'text-[var(--text-2)]' },
        ].map((kpi) => (
          <div key={kpi.label} className="bx-card p-4">
            <div className="text-[11px] font-bold uppercase tracking-wide opacity-70 truncate">
              {kpi.label}
            </div>
            <div className={`text-2xl font-black mt-1 ${kpi.accent}`}>
              {kpi.value.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {/* Filters & Management Table OR Create/Edit Studio */}
      {editorOpen ? (
        <div className="bx-card p-5 space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-[var(--border-soft)]">
            <div>
              <h2 className="text-lg font-black flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-[#FF6500]" />
                <span>
                  {draft.editingId ? 'Edit Popup Notification' : 'Create New Popup Notification'}
                </span>
              </h2>
              <p className="text-xs opacity-75 mt-0.5">
                Choose audience delivery, pick a starter theme, customize every visual property, and preview live.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setEditorOpen(false)}
              className="bx-btn bx-btn-sm self-start"
            >
              <X className="w-4 h-4" />
              <span>Back to Table</span>
            </button>
          </div>

          {formError && (
            <div
              role="alert"
              className="p-3.5 rounded-xl border-2 border-red-600 bg-red-600/10 text-red-700 dark:text-red-300 text-xs font-bold"
            >
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
            {/* LEFT: Configuration Controls */}
            <div className="xl:col-span-7 space-y-6">
              {/* 1. Delivery Mode & Audience */}
              <div className="bx-soft p-4 space-y-4">
                <h3 className="text-xs font-black uppercase tracking-wider text-[#FF6500]">
                  1. Delivery Mode &amp; Target Audience
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, deliveryMode: 'global' }))}
                    className={`p-3.5 rounded-xl border-2 text-left transition-all ${
                      draft.deliveryMode === 'global'
                        ? 'border-[#FF6500] bg-[#FF6500]/10'
                        : 'border-[var(--border-soft)] bg-[var(--surface)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-black text-sm">
                      <Globe className="w-4 h-4 text-[#FF6500]" />
                      <span>Global Website Notification</span>
                    </div>
                    <p className="text-xs opacity-75 mt-1">
                      Shown automatically when any visitor or member enters the marketplace.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => setDraft((p) => ({ ...p, deliveryMode: 'targeted' }))}
                    className={`p-3.5 rounded-xl border-2 text-left transition-all ${
                      draft.deliveryMode === 'targeted'
                        ? 'border-[#793A91] bg-[#793A91]/10'
                        : 'border-[var(--border-soft)] bg-[var(--surface)]'
                    }`}
                  >
                    <div className="flex items-center gap-2 font-black text-sm">
                      <UserCheck className="w-4 h-4 text-[#793A91] dark:text-[#C084FC]" />
                      <span>Specific User Notification</span>
                    </div>
                    <p className="text-xs opacity-75 mt-1">
                      Delivered privately only to selected accounts; completely isolated from other users.
                    </p>
                  </button>
                </div>

                {draft.deliveryMode === 'targeted' && (
                  <div className="space-y-3 pt-2">
                    <label className="bx-label" htmlFor="popup-user-search">
                      Search Users by Username, Email, or UID ({draft.targetUsers.length} selected)
                    </label>
                    <div className="relative">
                      <Search className="w-4 h-4 opacity-55 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        id="popup-user-search"
                        type="text"
                        value={userSearch}
                        onChange={(e) => setUserSearch(e.target.value)}
                        placeholder="Search @username, email@domain.com, or UID…"
                        className="bx-input pl-9"
                      />
                    </div>

                    {draft.targetUsers.length > 0 && (
                      <div className="flex flex-wrap gap-2 p-2.5 rounded-xl bg-[var(--surface)] border border-[var(--border-soft)]">
                        {draft.targetUsers.map((u) => (
                          <button
                            key={u.uid}
                            type="button"
                            onClick={() => toggleTargetUser(u)}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold bg-[#793A91]/15 text-[#793A91] dark:text-[#E9D5FF] border border-[#793A91]/40 hover:bg-red-500/15 hover:text-red-600"
                            title={`Click to remove ${u.displayName}`}
                          >
                            <span>
                              {u.displayName}
                              {u.username ? ` (@${u.username})` : ''}
                            </span>
                            <X className="w-3 h-3" />
                          </button>
                        ))}
                      </div>
                    )}

                    <div className="max-h-48 overflow-y-auto rounded-xl border border-[var(--border-soft)] bg-[var(--surface)] divide-y divide-[var(--border-soft)]">
                      {searchingUsers ? (
                        <div className="p-3 text-xs opacity-70">Searching registered users…</div>
                      ) : userResults.length === 0 ? (
                        <div className="p-3 text-xs opacity-70">
                          No matching users found for &ldquo;{userSearch || 'all'}&rdquo;.
                        </div>
                      ) : (
                        userResults.map((u) => {
                          const selected = draft.targetUsers.some((sel) => sel.uid === u.uid);
                          return (
                            <button
                              key={u.uid}
                              type="button"
                              onClick={() => toggleTargetUser(u)}
                              className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between gap-2 transition-colors ${
                                selected
                                  ? 'bg-[#793A91]/12 font-bold'
                                  : 'hover:bg-[var(--surface-2)]'
                              }`}
                            >
                              <div className="min-w-0">
                                <div className="font-extrabold truncate">
                                  {u.displayName}{' '}
                                  {u.username && (
                                    <span className="opacity-70 font-mono">@{u.username}</span>
                                  )}
                                </div>
                                <div className="text-[11px] opacity-70 truncate">
                                  {u.email || 'No email'} · <span className="font-mono">{u.uid}</span>
                                </div>
                              </div>
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-black shrink-0 ${
                                  selected
                                    ? 'bg-[#793A91] text-white'
                                    : 'border border-[var(--border-soft)]'
                                }`}
                              >
                                {selected ? 'Selected' : 'Select'}
                              </span>
                            </button>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* 2. 10-Theme Preset Library */}
              <div className="bx-soft p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-xs font-black uppercase tracking-wider text-[#FF6500]">
                    2. Theme Library (10 Editable Starter Themes)
                  </h3>
                  <button
                    type="button"
                    onClick={() => handleSelectTheme(draft.themeId, true)}
                    className="text-[11px] font-extrabold text-[#FF6500] hover:underline"
                  >
                    Load Selected Theme Sample Copy
                  </button>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                  {POPUP_THEME_LIBRARY.map((preset) => {
                    const isSelected = draft.themeId === preset.id;
                    const bg = preset.style.useGradient
                      ? `linear-gradient(${preset.style.gradientDirection}, ${preset.style.gradientFrom}, ${preset.style.gradientTo})`
                      : preset.style.backgroundColor;
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        onClick={() => handleSelectTheme(preset.id, false)}
                        className={`p-2 rounded-xl border-2 text-left transition-all flex flex-col gap-1.5 ${
                          isSelected
                            ? 'border-[#FF6500] ring-2 ring-[#FF6500]/30'
                            : 'border-[var(--border-soft)] bg-[var(--surface)] hover:border-[var(--text-3)]'
                        }`}
                      >
                        <div
                          className="h-7 w-full rounded-md border flex items-center justify-end px-1.5"
                          style={{
                            background: bg,
                            borderColor: preset.style.borderColor,
                          }}
                        >
                          {isSelected && (
                            <Check
                              className="w-3.5 h-3.5"
                              style={{ color: preset.style.textColor }}
                            />
                          )}
                        </div>
                        <span className="text-[11px] font-extrabold leading-tight line-clamp-2">
                          {preset.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 3. Message & Banner Content */}
              <div className="bx-soft p-4 space-y-4">
                <h3 className="text-xs font-black uppercase tracking-wider text-[#FF6500]">
                  3. Content &amp; Optional Banner Image
                </h3>

                <div>
                  <label className="bx-label" htmlFor="popup-title">
                    Notification Title
                  </label>
                  <input
                    id="popup-title"
                    type="text"
                    maxLength={140}
                    value={draft.title}
                    onChange={(e) => setDraft((p) => ({ ...p, title: e.target.value }))}
                    placeholder="Enter popup headline…"
                    className="bx-input"
                  />
                </div>

                <div>
                  <label className="bx-label" htmlFor="popup-body">
                    Description / Message Body
                  </label>
                  <textarea
                    id="popup-body"
                    rows={3}
                    maxLength={2000}
                    value={draft.body}
                    onChange={(e) => setDraft((p) => ({ ...p, body: e.target.value }))}
                    placeholder="Write clear details for your visitors or targeted users…"
                    className="bx-textarea"
                  />
                </div>

                <div className="space-y-2">
                  <label className="bx-label" htmlFor="popup-banner-url">
                    Optional Banner Image (HTTPS URL or Upload)
                  </label>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      id="popup-banner-url"
                      type="text"
                      value={
                        draft.bannerImageUrl.startsWith('data:image/')
                          ? '(Uploaded Image Attached)'
                          : draft.bannerImageUrl
                      }
                      readOnly={draft.bannerImageUrl.startsWith('data:image/')}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, bannerImageUrl: e.target.value }))
                      }
                      placeholder="https://example.com/banner.jpg"
                      className="bx-input flex-1"
                    />
                    <label className="bx-btn bx-btn-sm cursor-pointer shrink-0">
                      <ImageIcon className="w-4 h-4" />
                      <span>{uploadingBanner ? 'Uploading…' : 'Upload Photo'}</span>
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        className="sr-only"
                        disabled={uploadingBanner}
                        onChange={(e) => {
                          void handleBannerUpload(e.target.files?.[0] || null);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {draft.bannerImageUrl && (
                      <button
                        type="button"
                        onClick={() => setDraft((p) => ({ ...p, bannerImageUrl: '' }))}
                        className="bx-btn bx-btn-danger bx-btn-sm shrink-0"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* 4. Visual Customization Controls */}
              <div className="bx-soft p-4 space-y-4">
                <h3 className="text-xs font-black uppercase tracking-wider text-[#FF6500]">
                  4. Typography, Colors, Gradients &amp; Dimensions
                </h3>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="bx-label" htmlFor="popup-font-size">
                      Font Size ({draft.style.fontSizePx}px)
                    </label>
                    <input
                      id="popup-font-size"
                      type="number"
                      min={12}
                      max={24}
                      value={draft.style.fontSizePx}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            fontSizePx: Math.max(12, Math.min(24, Number(e.target.value) || 15)),
                          },
                        }))
                      }
                      className="bx-input"
                    />
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-font-weight">
                      Font Weight
                    </label>
                    <select
                      id="popup-font-weight"
                      value={draft.style.fontWeight}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            fontWeight: e.target.value as PopupNotificationStyleConfig['fontWeight'],
                          },
                        }))
                      }
                      className="bx-select"
                    >
                      <option value="400">Regular (400)</option>
                      <option value="500">Medium (500)</option>
                      <option value="600">Semibold (600)</option>
                      <option value="700">Bold (700)</option>
                      <option value="800">Extrabold (800)</option>
                    </select>
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-align">
                      Text Alignment
                    </label>
                    <select
                      id="popup-align"
                      value={draft.style.textAlign}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            textAlign: e.target.value as PopupNotificationStyleConfig['textAlign'],
                          },
                        }))
                      }
                      className="bx-select"
                    >
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-radius">
                      Radius ({draft.style.borderRadiusPx}px)
                    </label>
                    <input
                      id="popup-radius"
                      type="number"
                      min={0}
                      max={36}
                      value={draft.style.borderRadiusPx}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            borderRadiusPx: Math.max(0, Math.min(36, Number(e.target.value) || 0)),
                          },
                        }))
                      }
                      className="bx-input"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="bx-label" htmlFor="popup-text-color">
                      Text Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="popup-text-color"
                        type="color"
                        value={draft.style.textColor}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            style: { ...p.style, textColor: e.target.value.toUpperCase() },
                          }))
                        }
                        className="w-10 h-10 rounded cursor-pointer border border-[var(--border-soft)] shrink-0"
                      />
                      <span className="text-xs font-mono opacity-80">{draft.style.textColor}</span>
                    </div>
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-bg-color">
                      Background Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="popup-bg-color"
                        type="color"
                        value={draft.style.backgroundColor}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            style: { ...p.style, backgroundColor: e.target.value.toUpperCase() },
                          }))
                        }
                        className="w-10 h-10 rounded cursor-pointer border border-[var(--border-soft)] shrink-0"
                      />
                      <span className="text-xs font-mono opacity-80">
                        {draft.style.backgroundColor}
                      </span>
                    </div>
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-border-color">
                      Border Color
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="popup-border-color"
                        type="color"
                        value={draft.style.borderColor}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            style: { ...p.style, borderColor: e.target.value.toUpperCase() },
                          }))
                        }
                        className="w-10 h-10 rounded cursor-pointer border border-[var(--border-soft)] shrink-0"
                      />
                      <span className="text-xs font-mono opacity-80">{draft.style.borderColor}</span>
                    </div>
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-accent-color">
                      Badge Accent
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="popup-accent-color"
                        type="color"
                        value={draft.style.accentColor}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            style: { ...p.style, accentColor: e.target.value.toUpperCase() },
                          }))
                        }
                        className="w-10 h-10 rounded cursor-pointer border border-[var(--border-soft)] shrink-0"
                      />
                      <span className="text-xs font-mono opacity-80">{draft.style.accentColor}</span>
                    </div>
                  </div>
                </div>

                {/* Gradient Toggle & Colors */}
                <div className="p-3 rounded-xl border border-[var(--border-soft)] bg-[var(--surface)] space-y-3">
                  <label className="flex items-center gap-2 text-xs font-extrabold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.style.useGradient}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: { ...p.style, useGradient: e.target.checked },
                        }))
                      }
                      className="w-4 h-4 accent-[#FF6500]"
                    />
                    <span>Enable Background Gradient</span>
                  </label>

                  {draft.style.useGradient && (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="bx-label" htmlFor="popup-grad-from">
                          Gradient Start
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="popup-grad-from"
                            type="color"
                            value={draft.style.gradientFrom}
                            onChange={(e) =>
                              setDraft((p) => ({
                                ...p,
                                style: { ...p.style, gradientFrom: e.target.value.toUpperCase() },
                              }))
                            }
                            className="w-9 h-9 rounded cursor-pointer border"
                          />
                          <span className="text-xs font-mono">{draft.style.gradientFrom}</span>
                        </div>
                      </div>
                      <div>
                        <label className="bx-label" htmlFor="popup-grad-to">
                          Gradient End
                        </label>
                        <div className="flex items-center gap-2">
                          <input
                            id="popup-grad-to"
                            type="color"
                            value={draft.style.gradientTo}
                            onChange={(e) =>
                              setDraft((p) => ({
                                ...p,
                                style: { ...p.style, gradientTo: e.target.value.toUpperCase() },
                              }))
                            }
                            className="w-9 h-9 rounded cursor-pointer border"
                          />
                          <span className="text-xs font-mono">{draft.style.gradientTo}</span>
                        </div>
                      </div>
                      <div>
                        <label className="bx-label" htmlFor="popup-grad-dir">
                          Direction
                        </label>
                        <select
                          id="popup-grad-dir"
                          value={draft.style.gradientDirection}
                          onChange={(e) =>
                            setDraft((p) => ({
                              ...p,
                              style: {
                                ...p.style,
                                gradientDirection: e.target
                                  .value as PopupNotificationStyleConfig['gradientDirection'],
                              },
                            }))
                          }
                          className="bx-select"
                        >
                          <option value="135deg">Diagonal (135deg)</option>
                          <option value="90deg">Horizontal (90deg)</option>
                          <option value="180deg">Vertical (180deg)</option>
                        </select>
                      </div>
                    </div>
                  )}
                </div>

                {/* Spacing, Width & Height */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <label className="bx-label" htmlFor="popup-padding">
                      Padding ({draft.style.paddingPx}px)
                    </label>
                    <input
                      id="popup-padding"
                      type="number"
                      min={12}
                      max={48}
                      value={draft.style.paddingPx}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            paddingPx: Math.max(12, Math.min(48, Number(e.target.value) || 24)),
                          },
                        }))
                      }
                      className="bx-input"
                    />
                  </div>
                  <div>
                    <label className="bx-label" htmlFor="popup-width">
                      Width ({draft.style.popupWidthPx}px)
                    </label>
                    <input
                      id="popup-width"
                      type="number"
                      min={320}
                      max={760}
                      step={10}
                      value={draft.style.popupWidthPx}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            popupWidthPx: Math.max(
                              320,
                              Math.min(760, Number(e.target.value) || 480)
                            ),
                          },
                        }))
                      }
                      className="bx-input"
                    />
                  </div>
                  <div>
                    <label className="bx-label" htmlFor="popup-height-mode">
                      Height Mode
                    </label>
                    <select
                      id="popup-height-mode"
                      value={draft.style.popupHeightMode}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            popupHeightMode: e.target.value === 'custom' ? 'custom' : 'auto',
                          },
                        }))
                      }
                      className="bx-select"
                    >
                      <option value="auto">Auto Height</option>
                      <option value="custom">Custom Height</option>
                    </select>
                  </div>
                  <div>
                    <label className="bx-label" htmlFor="popup-height-px">
                      Height (px)
                    </label>
                    <input
                      id="popup-height-px"
                      type="number"
                      min={220}
                      max={680}
                      step={10}
                      disabled={draft.style.popupHeightMode !== 'custom'}
                      value={draft.style.popupHeightPx}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: {
                            ...p.style,
                            popupHeightPx: Math.max(
                              220,
                              Math.min(680, Number(e.target.value) || 360)
                            ),
                          },
                        }))
                      }
                      className="bx-input"
                    />
                  </div>
                </div>
              </div>

              {/* 5. Action Button & Close Control */}
              <div className="bx-soft p-4 space-y-4">
                <h3 className="text-xs font-black uppercase tracking-wider text-[#FF6500]">
                  5. Action Button &amp; Close Controls
                </h3>

                <div className="flex flex-wrap gap-5">
                  <label className="flex items-center gap-2 text-xs font-extrabold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.style.buttonEnabled}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: { ...p.style, buttonEnabled: e.target.checked },
                        }))
                      }
                      className="w-4 h-4 accent-[#FF6500]"
                    />
                    <span>Show Action Button (CTA)</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs font-extrabold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={draft.style.closeButtonEnabled}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          style: { ...p.style, closeButtonEnabled: e.target.checked },
                        }))
                      }
                      className="w-4 h-4 accent-[#FF6500]"
                    />
                    <span>Enable Close Button (X)</span>
                  </label>
                </div>

                {draft.style.buttonEnabled && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div>
                      <label className="bx-label" htmlFor="popup-btn-text">
                        Button Label
                      </label>
                      <input
                        id="popup-btn-text"
                        type="text"
                        maxLength={48}
                        value={draft.style.buttonText}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            style: { ...p.style, buttonText: e.target.value },
                          }))
                        }
                        className="bx-input"
                      />
                    </div>

                    <div>
                      <label className="bx-label" htmlFor="popup-btn-dest">
                        Destination (Route or https:// URL)
                      </label>
                      <input
                        id="popup-btn-dest"
                        type="text"
                        value={draft.style.buttonDestination}
                        onChange={(e) =>
                          setDraft((p) => ({
                            ...p,
                            style: { ...p.style, buttonDestination: e.target.value },
                          }))
                        }
                        placeholder="/market or https://…"
                        className="bx-input"
                      />
                    </div>

                    <div>
                      <label className="bx-label" htmlFor="popup-btn-bg">
                        Button Background Color
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="popup-btn-bg"
                          type="color"
                          value={draft.style.buttonBgColor}
                          onChange={(e) =>
                            setDraft((p) => ({
                              ...p,
                              style: { ...p.style, buttonBgColor: e.target.value.toUpperCase() },
                            }))
                          }
                          className="w-9 h-9 rounded cursor-pointer border"
                        />
                        <span className="text-xs font-mono">{draft.style.buttonBgColor}</span>
                      </div>
                    </div>

                    <div>
                      <label className="bx-label" htmlFor="popup-btn-fg">
                        Button Text Color
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          id="popup-btn-fg"
                          type="color"
                          value={draft.style.buttonTextColor}
                          onChange={(e) =>
                            setDraft((p) => ({
                              ...p,
                              style: { ...p.style, buttonTextColor: e.target.value.toUpperCase() },
                            }))
                          }
                          className="w-9 h-9 rounded cursor-pointer border"
                        />
                        <span className="text-xs font-mono">{draft.style.buttonTextColor}</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* 6. Frequency & Asia/Dhaka Scheduling */}
              <div className="bx-soft p-4 space-y-4">
                <h3 className="text-xs font-black uppercase tracking-wider text-[#FF6500] flex items-center gap-1.5">
                  <CalendarClock className="w-4 h-4" />
                  <span>6. Frequency &amp; Scheduling (Bangladesh Time · Asia/Dhaka)</span>
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="bx-label" htmlFor="popup-frequency">
                      Display Frequency
                    </label>
                    <select
                      id="popup-frequency"
                      value={draft.frequency}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          frequency: e.target.value as PopupNotificationFrequency,
                        }))
                      }
                      className="bx-select"
                    >
                      {(Object.keys(POPUP_FREQUENCY_LABELS) as PopupNotificationFrequency[]).map(
                        (freq) => (
                          <option key={freq} value={freq}>
                            {POPUP_FREQUENCY_LABELS[freq]}
                          </option>
                        )
                      )}
                    </select>
                  </div>

                  <div>
                    <label className="bx-label" htmlFor="popup-schedule-mode">
                      Publish Timing (Asia/Dhaka)
                    </label>
                    <select
                      id="popup-schedule-mode"
                      value={draft.scheduleMode}
                      onChange={(e) =>
                        setDraft((p) => ({
                          ...p,
                          scheduleMode: e.target.value === 'scheduled' ? 'scheduled' : 'immediate',
                        }))
                      }
                      className="bx-select"
                    >
                      <option value="immediate">Publish Immediately</option>
                      <option value="scheduled">Schedule Start Time (Asia/Dhaka)</option>
                    </select>
                  </div>

                  {draft.scheduleMode === 'scheduled' && (
                    <div>
                      <label className="bx-label" htmlFor="popup-start-dhaka">
                        Start Date &amp; Time (Asia/Dhaka BST)
                      </label>
                      <input
                        id="popup-start-dhaka"
                        type="datetime-local"
                        value={draft.startDhakaInput}
                        onChange={(e) =>
                          setDraft((p) => ({ ...p, startDhakaInput: e.target.value }))
                        }
                        className="bx-input"
                      />
                    </div>
                  )}

                  <div>
                    <label className="bx-label" htmlFor="popup-expires-dhaka">
                      Expiration Date &amp; Time (Optional · Asia/Dhaka BST)
                    </label>
                    <input
                      id="popup-expires-dhaka"
                      type="datetime-local"
                      value={draft.expiresDhakaInput}
                      onChange={(e) =>
                        setDraft((p) => ({ ...p, expiresDhakaInput: e.target.value }))
                      }
                      className="bx-input"
                    />
                  </div>
                </div>
              </div>

              {/* Save / Publish Buttons */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveCampaign('active')}
                  className="bx-btn bx-btn-primary"
                >
                  <Play className="w-4 h-4" />
                  <span>
                    {saving
                      ? 'Saving…'
                      : draft.scheduleMode === 'scheduled'
                        ? 'Save & Schedule'
                        : 'Publish Notification'}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => void handleSaveCampaign('draft')}
                  className="bx-btn"
                >
                  <Layers className="w-4 h-4" />
                  <span>Save as Draft</span>
                </button>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() => setEditorOpen(false)}
                  className="bx-btn"
                >
                  <span>Cancel</span>
                </button>
              </div>
            </div>

            {/* RIGHT: Sticky Live Interactive Preview */}
            <div className="xl:col-span-5 xl:sticky xl:top-6 space-y-3">
              <div className="bx-soft p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-black uppercase tracking-wider flex items-center gap-1.5">
                    <Eye className="w-4 h-4 text-[#FF6500]" />
                    <span>Live Preview</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setPreviewViewport('desktop')}
                      className={`px-2.5 py-1 rounded text-xs font-bold border ${
                        previewViewport === 'desktop'
                          ? 'bg-[#FF6500] text-white border-[#FF6500]'
                          : 'bg-[var(--surface)] border-[var(--border-soft)]'
                      }`}
                      title="Desktop Width Preview"
                    >
                      <Monitor className="w-3.5 h-3.5 inline mr-1" />
                      Desktop
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewViewport('mobile')}
                      className={`px-2.5 py-1 rounded text-xs font-bold border ${
                        previewViewport === 'mobile'
                          ? 'bg-[#FF6500] text-white border-[#FF6500]'
                          : 'bg-[var(--surface)] border-[var(--border-soft)]'
                      }`}
                      title="Mobile Width Preview"
                    >
                      <Smartphone className="w-3.5 h-3.5 inline mr-1" />
                      Mobile
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewBackdropDark((v) => !v)}
                      className="px-2 py-1 rounded text-xs font-bold border border-[var(--border-soft)] bg-[var(--surface)]"
                      title="Toggle Preview Backdrop Light/Dark"
                      aria-label="Toggle preview backdrop brightness"
                    >
                      {previewBackdropDark ? (
                        <Sun className="w-3.5 h-3.5" />
                      ) : (
                        <Moon className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </div>

                <div
                  className={`rounded-xl border border-[var(--border-soft)] p-4 sm:p-6 min-h-[340px] flex items-center justify-center overflow-x-auto transition-colors ${
                    previewBackdropDark ? 'bg-[#09090D]' : 'bg-[#EFE8DC]'
                  }`}
                >
                  <PopupNotificationModal
                    campaign={{
                      id: draft.editingId || 'preview',
                      title: draft.title,
                      body: draft.body,
                      themeId: draft.themeId,
                      style: draft.style,
                      bannerImageUrl: draft.bannerImageUrl,
                      deliveryMode: draft.deliveryMode,
                    }}
                    previewMode
                    previewViewport={previewViewport}
                  />
                </div>

                <div className="text-[11px] opacity-75 space-y-0.5">
                  <div>
                    <strong>Theme:</strong> {getPopupThemePreset(draft.themeId).label} ·{' '}
                    <strong>Frequency:</strong> {POPUP_FREQUENCY_LABELS[draft.frequency]}
                  </div>
                  <div>
                    <strong>Audience:</strong>{' '}
                    {draft.deliveryMode === 'global'
                      ? 'All Website Visitors & Users'
                      : `${draft.targetUsers.length} Specific User(s)`}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="bx-card p-5 space-y-4">
          {/* Toolbar Filters */}
          <div className="flex flex-col md:flex-row gap-3 items-stretch md:items-center justify-between">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 opacity-55 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search notifications by title, theme, or recipient UID…"
                className="bx-input pl-9"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={typeFilter}
                onChange={(e) =>
                  setTypeFilter(e.target.value as 'all' | PopupNotificationDeliveryMode)
                }
                aria-label="Filter by notification type"
                className="bx-select w-auto min-w-[140px]"
              >
                <option value="all">All Types</option>
                <option value="global">Global Only</option>
                <option value="targeted">Targeted Users Only</option>
              </select>

              <select
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as 'all' | PopupNotificationEffectiveStatus)
                }
                aria-label="Filter by notification status"
                className="bx-select w-auto min-w-[140px]"
              >
                <option value="all">All Statuses</option>
                <option value="active">Active</option>
                <option value="scheduled">Scheduled</option>
                <option value="paused">Paused</option>
                <option value="expired">Expired</option>
                <option value="draft">Draft</option>
              </select>
            </div>
          </div>

          {loadError && (
            <div className="p-4 rounded-xl border border-red-600 bg-red-600/10 text-red-700 dark:text-red-300 text-xs font-bold">
              {loadError}
            </div>
          )}

          {loading ? (
            <div className="p-8 text-center text-sm font-bold opacity-70">
              Loading notification campaigns…
            </div>
          ) : filteredCampaigns.length === 0 ? (
            <div className="p-10 text-center space-y-3 bx-soft">
              <BellRing className="w-8 h-8 mx-auto text-[#FF6500] opacity-80" />
              <div className="text-sm font-black">No Popup Notifications Found</div>
              <p className="text-xs opacity-75 max-w-md mx-auto">
                Create a Global Website Notification or a private Specific User Notification with custom styling and Bangladesh Time scheduling.
              </p>
              <button
                type="button"
                onClick={openCreateEditor}
                className="bx-btn bx-btn-primary bx-btn-sm"
              >
                <Plus className="w-4 h-4" />
                <span>Create First Notification</span>
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b-2 border-[var(--border-soft)] text-[11px] uppercase tracking-wider opacity-75">
                    <th className="py-3 px-2 font-black">Notification Title</th>
                    <th className="py-3 px-2 font-black">Type</th>
                    <th className="py-3 px-2 font-black">Selected Theme</th>
                    <th className="py-3 px-2 font-black">Target Audience</th>
                    <th className="py-3 px-2 font-black">Status</th>
                    <th className="py-3 px-2 font-black">Created (Asia/Dhaka)</th>
                    <th className="py-3 px-2 font-black">Expiration (Asia/Dhaka)</th>
                    <th className="py-3 px-2 font-black text-right">View Count</th>
                    <th className="py-3 px-2 font-black text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-soft)] tabular-nums">
                  {filteredCampaigns.map((c) => {
                    const effStatus = resolveEffectivePopupStatus(c, nowMs);
                    const badge = getEffectiveStatusBadge(effStatus);
                    const theme = getPopupThemePreset(c.themeId);
                    const isBusy = busyId === c.id;

                    return (
                      <tr key={c.id} className="hover:bg-[var(--surface-2)]/60">
                        <td className="py-3 px-2 max-w-[220px]">
                          <div className="font-extrabold text-sm truncate">{c.title}</div>
                          <div className="text-[11px] opacity-70 truncate">
                            {POPUP_FREQUENCY_LABELS[c.frequency]}
                          </div>
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap">
                          {c.deliveryMode === 'global' ? (
                            <span className="inline-flex items-center gap-1 font-bold text-[#FF6500]">
                              <Globe className="w-3.5 h-3.5" />
                              Global
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-bold text-[#793A91] dark:text-[#C084FC]">
                              <Users className="w-3.5 h-3.5" />
                              Targeted
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap font-bold">{theme.label}</td>
                        <td className="py-3 px-2 max-w-[180px]">
                          {c.deliveryMode === 'global' ? (
                            <span className="opacity-85 font-semibold">All Visitors &amp; Users</span>
                          ) : (
                            <span className="font-semibold" title={c.targetUserIds.join(', ')}>
                              {c.targetUsers && c.targetUsers.length > 0
                                ? c.targetUsers.length === 1
                                  ? `${c.targetUsers[0]!.displayName}${
                                      c.targetUsers[0]!.username
                                        ? ` (@${c.targetUsers[0]!.username})`
                                        : ''
                                    }`
                                  : `${c.targetUsers[0]!.displayName} + ${c.targetUsers.length - 1} more`
                                : `${c.targetUserIds.length} User(s)`}
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded border text-[11px] font-black ${badge.className}`}
                          >
                            {badge.label}
                          </span>
                          {effStatus === 'scheduled' && c.startAtMs > 0 && (
                            <div className="text-[10px] opacity-70 mt-0.5">
                              Starts: {formatDhakaDateTime(c.startAtMs)}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap text-[11px]">
                          {formatDhakaDateTime(c.createdAtMs)}
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap text-[11px]">
                          {c.expiresAtMs > 0 ? formatDhakaDateTime(c.expiresAtMs) : 'No expiration'}
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap text-right">
                          <div className="font-black text-sm">{c.viewCount.toLocaleString()}</div>
                          <div className="text-[10px] opacity-70">
                            {c.dismissCount.toLocaleString()} dismissed
                          </div>
                        </td>
                        <td className="py-3 px-2 whitespace-nowrap text-right">
                          <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => setPreviewModalCampaign(c)}
                              className="bx-btn bx-btn-sm px-2.5 py-1.5 text-[11px]"
                              title="Preview Popup"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              <span>Preview</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => openEditEditor(c)}
                              className="bx-btn bx-btn-sm px-2.5 py-1.5 text-[11px]"
                              title="Edit Notification"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>Edit</span>
                            </button>

                            {c.storedStatus === 'active' && effStatus !== 'expired' ? (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleToggleStatus(c, 'paused')}
                                className="bx-btn bx-btn-sm px-2.5 py-1.5 text-[11px]"
                                title="Pause Notification"
                              >
                                <Pause className="w-3.5 h-3.5" />
                                <span>Pause</span>
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => void handleToggleStatus(c, 'active')}
                                className="bx-btn bx-btn-primary bx-btn-sm px-2.5 py-1.5 text-[11px]"
                                title={c.storedStatus === 'draft' ? 'Publish Notification' : 'Activate Notification'}
                              >
                                <Play className="w-3.5 h-3.5" />
                                <span>{c.storedStatus === 'draft' ? 'Publish' : 'Activate'}</span>
                              </button>
                            )}

                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => setDeleteTarget(c)}
                              className="bx-btn bx-btn-danger bx-btn-sm px-2.5 py-1.5 text-[11px]"
                              title="Delete Notification"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>Delete</span>
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Full Modal Preview Overlay */}
      {previewModalCampaign && (
        <PopupNotificationModal
          campaign={previewModalCampaign}
          onDismiss={() => setPreviewModalCampaign(null)}
          onActionNavigate={() => setPreviewModalCampaign(null)}
        />
      )}

      {/* Centered Delete Confirmation Modal */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-[2px]"
          onClick={() => {
            if (!deleting) setDeleteTarget(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Delete Popup Notification"
            className="bx-card w-full max-w-md p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 text-red-600 font-black text-base">
                <Trash2 className="w-5 h-5 shrink-0" />
                <span>Delete Notification?</span>
              </div>
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="bx-icon-btn"
                aria-label="Close delete confirmation"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs opacity-85">
              Are you sure you want to delete <strong>{deleteTarget.title}</strong>? Visitors and targeted users will immediately stop seeing this popup.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={deleting}
                onClick={() => setDeleteTarget(null)}
                className="bx-btn bx-btn-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={() => void handleConfirmDelete()}
                className="bx-btn bx-btn-danger bx-btn-sm"
              >
                {deleting ? 'Deleting…' : 'Confirm Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
