import React from 'react';

export interface UserProfileLinkProps {
  uid?: string | null;
  name?: string | null;
  username?: string | null;
  onOpenProfile?: (uid: string) => void;
  className?: string;
  showAtPrefix?: boolean;
  stopPropagation?: boolean;
  title?: string;
  children?: React.ReactNode;
}

const NON_LINKABLE_UIDS = new Set(['system', 'admin', 'bexora', 'deleted', 'unknown', 'null', 'undefined']);

export function isLinkablePublicProfileUid(uid?: string | null): uid is string {
  if (typeof uid !== 'string') return false;
  const trimmed = uid.trim();
  if (!trimmed || trimmed.length > 128) return false;
  if (NON_LINKABLE_UIDS.has(trimmed.toLowerCase())) return false;
  return /^[a-zA-Z0-9_-]+$/.test(trimmed);
}

export const UserProfileLink: React.FC<UserProfileLinkProps> = ({
  uid,
  name,
  username,
  onOpenProfile,
  className = '',
  showAtPrefix = false,
  stopPropagation = true,
  title,
  children,
}) => {
  const displayLabel =
    children ??
    (showAtPrefix && username
      ? `@${username.replace(/^@+/, '')}`
      : name || (username ? `@${username.replace(/^@+/, '')}` : 'User'));

  if (!isLinkablePublicProfileUid(uid) || typeof onOpenProfile !== 'function') {
    return <span className={className}>{displayLabel}</span>;
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        if (stopPropagation) e.stopPropagation();
        onOpenProfile(uid.trim());
      }}
      title={title || `View ${typeof displayLabel === 'string' ? displayLabel : 'user'} public profile`}
      className={`inline text-left hover:underline focus:underline focus:outline-none cursor-pointer transition-opacity hover:opacity-85 ${className}`}
    >
      {displayLabel}
    </button>
  );
};
