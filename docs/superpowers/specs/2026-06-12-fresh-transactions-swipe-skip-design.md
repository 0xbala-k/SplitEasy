# Fresh-Transactions-Only Dashboard + Swipe-to-Skip — Design

**Date:** 2026-06-12
**Status:** Approved (filter method and swipe UX confirmed by user)

## Problem

1. When a user connects a bank account, Plaid's first `/transactions/sync` call
   returns the historical backlog (typically 90+ days). All of it lands on the
   dashboard as "pending splits", burying genuinely new transactions.
2. Skipping a transaction requires tapping a small × button. The user wants a
   swipe-right gesture to skip.

## Decisions

- **Filter method: drain the first sync.** On the first sync for an account
  (no saved cursor), fetch the entire backlog but discard the transactions,
  saving only Plaid's `next_cursor`. Every subsequent sync then returns only
  transactions that occurred after connection. No date heuristics.
- **Swipe UX: full swipe skips.** Swiping a row right reveals a "Skip"
  underlay; releasing past the open threshold (or tapping the revealed action)
  skips immediately. The existing × button stays as a fallback.

## Changes

### 1. First-sync drain (`mobile/stores/transactionStore.ts`)

In `refresh()`, per account:

- **Cursor is `null` (first sync):** loop `fetchTransactions(token, cursor)`
  while `has_more` is true, ignoring `added`/`modified`/`removed`. Persist the
  final `next_cursor` via `saveCursor`. Insert nothing into SQLite.
- **Cursor exists (incremental sync):** current behavior, but also loop while
  `has_more` so multi-page updates aren't silently truncated (today only the
  first page is consumed). Upsert/delete per page, save the final cursor.

The worker already returns `has_more`, and `PlaidTransactionsResponse`
already includes it; no backend or type changes needed.

Existing linked accounts already have a cursor, so they are unaffected.
Old rows already in SQLite from before this change are out of scope.

### 2. Swipe-right-to-skip (`mobile/components/TransactionRow.tsx`)

- Wrap the row card in `ReanimatedSwipeable` from
  `react-native-gesture-handler/ReanimatedSwipeable` (available in the
  installed v2.20; reanimated v3.16 is already a dependency, and
  `GestureHandlerRootView` already wraps the app).
- `renderLeftActions` renders a "Skip" underlay (muted background, close icon
  + label) revealed by a rightward swipe.
- `onSwipeableOpen` with direction `left` calls `onSkip()` — a full swipe past
  the threshold skips without a second tap; tapping the revealed underlay also
  skips.
- The × and Split buttons are unchanged. History rows are not swipeable.

## Error handling

- Drain loop failures (network, `ITEM_LOGIN_REQUIRED`) fall through to the
  existing `refresh()` catch. The cursor is only saved after the drain
  completes, so a partial drain retries from the start next refresh — sync
  cursors are replayable, so this is safe and idempotent.
- Skip-on-swipe reuses the existing `skip(id)` store action (SQLite status
  update + list removal); no new failure modes.

## Testing

- `transactionStore.test.ts`: first sync (no cursor) drains multi-page
  backlog, saves final cursor, inserts nothing; incremental sync loops
  `has_more` pages and upserts each; existing skip/reauth tests unchanged.
- Swipe behavior verified manually (gesture simulation is unreliable in
  jest-expo); the skip action itself is already covered by store tests.
