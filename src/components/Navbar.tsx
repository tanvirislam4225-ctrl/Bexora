import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  Download,
  ExternalLink,
  Gavel,
  Heart,
  Home,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Trophy,
  User as UserIcon,
  UserCheck,
  Wallet,
  X,
} from 'lucide-react';
import { CurrencyCode, LanguageCode, PublicProfile, ThemeMode } from '../types';
import { BexoraLogo } from './Icons';
import { SUPPORTED_LANGUAGES, t } from '../lib/i18n';
import { FullScreenPage } from '../lib/checkoutAndIntentLogic';
import {
  buildProfileMenuActions,
  ProfileMenuActionId,
  shouldAutoCloseDrawerOnViewportWidth,
  shouldLockBodyScrollForDrawer,
} from '../lib/navigationAndProfileMenuLogic';
import { type AuthStateLifecycle } from '../lib/authDomainAndPersistenceLogic';
import type { CachedUser } from '../lib/cachedUser';

export type NavPage = FullScreenPage;

function isNavSectionActive(currentPage: FullScreenPage, navId: FullScreenPage): boolean {
  if (currentPage === navId) return true;
  if (navId === 'market' && (currentPage === 'listing' || currentPage === 'checkout')) return true;
  if (navId === 'sellers' && currentPage === 'public-profile') return true;
  return false;
}

interface NavbarProps {
  page: NavPage;
  onNavigate: (p: NavPage) => void;
  theme: ThemeMode;
  onToggleTheme: () => void;
  language: LanguageCode;
  onChangeLanguage: (l: LanguageCode) => void;
  currency: CurrencyCode;
  onChangeCurrency: (c: CurrencyCode) => void;
  userUid: string | null;
  profile: PublicProfile | null;
  cachedUser?: CachedUser | null;
  hasCachedUser?: boolean;
  authStatus?: AuthStateLifecycle;
  isAdmin: boolean;
  signingOut: boolean;
  onOpenAuth: () => void;
  onPrefetchAuth?: () => void;
  onOpenCreateListing: () => void;
  onOpenWallet: (mode?: 'deposit' | 'withdraw' | 'history') => void;
  onOpenPublicSelf?: () => void;
  onOpenSafetyAndAppeals?: () => void;
  onLogout: () => Promise<void>;
  isInstalled: boolean;
  onTriggerInstall: () => void;
  notificationSlot?: React.ReactNode;
  siteName?: string;
  logoUrl?: string;
  enabledLanguages?: LanguageCode[];
}

