import {
  CurrencyCode,
  DealRecord,
  MarketplaceListing,
  PlatformId,
  PublicSettings,
} from '../types';
import {
  calculateAcceptedBidDealFinancials,
  formatMoneyFromMinor,
  getProtectionDurationHours,
  isDealUnpaidStatus,
} from './marketplaceLogic';

// ============================================================================
// 1. FULL-SCREEN PAGE ROUTING & URL SYNCHRONIZATION
// ============================================================================

export type FullScreenPage =
  | 'home'
  | 'market'
  | 'listing'
  | 'checkout'
  | 'auth'
  | 'wallet'
  | 'sell'
  | 'sellers'
  | 'favorites'
  | 'my-bids'
  | 'following'
  | 'chat'
  | 'deals'
  | 'profile'
  | 'public-profile'
  | 'admin';

export type AuthScreenMode = 'login' | 'register' | 'forgot';

export interface AppRouteState {
  page: FullScreenPage;
  listingId?: string;
  editListingId?: string;
  checkoutListingId?: string;
  checkoutDealId?: string;
  dealId?: string;
  convId?: string;
  sellerUid?: string;
  authMode?: AuthScreenMode;
  platformFilter?: PlatformId;
}

const SAFE_ROUTE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;
const VALID_PLATFORMS = new Set<string>([
  'youtube',
  'facebook',
  'instagram',
  'tiktok',
  'telegram',
  'website',
  'domain',
  'gaming',
]);

