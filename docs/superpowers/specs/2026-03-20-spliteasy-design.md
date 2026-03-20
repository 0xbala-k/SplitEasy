# SplitEasy — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

SplitEasy is an iOS app that automatically imports bank/card transactions via Plaid and lets users add them as expenses to Splitwise. Users review new transactions one at a time, choosing to split them with friends or skip them. The goal is to eliminate the manual work of logging shared expenses in Splitwise.

---

## Goals

- Automatically surface new bank debit transactions for review (credits/refunds excluded)
- Allow users to split a transaction equally among Splitwise friends in a few taps
- Keep history of split and skipped transactions
- Design for extensibility: multi-account support and non-equal split types are out of scope for MVP but must not require schema changes to add later

---

## Non-Goals (MVP)

- Multiple linked bank accounts per user (UI limited to one; schema supports many)
- Percentage-based or exact-amount splits (schema prepared; UI deferred)
- Splitwise group support (friends only for MVP)
- Recurring split defaults or saved friend groups
- Manual transaction entry
- Push notifications (APNs setup deferred; in-app banners used instead)

---

## Tech Stack

| Layer | Technology |
|---|---|
| iOS App | Swift / SwiftUI |
| Backend | Supabase (Postgres + Edge Functions + Realtime) |
| Bank data | Plaid (Transactions product + webhooks) |
| Identity + expenses | Splitwise OAuth + REST API |
| Sensitive token storage | Supabase Vault |

---

## Architecture

### Components

**iOS App (SwiftUI)**
- Handles Splitwise OAuth via `ASWebAuthenticationSession`
- Embeds Plaid Link SDK for bank connection
- Subscribes to Supabase Realtime for live transaction updates; falls back to pull-to-refresh if Realtime socket is unavailable
- 3-tab navigation: New · History · Settings

**Supabase Edge Functions (Deno)**
- `splitwise-auth-callback` — receives Splitwise OAuth access token from iOS after sign-in, stores it in Vault, writes user profile to `users` table; iOS never writes directly to the `users` table
- `splitwise-get-friends` — called by iOS when opening the friend picker; retrieves Vault-stored Splitwise access token for the user and proxies the Splitwise `/friends` API call; iOS cannot call Splitwise directly since the token lives in Vault
- `plaid-link-exchange` — receives Plaid `public_token` from iOS, exchanges for `access_token`, stores in Vault in `plaid_items`
- `plaid-webhook` — receives Plaid webhook events; verifies Plaid webhook signature before processing; fetches new/removed transactions from Plaid; upserts `status = 'new'` for new debits, sets `status = 'removed'` for removed transactions
- `splitwise-create-expense` — called by iOS after friend selection; checks `split_decisions` for an existing `splitwise_expense_id` on the transaction before creating (idempotency guard); creates expense via Splitwise API; writes `split_decisions` row and updates `transactions.status = 'split'` atomically; returns a structured error to iOS if Splitwise returns 401

**PostgreSQL (Supabase)**
- All tables protected by Row Level Security (RLS)
- RLS policy on `transactions`: users may `SELECT` and `UPDATE` (status field only) rows where `user_id = auth.uid()`; all other writes go through Edge Functions using the service role key
- RLS policy on `split_decisions`: users may `SELECT` rows where `user_id = auth.uid()`; all writes go through `splitwise-create-expense` Edge Function using service role key
- RLS policy on `plaid_items`: users may `SELECT` rows where `user_id = auth.uid()`; all writes go through `plaid-link-exchange` Edge Function using service role key
- RLS policy on `users`: users may `SELECT` their own row (`id = auth.uid()`); all writes go through `splitwise-auth-callback` Edge Function using service role key
- Supabase Realtime enabled on `transactions` table for instant push to iOS

**External APIs**
- **Plaid:** bank connection, transaction sync, webhook events (signed)
- **Splitwise:** user identity (OAuth), friend list, expense creation

### Data Flow

1. **Sign in:** iOS opens Splitwise OAuth via `ASWebAuthenticationSession` → user grants access → iOS receives access token → iOS sends token to `splitwise-auth-callback` Edge Function → function stores token in Vault, creates/updates `users` row
2. **Bank link:** iOS launches Plaid Link SDK → user connects bank → `public_token` sent to `plaid-link-exchange` Edge Function → exchanged for `access_token` → stored in Vault in `plaid_items`
3. **Transaction sync:** Plaid sends signed webhook → `plaid-webhook` verifies signature → fetches transactions from Plaid → upserts debits (amount > 0) as `status = 'new'`; marks removed transactions as `status = 'removed'` → Supabase Realtime pushes update to iOS app
4. **Split:** User taps Split → selects friends → "Add to Splitwise" button disabled on tap to prevent double-submission → iOS calls `splitwise-create-expense` → function checks for existing `splitwise_expense_id` (idempotency) → creates expense in Splitwise → writes `split_decisions` + updates `transactions.status = 'split'` in one DB transaction → iOS shows confirmation toast
5. **Skip:** User taps Skip → iOS updates `transactions.status = 'skipped'` directly via Supabase client (RLS permits UPDATE on own rows)

---

## Data Model

### `users`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | Supabase auth user ID |
| splitwise_user_id | text | Splitwise user ID |
| splitwise_access_token | text 🔒 | Vault secret reference; written only by `splitwise-auth-callback` Edge Function |
| display_name | text | From Splitwise profile |
| avatar_url | text | From Splitwise profile |
| created_at | timestamptz | |

### `plaid_items`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | → users |
| plaid_item_id | text | Plaid's item identifier |
| plaid_access_token | text 🔒 | Vault secret reference; written only by `plaid-link-exchange` Edge Function |
| institution_name | text | Display name for bank |
| institution_logo_url | text | |
| created_at | timestamptz | |