export const Navbar: React.FC<NavbarProps> = ({
  page,
  onNavigate,
  theme,
  onToggleTheme,
  language,
  onChangeLanguage,
  currency,
  onChangeCurrency,
  userUid,
  profile,
  cachedUser,
  hasCachedUser,
  authStatus,
  isAdmin,
  signingOut,
  onOpenAuth,
  onPrefetchAuth,
  onOpenCreateListing,
  onOpenWallet,
  onOpenPublicSelf,
  onOpenSafetyAndAppeals,
  onLogout,
  isInstalled,
  onTriggerInstall,
  notificationSlot,
  siteName,
  logoUrl,
  enabledLanguages,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const profileMenuWrapRef = useRef<HTMLDivElement | null>(null);

  const visibleLanguages =
    enabledLanguages && enabledLanguages.length > 0
      ? SUPPORTED_LANGUAGES.filter((l) => enabledLanguages.includes(l.code))
      : SUPPORTED_LANGUAGES;

  const navItems: { id: NavPage; label: string; icon: React.ReactNode }[] = [
    { id: 'home', label: t(language, 'nav_home'), icon: <Home className="w-4 h-4 shrink-0" /> },
    { id: 'market', label: t(language, 'nav_market'), icon: <LayoutGrid className="w-4 h-4 shrink-0" /> },
    { id: 'sellers', label: t(language, 'nav_sellers'), icon: <Trophy className="w-4 h-4 shrink-0" /> },
    { id: 'favorites', label: t(language, 'nav_favorites'), icon: <Heart className="w-4 h-4 shrink-0" /> },
    { id: 'my-bids', label: t(language, 'nav_my_bids'), icon: <Gavel className="w-4 h-4 shrink-0" /> },
    { id: 'following', label: t(language, 'nav_following'), icon: <UserCheck className="w-4 h-4 shrink-0" /> },
    { id: 'chat', label: t(language, 'nav_chat'), icon: <MessageSquare className="w-4 h-4 shrink-0" /> },
    { id: 'deals', label: t(language, 'nav_deals'), icon: <ShieldCheck className="w-4 h-4 shrink-0" /> },
  ];

  const activeAccount = profile ?? cachedUser ?? null;
  const effectiveUserUid = userUid ?? cachedUser?.uid ?? null;
  const effectiveAuthStatus: AuthStateLifecycle =
    authStatus ?? (effectiveUserUid || hasCachedUser ? 'authenticated' : 'unauthenticated');
  const isAuthenticatedUi =
    effectiveAuthStatus === 'authenticated' && Boolean(effectiveUserUid || hasCachedUser);

  const safeDisplayName = (activeAccount?.displayName || activeAccount?.username || '').trim();
  const initials = safeDisplayName
    ? safeDisplayName
        .split(/\s+/)
        .filter(Boolean)
        .map((w) => w[0])
        .slice(0, 2)
        .join('')
        .toUpperCase()
    : '';

  const profileMenuItems = buildProfileMenuActions({
    userUid: effectiveUserUid,
    isAdmin,
    signingOut,
  });
  const primaryProfileItems = profileMenuItems.filter((item) => item.section === 'primary');
  const footerProfileItems = profileMenuItems.filter((item) => item.section === 'footer');

  // Close profile menu when auth state clears
  useEffect(() => {
    if (!effectiveUserUid) {
      setProfileMenuOpen(false);
    }
  }, [effectiveUserUid]);

  // Close profile dropdown on outside pointer/touch click or Escape key
  useEffect(() => {
    if (!profileMenuOpen) return;

    const handlePointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (profileMenuWrapRef.current && target && !profileMenuWrapRef.current.contains(target)) {
        setProfileMenuOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setProfileMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [profileMenuOpen]);

  // Prevent background page scroll while hamburger drawer is open, close on Escape, and auto-close on desktop resize
  useEffect(() => {
    if (!shouldLockBodyScrollForDrawer(drawerOpen)) return;

    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawerOpen(false);
      }
    };

    const handleResize = () => {
      if (shouldAutoCloseDrawerOnViewportWidth(true, window.innerWidth)) {
        setDrawerOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
    };
  }, [drawerOpen]);

  const renderProfileActionIcon = (id: ProfileMenuActionId) => {
    switch (id) {
      case 'dashboard':
        return <UserIcon className="w-4 h-4 shrink-0 text-[var(--orange)]" />;
      case 'deposit':
        return <ArrowDownLeft className="w-4 h-4 shrink-0 text-[var(--green)]" />;
      case 'withdraw':
        return <ArrowUpRight className="w-4 h-4 shrink-0 text-[var(--purple)]" />;
      case 'public_profile':
        return <ExternalLink className="w-4 h-4 shrink-0 text-[var(--text-2)]" />;
      case 'safety_appeals':
        return <ShieldAlert className="w-4 h-4 shrink-0 text-[var(--orange)]" />;
      case 'admin':
        return <ShieldCheck className="w-4 h-4 shrink-0 text-[var(--purple)]" />;
      case 'logout':
        return <LogOut className="w-4 h-4 shrink-0" />;
    }
  };

  const handleSelectProfileMenuAction = async (id: ProfileMenuActionId) => {
    if (id === 'logout') {
      setProfileMenuOpen(false);
      await onLogout();
      return;
    }

    setProfileMenuOpen(false);
    switch (id) {
      case 'dashboard':
        onNavigate('profile');
        break;
      case 'deposit':
        onOpenWallet('deposit');
        break;
      case 'withdraw':
        onOpenWallet('withdraw');
        break;
      case 'public_profile':
        if (onOpenPublicSelf) {
          onOpenPublicSelf();
        } else {
          onNavigate('profile');
        }
        break;
      case 'safety_appeals':
        if (onOpenSafetyAndAppeals) {
          onOpenSafetyAndAppeals();
        } else {
          onNavigate('profile');
        }
        break;
      case 'admin':
        onNavigate('admin');
        break;
    }
  };

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b-2 border-[var(--border-strong)] bg-[var(--bg)]/92 backdrop-blur-md"
      >
        <div className="bx-wrap h-16 flex items-center justify-between gap-4">
          {/* Left: Hamburger on mobile/tablet + Official BEXORA Logo */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => {
                setProfileMenuOpen(false);
                setDrawerOpen(true);
              }}
              className="bx-icon-btn xl:hidden"
              aria-label="Open navigation menu"
              aria-expanded={drawerOpen}
              aria-controls="bx-navigation-drawer"
            >
              <Menu className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('home')}
              className="inline-flex items-center text-left"
              aria-label={`${siteName || 'BEXORA'} Home`}
            >
              <BexoraLogo siteName={siteName} logoUrl={logoUrl} />
            </button>
          </div>

          {/* Center: Clean single-line text navigation links on desktop */}
          <nav className="hidden xl:flex items-center gap-4 2xl:gap-5" aria-label="Main navigation">
            {navItems.map((item) => {
              const active = isNavSectionActive(page, item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  className={`text-sm font-bold whitespace-nowrap shrink-0 py-1.5 border-b-2 transition-colors ${
                    active
                      ? 'text-[var(--orange)] border-[var(--orange)]'
                      : 'text-[var(--text-2)] border-transparent hover:text-[var(--text)]'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
            {isAdmin && (
              <button
                type="button"
                onClick={() => onNavigate('admin')}
                className={`text-sm font-bold whitespace-nowrap shrink-0 py-1.5 border-b-2 transition-colors ${
                  page === 'admin'
                    ? 'text-[var(--purple)] border-[var(--purple)]'
                    : 'text-[var(--text-2)] border-transparent hover:text-[var(--purple)]'
                }`}
              >
                {t(language, 'nav_admin')}
              </button>
            )}
          </nav>

          {/* Right: 1. Notification Bell -> 2. Theme Toggle -> 3. Sign In / Account Profile Menu */}
          <div className="flex items-center gap-2 shrink-0">
            {notificationSlot}

            <button
              type="button"
              onClick={onToggleTheme}
              className="bx-icon-btn"
              aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
              title={theme === 'light' ? 'Dark Mode' : 'Light Mode'}
            >
              {theme === 'light' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
            </button>

            <div className="min-w-[84px] sm:min-w-[168px] flex items-center justify-end gap-2">
              {effectiveAuthStatus === 'initializing' ? (
                <div
                  className="w-[84px] sm:w-[168px] h-9 invisible pointer-events-none"
                  aria-hidden="true"
                />
              ) : isAuthenticatedUi ? (
                <>
                  <button
                    type="button"
                    onClick={() => onOpenWallet('deposit')}
                    className={`bx-icon-btn hidden sm:inline-flex ${
                      page === 'wallet'
                        ? '!bg-[var(--orange-soft)] !border-[var(--orange)]'
                        : ''
                    }`}
                    aria-label="Open Wallet"
                    title="Wallet & Add Balance"
                  >
                    <Wallet className="w-5 h-5" />
                  </button>
                  <button
                    type="button"
                    onClick={onOpenCreateListing}
                    className="bx-btn bx-btn-yellow bx-btn-sm hidden md:inline-flex"
                  >
                    <Plus className="w-4 h-4" />
                    <span>{t(language, 'btn_sell')}</span>
                  </button>

                  {/* Desktop / Tablet / Mobile Profile Dropdown Menu */}
                  <div ref={profileMenuWrapRef} className="relative">
                    <button
                      type="button"
                      data-testid="navbar-profile-menu-btn"
                      onClick={() => setProfileMenuOpen((prev) => !prev)}
                      className="bx-icon-btn !w-auto px-2.5 gap-1.5 font-extrabold text-xs !bg-[var(--orange)] !text-white min-w-[54px]"
                      aria-label="My Profile"
                      aria-haspopup="menu"
                      aria-expanded={profileMenuOpen}
                      title={safeDisplayName || 'My Profile'}
                    >
                      {activeAccount?.avatarUrl ? (
                        <img
                          src={activeAccount.avatarUrl}
                          alt={safeDisplayName || 'Profile'}
                          width={20}
                          height={20}
                          decoding="async"
                          className="w-5 h-5 rounded-full object-cover shrink-0"
                        />
                      ) : initials ? (
                        <span>{initials}</span>
                      ) : (
                        <UserIcon className="w-4 h-4 shrink-0" />
                      )}
                      <ChevronDown
                        className={`w-3.5 h-3.5 transition-transform duration-150 ${
                          profileMenuOpen ? 'rotate-180' : ''
                        }`}
                      />
                    </button>

                    {profileMenuOpen && (
                      <div
                        role="menu"
                        aria-label="Account profile menu"
                        data-testid="navbar-profile-dropdown"
                        className="absolute right-0 top-[calc(100%+8px)] w-64 max-w-[calc(100vw-2rem)] z-[65] bx-card p-2 shadow-xl"
                      >
                        {/* Signed-in Identity Summary */}
                        <div className="px-3 py-2.5 border-b border-[var(--border-soft)] mb-1">
                          {safeDisplayName && (
                            <div className="text-sm font-black truncate text-[var(--text)]">
                              {safeDisplayName}
                            </div>
                          )}
                          {activeAccount?.username && (
                            <div className="text-xs font-bold truncate text-[var(--text-2)]">
                              @{activeAccount.username}
                            </div>
                          )}
                        </div>

                      {/* Primary Profile Menu Navigation Options */}
                      <div className="flex flex-col gap-0.5">
                        {primaryProfileItems.map((action) => {
                          const isCurrentDashboard =
                            action.id === 'dashboard' && page === 'profile';
                          return (
                            <button
                              key={action.id}
                              type="button"
                              role="menuitem"
                              data-testid={`profile-menu-item-${action.id}`}
                              onClick={() => {
                                void handleSelectProfileMenuAction(action.id);
                              }}
                              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-extrabold text-left transition-colors ${
                                isCurrentDashboard
                                  ? 'bg-[var(--surface-2)] text-[var(--orange)]'
                                  : 'text-[var(--text)] hover:bg-[var(--surface-2)]'
                              }`}
                            >
                              {renderProfileActionIcon(action.id)}
                              <span className="truncate">{action.label}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Visual Separator Above Logout */}
                      <div
                        role="separator"
                        className="h-px my-1.5 bg-[var(--border-soft)]"
                      />

                      {/* Separated Logout Action at Bottom of Profile Menu */}
                      {footerProfileItems.map((action) => (
                        <button
                          key={action.id}
                          type="button"
                          role="menuitem"
                          data-testid="profile-menu-logout-btn"
                          disabled={signingOut}
                          onClick={() => {
                            void handleSelectProfileMenuAction(action.id);
                          }}
                          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-extrabold text-left transition-colors bg-[var(--red-soft)] text-[var(--red)] border border-[var(--red)] hover:opacity-90 disabled:opacity-50"
                        >
                          {renderProfileActionIcon(action.id)}
                          <span>{action.label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
              ) : (
                <button
                  type="button"
                  onClick={onOpenAuth}
                  onMouseEnter={onPrefetchAuth}
                  onFocus={onPrefetchAuth}
                  className="bx-btn bx-btn-orange bx-btn-sm inline-flex items-center gap-1.5"
                  data-testid="navbar-login-btn"
                >
                  <UserIcon className="w-4 h-4" />
                  <span>{t(language, 'btn_login')}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Slide-over Tablet & Mobile Navigation Drawer (Fixed Header + Independently Scrollable Body) */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-xs flex justify-start overscroll-none xl:hidden"
          onClick={() => setDrawerOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          id="bx-navigation-drawer"
        >
          <div
            className="w-[min(320px,88vw)] h-dvh max-h-dvh flex flex-col overflow-hidden border-r-2 border-[var(--border-strong)] bg-[var(--bg)] text-[var(--text)]"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Pinned Drawer Header (Always Accessible) */}
            <div className="shrink-0 flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--border-soft)] bg-[var(--bg)]">
              <BexoraLogo compact siteName={siteName} logoUrl={logoUrl} />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="bx-icon-btn !w-9 !h-9"
                aria-label="Close navigation menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Independently Scrollable Drawer Content Area */}
            <div
              data-testid="nav-drawer-scroll-body"
              className="flex-1 min-h-0 overflow-y-auto bx-drawer-scroll px-5 pt-3 pb-[calc(1.75rem+env(safe-area-inset-bottom))] flex flex-col gap-3"
            >
              <div className="flex flex-col gap-1.5 shrink-0">
                {navItems.map((item) => {
                  const active = isNavSectionActive(page, item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => {
                        onNavigate(item.id);
                        setDrawerOpen(false);
                      }}
                      className={`shrink-0 flex items-center gap-3 px-3.5 py-3 rounded-xl font-bold text-sm text-left border-[1.5px] transition-colors ${
                        active
                          ? 'bg-[var(--surface-2)] text-[var(--orange)] border-[var(--border-strong)]'
                          : 'bg-transparent text-[var(--text)] border-transparent hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      {item.icon}
                      <span>{item.label}</span>
                    </button>
                  );
                })}

                {effectiveAuthStatus === 'initializing' ? (
                  <div
                    className="h-[46px] w-full invisible pointer-events-none"
                    aria-hidden="true"
                  />
                ) : isAuthenticatedUi ? (
                  <button
                    type="button"
                    onClick={() => {
                      onNavigate('profile');
                      setDrawerOpen(false);
                    }}
                    className={`shrink-0 flex items-center gap-3 px-3.5 py-3 rounded-xl font-bold text-sm text-left border-[1.5px] transition-colors ${
                      page === 'profile'
                        ? 'bg-[var(--surface-2)] text-[var(--orange)] border-[var(--border-strong)]'
                        : 'bg-transparent text-[var(--text)] border-transparent hover:bg-[var(--surface-2)]'
                    }`}
                  >
                    <UserIcon className="w-4 h-4 shrink-0" />
                    <span>{activeAccount?.displayName || t(language, 'nav_profile')}</span>
                  </button>
                ) : null}

                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => {
                      onNavigate('admin');
                      setDrawerOpen(false);
                    }}
                    className={`shrink-0 flex items-center gap-3 px-3.5 py-3 rounded-xl font-bold text-sm text-left border-[1.5px] transition-colors ${
                      page === 'admin'
                        ? 'bg-[var(--purple-soft)] text-[var(--purple)] border-[var(--purple)]'
                        : 'bg-transparent text-[var(--purple)] border-transparent hover:bg-[var(--purple-soft)]'
                    }`}
                  >
                    <ShieldCheck className="w-4 h-4 shrink-0" />
                    <span>{t(language, 'nav_admin')}</span>
                  </button>
                )}
              </div>

              <div className="h-px my-1 shrink-0 bg-[var(--border-soft)]" />

              {/* Lower Menu Controls Below Admin Section (Always Reachable via Vertical Scroll) */}
              <div className="flex flex-col gap-3 shrink-0">
                {/* Language & Currency Controls */}
                <div className="grid grid-cols-2 gap-2 shrink-0">
                  <div>
                    <label htmlFor="drawer-lang" className="bx-label !text-xs">
                      Language
                    </label>
                    <select
                      id="drawer-lang"
                      value={language}
                      onChange={(e) => onChangeLanguage(e.target.value as LanguageCode)}
                      className="bx-select !min-h-[40px] !py-1.5 !text-xs"
                    >
                      {visibleLanguages.map((l) => (
                        <option key={l.code} value={l.code}>
                          {l.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="drawer-currency" className="bx-label !text-xs">
                      Currency
                    </label>
                    <select
                      id="drawer-currency"
                      value={currency}
                      onChange={(e) => onChangeCurrency(e.target.value as CurrencyCode)}
                      className="bx-select !min-h-[40px] !py-1.5 !text-xs"
                    >
                      <option value="BDT">BDT (৳)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    onOpenCreateListing();
                    setDrawerOpen(false);
                  }}
                  className="bx-btn bx-btn-yellow w-full shrink-0"
                >
                  <Plus className="w-4 h-4 shrink-0" />
                  <span>{t(language, 'btn_sell')}</span>
                </button>

                {!isInstalled && (
                  <button
                    type="button"
                    onClick={() => {
                      setDrawerOpen(false);
                      onTriggerInstall();
                    }}
                    className="bx-btn w-full shrink-0"
                  >
                    <Download className="w-4 h-4 shrink-0" />
                    <span>{t(language, 'btn_install')}</span>
                  </button>
                )}

                {effectiveAuthStatus === 'unauthenticated' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDrawerOpen(false);
                      onOpenAuth();
                    }}
                    onMouseEnter={onPrefetchAuth}
                    onFocus={onPrefetchAuth}
                    className="bx-btn bx-btn-orange w-full shrink-0 flex items-center justify-center gap-2"
                    data-testid="drawer-login-btn"
                  >
                    <UserIcon className="w-4 h-4 shrink-0" />
                    <span>{t(language, 'btn_login')}</span>
                  </button>
                ) : isAuthenticatedUi ? (
                  <button
                    type="button"
                    disabled={signingOut}
                    onClick={async () => {
                      setDrawerOpen(false);
                      await onLogout();
                    }}
                    className="bx-btn bx-btn-danger w-full shrink-0 flex items-center justify-center gap-2"
                    data-testid="drawer-logout-btn"
                  >
                    <LogOut className="w-4 h-4 shrink-0" />
                    <span>{signingOut ? 'Signing out…' : 'Logout'}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export const BottomNav: React.FC<{
  page: NavPage;
  onNavigate: (p: NavPage) => void;
  language: LanguageCode;
  cachedUser?: CachedUser | null;
  hasCachedUser?: boolean;
  authStatus?: AuthStateLifecycle;
}> = ({ page, onNavigate, language, cachedUser, hasCachedUser, authStatus }) => {
  const showAccountAvatar =
    (authStatus === 'authenticated' || Boolean(hasCachedUser)) && Boolean(cachedUser?.avatarUrl);

  const items: { id: NavPage; label: string; icon: React.ReactNode }[] = [
    { id: 'home', label: t(language, 'nav_home'), icon: <Home className="w-5 h-5" /> },
    { id: 'market', label: t(language, 'nav_market'), icon: <LayoutGrid className="w-5 h-5" /> },
    { id: 'chat', label: t(language, 'nav_chat'), icon: <MessageSquare className="w-5 h-5" /> },
    { id: 'deals', label: t(language, 'nav_deals'), icon: <ShieldCheck className="w-5 h-5" /> },
    {
      id: 'profile',
      label: t(language, 'nav_profile'),
      icon: showAccountAvatar && cachedUser?.avatarUrl ? (
        <img
          src={cachedUser.avatarUrl}
          alt={cachedUser.displayName || t(language, 'nav_profile')}
          width={20}
          height={20}
          decoding="async"
          className="w-5 h-5 rounded-full object-cover"
        />
      ) : (
        <UserIcon className="w-5 h-5" />
      ),
    },
  ];

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t-2 border-[var(--bx-border)] bg-[var(--bx-bg)]/95 lg:hidden backdrop-blur-md"
      aria-label="Mobile bottom navigation"
    >
      {items.map((it) => {
        const active = isNavSectionActive(page, it.id);
        const hideInitializingProfile = it.id === 'profile' && authStatus === 'initializing';
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onNavigate(it.id)}
            className={`flex flex-col items-center justify-center gap-1 min-h-[56px] px-1 text-[11px] font-bold transition-colors ${
              active ? 'text-[var(--orange)]' : 'text-[var(--text-3)]'
            } ${hideInitializingProfile ? 'invisible pointer-events-none' : ''}`}
          >
            {it.icon}
            <span className="truncate max-w-full">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
