import React from 'react';
import { PlatformId } from '../types';

export const BexoraLogo: React.FC<{ compact?: boolean }> = ({ compact = false }) => {
  return (
    <span className="inline-flex items-center gap-2.5 select-none shrink-0">
      <img
        src="./icon.svg"
        alt="BEXORA official mark"
        width={compact ? 32 : 36}
        height={compact ? 32 : 36}
        className="w-8 h-8 md:w-9 md:h-9 rounded-lg object-contain shrink-0"
      />
      <span className="font-extrabold text-lg md:text-xl tracking-tight whitespace-nowrap" style={{ color: 'var(--text)' }}>
        BEXORA
      </span>
    </span>
  );
};

export const PlatformIcon: React.FC<{ id: PlatformId; size?: number; className?: string }> = ({
  id,
  size = 24,
  className = '',
}) => {
  switch (id) {
    case 'youtube':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
          <polygon points="10 9.2 15.2 12 10 14.8 10 9.2" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'facebook':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <path d="M15.5 4h-2.3A3.7 3.7 0 0 0 9.5 7.7V20" />
          <path d="M7.5 12h7" />
        </svg>
      );
    case 'instagram':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <circle cx="12" cy="12" r="4" />
          <circle cx="17.2" cy="6.8" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'tiktok':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <path d="M14.5 3.5v11.2a3.7 3.7 0 1 1-3.7-3.7" />
          <path d="M14.5 5.5a4.5 4.5 0 0 0 4.5 4.5" />
        </svg>
      );
    case 'telegram':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <path d="M21 4.2 3 11.2l5.4 2 2 6.2 3.1-3.6 4.5 3.2L21 4.2Z" />
          <path d="m8.4 13.2 8.4-5.4" />
        </svg>
      );
    case 'website':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <circle cx="12" cy="12" r="8.8" />
          <path d="M3.4 12h17.2" />
          <path d="M12 3.2a13.8 13.8 0 0 1 0 17.6 13.8 13.8 0 0 1 0-17.6Z" />
        </svg>
      );
    case 'domain':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="3" />
          <path d="M3 9.5h18" />
          <path d="M8 14.5h8" />
        </svg>
      );
    case 'gaming':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.85" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
          <path d="M7.5 8h9a4.5 4.5 0 0 1 4.4 5.4l-.5 2.6a2.6 2.6 0 0 1-4.4 1.3L14.6 16H9.4L8 17.3a2.6 2.6 0 0 1-4.4-1.3l-.5-2.6A4.5 4.5 0 0 1 7.5 8Z" />
          <path d="M8 11v2.6M6.7 12.3h2.6" />
          <circle cx="15.8" cy="11.6" r="0.95" fill="currentColor" stroke="none" />
          <circle cx="17.8" cy="13.4" r="0.95" fill="currentColor" stroke="none" />
        </svg>
      );
  }
};

export const PLATFORM_BANNER_BG: Record<PlatformId, string> = {
  youtube: 'linear-gradient(135deg, #FF6500, #FFB000)',
  facebook: 'linear-gradient(135deg, #2457C5, #5F93FF)',
  instagram: 'linear-gradient(135deg, #793A91, #FF6500)',
  tiktok: 'linear-gradient(135deg, #181822, #12897B)',
  telegram: 'linear-gradient(135deg, #1E78D6, #793A91)',
  website: 'linear-gradient(135deg, #12897B, #0D5C53)',
  domain: 'linear-gradient(135deg, #272738, #793A91)',
  gaming: 'linear-gradient(135deg, #5B2873, #D98200)',
};
