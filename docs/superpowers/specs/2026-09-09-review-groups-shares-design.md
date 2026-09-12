# Review Actions, Vacation Groups, and Shares Splitting — Design

**Date:** 2026-09-09
**Status:** Approved

Five independent user-facing changes, shipped as five pull requests. They share
no state; the only ordering constraint is that PR 4 consumes a store PR 2
introduces.

| PR | Change | Depends on |
|---|---|---|
| 1 | Accept / Reject / Edit actions on "Needs review" rows | — |
| 2 | Link a Splitwise group to a vacation after it was created | — |
| 3 | Edit an already-split or skipped transaction from the vacation page | — |
| 4 | Browse and pick Splitwise groups inside the friend picker | PR 2 |
| 5 | A "Shares" split mode (weights, not dollars) | — |

## Global Constraints

These are pre-existing rules of this codebase, restated because every PR below
touches code they govern.

- **Dual database, always in lockstep.** Every function added to
  `mobile/lib/db.ts` must also be added to `mobile/lib/db.web.ts`.
  `mobile/__tests__/lib/db.parity.test.ts` fails otherwise, and the PWA would
  throw at runtime the first time the feature is used.
- **Money.** Dollars as `REAL` in the database. Cent arithmetic happens in
  integer cents and converts back at the boundary. Never pre-multiply.
- **Dates.** Calendar dates are `YYYY-MM-DD` in device-local time via
  `@/lib/date`. `created_at` / `started_at` / `ended_at` stay UTC ISO strings.
- **Splitwise ids are numbers in JSON, strings everywhere in this codebase.**
  `String(...)` them at the boundary.
- **Plan documents are not committed.** Specs are. Every `git add` names files
  explicitly — never `git add -A`, never `git add docs/superpowers/plans/`.
- **Test command:** `cd mobile && npx jest <path> -t '<name>'`. Full suite:
  `cd mobile && npm test`. Types: `cd mobile && npx tsc --noEmit`.

---

## PR 1 — Accept / Reject / Edit on "Needs review"

### Problem

A row in the "Needs review" queue is a split transaction whose pending→posted
transition needs attention: either it posted at a different amount
(`review_reason = 'amount_changed'`) or the pending charge was reversed and
never posted (`'reversed'`). Tapping one today jumps straight to a single
outcome — the full split editor for the first, a destructive confirm dialog for
the second. There is no way to say "yes, push that new amount" without
re-deciding the whole split, and no way to say "no, leave it alone" without
leaving the row in the queue forever.

The Splitwise inbox section directly below it already models the right
interaction: a row offers a small set of explicit actions. This brings the
review queue in line.

### Behavior

Tapping a review row opens a new `ReviewActionSheet` offering three actions.

| | `amount_changed` | `reversed` |
|---|---|---|
| Accept | **Update Splitwise to $47.85** | **Delete expense** (destructive) |
| Edit | **Edit split** | **Edit split** |
| Reject | **Keep $42.10** | **Keep the split** |

All three clear the row from the queue.

**Accept, `amount_changed`.** Push the posted amount to the existing Splitwise
expense, preserving the split's shape:

1. Read the current per-participant owed shares with `getExpense(expenseId)`.
2. Scale each friend's share by `newAmount / oldAmount`, in integer cents.
3. Send through `updateExpense` with those `friendShares`. `buildExpenseBody`
   derives the owner's share as `amount - sum(friendShares)`, so the owner
   absorbs the rounding remainder exactly as everywhere else.
4. `clearReview(transaction_ids)`.

Scaling preserves both shapes: an equal split stays equal at the new total, and
a custom split keeps its proportions. If `getExpense` fails or the old amount is
zero, fall back to an equal split of the new amount among the same friends —
the user can still correct it via Edit.

**Accept, `reversed`.** Unchanged from today: delete the Splitwise expense
(`deleteSplit` / `deleteCombinedSplit`), delete the local rows
(`deleteTransactionsByPlaidIds`), reload.

**Edit.** Unchanged from today: opens `FriendPickerSheet` in `'edit'` mode via
the existing `openReviewEdit`, which already resolves the review on success.

**Reject, `amount_changed`.** Restore the local transaction's previous amount so
it matches the untouched Splitwise expense again, and clear the review. This
needs one more thing to actually stick: without it the next Plaid `modified`
sync writes the posted amount straight back and the row returns to the queue.
So the revert also adds `amount` to the row's `edited_fields`, which is exactly
what `applyLocks` (`mobile/lib/editLocks.ts`) exists to honour — every upstream
write path already strips locked fields.

