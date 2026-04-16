# SplitEasy — React Native / Expo Rebuild Design Spec

**Date:** 2026-04-15
**Status:** Approved
**Replaces (client only):** `2026-03-22-local-first-plaid-splitwise-design.md` (Swift/SwiftUI)
**Backend unchanged:** Cloudflare Worker from `2026-03-22` spec is reused as-is

---

## Overview

SplitEasy is being rebuilt from Swift/SwiftUI to React Native + Expo. The product stays identical: automatically surface bank debit transactions via Plaid and let users push them to Splitwise as shared expenses. The motivation for the rebuild is developer experience — TypeScript/JS is more familiar and allows faster iteration than Swift. The Cloudflare Worker backend is already deployed and requires zero changes.

---

## Goals

- Feature parity with the Swift MVP
- iOS + Android from a single codebase
- Expo Managed Workflow — no Xcode or Android Studio required day-to-day
- Local-first: no server stores user financial data
- OTA updates via `expo-updates` for JS-only fixes (no App Store review required for patches)

---

## Non-Goals

- Multi-device sync
- Push notifications
- Percentage or exact-amount splits (deferred — same as Swift version)
- Splitwise group support (friends only)
- Institution logo display (deferred — Worker route not implemented yet)
- SQLCipher encryption (iOS Data Protection + Android EncryptedSharedPreferences considered sufficient)

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Expo Managed SDK 52+ | No native toolchain day-to-day |
| Language | TypeScript | End-to-end; share types with CF Worker |
| Navigation | Expo Router (file-based) | Handles deep links natively — required for Splitwise OAuth callback |
| State | Zustand | One store per domain, no Redux overhead |
| Local DB | `expo-sqlite` | WAL mode; same schema as Swift/GRDB version |
| Secure storage | `expo-secure-store` | Keychain on iOS, EncryptedSharedPreferences on Android |
| Non-sensitive metadata | `@react-native-async-storage/async-storage` | Replaces UserDefaults |
| Plaid | `react-native-plaid-link-sdk` | Native module — requires custom dev client |
| OAuth | `expo-web-browser` + `expo-linking` | Splitwise OAuth flow |
| Offline detection | `@react-native-community/netinfo` | Subscribe in root layout |
| Bottom sheet | `@gorhom/bottom-sheet` | Friend Picker modal |
| Build & CI | EAS Build + EAS Submit | Managed builds, App Store + Play Store |
| OTA | `expo-updates` | JS-only patches without app review |
| Backend | Cloudflare Worker (existing) | Zero changes — 4 routes reused verbatim |

---

## Architecture

```
React Native App (Expo Managed)
  ├── expo-secure-store
  │     ├── plaid_access_token
  │     ├── splitwise_access_token
  │     └── worker_api_key            ← injected at build time via app.config.js
  ├── AsyncStorage (non-sensitive)
  │     ├── splitwise_user_id
  │     ├── splitwise_display_name
  │     ├── splitwise_avatar_url
  │     ├── plaid_institution_name
  │     ├── plaid_needs_reauth
  │     └── last_plaid_cursor
  ├── SQLite (expo-sqlite, WAL mode)
  │     ├── transactions
  │     └── split_decisions
  ├── Cloudflare Worker (stateless, existing)
  │     ├── POST /plaid/link-token
  │     ├── POST /plaid/exchange
  │     ├── POST /plaid/transactions
  │     └── POST /splitwise/exchange
  └── Splitwise API (called directly from app)
        ├── GET  /api/v3/get_current_user
        ├── GET  /api/v3/get_friends
        └── POST /api/v3/create_expense
```

---

## Project Structure

```
app/
  _layout.tsx                 ← root layout: auth gate, providers (toast, bottom sheet)
  (auth)/
    _layout.tsx
    index.tsx                 ← Welcome screen
    bank-connect.tsx          ← Bank Connect screen
  (tabs)/
    _layout.tsx               ← Bottom tab bar, badge wired to new transaction count
    index.tsx                 ← New Transactions tab
    history.tsx               ← History tab
    settings.tsx              ← Settings tab

components/
  TransactionRow.tsx
  FriendPickerSheet.tsx
  ReauthBanner.tsx
  OfflineBanner.tsx
  Toast.tsx

stores/
  authStore.ts                ← Splitwise token (secure-store) + user metadata (AsyncStorage)
  plaidStore.ts               ← Plaid token (secure-store) + cursor/flags (AsyncStorage)
  transactionStore.ts         ← in-memory transaction list sourced from SQLite
  friendStore.ts              ← in-memory friend list sourced from Splitwise API

lib/
  db.ts                       ← expo-sqlite init, migrations, typed query functions
  worker.ts                   ← typed fetch wrapper for CF Worker (bearer auth injected)
  splitwise.ts                ← Splitwise REST API calls (bearer auth injected)
  secure.ts                   ← expo-secure-store get/set/delete helpers
```

