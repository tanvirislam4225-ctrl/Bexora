import React, { useCallback, useEffect, useState } from 'react';
import { BellRing, X } from 'lucide-react';
import { resolveNotificationOnboardingState } from '../lib/notificationLogic';
import { requestNotificationPermissionFromOnboarding } from '../lib/pushNotifications';
import { detectBrowserPushEnvironment } from '../lib/soundAndPushConfig';

const ONBOARDING_DISMISSED_KEY = 'bx_notif_onboarding_dismissed_v1';

interface NotificationPermissionOnboardingProps {
  fallbackVapidKey?: string;
  onFlash?: (msg: string) => void;
}

function readBrowserPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission;
}

function readDismissedFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export const NotificationPermissionOnboarding: React.FC<
  NotificationPermissionOnboardingProps
> = ({ fallbackVapidKey, onFlash }) => {
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    readBrowserPermission()
  );
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissedFlag());
  const [submitting, setSubmitting] = useState(false);

  const refreshPermissionState = useCallback(() => {
    setPermission(readBrowserPermission());
    setDismissed(readDismissedFlag());
  }, []);

  useEffect(() => {
    refreshPermissionState();
    const onFocus = () => refreshPermissionState();
    window.addEventListener('focus', onFocus);

    let permStatus: PermissionStatus | null = null;
    const onPermChange = () => refreshPermissionState();
    if (typeof navigator !== 'undefined' && 'permissions' in navigator) {
      navigator.permissions
        .query({ name: 'notifications' as PermissionName })
        .then((status) => {
          permStatus = status;
          permStatus.addEventListener('change', onPermChange);
        })
        .catch(() => {
          // Permissions API query is optional
        });
    }

    return () => {
      window.removeEventListener('focus', onFocus);
      if (permStatus) {
        permStatus.removeEventListener('change', onPermChange);
      }
    };
  }, [refreshPermissionState]);

  const envInfo = detectBrowserPushEnvironment();

  const onboardingState = resolveNotificationOnboardingState({
    permission,
    dismissedInStorage: dismissed,
    isSecureContext: envInfo.isSecureContext,
    supportsNotificationApi: envInfo.supportsNotificationApi,
    supportsServiceWorker: envInfo.supportsServiceWorker,
    iosRequiresHomeScreenInstall: envInfo.iosRequiresHomeScreenInstall,
  });

  if (onboardingState !== 'show_onboarding') {
    return null;
  }

  const handleDismissNotNow = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  };

  const handleAllowNotifications = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const result = await requestNotificationPermissionFromOnboarding(fallbackVapidKey);
      setPermission(result.permission);
      if (result.permission === 'granted') {
        onFlash?.(result.message);
      } else if (result.permission === 'denied') {
        setDismissed(true);
        try {
          window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
        } catch {
          // Ignore storage errors
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="region"
      aria-label="Enable BEXORA notifications"
      className="border-b border-[var(--border-soft)] bg-[var(--surface-2)] px-4 py-2.5"
    >
      <div className="max-w-7xl mx-auto flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 text-xs">
        <div className="flex items-start sm:items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg border border-[var(--border-strong)] bg-[var(--surface)] flex items-center justify-center shrink-0 mt-0.5 sm:mt-0">
            <BellRing className="w-3.5 h-3.5 text-[var(--orange)]" />
          </div>
          <div className="min-w-0 leading-snug">
            <span className="font-black text-[var(--text)]">Stay updated on BEXORA: </span>
            <span className="font-semibold text-[var(--text-2)]">
              Allow browser notifications for instant updates on bids, escrow Deal Rooms, messages, wallet credits, and account security.
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 shrink-0">
          <button
            type="button"
            disabled={submitting}
            onClick={() => void handleAllowNotifications()}
            className="bx-btn bx-btn-primary bx-btn-sm !min-h-[32px] !px-3.5 !py-1 text-xs font-extrabold whitespace-nowrap"
          >
            {submitting ? 'Enabling…' : 'Allow Notifications'}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handleDismissNotNow}
            className="bx-btn bx-btn-ghost bx-btn-sm !min-h-[32px] !px-3 !py-1 text-xs font-bold whitespace-nowrap"
          >
            Not Now
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handleDismissNotNow}
            aria-label="Dismiss notification prompt"
            className="bx-icon-btn !w-7 !h-7 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
