# Monthly Spending Tracker — Design

**Date:** 2026-08-19
**Status:** Approved

## Problem

SplitEasy knows every transaction and every split, but never answers "where did my
money go last month?". The data is all there — it just isn't categorized, isn't
reduced to the user's own share, and isn't aggregated by month.

## Goals

- Bucket every committed transaction into one of six spending categories.
- Count only the user's share: full amount when skipped, owed share when split.
- Aggregate per month, viewable as a pie chart with a drill-down.
- Guess the bucket as soon as a transaction lands; commit it on skip/split.
- Let the user re-tag from the tile, before or after the transaction is committed.
- Attribute vacation spend to the vacation's month, not the transaction's month.

## Non-goals

- Backfilling existing history. The tracker starts from the day this ships.
- Budgets, targets, or alerts.
- Currency conversion. There is no FX rate source in the app.
- Server-side or cross-device aggregation. This stays local-first.

---

## Taxonomy

Six leaf buckets under four display groups.

```ts
// mobile/lib/buckets.ts
export type Bucket =
  | 'travel' | 'needs' | 'food' | 'shopping' | 'experiences' | 'misc';

export type BucketGroup = 'travel' | 'needs' | 'wants' | 'misc';
```

| Group | Buckets | Covers |
|---|---|---|
| Travel | `travel` | Anything belonging to a vacation |
| Needs | `needs` | Groceries, rent, bills, finance payments, auto insurance, gas |
| Wants | `food` | Restaurants, eating out, delivery, drinks |
| | `shopping` | Clothes, devices, motorcycle parts |
| | `experiences` | Movies, games, amusement parks, museums, events |
| Misc | `misc` | Anything unclassified |

`misc` sits at the **top level**, not under Wants. Unclassified spend must not
silently inflate the Wants number and distort the needs-vs-wants ratio; keeping
it separate also makes it a visible re-tagging queue.

---

## Data model

### Migration v6

```sql
ALTER TABLE transactions ADD COLUMN bucket TEXT;          -- NULL until committed
ALTER TABLE transactions ADD COLUMN bucket_source TEXT;   -- 'auto' | 'manual' | 'vacation'
ALTER TABLE transactions ADD COLUMN plaid_category TEXT;  -- personal_finance_category.detailed

CREATE TABLE IF NOT EXISTS merchant_buckets (
  merchant_key TEXT PRIMARY KEY,  -- normalized merchant name
  bucket       TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

PRAGMA user_version = 6;
```

These three `ALTER`s must run **ungated** — not behind `version >= 1 && ...` —
because they are not present in the base `version < 1` `CREATE TABLE`, so a
fresh install at version 0 needs them too. This follows the convention already
documented in `db.ts` for `vacation_id`, `review_reason`, and
`amount_changed_from`. Bump the trailing `PRAGMA user_version` guard to 6 to
match.

### Storing the Plaid category

`upsertTransactions` begins persisting `personal_finance_category.detailed` into
`plaid_category`. The Cloudflare Worker already forwards the entire raw Plaid
transaction object untouched (`workers/src/index.ts:134` spreads it), so this
requires **no Worker change and no additional API call**. `PlaidTransaction` in
`lib/types.ts` gains the optional field.

---

## Guess vs. commit

The two-phase requirement — "evaluated as soon as the transaction lands, routed
only after skip/split" — reduces to a single invariant:

> `bucket IS NULL` means the transaction has not been committed to a bucket.

| Moment | Behavior |
|---|---|
| Transaction lands | Nothing written. The tile's chip calls `resolveBucket(tx)` live. |
| User re-tags pre-commit | `bucket` + `bucket_source='manual'` written; `status` is still `'new'`, so it stays out of the tracker. |
| User skips or splits | `bucket = resolveBucket(tx)`, and `bucket_source` set to `'vacation'`, `'manual'`, or `'auto'` by which rule matched |
| Tracker query | `WHERE status IN ('split','skipped') AND bucket IS NOT NULL` |

`resolveBucket` needs no special-casing at the commit site: its rule 1 applies
the vacation lock and its rule 2 returns an existing manual choice unchanged, so
a pre-commit re-tag survives the commit by construction.