export function sanitizeRouteId(raw: string | null | undefined): string | undefined {
  const trimmed = String(raw || '').trim();
  if (!trimmed || !SAFE_ROUTE_ID_REGEX.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function sanitizeAuthMode(raw: string | null | undefined): AuthScreenMode {
  if (raw === 'register' || raw === 'forgot') return raw;
  return 'login';
}

/**
 * Parses URL search parameters (including direct links, `?autostart=1`, and legacy `?dest=...`
 * notification links) into a clean, full-screen `AppRouteState`.
 */
export function parseRouteFromSearch(search: string): AppRouteState {
  const cleanSearch = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(cleanSearch);

  // Support ?autostart=1 fast jump to marketplace
  if (params.get('autostart') === '1' && !params.get('view')) {
    return { page: 'market' };
  }

  // Support notification deep links (?dest=listing:abc, ?dest=deal:xyz, ?dest=wallet, etc.)
  const dest = (params.get('dest') || '').trim();
  if (dest && !params.get('view')) {
    if (dest === 'wallet') return { page: 'wallet' };
    if (dest === 'market' || dest === 'marketplace') return { page: 'market' };
    if (dest === 'sell') return { page: 'sell' };
    if (dest === 'sellers') return { page: 'sellers' };
    if (dest === 'favorites') return { page: 'favorites' };
    if (dest === 'my-bids') return { page: 'my-bids' };
    if (dest === 'following') return { page: 'following' };
    if (dest === 'deals') return { page: 'deals' };
    if (dest === 'chat') return { page: 'chat' };
    if (dest === 'profile' || dest.startsWith('profile:')) return { page: 'profile' };
    if (dest === 'admin') return { page: 'admin' };
    if (dest.startsWith('listing:')) {
      const id = sanitizeRouteId(dest.slice('listing:'.length));
      return id ? { page: 'listing', listingId: id } : { page: 'market' };
    }
    if (dest.startsWith('deal:')) {
      const id = sanitizeRouteId(dest.slice('deal:'.length));
      return id ? { page: 'deals', dealId: id } : { page: 'deals' };
    }
    if (dest.startsWith('admin:deal:') || dest.startsWith('admindeal:')) {
      const rawId = dest.startsWith('admin:deal:')
        ? dest.slice('admin:deal:'.length)
        : dest.slice('admindeal:'.length);
      const id = sanitizeRouteId(rawId);
      return id ? { page: 'admin', dealId: id } : { page: 'admin' };
    }
    if (dest.startsWith('chat:')) {
      const id = sanitizeRouteId(dest.slice('chat:'.length));
      return id ? { page: 'chat', convId: id } : { page: 'chat' };
    }
    if (dest.startsWith('seller:')) {
      const uid = sanitizeRouteId(dest.slice('seller:'.length));
      return uid ? { page: 'public-profile', sellerUid: uid } : { page: 'sellers' };
    }
  }

  const view = (params.get('view') || '').trim().toLowerCase();
  switch (view) {
    case 'market': {
      const rawPlat = (params.get('platform') || '').trim().toLowerCase();
      return {
        page: 'market',
        platformFilter: VALID_PLATFORMS.has(rawPlat) ? (rawPlat as PlatformId) : undefined,
      };
    }
    case 'listing': {
      const id = sanitizeRouteId(params.get('id'));
      return id ? { page: 'listing', listingId: id } : { page: 'market' };
    }
    case 'checkout': {
      const dealId = sanitizeRouteId(params.get('dealId'));
      const listingId = sanitizeRouteId(params.get('listingId'));
      if (dealId) return { page: 'checkout', checkoutDealId: dealId };
      if (listingId) return { page: 'checkout', checkoutListingId: listingId };
      return { page: 'market' };
    }
    case 'auth':
      return {
        page: 'auth',
        authMode: sanitizeAuthMode(params.get('authMode') || params.get('tab')),
      };
    case 'wallet':
      return { page: 'wallet' };
    case 'sell': {
      const editListingId = sanitizeRouteId(params.get('editListingId'));
      return editListingId ? { page: 'sell', editListingId } : { page: 'sell' };
    }
    case 'sellers':
      return { page: 'sellers' };
    case 'favorites':
      return { page: 'favorites' };
    case 'my-bids':
      return { page: 'my-bids' };
    case 'following':
      return { page: 'following' };
    case 'chat': {
      const convId = sanitizeRouteId(params.get('convId'));
      return { page: 'chat', convId };
    }
    case 'deals': {
      const dealId = sanitizeRouteId(params.get('dealId'));
      return { page: 'deals', dealId };
    }
    case 'profile':
      return { page: 'profile' };
    case 'seller':
    case 'public-profile': {
      const uid = sanitizeRouteId(params.get('uid'));
      return uid ? { page: 'public-profile', sellerUid: uid } : { page: 'sellers' };
    }
    case 'admin': {
      const dealId = sanitizeRouteId(params.get('dealId'));
      return { page: 'admin', dealId };
    }
    default:
      return { page: 'home' };
  }
}

/**
 * Serializes an `AppRouteState` into a deterministic URL query string (`""` for home, `"?view=..."` otherwise).
 * Preserves Firebase email action query params (`mode`, `oobCode`) or WordPress payment return params (`wp_session`, `wp_status`) if present.
 */
export function buildSearchForRoute(
  route: AppRouteState,
  existingSearch = ''
): string {
  const incoming = new URLSearchParams(
    existingSearch.startsWith('?') ? existingSearch.slice(1) : existingSearch
  );
  const out = new URLSearchParams();

  // Preserve transient callback tokens if currently active
  const oobMode = incoming.get('mode');
  const oobCode = incoming.get('oobCode');
  if ((oobMode === 'verifyEmail' || oobMode === 'resetPassword') && oobCode) {
    out.set('mode', oobMode);
    out.set('oobCode', oobCode);
  }
  const wpSession = sanitizeRouteId(incoming.get('wp_session'));
  if (wpSession && route.page === 'checkout') {
    out.set('wp_session', wpSession);
  }

  switch (route.page) {
    case 'home':
      break;
    case 'market':
      out.set('view', 'market');
      if (route.platformFilter && VALID_PLATFORMS.has(route.platformFilter)) {
        out.set('platform', route.platformFilter);
      }
      break;
    case 'listing':
      if (route.listingId && sanitizeRouteId(route.listingId)) {
        out.set('view', 'listing');
        out.set('id', route.listingId);
      } else {
        out.set('view', 'market');
      }
      break;
    case 'checkout':
      out.set('view', 'checkout');
      if (route.checkoutDealId && sanitizeRouteId(route.checkoutDealId)) {
        out.set('dealId', route.checkoutDealId);
      } else if (route.checkoutListingId && sanitizeRouteId(route.checkoutListingId)) {
        out.set('listingId', route.checkoutListingId);
      }
      break;
    case 'auth':
      out.set('view', 'auth');
      out.set('tab', sanitizeAuthMode(route.authMode));
      break;
    case 'wallet':
      out.set('view', 'wallet');
      break;
    case 'sell':
      out.set('view', 'sell');
      if (route.editListingId && sanitizeRouteId(route.editListingId)) {
        out.set('editListingId', route.editListingId);
      }
      break;
    case 'sellers':
      out.set('view', 'sellers');
      break;
    case 'favorites':
      out.set('view', 'favorites');
      break;
    case 'my-bids':
      out.set('view', 'my-bids');
      break;
    case 'following':
      out.set('view', 'following');
      break;
    case 'chat':
      out.set('view', 'chat');
      if (route.convId && sanitizeRouteId(route.convId)) {
        out.set('convId', route.convId);
      }
      break;
    case 'deals':
      out.set('view', 'deals');
      if (route.dealId && sanitizeRouteId(route.dealId)) {
        out.set('dealId', route.dealId);
      }
      break;
    case 'profile':
      out.set('view', 'profile');
      break;
    case 'public-profile':
      if (route.sellerUid && sanitizeRouteId(route.sellerUid)) {
        out.set('view', 'seller');
        out.set('uid', route.sellerUid);
      } else {
        out.set('view', 'sellers');
      }
      break;
    case 'admin':
      out.set('view', 'admin');
      if (route.dealId && sanitizeRouteId(route.dealId)) {
        out.set('dealId', route.dealId);
      }
      break;
  }

  const str = out.toString();
  return str ? `?${str}` : '';
}

// ============================================================================
// 2. LOGGED-OUT AUTHENTICATION CONTINUATION STATE MACHINE
// ============================================================================

export type PendingAuthIntent =
  | {
      kind: 'buy_now';
      listingId: string;
      listingTitle: string;
      returnPage: FullScreenPage;
      createdAtMs: number;
    }
  | {
      kind: 'place_bid';
      listingId: string;
      listingTitle: string;
      draftBidAmount: string;
      currency: CurrencyCode;
      returnPage: FullScreenPage;
      createdAtMs: number;
    }
  | {
      kind: 'pay_deal';
      dealId: string;
      listingTitle: string;
      returnPage: FullScreenPage;
      createdAtMs: number;
    }
  | {
      kind: 'message_seller';
      targetUid: string;
      targetName: string;
      listingId?: string;
      listingTitle?: string;
      returnPage: FullScreenPage;
      createdAtMs: number;
    }
  | {
      kind: 'toggle_favorite';
      listingId: string;
      listingTitle: string;
      returnPage: FullScreenPage;
      createdAtMs: number;
    }
  | {
      kind: 'follow_seller';
      sellerUid: string;
      sellerName: string;
      listingId?: string;
      returnPage: FullScreenPage;
      createdAtMs: number;
    }
  | {
      kind: 'open_page';
      targetPage:
        | 'wallet'
        | 'sell'
        | 'deals'
        | 'chat'
        | 'profile'
        | 'admin'
        | 'favorites'
        | 'my-bids'
        | 'following';
      dealId?: string;
      convId?: string;
      returnPage: FullScreenPage;
      createdAtMs: number;
    };

export const AUTH_INTENT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Ensures post-login continuation runs ONLY once Firebase Auth AND Firestore user profile + wallet
 * documents are hydrated—preventing the race condition where `fbUser` is set before `privateUser`
 * and downstream handlers falsely re-trigger `onRequireAuth()`.
 */
export function canResumeAuthIntent(params: {
  authReady: boolean;
  userUid: string | null;
  profileBootstrapped: boolean;
  hasProfile: boolean;
  hasPrivateUser: boolean;
  signingOut: boolean;
}): boolean {
  return (
    params.authReady &&
    Boolean(params.userUid) &&
    params.profileBootstrapped &&
    params.hasProfile &&
    params.hasPrivateUser &&
    !params.signingOut
  );
}

export function describePendingAuthIntent(intent: PendingAuthIntent | null): {
  heading: string;
  detail: string;
  backLabel: string;
} | null {
  if (!intent) return null;
  switch (intent.kind) {
    case 'buy_now':
      return {
        heading: 'Sign in or create an account to complete Buy Now checkout',
        detail: `Selected asset: "${intent.listingTitle}". You will proceed straight to secure Escrow Checkout right after authentication.`,
        backLabel: 'Back to Listing',
      };
    case 'place_bid': {
      const hasDraft = Boolean(intent.draftBidAmount && Number(intent.draftBidAmount) > 0);
      return {
        heading: 'Sign in or create an account to place your bid',
        detail: hasDraft
          ? `Your ${intent.currency} ${intent.draftBidAmount} bid on "${intent.listingTitle}" is saved and will be ready to submit immediately after sign-in.`
          : `Selected asset: "${intent.listingTitle}". You will return directly to the live bidding room after sign-in.`,
        backLabel: 'Back to Listing',
      };
    }
    case 'pay_deal':
      return {
        heading: 'Sign in to complete your Accepted Bid payment',
        detail: `Deal for "${intent.listingTitle}" is reserved. Sign in to proceed to Escrow Checkout.`,
        backLabel: 'Back',
      };
    case 'message_seller':
      return {
        heading: `Sign in to message ${intent.targetName}`,
        detail: intent.listingTitle
          ? `Your inquiry regarding "${intent.listingTitle}" will open in Pre-Deal Messenger right after sign-in.`
          : `Your conversation with ${intent.targetName} will open right after sign-in.`,
        backLabel: intent.listingId ? 'Back to Listing' : 'Back',
      };
    case 'toggle_favorite':
      return {
        heading: 'Sign in or create an account to save Favorites',
        detail: `"${intent.listingTitle}" will be added to your private Saved Favorites right after sign-in.`,
        backLabel: 'Back',
      };
    case 'follow_seller':
      return {
        heading: `Sign in or create an account to follow ${intent.sellerName}`,
        detail: `You will follow ${intent.sellerName} and receive alerts when they publish new listings.`,
        backLabel: 'Back',
      };
    case 'open_page': {
      const pageNames: Record<typeof intent.targetPage, string> = {
        sell: 'list a digital asset for sale',
        wallet: 'open your BEXORA Wallet',
        deals: 'access your Escrow Deal Rooms',
        chat: 'open Pre-Deal Messenger',
        profile: 'manage your BEXORA Profile',
        admin: 'access the Admin Console',
        favorites: 'view your Saved Favorites',
        'my-bids': 'view and manage My Bids',
        following: 'view your Followed Sellers',
      };
      return {
        heading: `Sign in or create an account to ${pageNames[intent.targetPage]}`,
        detail: 'You will be taken directly to your requested page as soon as you sign in.',
        backLabel: 'Back',
      };
    }
  }
}

export function serializePendingAuthIntent(intent: PendingAuthIntent | null): string | null {
  if (!intent) return null;
  try {
    return JSON.stringify(intent);
  } catch {
    return null;
  }
}

export function deserializePendingAuthIntent(
  raw: string | null | undefined,
  nowMs = Date.now()
): PendingAuthIntent | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingAuthIntent>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.kind !== 'string') return null;
    const createdAtMs = Number(parsed.createdAtMs || 0);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0 || nowMs - createdAtMs > AUTH_INTENT_TTL_MS) {
      return null;
    }
    const returnPage: FullScreenPage =
      typeof parsed.returnPage === 'string' ? (parsed.returnPage as FullScreenPage) : 'home';

    if (parsed.kind === 'buy_now') {
      const listingId = sanitizeRouteId((parsed as { listingId?: string }).listingId);
      if (!listingId) return null;
      return {
        kind: 'buy_now',
        listingId,
        listingTitle: String((parsed as { listingTitle?: string }).listingTitle || 'Selected Asset').slice(0, 140),
        returnPage,
        createdAtMs,
      };
    }
    if (parsed.kind === 'place_bid') {
      const listingId = sanitizeRouteId((parsed as { listingId?: string }).listingId);
      if (!listingId) return null;
      const rawCurrency = (parsed as { currency?: string }).currency;
      return {
        kind: 'place_bid',
        listingId,
        listingTitle: String((parsed as { listingTitle?: string }).listingTitle || 'Selected Asset').slice(0, 140),
        draftBidAmount: String((parsed as { draftBidAmount?: string }).draftBidAmount || '').slice(0, 24),
        currency: rawCurrency === 'USD' ? 'USD' : 'BDT',
        returnPage,
        createdAtMs,
      };
    }
    if (parsed.kind === 'pay_deal') {
      const dealId = sanitizeRouteId((parsed as { dealId?: string }).dealId);
      if (!dealId) return null;
      return {
        kind: 'pay_deal',
        dealId,
        listingTitle: String((parsed as { listingTitle?: string }).listingTitle || 'Reserved Asset').slice(0, 140),
        returnPage,
        createdAtMs,
      };
    }
    if (parsed.kind === 'message_seller') {
      const targetUid = sanitizeRouteId((parsed as { targetUid?: string }).targetUid);
      if (!targetUid) return null;
      const listingId = sanitizeRouteId((parsed as { listingId?: string }).listingId);
      return {
        kind: 'message_seller',
        targetUid,
        targetName: String((parsed as { targetName?: string }).targetName || 'Seller').slice(0, 80),
        listingId,
        listingTitle: (parsed as { listingTitle?: string }).listingTitle
          ? String((parsed as { listingTitle?: string }).listingTitle).slice(0, 140)
          : undefined,
        returnPage,
        createdAtMs,
      };
    }
    if (parsed.kind === 'toggle_favorite') {
      const listingId = sanitizeRouteId((parsed as { listingId?: string }).listingId);
      if (!listingId) return null;
      return {
        kind: 'toggle_favorite',
        listingId,
        listingTitle: String((parsed as { listingTitle?: string }).listingTitle || 'Selected Asset').slice(0, 140),
        returnPage,
        createdAtMs,
      };
    }
    if (parsed.kind === 'follow_seller') {
      const sellerUid = sanitizeRouteId((parsed as { sellerUid?: string }).sellerUid);
      if (!sellerUid) return null;
      const listingId = sanitizeRouteId((parsed as { listingId?: string }).listingId);
      return {
        kind: 'follow_seller',
        sellerUid,
        sellerName: String((parsed as { sellerName?: string }).sellerName || 'Seller').slice(0, 80),
        ...(listingId ? { listingId } : {}),
        returnPage,
        createdAtMs,
      };
    }
    if (parsed.kind === 'open_page') {
      const targetPage = (parsed as { targetPage?: string }).targetPage;
      if (
        targetPage !== 'wallet' &&
        targetPage !== 'sell' &&
        targetPage !== 'deals' &&
        targetPage !== 'chat' &&
        targetPage !== 'profile' &&
        targetPage !== 'admin' &&
        targetPage !== 'favorites' &&
        targetPage !== 'my-bids' &&
        targetPage !== 'following'
      ) {
        return null;
      }
      return {
        kind: 'open_page',
        targetPage,
        dealId: sanitizeRouteId((parsed as { dealId?: string }).dealId),
        convId: sanitizeRouteId((parsed as { convId?: string }).convId),
        returnPage,
        createdAtMs,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// 3. PURCHASE CHECKOUT QUOTE & WORDPRESS LIVE PAYMENT BRIDGE ARCHITECTURE
// ============================================================================

export interface CheckoutOrderQuote {
  mode: 'buy_now' | 'accepted_bid_deal';
  listingId: string;
  dealId?: string;
  acceptedBidId?: string;
  title: string;
  platform: PlatformId;
  subcategory: string;
  sellerId: string;
  sellerName: string;
  sellerVerified: boolean;
  currency: CurrencyCode;
  originalListingPriceMinor: number;
  baseAmountMinor: number;
  buyerFeePct: number;
  sellerFeePct: number;
  buyerFeeMinor: number;
  sellerFeeMinor: number;
  buyerTotalMinor: number;
  sellerPayoutMinor: number;
  platformCommissionMinor: number;
  refundBuyerMinor: number;
  refundPlatformRetainedMinor: number;
  protectionDurationHours: number;
}

export interface WalletSufficiencySummary {
  walletBalanceMinor: number;
  requiredInWalletCurrencyMinor: number;
  hasSufficientBalance: boolean;
  shortfallMinor: number;
  remainingAfterPurchaseMinor: number;
}

/**
 * Converts a purchase total into BDT minor units (since BEXORA Wallet balances are denominated in BDT minor units)
 * when the listing is priced in USD, or 1:1 when priced in BDT.
 */
export function convertOrderMinorToWalletBdtMinor(
  amountMinor: number,
  orderCurrency: CurrencyCode,
  usdToBdtRate = 120
): number {
  if (orderCurrency === 'BDT') return amountMinor;
  const safeRate = Number.isFinite(usdToBdtRate) && usdToBdtRate > 0 ? usdToBdtRate : 120;
  return Math.round(amountMinor * safeRate);
}

export function buildListingBuyNowQuote(
  listing: MarketplaceListing,
  settings: PublicSettings
): CheckoutOrderQuote {
  const financials = calculateAcceptedBidDealFinancials(
    listing.priceMinor,
    settings,
    listing.priceMinor
  );
  return {
    mode: 'buy_now',
    listingId: listing.id,
    title: listing.title,
    platform: listing.platform,
    subcategory: listing.subcategory,
    sellerId: listing.sellerId,
    sellerName: listing.sellerName,
    sellerVerified: listing.sellerVerified,
    currency: listing.currency,
    originalListingPriceMinor: listing.priceMinor,
    baseAmountMinor: financials.baseAmountMinor,
    buyerFeePct: financials.buyerFeePct,
    sellerFeePct: financials.sellerFeePct,
    buyerFeeMinor: financials.buyerFeeMinor,
    sellerFeeMinor: financials.sellerFeeMinor,
    buyerTotalMinor: financials.buyerTotalMinor,
    sellerPayoutMinor: financials.sellerPayoutMinor,
    platformCommissionMinor: financials.platformCommissionMinor,
    refundBuyerMinor: financials.refundBuyerMinor,
    refundPlatformRetainedMinor: financials.refundPlatformRetainedMinor,
    protectionDurationHours: getProtectionDurationHours(listing.platform, settings),
  };
}

export function buildAcceptedDealCheckoutQuote(
  deal: DealRecord,
  listing?: MarketplaceListing | null
): CheckoutOrderQuote {
  return {
    mode: 'accepted_bid_deal',
    listingId: deal.listingId,
    dealId: deal.id,
    acceptedBidId: deal.acceptedBidId,
    title: deal.listingTitle,
    platform: deal.platform,
    subcategory: listing?.subcategory || deal.platform.toUpperCase(),
    sellerId: deal.sellerId,
    sellerName: deal.sellerName,
    sellerVerified: Boolean(listing?.sellerVerified),
    currency: deal.currency,
    originalListingPriceMinor: deal.originalListingPriceMinor || deal.baseAmountMinor,
    baseAmountMinor: deal.baseAmountMinor,
    buyerFeePct: deal.buyerFeePct,
    sellerFeePct: deal.sellerFeePct,
    buyerFeeMinor: deal.buyerFeeMinor,
    sellerFeeMinor: deal.sellerFeeMinor,
    buyerTotalMinor: deal.buyerTotalMinor,
    sellerPayoutMinor: deal.sellerPayoutMinor,
    platformCommissionMinor: deal.platformCommissionMinor,
    refundBuyerMinor: deal.refundBuyerMinor ?? deal.baseAmountMinor,
    refundPlatformRetainedMinor: deal.refundPlatformRetainedMinor ?? deal.buyerFeeMinor,
    protectionDurationHours: deal.protectionDurationHours,
  };
}

export function computeCheckoutWalletState(
  walletBalanceMinor: number,
  quote: Pick<CheckoutOrderQuote, 'buyerTotalMinor' | 'currency'>,
  usdToBdtRate = 120
): WalletSufficiencySummary {
  const safeWallet = Math.max(0, Math.floor(Number(walletBalanceMinor) || 0));
  const requiredInWalletCurrencyMinor = convertOrderMinorToWalletBdtMinor(
    quote.buyerTotalMinor,
    quote.currency,
    usdToBdtRate
  );
  const hasSufficientBalance = safeWallet >= requiredInWalletCurrencyMinor;
  const shortfallMinor = hasSufficientBalance ? 0 : requiredInWalletCurrencyMinor - safeWallet;
  const remainingAfterPurchaseMinor = hasSufficientBalance
    ? safeWallet - requiredInWalletCurrencyMinor
    : 0;

  return {
    walletBalanceMinor: safeWallet,
    requiredInWalletCurrencyMinor,
    hasSufficientBalance,
    shortfallMinor,
    remainingAfterPurchaseMinor,
  };
}

export function canCheckoutDeal(deal: DealRecord | null | undefined, userUid: string | null): {
  eligible: boolean;
  reason?: string;
} {
  if (!deal) return { eligible: false, reason: 'Deal record not found.' };
  if (!userUid || deal.buyerId !== userUid) {
    return { eligible: false, reason: 'Only the reserved buyer can complete payment for this deal.' };
  }
  if (!isDealUnpaidStatus(deal.status)) {
    return { eligible: false, reason: 'This deal has already been funded or closed.' };
  }
  return { eligible: true };
}

// --- WordPress Multi-Gateway Live Payment Architecture ---

export interface WordPressPaymentMethod {
  id: string;
  title: string;
  description: string;
  providerBadge?: string;
  supportedCurrencies: CurrencyCode[];
  enabled: boolean;
  selectable: boolean;
}

export interface WordPressGatewayDiscoveryState {
  enabledInSettings: boolean;
  siteUrl: string;
  bridgeEndpoint: string;
  liveVerified: boolean;
  webhookSecretConfigured: boolean;
  methods: WordPressPaymentMethod[];
  statusCode:
    | 'not_configured'
    | 'disabled_by_admin'
    | 'server_bridge_unconfigured'
    | 'wordpress_unreachable'
    | 'no_active_gateways'
    | 'live_ready';
  userMessage: string;
}

export function validateWordPressSiteUrl(rawUrl: string): {
  valid: boolean;
  normalizedUrl: string;
  error?: string;
} {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) {
    return { valid: true, normalizedUrl: '' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'Enter a valid full WordPress HTTPS URL (e.g. https://pay.yourdomain.com).',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'WordPress live payment endpoints must use secure https://.',
    };
  }
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'Never embed API keys or credentials inside the public WordPress URL.',
    };
  }
  const normalized = `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  if (normalized.length > 200) {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'WordPress URL must be 200 characters or fewer.',
    };
  }
  return { valid: true, normalizedUrl: normalized };
}

/**
 * Normalizes raw WordPress REST / WooCommerce gateway payloads into safe, strictly validated
 * `WordPressPaymentMethod` items.
 *
 * CRITICAL ANTI-FAKE-PAYMENT INVARIANT:
 * A live payment method is marked `selectable: true` ONLY when:
 *   1. `enabledInSettings === true`
 *   2. `siteUrl` is a valid `https://` WordPress origin
 *   3. `liveVerified === true` (WordPress bridge responded with 200 OK)
 *   4. `webhookSecretConfigured === true` (server can cryptographically verify payment completion before marking deals paid)
 *   5. The gateway itself is `enabled === true` in WordPress.
 */
