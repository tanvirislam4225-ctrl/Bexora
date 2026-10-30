import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BellOff,
  BellRing,
  CheckCheck,
  CheckCircle2,
  Clock,
  Eye,
  Info,
  Lock,
  Megaphone,
  Play,
  RefreshCw,
  ShieldAlert,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  NotificationCategory,
  NotificationRecord,
  NotificationSeverity,
  NotificationSoundId,
  UserNotificationPreferences,
  VibrationStrength,
} from '../types';
import {
  computeUnreadNotificationCount,
  formatNotificationExactDateTime,
  formatNotificationTimestamp,
  formatUnreadBadgeCount,
  getNotificationCategoryLabel,
  sanitizeNotificationDestination,
  sortNotificationsNewestFirst,
  type SafeInternalDestination,
} from '../lib/notificationLogic';
import {
  disableWebPushForCurrentUser,
  enableWebPushForCurrentUser,
  inspectWebPushState,
  type WebPushStateSnapshot,
} from '../lib/pushNotifications';
import {
  NOTIFICATION_SOUND_CATALOG,
  playNotificationSoundById,
  resolveNotificationAlertKind,
  triggerDealRoomVibration,
} from '../lib/soundAndPushConfig';

interface NotificationCenterProps {
  userUid: string | null;
  notifications: NotificationRecord[];
  loading: boolean;
  error: string | null;
  isOffline: boolean;
  fallbackVapidKey?: string;
  preferences: UserNotificationPreferences;
  onUpdatePreferences: (next: UserNotificationPreferences) => void;
  onRetry: () => void;
  onMarkOneRead: (item: NotificationRecord) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onNavigateDestination: (dest: SafeInternalDestination) => void;
  onOpenAuth: () => void;
}