---

## State Management (Zustand)

Tokens are **never held in Zustand store state** — they live in `expo-secure-store` and are read via `lib/secure.ts` at call time. Stores hold metadata and derived booleans only.

### `authStore`
```ts
{
  user_id: string | null
  display_name: string | null
  avatar_url: string | null
  isAuthenticated: boolean           // true when splitwise_access_token exists in secure-store

  signIn(code: string, redirect_uri: string): Promise<void>
  // → calls Worker /splitwise/exchange
  // → stores access_token in secure-store
  // → stores user metadata in AsyncStorage
  // → sets isAuthenticated = true

  signOut(): Promise<void>
  // → clears secure-store (splitwise_access_token)
  // → clears AsyncStorage (user metadata)
  // → calls plaidStore.disconnect()
  // → sets isAuthenticated = false
}
```

### `plaidStore`
```ts
{
  institution_name: string | null
  needs_reauth: boolean
  isLinked: boolean                  // true when plaid_access_token exists in secure-store

  linkBank(public_token: string, institution_name: string): Promise<void>
  // → calls Worker /plaid/exchange
  // → stores access_token in secure-store
  // → stores institution_name, clears last_plaid_cursor in AsyncStorage
  // → sets isLinked = true

  disconnect(): Promise<void>
  // → clears secure-store (plaid_access_token)
  // → clears AsyncStorage (institution_name, needs_reauth, last_plaid_cursor)
  // → deletes all rows from transactions table (cascades to split_decisions)
  // → sets isLinked = false
}
```

### `transactionStore`
```ts
{
  transactions: Transaction[]        // in-memory, sourced from SQLite
  isLoading: boolean

  load(): Promise<void>              // reads all 'new' rows from SQLite
  refresh(): Promise<void>           // calls Worker /plaid/transactions, upserts SQLite, reloads
  skip(id: string): Promise<void>    // UPDATE status='skipped' in SQLite, remove from list (optimistic)
  markSplit(id: string): Promise<void> // UPDATE status='split' in SQLite, remove from list
}
```

### `friendStore`
```ts
{
  friends: SplitwiseFriend[]         // in-memory only, never persisted
  isLoading: boolean

  load(): Promise<void>
  // → reads splitwise_access_token from secure-store
  // → calls GET /api/v3/get_friends
  // → populates friends[]
  // No TTL — in-memory cache is valid for the app session (process lifetime)
  // Refreshed on every cold start via /(tabs) _layout.tsx mount effect
}
```

---

## Local Database (expo-sqlite)

### Schema

Managed via a sequential migrations array in `lib/db.ts`. Migrations run on every app start. **Never modify an existing migration — always append a new one.**

```ts
// Migration 001 — initial schema
db.execSync(`
  CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,               -- Plaid transaction ID
    merchant_name TEXT,
    amount REAL,                       -- always positive (debits only)
    currency TEXT DEFAULT 'USD',
    date TEXT,                         -- ISO-8601 date
    status TEXT DEFAULT 'new',         -- 'new' | 'split' | 'skipped'
    created_at TEXT                    -- ISO-8601 timestamp; used for 6-month prune
  );

  CREATE TABLE IF NOT EXISTS split_decisions (
    id TEXT PRIMARY KEY,               -- locally generated UUID
    transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
    splitwise_expense_id TEXT,         -- idempotency key
    friend_ids TEXT,                   -- JSON array of Splitwise user ID strings
    friend_names TEXT,                 -- JSON array, same order as friend_ids
    amount_each REAL,
    created_at TEXT
  );
`);
```

### Key Queries

