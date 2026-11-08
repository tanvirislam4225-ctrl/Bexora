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
12. **Atomic Escrow Wallet Debit & Fee Integrity**: Non-admin Buy Now (`create /deals/{dealId}`) and Accepted-Bid payment (`update /deals/{dealId}`) enforce configured platform fee percentages, exact `buyerFeeMinor`/`sellerFeeMinor` rounding, listing transition to `sold`, deterministic ledger creation `led_pay_{dealId}`, and verified deduction of `buyerTotalMinor` (converted to BDT minor units for USD deals) from `privateUsers/{buyerId}.walletBalanceMinor`.
13. **Atomic Withdrawal Balance Reservation**: Creating `/withdrawals/{withdrawalId}` enforces `currency == 'BDT'`, deterministic ledger creation `led_wd_{withdrawalId}`, exact deduction from `privateUsers/{userId}.walletBalanceMinor`, and equal increment of `reservedBalanceMinor`.
14. **Single-Review Atomic Rating Synchronization**: `/reviews/{reviewId}` enforces deterministic ID `rev_{dealId}` on a `settled` deal, and `/publicProfiles/{sellerId}` rating updates require non-self caller + atomic creation of `reviews/rev_{lastReviewDealId}` with exact score delta.
15. **Sanitized Admin-Only Public Activity Projection**: `/publicActivity/{activityId}` uses opaque IDs (`act_<ts>_<rand>`), rejects all PII or internal transaction IDs (`uid`, `email`, `phone`, `payoutAccount`, `dealId`, `withdrawalId`), and restricts `create`, `update`, and `delete` strictly to `isAdmin()`.
16. **Strictly Owner-Private Recent Searches**: `/privateUsers/{userId}/recentSearches/{searchId}` enforces `request.auth.uid == userId` + parent `exists(/databases/$(database)/documents/privateUsers/$(userId))` Master Gate on `get`, `list`, `create`, `update`, and `delete` (even admins cannot snoop user search history).
17. **Verified Single-Report Review Abuse Governance**: `/reviewReports/{reportId}` requires `email_verified == true`, deterministic ID `rrep_${reviewId}_${request.auth.uid}`, verified existence of `/reviews/{reviewId}`, and restricts listing/moderation strictly to `isAdmin()`.
18. **Server/Admin-Only Strike & Restriction Integrity**: `/userRestrictions/{userId}` is readable only by `request.auth.uid == userId || isAdmin()` and writable strictly by `isAdmin()`. Suspended or restricted users (`isUserModerationSuspended` / `hasActiveRestrictionFlag`) are blocked at the Firestore rules layer from creating/editing listings, placing bids, initiating Buy-Now deals, sending messages, posting reviews, or creating new withdrawal requests while their `walletBalanceMinor` and `walletLedger` remain intact.
19. **One-Way Protective Conversation Pause Lock**: Participants or `isAdmin()` can set `moderationPaused: true` on `/conversations/{convId}` or `/deals/{dealId}`, immediately blocking non-admin `/messages` creation, while ONLY `isAdmin()` can resume (`moderationPaused: false`).
20. **Reporter Identity Confidentiality**: `/userReports/{reportId}` restricts `get` and `list` strictly to `reporterId == request.auth.uid || isAdmin()`, preventing reported users from discovering who reported them.
21. **Immutable Moderation Audit Trail**: `/moderationAuditLogs/{logId}` is Admin-only and strictly forbids `update` and `delete`.

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
38. **Self-Unban / Strike Reset Tampering**: Suspended user attempts `PATCH /userRestrictions/attacker` setting `accountStatus: 'active'` or `activeStrikes: 0` -> `PERMISSION_DENIED` (`isAdmin()` strictly required on all writes).
39. **Suspended User Bypassing Client UI to Create Listing or Withdrawal**: User with `accountStatus: 'protective_suspension'` or `restrictWithdrawals: true` calls `POST /listings/L_bad` or `POST /withdrawals/W_bad` directly via Firestore SDK -> `PERMISSION_DENIED` (`!isUserModerationSuspended` & `!hasActiveRestrictionFlag` enforced).
40. **Sending Messages or Self-Resuming a Paused Conversation**: Participant attempts `POST /conversations/C1/messages/M_bypass` while `C1.moderationPaused == true`, or attempts `PATCH /conversations/C1` with `{ moderationPaused: false }` -> `PERMISSION_DENIED` (only `isAdmin()` can resume a paused conversation).
41. **Reported User Snooping Reporter Identity**: Reported user attempts `LIST /userReports` where `reportedUserId == request.auth.uid` -> `PERMISSION_DENIED` (`resource.data.reporterId == request.auth.uid || isAdmin()` enforced).

