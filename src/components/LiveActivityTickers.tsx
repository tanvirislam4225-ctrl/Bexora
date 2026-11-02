import React, { useEffect, useMemo, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { CheckCircle2, ShieldCheck, Wallet } from 'lucide-react';
import { db } from '../lib/firebase';
import { PublicActivityItem } from '../types';
import {
  formatActivityRelativeTime,
  formatRecordedTickerAmount,
  mergeAndSortTickerItems,
  parseRawPublicActivityItem,
} from '../lib/activityTickerLogic';

export interface LiveActivityTickersProps {
  /** Optional callback so parent components (e.g. Footer live stats) can reuse verified public activities without a duplicate listener */
  onActivitiesChange?: (activities: PublicActivityItem[]) => void;
}

export const LiveActivityTickers: React.FC<LiveActivityTickersProps> = ({
  onActivitiesChange,
}) => {
  const [activities, setActivities] = useState<PublicActivityItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Refresh relative timestamps ("Just now", "5m ago", etc.) every 30s without extra Firestore reads
  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  // Subscribe in real time to sanitized /publicActivity projection + fallback to cached server API
  useEffect(() => {
    let active = true;

    async function fetchServerFallback() {
      try {
        const res = await fetch('/api/public/activity-tickers');
        if (!res.ok || !active) return;
        const data = (await res.json()) as {
          sold?: Array<Record<string, unknown>>;
          payout?: Array<Record<string, unknown>>;
        };
        const mergedRaw = [...(data.sold || []), ...(data.payout || [])];
        const parsed: PublicActivityItem[] = [];
        for (const raw of mergedRaw) {
          const id = typeof raw?.id === 'string' ? raw.id : '';
          const item = parseRawPublicActivityItem(id, raw);
          if (item) parsed.push(item);
        }
        if (active && parsed.length > 0) {
          setActivities((prev) => mergeAndSortTickerItems([...prev, ...parsed], 35));
        }
      } catch {
        // Non-fatal fallback
      } finally {
        if (active) setLoaded(true);
      }
    }

    void fetchServerFallback();

    const q = query(
      collection(db, 'publicActivity'),
      orderBy('completedAtMs', 'desc'),
      limit(35)
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        if (!active) return;
        const next: PublicActivityItem[] = [];
        for (const docSnap of snap.docs) {
          const item = parseRawPublicActivityItem(docSnap.id, docSnap.data());
          if (item) next.push(item);
        }
        const clean = mergeAndSortTickerItems(next, 35);
        if (snap.metadata.fromCache && clean.length === 0) {
          return;
        }
        setActivities(clean);
        setLoaded(true);
      },
      () => {
        void fetchServerFallback();
      }
    );

    return () => {
      active = false;
      unsub();
    };
  }, []);

  useEffect(() => {
    if (onActivitiesChange) {
      onActivitiesChange(activities);
    }
  }, [activities, onActivitiesChange]);

  const soldItems = useMemo(
    () => mergeAndSortTickerItems(activities.filter((a) => a.kind === 'sold'), 18),
    [activities]
  );

  const payoutItems = useMemo(
    () => mergeAndSortTickerItems(activities.filter((a) => a.kind === 'payout'), 18),
    [activities]
  );

  // Build repeat passes for seamless marquee looping while keeping screen-reader / DOM snapshot clean:
  // passIndex === 0 is accessible; passIndex > 0 is strictly aria-hidden="true".
  const buildSeamlessLoopPasses = (items: PublicActivityItem[]): number => {
    if (items.length === 0) return 0;
    if (items.length === 1) return 12;
    if (items.length === 2) return 6;
    if (items.length <= 5) return 4;
    return 2;
  };

  const soldPassCount = buildSeamlessLoopPasses(soldItems);
  const payoutPassCount = buildSeamlessLoopPasses(payoutItems);

  const soldDurationSec = Math.max(28, soldItems.length * (soldPassCount / 2) * 7);
  const payoutDurationSec = Math.max(30, payoutItems.length * (payoutPassCount / 2) * 7);

  return (
    <section
      aria-label="Live Marketplace Activity"
      data-testid="live-activity-tickers"
      className="w-full overflow-x-hidden border-b"
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border-soft)',
      }}
    >
      {/* TICKER A: RECENT SOLD */}
      <div
        className="bx-ticker-row flex items-center min-h-[38px] border-b"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div
          className="shrink-0 self-stretch px-3 sm:px-4 flex items-center gap-1.5 border-r text-[11px] font-extrabold tracking-wider uppercase whitespace-nowrap"
          style={{
            background: 'var(--green-soft)',
            color: 'var(--green)',
            borderColor: 'var(--border-soft)',
          }}
        >
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>RECENT SOLD</span>
        </div>

        <div className="bx-ticker-viewport py-1.5">
          {!loaded ? (
            <div className="px-4 text-xs font-semibold truncate" style={{ color: 'var(--text-3)' }}>
              Syncing verified escrow settlements…
            </div>
          ) : soldItems.length === 0 ? (
            <div
              data-testid="ticker-sold-empty"
              className="px-4 text-xs font-semibold truncate"
              style={{ color: 'var(--text-2)' }}
            >
              Verified completed sales appear here automatically upon escrow settlement.
            </div>
          ) : (
            <div
              className="bx-ticker-track"
              style={
                {
                  '--bx-ticker-duration': `${soldDurationSec}s`,
                } as React.CSSProperties
              }
            >
              {Array.from({ length: soldPassCount }).map((_, passIdx) => (
                <div
                  key={`sold-pass-${passIdx}`}
                  aria-hidden={passIdx > 0 ? 'true' : undefined}
                  className="flex items-center shrink-0"
                >
                  {soldItems.map((item) => (
                    <div
                      key={`${passIdx}-${item.id}`}
                      className="inline-flex items-center gap-2 px-4 text-xs whitespace-nowrap shrink-0 border-r"
                      style={{ borderColor: 'var(--border-soft)' }}
                    >
                      <span className="font-extrabold inline-flex items-center gap-1" style={{ color: 'var(--text)' }}>
                        <span>{item.actorDisplayName}</span>
                        {item.actorVerified && (
                          <ShieldCheck
                            className="w-3.5 h-3.5 shrink-0"
                            style={{ color: 'var(--green)' }}
                            aria-label={passIdx === 0 ? 'Verified Seller' : undefined}
                          />
                        )}
                      </span>
                      <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>
                        sold
                      </span>
                      <span
                        className="font-semibold max-w-[220px] sm:max-w-[280px] truncate"
                        style={{ color: 'var(--text-2)' }}
                      >
                        {item.assetTitle || 'Digital Asset'}
                      </span>
                      <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>
                        ·
                      </span>
                      <strong
                        className="font-extrabold tabular-nums"
                        style={{ color: 'var(--green)' }}
                      >
                        {formatRecordedTickerAmount(item.amountMinor, item.currency)}
                      </strong>
                      <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>
                        ·
                      </span>
                      <span className="tabular-nums font-medium" style={{ color: 'var(--text-3)' }}>
                        {formatActivityRelativeTime(item.completedAtMs, nowMs)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* TICKER B: RECENT PAYOUT */}
      <div className="bx-ticker-row flex items-center min-h-[38px]">
        <div
          className="shrink-0 self-stretch px-3 sm:px-4 flex items-center gap-1.5 border-r text-[11px] font-extrabold tracking-wider uppercase whitespace-nowrap"
          style={{
            background: 'var(--purple-soft)',
            color: 'var(--purple)',
            borderColor: 'var(--border-soft)',
          }}
        >
          <Wallet className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          <span>RECENT PAYOUT</span>
        </div>

        <div className="bx-ticker-viewport py-1.5">
          {!loaded ? (
            <div className="px-4 text-xs font-semibold truncate" style={{ color: 'var(--text-3)' }}>
              Syncing confirmed seller payouts…
            </div>
          ) : payoutItems.length === 0 ? (
            <div
              data-testid="ticker-payout-empty"
              className="px-4 text-xs font-semibold truncate"
              style={{ color: 'var(--text-2)' }}
            >
              Confirmed seller payouts appear here automatically once processed.
            </div>
          ) : (
            <div
              className="bx-ticker-track"
              style={
                {
                  '--bx-ticker-duration': `${payoutDurationSec}s`,
                } as React.CSSProperties
              }
            >
              {Array.from({ length: payoutPassCount }).map((_, passIdx) => (
                <div
                  key={`payout-pass-${passIdx}`}
                  aria-hidden={passIdx > 0 ? 'true' : undefined}
                  className="flex items-center shrink-0"
                >
                  {payoutItems.map((item) => (
                    <div
                      key={`${passIdx}-${item.id}`}
                      className="inline-flex items-center gap-2 px-4 text-xs whitespace-nowrap shrink-0 border-r"
                      style={{ borderColor: 'var(--border-soft)' }}
                    >
                      <span className="font-extrabold inline-flex items-center gap-1" style={{ color: 'var(--text)' }}>
                        <span>{item.actorDisplayName}</span>
                        {item.actorVerified && (
                          <ShieldCheck
                            className="w-3.5 h-3.5 shrink-0"
                            style={{ color: 'var(--green)' }}
                            aria-label={passIdx === 0 ? 'Verified Seller' : undefined}
                          />
                        )}
                      </span>
                      <span className="font-medium" style={{ color: 'var(--text-2)' }}>
                        received payout
                      </span>
                      <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>
                        ·
                      </span>
                      <strong
                        className="font-extrabold tabular-nums"
                        style={{ color: 'var(--purple)' }}
                      >
                        {formatRecordedTickerAmount(item.amountMinor, item.currency)}
                      </strong>
                      <span aria-hidden="true" style={{ color: 'var(--text-3)' }}>
                        ·
                      </span>
                      <span className="tabular-nums font-medium" style={{ color: 'var(--text-3)' }}>
                        {formatActivityRelativeTime(item.completedAtMs, nowMs)}
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
