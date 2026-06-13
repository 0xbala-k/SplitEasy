# History actions: split skipped, edit split, delete split

**Date:** 2026-06-12
**Status:** Approved

## Problem

Once a transaction leaves the dashboard it lands in the read-only History tab as
either `skipped` or `split`. There is no way to act on it afterward. Users need to:

1. **Split a skipped transaction** — they skipped it but later decide to split it.
2. **Edit a split transaction** — change who it was split with, or the per-person shares.
3. **Delete a split transaction** — undo a split entirely, including the Splitwise expense.

## Scope

In scope: the three actions above, triggered from the History tab.

Out of scope: editing a transaction's merchant name or total amount. Those come from
Plaid and remain fixed. "Edit" only changes split participants and their shares.

## Key constraint

The local `split_decisions` table stores the friend list and a single `amount_each`,
but **not** each friend's individual owed share. For a custom split, the exact
per-friend breakdown lives only in Splitwise. Therefore the Edit flow pre-fills from
Splitwise (the source of truth for the expense being edited) rather than from local
data. This is **Approach A**: accurate edits for custom splits at the cost of one extra
Splitwise read.

## Interaction model

All actions start by tapping a row in the History tab.

- **Tap a skipped row** → present `FriendPickerSheet` in *create* mode for that
  transaction. Identical to splitting from the dashboard. On success the row becomes a
  split.
- **Tap a split row** → present `HistoryActionSheet`, a small `@gorhom/bottom-sheet`
  modal (consistent with `FriendPickerSheet`) offering **Edit** and **Delete**.
  - **Edit** → dismiss the action sheet, then present `FriendPickerSheet` in *edit*
    mode, pre-filled from Splitwise.
  - **Delete** → confirm via `Alert`, then run the delete flow.

## Components and changes

### `FriendPickerSheet` — add a mode

New optional prop: `{ mode: 'create' | 'edit', existing?: SplitDecision }`.

- *Create* mode: unchanged. Covers both brand-new (dashboard) and skipped (History)
  transactions.
- *Edit* mode: on open, call `getExpense(existing.splitwise_expense_id)` to fetch each
  non-owner's owed share. Pre-select those friends, populate `customAmounts`, and set
  `splitMode` to `equal` if all shares are equal else `custom`. The CTA reads
  "Save changes" and calls the update path.

The current short-circuit in `handleAddToSplitwise` (`if (existing) { re-mark split;
return; }`) is replaced by an explicit branch on `mode`. In edit mode `existing` is
always present, so the old guard would wrongly skip the Splitwise update.

### `HistoryActionSheet` — new component

A minimal bottom-sheet modal with **Edit** and **Delete** rows. Receives the selected
`TransactionWithSplit` and callbacks. Delete shows a confirmation `Alert` before acting.

### `lib/splitwise.ts` — three additions

- `updateExpense(expenseId, params)` — same body builder as `createExpense`, POST to
  `/update_expense/{id}`.
- `deleteExpense(expenseId)` — POST to `/delete_expense/{id}`.
- `getExpense(expenseId)` — GET `/get_expense/{id}`, returns each non-owner user's
  `owed_share` keyed by user id.

The body-building logic shared by create and update is extracted into a helper so the
two paths cannot drift.

### `lib/db.ts` — two additions

- `upsertSplitDecision(decision)` — replaces the existing row on edit. The current
  `insertSplitDecision` would throw on the `UNIQUE(transaction_id)` constraint.
- `deleteSplitDecision(transactionId)` — removes the row during delete.

### Delete flow → "return to dashboard as new"

Ordered so Splitwise and local state never diverge:

1. `deleteExpense(splitwise_expense_id)` (Splitwise first)
2. `deleteSplitDecision(transactionId)`
3. `updateTransactionStatus(transactionId, 'new')`
4. `useTransactionStore.getState().load()`

Because the dashboard subscribes to the transaction store, the transaction reappears
there live, without a remount. The History list re-queries via its focus effect / the
`onDone` callback below.

### State refresh

The sheets take an `onDone` callback that re-runs `getHistoryTransactions()` so History
updates immediately after any action rather than only on the next focus.

## Data flow per action

**Split skipped:** tap → `FriendPickerSheet` (create) → `createExpense` →
`insertSplitDecision` → `markSplit` (status `split`) → `onDone` refreshes History.

**Edit split:** tap → action sheet → Edit → `FriendPickerSheet` (edit) prefilled via
`getExpense` → on save: `updateExpense` (Splitwise first) → `upsertSplitDecision`
(replaces row) → status stays `split` → `onDone` refreshes History.

**Delete split:** tap → action sheet → Delete → confirm → delete flow above →
transaction returns to the dashboard as `new`.

## Error handling

- Splitwise `401` → existing `SplitwiseAuthError` → "session expired" toast. No local
  write happens, so local state stays consistent with Splitwise.
- **Edit:** update Splitwise first, then write the local row. A failed update leaves the
  old decision intact.
- **Delete:** delete on Splitwise first, then revert locally. A failed Splitwise delete
  keeps the split intact and shows an error toast, avoiding a state where the local row
  is gone but the Splitwise expense lingers.

## Testing strategy (TDD)

Unit-test the pure / logic layers with mocked dependencies:

- `lib/splitwise.ts`: `updateExpense`, `deleteExpense`, `getExpense` against a mocked
  `fetch` — assert correct HTTP method, path, request body, and `401` → `SplitwiseAuthError`.
- `lib/db.ts` logic where mockable: `upsertSplitDecision` replaces an existing row;
  `deleteSplitDecision` removes it.
- `transactionStore`: the delete-revert action sets status to `new` and reloads the
  in-memory list.

The `FriendPickerSheet` edit-mode UI and `HistoryActionSheet` interactions are verified
manually, consistent with how the swipe gesture was handled previously — React Native
bottom-sheet interactions are not unit-testable in this jest setup.

## Manual verification checklist

- Skipped row → tap → split it → moves to the split state in History.
- Split row → Edit → change friends/amounts → Splitwise expense reflects the change.
- Split row (custom split) → Edit → exact per-friend amounts are pre-filled.
- Split row → Delete → confirm → Splitwise expense removed; transaction reappears on the
  dashboard.
