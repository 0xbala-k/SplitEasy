# Splitwise Inbox — Importing Expenses You Didn't Pay For

**Date:** 2026-08-24
**Status:** Approved

## Problem

SplitEasy learns about spending exclusively through Plaid, which only ever sees
charges on the user's own cards. When a friend pays for a shared dinner and adds
the user to the expense in Splitwise, the user genuinely owes that money — but no
Plaid transaction exists, so the expense never reaches History and never counts
toward the spending tracker. The user's monthly total is systematically short by
every dollar someone else fronted.

Splitwise already holds these expenses, and the app already holds a Splitwise
access token. Nothing needs to be invented — the data just needs to be pulled,
triaged, and written into the same shape the rest of the app already reads.

## Goals

- Poll Splitwise for expenses where the user owes a share but paid nothing.
- Present them for one-tap approval rather than importing silently.
- On accept, make them indistinguishable from any other committed transaction to
  History and to the spending tracker.
- Reconcile upstream changes: an expense the payer edits or deletes should follow.
- Auto-attribute expenses from an active vacation's Splitwise group to that vacation.

## Non-goals

- Backfilling expenses that predate enabling this. The watermark starts at "now".
- Editing or deleting the friend's Splitwise expense. These records belong to
  someone else; the app never writes to them.
- A review queue for upstream amount changes. It isn't the user's expense to
  reconcile — changes apply silently.
- Currency conversion. `aggregateMonth` already segregates currencies.
- Pruning the inbox. Dismissed tombstones are kept indefinitely — dropping one
  would let an old expense reappear the next time its payer edits it. Untriaged
  pending items are left alone too; they only accumulate if the user ignores them,
  and silently discarding a real debt is worse than a long list.

---

## Data model

### Migration: SQLite `user_version` 6 → 7

```sql
ALTER TABLE transactions ADD COLUMN source TEXT;      -- NULL/'plaid' | 'splitwise'
ALTER TABLE transactions ADD COLUMN payer_name TEXT;  -- NULL for Plaid rows

CREATE TABLE IF NOT EXISTS splitwise_inbox (
  expense_id  TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  cost        REAL NOT NULL,
  currency    TEXT NOT NULL,
  date        TEXT NOT NULL,      -- "YYYY-MM-DD"
  payer_name   TEXT NOT NULL,
  my_share     REAL NOT NULL,
  participants TEXT NOT NULL,    -- JSON [{id, name}] of everyone except the user
  group_id     TEXT,
  state       TEXT NOT NULL,      -- 'pending' | 'dismissed'
  fetched_at  TEXT NOT NULL
);
```

Both `ALTER TABLE` statements run **ungated** — not behind a `version >= 1` guard
— because `source` and `payer_name` are absent from the base `version < 1`
`CREATE TABLE`, so a brand-new install at version 0 must receive them too. This
mirrors the convention already documented in `db.ts` for `vacation_id`,
`review_reason`, and the bucket columns. Bump the `PRAGMA user_version` stamp to 7.

Existing rows have `source IS NULL`, which reads as Plaid. Every consumer treats
`source IS NULL OR source = 'plaid'` as Plaid-origin; only `'splitwise'` is special.

### Migration: IndexedDB `DB_VERSION` 3 → 4

`db.web.ts` adds an `INBOX_STORE = 'splitwise_inbox'` object store with
`keyPath: 'expense_id'`. Transaction objects are schemaless in IndexedDB, so
`source` and `payer_name` need no migration there — they simply start appearing
on newly written records, and absent means Plaid.

### Shape of an accepted expense

Accepting Splitwise expense `1234567` writes two rows atomically:

**`transactions`**

| Column | Value |
|---|---|
| `id` | `sw:1234567` |
| `merchant_name` | the Splitwise description |
| `amount` | the **full** expense cost |
| `currency` | expense `currency_code` |
| `date` | expense `date`, as `YYYY-MM-DD` |
| `status` | `'split'` |
| `pending` | `0` |
| `created_at` | now, ISO-8601 |
| `source` | `'splitwise'` |
| `payer_name` | display name of the participant with `paid_share > 0` |
| `vacation_id` | active vacation's id when its group matches, else `NULL` |
| `bucket` | user's pick, or `'travel'` when vacation-assigned |
| `bucket_source` | `'manual'`, or `'vacation'` when vacation-assigned |
| `plaid_category` | `NULL` |

**`split_decisions`**

| Column | Value |
|---|---|
| `id` | `generateId()` |
| `transaction_id` | `sw:1234567` |
| `splitwise_expense_id` | `1234567` |
| `friend_ids` / `friend_names` | the **other** participants, same order, from the inbox row's `participants` |
| `amount_each` | the user's own `owed_share` |
| `created_at` | now |
| `description` | `NULL` — `merchant_name` is already the title |