**Reject, `reversed`.** There is no amount to revert. Keep the Splitwise expense
and the local rows as they are, and clear the review.

### Data model

No migration. `revertReviewedAmount` reuses columns that already exist
(`amount`, `amount_changed_from`, `review_reason`, `edited_fields`).

`ReviewItem` gains a nullable expense id:

```ts
export interface ReviewItem {
  // ...unchanged fields...
  /**
   * Splitwise's id for the expense, or null while the split's create is still
   * queued (see pending_splitwise_ops). Was previously coerced to the
   * transaction id, which made a queued split indistinguishable from a pushed
   * one at the call site.
   */
  splitwise_expense_id: string | null;
  expense_id: string;   // grouping key only: splitwise_expense_id ?? transaction id
}
```

`expense_id` keeps its current meaning — a stable grouping key for collapsing a
combined split's members into one row — and stays non-null.
`splitwise_expense_id` is the network identity, and is the only one any
Splitwise call may use.

This closes a latent bug. `groupReviewRows` currently sets
`expense_id: r.splitwise_expense_id ?? r.id`, so for a split whose create is
still queued, the reversed path calls `deleteExpense(<plaid transaction id>)` —
a live request against an id Splitwise has never seen. With the two fields
separated, both Accept paths check `splitwise_expense_id` first and, when it is
null, refuse with the toast *"That split hasn't reached Splitwise yet. Try again
in a moment."* Reject needs no such guard: it touches nothing upstream.

### Components

**`mobile/lib/db.ts` + `mobile/lib/db.web.ts`** — new:

```ts
/**
 * Undo an amount_changed review by restoring the pre-posting amount.
 *
 * Locks `amount` against upstream writes, or the next Plaid sync would put the
 * posted amount back and re-raise the review. Guarded on
 * review_reason = 'amount_changed' so it can never fire on a reversed row,
 * whose amount_changed_from is NULL.
 */
export async function revertReviewedAmount(transactionIds: string[]): Promise<void>
```

Per id: read `amount_changed_from` and `edited_fields`; skip the row if
`amount_changed_from` is null or `review_reason !== 'amount_changed'`; else set
`amount = amount_changed_from`, `review_reason = NULL`,
`amount_changed_from = NULL`, `edited_fields = addLocks(edited_fields, ['amount'])`.

**`mobile/stores/transactionStore.ts`** — new actions:

```ts
acceptReview: (item: ReviewItem) => Promise<void>;
rejectReview: (item: ReviewItem) => Promise<void>;
```

`acceptReview` branches on `item.reason`. `rejectReview` calls
`revertReviewedAmount` for `amount_changed` and `clearReview` for `reversed`,
then `loadReview()` + `load()`.

**`mobile/components/ReviewActionSheet.tsx`** — new, modelled directly on
`HistoryActionSheet`: a `BottomSheetModal` with a fixed snap point, an avatar +
summary header, and three `Pressable` action rows. Labels come from `item.reason`
and the amounts, so the sheet is a pure function of its props.

**`mobile/app/(tabs)/index.tsx`** — `ReviewRow`'s `onPress` opens the new sheet
instead of branching into `openReviewEdit` / `openReviewReversed` directly. Both
of those stay, now invoked from the sheet's Edit and Accept actions.

### Testing

- `__tests__/lib/db.test.ts` + `db.web.test.ts`: `revertReviewedAmount` restores
  the amount, clears both review columns, adds the `amount` lock, and no-ops on
  a reversed row and on a row with no `amount_changed_from`.
- `__tests__/lib/db.parity.test.ts` passes unchanged (it enumerates exports).
- `__tests__/stores/transactionStore.test.ts`: proportional scaling for a custom
  split; equal stays equal; `getExpense` failure falls back to equal; both
  Accept paths refuse when `splitwise_expense_id` is null.
- `__tests__/components/ReviewActionSheet.test.tsx`: label sets per reason;
  each action fires the right callback.
- `__tests__/app/index.test.tsx`: tapping a review row presents the sheet.

---

## PR 2 — Link a Splitwise group to a vacation later

### Problem

A vacation's Splitwise group can only be chosen on the create screen. A trip
created before the group existed — or created in a hurry — can never be linked,
and the group is what makes the friend picker default to the right people and
file expenses under the trip in Splitwise.

### Behavior

On the vacation detail page the group chip in the meta row becomes tappable,
reading **"Add Splitwise group"** when none is linked. It opens a
`GroupPickerSheet` listing the user's groups plus a "None" row that unlinks.

