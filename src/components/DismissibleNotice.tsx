import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';

const ADMIN_HIDDEN_NOTICES_STORAGE_KEY = 'bexora_admin_hidden_notices_v1';
const ADMIN_NOTICES_CHANGED_EVENT = 'bexora:admin-notices-changed';

const DEFAULT_KNOWN_NOTICE_IDS = [
  'overview-policy',
  'branding-intro',
  'announcements-intro',
];

const registeredNoticeIds = new Set<string>(DEFAULT_KNOWN_NOTICE_IDS);

function readHiddenNoticeIds(): Set<string> {
  if (typeof window === 'undefined') return new Set<string>();
  try {
    const raw = window.localStorage.getItem(ADMIN_HIDDEN_NOTICES_STORAGE_KEY);
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0));
  } catch {
    return new Set<string>();
  }
}

function writeHiddenNoticeIds(ids: Set<string>): void {
  if (typeof window === 'undefined') return;
  try {
    if (ids.size === 0) {
      window.localStorage.removeItem(ADMIN_HIDDEN_NOTICES_STORAGE_KEY);
    } else {
      window.localStorage.setItem(ADMIN_HIDDEN_NOTICES_STORAGE_KEY, JSON.stringify(Array.from(ids)));
    }
    window.dispatchEvent(new CustomEvent(ADMIN_NOTICES_CHANGED_EVENT));
  } catch {
    // Ignore storage quota/security errors
  }
}

export function hideAdminNotice(id: string): void {
  const cleanId = String(id || '').trim();
  if (!cleanId) return;
  registeredNoticeIds.add(cleanId);
  const current = readHiddenNoticeIds();
  current.add(cleanId);
  writeHiddenNoticeIds(current);
}

export function hideAllAdminNotices(): void {
  const current = readHiddenNoticeIds();
  for (const id of registeredNoticeIds) {
    current.add(id);
  }
  writeHiddenNoticeIds(current);
}

export function restoreAllAdminNotices(): void {
  writeHiddenNoticeIds(new Set<string>());
}

interface DismissibleNoticeProps {
  id: string;
  children: React.ReactNode;
  className?: string;
}

export const DismissibleNotice: React.FC<DismissibleNoticeProps> = ({
  id,
  children,
  className = '',
}) => {
  const [hidden, setHidden] = useState<boolean>(() => readHiddenNoticeIds().has(id));

  useEffect(() => {
    registeredNoticeIds.add(id);
    const sync = () => {
      setHidden(readHiddenNoticeIds().has(id));
    };
    sync();
    window.addEventListener(ADMIN_NOTICES_CHANGED_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(ADMIN_NOTICES_CHANGED_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [id]);

  if (hidden) return null;

  return (
    <div className={`relative pr-8 ${className}`.trim()} data-dismissible-notice={id}>
      <button
        type="button"
        onClick={() => hideAdminNotice(id)}
        aria-label="Dismiss notice"
        title="Dismiss notice"
        className="absolute top-1.5 right-1.5 w-6 h-6 rounded inline-flex items-center justify-center opacity-60 hover:opacity-100 hover:bg-[var(--bx-surface-alt)] transition-opacity cursor-pointer"
      >
        <X className="w-3.5 h-3.5" />
      </button>
      {children}
    </div>
  );
};