The `sw:` id prefix guarantees no collision with a Plaid `transaction_id`, so
`upsertTransactions`' `INSERT OR IGNORE`, `rekeyTransaction`, and
`markTransactionsReversed` can never touch an imported row.

### Why this shape needs no changes to `spend.ts`

`myShareCentsByTransaction` computes, for a `status = 'split'` row carrying a
`splitwise_expense_id`, a share equal to that expense's `amount_each` — pro-rated
only when several transactions share one expense. An imported expense is always a
single-member group, so its share is exactly `amount_each`, which is the user's
`owed_share`. `amount` (full cost) drives display; `amount_each` (user's share)
drives the tracker. That is precisely the existing contract.

`getSpendingRows()`, `getHistoryTransactions()`, `getVacationHistory()`,
`monthKeyOf()`, and `pruneOldTransactions()` all work unmodified. The queries need
only widen their `SELECT` lists to carry `source` and `payer_name` through for display.

---

## The poll

### API

New in `lib/splitwise.ts`:

```ts
export async function getExpensesUpdatedAfter(iso: string): Promise<RawExpense[]>
```

Calls `GET /get_expenses?updated_after=<iso>&limit=100&offset=<n>`, paginating
until a short page comes back. Uses the existing `swGet` helper, so a 401 raises
`SplitwiseAuthError` exactly as elsewhere.

Relevant response fields per expense: `id`, `description`, `cost`,
`currency_code`, `date`, `group_id`, `payment`, `deleted_at`, `updated_at`, and
`users[]` of `{ user: { id, first_name, last_name }, paid_share, owed_share }`.

### Watermark

`AsyncStorage` key `splitwise_expenses_watermark`, an ISO-8601 timestamp stored
alongside the existing `splitwise_user_id`. **On first run the watermark is absent:
stamp it with the current time and import nothing.** This mirrors the Plaid
first-sync behavior of draining the historical backlog without storing it, so the
user is never handed a wall of old expenses to triage.

After a successful pass, the watermark advances to the request start time. Using
request-start rather than the maximum `updated_at` seen means a concurrent write
on Splitwise's side is re-fetched rather than skipped; re-fetching is harmless
because every branch below is idempotent.

### Where it runs

At the tail of `transactionStore.refresh()`, after the Plaid sync loop and before
`get().load()`. It is wrapped so that **no Splitwise failure can fail the Plaid
refresh** — a `SplitwiseAuthError` surfaces the existing "Splitwise session
expired. Please sign in again." toast and the pull is skipped; any other error is
logged and skipped. If the user has no Splitwise token, the pull returns immediately.

### Filter and reconcile, per expense

Evaluated in this order. `mine` is the entry in `users[]` whose `user.id` matches
`authStore.user_id`; `imported` means a `transactions` row with id `sw:<expense_id>` exists.

| Condition | Action |
|---|---|
| `deleted_at` is set | Delete the imported row (and its split decision) if present; delete any inbox entry. |
| `mine` absent, or `mine.owed_share <= 0` | The user was removed from the expense: same as deleted. |
| `payment === true` | Skip — a settlement transfer, not spending. |
| `mine.paid_share > 0` | Skip. **This is what excludes every expense SplitEasy itself created**, since the app always records the user as payer. |
| `imported` | Update `amount`, `date`, `merchant_name`, `payer_name`, and `amount_each` in place. Bucket, vacation, and `bucket_source` are the user's and are left alone. |
| inbox entry has `state = 'dismissed'` | Skip — never re-offer. |
| otherwise | Upsert the inbox entry as `state = 'pending'`, refreshing its fields. |

Note the deliberate ordering: `paid_share > 0` is checked *before* the `imported`
branch, so an expense the user later becomes the payer of stops being reconciled
rather than being rewritten with a nonsensical share.

---

## Accept and dismiss

### Placement

`getNewTransactions()` is untouched, and imported rows are never `status = 'new'`,
so nothing can leak into the Plaid list. A new `splitwiseInbox: SplitwiseInboxItem[]`
slice on `transactionStore` feeds a **"From Splitwise · N"** section rendered inside
the Transactions FlatList's existing `ListHeaderComponent`, directly beneath the
"Needs review" section. The section renders nothing when the inbox is empty.

Each card shows the description, a subtitle reading `Alice paid · your share $12.50`,
the date, and the full amount on the right — matching the visual weight of the
review cards above it.

### Accept

Tapping a card opens `BucketPickerSheet`, seeded with `resolveBucket()`'s guess as
the current bucket so the sheet has something to render and the likely answer is
already highlighted. Choosing a bucket writes both rows with `bucket_source = 'manual'`,
clears the inbox entry, and toasts "Added to History".

**Vacation exception.** If an active vacation exists whose `splitwise_group_id`
equals the expense's `group_id`, accept skips the picker entirely: `vacation_id` is
set, `bucket` is `'travel'` with `bucket_source = 'vacation'`, and the toast reads
"Added to <vacation name>". This matches how vacation-assigned Plaid transactions
already behave — `resolveBucket` returns `travel`/`vacation` for anything carrying a
`vacation_id`, and `BucketPickerSheet` renders its locked variant for such rows.

### Dismiss

A trailing `×` on the card sets `state = 'dismissed'`. The tombstone persists, so
the expense is never offered again even though the poll keeps seeing it. No
confirmation dialog — the action is reversible in the sense that nothing was
created, and requiring a tap-through on every unwanted expense defeats the point.

---

## History behavior

`HistoryItem` gains `source: TransactionSource` and `payer_name: string | null`,
both carried through from the widened `getHistoryTransactions()` /
`getVacationHistory()` queries.

**Display.** An imported row replaces the `Friends · $X each` split badge with
`Alice paid · your share $12.50`. The bucket chip behaves normally, including the
vacation lock.

**Actions.** Tapping opens `HistoryActionSheet` in a read-only variant:

- **"Edit split" is not rendered.** The expense belongs to the payer; the app must
  never call `updateExpense` on it.
- The destructive action reads **"Remove from SplitEasy"**, not "Delete split".
  It deletes only the local `transactions` and `split_decisions` rows and **never
  calls `deleteExpense`**. It also writes a `dismissed` tombstone into
  `splitwise_inbox`, so the next poll doesn't immediately re-offer the expense the
  user just removed.

The confirmation dialog copy changes accordingly: "This removes it from SplitEasy
and stops it counting toward your spending. The Splitwise expense is not affected."

---

## Sign-out

`authStore.signOut` must additionally clear `splitwise_expenses_watermark` from
AsyncStorage. Without this, signing out and back in with a different Splitwise
account would resume from a stale watermark and silently skip that account's
expenses. Imported transaction rows follow whatever the existing sign-out path
does with local data.

---

## New and changed surface

| File | Change |
|---|---|
| `lib/types.ts` | `TransactionSource`, `SplitwiseInboxItem`; `source`/`payer_name` on `Transaction` and `HistoryItem` |
| `lib/splitwise.ts` | `getExpensesUpdatedAfter()`, `RawExpense` |
| `lib/splitwiseInbox.ts` *(new)* | Pure filter/reconcile decision function over a raw expense + local state → an action. Keeps the branching table above testable without a database. |
| `lib/db.ts` | Migration v7; `getSplitwiseInbox`, `upsertInboxItem`, `dismissInboxItem`, `acceptSplitwiseExpense`, `updateImportedExpense`, `deleteImportedExpense`; widened history/spending selects |
| `lib/db.web.ts` | Every one of the above, IndexedDB v4 |
| `stores/transactionStore.ts` | `splitwiseInbox` slice; `syncSplitwiseInbox()` called from `refresh()`; `acceptInboxItem`, `dismissInboxItem` |
| `stores/authStore.ts` | Clear the watermark on sign-out |
| `app/(tabs)/index.tsx` | "From Splitwise" section + accept/dismiss wiring |
| `app/(tabs)/history.tsx` | Read-only branch for imported rows |
| `components/HistoryActionSheet.tsx` | `readOnly` variant |

---

## Testing

Test-driven throughout; each behavior below gets a failing test first.

**`lib/splitwiseInbox.ts` (pure, no DB).** The decision table is the highest-value
target: deleted expense, user removed from the expense, settlement payment,
user is the payer, already-imported update, dismissed tombstone, and the plain
new-expense case. Plus the ordering guarantee that `paid_share > 0` beats `imported`.

**Watermark.** First run stamps and imports nothing. Subsequent runs pass the
stored watermark and advance it. A thrown error leaves the watermark unadvanced,
so nothing is silently skipped.

**DB (native and web).** Accept writes both rows with the correct
`amount`/`amount_each` split; dismiss writes a tombstone; remove deletes both rows,
writes a tombstone, and issues no Splitwise call; upstream update rewrites amounts
while preserving the user's bucket and vacation.

**Vacation.** An expense whose `group_id` matches the active vacation accepts
without the picker, lands with `vacation_id` set and `bucket_source = 'vacation'`.
One whose group doesn't match goes through the picker.

**Spending integration.** An accepted expense contributes exactly its `owed_share`
— not its full cost — to `aggregateMonth`, and a vacation-assigned one lands in the
vacation's month rather than the expense's.

**Parity.** `db.parity.test.ts` fails until `db.web.ts` implements every new export,
which is the existing guard against the PWA path throwing at runtime.

**Isolation.** A Splitwise 401 during `refresh()` leaves Plaid results intact and
the Plaid cursor saved.