One user can have multiple rows (schema-ready for multi-account; MVP UI limits to one).

### `transactions`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | → users |
| plaid_item_id | uuid FK | → plaid_items |
| plaid_transaction_id | text UQ | Prevents duplicates on re-sync |
| merchant_name | text | |
| amount | numeric(10,2) | Always positive (debits only surfaced) |
| currency | text | default 'USD' |
| date | date | Transaction date from Plaid |
| status | text | `'new'` \| `'split'` \| `'skipped'` \| `'removed'` |
| created_at | timestamptz | |

Only transactions with `amount > 0` (debits) are inserted. Credits and refunds from Plaid are silently ignored by `plaid-webhook`.

`'removed'` status is set when Plaid sends a `TRANSACTIONS_REMOVED` event. Removed transactions are hidden from all tabs. If a removed transaction had already been split, the corresponding Splitwise expense is left intact (out of scope to reverse).

### `split_decisions`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| transaction_id | uuid FK | → transactions |
| user_id | uuid FK | → users |
| splitwise_expense_id | text | Splitwise expense reference; used as idempotency key |
| friend_ids | text[] | Splitwise user IDs of friends |
| split_type | text | `'equal'` for MVP; `'percentage'` and `'exact'` deferred |
| equal_amount_each | numeric(10,2) | Amount per person for equal splits only; NULL for future non-equal splits |
| created_at | timestamptz | |

---

## UI Screens

### Onboarding
1. **Welcome screen** — app name, tagline, "Sign in with Splitwise" button
2. **Bank connect screen** — shown after sign-in; "Connect via Plaid" CTA + "Skip for now" option

### Main App (Tab Bar)

**New tab** (default, badge count of unreviewed transactions)
- List of transactions with `status = 'new'`, sorted by date descending
- Each row: merchant name, date, amount
- Two inline actions per row: **Split** and **Skip**
- Tapping Skip immediately updates `status = 'skipped'` and removes the row from the list
- Tapping Split opens the friend picker sheet
- Pull-to-refresh available as fallback when Realtime is unavailable

**Friend picker sheet** (modal)
- Header: transaction name + amount
- Scrollable list of Splitwise friends fetched from Splitwise API; cached for the session and refreshed in the background on next app launch
- Empty state: "You have no Splitwise friends yet. Add friends in Splitwise first." with a link to open the Splitwise app
- Multi-select: tap to toggle; shows calculated equal share per selected friend
- "Add to Splitwise" CTA at bottom; disabled immediately on tap to prevent double-submission
- On success: confirmation toast (e.g. "Alex K. owes you $12.25"), transaction removed from New tab
- On error: error toast shown, CTA re-enabled for retry

**History tab**
- Transactions with `status = 'split'` or `'skipped'`, sorted by date descending
- Paginated: 50 rows per page, cursor-based on composite key `(date DESC, id ASC)` to guarantee unique page boundaries
- Split transactions show friend names and `equal_amount_each` owed
- Skipped transactions shown with a muted "Skipped" label

**Settings tab**
- Connected bank account (institution name + reconnect option)
- Splitwise account (display name + sign out)
- Notifications toggle (placeholder for future APNs; no-op in MVP)

---

## Error Handling

| Scenario | Handling |
|---|---|
| Plaid webhook missed/delayed | Plaid retries automatically; `plaid-webhook` upserts on `plaid_transaction_id` (idempotent) |
| Invalid Plaid webhook signature | `plaid-webhook` returns 401 immediately; event discarded |
| Splitwise API error on split | Error toast shown; CTA re-enabled; transaction stays `new` for retry |
| Duplicate split submission | `splitwise-create-expense` detects existing `splitwise_expense_id` in `split_decisions`; returns success without creating a second expense |
| Plaid token expired (`ITEM_LOGIN_REQUIRED`) | `plaid-webhook` receives event → sets a flag on `plaid_items.needs_reauth = true` → iOS shows in-app banner on next open prompting user to reconnect via Plaid Link update mode |
| Splitwise token expired (401) | Edge Function receives 401 from Splitwise API → returns structured `{ error: 'splitwise_auth_expired' }` to iOS → iOS initiates Splitwise re-auth flow via `splitwise-auth-callback` |
| No internet during split | iOS disables CTA while offline; shows "No internet connection" inline message |
| Plaid `TRANSACTIONS_REMOVED` event | `plaid-webhook` sets `status = 'removed'` on affected rows; rows hidden from New and History tabs regardless of prior status (including previously `'split'` rows — this is intentional; the Splitwise expense is left intact and the user can manage it directly in Splitwise) |
| Realtime socket unavailable | iOS falls back to pull-to-refresh; no silent data staleness |
| Credit / refund transaction from Plaid | Ignored by `plaid-webhook` (amount ≤ 0 filtered at insertion time) |

---

## Extensibility Notes

These features are explicitly deferred but the design accommodates them without schema changes:

- **Multiple bank accounts:** `plaid_items` is a separate table; adding accounts is additive. MVP UI shows one account in Settings.
- **Non-equal splits:** `split_decisions.split_type` accepts future values (`'percentage'`, `'exact'`). A `split_shares` table (split_decision_id, friend_id, amount, percentage) can be added for per-friend amounts. `equal_amount_each` is NULL for non-equal splits.

---

## Out of Scope

- Android / web app
- Push notifications (APNs setup deferred; Settings toggle is a placeholder)
- In-app Splitwise balance view
- Exporting transaction history
- Reversing Splitwise expenses when a Plaid transaction is removed
