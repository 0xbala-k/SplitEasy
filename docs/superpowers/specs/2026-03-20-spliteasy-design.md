# SplitEasy — Design Spec

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

SplitEasy is an iOS app that automatically imports bank/card transactions via Plaid and lets users add them as expenses to Splitwise. Users review new transactions one at a time, choosing to split them with friends or skip them. The goal is to eliminate the manual work of logging shared expenses in Splitwise.

---

## Goals

- Automatically surface new bank transactions for review
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
- Subscribes to Supabase Realtime for live transaction updates
- 3-tab navigation: New · History · Settings

**Supabase Edge Functions (Deno)**
- `plaid-link-exchange` — receives Plaid public_token from iOS, exchanges for access_token, stores in Vault
- `plaid-webhook` — receives Plaid webhook events, fetches new transactions from Plaid API, upserts into `transactions` table
- `splitwise-create-expense` — called by iOS after friend selection; creates expense via Splitwise API, marks transaction as `split`

**PostgreSQL (Supabase)**
- All tables protected by Row Level Security (RLS)
- Supabase Realtime enabled on `transactions` table for instant push to iOS

**External APIs**
- **Plaid:** bank connection, transaction sync, webhook events
- **Splitwise:** user identity (OAuth), friend list, expense creation

### Data Flow

1. **Sign in:** iOS opens Splitwise OAuth → user grants access → iOS receives access token → stored in `users` table via Supabase Auth custom token
2. **Bank link:** iOS launches Plaid Link SDK → user connects bank → `public_token` sent to `plaid-link-exchange` Edge Function → exchanged for `access_token` → stored in Vault in `plaid_items`
3. **Transaction sync:** Plaid sends `TRANSACTIONS_SYNC` webhook → `plaid-webhook` Edge Function fetches new transactions from Plaid → upserts into `transactions` with `status = 'new'` → Supabase Realtime pushes to iOS app
4. **Split:** User taps Split → selects friends → iOS calls `splitwise-create-expense` → expense created in Splitwise → transaction updated to `status = 'split'` → record written to `split_decisions`
5. **Skip:** User taps Skip → iOS updates transaction to `status = 'skipped'` directly via Supabase client

---

## Data Model

### `users`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | Supabase auth user ID |
| splitwise_user_id | text | Splitwise user ID |
| splitwise_access_token | text 🔒 | Stored via Supabase Vault |
| display_name | text | From Splitwise profile |
| avatar_url | text | From Splitwise profile |
| created_at | timestamptz | |

### `plaid_items`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| user_id | uuid FK | → users |
| plaid_item_id | text | Plaid's item identifier |
| plaid_access_token | text 🔒 | Stored via Supabase Vault |
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
| amount | numeric(10,2) | |
| currency | text | default 'USD' |
| date | date | Transaction date from Plaid |
| status | text | `'new'` \| `'split'` \| `'skipped'` |
| created_at | timestamptz | |

### `split_decisions`
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| transaction_id | uuid FK | → transactions |
| user_id | uuid FK | → users |
| splitwise_expense_id | text | Splitwise expense reference |
| friend_ids | text[] | Splitwise user IDs of friends |
| split_type | text | `'equal'` (+ `'percentage'`, `'exact'` later) |
| amount_each | numeric(10,2) | Calculated split amount |
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
- Tapping Skip immediately marks transaction as `skipped` and removes it from list
- Tapping Split opens the friend picker sheet

**Friend picker sheet** (modal)
- Header: transaction name + amount
- Scrollable list of Splitwise friends (fetched from Splitwise API)
- Multi-select: tap to toggle; shows calculated equal share per selected friend
- "Add to Splitwise" CTA at bottom
- On success: confirmation toast ("Alex K. owes you $12.25"), transaction removed from New tab

**History tab**
- All transactions with `status = 'split'` or `'skipped'`, sorted by date descending
- Split transactions show friend names and amount each owed
- Skipped transactions shown with a muted "Skipped" label

**Settings tab**
- Connected bank account (institution name + reconnect option)
- Splitwise account (display name + sign out)
- Notifications toggle

---

## Error Handling

| Scenario | Handling |
|---|---|
| Plaid webhook missed/delayed | Plaid retries automatically; Edge Function upserts on `plaid_transaction_id` (idempotent) |
| Splitwise API error on split | Error toast shown; transaction stays `new` for retry |
| Plaid token expired (`ITEM_LOGIN_REQUIRED`) | Plaid webhook triggers push notification; user re-authenticates via Plaid Link update mode |
| Splitwise token expired (401) | App detects 401, redirects to Splitwise re-auth flow |
| No internet during split | iOS queues action; retries via URLSession background task on reconnect |
| Duplicate transaction from Plaid | `plaid_transaction_id` unique constraint rejects duplicate; Edge Function handles gracefully |

---

## Extensibility Notes

These features are explicitly deferred but the design accommodates them:

- **Multiple bank accounts:** `plaid_items` is a separate table; adding accounts is additive. MVP UI shows one account in Settings.
- **Non-equal splits:** `split_decisions.split_type` column + future `split_shares` table (per-friend amount/percentage) can be added without touching existing rows.

---

## Out of Scope

- Android / web app
- Push notifications beyond transaction arrival (deferred — requires APNs setup)
- In-app Splitwise balance view
- Exporting transaction history
