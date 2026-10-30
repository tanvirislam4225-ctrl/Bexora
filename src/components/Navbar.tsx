import React, { useState } from 'react';
import {
  Download,
  Home,
  LayoutGrid,
  LogOut,
  Menu,
  MessageSquare,
  Moon,
  Plus,
  ShieldCheck,
  Sun,
  Trophy,
  User as UserIcon,
  Wallet,
  X,
} from 'lucide-react';
import { CurrencyCode, LanguageCode, PublicProfile, ThemeMode } from '../types';
import { BexoraLogo } from './Icons';
import { SUPPORTED_LANGUAGES, t } from '../lib/i18n';

export type NavPage =
  | 'home'
  | 'market'
  | 'sellers'
  | 'chat'
  | 'deals'
  | 'profile'
  | 'public-profile'
  | 'admin';

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
  isAdmin: boolean;
  signingOut: boolean;
  onOpenAuth: () => void;
  onOpenCreateListing: () => void;
  onOpenWallet: () => void;
  onLogout: () => Promise<void>;
  isInstalled: boolean;
  onTriggerInstall: () => void;
  notificationSlot?: React.ReactNode;
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
  isAdmin,
  signingOut,
  onOpenAuth,
  onOpenCreateListing,
  onOpenWallet,
  onLogout,
  isInstalled,
  onTriggerInstall,
  notificationSlot,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const navItems: { id: NavPage; label: string; icon: React.ReactNode }[] = [
    { id: 'home', label: t(language, 'nav_home'), icon: <Home className="w-4 h-4" /> },
    { id: 'market', label: t(language, 'nav_market'), icon: <LayoutGrid className="w-4 h-4" /> },
    { id: 'sellers', label: t(language, 'nav_sellers'), icon: <Trophy className="w-4 h-4" /> },
    { id: 'chat', label: t(language, 'nav_chat'), icon: <MessageSquare className="w-4 h-4" /> },
    { id: 'deals', label: t(language, 'nav_deals'), icon: <ShieldCheck className="w-4 h-4" /> },
  ];

  const initials = (profile?.displayName || 'User')
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <>
      <header
        className="sticky top-0 z-50 border-b-2 backdrop-blur-md"
        style={{
          background: 'color-mix(in srgb, var(--bg) 92%, transparent)',
          borderColor: 'var(--border-strong)',
        }}
      >
        <div className="bx-wrap h-16 flex items-center justify-between gap-4">
          {/* Left: Hamburger on mobile + Official BEXORA Logo */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="bx-icon-btn lg:hidden"
              aria-label="Open navigation menu"
            >
              <Menu className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={() => onNavigate('home')}
              className="inline-flex items-center text-left"
              aria-label="BEXORA Home"
            >
              <BexoraLogo />
            </button>
          </div>

          {/* Center: Clean single-line text navigation links */}
          <nav className="hidden lg:flex items-center gap-6" aria-label="Main navigation">
            {navItems.map((item) => {
              const active = page === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onNavigate(item.id)}
                  className="text-sm font-bold whitespace-nowrap shrink-0 py-1.5 border-b-2 transition-colors"
                  style={{
                    color: active ? 'var(--orange)' : 'var(--text-2)',
                    borderColor: active ? 'var(--orange)' : 'transparent',
                  }}
                >
                  {item.label}
                </button>
              );
            })}
            {isAdmin && (
              <button
                type="button"
                onClick={() => onNavigate('admin')}
                className="text-sm font-bold whitespace-nowrap shrink-0 py-1.5 border-b-2 transition-colors"
                style={{
                  color: page === 'admin' ? 'var(--purple)' : 'var(--text-2)',
                  borderColor: page === 'admin' ? 'var(--purple)' : 'transparent',
                }}
              >
                {t(language, 'nav_admin')}
              </button>
            )}
          </nav>

          {/* Right: 1. Notification Bell -> 2. Theme Toggle -> 3. Sign In / Account Controls */}
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

            {userUid ? (
              <>
                <button
                  type="button"
                  onClick={onOpenWallet}
                  className="bx-icon-btn hidden sm:inline-flex"
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
                <button
                  type="button"
                  onClick={() => onNavigate('profile')}
                  className="bx-icon-btn font-extrabold text-xs"
                  style={{ background: 'var(--orange)', color: '#FFFFFF' }}
                  aria-label="My Profile"
                  title={profile?.displayName || 'My Profile'}
                >
                  {initials}
                </button>
              </>
            ) : (
              <button type="button" onClick={onOpenAuth} className="bx-btn bx-btn-primary bx-btn-sm">
                <span>{t(language, 'btn_login')}</span>
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Slide-over Navigation & Settings Menu Drawer */}
      {drawerOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex justify-start"
          onClick={() => setDrawerOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
        >
          <div
            className="w-[min(320px,88vw)] h-full overflow-y-auto p-5 flex flex-col gap-3 border-r-2"
            style={{ background: 'var(--bg)', borderColor: 'var(--border-strong)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
              <BexoraLogo compact />
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="bx-icon-btn !w-9 !h-9"
                aria-label="Close navigation menu"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex flex-col gap-1.5">
              {navItems.map((item) => {
                const active = page === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      onNavigate(item.id);
                      setDrawerOpen(false);
                    }}
                    className="flex items-center gap-3 px-3.5 py-3 rounded-xl font-bold text-sm text-left transition-colors"
                    style={{
                      background: active ? 'var(--surface-2)' : 'transparent',
                      color: active ? 'var(--orange)' : 'var(--text)',
                      border: active ? '1.5px solid var(--border-strong)' : '1.5px solid transparent',
                    }}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}

              {userUid && (
                <button
                  type="button"
                  onClick={() => {
                    onNavigate('profile');
                    setDrawerOpen(false);
                  }}
                  className="flex items-center gap-3 px-3.5 py-3 rounded-xl font-bold text-sm text-left"
                  style={{
                    background: page === 'profile' ? 'var(--surface-2)' : 'transparent',
                    color: page === 'profile' ? 'var(--orange)' : 'var(--text)',
                  }}
                >
                  <UserIcon className="w-4 h-4" />
                  <span>{t(language, 'nav_profile')}</span>
                </button>
              )}

              {isAdmin && (
                <button
                  type="button"
                  onClick={() => {
                    onNavigate('admin');
                    setDrawerOpen(false);
                  }}
                  className="flex items-center gap-3 px-3.5 py-3 rounded-xl font-bold text-sm text-left"
                  style={{
                    background: page === 'admin' ? 'var(--purple-soft)' : 'transparent',
                    color: 'var(--purple)',
                  }}
                >
                  <ShieldCheck className="w-4 h-4" />
                  <span>{t(language, 'nav_admin')}</span>
                </button>
              )}
            </div>

            <div className="h-px my-1" style={{ background: 'var(--border-soft)' }} />

            {/* Language & Currency Controls */}
            <div className="grid grid-cols-2 gap-2">
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
                  {SUPPORTED_LANGUAGES.map((l) => (
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
              className="bx-btn bx-btn-yellow w-full mt-1"
            >
              <Plus className="w-4 h-4" />
              <span>{t(language, 'btn_sell')}</span>
            </button>

            {!isInstalled && (
              <button
                type="button"
                onClick={() => {
                  setDrawerOpen(false);
                  onTriggerInstall();
                }}
                className="bx-btn w-full"
              >
                <Download className="w-4 h-4" />
                <span>{t(language, 'btn_install')}</span>
              </button>
            )}

            {userUid && (
              <button
                type="button"
                disabled={signingOut}
                onClick={async () => {
                  await onLogout();
                  setDrawerOpen(false);
                }}
                className="bx-btn bx-btn-danger w-full mt-auto"
              >
                <LogOut className="w-4 h-4" />
                <span>{signingOut ? 'Signing out…' : 'Logout'}</span>
              </button>
            )}
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
}> = ({ page, onNavigate, language }) => {
  const items: { id: NavPage; label: string; icon: React.ReactNode }[] = [
    { id: 'home', label: t(language, 'nav_home'), icon: <Home className="w-5 h-5" /> },
    { id: 'market', label: t(language, 'nav_market'), icon: <LayoutGrid className="w-5 h-5" /> },
    { id: 'chat', label: t(language, 'nav_chat'), icon: <MessageSquare className="w-5 h-5" /> },
    { id: 'deals', label: t(language, 'nav_deals'), icon: <ShieldCheck className="w-5 h-5" /> },
    { id: 'profile', label: t(language, 'nav_profile'), icon: <UserIcon className="w-5 h-5" /> },
  ];

  return (
    <nav
      className="fixed bottom-0 inset-x-0 z-40 grid grid-cols-5 border-t-2 border-[var(--bx-border)] bg-[var(--bx-bg)]/95 lg:hidden backdrop-blur-md"
      aria-label="Mobile bottom navigation"
    >
      {items.map((it) => {
        const active = page === it.id;
        return (
          <button
            key={it.id}
            type="button"
            onClick={() => onNavigate(it.id)}
            className={`flex flex-col items-center justify-center gap-1 min-h-[56px] px-1 text-[11px] font-bold transition-colors ${
              active ? 'text-[var(--orange)]' : 'text-[var(--text-3)]'
            }`}
          >
            {it.icon}
            <span className="truncate max-w-full">{it.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