Editable while `status !== 'ended'` — the same rule `canEditDates` already
applies, and for the same reason: an ended trip's splits are history, and a
group that only affects future splits can no longer do anything for it. An ended
trip still displays its group, just not as a button.

**Linking is going-forward-only.** Expenses already created under the trip stay
where they are in Splitwise; the sheet says so in one line beneath the list.
Moving them would mean an `update_expense` per split, each able to fail
independently, which needs the pending-op queue and is out of scope here.

### Components

**`mobile/stores/groupStore.ts`** — new, a direct structural mirror of
`friendStore`: cache-first (`getCachedGroups` → render → `getGroups` →
`replaceCachedGroups`), `isStale` on refresh failure, `SplitwiseAuthError`
reported to `authStore`, no "already loaded" guard. Every one of those helpers
already exists; this only moves the orchestration into a store so three call
sites stop duplicating it.

**`mobile/app/vacation/new.tsx`** — drops its inline cache-first `useEffect`
(currently ~25 lines) and reads `groupStore`. No behavior change.

**`mobile/lib/db.ts` + `mobile/lib/db.web.ts`** — new:

```ts
/** Link or unlink a vacation's Splitwise group. Pass null to unlink. */
export async function updateVacationGroup(
  id: string,
  group: SplitwiseGroup | null
): Promise<void>
```

Writes `splitwise_group_id`, `splitwise_group_name`, and
`splitwise_group_member_ids` together — the three are one fact and must never
drift apart. Member ids serialize as JSON, matching `createVacation`.

**`mobile/stores/vacationStore.ts`** — `updateGroup(id, group)` calling the
above then `load()`. Plain `load()`, not `reconcile()`: unlike dates, a group
cannot change a vacation's status.

**`mobile/components/GroupPickerSheet.tsx`** — new. A `BottomSheetModal` with a
`BottomSheetFlatList` of groups, a "None" row, a checkmark on the current
selection, and the going-forward-only note. Takes `groups`, `selectedGroupId`,
`onSelect`, `openToken`.

**`mobile/app/vacation/[id].tsx`** — the group chip becomes a `Pressable`
guarded by `canEditGroup`; add the sheet and its deferred-present branch to the
existing `pendingPresent` state machine.

### Testing

- `__tests__/stores/groupStore.test.ts`: cache renders first; refresh replaces;
  failure keeps cache and sets `isStale`; a 401 reports to `authStore`.
- `__tests__/lib/db.test.ts` + `db.web.test.ts`: `updateVacationGroup` writes all
  three columns; null clears all three; member ids round-trip as an array.
- `__tests__/components/GroupPickerSheet.test.tsx`: renders groups + None, marks
  the selection, fires `onSelect`.
- `__tests__/app/vacation-detail.splitwise.test.tsx`: chip reads "Add Splitwise
  group" when unlinked, opens the sheet, persists a pick; not a button when
  ended.
- `__tests__/app/vacation-new.test.tsx`: still passes against the store.

---

## PR 3 — Edit an already-split or skipped transaction from the vacation page

### Problem

The vacation page's "Already split" recap rows are inert `View`s. The same
transactions are fully editable from the History tab, so the user has to leave
the trip they are looking at, find the row again in a global list, and act
there.

### Behavior

Recap rows become pressable and behave **exactly** as their History
counterparts:

- a split row (single or combined) opens the action sheet offering Edit split /
  Delete split;
- a skipped row opens `FriendPickerSheet` in `'create'` mode;
- a row imported from Splitwise (`source === 'splitwise'`) gets the read-only
  variant, whose only action is "Remove from SplitEasy".

After any of these the vacation page refreshes both its lists.

### Components

History's implementation of this is ~120 lines of sheet plumbing — two refs, an
open-token, a deferred-present effect, and three handlers. Copying it into
`vacation/[id].tsx` would leave two divergent copies of logic whose subtleties
(present-from-an-effect, combined-split loading, the read-only branch) are
exactly the kind that rot when duplicated. So it is extracted first.

**`mobile/hooks/useSplitEditor.ts`** — new. Takes `{ onChange }` (the caller's
list-refresh callback) and owns:

- `selected: HistoryItem | null`, `editDecision`, `combineTxs`, `pickerMode`,
  `pickerToken`, and the `pending: null | 'picker' | 'action'` present latch;
- `pickerRef` / `actionRef` and the effect that presents from a committed
  render;
- `openFor(item)` — the `handleRowPress` branch (skipped → picker, imported or
  split → action sheet);
