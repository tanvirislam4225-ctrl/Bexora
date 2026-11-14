import React from 'react';
import { useUserStatus } from '../lib/presenceService';

export interface ActiveStatusProps {
  userId?: string | null;
  viewerUserId?: string | null;
  mode?: 'full' | 'dot' | 'text' | 'compact';
  showOfflineDot?: boolean;
  className?: string;
  dotClassName?: string;
  textClassName?: string;
}

/**
 * Reusable ActiveStatus component displaying WhatsApp / IMO-style presence:
 * - "Active now" with glowing green indicator
 * - "Active just now"
 * - "Active N min ago"
 * - "Active N hr ago"
 * - "Active N day(s) ago"
 * - "Offline" after 72 hours
 * - Respects privacy setting `showStatus` (hidden when false for other viewers)
 * - Accessible `aria-label`
 */
export const ActiveStatus: React.FC<ActiveStatusProps> = ({
  userId,
  viewerUserId,
  mode = 'full',
  showOfflineDot = false,
  className = '',
  dotClassName = '',
  textClassName = '',
}) => {
  const { loading, status } = useUserStatus(userId, viewerUserId);

  if (!userId || !status.visible) {
    return null;
  }

  // Loading skeleton placeholder so we never flash a wrong status
  if (loading) {
    if (mode === 'dot') {
      return (
        <span
          className={`inline-block w-2 h-2 rounded-full bg-slate-300 dark:bg-slate-700 animate-pulse ${className}`}
          aria-hidden="true"
        />
      );
    }
    return (
      <span
        className={`inline-flex items-center gap-1.5 text-xs opacity-60 animate-pulse ${className}`}
        aria-hidden="true"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-slate-300 dark:bg-slate-700" />
        <span className="h-3 w-16 rounded bg-slate-200 dark:bg-slate-800" />
      </span>
    );
  }

  // Dot-only mode (ideal for placing on avatar badges)
  if (mode === 'dot') {
    if (!status.isOnline && !showOfflineDot) {
      return null;
    }
    return (
      <span
        title={status.text}
        aria-label={status.ariaLabel}
        className={`inline-flex items-center justify-center ${className}`}
      >
        {status.isOnline ? (
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
          status.isOnline
            ? 'font-bold text-emerald-600 dark:text-emerald-400'
            : 'text-slate-500 dark:text-slate-400 font-medium'
        } ${textClassName}`}
        aria-label={status.ariaLabel}
      >
        {status.text}
      </span>
    );
  }

  // Compact / Full mode
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${className}`}
      aria-label={status.ariaLabel}
      title={status.text}
    >
      {status.isOnline ? (
        <>
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
          </span>
          <span className={`font-bold text-emerald-600 dark:text-emerald-400 ${textClassName}`}>
            {status.text}
          </span>
        </>
      ) : (
        <>
          <span className="h-1.5 w-1.5 rounded-full bg-slate-400 dark:bg-slate-500 shrink-0" />
          <span className={`text-slate-500 dark:text-slate-400 font-medium ${textClassName}`}>
            {status.text}
          </span>
        </>
      )}
    </span>
  );
};