That final `WHERE` clause is also exactly the "tracker starts from now"
decision: every pre-existing split or skipped row has `bucket = NULL` and is
excluded automatically. No backfill migration, no special-casing, no
heuristic guessing over old data.

**Materialization lives in the db layer**, in the same statements that flip
`status` to `'split'` or `'skipped'` (`updateTransactionStatus`,
`persistCombinedSplit`). Placing it there means the Transactions tab, the
vacation screen, and the review queue all inherit the behavior instead of each
call site having to remember it.

---

## Routing: `resolveBucket`

A pure function in `lib/buckets.ts`. Offline, deterministic, fully testable.

1. `tx.vacation_id` is set → `travel` *(locked; see below)*
2. `tx.bucket` already set → that value
3. `merchant_buckets[normalizeMerchant(tx.merchant_name)]` → learned override
4. `PFC_DETAILED_TO_BUCKET[tx.plaid_category]`
5. `PFC_PRIMARY_TO_BUCKET[primaryOf(tx.plaid_category)]` — coarse fallback
6. `MERCHANT_KEYWORDS` scan
7. `misc`

`bucket_source` records which rule won: `'vacation'` for rule 1, `'manual'`
for rules 2–3, `'auto'` for rules 4–7. It drives the chip's lock state and lets
the Spending tab surface how much of a month is still an unconfirmed guess.

Representative detailed-category mappings:

| Plaid detailed category | Bucket |
|---|---|
| `FOOD_AND_DRINK_GROCERIES` | needs |
| `FOOD_AND_DRINK_RESTAURANT`, `_FAST_FOOD`, `_COFFEE`, `_ALCOHOL_AND_BARS` | food |
| `TRANSPORTATION_GAS` | needs |
| `RENT_AND_UTILITIES_*` | needs |
| `LOAN_PAYMENTS_*`, `BANK_FEES_*` | needs |
| `GENERAL_MERCHANDISE_*` | shopping |
| `ENTERTAINMENT_*` | experiences |
| `TRAVEL_*` | travel |

Rule 6 exists because transactions already sitting in the Transactions tab were
fetched before this ships and carry no stored `plaid_category`. Without a
keyword fallback they would all commit to `misc`.

### Merchant memory

A manual re-tag writes three things: `transactions.bucket`,
`bucket_source='manual'`, and an upsert into `merchant_buckets`.

The memory applies **to future transactions only**. Already-bucketed
transactions from that merchant are never rewritten — a month the user has
already looked at must keep meaning what it meant.

`normalizeMerchant` lowercases, trims, and strips punctuation and trailing
digits, so `"STARBUCKS #4471"` and `"Starbucks"` share one key.

### Vacation lock

While a transaction belongs to a vacation, its bucket is `travel` and is not
editable. Tapping the chip explains that the trip sets it, and offers to remove
the transaction from the vacation instead.

This keeps one rule rather than two. The alternative — letting a manual tag win
— creates a transaction sitting in Food while still counted in the vacation's
month rather than its own, which is incoherent.

---

## Money math

Pure functions in `lib/spend.ts`, in **integer cents** throughout.

| Case | The user's share |
|---|---|
| `status = 'skipped'` | full `tx.amount` |
| `status = 'split'`, expense covers 1 transaction | `decision.amount_each` |
| `status = 'split'`, expense covers N transactions | `amount_each × (tx.amount / Σ member amounts)` |

The third row is the subtle one. `split_decisions.amount_each` is **the owner's
owed share of the whole expense** (`splitwise.ts:81`, `:118`), and for a
combined split the identical whole-expense value is stored on every one of the N
member rows. Summing it naively would multiply the user's share by N.

Pro-rating uses **largest-remainder** distribution so the N member shares sum
back to `amount_each` exactly, with no drifting cent.

Grouping by `splitwise_expense_id` happens in TypeScript rather than SQL,
mirroring the existing `groupHistoryRows` (`db.ts:148`). A month's row count is
small, and this keeps the arithmetic in a pure, unit-testable function.

Shares are computed **at read time**, never denormalized onto the transaction
row. Splits are editable from History, and a stored share would silently drift
out of date on every edit.

---

## Month attribution

