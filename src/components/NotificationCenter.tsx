import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowRight,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  CheckCircle2,
  Clock,
  Eye,
  Info,
  Megaphone,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Sparkles,
  WifiOff,
  X,
} from 'lucide-react';
import type {
  NotificationCategory,
  NotificationRecord,
  NotificationSeverity,
} from '../types';
import {
  computeUnreadNotificationCount,
  formatNotificationExactDateTime,
  formatNotificationTimestamp,
  formatUnreadBadgeCount,
  getNotificationCategoryLabel,
  isFollowedSellerNewListingNotification,
  resolveNotificationOnboardingState,
  sanitizeNotificationDestination,
  sortNotificationsNewestFirst,
  type SafeInternalDestination,
} from '../lib/notificationLogic';
import {
  detectBrowserPushEnvironment,
  resolveNotificationAlertKind,
} from '../lib/soundAndPushConfig';

interface NotificationCenterProps {
  userUid: string | null;
  notifications: NotificationRecord[];
  loading: boolean;
  error: string | null;
  isOffline: boolean;
  onRetry: () => void;
  onMarkOneRead: (item: NotificationRecord) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onNavigateDestination: (dest: SafeInternalDestination) => void;
  onOpenAuth: () => void;
  externalOpenSignal?: number;
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

function readBrowserPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

export const NotificationCenter: React.FC<NotificationCenterProps> = ({
  userUid,
  notifications,
  loading,
  error,
  isOffline,
  onRetry,
  onMarkOneRead,
  onMarkAllRead,
  onNavigateDestination,
  onOpenAuth,
  externalOpenSignal,
}) => {
  const [open, setOpen] = useState(false);
  const [selectedNotificationId, setSelectedNotificationId] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [markingOneId, setMarkingOneId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [browserPermission, setBrowserPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() => readBrowserPermission());

  const bellButtonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (externalOpenSignal && externalOpenSignal > 0) {
      setOpen(true);
    }
  }, [externalOpenSignal]);

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

  const refreshPermission = useCallback(() => {
    setBrowserPermission(readBrowserPermission());
  }, []);

  useEffect(() => {
    if (open) {
      setActionError(null);
      refreshPermission();
    }
  }, [open, refreshPermission]);

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

  const inboxHintState = useMemo(() => {
    const envInfo = detectBrowserPushEnvironment();
    return resolveNotificationOnboardingState({
      permission: browserPermission,
      dismissedInStorage: true,
      isSecureContext: envInfo.isSecureContext,
      supportsNotificationApi: envInfo.supportsNotificationApi,
      supportsServiceWorker: envInfo.supportsServiceWorker,
      iosRequiresHomeScreenInstall: envInfo.iosRequiresHomeScreenInstall,
    });
  }, [browserPermission]);

  const handleMarkSingleRead = async (item: NotificationRecord) => {
    if (item.read || markingOneId === item.id) return;
    setActionError(null);
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
  };

