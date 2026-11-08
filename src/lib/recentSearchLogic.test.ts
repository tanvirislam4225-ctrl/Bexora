import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRecentSearchId,
  createRecentSearchRecord,
  isMeaningfulSearchInput,
  MAX_RECENT_SEARCHES,
  parseStoredRecentSearches,
  upsertRecentSearchList,
} from './recentSearchLogic';

test('Recent Searches: rejects empty or 1-char noise searches without filters', () => {
  assert.equal(isMeaningfulSearchInput({ query: '' }), false);
  assert.equal(isMeaningfulSearchInput({ query: '   ', monetization: 'all' }), false);
  assert.equal(isMeaningfulSearchInput({ query: 'a' }), false);
  assert.equal(createRecentSearchRecord({ query: '' }), null);

  // Category-only or verified-only filter searches ARE meaningful
  assert.equal(isMeaningfulSearchInput({ query: '', platform: 'youtube' }), true);
  assert.equal(isMeaningfulSearchInput({ query: '', verifiedOnly: true }), true);
});

test('Recent Searches: normalizes, deduplicates identical queries, updates timestamp, and enforces cap', () => {
  const first = createRecentSearchRecord(
    { query: '  Monetized   YouTube ', platform: 'youtube' },
    1000
  );
  const duplicateCaseVariant = createRecentSearchRecord(
    { query: 'monetized youtube', platform: 'youtube' },
    5000
  );
  assert.ok(first && duplicateCaseVariant);
  assert.equal(first.id, duplicateCaseVariant.id);
  assert.equal(computeRecentSearchId({ query: 'Monetized YouTube', platform: 'youtube' }), first.id);

  let list = upsertRecentSearchList([], first);
  list = upsertRecentSearchList(list, duplicateCaseVariant);
  assert.equal(list.length, 1);
  assert.equal(list[0].searchedAtMs, 5000);

  // Cap check
  for (let i = 0; i < 28; i++) {
    const rec = createRecentSearchRecord({ query: `gaming account ${i}` }, 6000 + i);
    assert.ok(rec);
    list = upsertRecentSearchList(list, rec);
  }
  assert.equal(list.length, MAX_RECENT_SEARCHES);
  assert.equal(list[0].query, 'gaming account 27');

  const roundTripped = parseStoredRecentSearches(JSON.stringify(list));
  assert.equal(roundTripped.length, MAX_RECENT_SEARCHES);
  assert.equal(roundTripped[0].id, list[0].id);
});
