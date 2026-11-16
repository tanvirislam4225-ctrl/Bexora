import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canAttemptChunkAutoReload,
  isChunkLoadError,
  tryClaimChunkReloadWindow,
  type StorageLike,
} from './chunkRetry';

test('chunkRetry: detects browser dynamic module and chunk load errors accurately', () => {
  assert.equal(
    isChunkLoadError(
      new TypeError(
        'Failed to fetch dynamically imported module: https://example.com/assets/AdminDashboard-BYqlQMkY.js'
      )
    ),
    true
  );
  assert.equal(
    isChunkLoadError(new Error('Importing a module script failed.')),
    true
  );
  assert.equal(
    isChunkLoadError(new Error('Loading chunk 42 failed.')),
    true
  );
  assert.equal(
    isChunkLoadError(new Error('Permission denied on Firestore collection')),
    false
  );
});

test('chunkRetry: enforces cooldown window to prevent infinite reload loops', () => {
  const now = 1_700_000_000_000;
  assert.equal(canAttemptChunkAutoReload(null, now), true);
  assert.equal(canAttemptChunkAutoReload(String(now - 5_000), now), false);
  assert.equal(canAttemptChunkAutoReload(String(now - 20_000), now), true);
  assert.equal(canAttemptChunkAutoReload('invalid', now), true);
});

test('chunkRetry: tryClaimChunkReloadWindow claims once per cooldown window and handles throwing storage', () => {
  const store = new Map<string, string>();
  const mockStorage: StorageLike = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
  };
  const t0 = 1_700_000_000_000;
  assert.equal(tryClaimChunkReloadWindow(mockStorage, t0), true);
  assert.equal(tryClaimChunkReloadWindow(mockStorage, t0 + 3_000), false);
  assert.equal(tryClaimChunkReloadWindow(mockStorage, t0 + 20_000), true);

  const throwingStorage: StorageLike = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('SecurityError');
    },
  };
  assert.equal(tryClaimChunkReloadWindow(throwingStorage, t0), false);
  assert.equal(tryClaimChunkReloadWindow(null, t0), false);
});
