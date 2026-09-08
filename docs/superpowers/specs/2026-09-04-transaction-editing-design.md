# Editable transactions and manual entry

Date: 2026-09-04
Status: approved, not yet implemented
Depends on: `feat/splitwise-inbox` (schema `user_version` 7, `source` column, `splitwise_inbox` table)

## Problem

Every row on the Transactions tab is a read-only mirror of an upstream system.
Plaid owns `merchant_name`, `amount`, and `date`; the Splitwise poll owns
imported rows and rewrites the payer's facts on every sync. A user cannot fix an
ugly merchant name, correct an amount, remove a row they do not want, or record
spending that never passed through a linked account — cash, or a card the app
does not know about.

This design makes rows on the Transactions tab editable and removable, and adds
manual entry, without giving up the guarantee that a sync can be run at any time
without destroying user intent.

## Decisions

Settled during brainstorming; recorded here because the reasoning is not
recoverable from the code.

1. **Editable fields**: merchant name, amount, date, and bucket. Currency is
   not editable.
2. **No writeback to Splitwise.** Editing an imported expense changes only the
   local copy. The expense belongs to whoever paid for it.
3. **Per-field conflict resolution.** When upstream later changes a field the
   user has edited, the user's value wins — but only for fields they actually
   touched. An untouched field still takes the upstream value.
4. **Delete is soft.** The record survives, excluded from the Transactions tab,
   History's default view, and all spending totals. It is restorable.
5. **Excluded rows are recoverable from History**, behind a filter.
6. **Manual transactions are always paid by the user** and land as ordinary
   `new` rows that reuse the existing split flow unchanged.
7. **Entry point is tapping the row**, which opens a detail sheet.

## Scope

In scope: the main list rows (Plaid and manual, `status='new'`) and the
Splitwise inbox rows on the Transactions tab.

Out of scope, deliberately:

- Any write to the Splitwise API.
- Edit or delete on `split` rows, in History or anywhere else. Those have a live
  Splitwise expense and their own purpose-built flows.
- The "Needs review" section, which has dedicated edit and reverse flows.
- Editing currency.
- Restoring a dismissed inbox item from the Excluded filter. See "Known
  asymmetry" below.

## Data model

### Migrations

SQLite `user_version` 7 → 8; IndexedDB `DB_VERSION` 4 → 5.

- `transactions` gains `edited_fields TEXT`.
- `splitwise_inbox` gains `edited_fields TEXT`.

`edited_fields` holds a JSON array of locked field names — `["merchant_name",
"amount"]`. `NULL` or absent means nothing was edited. It is parsed at the DB
boundary, exactly as `split_decisions.friend_ids` and
`splitwise_inbox.participants` already are.

**Bucket is never listed in `edited_fields`.** No sync path writes it —
`upsertTransactions` does not touch the column, and `updateImportedExpense`
documents that bucket, `bucket_source`, and `vacation_id` are the user's and
are left strictly alone. User intent for bucket is already tracked by the
existing `bucket_source='manual'` value. Adding a second mechanism for the same
fact would be redundant and would create two places to disagree.

Both `ALTER`s must run ungated rather than behind a `version >= 1` guard,
because neither column appears in the base `version < 1` `CREATE TABLE`. A
fresh install starts at version 0 and must still receive them. This trap is
documented three times in `db.ts`'s existing migration blocks; it applies here
identically.

### Type changes (`lib/types.ts`)

- `TransactionStatus` gains `'excluded'`.
- `TransactionSource` gains `'manual'`.
- `Transaction` and `SplitwiseInboxItem` gain `edited_fields?: string[] | null`.

### Why `'excluded'` is a status, not a separate column

Every `status` comparison in the app is a positive test — `status = 'new'`,
`status IN ('split','skipped')`, `r.status === 'split'`. A new status value is
therefore filtered out of the Transactions tab, History, `getSpendingRows`, and
the vacation views without editing any of those queries.

It also removes the need for a delete tombstone. `upsertTransactions` uses
`INSERT OR IGNORE` followed by `UPDATE ... WHERE id = ? AND status = 'new'`
(`db.ts:436-446`). An excluded row is neither re-inserted nor re-updated, so
Plaid cannot resurrect it. Permanent deletion would have required a tombstone
table to get the same property.

Two places enumerate `'new'`/`'skipped'` explicitly and must be given a
deliberate `'excluded'` decision rather than inheriting one by accident:

- `rekeyTransaction`'s occupant branch (`db.ts:606`), which deletes a
  non-`split` occupant of a posted id.
