# Vacation Mode — Design Spec

Date: 2026-08-03

## Goal

Let a user create a "vacation" (e.g. a trip), optionally start it so that new
bank transactions land inside it instead of the normal Transactions list, add
existing transactions to it manually, and split its transactions to Splitwise
from a dedicated screen — optionally into a linked Splitwise group.

## Non-goals (YAGNI)

- Multiple concurrent active vacations.
- Editing a vacation's name/dates/group after creation (delete + recreate
  covers the rare case).
- Duplicating the History tab's edit/delete-split UI inside the vacation
  screen — already-split vacation transactions are shown read-only there;
  editing/deleting them stays a History tab action.
- Automatic conflict resolution when a dated vacation's start date would
  activate it while another vacation is already active — this is prevented
  at creation time by an overlap check, so it cannot occur at reconcile time.

## Data model

### `vacations` table (new)

| column                        | type | notes                                                |
|--------------------------------|------|-------------------------------------------------------|
| `id`                           | TEXT PK | locally generated UUID                             |
| `name`                         | TEXT |                                                        |
| `start_date`                   | TEXT NULL | ISO-8601 date, optional                          |
| `end_date`                     | TEXT NULL | ISO-8601 date, optional                          |
| `status`                       | TEXT | `'draft' \| 'active' \| 'ended'`                      |
| `splitwise_group_id`           | TEXT NULL |                                                   |
| `splitwise_group_name`         | TEXT NULL | denormalized for display                         |
| `splitwise_group_member_ids`   | TEXT NULL | JSON string array, snapshot at creation time     |
| `created_at`                   | TEXT |                                                        |
| `started_at`                   | TEXT NULL |                                                   |
| `ended_at`                     | TEXT NULL |                                                   |

### `transactions` table

Add nullable `vacation_id TEXT REFERENCES vacations(id)` (unenforced FK,
matching the existing `split_decisions.transaction_id` style — no
`PRAGMA foreign_keys` is enabled in this codebase today).

### Dual implementation requirement

This repo maintains **two** DB backends with parity: `lib/db.ts` (native,
expo-sqlite) and `lib/db.web.ts` (web, IndexedDB) — see the recent
`fix(web): implement combined-split writes missing from db.web` fix. Vacation
mode must ship in both:

- `lib/db.ts`: new `vacations` table, `ALTER TABLE transactions ADD COLUMN
  vacation_id`, migration bumps `user_version` to 4.
- `lib/db.web.ts`: new `VACATION_STORE` object store (keyPath `id`),
  `DB_VERSION` bump with an `onupgradeneeded` branch that adds it; existing
  `Transaction` records gain an optional `vacation_id` field (IndexedDB is
  schemaless per-record, so no migration of existing rows is needed —
  `vacation_id` is simply absent/undefined on old rows, treated as `null`).

Both backends expose the same function surface (see below), and both must be
covered by the same test scenarios, mirroring how `__tests__/` already tests
`db.ts` and `db.web.ts` in parallel for the existing tables.

## Status lifecycle

```
draft ──(start, manual or start_date reached)──▶ active ──(end, manual or end_date passed)──▶ ended
```

