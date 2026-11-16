import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildApiUrl,
  cachedApiGetJson,
  createIdempotencyKey,
  dedupedRequest,
  invalidateClientApiCache,
  isCrossOriginApiConfigured,
  normalizeApiBaseUrl,
  resetClientApiCachesForTests,
} from './apiClient';

test('normalizeApiBaseUrl handles empty, trailing slashes, and invalid protocols safely', () => {
  assert.equal(normalizeApiBaseUrl(''), '');
  assert.equal(normalizeApiBaseUrl(undefined), '');
  assert.equal(normalizeApiBaseUrl('  https://api.bexora.app/  '), 'https://api.bexora.app');
  assert.equal(normalizeApiBaseUrl('https://host.example.com/backend///'), 'https://host.example.com/backend');
  assert.equal(normalizeApiBaseUrl('javascript:alert(1)'), '');
  assert.equal(normalizeApiBaseUrl('not-a-url'), '');
});

test('buildApiUrl builds same-origin and cross-origin API URLs cleanly', () => {
  assert.equal(buildApiUrl('/api/health', ''), '/api/health');
  assert.equal(buildApiUrl('api/admin/access', ''), '/api/admin/access');
  assert.equal(
    buildApiUrl('/api/admin/finance-overview?refresh=1', 'https://api.bexora.app/'),
    'https://api.bexora.app/api/admin/finance-overview?refresh=1'
  );
  assert.equal(
    buildApiUrl('api/deals/d1/release-if-ready', 'https://api.bexora.app/v2/'),
    'https://api.bexora.app/v2/api/deals/d1/release-if-ready'
  );
  assert.equal(
    buildApiUrl('https://already-full.example.com/api/test', 'https://api.bexora.app'),
    'https://already-full.example.com/api/test'
  );
});

test('isCrossOriginApiConfigured detects configured external API base URL', () => {
  assert.equal(isCrossOriginApiConfigured(''), false);
  assert.equal(isCrossOriginApiConfigured('https://api.bexora.app'), true);
});

test('dedupedRequest shares identical concurrent in-flight promises', async () => {
  resetClientApiCachesForTests();
  let executions = 0;
  const run = () =>
    dedupedRequest('GET:/api/admin/access', async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 15));
      return { ok: true, count: executions };
    });

  const [r1, r2, r3] = await Promise.all([run(), run(), run()]);
  assert.equal(executions, 1);
  assert.deepEqual(r1, { ok: true, count: 1 });
  assert.deepEqual(r2, { ok: true, count: 1 });
  assert.deepEqual(r3, { ok: true, count: 1 });
});

test('cachedApiGetJson serves cached TTL payload and supports prefix invalidation', async () => {
  resetClientApiCachesForTests();
  let calls = 0;
  const fetchOnce = () =>
    cachedApiGetJson(
      'GET:/api/finance:120',
      async () => {
        calls += 1;
        return { calls };
      },
      { ttlMs: 5000 }
    );

  const first = await fetchOnce();
  const second = await fetchOnce();
  assert.equal(calls, 1);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);

  invalidateClientApiCache('GET:/api/finance');
  const third = await fetchOnce();
  assert.equal(calls, 2);
  assert.equal(third.calls, 2);
});

test('createIdempotencyKey returns unique scoped keys', () => {
  const k1 = createIdempotencyKey('checkout');
  const k2 = createIdempotencyKey('checkout');
  assert.ok(k1.startsWith('checkout_'));
  assert.ok(k2.startsWith('checkout_'));
  assert.notEqual(k1, k2);
});
