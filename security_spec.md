# BEXORA Security Specification — Phase 0 Payload-First TDD

## 1. Data Invariants

1. **PII Split Isolation**: `publicProfiles/{userId}` never stores email, phone, wallet balance, or NID images. `privateUsers/{userId}` and `identityVerifications/{userId}` are readable strictly by `request.auth.uid == userId || isAdmin()`.
2. **Privilege Escalation Prevention**: Ordinary users can never write to `/admins/{userId}`, grant themselves `nidVerified: true`, `completedTrader: true`, or modify `walletBalanceMinor` arbitrarily on creation (`walletBalanceMinor == 0` required on self-registration).
3. **Admin Email Spoofing Guard**: Bootstrapped superadmin email check (`tanvirislam7574@gmail.com`) strictly requires `request.auth.token.email_verified == true`.
4. **Global Username Uniqueness**: `/usernames/{username}` requires document ID `username` to match `^[a-z0-9_]{3,24}$` and can only be claimed if unassigned or already owned by `request.auth.uid`.
5. **Listing Moderation Gate**: Sellers creating a listing in `/listings/{listingId}` must set `sellerId == request.auth.uid`, `status` in `['draft', 'pending']`, and `verifiedOptions.size() == 0`. Only `isAdmin()` can transition `status` to `'active'` or populate `verifiedOptions`.
6. **Role-Governed Bidding**: Only `buyerId == request.auth.uid` can create a bid (`status == 'pending'`) or withdraw their own pending bid (`status == 'withdrawn'`). Only `sellerId == request.auth.uid` can transition a pending bid to `'accepted'` or `'rejected'`.
7. **Immutable Deal Deadline**: Once `originalDeadlineMs > 0` is set on `/deals/{dealId}`, no non-admin update (including filing reports or buyer actions) can ever alter `originalDeadlineMs`, `baseAmountMinor`, or fee snapshot fields.
8. **Append-Only Ledger & Audit Logs**: `/walletLedger/{entryId}` and `/auditLogs/{logId}` forbid `update` and `delete` for all actors.
9. **Strictly Owner-Private Favorites**: `/favorites/{favoriteId}` enforces deterministic ID `fav_${request.auth.uid}_${listingId}` and restricts `get`, `list`, `create`, and `delete` strictly to `userId == request.auth.uid` (no seller or public snooping).
10. **Non-Self Atomic Seller Following**: `/sellerFollows/{followId}` enforces `followerId == request.auth.uid`, `followerId != sellerId`, deterministic ID `fol_${followerId}_${sellerId}`, and Pillar-7 `exists`/`existsAfter`/`getAfter` atomicity with `publicProfiles/{sellerId}.followerCount` (+1 on create, -1 on delete).
11. **Single-Shot Follower Publication Gate**: Sellers cannot set or mutate `firstPublishedAtMs` on `/listings/{listingId}`; only `isAdmin()` sets `firstPublishedAtMs` upon first publication to `active`, preventing duplicate follower alerts on drafts, edits, rejections, or restorations.

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Shadow Admin Grant on Profile**: `POST /publicProfiles/attacker` with `{ ..., nidVerified: true, isAdmin: true }` -> `PERMISSION_DENIED` (blocked by `hasOnly` + `nidVerified == false`).
2. **Wallet Self-Credit**: `POST /privateUsers/attacker` with `{ ..., walletBalanceMinor: 99999900 }` -> `PERMISSION_DENIED` (blocked by `walletBalanceMinor == 0`).
3. **Unverified Admin Email Spoof**: Request from `email: "tanvirislam7574@gmail.com"` with `email_verified: false` attempting `PUT /publicConfig/settings` -> `PERMISSION_DENIED`.
4. **PII Harvest (`get` another user)**: Authenticated `attacker` reads `GET /privateUsers/victim` or `GET /identityVerifications/victim` -> `PERMISSION_DENIED`.
5. **Blanket List Query Scraping**: Authenticated `attacker` runs `LIST /deposits` without `where('userId', '==', 'attacker')` -> `PERMISSION_DENIED` (`resource.data.userId == request.auth.uid` enforced).
6. **ID Poisoning (2KB junk ID)**: `PUT /listings/<2000-char-junk>` -> `PERMISSION_DENIED` (`isValidId` regex & 128-char cap).
7. **Self-Verified Listing Bypass**: Seller creates `/listings/L1` with `{ status: "active", verifiedOptions: ["yt-ads"] }` -> `PERMISSION_DENIED`.
8. **Buyer Accepting Own Bid**: Buyer updates `/bids/B1` from `pending` to `accepted` -> `PERMISSION_DENIED` (only `existing().sellerId == request.auth.uid` allowed).
9. **Seller Withdrawing Buyer's Bid**: Seller updates `/bids/B1` to `withdrawn` -> `PERMISSION_DENIED` (only `existing().buyerId == request.auth.uid` allowed).
10. **Deal Deadline Extension Attack**: Participant updates `/deals/D1` on report with `originalDeadlineMs: existing.originalDeadlineMs + 86400000` -> `PERMISSION_DENIED`.
11. **Unauthorized Deal Chat Snooping**: Non-participant reads `/deals/D1/messages/M1` -> `PERMISSION_DENIED` (Master Gate `get()` on parent `/deals/D1` rejects non-participants).
12. **Audit Log Tampering**: Any user or admin calls `DELETE /auditLogs/log1` or `PATCH /auditLogs/log1` -> `PERMISSION_DENIED`.
13. **Cross-User Notification Snooping**: Authenticated `attacker` queries `LIST /notifications` without `where('recipientId', '==', 'attacker')` or reads `GET /notifications/victim_notif` -> `PERMISSION_DENIED` (`recipientId == request.auth.uid || isAdmin()` strictly enforced).
14. **Spoofed Admin / Wallet Notification Injection**: Ordinary user creates `/notifications/fake_credit` for `victim` with `actorRole: 'admin'` or `category: 'wallet'` -> `PERMISSION_DENIED` (non-admin cross-user creation is strictly restricted to `actorRole == 'user'` on verified `listings/{refId}` or `deals/{refId}` counterparties, never `'wallet'`, `'security'`, `'verification'`, or `'announcement'`).
15. **Notification Content Tampering or Deletion**: Recipient attempts `PATCH /notifications/n1` mutating `title`, `body`, `recipientId`, or reverting `read: false`, or calls `DELETE /notifications/n1` -> `PERMISSION_DENIED` (`affectedKeys().hasOnly(['read', 'readAt', 'updatedAt'])` and `read: false -> true`, `allow delete: if false`).
16. **Cross-User FCM PushToken Theft**: Any user or admin other than `request.auth.uid == userId` attempts to read or write `/privateUsers/{userId}/pushTokens/{tokenId}` -> `PERMISSION_DENIED` (strict owner-only access with parent `exists()` Master Gate).
17. **Unauthorized Platform Announcement Broadcast**: Non-admin user attempts `POST /announcements/a1` -> `PERMISSION_DENIED` (`isAdmin()` strictly required for create, update, and delete).
18. **Seller Self-Unsuspending Admin-Suspended Listing**: Seller attempts `PATCH /listings/L_susp` from `status: 'suspended'` to `'active'` or `'pending'` -> `PERMISSION_DENIED` (`existing().status != 'suspended'` enforced on seller update branch; only `isAdmin()` can restore a suspended listing).
19. **Seller Preserving Verified Monetization Badges After Editing Claims**: Seller edits `/listings/L1` while keeping `verifiedOptions: ['yt-ypp']` -> `PERMISSION_DENIED` (`incoming().verifiedOptions.size() == 0` strictly required on seller updates so edited claims undergo fresh admin moderation).
20. **Insecure Custom Brand Logo Injection (`javascript:` or `http://`)**: Admin or attacker submits `logoUrl: "javascript:alert(1)"` to `/publicConfig/settings` -> `PERMISSION_DENIED` (`^$|^\./icon\.svg$|^https://[A-Za-z0-9.\-/:_?=&%]+$` regex enforced).
21. **Cross-User Favorites Snooping / Tampering**: Authenticated user or seller attempts `LIST /favorites` without `where('userId', '==', request.auth.uid)` or `DELETE /favorites/fav_victim_L1` -> `PERMISSION_DENIED` (`userId == request.auth.uid` strictly enforced on `get`, `list`, `create`, and `delete`).
22. **Self-Follow & Duplicate Follow ID Attack**: Seller attempts `POST /sellerFollows/fol_seller1_seller1` or `POST /sellerFollows/random_id` -> `PERMISSION_DENIED` (`data.followerId != data.sellerId` and deterministic `followId == 'fol_' + request.auth.uid + '_' + incoming().sellerId` enforced).
23. **Out-of-Band `followerCount` Inflation**: Attacker attempts `PATCH /publicProfiles/seller1` with `{ followerCount: 50000 }` without creating `sellerFollows/fol_attacker_seller1` -> `PERMISSION_DENIED` (`!exists` + `existsAfter` + exact `+1` delta enforced).
24. **Blanket Follower Roster Scraping**: Non-admin user runs `LIST /sellerFollows` where `sellerId == 'competitor'` -> `PERMISSION_DENIED` (`resource.data.followerId == request.auth.uid || isAdmin()` enforced).
25. **Seller Spoofing `firstPublishedAtMs` on Listing Creation/Edit**: Seller creates `/listings/L2` with `firstPublishedAtMs: 1` or mutates `firstPublishedAtMs` on update -> `PERMISSION_DENIED` (`!('firstPublishedAtMs' in incoming())` on create and omitted from seller `affectedKeys().hasOnly(...)` on update).