  const handleViewNotification = async (item: NotificationRecord) => {
    setActionError(null);
    setSelectedNotificationId(item.id);
    if (!item.read) {
      await handleMarkSingleRead(item);
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

  const safeSelectedDestination = useMemo(
    () =>
      selectedNotification
        ? sanitizeNotificationDestination(selectedNotification.destination)
        : null,
    [selectedNotification]
  );

  const ariaBellLabel =
    unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications';

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

            {/* Unified Notification Inbox Panel */}
            <div
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label="Notification Inbox"
              className="fixed inset-x-3 top-[68px] sm:inset-x-auto sm:right-6 sm:top-[72px] sm:w-[440px] max-h-[calc(100vh-84px)] flex flex-col rounded-2xl border-2 border-[var(--border-strong)] bg-[var(--surface)] text-[var(--text)] shadow-[var(--shadow)] overflow-hidden"
            >
              {/* Panel Header */}
              <div className="px-4 py-3.5 border-b-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2 min-w-0">
                  <Bell className="w-4 h-4 text-[var(--orange)] shrink-0" />
                  <h2 className="text-base font-black tracking-tight whitespace-nowrap">
                    Inbox
                  </h2>
                  <span className="text-xs font-extrabold text-[var(--text-2)] tabular-nums whitespace-nowrap shrink-0">
                    · {unreadCount} unread
                  </span>
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleMarkAll()}
                    disabled={unreadCount === 0 || markingAll}
                    className="bx-btn bx-btn-sm !min-h-[34px] !px-2.5 !py-1 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
                  >
                    <CheckCheck className="w-3.5 h-3.5" />
                    <span className="sm:hidden">{markingAll ? '…' : 'Mark read'}</span>
                    <span className="hidden sm:inline">
                      {markingAll ? 'Updating…' : 'Mark all read'}
                    </span>
                  </button>
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

              {/* Discreet helper strip ONLY when browser push permission is denied or iOS needs Home Screen install */}
              {inboxHintState === 'denied_discreet_inbox_hint' && (
                <div className="px-4 py-2 bg-[var(--surface-2)] border-b border-[var(--border-soft)] flex items-start gap-2 text-[11px] font-semibold text-[var(--text-2)] leading-snug shrink-0">
                  <BellOff className="w-3.5 h-3.5 text-[var(--text-3)] shrink-0 mt-0.5" />
                  <span>
                    Browser alerts are turned off. Your BEXORA Inbox stays updated here — enable Notifications in your browser&apos;s site settings anytime to receive background alerts.
                  </span>
                </div>
              )}

              {inboxHintState === 'ios_install_inbox_hint' && (
                <div className="px-4 py-2 bg-[var(--surface-2)] border-b border-[var(--border-soft)] flex items-start gap-2 text-[11px] font-semibold text-[var(--text-2)] leading-snug shrink-0">
                  <Smartphone className="w-3.5 h-3.5 text-[var(--orange)] shrink-0 mt-0.5" />
                  <span>
                    On iPhone/iPad, tap Share &rarr; Add to Home Screen to receive background push alerts when BEXORA is closed.
                  </span>
                </div>
              )}

              {/* Unified Chronological Notification List */}
              <div className="flex-1 overflow-y-auto divide-y divide-[var(--border-soft)]">
                {loading ? (
                  <div className="p-8 text-center space-y-2.5">
                    <RefreshCw className="w-6 h-6 mx-auto animate-spin text-[var(--orange)]" />
                    <p className="text-xs font-extrabold text-[var(--text-2)]">
                      Syncing your inbox…
                    </p>
                  </div>
                ) : sortedNotifications.length === 0 ? (
                  <div className="p-8 text-center space-y-3">
                    <div className="w-12 h-12 mx-auto rounded-xl border-2 border-[var(--border-strong)] bg-[var(--surface-2)] flex items-center justify-center">
                      <Bell className="w-5 h-5 text-[var(--text-3)]" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-black text-[var(--text)]">
                        {userUid ? 'Your inbox is empty' : 'Sign in for account notifications'}
                      </p>
                      <p className="text-xs font-medium text-[var(--text-2)] max-w-xs mx-auto leading-relaxed">
                        {userUid
                          ? 'Real-time updates for bids, Deal Rooms, messages, followed sellers, wallet activity, and account security appear here.'
                          : 'Platform announcements appear here for everyone. Sign in to view your bids, Deal Rooms, messages, wallet updates, and security alerts.'}
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
                    const isFollowedListing = isFollowedSellerNewListingNotification(item);
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
                                : isFollowedListing
                                ? 'Followed Seller · New Listing'
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
                          <div className="flex items-center gap-1.5 shrink-0">
                            {isUnread && (
                              <button
                                type="button"
                                onClick={() => void handleMarkSingleRead(item)}
                                disabled={isSyncingThis}
                                aria-label={`Mark notification read: ${item.title}`}
                                className="bx-btn bx-btn-ghost bx-btn-sm !min-h-[30px] !px-2.5 !py-1 text-[11px] font-bold inline-flex items-center gap-1 whitespace-nowrap"
                              >
                                <Check className="w-3 h-3 text-[var(--green)]" />
                                <span>Mark read</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void handleViewNotification(item)}
                              disabled={isSyncingThis}
                              aria-label={`View notification: ${item.title}`}
                              className="bx-btn bx-btn-sm !min-h-[30px] !px-3 !py-1 text-xs font-extrabold inline-flex items-center gap-1.5 whitespace-nowrap"
                            >
                              <Eye className="w-3.5 h-3.5 text-[var(--orange)]" />
                              <span>{isSyncingThis ? 'Opening…' : 'View'}</span>
                            </button>
                          </div>
                        </div>
                      </article>
                    );
                  })
                )}
              </div>
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
                      {isFollowedSellerNewListingNotification(selectedNotification)
                        ? 'Followed Seller · New Listing'
                        : getNotificationCategoryLabel(selectedNotification.category)}
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
                  <span>Back to Inbox</span>
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
