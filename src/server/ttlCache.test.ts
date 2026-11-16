import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache } from './ttlCache';

test('TtlCache caches values within TTL and expires after TTL', async () => {
  let calls = 0;
  const cache = new TtlCache<number>(1000, 10);

  const first = await cache.getOrCompute('k1', async () => ++calls, { nowMs: 1000 });
  assert.equal(first, 1);

  const cached = cache.get('k1', 1500);
  assert.equal(cached, 1);

  const expired = cache.get('k1', 2100);
  assert.equal(expired, undefined);
});

test('TtlCache coalesces concurrent identical in-flight computations', async () => {
  let calls = 0;
  const cache = new TtlCache<string>(5000, 10);

  const compute = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 15));
    return `val-${calls}`;
  };

  const [a, b, c] = await Promise.all([
    cache.getOrCompute('heavy', compute),
    cache.getOrCompute('heavy', compute),
    cache.getOrCompute('heavy', compute),
  ]);

  assert.equal(calls, 1);
  assert.equal(a, 'val-1');
  assert.equal(b, 'val-1');
  assert.equal(c, 'val-1');
  assert.equal(cache.getStats().coalesced, 2);
});

test('TtlCache respects shouldCache predicate and prefix invalidation', async () => {
  let calls = 0;
  const cache = new TtlCache<{ ok: boolean }>(5000, 10);

  await cache.getOrCompute(
    'finance:120',
    async () => {
      calls += 1;
      return { ok: false };
    },
    { shouldCache: (v) => v.ok }
  );
  assert.equal(cache.get('finance:120'), undefined);

  await cache.getOrCompute(
    'finance:120',
    async () => {
      calls += 1;
      return { ok: true };
    },
    { shouldCache: (v) => v.ok }
  );
  assert.equal(calls, 2);
  assert.deepEqual(cache.get('finance:120'), { ok: true });

  cache.invalidate('finance:');
  assert.equal(cache.get('finance:120'), undefined);
});