```sql
-- New tab
SELECT * FROM transactions WHERE status = 'new' ORDER BY date DESC;

-- History tab
SELECT t.*, s.friend_names, s.amount_each
FROM transactions t
LEFT JOIN split_decisions s ON s.transaction_id = t.id
WHERE t.status IN ('split', 'skipped')
ORDER BY t.date DESC;

-- Idempotency check before split
SELECT splitwise_expense_id FROM split_decisions WHERE transaction_id = ?;

-- Prune (background on app start)
DELETE FROM transactions WHERE created_at < datetime('now', '-6 months');
-- split_decisions cascade automatically
```

---

## Secure Storage & AsyncStorage Layout

### `expo-secure-store` (sensitive — 2 KB per-value limit)

| Key | Value | Lifecycle |
|---|---|---|
| `splitwise_access_token` | string | Written on sign-in; deleted on sign-out |
| `plaid_access_token` | string | Written on bank link; deleted on disconnect or reauth |
| `worker_api_key` | string | Injected at build time from `app.config.js` env var; never in source control. **Key rotation requires a new EAS build.** |

### `AsyncStorage` (non-sensitive)

| Key | Type | Notes |
|---|---|---|
| `splitwise_user_id` | string | |
| `splitwise_display_name` | string | |
| `splitwise_avatar_url` | string | |
| `plaid_institution_name` | string | |
| `plaid_needs_reauth` | boolean (as string) | Set `'true'` on ITEM_LOGIN_REQUIRED; cleared after reauth |
| `last_plaid_cursor` | string | Cleared on bank disconnect or new access_token |

---

## Navigation (Expo Router)

```
app/_layout.tsx
  Reads authStore.isAuthenticated + plaidStore.isLinked on mount.
  Redirects:
    → not authenticated              : /(auth)/index
    → authenticated, not linked      : /(auth)/bank-connect
    → authenticated + linked         : /(tabs)/index

  Providers mounted here: ToastProvider, BottomSheetModalProvider, GestureHandlerRootView

app/(auth)/index.tsx  — Welcome
  "Sign in with Splitwise" button
  → expo-web-browser.openAuthSessionAsync(splitwiseOAuthURL, redirectUri)
  → on return, parse `code` from redirect URL
  → authStore.signIn(code, redirectUri)
  → navigation handled by root _layout redirect

app/(auth)/bank-connect.tsx  — Bank Connect
  "Connect via Plaid" + "Skip for now"
  PlaidLink component:
    onSuccess(public_token, metadata) →
      plaidStore.linkBank(public_token, metadata.institution.name)
  "Skip for now" → navigate to /(tabs) without linking
    (New tab shows empty state with "Connect bank" CTA)

app/(tabs)/_layout.tsx  — Tab Bar
  tabBarBadge on index tab wired to transactionStore.transactions.length
  Mounts: friendStore.load() in background useEffect (cold start refresh)
  Mounts: background prune in useEffect (DELETE old rows)

app/(tabs)/index.tsx  — New Transactions
  Loads transactionStore on mount (load + refresh)
  ReauthBanner shown if plaidStore.needs_reauth
  OfflineBanner shown if NetInfo.isConnected === false
  FlatList of TransactionRow
  pull-to-refresh → transactionStore.refresh()
  Split tap → open FriendPickerSheet (bottom sheet modal)
  Skip tap → transactionStore.skip(id) (optimistic remove)

app/(tabs)/history.tsx  — History
  Reads split + skipped transactions from SQLite
  No pagination — 6-month local window bounds dataset

app/(tabs)/settings.tsx  — Settings
  Institution name + "Disconnect bank" → plaidStore.disconnect()
  Display name + avatar + "Sign out" → authStore.signOut()
  Sign out also disconnects bank (no local data remains)
```

### Deep Link (Splitwise OAuth Callback)

Register `spliteasy` as the URL scheme in `app.json`:
```json
{ "expo": { "scheme": "spliteasy" } }
```

Splitwise redirects to `spliteasy://oauth/callback?code=XXX`. Expo Router handles this automatically — the `/(auth)/index` screen uses `expo-linking` to parse the URL and extract `code`. No manual `Linking.addEventListener` needed.

---

## Data Flows

### 1. Sign In (Splitwise OAuth)

