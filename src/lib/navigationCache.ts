import type { AppRouteState, FullScreenPage } from './checkoutAndIntentLogic';

export function buildRouteScrollKey(route: AppRouteState): string {
  switch (route.page) {
    case 'listing':
      return `listing:${route.listingId || ''}`;
    case 'checkout':
      return `checkout:${route.checkoutDealId || route.checkoutListingId || ''}`;
    case 'public-profile':
      return `public-profile:${route.sellerUid || ''}`;
    case 'deals':
      return `deals:${route.dealId || 'list'}`;
    case 'chat':
      return `chat:${route.convId || 'list'}`;
    case 'info':
      return `info:${route.infoTopic || 'default'}`;
    case 'market':
      return `market:${route.platformFilter || 'all'}`;
    default:
      return route.page;
  }
}

export class RouteScrollMemory {
  private readonly positions = new Map<string, number>();

  constructor(private readonly maxEntries = 40) {}

  save(key: string, scrollY: number): void {
    const clean = Number.isFinite(scrollY) ? Math.max(0, Math.round(scrollY)) : 0;
    if (this.positions.has(key)) {
      this.positions.delete(key);
    } else if (this.positions.size >= this.maxEntries) {
      const oldest = this.positions.keys().next().value;
      if (oldest !== undefined) this.positions.delete(oldest);
    }
    this.positions.set(key, clean);
  }

  get(key: string): number {
    return this.positions.get(key) ?? 0;
  }

  clear(): void {
    this.positions.clear();
  }
}

export class NavigationDataCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAtMs: number }>();

  constructor(private readonly defaultTtlMs = 45_000, private readonly maxEntries = 80) {}

  get(key: string, nowMs = Date.now()): T | undefined {
    const item = this.entries.get(key);
    if (!item) return undefined;
    if (nowMs >= item.expiresAtMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh LRU order
    this.entries.delete(key);
    this.entries.set(key, item);
    return item.value;
  }

  set(key: string, value: T, ttlMs = this.defaultTtlMs, nowMs = Date.now()): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAtMs: nowMs + Math.max(1, ttlMs) });
  }

  invalidate(keyPrefix?: string): void {
    if (!keyPrefix) {
      this.entries.clear();
      return;
    }
    for (const k of Array.from(this.entries.keys())) {
      if (k.startsWith(keyPrefix)) this.entries.delete(k);
    }
  }
}

const IMMEDIATELY_ACTIVE_SUB_PAGES = new Set<FullScreenPage>([
  'profile',
  'sell',
  'my-bids',
  'chat',
  'deals',
  'wallet',
  'checkout',
  'admin',
]);

export function doesRouteRequireImmediateSecondarySubs(page: FullScreenPage): boolean {
  return IMMEDIATELY_ACTIVE_SUB_PAGES.has(page);
}

const prefetchedRouteChunks = new Set<string>();

const ROUTE_PREFETCHERS: Partial<Record<FullScreenPage, () => Promise<unknown>>> = {
  auth: () => import('../components/AuthModal'),
  listing: () => import('../components/ListingDetailModal'),
  checkout: () => import('../components/CheckoutView'),
  chat: () => import('../components/ChatView'),
  deals: () => import('../components/DealsView'),
  wallet: () => import('../components/WalletModal'),
  profile: () => import('../components/ProfileView'),
  'public-profile': () => import('../components/ProfileView'),
  sell: () => import('../components/CreateListingModal'),
  sellers: () => import('../components/TopSellersView'),
  favorites: () => import('../components/FavoritesView'),
  'my-bids': () => import('../components/MyBidsView'),
  following: () => import('../components/FollowingView'),
  admin: () => import('../components/AdminDashboard'),
  'recent-searches': () => import('../components/RecentSearchesView'),
  reviews: () => import('../components/ReviewsView'),
  info: () => import('../components/InfoCenterView'),
};

export function prefetchRouteView(page: FullScreenPage): void {
  if (typeof window === 'undefined' || prefetchedRouteChunks.has(page)) return;
  const loader = ROUTE_PREFETCHERS[page];
  if (!loader) return;
  prefetchedRouteChunks.add(page);
  void loader().catch(() => {
    prefetchedRouteChunks.delete(page);
  });
}