- `markTransactionsReversed`'s `keepIds` filter (`db.ts:644`).

In both cases the correct behavior is to treat `'excluded'` like `'skipped'` —
there is no Splitwise expense attached, so the row is safe to drop.

### Manual rows

Id `mn:<uuid>` via the existing `generateId` convention, mirroring the
`sw:<expenseId>` prefix used for imported expenses. `source='manual'`,
`status='new'`, `pending=0`, `plaid_category=NULL`, `created_at=now`.

`deleteAllTransactions()` currently clears rows matching `source IS NULL OR
source <> 'splitwise'` (`db.ts:775`). A manual row matches that predicate and
would be destroyed when the user disconnects their last bank. The predicate
changes to an explicit allowlist:

```sql
source IS NULL OR source = 'plaid'
```

This is correct for manual rows now and fails safe for any source added later.

## Sync semantics

### One pure helper, four call sites

`lib/editLocks.ts` exports a pure function — given the row as stored, the values
upstream wants to write, and the lock list, it returns the values to actually
write. No DB dependency.

This matters because `db.ts` (SQLite, native) and `db.web.ts` (IndexedDB, web)
are separate implementations that must stay in parity. Both call the same
helper rather than each re-deriving the rule.

The four paths that write user-visible fields and must route through it:

| Path | Owns | Current behavior |
|---|---|---|
| `upsertTransactions` | Plaid adds and modifies | `UPDATE ... WHERE id = ? AND status = 'new'` (`db.ts:442`) |
| `rekeyTransaction` | pending → posted transition | unconditional `UPDATE` (`db.ts:621`) |
| `upsertInboxItem` | poll refresh of an unaccepted expense | `ON CONFLICT DO UPDATE SET` (`db.ts:983`) |
| `updateImportedExpense` | payer edits an accepted expense | unconditional `UPDATE` (`db.ts:1079`) |

`rekeyTransaction` is easy to miss: it overwrites `merchant_name`, `amount`, and
`date` while moving a row onto its posted Plaid id.

The `SET` list is built in JavaScript, not SQL. A `CASE WHEN instr(edited_fields,
...)` expression would work but depends on string-matching a JSON blob, and
`db.web.ts` is JavaScript regardless — doing it the same way on both sides keeps
the two backends readable against each other.

### Edits cannot collide with the review queue

Every review flag is gated on `status === 'split'` (`db.ts:617`, `db.ts:644`).
Edits exist only on `new` rows and inbox rows. A locked field can therefore never
sit on a row the review machinery inspects.

This is a structural property of the scope boundary, not a check anyone has to
remember to write, and it is the main reason the feature stays small.

### Inbox-to-transaction handoff

An inbox row edited before acceptance holds its locks in
`splitwise_inbox.edited_fields`. `acceptSplitwiseExpense` copies both the edited
values and the lock list onto the new transaction row, so a later upstream edit
arriving through `updateImportedExpense` respects the same locks.

One mechanism, two tables, no special case at the boundary.

## Operations

Added to both `db.ts` and `db.web.ts`:

- `updateTransactionFields(id, patch)` — writes changed columns, unions the
  patched keys into `edited_fields`. Only affects rows with `status='new'`.
- `updateInboxItemFields(expenseId, patch)` — the same, against
  `splitwise_inbox`.
- `excludeTransaction(id)` / `restoreTransaction(id)` — flip `status` between
  `'new'` and `'excluded'`.
- `getExcludedTransactions()` — powers the History filter.
- `createManualTransaction(input)` — inserts the `mn:<uuid>` row.

`transactionStore` gains matching actions — `editTransaction`,
`excludeTransaction`, `restoreTransaction`, `addManualTransaction`,
`editInboxItem` — each following the store's existing pattern of an optimistic
list filter followed by `load()`.

## UI

### `TransactionDetailSheet`

One new component with three modes, so the add form and the edit form are the
same code:

- `create` — blank fields, for a manual transaction
- `edit` — a `new` Plaid or manual row
- `inbox` — an unaccepted Splitwise expense

Fields in `create` and `edit` mode: merchant, amount, date, bucket.

`inbox` mode shows **two** amount fields, because an inbox row already displays
two distinct numbers — the full expense cost and the user's share of it
(`"{payer} paid · your share ${my_share}"`). Editing one without the other would
silently desync them, so both `cost` and `my_share` are editable, alongside
description, date, and bucket. `my_share` is the figure that reaches the
spending tracker, via `split_decisions.amount_each`.

