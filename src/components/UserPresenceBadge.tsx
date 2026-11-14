import React from 'react';
import { useUserPresence } from '../lib/userPresenceService';

export interface UserPresenceBadgeProps {
  uid?: string | null;
  mode?: 'full' | 'compact' | 'dot' | 'text';
  showOfflineDot?: boolean;
  className?: string;
  dotClassName?: string;
  textClassName?: string;
}

export const UserPresenceBadge: React.FC<UserPresenceBadgeProps> = ({
  uid,
  mode = 'full',
  showOfflineDot = false,
  className = '',
  dotClassName = '',
  textClassName = '',
}) => {
  const { isOnline, label, shortLabel } = useUserPresence(uid);

  if (!uid) return null;

  // Dot-only mode (ideal for placing on avatar badges; only shows glowing emerald dot when online unless showOfflineDot is true)
  if (mode === 'dot') {
    if (!isOnline && !showOfflineDot) {
      return null;
    }
    return (
      <span
        title={label}
        aria-label={`User status: ${label}`}
        className={`inline-flex items-center justify-center ${className}`}
      >
        {isOnline ? (
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span
              className={`relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500 ring-2 ring-white dark:ring-slate-900 ${dotClassName}`}
            />
          </span>
        ) : (
          <span
            className={`inline-flex rounded-full h-2 w-2 bg-slate-400 dark:bg-slate-600 ring-1.5 ring-white dark:ring-slate-900 ${dotClassName}`}
          />
        )}
      </span>
    );
  }

  // Text-only mode
  if (mode === 'text') {
    return (
      <span
        className={`text-xs ${
          isOnline
            ? 'font-semibold text-emerald-600 dark:text-emerald-400'
            : 'text-slate-500 dark:text-slate-400'
        } ${textClassName}`}
      >
        {label}
      </span>
    );
  }

  // Compact mode (ideal for narrow headers/cards)
  if (mode === 'compact') {
    return (
      <span
        title={label}
        className={`inline-flex items-center gap-1.5 text-xs ${className}`}
      >
        {isOnline ? (
          <>
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
            <span className={`font-bold text-emerald-600 dark:text-emerald-400 ${textClassName}`}>
              Online
            </span>
          </>
        ) : (
          <span className={`text-slate-500 dark:text-slate-400 ${textClassName}`}>
            {shortLabel}
          </span>
        )}
      </span>
    );
  }

  // Full mode (WhatsApp / Messenger style)
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${className}`}
      aria-label={`User status: ${label}`}
    >
      {isOnline ? (
        <>
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className={`font-bold text-emerald-600 dark:text-emerald-400 ${textClassName}`}>
            Online
          </span>
        </>
      ) : (
        <span className={`text-slate-500 dark:text-slate-400 font-medium ${textClassName}`}>
          {label}
        </span>
      )}
    </span>
  );
};
