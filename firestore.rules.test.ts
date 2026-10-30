import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const rules = fs.readFileSync('firestore.rules', 'utf8');

test('Firestore Rules: enforces default-deny catch-all at root and zero blanket allow true', () => {
  assert.match(rules, /match\s+\/\{document=\*\*\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/);
  assert.doesNotMatch(rules, /allow\s+read,\s*write:\s*if\s+true/);
});

test('Firestore Rules: bootstrapped superadmin checks email_verified == true to block email spoofing', () => {
  assert.match(rules, /request\.auth\.token\.email_verified\s*==\s*true/);
  assert.match(rules, /request\.auth\.token\.email\s*==\s*'tanvirislam7574@gmail\.com'/);
});

test('Firestore Rules: isolates PII in privateUsers and identityVerifications to owner or admin, and enforces token verification on emailVerified', () => {
  assert.match(rules, /match\s+\/privateUsers\/\{userId\}[\s\S]*?request\.auth\.uid\s*==\s*userId\s*\|\|\s*isAdmin\(\)/);
  assert.match(rules, /match\s+\/identityVerifications\/\{userId\}[\s\S]*?request\.auth\.uid\s*==\s*userId\s*\|\|\s*isAdmin\(\)/);
  assert.match(rules, /incoming\(\)\.emailVerified\s*==\s*true\s*&&\s*request\.auth\.token\.email_verified\s*==\s*true/);
});

test('Firestore Rules: bids require active listing, non-self buyer, and buyer-only pending withdrawal preserving history', () => {
  assert.match(rules, /get\(\/databases\/\$\(database\)\/documents\/listings\/\$\(incoming\(\)\.listingId\)\)\.data\.status\s*==\s*'active'/);
  assert.match(rules, /existing\(\)\.buyerId\s*==\s*request\.auth\.uid[\s\S]*?incoming\(\)\.status\s*==\s*'withdrawn'/);
  assert.match(rules, /match\s+\/bids\/\{bidId\}[\s\S]*?allow\s+delete:\s*if\s+false;/);
});

test('Firestore Rules: locks originalDeadlineMs immutably once set on deals', () => {
  assert.match(
    rules,
    /existing\(\)\.originalDeadlineMs\s*==\s*0\s*\|\|\s*incoming\(\)\.originalDeadlineMs\s*==\s*existing\(\)\.originalDeadlineMs/
  );
});

test('Firestore Rules: auditLogs and walletLedger are strictly append-only (no update or delete)', () => {
  assert.match(rules, /match\s+\/walletLedger\/\{entryId\}[\s\S]*?allow\s+update,\s*delete:\s*if\s+false;/);
  assert.match(rules, /match\s+\/auditLogs\/\{logId\}[\s\S]*?allow\s+update,\s*delete:\s*if\s+false;/);
});

test('Firestore Rules: notifications enforce recipient-scoped reads, verified counterparty writes, mark-read-only updates, and forbid delete', () => {
  assert.match(rules, /match\s+\/notifications\/\{notificationId\}/);
  assert.match(rules, /resource\.data\.recipientId\s*==\s*request\.auth\.uid/);
  assert.match(rules, /incoming\(\)\.diff\(existing\(\)\)\.affectedKeys\(\)\.hasOnly\(\['read',\s*'readAt',\s*'updatedAt'\]\)/);
  assert.match(rules, /existing\(\)\.read\s*==\s*false\s*&&\s*incoming\(\)\.read\s*==\s*true/);
  assert.match(rules, /match\s+\/notifications\/\{notificationId\}[\s\S]*?allow\s+delete:\s*if\s+false;/);
});

test('Firestore Rules: pushTokens are strictly owner-only with parent Master Gate and announcements require isAdmin() to write', () => {
  assert.match(rules, /match\s+\/pushTokens\/\{tokenId\}[\s\S]*?request\.auth\.uid\s*==\s*userId/);
  assert.match(rules, /exists\(\/databases\/\$\(database\)\/documents\/privateUsers\/\$\(userId\)\)/);
  assert.match(rules, /match\s+\/announcements\/\{announcementId\}[\s\S]*?allow\s+create:\s*if\s+isAdmin\(\)/);
});

test('Storage Rules: enforces default-deny catch-all and scopes nid_documents, listing_evidence, and deal_media to owner or superadmin only', () => {
  const storageRules = fs.readFileSync('storage.rules', 'utf8');
  assert.match(storageRules, /match\s+\/\{allPaths=\*\*\}\s*\{\s*allow\s+read,\s*write:\s*if\s+false;\s*\}/);
  assert.doesNotMatch(storageRules, /allow\s+read:\s*if\s+isSignedIn\(\)\s*;/);
  assert.match(
    storageRules,
    /match\s+\/deal_media\/\{dealId\}\/\{userId\}\/\{fileName\}[\s\S]*?allow\s+read:\s*if\s+isSignedIn\(\)\s*&&\s*\(request\.auth\.uid\s*==\s*userId\s*\|\|\s*isBootstrappedSuperAdmin\(\)\)/
  );
});

test('Firestore Rules: reserved listings remain visible and accepted_pending_payment bids enforce exact deal baseAmountMinor', () => {
  assert.match(rules, /resource\.data\.status\s+in\s+\['active',\s*'reserved'\]/);
  assert.match(rules, /accepted_pending_payment/);
  assert.match(
    rules,
    /getAfter\(\/databases\/\$\(database\)\/documents\/deals\/\$\(incoming\(\)\.dealId\)\)\.data\.baseAmountMinor\s*==\s*existing\(\)\.amountMinor/
  );
});

test('Firestore Rules: 3-party deal room transfers enforce 2-3 screenshots, server-clock-bounded timer start, and ledger idempotency for pay/refund/release', () => {
  assert.match(rules, /data\.screenshots\.size\(\)\s*>=\s*2\s*&&\s*data\.screenshots\.size\(\)\s*<=\s*3/);
  assert.match(rules, /incoming\(\)\.confirmedAtMs\s*>=\s*request\.time\.toMillis\(\)\s*-\s*300000/);
  assert.match(rules, /led_pay_/);
  assert.match(rules, /led_refund_/);
  assert.match(rules, /led_release_/);
});

test('Firestore Rules: validates notificationPrefs sound catalog & vibrationStrength enums, blocks private VAPID keys on publicConfig, and gates deal_room_created alertKind behind funded deals', () => {
  assert.match(rules, /function\s+isValidNotificationPrefs\(prefs\)/);
  assert.match(rules, /'01_soft_normal',\s*'02_crisp_normal',\s*'03_premium_deal',\s*'04_urgent_deal'/);
  assert.match(rules, /prefs\.vibrationStrength\s+in\s+\['standard',\s*'strong'\]/);
  assert.match(rules, /data\.fcmVapidPublicKey\.matches\('\^\$\|\^\[A-Za-z0-9_\\\\-\]\{84,92\}\$'\)/);
  assert.match(rules, /incoming\(\)\.alertKind\s*!=\s*'deal_room_created'/);
  assert.match(rules, /'paid_deal_room_active'/);
});