Primary action is Save (or Add, or Accept); secondary destructive action is
Delete (or Dismiss in `inbox` mode).

Two repo-specific build constraints, both from problems already encountered
here:

- `@gorhom` `BottomSheetView` breaks flex layout and pushes the CTA off-screen.
  The primary action goes in `footerComponent`, not at the end of the scroll
  body.
- Text inputs must be `BottomSheetTextInput`, or the keyboard fights the sheet.

### Entry points

`TransactionRow`'s card gains `onPress`. It currently has only `onLongPress`
(`TransactionRow.tsx:100`), so the gesture is free and no existing interaction
moves.

Add is a `+` in the tab header beside the count badge, not a floating button:
`styles.selectBar` is absolutely positioned at `bottom: 0`, and a FAB would sit
underneath it in select mode.

### Inbox rows keep their tap cost

Tapping an inbox row today accepts it and opens `BucketPickerSheet` — two taps
to a bucketed accept. Routing tap through a detail sheet would make it three.

Instead the detail sheet carries the bucket field itself, pre-filled with the
same `resolveBucket` guess the picker uses now. Tap the row, adjust anything,
hit Accept: still two taps, with editing available for free. The row's `×` stays
for fast dismiss.

This also removes a duplicated predicate. `openInboxAccept` in
`app/(tabs)/index.tsx` carries a comment warning that its vacation group-match
condition must stay byte-for-byte identical to `acceptInboxItem`'s in
`transactionStore.ts`, because one decides which sheet to show and the other
decides the bucket. With the bucket living in the sheet, the field renders as a
locked `BucketChip` — `BucketChip` already supports `locked` — and the store
regains sole ownership of the decision.

### History filter

History has no filter UI today. A chip row above the list offers All /
Excluded. Excluded rows reuse `HistoryActionSheet` with a new mode offering
Restore, alongside its existing default and `readOnly` modes.

### Known asymmetry

Deleting a Splitwise inbox row remains the existing Dismiss, which sets
`splitwise_inbox.state='dismissed'`. An unaccepted inbox item is not a
transaction, so it cannot appear in a transactions-backed Excluded filter.
Dismissed inbox items are therefore not restorable from that filter; they are
recoverable only in the sense that the payer's expense still exists upstream.

This is named rather than solved. A second recovery surface for a rare action
is not worth its cost.

## Testing

TDD throughout, following the existing suite's layout.

- `lib/editLocks.ts` gets unit tests as a pure function: every lock
  combination, plus empty and absent lock lists.
- Each of the four sync paths gets a test proving a locked field survives an
  upstream write **and** that an unlocked field on the same row still updates.
  The second half is what catches a lock that is too broad.
- Every new operation gets a case in **both** `db.test.ts` and
  `db.web.test.ts`. Note what these can actually prove, because the two suites
  are not equivalent: `db.test.ts` automocks `expo-sqlite` and asserts on the
  SQL strings and parameters handed to a stub, so it verifies the statement
  built, not the resulting row. `db.web.test.ts` runs against `fake-indexeddb`
  and verifies real stored state. `db.parity.test.ts` only checks that
  `db.web.ts` exports every name `db.ts` does — it is a surface check, not a
  behavioral one.
- This asymmetry is the reason the lock rule lives in a pure helper. It is the
  one place the behavior can be tested directly and trusted for both backends;
  the native suite then verifies only that `db.ts` feeds the helper's output
  into its `SET` clause.
- A regression test that `deleteAllTransactions()` leaves `source='manual'`
  rows alone.
- Explicit `'excluded'` cases for the two status enumerations at `db.ts:606`
  and `db.ts:644`.

## Risks

1. **Data loss through `deleteAllTransactions`.** A manual row is the user's
   only copy — there is no upstream to re-sync it from. This is the same class
   of bug as the recently fixed Splitwise scoping issue, and the most expensive
   thing that can go wrong here. Covered by the predicate change and a
   regression test.
2. **Silent divergence between `db.ts` and `db.web.ts`.** The standing hazard in
   this codebase, and larger than it first appears: the native suite mocks
   SQLite and can only assert on generated SQL, so a native behavioral bug that
   produces well-formed statements is invisible to it. Mitigated by putting the
   rule in a pure, directly-tested helper and by mirroring every case into
   `db.web.test.ts`, where it runs against real storage.
3. **The migration.** Two backends, `user_version` 7 → 8 and `DB_VERSION`
   4 → 5, with the ungated-`ALTER` requirement described above.