1. User taps "Sign in with Splitwise"
2. `expo-web-browser.openAuthSessionAsync(url, 'spliteasy://oauth/callback')`
3. User grants access → Splitwise redirects to `spliteasy://oauth/callback?code=XXX`
4. App receives URL → extracts `code`
5. `authStore.signIn(code, 'spliteasy://oauth/callback')`
   - Calls Worker `POST /splitwise/exchange` → returns `{ access_token, user_id, display_name, avatar_url }`
   - Stores `access_token` in `expo-secure-store`
   - Stores user metadata in AsyncStorage
6. Root `_layout` redirect fires → navigates to `/(auth)/bank-connect`

### 2. Bank Link (Plaid)

1. Worker `POST /plaid/link-token` → returns `link_token`
2. `PlaidLink` component opens with `link_token`
3. `onSuccess(public_token, metadata)`:
   - Worker `POST /plaid/exchange` → returns `{ access_token }`
   - `expo-secure-store` stores `plaid_access_token`
   - AsyncStorage stores `plaid_institution_name` from `metadata.institution.name`
   - AsyncStorage clears `last_plaid_cursor` (fresh sync)
4. Root `_layout` redirect fires → navigates to `/(tabs)/index`
5. `transactionStore.refresh()` called immediately (cursor = null → full initial sync)

### 3. Fetch Transactions (on app open / pull-to-refresh)

1. Read `plaid_access_token` from `expo-secure-store`, `last_plaid_cursor` from AsyncStorage
2. Worker `POST /plaid/transactions` with `{ access_token, cursor? }`
3. Worker proxies to Plaid `/transactions/sync`, filters out credits (amount ≤ 0), returns `{ added, modified, removed, next_cursor }`
4. Upsert `added` + `modified` into SQLite (`status = 'new'` only if not already `'split'` or `'skipped'`)
5. Hard-delete `removed` IDs from SQLite (cascades to `split_decisions`)
6. Save `next_cursor` to AsyncStorage
7. If Worker returns `{ error: 'ITEM_LOGIN_REQUIRED' }`: set `plaid_needs_reauth = 'true'` in AsyncStorage, show `ReauthBanner`

### 4. Plaid Reauth

1. User taps `ReauthBanner`
2. Worker `POST /plaid/link-token` → new `link_token`
3. `PlaidLink` opens in update mode with `link_token`
4. `onSuccess` → new `public_token` → Worker `POST /plaid/exchange` → new `access_token`
5. Overwrite `plaid_access_token` in `expo-secure-store`
6. Clear `last_plaid_cursor` from AsyncStorage (cursor bound to item; reauthed item starts fresh)
7. Set `plaid_needs_reauth = 'false'` → banner dismissed
8. `transactionStore.refresh()` immediately (cursor = null)

### 5. Split

1. User taps Split → `FriendPickerSheet` opens
2. `friendStore.load()` (no-op if already loaded this session)
3. User multi-selects friends; equal share calculated locally
4. User taps "Add to Splitwise" → button disabled immediately
5. **Idempotency check:** query SQLite for existing `split_decisions` row with `transaction_id = X`
   - If found: skip Splitwise API call; update `transactions.status = 'split'`; show success toast; return
6. Read `splitwise_access_token` from `expo-secure-store`
7. `POST /api/v3/create_expense` to Splitwise
8. **On success:**
   - Write `split_decisions` row (including `friend_names` for offline History display)
   - Update `transactions.status = 'split'` in SQLite
   - Dismiss sheet; show success toast "Others owe you $X.XX"
   - `transactionStore.markSplit(id)` removes from New tab
9. **On error:** re-enable button; show error toast; SQLite unchanged; transaction stays `'new'`

**Partial success risk:** If Splitwise succeeds but the SQLite write fails (all 3 retry attempts), show error toast; transaction stays `'new'`; user may retry; a duplicate Splitwise expense could be created. Accepted for MVP. Idempotency check (step 5) only catches cases where the SQLite write *succeeded* on a prior attempt.

### 6. Skip

1. User taps Skip
2. `transactionStore.skip(id)` → update SQLite `status = 'skipped'` → remove from in-memory list (optimistic)
3. Row appears in History tab on next load

### 7. Prune (background, on tab bar mount)

```sql
DELETE FROM transactions WHERE created_at < datetime('now', '-6 months');
```
Runs in a `useEffect` in `/(tabs)/_layout.tsx`, off the main thread. Never blocks UI.

### 8. Bank Disconnect

