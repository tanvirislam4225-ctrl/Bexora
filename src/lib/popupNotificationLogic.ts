export type PopupNotificationDeliveryMode = 'global' | 'targeted';

export type PopupNotificationFrequency =
  | 'once_per_user'
  | 'once_per_session'
  | 'every_open'
  | 'until_dismissed';

export type PopupNotificationStoredStatus = 'draft' | 'active' | 'paused';

export type PopupNotificationEffectiveStatus =
  | 'draft'
  | 'scheduled'
  | 'active'
  | 'paused'
  | 'expired';

export type PopupNotificationThemeId =
  | 'modern_gradient'
  | 'premium_gold'
  | 'professional_business'
  | 'minimal_white'
  | 'dark_elegant'
  | 'colorful_announcement'
  | 'special_offer'
  | 'warning_alert'
  | 'success_notification'
  | 'festive_celebration';

export interface PopupNotificationStyleConfig {
  fontSizePx: number;
  fontWeight: '400' | '500' | '600' | '700' | '800';
  textColor: string;
  backgroundColor: string;
  useGradient: boolean;
  gradientFrom: string;
  gradientTo: string;
  gradientDirection: '135deg' | '90deg' | '180deg';
  textAlign: 'left' | 'center' | 'right';
  paddingPx: number;
  borderRadiusPx: number;
  popupWidthPx: number;
  popupHeightMode: 'auto' | 'custom';
  popupHeightPx: number;
  borderColor: string;
  accentColor: string;
  buttonEnabled: boolean;
  buttonText: string;
  buttonBgColor: string;
  buttonTextColor: string;
  buttonDestination: string;
  closeButtonEnabled: boolean;
}

export interface PopupNotificationTargetUser {
  uid: string;
  displayName: string;
  username: string;
  email: string;
}