export function normalizeWordPressDiscovery(input: {
  enabledInSettings: boolean;
  siteUrl: string;
  bridgeEndpoint?: string;
  liveVerified: boolean;
  webhookSecretConfigured: boolean;
  rawMethods?: unknown[];
  errorHint?: string;
}): WordPressGatewayDiscoveryState {
  const urlCheck = validateWordPressSiteUrl(input.siteUrl);
  const cleanSiteUrl = urlCheck.valid ? urlCheck.normalizedUrl : '';
  const cleanEndpoint = String(input.bridgeEndpoint || '/wp-json/bexora/v1').trim() || '/wp-json/bexora/v1';

  if (!cleanSiteUrl) {
    return {
      enabledInSettings: false,
      siteUrl: '',
      bridgeEndpoint: cleanEndpoint,
      liveVerified: false,
      webhookSecretConfigured: Boolean(input.webhookSecretConfigured),
      methods: [],
      statusCode: 'not_configured',
      userMessage:
        'Live card, mobile banking, and international gateways will appear here automatically once WordPress Live Payment is connected. Use your BEXORA Wallet Balance to purchase immediately.',
    };
  }

  if (!input.enabledInSettings) {
    return {
      enabledInSettings: false,
      siteUrl: cleanSiteUrl,
      bridgeEndpoint: cleanEndpoint,
      liveVerified: false,
      webhookSecretConfigured: Boolean(input.webhookSecretConfigured),
      methods: [],
      statusCode: 'disabled_by_admin',
      userMessage:
        'WordPress Live Payment is currently paused in Admin Settings. Complete your purchase immediately using BEXORA Wallet Balance.',
    };
  }

  if (!input.webhookSecretConfigured) {
    return {
      enabledInSettings: true,
      siteUrl: cleanSiteUrl,
      bridgeEndpoint: cleanEndpoint,
      liveVerified: false,
      webhookSecretConfigured: false,
      methods: [],
      statusCode: 'server_bridge_unconfigured',
      userMessage:
        'WordPress payment verification secret is not active on this server yet. To prevent unverified orders, live gateways remain locked until webhook verification is enabled. Use BEXORA Wallet Balance.',
    };
  }

  if (!input.liveVerified) {
    return {
      enabledInSettings: true,
      siteUrl: cleanSiteUrl,
      bridgeEndpoint: cleanEndpoint,
      liveVerified: false,
      webhookSecretConfigured: true,
      methods: [],
      statusCode: 'wordpress_unreachable',
      userMessage:
        input.errorHint ||
        'WordPress payment gateway endpoint could not be reached right now. Please pay securely using your BEXORA Wallet Balance.',
    };
  }

  const rawList = Array.isArray(input.rawMethods) ? input.rawMethods : [];
  const methods: WordPressPaymentMethod[] = [];

  for (const item of rawList.slice(0, 20)) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawId = String(rec.id || rec.gateway_id || '').trim();
    if (!rawId || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawId)) continue;
    const title = String(rec.title || rec.method_title || rawId).trim().slice(0, 80);
    if (!title) continue;
    const description = String(rec.description || rec.method_description || '')
      .replace(/<[^>]*>/g, '')
      .trim()
      .slice(0, 220);
    const enabled = rec.enabled === true || rec.enabled === 'yes';
    const rawCurrencies = Array.isArray(rec.currencies)
      ? rec.currencies
      : Array.isArray(rec.supportedCurrencies)
      ? rec.supportedCurrencies
      : ['BDT', 'USD'];
    const supportedCurrencies = rawCurrencies
      .map((c) => String(c || '').toUpperCase())
      .filter((c): c is CurrencyCode => c === 'BDT' || c === 'USD');

    if (!enabled) continue;

    methods.push({
      id: rawId,
      title,
      description: description || `Pay securely via ${title} (verified WordPress checkout).`,
      providerBadge: rec.providerBadge ? String(rec.providerBadge).slice(0, 32) : 'Live Gateway',
      supportedCurrencies: supportedCurrencies.length > 0 ? supportedCurrencies : ['BDT', 'USD'],
      enabled: true,
      selectable: true,
    });
  }

  if (methods.length === 0) {
    return {
      enabledInSettings: true,
      siteUrl: cleanSiteUrl,
      bridgeEndpoint: cleanEndpoint,
      liveVerified: true,
      webhookSecretConfigured: true,
      methods: [],
      statusCode: 'no_active_gateways',
      userMessage:
        'WordPress is connected, but no live payment gateways are enabled yet in WordPress/WooCommerce. Use BEXORA Wallet Balance.',
    };
  }

  return {
    enabledInSettings: true,
    siteUrl: cleanSiteUrl,
    bridgeEndpoint: cleanEndpoint,
    liveVerified: true,
    webhookSecretConfigured: true,
    methods,
    statusCode: 'live_ready',
    userMessage: `${methods.length} verified live payment ${methods.length === 1 ? 'method' : 'methods'} available via WordPress.`,
  };
}

export function formatCheckoutShortfallNotice(
  shortfallMinorBdt: number,
  displayCurrency: CurrencyCode,
  usdToBdtRate = 120
): string {
  const formatted = formatMoneyFromMinor(shortfallMinorBdt, displayCurrency, 'BDT', usdToBdtRate);
  return `Add at least ${formatted} to your BEXORA Wallet to complete this escrow purchase.`;
}