Month keys are `"YYYY-MM"` in **device-local** time, produced through
`lib/date.ts` helpers. Never `new Date("2026-08-06")` — ECMA-262 parses the
date-only form as UTC midnight, which renders as the previous day anywhere west
of UTC.

| Transaction | Month |
|---|---|
| Has `vacation_id` | month of `vacation.start_date ?? started_at ?? created_at` |
| Otherwise | month of `tx.date` |

A vacation spanning a month boundary (Dec 28 – Jan 4) puts **all** of its spend
in the start month. The month is stable: it never moves once the trip begins.

Attribution is **derived at read time**, not stored, so editing a trip's dates
through `EditDatesSheet` correctly moves the whole trip's spend to the new
month. The aggregate query therefore `LEFT JOIN`s `vacations` on
`transactions.vacation_id` to pull `start_date`, `started_at`, and `created_at`
alongside each row.

### Currency

Transactions carry a `currency`, and foreign currency appears precisely on the
trips that dominate the Travel bucket. There is no FX rate source in the app, so
euros must never be silently added to dollars.

Totals are computed **per currency**. The pie renders the month's dominant
currency — the one with the largest total share, ties broken alphabetically by
currency code so the selection is stable across reloads. Other currencies appear
as a footnote (`+ €340 EUR`) below the chart.

---

## UI

### Spending tab

New fourth tab: Transactions / History / **Spending** / Settings
(`app/(tabs)/spending.tsx`, icon `pie-chart-outline`).

- **Month switcher** — `‹ August 2026 ›`. `addMonths`, `formatMonthLabel`, and
  `yearMonthOf` already exist in `lib/date.ts`; no new date code. Forward-clamped
  at the current month, back-clamped at the earliest month with data.