- One-directional; no re-opening an `ended` vacation.
- At most one `active` vacation at any time, enforced at two points:
  - **Creation**: if `start_date`/`end_date` are given, reject creation when
    the range overlaps any existing `draft`/`active` vacation's range (dates
    inclusive). No dates given → no overlap check needed (manual-only
    vacations don't auto-activate).
  - **Manual start**: reject starting a `draft` vacation if another vacation
    is currently `active`, with a message naming the active one.
- **Reconciliation** (`reconcileVacationStatuses()` in `lib/db.ts` /
  `lib/db.web.ts`): compares today's date against every `draft`/`active`
  vacation's `start_date`/`end_date` and flips status + stamps
  `started_at`/`ended_at` accordingly. Called:
  - once at app startup (in the tabs layout, alongside the existing
    `pruneOldTransactions()` call),
  - at the start of `transactionStore.refresh()`, so a sync always reflects
    the current vacation state before capturing transactions,
  - immediately after creating a vacation (so a vacation whose `start_date`
    is today activates right away instead of waiting for the next sync).
- Manual "Start now" / "End now" actions are always available on the detail
  screen regardless of whether the vacation has dates — dates only
  *pre-schedule* a transition, they don't remove manual control. "Start now"
  is unavailable while another vacation is active (button hidden, banner
  reason shown); "End now" is available any time the vacation is `active`.

## Transaction capture & queries

- **`getNewTransactions()`** (both backends) changes its filter from
  `status = 'new'` to `status = 'new' AND vacation_id IS NULL`. This is the
  mechanism that makes vacation transactions disappear from the main
  Transactions tab.
- **New: `getVacationPendingTransactions(vacationId)`** — `status = 'new' AND
  vacation_id = ?`, same ordering as `getNewTransactions`.
- **New: `getVacationHistory(vacationId)`** — reuses the exact grouping logic
  of `getHistoryTransactions()` (combined-split collapsing by expense id) but
  scoped to `vacation_id = ?` and `status IN ('split','skipped')`. Refactor:
  extract the shared row→`HistoryItem[]` grouping helper out of
  `getHistoryTransactions` in both backends and parametrize by the WHERE
  filter, rather than duplicating the grouping code.
- **`upsertTransactions`**: when a brand-new transaction is inserted (not an
  update to an existing "new" row — this preserves the "don't touch
  already-split rows" invariant), stamp `vacation_id` with the currently
  active vacation's id, or `NULL` if none. `transactionStore.refresh()` looks
  up the active vacation id (`getActiveVacation()`) once per refresh cycle and
  threads it through to `upsertTransactions`.
- **New: `assignTransactionsToVacation(vacationId, transactionIds)`** — bulk
  `UPDATE transactions SET vacation_id = ? WHERE id IN (...)`. Used by the
  detail screen's "Add transactions" flow. Only offers transactions that are
  currently `status = 'new' AND vacation_id IS NULL` as candidates.
- **New: `removeTransactionFromVacation(transactionId)`** — sets
  `vacation_id = NULL`. Only meaningful for `status = 'new'` rows (a
  split/skipped transaction's vacation association is permanent history, no
  "remove" affordance is shown for those rows).

## Vacation CRUD (`lib/db.ts` / `lib/db.web.ts`)

- `createVacation(input)` → validates overlap, inserts, returns the row.
- `getVacations()` → all vacations, in-progress (`draft`/`active`) first
  (there's at most one), then `ended` ones by `start_date`/`created_at` desc.
- `getVacation(id)`.
- `getActiveVacation()` → the single `active` row, or `null`.
- `startVacation(id)` / `endVacation(id)` → status + timestamp update, with
  the single-active-vacation guard on `startVacation`.
- `deleteVacation(id)` → within one transaction: unassign every transaction
  currently pointing at it (`vacation_id = NULL` for `status='new'` rows —
  already-split rows keep their `vacation_id` as history even though the
  parent vacation row is gone, matching how `HistoryItem`s already survive
  independently of live app state), then delete the vacation row.

## `stores/vacationStore.ts` (new, zustand — mirrors `transactionStore.ts`)

State: `vacations`, `activeVacation`, `isLoading`.
Actions: `load`, `reconcile`, `create`, `startVacation`, `endVacation`,
`addTransactions`, `removeTransaction`, `deleteVacation`. Each DB-mutating
action re-runs `load()` (or patches state directly, following the existing
`transactionStore` pattern of optimistic local `set()` + DB write) so the
banner and list stay current.

`transactionStore.refresh()` gains a call to
`useVacationStore.getState().reconcile()` at its start, then reads
`activeVacation` to pass into `upsertTransactions`.

## Navigation & screens

- **`components/VacationBanner.tsx`**, rendered at the top of
  `app/(tabs)/index.tsx` above the `FlatList`:
  - No vacations exist at all → "Track vacation spending separately — Create
    a vacation" CTA → `router.push('/vacation')`.
  - An in-progress (`draft`/`active`) vacation exists → card with name,
    dates (if set), status pill, pending-transaction count → tapping opens
    `router.push('/vacation/${id}')` directly (skip the list, since there's
    only one in-progress vacation to show).
  - Only `ended` vacations exist → compact "Vacations" link →
    `router.push('/vacation')`.
- **`app/vacation/index.tsx`** — list screen. In-progress vacation pinned at
  top (if any), `ended` vacations below. "+ New Vacation" → `/vacation/new`.
  Row tap → `/vacation/[id]`.
- **`app/vacation/new.tsx`** — full-screen push (matches
  `app/(auth)/bank-connect.tsx`'s pattern of a dedicated screen for a
  multi-field flow rather than a bottom sheet): name input, optional
  start/end date pickers, optional Splitwise group picker (fetches
  `getGroups()` on mount, single-select list). Save button disabled until
  name is non-empty and (if dates given) the range doesn't overlap. On
  success, navigates to the new vacation's detail screen.
- **`app/vacation/[id].tsx`** — detail screen:
  - Header: name, status pill + dates, group chip if linked, Start
    now/End now button per the lifecycle rules above.
  - **Pending section**: `TransactionRow` list from
    `getVacationPendingTransactions`, reusing the Transactions tab's
    existing long-press-to-multi-select → "Split together" bottom bar
    exactly as implemented in `app/(tabs)/index.tsx` today. A "Split all
    together" quick action pre-selects every pending row and opens the
    combine sheet directly; if the vacation's pending transactions span more
    than one currency, this button is disabled with the same explanatory
    copy the manual combine flow already uses for cross-currency selections.
    Each row also gets a "Remove from vacation" action (icon button, calls
    `removeTransactionFromVacation`).
  - **"Add transactions"** button → a sheet/screen listing unassigned
    `status='new'` transactions (multi-select) → confirm calls
    `assignTransactionsToVacation`.
  - **History section**: read-only rows from `getVacationHistory`, visually
    matching `HistoryRow` in `app/(tabs)/history.tsx` (combined-split badge,
    friend names, amount) but not pressable.
  - **Delete vacation** (destructive, confirm dialog via `lib/dialog.ts`,
    matching the existing delete-split confirmation pattern in
    `history.tsx`).

The `FriendPickerSheet` instance used on the vacation detail screen passes
`groupId={vacation.splitwise_group_id}` and
`groupMemberIds={parsed splitwise_group_member_ids}` (both `undefined` when
the vacation has no linked group); the Transactions and History tabs' usages
are unchanged (props omitted → today's behavior).

## Splitwise group integration

- **`lib/splitwise.ts`**: new `getGroups()` calling `GET /get_groups`,
  mapping the raw response to `SplitwiseGroup { id, name, member_ids,
  member_names }[]`. Used only by `app/vacation/new.tsx` — no store needed
  since the chosen group's id/name/member ids are snapshotted onto the
  vacation row at creation and never re-fetched.
- **`ExpenseParams`** (and `buildExpenseBody`) gains an optional `groupId`;
  when present, `group_id` is added to the request body for both
  `create_expense` and `update_expense`.
- **`FriendPickerSheet`** gains two optional props: `groupId?: string` and
  `groupMemberIds?: string[]`.
  - `groupId`, when present, is passed through to `createExpense`/
    `updateExpense`.
  - `groupMemberIds`, when present, changes only the *ordering* of the
    friends list (group members sorted first) — not a hard filter, so a
    non-member friend can still be added (e.g. covering someone outside the
    group on the trip). Search/select/custom-amount behavior is unchanged.

## Testing plan

- `lib/db.ts` / `lib/db.web.ts`: vacation CRUD, overlap rejection, single-
  active-vacation guard, `reconcileVacationStatuses` date transitions,
  `getNewTransactions` excluding vacation-assigned rows,
  `assignTransactionsToVacation` / `removeTransactionFromVacation`,
  `getVacationHistory` combined-split grouping parity with
  `getHistoryTransactions`, `deleteVacation` unassignment — same scenarios
  run against both backends, following the existing `__tests__/` structure.
- `stores/vacationStore.ts`: reconcile-on-load, create/start/end guards.
- `lib/splitwise.ts`: `buildExpenseBody` includes `group_id` when `groupId`
  is set; `getGroups()` response mapping.
- `FriendPickerSheet`: group-member sort ordering, `groupId` threaded into
  create/update calls, existing non-group tests unaffected by the new
  optional props.
- Manual/UI: create a dated vacation starting today → verify auto-activate;
  sync a transaction while active → verify it's captured and absent from the
  main list; end early via "End now"; add/remove a transaction manually;
  split a subset, then "Split all together" for the rest; verify group-linked
  split posts to the right Splitwise group; delete a vacation with pending
  transactions and confirm they return to the main list.
