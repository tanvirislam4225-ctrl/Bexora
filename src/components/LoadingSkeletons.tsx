import React from 'react';

export const MarketplaceGridSkeleton: React.FC<{ count?: number }> = ({ count = 8 }) => {
  return (
    <div
      role="status"
      aria-label="Loading marketplace listings"
      className="bx-listing-grid"
    >
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="bx-card overflow-hidden flex flex-col animate-pulse"
          aria-hidden="true"
        >
          <div className="w-full aspect-[16/9] bg-[var(--surface-2)] border-b border-[var(--border-soft)]" />
          <div className="p-4 space-y-3 flex-1">
            <div className="flex items-center justify-between gap-2">
              <div className="h-3 w-20 rounded bg-[var(--surface-2)]" />
              <div className="h-3 w-16 rounded bg-[var(--surface-2)]" />
            </div>
            <div className="h-3 w-28 rounded bg-[var(--surface-2)]" />
            <div className="space-y-1.5">
              <div className="h-4 w-full rounded bg-[var(--surface-2)]" />
              <div className="h-4 w-3/4 rounded bg-[var(--surface-2)]" />
            </div>
            <div className="h-6 w-24 rounded bg-[var(--surface-2)] pt-1" />
            <div className="pt-2 border-t border-[var(--border-soft)] flex items-center gap-2">
              <div className="w-7 h-7 rounded-full bg-[var(--surface-2)]" />
              <div className="h-3 w-24 rounded bg-[var(--surface-2)]" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

export const DetailPageSkeleton: React.FC<{ title?: string }> = ({
  title = 'Loading details…',
}) => {
  return (
    <div className="bx-wrap py-8" role="status" aria-label={title}>
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 animate-pulse">
        <div className="lg:col-span-7 space-y-4">
          <div className="bx-card aspect-[16/9] bg-[var(--surface-2)]" />
          <div className="bx-card p-6 space-y-3">
            <div className="h-5 w-1/2 rounded bg-[var(--surface-2)]" />
            <div className="h-4 w-full rounded bg-[var(--surface-2)]" />
            <div className="h-4 w-5/6 rounded bg-[var(--surface-2)]" />
            <div className="h-4 w-2/3 rounded bg-[var(--surface-2)]" />
          </div>
        </div>
        <div className="lg:col-span-5 space-y-4">
          <div className="bx-card p-6 space-y-4">
            <div className="h-7 w-40 rounded bg-[var(--surface-2)]" />
            <div className="h-10 w-full rounded bg-[var(--surface-2)]" />
            <div className="h-11 w-full rounded bg-[var(--surface-2)]" />
            <div className="h-24 w-full rounded bg-[var(--surface-2)]" />
          </div>
        </div>
      </div>
    </div>
  );
};

export const PageShellSkeleton: React.FC<{ label?: string }> = ({ label = 'Loading view…' }) => {
  return (
    <div className="bx-wrap py-8 space-y-5" role="status" aria-label={label}>
      <div className="bx-card p-6 space-y-3 animate-pulse">
        <div className="h-6 w-52 rounded bg-[var(--surface-2)]" />
        <div className="h-4 w-80 max-w-full rounded bg-[var(--surface-2)]" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bx-card p-5 space-y-3">
            <div className="h-4 w-28 rounded bg-[var(--surface-2)]" />
            <div className="h-7 w-36 rounded bg-[var(--surface-2)]" />
            <div className="h-3 w-full rounded bg-[var(--surface-2)]" />
          </div>
        ))}
      </div>
    </div>
  );
};

export const DashboardStatsSkeleton: React.FC<{ cards?: number }> = ({ cards = 6 }) => {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 animate-pulse"
      role="status"
      aria-label="Loading dashboard metrics"
    >
      {Array.from({ length: cards }).map((_, i) => (
        <div key={i} className="bx-card p-4 space-y-2.5">
          <div className="h-3 w-28 rounded bg-[var(--surface-2)]" />
          <div className="h-7 w-32 rounded bg-[var(--surface-2)]" />
          <div className="h-3 w-3/4 rounded bg-[var(--surface-2)]" />
        </div>
      ))}
    </div>
  );
};

export const TableRowsSkeleton: React.FC<{ rows?: number }> = ({ rows = 5 }) => {
  return (
    <div className="space-y-2 animate-pulse" role="status" aria-label="Loading records">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="p-3.5 border border-[var(--border-soft)] rounded-xl bg-[var(--surface)] flex items-center justify-between gap-3"
        >
          <div className="space-y-1.5 flex-1">
            <div className="h-4 w-1/3 rounded bg-[var(--surface-2)]" />
            <div className="h-3 w-1/2 rounded bg-[var(--surface-2)]" />
          </div>
          <div className="h-8 w-20 rounded bg-[var(--surface-2)] shrink-0" />
        </div>
      ))}
    </div>
  );
};