- `handleEdit`, `handleDelete`, `handlePickerSuccess`;
- returns `pickerProps` and `actionProps` to spread onto the two sheets.

Modelled on `useBucketEditor`, which already establishes this pattern
(`sheetRef` + `sheetProps` + an `open()`), including its "the host owns list
state, so tell the hook how to refresh it" callback.

**`mobile/app/(tabs)/history.tsx`** — refactored onto the hook. Its
excluded-filter and Restore behavior are preserved by passing `mode` through to
`HistoryActionSheet`; the filter state itself stays in the screen, since it is
about which list to load, not about editing.

**`mobile/app/vacation/[id].tsx`** — `HistoryRecapRow` becomes a `Pressable`
wired to `openFor`; mount `FriendPickerSheet` and `HistoryActionSheet` from the
hook's props. The vacation's existing `FriendPickerSheet` (the one used for
splitting pending transactions, with `groupId`) stays separate — it serves a
different flow and carries the trip's group.

### Testing

- `__tests__/hooks/useSplitEditor.test.tsx`: routes each row kind to the right
  sheet; combined-split edit loads members and the shared decision; a failed
  decision load surfaces the error and opens nothing.
- `__tests__/app/history.splitwise.test.tsx` and the rest of the History suite
  pass unchanged — this is the regression gate on the refactor.
- `__tests__/app/vacation-detail.splitwise.test.tsx`: a split recap row opens
  the action sheet; a skipped one opens the picker; an imported one is
  read-only; the list refreshes after a delete.

---

## PR 4 — Groups in the friend picker

### Problem

The picker only lists individual friends. Splitting with a group means finding
and ticking each member by hand, and the resulting expense is filed outside the
group in Splitwise, where the group's members expect to see it.

### Behavior

In `'equal'` mode a **Friends | Groups** toggle sits above the search box. The
Groups tab lists the user's groups, filtered by the same search query.

Picking a group:

- selects every member of that group that appears in the user's friends list;
- records the group, so `group_id` is sent with the expense and it lands inside
  the group in Splitwise;
- shows a removable chip ("Roommates ×") above the list;
- returns to the Friends tab, where the per-person shares are visible.

Members can then be deselected individually — Splitwise permits a group expense
that involves a subset of the group. Clearing the chip drops `group_id` and
leaves the selection alone.

A vacation's linked group remains the default: the effective group is
`pickedGroupId ?? props.groupId`.

**Edit mode** seeds the chip from the expense's existing group, which requires
one fix described next.

### A correctness fix this depends on

`getExpense` returns only owed shares. `handleAddToSplitwise`'s edit path then
rebuilds the whole expense body from the picker's state and PUTs it — so today,
**editing a group expense from anywhere without a `groupId` prop silently strips
its `group_id`**, moving it out of the group in Splitwise. It is invisible in the
app and only shows up in Splitwise.

So `getExpense` changes shape:

```ts
export async function getExpense(
  expenseId: string
): Promise<{ shares: Record<string, number>; groupId: string | null }>
```

Splitwise reports `group_id: 0` for a non-group expense; normalize that to
`null`. Both existing call sites in `FriendPickerSheet` update to read `.shares`,
and the edit-mode prefill seeds the group chip from `.groupId`.

### Components

**`mobile/lib/splitwise.ts`** — `getExpense` returns the object above.

**`mobile/components/FriendPickerSheet.tsx`**:

- new state `friendTab: 'friends' | 'groups'` and `pickedGroup: SplitwiseGroup | null`,
  both reset by the existing render-phase `openToken` reset;
- the toggle, the chip, and a `GroupRow` list item;
- `filtered` gains a group-filtered sibling for the Groups tab;
- the `data` array and `renderItem` branch on `friendTab` while in `'equal'` mode;
- `groupId` at both `buildExpenseBody` call sites becomes `pickedGroup?.id ?? groupId`.

**`mobile/stores/groupStore.ts`** (from PR 2) — loaded alongside friends. The
picker renders whatever the cache holds if the network is down, matching how
friends already behave.

### Testing

- `__tests__/lib/splitwise.test.ts`: `getExpense` returns shares and groupId;
  `group_id: 0` normalizes to null.
- `__tests__/components/FriendPickerSheet.test.tsx`: the toggle switches lists;
  picking a group selects its members, shows the chip, and returns to Friends;
  the created expense carries `group_id`; clearing the chip drops it while
  keeping the selection; a picked group overrides the vacation's group; edit
  mode seeds the chip from the loaded expense and a no-op save preserves
  `group_id` (the regression test for the fix above).

---

## PR 5 — A "Shares" split mode

