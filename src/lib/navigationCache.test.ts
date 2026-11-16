import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRouteScrollKey,
  doesRouteRequireImmediateSecondarySubs,
  NavigationDataCache,
  RouteScrollMemory,
} from './navigationCache';

test('buildRouteScrollKey generates distinct stable keys per route and detail target', () => {
  assert.equal(buildRouteScrollKey({ page: 'home' }), 'home');
  assert.equal(buildRouteScrollKey({ page: 'market', platformFilter: 'youtube' }), 'market:youtube');
  assert.equal(buildRouteScrollKey({ page: 'listing', listingId: 'abc123' }), 'listing:abc123');
  assert.equal(buildRouteScrollKey({ page: 'deals', dealId: 'd9' }), 'deals:d9');
});

test('RouteScrollMemory stores clamped positions and evicts oldest beyond capacity', () => {
  const mem = new RouteScrollMemory(2);
  mem.save('home', -50);
  assert.equal(mem.get('home'), 0);

  mem.save('market:all', 420.6);
  assert.equal(mem.get('market:all'), 421);

  mem.save('listing:l1', 800);
  // 'home' should be evicted when maxEntries = 2
  assert.equal(mem.get('home'), 0);
  assert.equal(mem.get('market:all'), 421);
  assert.equal(mem.get('listing:l1'), 800);
});

test('NavigationDataCache honors TTL and prefix invalidation', () => {
  const cache = new NavigationDataCache<{ title: string }>(1000, 3);
  cache.set('listing:1', { title: 'YT Channel' }, 1000, 100);
  assert.deepEqual(cache.get('listing:1', 500), { title: 'YT Channel' });
  assert.equal(cache.get('listing:1', 1200), undefined);

  cache.set('profile:u1', { title: 'Alice' }, 5000, 100);
  cache.set('listing:2', { title: 'FB Page' }, 5000, 100);
  cache.invalidate('listing:');
  assert.equal(cache.get('listing:2', 200), undefined);
  assert.deepEqual(cache.get('profile:u1', 200), { title: 'Alice' });
});

test('doesRouteRequireImmediateSecondarySubs differentiates immediate vs deferred routes', () => {
  assert.equal(doesRouteRequireImmediateSecondarySubs('home'), false);
  assert.equal(doesRouteRequireImmediateSecondarySubs('market'), false);
  assert.equal(doesRouteRequireImmediateSecondarySubs('deals'), true);
  assert.equal(doesRouteRequireImmediateSecondarySubs('wallet'), true);
  assert.equal(doesRouteRequireImmediateSecondarySubs('chat'), true);
});