1. User taps "Disconnect bank" in Settings
2. Delete `plaid_access_token` from `expo-secure-store`
3. Clear `plaid_institution_name`, `plaid_needs_reauth`, `last_plaid_cursor` from AsyncStorage
4. `DELETE FROM transactions` (cascades to `split_decisions`)
5. `plaidStore.isLinked = false` → root `_layout` redirect fires → `/(auth)/bank-connect`

### 9. Sign Out

1. User taps "Sign out" in Settings
2. Runs Bank Disconnect (step 8 above) first
3. Delete `splitwise_access_token` from `expo-secure-store`
4. Clear `splitwise_user_id`, `splitwise_display_name`, `splitwise_avatar_url` from AsyncStorage
5. `authStore.isAuthenticated = false` → root `_layout` redirect fires → `/(auth)/index`

---

## Error Handling

| Scenario | Handling |
|---|---|
| Worker returns `ITEM_LOGIN_REQUIRED` | Set `plaid_needs_reauth = true` in AsyncStorage; show `ReauthBanner`; user re-runs Plaid Link update mode |
| Splitwise API 401 | Clear `splitwise_access_token` from secure-store; `authStore.isAuthenticated = false`; root layout redirects to sign-in |
| No internet on app open | `NetInfo` detects offline; `OfflineBanner` shown; refresh + split CTAs disabled |
| No internet mid-split (after sheet opens) | Network timeout → error toast; button re-enabled; SQLite unchanged; transaction stays `'new'` |
| Duplicate split tap | Button disabled on first tap; re-enabled only on error response |
| Plaid removed transactions | Hard-deleted from SQLite immediately via `removed` array; cascades to `split_decisions`; Splitwise expense left intact |
| Worker error (non-Plaid) | Structured `{ error: string }` returned; show actionable error toast |
| SQLite write failure after Splitwise success | Retry loop (3 attempts); if all fail: error toast; transaction stays `'new'`; duplicate expense risk accepted for MVP |
| Duplicate split (idempotency check) | Before calling Splitwise, check SQLite for existing `split_decisions` row; if found, skip API call and mark `'split'` |
| `expo-secure-store` read returns null | Treat as signed-out / disconnected state; redirect to auth |

---

## Key Gotchas & Decisions

### 1. Plaid requires a custom dev client
`react-native-plaid-link-sdk` is a native module and **does not work in Expo Go**. You need a custom dev client built via EAS:
```bash
eas build --profile development --platform ios
```
This is a one-time setup. After that, install the dev client on your device and develop normally with fast refresh.

### 2. Splitwise OAuth deep link scheme must be registered in `app.json`
```json
{ "expo": { "scheme": "spliteasy" } }
```
Without this, `expo-web-browser.openAuthSessionAsync` cannot return to the app after OAuth. On Android, also ensure `intentFilters` are set correctly (Expo handles this automatically from the `scheme` field).

### 3. `expo-secure-store` 2 KB per-value limit
Tokens and API keys are well within this. Never store transaction data or friend lists here.

### 4. `worker_api_key` must never be in source control
Inject via `app.config.js` using `process.env.WORKER_API_KEY`. In EAS, add it as an EAS secret:
```bash
eas secret:create --name WORKER_API_KEY --value <key>
```
In `app.config.js`:
```js
extra: { workerApiKey: process.env.WORKER_API_KEY }
```
Read in the app via `Constants.expoConfig.extra.workerApiKey`. Write to secure-store on first launch.

### 5. OTA updates do NOT update native modules
`expo-updates` pushes JS bundle changes only. If you update `react-native-plaid-link-sdk` or any other native module, a full EAS build + App Store submission is required. Plan native module upgrades as part of releases, not hotfixes.

### 6. expo-sqlite WAL mode
Enable WAL (Write-Ahead Logging) immediately after opening the DB for better concurrent read performance:
```ts
db.execSync('PRAGMA journal_mode = WAL;');
```

### 7. Button disabled on first tap (split idempotency)
Disable the "Add to Splitwise" button immediately on press, before the async call starts. Re-enable only on error. This prevents double-submission from fast taps and is simpler than debounce.

### 8. Friend list cache is in-memory only (no TTL needed)
`friendStore.friends` is a plain Zustand array — never written to AsyncStorage. It is populated on every cold start via a background `useEffect` in the tab bar layout. Valid for the app session (process lifetime). No stale-data risk.