export interface PopupNotificationCampaign {
  id: string;
  title: string;
  body: string;
  deliveryMode: PopupNotificationDeliveryMode;
  targetUserIds: string[];
  targetUsers?: PopupNotificationTargetUser[];
  themeId: PopupNotificationThemeId;
  style: PopupNotificationStyleConfig;
  bannerImageUrl: string;
  frequency: PopupNotificationFrequency;
  storedStatus: PopupNotificationStoredStatus;
  startAtMs: number;
  expiresAtMs: number;
  viewCount: number;
  dismissCount: number;
  createdBy: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface PopupNotificationReceiptState {
  viewed?: boolean;
  dismissed?: boolean;
  viewedAtMs?: number;
  dismissedAtMs?: number;
}

export interface PopupNotificationDashboardStats {
  total: number;
  active: number;
  scheduled: number;
  expired: number;
  globalCount: number;
  targetedCount: number;
  totalViews: number;
  totalDismissals: number;
}

export interface PopupNotificationThemePreset {
  id: PopupNotificationThemeId;
  label: string;
  description: string;
  badgeText: string;
  defaultTitle: string;
  defaultBody: string;
  style: PopupNotificationStyleConfig;
}

export const ASIA_DHAKA_TIMEZONE = 'Asia/Dhaka';
const DHAKA_UTC_OFFSET_MS = 6 * 60 * 60 * 1000;

export const POPUP_FREQUENCY_LABELS: Record<PopupNotificationFrequency, string> = {
  once_per_user: 'Once per user',
  once_per_session: 'Once per session',
  every_open: 'Every website open',
  until_dismissed: 'Until user dismisses',
};

export const POPUP_THEME_LIBRARY: PopupNotificationThemePreset[] = [
  {
    id: 'modern_gradient',
    label: 'Modern Gradient',
    description: 'Vibrant indigo-to-violet gradient card with crisp contrast and balanced CTA.',
    badgeText: 'Update',
    defaultTitle: 'New Marketplace Experience Is Live',
    defaultBody:
      'Discover faster verified escrow checkout, real-time notifications, and streamlined deal room tracking.',
    style: {
      fontSizePx: 15,
      fontWeight: '500',
      textColor: '#F8FAFC',
      backgroundColor: '#312E81',
      useGradient: true,
      gradientFrom: '#4F46E5',
      gradientTo: '#7C3AED',
      gradientDirection: '135deg',
      textAlign: 'left',
      paddingPx: 28,
      borderRadiusPx: 20,
      popupWidthPx: 480,
      popupHeightMode: 'auto',
      popupHeightPx: 360,
      borderColor: '#818CF8',
      accentColor: '#C4B5FD',
      buttonEnabled: true,
      buttonText: 'Explore Marketplace',
      buttonBgColor: '#FFFFFF',
      buttonTextColor: '#312E81',
      buttonDestination: '/market',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'premium_gold',
    label: 'Premium Gold',
    description: 'Luxury obsidian surface framed with warm metallic gold accents.',
    badgeText: 'VIP Notice',
    defaultTitle: 'Priority Escrow Access Unlocked',
    defaultBody:
      'Verified members now enjoy expedited review queues and dedicated protection support.',
    style: {
      fontSizePx: 15,
      fontWeight: '500',
      textColor: '#FEF3C7',
      backgroundColor: '#1C1917',
      useGradient: true,
      gradientFrom: '#1C1917',
      gradientTo: '#292524',
      gradientDirection: '135deg',
      textAlign: 'left',
      paddingPx: 28,
      borderRadiusPx: 18,
      popupWidthPx: 480,
      popupHeightMode: 'auto',
      popupHeightPx: 360,
      borderColor: '#D97706',
      accentColor: '#F59E0B',
      buttonEnabled: true,
      buttonText: 'View Benefits',
      buttonBgColor: '#F59E0B',
      buttonTextColor: '#1C1917',
      buttonDestination: '/wallet',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'professional_business',
    label: 'Professional Business',
    description: 'Executive slate-navy styling designed for operational notices and policy updates.',
    badgeText: 'Official Notice',
    defaultTitle: 'Scheduled Platform Governance Update',
    defaultBody:
      'Please review our updated escrow verification checklist before submitting your next digital asset listing.',
    style: {
      fontSizePx: 14,
      fontWeight: '500',
      textColor: '#0F172A',
      backgroundColor: '#F8FAFC',
      useGradient: false,
      gradientFrom: '#F8FAFC',
      gradientTo: '#E2E8F0',
      gradientDirection: '180deg',
      textAlign: 'left',
      paddingPx: 26,
      borderRadiusPx: 14,
      popupWidthPx: 500,
      popupHeightMode: 'auto',
      popupHeightPx: 340,
      borderColor: '#1E293B',
      accentColor: '#0F172A',
      buttonEnabled: true,
      buttonText: 'Review Guidelines',
      buttonBgColor: '#0F172A',
      buttonTextColor: '#FFFFFF',
      buttonDestination: '/info/escrow-protection',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'minimal_white',
    label: 'Minimal White',
    description: 'Clean Swiss editorial white card with generous whitespace and sharp typography.',
    badgeText: 'Announcement',
    defaultTitle: 'Important Account & Marketplace Notice',
    defaultBody:
      'Keep your contact details verified to receive instant bid, escrow, and settlement alerts.',
    style: {
      fontSizePx: 15,
      fontWeight: '400',
      textColor: '#18181B',
      backgroundColor: '#FFFFFF',
      useGradient: false,
      gradientFrom: '#FFFFFF',
      gradientTo: '#F4F4F5',
      gradientDirection: '180deg',
      textAlign: 'center',
      paddingPx: 30,
      borderRadiusPx: 16,
      popupWidthPx: 450,
      popupHeightMode: 'auto',
      popupHeightPx: 340,
      borderColor: '#E4E4E7',
      accentColor: '#FF6500',
      buttonEnabled: true,
      buttonText: 'Continue',
      buttonBgColor: '#18181B',
      buttonTextColor: '#FFFFFF',
      buttonDestination: '/market',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'dark_elegant',
    label: 'Dark Elegant',
    description: 'Deep charcoal velvet backdrop with refined contrast and subtle amethyst highlights.',
    badgeText: 'Spotlight',
    defaultTitle: 'Verified Assets Added Today',
    defaultBody:
      'Browse newly audited YouTube channels, monetized pages, and high-trust digital properties.',
    style: {
      fontSizePx: 15,
      fontWeight: '500',
      textColor: '#F4F4F5',
      backgroundColor: '#111118',
      useGradient: true,
      gradientFrom: '#111118',
      gradientTo: '#1F1B2E',
      gradientDirection: '135deg',
      textAlign: 'left',
      paddingPx: 28,
      borderRadiusPx: 20,
      popupWidthPx: 480,
      popupHeightMode: 'auto',
      popupHeightPx: 360,
      borderColor: '#793A91',
      accentColor: '#C084FC',
      buttonEnabled: true,
      buttonText: 'Browse Verified Assets',
      buttonBgColor: '#793A91',
      buttonTextColor: '#FFFFFF',
      buttonDestination: '/market',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'colorful_announcement',
    label: 'Colorful Announcement',
    description: 'Energetic coral-to-orange gradient crafted for high-engagement platform launches.',
    badgeText: 'Announcement',
    defaultTitle: 'Big Feature Drop on BEXORA',
    defaultBody:
      'Instant deal room updates, faster payout tracking, and improved asset verification are ready for you.',
    style: {
      fontSizePx: 15,
      fontWeight: '600',
      textColor: '#FFFFFF',
      backgroundColor: '#FF6500',
      useGradient: true,
      gradientFrom: '#FF6500',
      gradientTo: '#E11D48',
      gradientDirection: '135deg',
      textAlign: 'center',
      paddingPx: 28,
      borderRadiusPx: 22,
      popupWidthPx: 480,
      popupHeightMode: 'auto',
      popupHeightPx: 360,
      borderColor: '#FDE047',
      accentColor: '#FEF08A',
      buttonEnabled: true,
      buttonText: 'Check It Out',
      buttonBgColor: '#FFFFFF',
      buttonTextColor: '#BE123C',
      buttonDestination: '/market',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'special_offer',
    label: 'Special Offer',
    description: 'High-conversion teal-emerald offer frame tuned for fee discounts and promotions.',
    badgeText: 'Special Offer',
    defaultTitle: 'Limited-Time Reduced Escrow Fee',
    defaultBody:
      'List or purchase qualified verified digital assets during this promotional window with lower fees.',
    style: {
      fontSizePx: 15,
      fontWeight: '600',
      textColor: '#ECFDF5',
      backgroundColor: '#065F46',
      useGradient: true,
      gradientFrom: '#0F766E',
      gradientTo: '#047857',
      gradientDirection: '135deg',
      textAlign: 'center',
      paddingPx: 28,
      borderRadiusPx: 20,
      popupWidthPx: 470,
      popupHeightMode: 'auto',
      popupHeightPx: 360,
      borderColor: '#34D399',
      accentColor: '#6EE7B7',
      buttonEnabled: true,
      buttonText: 'Claim Offer',
      buttonBgColor: '#FACC15',
      buttonTextColor: '#064E3B',
      buttonDestination: '/sell',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'warning_alert',
    label: 'Warning Alert',
    description: 'High-clarity amber warning surface for urgent security or maintenance advisories.',
    badgeText: 'Important Alert',
    defaultTitle: 'Security & Escrow Verification Reminder',
    defaultBody:
      'Never share login credentials outside the official 3-party Deal Room. Always verify escrow payment status first.',
    style: {
      fontSizePx: 15,
      fontWeight: '600',
      textColor: '#451A03',
      backgroundColor: '#FFFBEB',
      useGradient: true,
      gradientFrom: '#FFFBEB',
      gradientTo: '#FEF3C7',
      gradientDirection: '180deg',
      textAlign: 'left',
      paddingPx: 26,
      borderRadiusPx: 16,
      popupWidthPx: 490,
      popupHeightMode: 'auto',
      popupHeightPx: 340,
      borderColor: '#D97706',
      accentColor: '#B45309',
      buttonEnabled: true,
      buttonText: 'View Active Deals',
      buttonBgColor: '#B45309',
      buttonTextColor: '#FFFFFF',
      buttonDestination: '/deals',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'success_notification',
    label: 'Success Notification',
    description: 'Reassuring emerald confirmation card for approvals, milestones, and completions.',
    badgeText: 'Confirmed',
    defaultTitle: 'Verification & Account Milestone Completed',
    defaultBody:
      'Your account privileges and marketplace protections are fully active. You are ready to trade safely.',
    style: {
      fontSizePx: 15,
      fontWeight: '500',
      textColor: '#052E16',
      backgroundColor: '#ECFDF5',
      useGradient: true,
      gradientFrom: '#ECFDF5',
      gradientTo: '#D1FAE5',
      gradientDirection: '180deg',
      textAlign: 'left',
      paddingPx: 26,
      borderRadiusPx: 18,
      popupWidthPx: 460,
      popupHeightMode: 'auto',
      popupHeightPx: 340,
      borderColor: '#10B981',
      accentColor: '#047857',
      buttonEnabled: true,
      buttonText: 'Open Dashboard',
      buttonBgColor: '#047857',
      buttonTextColor: '#FFFFFF',
      buttonDestination: '/profile',
      closeButtonEnabled: true,
    },
  },
  {
    id: 'festive_celebration',
    label: 'Festive Celebration',
    description: 'Warm festive burgundy-and-gold celebration card for holidays and milestone events.',
    badgeText: 'Celebration',
    defaultTitle: 'Festive Greetings From BEXORA!',
    defaultBody:
      'Thank you for being part of our trusted creator marketplace. Enjoy safe deals throughout this festive season.',
    style: {
      fontSizePx: 15,
      fontWeight: '600',
      textColor: '#FFFBEB',
      backgroundColor: '#7F1D1D',
      useGradient: true,
      gradientFrom: '#881337',
      gradientTo: '#B45309',
      gradientDirection: '135deg',
      textAlign: 'center',
      paddingPx: 30,
      borderRadiusPx: 24,
      popupWidthPx: 490,
      popupHeightMode: 'auto',
      popupHeightPx: 380,
      borderColor: '#FBBF24',
      accentColor: '#FDE68A',
      buttonEnabled: true,
      buttonText: 'Explore Featured Deals',
      buttonBgColor: '#FBBF24',
      buttonTextColor: '#450A0A',
      buttonDestination: '/market',
      closeButtonEnabled: true,
    },
  },
];

export function getPopupThemePreset(themeId: PopupNotificationThemeId): PopupNotificationThemePreset {
  return (
    POPUP_THEME_LIBRARY.find((preset) => preset.id === themeId) || POPUP_THEME_LIBRARY[0]!
  );
}

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

export function normalizeHexColor(value: unknown, fallback: string): string {
  const s = String(value || '').trim();
  return HEX_COLOR_REGEX.test(s) ? s.toUpperCase() : fallback;
}

const ALLOWED_INTERNAL_DESTINATIONS = new Set([
  '/',
  '/market',
  '/sell',
  '/deals',
  '/wallet',
  '/messages',
  '/profile',
  '/sellers',
  '/favorites',
  '/my-bids',
  '/following',
  '/reviews',
  '/info/escrow-protection',
  '/info/how-buying-works',
  '/info/how-selling-works',
  '/info/dispute-process',
]);

export function sanitizePopupDestinationUrl(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (s.startsWith('/')) {
    const clean = s.split('?')[0]?.trim() || '/';
    if (ALLOWED_INTERNAL_DESTINATIONS.has(clean) || /^\/info\/[a-z0-9-]+$/.test(clean)) {
      return clean;
    }
    return '';
  }
  if (/^https:\/\/[A-Za-z0-9.\-/:_?=&%#@~+!,;()]+$/.test(s) && s.length <= 300) {
    return s;
  }
  return '';
}

export function sanitizePopupBannerImageUrl(raw: unknown): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^https:\/\/[A-Za-z0-9.\-/:_?=&%#@~+!,;()]+$/.test(s) && s.length <= 300) {
    return s;
  }
  if (/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(s) && s.length <= 250000) {
    return s;
  }
  return '';
}

export function clampPopupNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function mergePopupStyleWithThemeDefaults(
  themeId: PopupNotificationThemeId,
  partial?: Partial<PopupNotificationStyleConfig>
): PopupNotificationStyleConfig {
  const base = getPopupThemePreset(themeId).style;
  if (!partial) return { ...base };
  const fontWeight = ['400', '500', '600', '700', '800'].includes(String(partial.fontWeight || ''))
    ? (String(partial.fontWeight) as PopupNotificationStyleConfig['fontWeight'])
    : base.fontWeight;
  const gradientDirection = ['135deg', '90deg', '180deg'].includes(String(partial.gradientDirection || ''))
    ? (String(partial.gradientDirection) as PopupNotificationStyleConfig['gradientDirection'])
    : base.gradientDirection;
  const textAlign = ['left', 'center', 'right'].includes(String(partial.textAlign || ''))
    ? (String(partial.textAlign) as PopupNotificationStyleConfig['textAlign'])
    : base.textAlign;
  const popupHeightMode =
    partial.popupHeightMode === 'custom' ? 'custom' : 'auto';

  return {
    fontSizePx: clampPopupNumber(partial.fontSizePx, 12, 24, base.fontSizePx),
    fontWeight,
    textColor: normalizeHexColor(partial.textColor, base.textColor),
    backgroundColor: normalizeHexColor(partial.backgroundColor, base.backgroundColor),
    useGradient:
      typeof partial.useGradient === 'boolean' ? partial.useGradient : base.useGradient,
    gradientFrom: normalizeHexColor(partial.gradientFrom, base.gradientFrom),
    gradientTo: normalizeHexColor(partial.gradientTo, base.gradientTo),
    gradientDirection,
    textAlign,
    paddingPx: clampPopupNumber(partial.paddingPx, 12, 48, base.paddingPx),
    borderRadiusPx: clampPopupNumber(partial.borderRadiusPx, 0, 36, base.borderRadiusPx),
    popupWidthPx: clampPopupNumber(partial.popupWidthPx, 320, 760, base.popupWidthPx),
    popupHeightMode,
    popupHeightPx: clampPopupNumber(partial.popupHeightPx, 220, 680, base.popupHeightPx),
    borderColor: normalizeHexColor(partial.borderColor, base.borderColor),
    accentColor: normalizeHexColor(partial.accentColor, base.accentColor),
    buttonEnabled:
      typeof partial.buttonEnabled === 'boolean' ? partial.buttonEnabled : base.buttonEnabled,
    buttonText:
      typeof partial.buttonText === 'string'
        ? partial.buttonText.trim().slice(0, 48) || base.buttonText
        : base.buttonText,
    buttonBgColor: normalizeHexColor(partial.buttonBgColor, base.buttonBgColor),
    buttonTextColor: normalizeHexColor(partial.buttonTextColor, base.buttonTextColor),
    buttonDestination:
      partial.buttonDestination !== undefined
        ? sanitizePopupDestinationUrl(partial.buttonDestination)
        : base.buttonDestination,
    closeButtonEnabled:
      typeof partial.closeButtonEnabled === 'boolean'
        ? partial.closeButtonEnabled
        : base.closeButtonEnabled,
  };
}

/**
 * Converts a datetime-local string (`YYYY-MM-DDTHH:mm`) interpreted in Bangladesh Time
 * (`Asia/Dhaka`, UTC+06:00, fixed offset with no DST) into a UTC epoch millisecond timestamp.
 */
export function dhakaInputToUtcMs(input: string | null | undefined): number {
  const raw = String(input || '').trim();
  if (!raw) return 0;
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return 0;
  }
  const utcAtWallClock = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  return utcAtWallClock - DHAKA_UTC_OFFSET_MS;
}

/**
 * Converts a UTC epoch millisecond timestamp into a `YYYY-MM-DDTHH:mm` string
 * formatted in Bangladesh Time (`Asia/Dhaka`, UTC+06:00).
 */
export function utcMsToDhakaInput(utcMs: number | null | undefined): string {
  if (!utcMs || !Number.isFinite(utcMs) || utcMs <= 0) return '';
  const shifted = new Date(utcMs + DHAKA_UTC_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = shifted.getUTCFullYear();
  const m = pad(shifted.getUTCMonth() + 1);
  const d = pad(shifted.getUTCDate());
  const hh = pad(shifted.getUTCHours());
  const mm = pad(shifted.getUTCMinutes());
  return `${y}-${m}-${d}T${hh}:${mm}`;
}

export function formatDhakaDateTime(utcMs: number | null | undefined): string {
  if (!utcMs || !Number.isFinite(utcMs) || utcMs <= 0) return 'Not set';
  try {
    const formatted = new Intl.DateTimeFormat('en-GB', {
      timeZone: ASIA_DHAKA_TIMEZONE,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(utcMs));
    return `${formatted} (BST)`;
  } catch {
    return `${utcMsToDhakaInput(utcMs).replace('T', ' ')} BST`;
  }
}

export function resolveEffectivePopupStatus(
  campaign: Pick<PopupNotificationCampaign, 'storedStatus' | 'startAtMs' | 'expiresAtMs'>,
  nowMs = Date.now()
): PopupNotificationEffectiveStatus {
  if (campaign.storedStatus === 'draft') return 'draft';
  if (campaign.storedStatus === 'paused') return 'paused';
  if (campaign.expiresAtMs > 0 && nowMs >= campaign.expiresAtMs) return 'expired';
  if (campaign.startAtMs > 0 && nowMs < campaign.startAtMs) return 'scheduled';
  return 'active';
}

export function isPopupCampaignLiveNow(
  campaign: Pick<PopupNotificationCampaign, 'storedStatus' | 'startAtMs' | 'expiresAtMs'>,
  nowMs = Date.now()
): boolean {
  return resolveEffectivePopupStatus(campaign, nowMs) === 'active';
}

export function canUserAccessPopupCampaign(
  campaign: Pick<
    PopupNotificationCampaign,
    'deliveryMode' | 'targetUserIds' | 'storedStatus' | 'startAtMs' | 'expiresAtMs'
  >,
  uid: string | null | undefined,
  nowMs = Date.now()
): boolean {
  if (!isPopupCampaignLiveNow(campaign, nowMs)) return false;
  if (campaign.deliveryMode === 'global') return true;
  if (!uid) return false;
  return Array.isArray(campaign.targetUserIds) && campaign.targetUserIds.includes(uid);
}

export interface FrequencyDisplayContext {
  campaignId: string;
  frequency: PopupNotificationFrequency;
  serverReceipt?: PopupNotificationReceiptState | null;
  localViewed?: boolean;
  localDismissed?: boolean;
  sessionViewed?: boolean;
  shownThisMount?: boolean;
}

export function shouldDisplayPopupForFrequency(ctx: FrequencyDisplayContext): boolean {
  if (ctx.shownThisMount) return false;

  const viewedAny = Boolean(ctx.serverReceipt?.viewed || ctx.localViewed);
  const dismissedAny = Boolean(ctx.serverReceipt?.dismissed || ctx.localDismissed);

  switch (ctx.frequency) {
    case 'once_per_user':
      return !viewedAny && !dismissedAny;
    case 'once_per_session':
      return !ctx.sessionViewed && !dismissedAny;
    case 'every_open':
      return !ctx.shownThisMount;
    case 'until_dismissed':
      return !dismissedAny;
    default:
      return !dismissedAny;
  }
}

export function computePopupNotificationDashboardStats(
  campaigns: PopupNotificationCampaign[],
  nowMs = Date.now()
): PopupNotificationDashboardStats {
  let active = 0;
  let scheduled = 0;
  let expired = 0;
  let globalCount = 0;
  let targetedCount = 0;
  let totalViews = 0;
  let totalDismissals = 0;

  for (const c of campaigns) {
    const eff = resolveEffectivePopupStatus(c, nowMs);
    if (eff === 'active') active += 1;
    else if (eff === 'scheduled') scheduled += 1;
    else if (eff === 'expired') expired += 1;

    if (c.deliveryMode === 'global') globalCount += 1;
    else targetedCount += 1;

    totalViews += Math.max(0, Number(c.viewCount || 0));
    totalDismissals += Math.max(0, Number(c.dismissCount || 0));
  }

  return {
    total: campaigns.length,
    active,
    scheduled,
    expired,
    globalCount,
    targetedCount,
    totalViews,
    totalDismissals,
  };
}