- **Donut**, four slices: Travel / Needs / Wants / Misc. The center reads the
  month total (the user's share). Tapping **Wants** re-renders the donut as
  Food / Shopping / Experiences, with the center showing the Wants total and a
  back chevron to return.
- **Bucket list** below, mirroring the current drill level: color dot, name,
  amount, percentage. Tapping a row expands its transactions, each individually
  re-taggable.
- Combined splits appear as **individual member transactions** here — each has
  its own bucket and its own pro-rated share — unlike History, which collapses
  them into one row.
- "Real time" means a `spendStore` recompute on focus and on any bucket, split,
  or skip mutation, using the same `useFocusEffect` pattern as the vacation
  screen.

**New dependency:** `react-native-svg`, installed via `npx expo install` so the
version matches SDK 52. It is Expo-blessed and renders under `react-native-web`,
so the PWA is unaffected. It is already present in the jest
`transformIgnorePatterns` at `package.json:59`, so no test-config change is
needed.

### The bucket chip

`components/BucketChip.tsx` and `components/BucketPickerSheet.tsx`.

The chip appears on the Transactions tile, on History rows, and in the Spending
tab's expanded lists — so "edit before committing" and "move it after it is
already in a bucket" are the same control in three places. Tapping opens a
bottom sheet listing the six buckets.

Two repo-specific constraints must be honored:

- `TransactionRow`'s width tuning is load-bearing. The `minWidth: 64` on `info`
  and `flexShrink: 1` on `amount` (lines 147–152, 185) exist because this row
  already overflows in the PWA under RN-web's `min-width: auto` behavior. The
  chip goes into `dateRow` with `flexShrink: 0`, exactly as `pendingBadge` does,
  and the date text keeps its truncation.
- If the picker sheet needs a CTA, it uses gorhom's `footerComponent` pattern.
  `BottomSheetView` breaks flex layout and pushes CTAs off-screen.

For a vacation transaction the chip reads Travel with a lock glyph, and tapping
it offers "Remove from vacation" rather than a bucket list.

A combined split in History is one row over N transactions, so re-tagging there
applies to every member. The Spending tab is where members can be pulled apart.

### Vacation skip

Today the vacation screen renders `TransactionRow` with `variant='remove'`
(`vacation/[id].tsx:303`), so the only actions are Split and Remove from
vacation. A trip expense paid entirely by the user cannot be committed — it is
either split or ejected from the trip. That blocks the tracker outright, since
nothing would ever route such a transaction to Travel.

New arrangement in vacation mode:

- swipe-right → **Remove from vacation** (the destructive action stays behind
  the swipe, as it effectively already does)
- inline buttons → **Skip** and **Split**, matching the main list

The `variant` prop is replaced by explicit `onSkip` / `onRemove` handlers. The
vacation screen passes both; the main Transactions list passes only `onSkip`.

Underneath, skipping inside a vacation is just `status='skipped'` with
`vacation_id` left intact. `updateTransactionStatus` only touches `status`, and
`getVacationHistory` (`db.ts:307`) already selects
`status IN ('split','skipped')` — so the skipped transaction appears in the
trip's history with **no query change**. Its bucket materializes to `travel` at
the full amount.

This is also what makes materializing `travel` safe rather than deriving it
forever: `endVacation` clears `vacation_id` only for `status='new'` rows
(`db.ts:760`), so once skipped or split, a trip expense belongs to that trip
permanently.

The vacation screen holds its pending list in local state rather than the
transaction store, so it calls the db function directly and then `refresh()`.

---

## Testing

Jest + `@testing-library/react-native`, joining the existing 314 tests.

- **`lib/buckets.test.ts`** — the full precedence ladder, every PFC mapping,
  merchant normalization (`"STARBUCKS #4471"` → `"starbucks"`), keyword
  fallback, and the vacation lock.
- **`lib/spend.test.ts`** — skipped, single-split, and N-way combined shares;
  odd-cent rounding; a property test asserting that member shares always sum
  back to `amount_each` exactly.
- **`lib/db.test.ts`** — v5→v6 migration against a populated database *and* a
  fresh v0→v6 install; bucket materialization on skip and on split; existing
  rows remain `NULL`.
- **Month attribution** — a trip spanning a month boundary, a vacation whose
  dates are edited afterward, and a vacation with no dates set.
- **Components** — the chip, the picker sheet, and the vacation skip action.

---

## Files

**New**

| File | Purpose |
|---|---|
| `mobile/lib/buckets.ts` | Taxonomy, PFC tables, `resolveBucket`, `normalizeMerchant` |
| `mobile/lib/spend.ts` | Share math, month attribution, monthly aggregation |
| `mobile/stores/spendStore.ts` | Month selection, drill state, aggregates |
| `mobile/app/(tabs)/spending.tsx` | The Spending tab |
| `mobile/components/SpendingDonut.tsx` | SVG donut with drill-down |
| `mobile/components/BucketChip.tsx` | The tappable tag |
| `mobile/components/BucketPickerSheet.tsx` | Bucket selection sheet |

**Modified**

| File | Change |
|---|---|
| `mobile/lib/db.ts` | Migration v6, `plaid_category` on upsert, materialization, two aggregate queries |
| `mobile/lib/types.ts` | `Bucket`, `BucketGroup`, new `Transaction` fields, `PlaidTransaction.personal_finance_category` |
| `mobile/lib/theme.ts` | Bucket colors |
| `mobile/components/TransactionRow.tsx` | Chip in `dateRow`; `variant` → `onSkip`/`onRemove` |
| `mobile/app/(tabs)/_layout.tsx` | Fourth tab |
| `mobile/app/(tabs)/history.tsx` | Chip on rows |
| `mobile/app/vacation/[id].tsx` | Skip action, new row props |
| `mobile/stores/transactionStore.ts` | Bucket mutations |
| `mobile/package.json` | `react-native-svg` |

---

## Decisions and rationale

| Decision | Why |
|---|---|
| Plaid PFC + merchant memory over an LLM | Already on the wire, free, deterministic, works offline, improves as the user corrects it |
| `misc` at top level, not under Wants | Unclassified spend must not distort the needs-vs-wants ratio |
| Vacation month = start date | Stable; never shifts when an end date is edited |
| Vacation beats a manual tag | One rule instead of two; avoids a transaction in Food counted in a trip's month |
| Re-tags apply forward only | A month already reviewed must keep meaning what it meant |
| No backfill | Old rows have no stored Plaid category; guessing over them would produce confident nonsense |
| Shares computed at read time | Splits are editable; a stored share would drift |
| Four-slice pie with drill-down | Cleanest top-level read of needs vs. wants, detail one tap away |
| Per-currency totals | No FX source exists; adding euros to dollars would be wrong, not approximate |