### 9. Migrations are append-only
`lib/db.ts` contains a sequential array of migration functions. The index in the array is the migration version. **Never modify an existing migration.** Always append a new function. On app start, the migrator runs all migrations not yet applied (tracked by a `user_version` PRAGMA).

### 10. Android back button during OAuth
`expo-web-browser.openAuthSessionAsync` handles the Android back button correctly — it dismisses the browser and resolves the promise with `{ type: 'cancel' }`. No manual `BackHandler` needed.

### 11. Plaid `onSuccess` metadata includes institution name but not logo URL
`metadata.institution.name` is available directly in the `onSuccess` callback and should be saved to AsyncStorage immediately — no extra network call needed. Institution logo requires a separate Worker route (`POST /plaid/institution`) that is **not yet implemented** — defer for post-MVP.

### 12. Cursor must be cleared on reauth
The Plaid sync cursor is bound to a specific `access_token`. When the user reauthenticates (gets a new token), clear `last_plaid_cursor` from AsyncStorage before the next `refresh()` call — otherwise Plaid will return a cursor mismatch error.

### 13. Splitwise `create_expense` equal split format
For an equal split among N people (current user + N-1 friends), the expense `cost` is the full transaction amount. Each person owes `cost / N`. The current user pays the full amount. Splitwise uses an indexed flat-key format:

```ts
// Example: $30 split equally among user + 2 friends (N=3, each owes $10)
const body = {
  cost: '30.00',
  description: 'Merchant Name',
  currency_code: 'USD',
  // Index 0 = current user (payer)
  'users__0__user_id': currentUserId,
  'users__0__paid_share': '30.00',
  'users__0__owed_share': '10.00',
  // Index 1..N-1 = friends (owe their share, paid nothing)
  'users__1__user_id': friendIds[0],
  'users__1__paid_share': '0.00',
  'users__1__owed_share': '10.00',
  'users__2__user_id': friendIds[1],
  'users__2__paid_share': '0.00',
  'users__2__owed_share': '10.00',
};
// POST as application/x-www-form-urlencoded or JSON — both accepted by Splitwise v3
```

The response includes `expenses[0].id` as the `splitwise_expense_id` to store in `split_decisions`.

### 14. `@gorhom/bottom-sheet` requires `GestureHandlerRootView`
Wrap the root layout in `<GestureHandlerRootView style={{ flex: 1 }}>`. Without this, bottom sheet gestures will not work on Android.

### 15. EAS build profile separation
Define three profiles in `eas.json`:
- `development` — custom dev client with `NODE_ENV=development`
- `preview` — internal distribution (TestFlight / internal track)
- `production` — App Store / Play Store submission

---

## Cloudflare Worker (Unchanged)

The existing Worker deployed at phase 1 is reused verbatim. For reference, the four routes:

| Route | Purpose |
|---|---|
| `POST /plaid/link-token` | Creates Plaid `link_token` using server-side credentials |
| `POST /plaid/exchange` | Exchanges `public_token` → `access_token` (never stored server-side) |
| `POST /plaid/transactions` | Proxies Plaid `/transactions/sync`; filters out credits (amount ≤ 0) |
| `POST /splitwise/exchange` | Exchanges OAuth `code` → `access_token` using `client_secret` |

All routes require `Authorization: Bearer <WORKER_API_KEY>`. The Worker logs no sensitive data.

---

## Testing Strategy

| Layer | Approach |
|---|---|
| `lib/db.ts` | Unit tests with an in-memory SQLite instance |
| `lib/worker.ts` | Unit tests mocking `fetch` |
| `lib/splitwise.ts` | Unit tests mocking `fetch` |
| Zustand stores | Unit tests with mocked `lib/*` dependencies |
| Components | React Native Testing Library for interaction tests |
| E2E | Detox or Maestro for the full onboarding + split flow on a simulator |

---

## Out of Scope

- Multi-device sync
- Push notifications
- Percentage-based or exact-amount splits
- Splitwise group support
- Institution logo (requires new Worker route — deferred)
- SQLCipher encryption (iOS Data Protection + Android EncryptedSharedPreferences sufficient for MVP)
- Reversing Splitwise expenses when a transaction is pruned or deleted
- Web app
