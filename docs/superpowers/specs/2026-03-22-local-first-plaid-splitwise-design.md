# SplitEasy — Local-First Architecture Design Spec

**Date:** 2026-03-22
**Status:** Approved
**Supersedes:** `2026-03-20-spliteasy-design.md` (Supabase-backed architecture)

---

## Overview

This spec describes a redesign of SplitEasy's data and backend architecture to be **local-first** for compliance and trust reasons. No user transaction data is stored on any server. Plaid transactions are fetched on-demand and stored only on the user's device. Splitwise is the backend for group expense data. A stateless Cloudflare Worker acts as a thin proxy for Plaid API calls (required because Plaid's server secret must not be embedded in the iOS binary).

---

## Goals

- Store zero user financial data on any server
- Remove Supabase entirely (Postgres, Vault, Realtime, Auth, Edge Functions)
- Keep the History tab using local SQLite with a 6-month prune policy
- Maintain a smooth split flow: Plaid transactions → user selects → pushed to Splitwise
- Preserve compliance posture: GDPR/CCPA data minimisation, Plaid ToS alignment

---

## Non-Goals

- Multi-device sync (Splitwise is the source of truth for group data; local SQLite is per-device)
- Android / web app
- Plaid webhook support (replaced by on-demand cursor-based sync)
- Server-side transaction history or analytics

---

## Tech Stack

| Layer | Technology |
|---|---|
| iOS App | Swift / SwiftUI |
| Local storage | SQLite via `GRDB.swift` |
| Sensitive credentials | iOS Keychain |
| Non-sensitive metadata | UserDefaults |
| Plaid proxy | Cloudflare Workers (TypeScript, stateless) |
| Bank data | Plaid Link iOS SDK + Transactions Sync API |
| Group expenses | Splitwise OAuth + REST API v3 |

---

## Architecture

```
iOS App (SwiftUI)
  ├── iOS Keychain
  │     ├── plaid_access_token
  │     ├── splitwise_access_token
  │     └── worker_api_key
  ├── SQLite (on-device, GRDB)
  │     ├── transactions
  │     └── split_decisions
  ├── Cloudflare Worker (stateless — no storage, no logging of sensitive data)
  │     ├── POST /plaid/link-token       → creates Plaid link_token
  │     ├── POST /plaid/exchange         → exchanges public_token → returns access_token to iOS
  │     └── POST /plaid/transactions     → iOS sends access_token, Worker proxies to Plaid, returns data
  └── Splitwise API (called directly from iOS)
        ├── GET  /api/v3/get_current_user
        ├── GET  /api/v3/get_friends
        └── POST /api/v3/create_expense
```

### What Is Removed vs Previous Design

| Component | Previous | New |
|---|---|---|
| Supabase Postgres | Stored users, transactions, split_decisions, plaid_items | Removed entirely |
| Supabase Vault | Stored Plaid + Splitwise tokens server-side | Removed — tokens move to iOS Keychain |
| Supabase Realtime | Pushed transaction updates to iOS | Removed — replaced by on-demand fetch |
| Supabase Auth | JWT for all backend calls | Removed |
| Supabase Edge Functions (6) | plaid-webhook, plaid-link-exchange, plaid-create-link-token, splitwise-auth-callback, splitwise-get-friends, splitwise-create-expense | Removed — replaced by 3 stateless CF Worker routes |
| Plaid webhooks | Server-side transaction ingestion | Removed — cursor-based sync on demand |
| `transactions.status = 'removed'` | Soft-delete for Plaid-removed transactions | **Removed** — Plaid-removed transactions are hard-deleted from SQLite immediately. Previously removed-but-split rows remained visible in History; now they disappear entirely. The Splitwise expense is left intact. This is an intentional product simplification. |

---

## Local Data Model (SQLite)

Schema managed via `GRDB.swift`'s `DatabaseMigrator` with numbered migrations. Any future schema changes require a new migration function — never modify existing migrations.

### `transactions`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | Plaid transaction ID (`plaid_transaction_id`) |
| merchant_name | TEXT | Display name for the transaction |
| amount | REAL | Always positive — debits only (credits never written, see Data Flow §2) |
| currency | TEXT | Default `'USD'` |
| date | TEXT | ISO-8601 date from Plaid |
| status | TEXT | `'new'` \| `'split'` \| `'skipped'` |
| created_at | TEXT | ISO-8601 timestamp — used for 6-month prune |

### `split_decisions`

| Column | Type | Notes |
|---|---|---|
| id | TEXT PK | UUID generated locally |
| transaction_id | TEXT FK UNIQUE | → transactions(id), CASCADE DELETE. UNIQUE constraint enforced at DB level (GRDB migration: `CREATE UNIQUE INDEX`) to prevent duplicate split_decisions rows per transaction even under concurrent writes |
| splitwise_expense_id | TEXT | Returned by Splitwise; used as idempotency key |
| friend_ids | TEXT | JSON-encoded array of Splitwise user IDs e.g. `["123","456"]` |
| friend_names | TEXT | JSON-encoded array of display names in same order as `friend_ids` e.g. `["Alex K.","Sam"]` — stored at split time so History tab displays names without a network call |
| amount_each | REAL | Equal split amount per person |
| created_at | TEXT | ISO-8601 timestamp |

### History Tab Pagination

The History tab reads from local SQLite with no server-side pagination. The 6-month prune window bounds the maximum row count to a manageable size. Rows are sorted by `date DESC`. If performance becomes an issue with large local datasets, lazy loading via `LIMIT`/`OFFSET` can be added without a schema change.

### Prune Policy

On every app launch (background thread, never blocking UI):

```sql
DELETE FROM transactions WHERE created_at < datetime('now', '-6 months');
-- split_decisions deleted via CASCADE
```

---

## Keychain & Local Metadata Storage

### iOS Keychain (sensitive credentials)

All Keychain items use `kSecAttrAccessibleAfterFirstUnlock` to allow background operations while keeping the device locked after first unlock.

| Key | Value | Lifecycle |
|---|---|---|
| `plaid_access_token` | String | Written after Plaid Link completes; overwritten on reauth; deleted on bank disconnect |
| `splitwise_access_token` | String | Written after Splitwise OAuth; deleted on sign-out |
| `worker_api_key` | String | Injected at build time via `.xcconfig` (gitignored). **Rotation requires a new app binary** — the Worker accepts only the current key. Plan key rotation as part of an app release, not independently. |

### UserDefaults (non-sensitive metadata)

| Key | Type | Notes |
|---|---|---|
| `splitwise_user_id` | String | Splitwise user ID |
| `splitwise_display_name` | String | e.g. "Bala" — shown in Settings |
| `splitwise_avatar_url` | String | Profile photo URL |
| `plaid_institution_name` | String | e.g. "Chase" — from Plaid Link `onSuccess` metadata |
| `plaid_institution_logo_url` | String | Bank logo URL — from Plaid Link `onSuccess` metadata |
| `plaid_needs_reauth` | Bool | Set `true` when Worker returns `ITEM_LOGIN_REQUIRED`; reset to `false` after successful reauth (new token stored in Keychain) |
| `last_plaid_cursor` | String | Plaid sync cursor for incremental fetches; cleared when bank is disconnected or new `access_token` is stored |

#### SQLite Encryption

The SQLite file lives within the iOS app sandbox and is protected by iOS Data Protection (`NSFileProtectionComplete`). An additional SQLCipher layer is not applied in the MVP — iOS full-disk encryption is considered sufficient. This decision must be revisited if the app stores data for enterprise/regulated users.

---

## Data Flow

### 1. Onboarding

1. iOS opens Splitwise OAuth via `ASWebAuthenticationSession`
2. User grants access → iOS receives `access_token` → stored in Keychain
3. iOS calls Splitwise `GET /api/v3/get_current_user` → stores `user_id`, `display_name`, `avatar_url` in UserDefaults
4. iOS shows Bank Connect screen
5. iOS calls Worker `POST /plaid/link-token` (authenticated with `worker_api_key`) → Worker returns `link_token`
6. Plaid Link SDK launches with `link_token` → user connects bank
7. Plaid Link `onSuccess` callback returns `public_token` **and** institution metadata (`institution.name`, `institution.institution_id`) directly to iOS
8. iOS stores institution name in UserDefaults immediately (no Worker call needed for metadata)
9. iOS calls Worker `POST /plaid/exchange` with `{ public_token }` → Worker exchanges for `access_token` → returns `{ access_token }` to iOS
10. iOS stores `access_token` in Keychain; clears `last_plaid_cursor` from UserDefaults (fresh sync)
11. iOS calls Worker `POST /plaid/transactions` to fetch initial transaction set (cursor = nil)

> **Institution logo:** Plaid's `onSuccess` does not include a logo URL. Logo is fetched by calling Plaid's `POST /institutions/get_by_id` via a separate Worker route `POST /plaid/institution` (body: `{ institution_id }`), or omitted from MVP if logos are not essential to the UI.

### 2. Fetching Transactions (on app open / pull-to-refresh)

1. iOS reads `plaid_access_token` from Keychain and `last_plaid_cursor` from UserDefaults
2. iOS calls Worker `POST /plaid/transactions` with `{ access_token, cursor? }`
3. Worker calls Plaid `POST /transactions/sync` → returns full response including `added`, `modified`, `removed`, `next_cursor`
4. **Worker filters before returning:** strips any entries from `added` and `modified` where `amount <= 0` (credits/refunds). The filtered payload is what iOS receives.
5. iOS upserts `added` and `modified` into SQLite (`status = 'new'` if not already `'split'` or `'skipped'`)
6. iOS hard-deletes `removed` transaction IDs from SQLite (and cascading `split_decisions`)
7. iOS saves `next_cursor` to UserDefaults
8. If Worker returns `{ error: 'ITEM_LOGIN_REQUIRED' }`: set `plaid_needs_reauth = true` in UserDefaults, show in-app reauth banner

### 3. Plaid Reauth

1. User taps reauth banner → Plaid Link SDK relaunches in update mode with a new `link_token`
2. On success: new `public_token` issued → iOS calls Worker `POST /plaid/exchange` → receives new `access_token`
3. iOS overwrites `plaid_access_token` in Keychain
4. iOS clears `last_plaid_cursor` from UserDefaults (cursor is bound to the item; a reauthed item starts fresh)
5. iOS sets `plaid_needs_reauth = false` in UserDefaults → reauth banner dismissed
6. iOS immediately fetches transactions with the new token (cursor = nil)

### 4. Split

1. User taps Split on a transaction → Friend Picker sheet opens
2. iOS calls Splitwise `GET /api/v3/get_friends` (Keychain token in header; response cached in-memory for the session)
3. User selects friends → equal share calculated locally
4. User taps "Add to Splitwise" → button disabled immediately (prevents double-tap)
5. **Idempotency check:** iOS queries SQLite for an existing `split_decisions` row with `transaction_id = X`. If found (app was killed mid-flight after Splitwise succeeded but before SQLite write), return success immediately and update `transactions.status = 'split'` without calling Splitwise again.
6. iOS calls Splitwise `POST /api/v3/create_expense` (Keychain token in header) with friend IDs and amounts
7. **On success:** iOS atomically writes `split_decisions` row (including `friend_names` for offline History display) + updates `transactions.status = 'split'` in SQLite → confirmation toast → transaction removed from New tab
8. **On Splitwise error:** button re-enabled → error toast shown; transaction stays `'new'`; SQLite unchanged
9. **On network timeout / offline mid-flow:** iOS shows "No internet connection" error toast; button re-enabled; no SQLite changes. The next app launch will display the transaction as `'new'` again for retry.

> **Partial success handling:** If Splitwise returns success (expense created) but the subsequent SQLite write fails, the transaction will remain `'new'` in the app and the user could attempt to split again. On the next attempt, the idempotency check (step 5) will not find a local `split_decisions` row, and a duplicate Splitwise expense would be created. This is an accepted edge case for MVP given its rarity. Mitigation: wrap the SQLite write in a retry loop (up to 3 attempts) before surfacing an error. Post-MVP, consider writing a pending `split_decisions` row before the Splitwise call and updating it on success.

### 5. Skip

1. User taps Skip
2. iOS updates `transactions.status = 'skipped'` in SQLite
3. Row immediately moves from New tab to History tab

### 6. Prune (background, on app launch)

1. Background thread runs: `DELETE FROM transactions WHERE created_at < datetime('now', '-6 months')`
2. Cascades to `split_decisions`
3. Never blocks UI

### 7. Bank Disconnect

1. User taps "Disconnect bank" in Settings
2. iOS deletes `plaid_access_token` from Keychain
3. iOS clears `plaid_institution_name`, `plaid_institution_logo_url`, `plaid_needs_reauth`, `last_plaid_cursor` from UserDefaults
4. iOS deletes all rows from `transactions` (cascades to `split_decisions`)

### 8. Sign Out (Splitwise)

1. User taps "Sign out" in Settings
2. iOS deletes `splitwise_access_token` from Keychain
3. iOS clears `splitwise_user_id`, `splitwise_display_name`, `splitwise_avatar_url` from UserDefaults
4. iOS also disconnects bank (step 7 above) — no local data remains

---

## Error Handling

| Scenario | Handling |
|---|---|
| Worker returns `ITEM_LOGIN_REQUIRED` | Set `plaid_needs_reauth = true` → in-app banner → user re-runs Plaid Link update mode → new token in Keychain → `plaid_needs_reauth = false`, cursor cleared |
| Splitwise API returns 401 | Clear Splitwise Keychain token → re-initiate OAuth flow |
| No internet on app open | Show offline banner; disable fetch and split CTAs |
| No internet mid-split (after opening Friend Picker) | Network timeout surfaced as error toast; "Add to Splitwise" button re-enabled; no SQLite changes; transaction stays `'new'` |
| Duplicate split tap | Button disabled immediately on tap; re-enabled only on error response |
| Plaid returns removed transactions | Hard-deleted from SQLite immediately; cascades to `split_decisions`; Splitwise expense left intact |
| Worker error (non-Plaid) | Structured `{ error: string, code: string }` returned; iOS shows actionable message |
| SQLite write failure after Splitwise success | Retry loop (3 attempts); if all fail, show error toast; transaction stays `'new'` for retry; duplicate expense risk accepted for MVP |
| Splitwise duplicate expense (local check) | Before calling Splitwise, iOS checks SQLite for existing `split_decisions` row; if found, skips API call and marks transaction `'split'` |

---

## Cloudflare Worker

Three primary routes, all stateless. The Worker never reads, writes, or logs user financial data.

### `POST /plaid/link-token`
- Auth: `worker_api_key` in `Authorization: Bearer` header
- Action: calls Plaid `POST /link/token/create` with server-side `client_id` + `secret`
- Returns: `{ link_token }`

### `POST /plaid/exchange`
- Auth: `worker_api_key` in `Authorization: Bearer` header
- Body: `{ public_token }`
- Action: calls Plaid `POST /item/public_token/exchange`
- Returns: `{ access_token }` — Worker does not store the token; iOS stores it in Keychain
- Note: institution metadata (name, id) comes from the Plaid Link `onSuccess` iOS SDK callback, not from this endpoint

### `POST /plaid/transactions`
- Auth: `worker_api_key` in `Authorization: Bearer` header
- Body: `{ access_token, cursor? }`
- Action: calls Plaid `POST /transactions/sync`; **filters out entries where `amount <= 0`** from `added` and `modified` arrays before returning
- Returns: `{ added, modified, removed, next_cursor }` (debits only in added/modified)
- On Plaid error `ITEM_LOGIN_REQUIRED`: returns `{ error: 'ITEM_LOGIN_REQUIRED' }` with HTTP 400

### Worker Security Notes
- Worker secrets stored as Cloudflare environment variables: `PLAID_CLIENT_ID`, `PLAID_SECRET`, `WORKER_API_KEY`
- Request body logging is disabled — `access_token` values must never appear in Cloudflare logs
- Rate limiting via Cloudflare WAF rules should be applied to all three routes to limit blast radius of a stolen `worker_api_key`
- **Key rotation requires a new app binary** — the Worker accepts only the current `WORKER_API_KEY`. Coordinate rotation with an app release.

---

## Compliance & Security Notes

| Concern | Mitigation |
|---|---|
| Plaid secret key | Lives only in Cloudflare Worker env var — never in iOS binary or source control |
| Plaid access_token in transit | Sent over HTTPS (TLS 1.2+) in request body; Worker logs disabled for request bodies |
| Splitwise token | Never leaves device; iOS Keychain with `kSecAttrAccessibleAfterFirstUnlock` |
| Worker API key | Bundled via `.xcconfig` (gitignored); rotation requires coordinated app release |
| No server-side financial data | Worker is fully stateless; Cloudflare has no visibility into transaction content |
| On-device data exposure | SQLite in iOS app sandbox with `NSFileProtectionComplete`; pruned after 6 months |
| GDPR / CCPA | Privacy policy must disclose: ephemeral Plaid processing via CF Worker, local SQLite storage, 6-month retention policy, right to deletion (covered by bank disconnect + sign out flows) |
| Plaid ToS | Use case must be registered with Plaid; transaction data used only for the stated splitting purpose |
| Splitwise ToS | Confirm commercial API use is permitted before scaling; check rate limits |

---

## UI Changes vs Previous Design

The UI remains largely unchanged. Key differences:

| Screen | Change |
|---|---|
| New tab | Pull-to-refresh triggers Worker `POST /plaid/transactions` instead of Supabase Realtime subscription |
| History tab | Reads from local SQLite; friend names displayed from stored `split_decisions.friend_names` (no network call); no pagination (6-month local window) |
| Settings tab | Shows Keychain-backed token status; bank disconnect and sign-out flows clear local data |
| Onboarding | Splitwise OAuth token stored in Keychain (not sent to server); bank connect flow calls CF Worker for link-token + exchange |
| Reauth banner | Triggered by Worker `ITEM_LOGIN_REQUIRED` error response; dismissed after successful reauth |

---

## Out of Scope

- Multi-device sync for the same user
- Android / web
- Push notifications
- Reversing Splitwise expenses when a transaction is pruned or deleted
- Percentage-based or exact-amount splits (deferred, same as original design)
- Splitwise group support (friends only, same as original)
- Institution logo fetching (deferred — requires an additional Worker route; institution name shown as text in MVP)
- SQLCipher encryption (relies on iOS Data Protection; revisit for enterprise use)