### Problem

Equal and Custom cover "everyone the same" and "exact dollars each". Neither
expresses proportional intent — three people splitting a $100 bill 4 : 1 : 5
have to compute $40 / $10 / $50 by hand, and redo it whenever the total changes.

### Behavior

A fourth mode, **Shares**, in the segmented control:
`Equal · Custom · Shares · Receipt` (three when Receipt is hidden, which it
already is for combined splits — a receipt is one physical purchase).

Each participant — the owner included — gets a share count, stepped with the
same `− / +` control Custom uses, defaulting to 1. The row shows the count and
the money it works out to: `4 shares · $40.00`. The owner's card becomes an
editable stepper rather than the read-only derived card Custom shows, because
the owner is a participant with a weight like anyone else.

Switching into Shares seeds every count to 1, so the mode opens as an equal
split and is adjusted from there.

### The math

Weighted apportionment of the total across share counts, in integer cents. This
is precisely what `distribute(totalCents, weights)` in `mobile/lib/receipt.ts`
already does — largest-remainder allocation, leftover cents handed to the
largest fractional remainders with ties broken toward index 0, guaranteed to sum
to exactly `totalCents`. It is already unit-tested. It is currently private, so
it becomes exported, and:

**`mobile/lib/shares.ts`** — new, pure:

```ts
export interface ShareSplitInput {
  totalCents: number;
  ownerId: string;
  friendIds: string[];            // stable order, as receipt.ts takes it
  counts: Record<string, number>; // participant id → share count; missing = 1
}

/** Cents per participant id. Sums to exactly totalCents. */
export function computeShareSplit(input: ShareSplitInput): Record<string, number>
```

The owner sits at index 0 of the weight vector, so it wins rounding ties — the
same floor-remainder-to-owner convention `buildExpenseBody` uses. A share count
of 0 is allowed and means that person owes nothing; if every count is 0,
`distribute` returns all zeros and the CTA is disabled with the existing
`title/selection` guards plus a "Give someone at least one share" hint.

On submit the counts convert to dollars and flow into the **existing**
`friendShares` path. `buildExpenseBody` then derives the owner's share as
`amount - sum(friendShares)`, which equals the owner's distributed cents
exactly. Nothing changes in `splitwise.ts`, the pending-op queue, or the
database — on the wire a shares split is indistinguishable from a custom one.

### Persistence

Share counts are **not** stored. Only the resulting dollar amounts are, in
`split_decisions.amount_each` and the Splitwise expense itself. Re-opening a
shares split therefore shows Custom mode with the same dollar amounts —
mathematically identical, and the same tradeoff Receipt mode already accepts
(it does not reload its items either). Persisting counts would need a
`split_decisions` column in both backends and a migration, for a display-only
gain.

`FriendPickerSheet`'s existing equal-vs-custom detection is unchanged: a shares
split whose friend shares happen to be equal reads back as equal, exactly as an
equal-by-coincidence custom split already does today.

### Components

**`mobile/lib/receipt.ts`** — export `distribute` (add a doc note that
`lib/shares.ts` shares it). No behavior change.

**`mobile/lib/shares.ts`** — new, as above.

**`mobile/components/FriendPickerSheet.tsx`**:

- `SplitMode` gains `'shares'`; new state `shareCounts: Record<string, number>`,
  reset with the other per-open state;
- `switchToShares()` seeds every selected friend and the owner to 1;
- a fourth segment; `segText` drops to `fontSize: 13` so four labels fit at
  375pt;
- `friendTotalCents` gains a `'shares'` branch reading `computeShareSplit`;
- the owner card renders a stepper in shares mode;
- `renderItem` renders a `ShareRow` for `'shares'` — `CustomRow`'s layout with
  an integer stepper and a derived-dollars subtitle;
- `handleAddToSplitwise`'s `shares` object gains a `'shares'` branch producing
  `friendShares` in dollars.

### Testing

- `__tests__/lib/shares.test.ts`: 4/1/5 of $100 → 40/10/50; all-equal counts
  match an equal split; parts always sum to the total across a range of awkward
  totals; a zero count yields zero; all-zero counts yield all zeros; the owner
  wins rounding ties.
- `__tests__/lib/receipt.test.ts`: unchanged, guarding the `distribute` export.
- `__tests__/components/FriendPickerSheet.test.tsx`: the segment appears (and
  Receipt still hides for combined splits); switching seeds 1s; stepping updates
  the derived dollars; the submitted `friendShares` match the computed split;
  the owner's share is the remainder; the CTA blocks when every count is 0.