function renderCategoryIcon(category: NotificationCategory, severity: NotificationSeverity) {
  if (category === 'announcement') return <Megaphone className="w-4 h-4 shrink-0 text-[var(--purple)]" />;
  if (category === 'security' || severity === 'critical') {
    return <ShieldAlert className="w-4 h-4 shrink-0 text-[var(--red)]" />;
  }
  if (severity === 'warning' || category === 'dispute') {
    return <AlertTriangle className="w-4 h-4 shrink-0 text-[var(--orange)]" />;
  }
  if (severity === 'success') {
    return <CheckCircle2 className="w-4 h-4 shrink-0 text-[var(--green)]" />;
  }
  if (category === 'account') {
    return <Sparkles className="w-4 h-4 shrink-0 text-[var(--orange)]" />;
  }
  return <Info className="w-4 h-4 shrink-0 text-[var(--teal)]" />;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  userUid,
  notifications,
  loading,
  error,
  isOffline,
  fallbackVapidKey,
  preferences,
  onUpdatePreferences,
  onRetry,
  onMarkOneRead,
  onMarkAllRead,
  onNavigateDestination,
  onOpenAuth,
}) => {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'inbox' | 'settings'>('inbox');
  const [selectedNotificationId, setSelectedNotificationId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingOneId, setMarkingOneId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pushState, setPushState] = useState<WebPushStateSnapshot | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFeedback, setPushFeedback] = useState<string | null>(null);
  const [previewingSoundId, setPreviewingSoundId] = useState<NotificationSoundId | null>(null);
  const [soundPreviewFeedback, setSoundPreviewFeedback] = useState<string | null>(null);

  const bellButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const sortedNotifications = useMemo(
    () => sortNotificationsNewestFirst(notifications),
    [notifications]
  );

  const unreadCount = useMemo(
    () => computeUnreadNotificationCount(sortedNotifications),
    [sortedNotifications]
  );

  const badgeLabel = useMemo(() => formatUnreadBadgeCount(unreadCount), [unreadCount]);

  const selectedNotification = useMemo(
    () => sortedNotifications.find((n) => n.id === selectedNotificationId) || null,
    [sortedNotifications, selectedNotificationId]
  );

  const refreshPushState = useCallback(async () => {
    const snap = await inspectWebPushState(userUid, fallbackVapidKey);
    setPushState(snap);
  }, [userUid, fallbackVapidKey]);

  useEffect(() => {
    if (open) {
      setActionError(null);
      setPushFeedback(null);
      setSoundPreviewFeedback(null);
      void refreshPushState();
    }
  }, [open, refreshPushState]);

  useEffect(() => {
    if (!open && !selectedNotificationId) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (selectedNotificationId) {
          setSelectedNotificationId(null);
          return;
        }
        setOpen(false);
        bellButtonRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, selectedNotificationId]);

  const handleViewNotification = async (item: NotificationRecord) => {
    setActionError(null);
    setSelectedNotificationId(item.id);
    if (!item.read) {
      setMarkingOneId(item.id);
      try {
        await onMarkOneRead(item);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Could not update read state. Please try again.';
        setActionError(msg);
      } finally {
        setMarkingOneId(null);
      }
    }
  };

  const handleMarkAll = async () => {
    if (unreadCount === 0 || markingAll) return;
    setActionError(null);
    setMarkingAll(true);
    try {
      await onMarkAllRead();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to mark notifications as read.';
      setActionError(msg);
    } finally {
      setMarkingAll(false);
    }
  };

  const handleEnablePush = async () => {
    setPushBusy(true);
    setPushFeedback(null);
    try {
      const res = await enableWebPushForCurrentUser(fallbackVapidKey);
      setPushFeedback(res.message);
      await refreshPushState();
    } finally {
      setPushBusy(false);
    }
  };

  const handleDisablePush = async () => {
    setPushBusy(true);
    setPushFeedback(null);
    try {
      const res = await disableWebPushForCurrentUser();
      setPushFeedback(res.message);
      await refreshPushState();
    } finally {
      setPushBusy(false);
    }
  };

  const handlePreviewSound = async (soundId: NotificationSoundId, withVibrate = false) => {
    setPreviewingSoundId(soundId);
    setSoundPreviewFeedback(null);
    try {
      if (withVibrate && preferences.vibrationEnabled) {
        triggerDealRoomVibration(preferences);
      }
      const res = await playNotificationSoundById(soundId, { isManualPreview: true });
      const soundLabel =
        NOTIFICATION_SOUND_CATALOG.find((s) => s.id === soundId)?.label || soundId;
      if (res.played) {
        setSoundPreviewFeedback(
          withVibrate
            ? `Played "${soundLabel}" (vibration triggered where supported by device).`
            : `Played "${soundLabel}".`
        );
      } else {
        setSoundPreviewFeedback(
          'Audio output unavailable in this browser environment; your chime selection is saved.'
        );
      }
    } finally {
      window.setTimeout(() => setPreviewingSoundId(null), 350);
    }
  };

  const safeSelectedDestination = useMemo(
    () =>
      selectedNotification
        ? sanitizeNotificationDestination(selectedNotification.destination)
        : null,
    [selectedNotification]
  );

  const ariaBellLabel =
    unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

  const getPushStatusLabel = (state: WebPushStateSnapshot): string => {
    switch (state.status) {
      case 'enabled':
        return 'Enabled';
      case 'ready_to_enable':
        return 'Ready to Enable';
      case 'permission_denied':
        return 'Blocked in Browser';
      case 'vapid_key_missing':
        return 'In-App Active (VAPID Unset)';
      case 'invalid_vapid_key':
        return 'Invalid VAPID Public Key';
      case 'fcm_api_disabled':
        return 'Awaiting Cloud API';
      case 'insecure_context':
        return 'HTTPS Required';
      case 'ios_install_required':
        return 'Install Home Screen App (iOS)';
      case 'signed_out':
        return 'Sign In Required';
      default:
        return 'Unsupported';
    }
  };

  return (
    <>
      <button
        ref={bellButtonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="bx-icon-btn relative"
        aria-label={ariaBellLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={ariaBellLabel}
      >
        <Bell className="w-5 h-5" />
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-[var(--orange)] text-white border-2 border-[var(--bg)] text-[10px] font-black leading-none flex items-center justify-center tabular-nums shadow-xs"
          >
            {badgeLabel}
          </span>
        )}
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[70]" role="presentation">
            {/* Click-outside backdrop */}
            <div
              className="fixed inset-0 bg-black/35 backdrop-blur-[1px]"
              onClick={() => setOpen(false)}
              aria-hidden="true"
            />

            {/* Viewport-safe Notification Panel */}
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Notifications"
              className="fixed inset-x-3 top-[68px] sm:inset-x-auto sm:right-6 sm:top-[72px] sm:w-[440px] max-h-[calc(100vh-84px)] flex flex-col rounded-2xl border-2 border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow)] overflow-hidden"
            >
              {/* Panel Header */}
              <div className="px-4 py-3.5 border-b-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Bell className="w-4 h-4 text-[var(--orange)] shrink-0" />
                  <h2 className="text-base font-black tracking-tight whitespace-nowrap">
                    Notifications
                  </h2>
                  <span className="text-xs font-extrabold text-[var(--text-2)] tabular-nums whitespace-nowrap shrink-0">
                    · {unreadCount} unread
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {activeTab === 'inbox' && (
                    <button
                      type="button"
                      onClick={handleMarkAll}
                      disabled={unreadCount === 0 || markingAll}
                      className="bx-btn bx-btn-sm !min-h-[34px] !px-2.5 !py-1 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
                    >
                      <CheckCheck className="w-3.5 h-3.5" />
                      <span className="sm:hidden">{markingAll ? '…' : 'Mark read'}</span>
                      <span className="hidden sm:inline">
                        {markingAll ? 'Updating…' : 'Mark all read'}
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      bellButtonRef.current?.focus();
                    }}
                    className="bx-icon-btn !w-8 !h-8"
                    aria-label="Close notifications panel"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Segmented Tab Bar: Inbox | Sound & Push */}
              <div
                role="tablist"
                aria-label="Notification panel sections"
                className="px-3 py-2 border-b border-[var(--border-soft)] bg-[var(--surface)] flex items-center gap-1.5 shrink-0"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'inbox'}
                  onClick={() => setActiveTab('inbox')}
                  className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-extrabold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${
                    activeTab === 'inbox'
                      ? 'bg-[var(--orange)] text-white border border-[var(--border-strong)]'
                      : 'bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)] border border-transparent'
                  }`}
                >
                  <Bell className="w-3.5 h-3.5 shrink-0" />
                  <span>Inbox</span>
                  {unreadCount > 0 && (
                    <span className="tabular-nums">({unreadCount})</span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'settings'}
                  onClick={() => setActiveTab('settings')}
                  className={`flex-1 py-1.5 px-3 rounded-lg text-xs font-extrabold inline-flex items-center justify-center gap-1.5 whitespace-nowrap transition-colors ${
                    activeTab === 'settings'
                      ? 'bg-[var(--orange)] text-white border border-[var(--border-strong)]'
                      : 'bg-[var(--surface-2)] text-[var(--text-2)] hover:text-[var(--text)] border border-transparent'
                  }`}
                >
                  <SlidersHorizontal className="w-3.5 h-3.5 shrink-0" />
                  <span>Sound &amp; Push</span>
                </button>
              </div>

              {/* Offline / Error Banners */}
              {isOffline && (
                <div className="px-4 py-2 bg-[var(--yellow-soft)] border-b border-[var(--border-soft)] flex items-center gap-2 text-xs font-bold text-[var(--text)] shrink-0">
                  <WifiOff className="w-3.5 h-3.5 text-[var(--orange)] shrink-0" />
                  <span>Offline mode — changes will sync when your connection returns.</span>
                </div>
              )}

              {(error || actionError) && (
                <div
                  role="alert"
                  className="px-4 py-2.5 bg-[var(--red-soft)] border-b border-[var(--red)] flex items-center justify-between gap-2 text-xs font-bold text-[var(--red)] shrink-0"
                >
                  <span className="leading-snug">{actionError || error}</span>
                  {error && (
                    <button
                      type="button"
                      onClick={onRetry}
                      className="bx-btn bx-btn-sm !min-h-[30px] !px-2.5 !py-1 text-[11px] font-extrabold shrink-0 inline-flex items-center gap-1 whitespace-nowrap"
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Retry</span>
                    </button>
                  )}
                </div>
              )}

              {activeTab === 'inbox' ? (
                <>
                  {/* Notification List Body */}
                  <div className="flex-1 overflow-y-auto divide-y divide-[var(--border-soft)]">
                    {loading ? (
                      <div className="p-8 text-center space-y-2.5">
                        <RefreshCw className="w-6 h-6 mx-auto animate-spin text-[var(--orange)]" />
                        <p className="text-xs font-extrabold text-[var(--text-2)]">
                          Syncing your notifications…
                        </p>
                      </div>
                    ) : sortedNotifications.length === 0 ? (
                      <div className="p-8 text-center space-y-3">
                        <div className="w-12 h-12 mx-auto rounded-xl border-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex items-center justify-center">
                          <Bell className="w-5 h-5 text-[var(--text-3)]" />
                        </div>
                        <div className="space-y-1">
                          <p className="text-sm font-black text-[var(--text)]">
                            {userUid ? 'No notifications yet' : 'Sign in for account notifications'}
                          </p>
                          <p className="text-xs font-medium text-[var(--text-2)] max-w-xs mx-auto leading-relaxed">
                            {userUid
                              ? 'Real-time updates for bids, paid 3-party Deal Rooms, wallet credits, verification reviews, and security alerts will appear here.'
                              : 'Platform announcements appear here for everyone. Sign in to view personal bids, Deal Rooms, wallet updates, and security alerts.'}
                          </p>
                        </div>
                        {!userUid && (
                          <button
                            type="button"
                            onClick={() => {
                              setOpen(false);
                              onOpenAuth();
                            }}
                            className="bx-btn bx-btn-primary bx-btn-sm mx-auto whitespace-nowrap"
                          >
                            <span>Sign In</span>
                          </button>
                        )}
                      </div>
                    ) : (
                      sortedNotifications.map((item) => {
                        const isUnread = !item.read;
                        const isSyncingThis = markingOneId === item.id;
                        const kind = resolveNotificationAlertKind(item);
                        const isDealRoomCreated = kind === 'deal_room_created';
                        return (
                          <article
                            key={item.id}
                            className={`p-3.5 transition-colors flex flex-col gap-2 ${
                              isUnread
                                ? 'bg-[var(--surface-2)]'
                                : 'bg-[var(--surface)] opacity-90'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-2 text-[11px] font-bold text-[var(--text-2)]">
                              <div className="flex items-center gap-1.5 min-w-0 truncate">
                                {renderCategoryIcon(item.category, item.severity)}
                                <span className="font-extrabold text-[var(--text)] truncate">
                                  {isDealRoomCreated
                                    ? 'Paid Deal Room'
                                    : getNotificationCategoryLabel(item.category)}
                                </span>
                                <span aria-hidden="true">·</span>
                                <span
                                  className={
                                    isUnread
                                      ? 'font-black text-[var(--orange)]'
                                      : 'font-semibold text-[var(--text-3)]'
                                  }
                                >
                                  {isUnread ? 'Unread' : 'Read'}
                                </span>
                              </div>

                              <span
                                title={formatNotificationExactDateTime(item.createdAtMs)}
                                className="text-[11px] font-bold text-[var(--text-3)] tabular-nums shrink-0 inline-flex items-center gap-1"
                              >
                                <Clock className="w-3 h-3" />
                                {formatNotificationTimestamp(item.createdAtMs)}
                              </span>
                            </div>

                            <div className="space-y-1">
                              <h3
                                className={`text-sm leading-snug break-words ${
                                  isUnread
                                    ? 'font-black text-[var(--text)]'
                                    : 'font-bold text-[var(--text-2)]'
                                }`}
                              >
                                {item.title}
                              </h3>
                              <p className="text-xs font-medium text-[var(--text-2)] line-clamp-2 leading-relaxed break-words">
                                {item.preview}
                              </p>
                            </div>

                            <div className="flex items-center justify-between gap-2 pt-0.5">
                              <span className="text-[11px] font-bold text-[var(--text-3)] truncate">
                                {item.referenceLabel || ''}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleViewNotification(item)}
                                disabled={isSyncingThis}
                                aria-label={`View notification: ${item.title}`}
                                className="bx-btn bx-btn-sm !min-h-[32px] !px-3 !py-1 text-xs font-extrabold inline-flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                              >
                                <Eye className="w-3.5 h-3.5 text-[var(--orange)]" />
                                <span>{isSyncingThis ? 'Opening…' : 'View'}</span>
                              </button>
                            </div>
                          </article>
                        );
                      })
                    )}
                  </div>

                  {/* Compact Push & Sound Quick-Status Footer */}
                  <div className="px-4 py-2.5 border-t-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex items-center justify-between gap-2 shrink-0 text-xs">
                    <div className="flex items-center gap-2 min-w-0 truncate">
                      {preferences.inAppSoundEnabled ? (
                        <Volume2 className="w-3.5 h-3.5 text-[var(--green)] shrink-0" />
                      ) : (
                        <VolumeX className="w-3.5 h-3.5 text-[var(--text-3)] shrink-0" />
                      )}
                      <span className="font-bold text-[var(--text-2)] truncate">
                        Chimes: <strong className="text-[var(--text)]">{preferences.inAppSoundEnabled ? 'On' : 'Muted'}</strong>
                        {pushState ? (
                          <>
                            {' · '}Push:{' '}
                            <strong className="text-[var(--orange)]">
                              {getPushStatusLabel(pushState)}
                            </strong>
                          </>
                        ) : null}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab('settings')}
                      className="text-xs font-extrabold text-[var(--orange)] hover:underline whitespace-nowrap shrink-0"
                    >
                      Configure →
                    </button>
                  </div>
                </>
              ) : (
                /* Sound, Vibration, Privacy & Background Web Push Settings View */
                <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
                  {/* 1. Background Web Push Card */}
                  <section className="p-3.5 rounded-xl border border-[var(--border-strong)] bg-[var(--surface-2)] space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {pushState?.status === 'enabled' ? (
                          <BellRing className="w-4 h-4 text-[var(--green)] shrink-0" />
                        ) : (
                          <BellOff className="w-4 h-4 text-[var(--text-3)] shrink-0" />
                        )}
                        <div className="min-w-0">
                          <h3 className="text-xs font-black text-[var(--text)] truncate">
                            Background Browser Push
                          </h3>
                          {pushState && (
                            <p className="text-[11px] font-bold text-[var(--orange)]">
                              {getPushStatusLabel(pushState)} · {pushState.deviceLabel}
                            </p>
                          )}
                        </div>
                      </div>

                      {userUid && pushState?.status === 'enabled' ? (
                        <button
                          type="button"
                          disabled={pushBusy}
                          onClick={() => void handleDisablePush()}
                          className="bx-btn bx-btn-sm !min-h-[32px] !px-3 !py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                        >
                          {pushBusy ? 'Updating…' : 'Disable Push'}
                        </button>
                      ) : userUid && pushState?.status === 'ready_to_enable' ? (
                        <button
                          type="button"
                          disabled={pushBusy}
                          onClick={() => void handleEnablePush()}
                          className="bx-btn bx-btn-primary bx-btn-sm !min-h-[32px] !px-3 !py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                        >
                          {pushBusy ? 'Enabling…' : 'Enable Push'}
                        </button>
                      ) : !userUid ? (
                        <button
                          type="button"
                          onClick={() => {
                            setOpen(false);
                            onOpenAuth();
                          }}
                          className="bx-btn bx-btn-primary bx-btn-sm !min-h-[32px] !px-3 !py-1 text-[11px] font-extrabold whitespace-nowrap shrink-0"
                        >
                          Sign In
                        </button>
                      ) : null}
                    </div>

                    <p className="text-[11px] font-medium text-[var(--text-2)] leading-relaxed">
                      {pushFeedback ||
                        pushState?.detailMessage ||
                        'Receive push alerts when BEXORA is closed or in the background.'}
                    </p>

                    {pushState?.serverDiagnostics && pushState.status !== 'enabled' && (
                      <div className="pt-2 border-t border-[var(--border-soft)] flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold text-[var(--text-2)]">
                        <span>
                          FCM v1:{' '}
                          <strong
                            className={
                              pushState.serverDiagnostics.fcmV1ApiStatus === 'enabled_verified'
                                ? 'text-[var(--green)]'
                                : 'text-[var(--orange)]'
                            }
                          >
                            {pushState.serverDiagnostics.fcmV1ApiStatus === 'enabled_verified'
                              ? 'Enabled'
                              : 'Check GCP'}
                          </strong>
                        </span>
                        <span>
                          Registrations API:{' '}
                          <strong
                            className={
                              pushState.serverDiagnostics.fcmRegistrationsApiStatus ===
                              'enabled_verified'
                                ? 'text-[var(--green)]'
                                : 'text-[var(--orange)]'
                            }
                          >
                            {pushState.serverDiagnostics.fcmRegistrationsApiStatus ===
                            'enabled_verified'
                              ? 'Enabled'
                              : 'Disabled in GCP'}
                          </strong>
                        </span>
                        <span>
                          Installations API:{' '}
                          <strong
                            className={
                              pushState.serverDiagnostics.firebaseInstallationsApiStatus ===
                              'enabled_verified'
                                ? 'text-[var(--green)]'
                                : 'text-[var(--orange)]'
                            }
                          >
                            {pushState.serverDiagnostics.firebaseInstallationsApiStatus ===
                            'enabled_verified'
                              ? 'Enabled'
                              : 'Check GCP'}
                          </strong>
                        </span>
                      </div>
                    )}
                  </section>

                  {/* 2. Chime Toggles & Selectable Sound Profiles */}
                  <section className="p-3.5 rounded-xl border border-[var(--border-soft)] bg-[var(--surface)] space-y-3">
                    <div className="flex items-center justify-between">
                      <h3 className="text-xs font-black text-[var(--text)] flex items-center gap-1.5">
                        <Volume2 className="w-4 h-4 text-[var(--orange)]" />
                        Notification Sound &amp; Chime Selection
                      </h3>
                    </div>

                    <label className="flex items-center justify-between gap-3 py-1 cursor-pointer">
                      <div>
                        <div className="font-extrabold text-[var(--text)]">
                          Normal Notification Sound
                        </div>
                        <div className="text-[11px] text-[var(--text-2)]">
                          Play a clean chime once when a new unread notification arrives
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={preferences.inAppSoundEnabled}
                        onChange={(e) =>
                          onUpdatePreferences({
                            ...preferences,
                            inAppSoundEnabled: e.target.checked,
                          })
                        }
                        className="w-4 h-4 accent-[#FF6500] shrink-0"
                      />
                    </label>

                    <div className="space-y-1">
                      <label
                        htmlFor="bx-normal-sound-select"
                        className="block text-[11px] font-extrabold text-[var(--text-2)]"
                      >
                        Everyday Notification Chime
                      </label>
                      <div className="flex items-center gap-2">
                        <select
                          id="bx-normal-sound-select"
                          value={preferences.normalSoundId}
                          onChange={(e) =>
                            onUpdatePreferences({
                              ...preferences,
                              normalSoundId: e.target.value as NotificationSoundId,
                            })
                          }
                          className="bx-input flex-1 px-2.5 py-1.5 text-xs font-bold"
                        >
                          {NOTIFICATION_SOUND_CATALOG.map((opt) => (
                            <option key={opt.id} value={opt.id}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => void handlePreviewSound(preferences.normalSoundId, false)}
                          aria-label="Preview normal notification sound"
                          className="bx-btn bx-btn-sm !min-h-[34px] !px-2.5 !py-1 text-xs font-extrabold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                        >
                          <Play className="w-3 h-3 text-[var(--orange)]" />
                          <span>
                            {previewingSoundId === preferences.normalSoundId ? 'Playing…' : 'Preview'}
                          </span>
                        </button>
                      </div>
                    </div>

                    <div className="border-t border-[var(--border-soft)] pt-2.5 space-y-2">
                      <label className="flex items-center justify-between gap-3 cursor-pointer">
                        <div>
                          <div className="font-extrabold text-[var(--text)]">
                            Premium Paid Deal-Room Alert
                          </div>
                          <div className="text-[11px] text-[var(--text-2)]">
                            Distinct chime for Buyer, Seller &amp; Admin when escrow payment opens a 3-party Deal Room
                          </div>
                        </div>
                        <input
                          type="checkbox"
                          checked={preferences.dealAlertSoundEnabled}
                          onChange={(e) =>
                            onUpdatePreferences({
                              ...preferences,
                              dealAlertSoundEnabled: e.target.checked,
                            })
                          }
                          className="w-4 h-4 accent-[#FF6500] shrink-0"
                        />
                      </label>

                      <div className="space-y-1">
                        <label
                          htmlFor="bx-deal-sound-select"
                          className="block text-[11px] font-extrabold text-[var(--text-2)]"
                        >
                          Paid Deal-Room Creation Chime
                        </label>
                        <div className="flex items-center gap-2">
                          <select
                            id="bx-deal-sound-select"
                            value={preferences.dealAlertSoundId}
                            onChange={(e) =>
                              onUpdatePreferences({
                                ...preferences,
                                dealAlertSoundId: e.target.value as NotificationSoundId,
                              })
                            }
                            className="bx-input flex-1 px-2.5 py-1.5 text-xs font-bold"
                          >
                            {NOTIFICATION_SOUND_CATALOG.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              void handlePreviewSound(preferences.dealAlertSoundId, true)
                            }
                            aria-label="Preview paid deal room alert sound"
                            className="bx-btn bx-btn-sm !min-h-[34px] !px-2.5 !py-1 text-xs font-extrabold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                          >
                            <Play className="w-3 h-3 text-[var(--orange)]" />
                            <span>
                              {previewingSoundId === preferences.dealAlertSoundId
                                ? 'Playing…'
                                : 'Preview'}
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="border-t border-[var(--border-soft)] pt-2.5 space-y-2">
                      <label className="flex items-center justify-between gap-3 cursor-pointer">
                        <div>
                          <div className="font-extrabold text-[var(--text)]">
                            Important Admin &amp; Security Chime
                          </div>
                          <div className="text-[11px] text-[var(--text-2)]">
                            Priority chime for dispute rulings and critical security alerts
                          </div>
                        </div>
                        <input
                          type="checkbox"
                          checked={preferences.adminAlertSoundEnabled}
                          onChange={(e) =>
                            onUpdatePreferences({
                              ...preferences,
                              adminAlertSoundEnabled: e.target.checked,
                            })
                          }
                          className="w-4 h-4 accent-[#FF6500] shrink-0"
                        />
                      </label>

                      <div className="space-y-1">
                        <label
                          htmlFor="bx-admin-sound-select"
                          className="block text-[11px] font-extrabold text-[var(--text-2)]"
                        >
                          Administrative Priority Chime
                        </label>
                        <div className="flex items-center gap-2">
                          <select
                            id="bx-admin-sound-select"
                            value={preferences.adminAlertSoundId}
                            onChange={(e) =>
                              onUpdatePreferences({
                                ...preferences,
                                adminAlertSoundId: e.target.value as NotificationSoundId,
                              })
                            }
                            className="bx-input flex-1 px-2.5 py-1.5 text-xs font-bold"
                          >
                            {NOTIFICATION_SOUND_CATALOG.map((opt) => (
                              <option key={opt.id} value={opt.id}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() =>
                              void handlePreviewSound(preferences.adminAlertSoundId, false)
                            }
                            aria-label="Preview admin priority alert sound"
                            className="bx-btn bx-btn-sm !min-h-[34px] !px-2.5 !py-1 text-xs font-extrabold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                          >
                            <Play className="w-3 h-3 text-[var(--orange)]" />
                            <span>
                              {previewingSoundId === preferences.adminAlertSoundId
                                ? 'Playing…'
                                : 'Preview'}
                            </span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {soundPreviewFeedback && (
                      <p className="text-[11px] font-bold text-[var(--green)] pt-1">
                        {soundPreviewFeedback}
                      </p>
                    )}
                  </section>

                  {/* 3. Deal-Room Vibration & Lock-Screen Privacy */}
                  <section className="p-3.5 rounded-xl border border-[var(--border-soft)] bg-[var(--surface)] space-y-3">
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <div className="flex items-start gap-2">
                        <Smartphone className="w-4 h-4 text-[var(--orange)] shrink-0 mt-0.5" />
                        <div>
                          <div className="font-extrabold text-[var(--text)]">
                            Deal-Room Tactile Vibration
                          </div>
                          <div className="text-[11px] text-[var(--text-2)]">
                            Tactile pulse vibration on supported Android/mobile browsers when a funded Deal Room opens
                          </div>
                        </div>
                      </div>
                      <input
                        type="checkbox"
                        checked={preferences.vibrationEnabled}
                        onChange={(e) =>
                          onUpdatePreferences({
                            ...preferences,
                            vibrationEnabled: e.target.checked,
                          })
                        }
                        className="w-4 h-4 accent-[#FF6500] shrink-0"
                      />
                    </label>

                    <div className="space-y-1">
                      <label
                        htmlFor="bx-vibration-strength-select"
                        className="block text-[11px] font-extrabold text-[var(--text-2)]"
                      >
                        Vibration Strength
                      </label>
                      <select
                        id="bx-vibration-strength-select"
                        disabled={!preferences.vibrationEnabled}
                        value={preferences.vibrationStrength || 'strong'}
                        onChange={(e) =>
                          onUpdatePreferences({
                            ...preferences,
                            vibrationStrength: (e.target.value === 'standard'
                              ? 'standard'
                              : 'strong') as VibrationStrength,
                          })
                        }
                        className="bx-input w-full px-2.5 py-1.5 text-xs font-bold disabled:opacity-50"
                      >
                        <option value="strong">
                          Strong (Triple-Pulse Deal Alert: 260ms · 320ms · 260ms)
                        </option>
                        <option value="standard">
                          Standard (Short Double-Pulse: 180ms · 240ms)
                        </option>
                      </select>
                    </div>

                    <div className="border-t border-[var(--border-soft)] pt-2.5 space-y-1.5">
                      <label
                        htmlFor="bx-lockscreen-privacy-select"
                        className="flex items-center gap-1.5 font-extrabold text-[var(--text)]"
                      >
                        <Lock className="w-3.5 h-3.5 text-[var(--orange)]" />
                        <span>Lock-Screen Push Privacy</span>
                      </label>
                      <select
                        id="bx-lockscreen-privacy-select"
                        value={preferences.lockScreenPrivacyMode}
                        onChange={(e) =>
                          onUpdatePreferences({
                            ...preferences,
                            lockScreenPrivacyMode:
                              e.target.value === 'standard' ? 'standard' : 'minimal',
                          })
                        }
                        className="bx-input w-full px-2.5 py-1.5 text-xs font-bold"
                      >
                        <option value="minimal">
                          Minimal (Recommended) — Hide asset names &amp; financial amounts
                        </option>
                        <option value="standard">
                          Standard — Show sanitized summary (never exposes emails, phones, or balances)
                        </option>
                      </select>
                      <p className="text-[11px] text-[var(--text-2)] leading-snug">
                        Note: Closed-tab OS push sound and vibration follow your browser and device system settings; custom chimes play whenever BEXORA is open.
                      </p>
                    </div>
                  </section>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}

      {/* Full Notification Reading Detail Modal */}
      {selectedNotification &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[80] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4"
            onClick={() => setSelectedNotificationId(null)}
            role="dialog"
            aria-modal="true"
            aria-label={`Notification detail: ${selectedNotification.title}`}
          >
            <div
              className="w-full max-w-lg max-h-[88vh] flex flex-col rounded-2xl border-2 border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow)] overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal Header */}
              <div className="px-5 py-4 border-b-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex items-start justify-between gap-3 shrink-0">
                <div className="space-y-1.5 min-w-0">
                  <div className="flex items-center gap-2 text-xs font-bold text-[var(--text-2)]">
                    {renderCategoryIcon(
                      selectedNotification.category,
                      selectedNotification.severity
                    )}
                    <span className="font-extrabold text-[var(--text)]">
                      {getNotificationCategoryLabel(selectedNotification.category)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="text-[var(--green)] font-extrabold">
                      {markingOneId === selectedNotification.id ? 'Marking as read…' : 'Read'}
                    </span>
                  </div>
                  <h3 className="text-base sm:text-lg font-black leading-snug break-words">
                    {selectedNotification.title}
                  </h3>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedNotificationId(null)}
                  className="bx-icon-btn !w-8 !h-8 shrink-0"
                  aria-label="Close notification detail"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="p-5 overflow-y-auto space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-[var(--text-2)] pb-3 border-b border-[var(--border-soft)]">
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <Clock className="w-3.5 h-3.5 text-[var(--orange)]" />
                    {formatNotificationExactDateTime(selectedNotification.createdAtMs)}
                  </span>
                  {selectedNotification.referenceLabel && (
                    <span className="text-xs font-extrabold text-[var(--text)]">
                      {selectedNotification.referenceLabel}
                    </span>
                  )}
                </div>

                <div className="text-sm font-medium leading-relaxed whitespace-pre-wrap break-words text-[var(--text)]">
                  {selectedNotification.body}
                </div>
              </div>

              {/* Modal Footer */}
              <div className="px-5 py-3.5 border-t-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex flex-wrap items-center justify-between gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setSelectedNotificationId(null)}
                  className="bx-btn bx-btn-sm text-xs font-extrabold whitespace-nowrap"
                >
                  <span>Back to Notifications</span>
                </button>

                <div className="flex items-center gap-2">
                  {safeSelectedDestination && (
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedNotificationId(null);
                        setOpen(false);
                        onNavigateDestination(safeSelectedDestination);
                      }}
                      className="bx-btn bx-btn-primary bx-btn-sm text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <span>{safeSelectedDestination.ctaLabel}</span>
                      <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedNotificationId(null);
                      setOpen(false);
                    }}
                    className="bx-btn bx-btn-sm text-xs font-extrabold whitespace-nowrap"
                  >
                    <span>Close</span>
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
