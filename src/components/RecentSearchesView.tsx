import React, { useState } from 'react';
import { ArrowRight, Clock, History, LayoutGrid, Search, Trash2, X } from 'lucide-react';
import { PlatformId, RecentSearchRecord } from '../types';
import { PLATFORM_CATALOG, PLATFORM_LIST } from '../lib/marketplaceLogic';
import { formatActivityRelativeTime } from '../lib/activityTickerLogic';
import { PlatformIcon } from './Icons';

export interface RecentSearchesViewProps {
  isAuthenticated: boolean;
  recentSearches: ReadonlyArray<RecentSearchRecord>;
  onExecuteRecentSearch: (record: RecentSearchRecord) => void;
  onDeleteRecentSearch: (searchId: string) => Promise<void> | void;
  onClearAllRecentSearches: () => Promise<void> | void;
  onBrowseCategory: (platform: PlatformId) => void;
  onBrowseMarketplace: () => void;
}

export const RecentSearchesView: React.FC<RecentSearchesViewProps> = ({
  isAuthenticated,
  recentSearches,
  onExecuteRecentSearch,
  onDeleteRecentSearch,
  onClearAllRecentSearches,
  onBrowseCategory,
  onBrowseMarketplace,
}) => {
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');

  const handleQuickSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = quickQuery.trim();
    if (!trimmed) {
      onBrowseMarketplace();
      return;
    }
    onExecuteRecentSearch({
      id: 'quick',
      query: trimmed,
      platform: '',
      subcategory: '',
      monetization: 'all',
      verifiedOnly: false,
      sortBy: 'newest',
      summaryLabel: `"${trimmed}"`,
      searchedAtMs: Date.now(),
    });
  };

  return (
    <section
      className="bx-wrap-wide py-8 space-y-6"
      aria-label="Recent Searches"
      data-testid="recent-searches-view"
    >
      {/* Header */}
      <div
        className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-5 border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div className="space-y-1">
          <p className="bx-eyebrow">Private Discovery History</p>
          <h1 className="text-2xl sm:text-3xl font-black tracking-tight">Recent Searches</h1>
          <p className="text-sm max-w-2xl" style={{ color: 'var(--text-2)' }}>
            {isAuthenticated
              ? 'Your recent marketplace searches and category filters are privately synced to your account and never visible to other users.'
              : 'Your recent marketplace searches are stored privately in this browser. Sign in anytime to sync search history to your account.'}
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap shrink-0">
          {recentSearches.length > 0 && (
            <button
              type="button"
              disabled={clearingAll}
              onClick={async () => {
                setClearingAll(true);
                try {
                  await onClearAllRecentSearches();
                } finally {
                  setClearingAll(false);
                }
              }}
              className="bx-btn bx-btn-sm whitespace-nowrap"
            >
              <Trash2 className="w-4 h-4" />
              <span>{clearingAll ? 'Clearing…' : 'Clear All'}</span>
            </button>
          )}
          <button
            type="button"
            onClick={onBrowseMarketplace}
            className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap"
          >
            <LayoutGrid className="w-4 h-4" />
            <span>Open Marketplace</span>
          </button>
        </div>
      </div>

      {/* Direct Search Input */}
      <form onSubmit={handleQuickSubmit} className="flex flex-col sm:flex-row gap-2.5 max-w-2xl">
        <div className="relative flex-1">
          <Search
            className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-3)' }}
          />
          <input
            type="search"
            value={quickQuery}
            onChange={(e) => setQuickQuery(e.target.value)}
            placeholder="Run a new marketplace search (e.g. Monetized YouTube, Gaming, SaaS)…"
            aria-label="New marketplace search"
            className="bx-input pl-10 pr-4"
          />
        </div>
        <button type="submit" className="bx-btn bx-btn-primary whitespace-nowrap shrink-0">
          <Search className="w-4 h-4" />
          <span>Search Listings</span>
        </button>
      </form>

      {/* Saved Recent Searches List or Honest Empty State */}
      {recentSearches.length === 0 ? (
        <div className="bx-card p-8 sm:p-10 text-center space-y-5">
          <div
            className="w-12 h-12 rounded-2xl mx-auto grid place-items-center"
            style={{ background: 'var(--surface-2)', color: 'var(--purple)' }}
          >
            <History className="w-6 h-6" />
          </div>
          <div className="space-y-1.5 max-w-md mx-auto">
            <h2 className="text-lg font-extrabold">No recent searches saved yet</h2>
            <p className="text-sm" style={{ color: 'var(--text-2)' }}>
              Whenever you search for channels, pages, websites, domains, or gaming accounts—or apply category filters—your recent searches appear here for one-click access.
            </p>
          </div>

          <div className="pt-2 space-y-2.5">
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
              Explore Supported Categories
            </p>
            <div className="flex flex-wrap items-center justify-center gap-2">
              {PLATFORM_LIST.map((pId) => {
                const plat = PLATFORM_CATALOG[pId];
                return (
                  <button
                    key={pId}
                    type="button"
                    onClick={() => onBrowseCategory(pId)}
                    className="bx-btn bx-btn-sm whitespace-nowrap"
                  >
                    <PlatformIcon id={pId} size={15} />
                    <span>{plat.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {recentSearches.map((item) => {
            const isDeleting = deletingId === item.id;
            const platMeta = item.platform ? PLATFORM_CATALOG[item.platform] : null;

            return (
              <article
                key={item.id}
                className="bx-card p-4 flex flex-col justify-between gap-3.5 min-w-0"
              >
                <div className="space-y-2 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => onExecuteRecentSearch(item)}
                      className="text-left font-extrabold text-[15px] leading-snug line-clamp-2 hover:underline flex-1 min-w-0"
                      style={{ color: 'var(--text)' }}
                    >
                      {item.summaryLabel}
                    </button>

                    <button
                      type="button"
                      disabled={isDeleting}
                      onClick={async () => {
                        setDeletingId(item.id);
                        try {
                          await onDeleteRecentSearch(item.id);
                        } finally {
                          setDeletingId(null);
                        }
                      }}
                      aria-label={`Delete recent search ${item.summaryLabel}`}
                      title="Remove from recent searches"
                      className="w-8 h-8 rounded-lg grid place-items-center shrink-0 border transition-colors hover:opacity-100 opacity-75"
                      style={{
                        borderColor: 'var(--border-soft)',
                        background: 'var(--surface-2)',
                        color: 'var(--text-2)',
                      }}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Unboxed filter metadata */}
                  <div
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold tabular-nums"
                    style={{ color: 'var(--text-2)' }}
                  >
                    {platMeta ? (
                      <span className="inline-flex items-center gap-1">
                        <PlatformIcon id={platMeta.id} size={13} />
                        <span>{platMeta.name}</span>
                      </span>
                    ) : (
                      <span>All Categories</span>
                    )}
                    {item.subcategory && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{item.subcategory}</span>
                      </>
                    )}
                    {item.monetization !== 'all' && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {item.monetization === 'monetized' ? 'Monetized' : 'Non-Monetized'}
                        </span>
                      </>
                    )}
                    {item.verifiedOnly && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span style={{ color: 'var(--green)' }}>Verified Only</span>
                      </>
                    )}
                  </div>
                </div>

                <div
                  className="pt-3 border-t flex items-center justify-between gap-2"
                  style={{ borderColor: 'var(--border-soft)' }}
                >
                  <span
                    className="inline-flex items-center gap-1 text-xs font-medium tabular-nums"
                    style={{ color: 'var(--text-3)' }}
                  >
                    <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{formatActivityRelativeTime(item.searchedAtMs)}</span>
                  </span>

                  <button
                    type="button"
                    onClick={() => onExecuteRecentSearch(item)}
                    className="bx-btn bx-btn-primary bx-btn-sm whitespace-nowrap shrink-0"
                  >
                    <span>Search Again</span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
