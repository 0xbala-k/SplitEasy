# Monthly Spending Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bucket every committed transaction into one of six spending categories, count only the user's own share, and show it as a per-month drill-down pie chart.

**Architecture:** Two pure, dependency-free modules (`lib/buckets.ts` for routing, `lib/spend.ts` for money and month math) hold all the logic and carry the bulk of the tests. The database layer stores a `bucket` column that is `NULL` until a transaction is skipped or split — that single invariant delivers both the "guess now, route on commit" requirement and the "tracker starts from now" decision. The UI is a fourth tab plus a tappable chip reused across three screens.

**Tech Stack:** Expo SDK 52, React Native 0.76.3, React 18.3.1, TypeScript, expo-sqlite (native) + IndexedDB (web), zustand, @gorhom/bottom-sheet, react-native-svg (new), jest + @testing-library/react-native.

**Spec:** `docs/superpowers/specs/2026-08-19-monthly-spending-tracker-design.md`

## Global Constraints

These apply to **every** task. Re-read them before starting any task.

- **All commands run from `mobile/`.** Tests: `npm test`. Types: `npx tsc --noEmit`. Both must pass before every commit.
- **Every change to `lib/db.ts` must be mirrored in `lib/db.web.ts`.** The PWA is the primary distribution and Metro resolves `@/lib/db` to `db.web.ts` on web. `__tests__/lib/db.parity.test.ts` fails if `db.ts` exports a function `db.web.ts` does not. A missing web function throws only at runtime, *after* side effects like a created Splitwise expense.
- **Migration `ALTER`s in `db.ts` run ungated** — not behind `version >= 1 && ...` — because the new columns are not in the base `version < 1` `CREATE TABLE`, so a fresh install at version 0 needs them too. This convention is documented in `db.ts` around the `vacation_id` ALTER. Bump the trailing `if (version < N)` / `PRAGMA user_version = N` guard to 6.
- **Calendar dates go through `lib/date.ts`.** Never `new Date("2026-08-06")` (parses as UTC midnight, renders as the previous day west of UTC) and never `new Date().toISOString().slice(0,10)`. Use `parseLocalDate`, `toLocalDateString`, `todayLocal`, `yearMonthOf`, `addMonths`, `formatMonthLabel`.
- **Money in pure functions is integer cents.** Dollars only at the storage boundary (existing columns are `REAL`) and at render time.
- **Colors come from `lib/theme.ts`** (`Colors`, `Radius`, `Shadow`, `Spacing`). No hardcoded hex in components.
- **Chips inside `TransactionRow` need `flexShrink: 0`**, like the existing `pendingBadge`. That row already overflows in the PWA under RN-web's `min-width: auto` behavior; the `minWidth: 64` on `info` and `flexShrink: 1` on `amount` are load-bearing.
- **If a bottom sheet needs a CTA, use gorhom's `footerComponent` prop.** `BottomSheetView` breaks flex layout and pushes CTAs off-screen.
- **Commit after every task.** End commit messages with:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `mobile/lib/buckets.ts` | Taxonomy types, Plaid category tables, merchant normalization, `resolveBucket`. Pure, no I/O. |
| `mobile/lib/spend.ts` | Per-transaction share math, month attribution, monthly aggregation. Pure, no I/O. |
| `mobile/stores/spendStore.ts` | Selected month, drill state, cached aggregates. |
| `mobile/app/(tabs)/spending.tsx` | The Spending tab screen. |
| `mobile/components/SpendingDonut.tsx` | SVG donut with drill-down. Presentational only. |
| `mobile/components/BucketChip.tsx` | The tappable tag. Presentational only. |
| `mobile/components/BucketPickerSheet.tsx` | Bucket selection bottom sheet. |
| `mobile/__tests__/lib/buckets.test.ts` | |
| `mobile/__tests__/lib/spend.test.ts` | |
| `mobile/__tests__/components/BucketChip.test.tsx` | |
| `mobile/__tests__/components/BucketPickerSheet.test.tsx` | |
| `mobile/__tests__/components/SpendingDonut.test.tsx` | |
| `mobile/__tests__/stores/spendStore.test.ts` | |

**Modified files**

| File | Change |
|---|---|
| `mobile/lib/types.ts` | `PlaidTransaction.personal_finance_category`; `Transaction.bucket` / `.bucket_source` / `.plaid_category` |
| `mobile/lib/db.ts` | Migration v6, `plaid_category` on upsert, merchant memory CRUD, bucket materialization, `getSpendingRows` |
| `mobile/lib/db.web.ts` | Same, against IndexedDB; `DB_VERSION` 2 → 3 |
| `mobile/lib/vacationErrors.ts` | `VacationBucketLockedError` |
| `mobile/lib/theme.ts` | `BucketColors` |
| `mobile/components/TransactionRow.tsx` | `variant` → explicit `onRemove`; bucket chip in `dateRow` |
| `mobile/app/(tabs)/_layout.tsx` | Fourth tab |
| `mobile/app/(tabs)/index.tsx` | Chip wiring |
| `mobile/app/(tabs)/history.tsx` | Chip wiring |
| `mobile/app/vacation/[id].tsx` | Skip action, new row props |
| `mobile/stores/transactionStore.ts` | `setBucket` action |
| `mobile/package.json` | `react-native-svg` |

---

## Task Order and Dependencies

```
1. buckets.ts (pure)  ──┐
2. spend.ts (pure)    ──┼──> 3. migration + memory ──> 4. materialization ──> 6. query + store ──┐
                        │                                                                        ├──> 9. Spending tab
5. vacation skip (independent) ─────────────────────────────────────────────> 7. donut ──────────┘
                                                                              8. chip + sheet ──> 10. chip wiring
```

---

### Task 1: Bucket taxonomy and routing (pure)

**Files:**
- Create: `mobile/lib/buckets.ts`
- Test: `mobile/__tests__/lib/buckets.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Bucket`, `BucketGroup`, `BucketSource`, `BUCKETS`, `BUCKET_GROUP`, `BUCKET_LABEL`, `GROUP_LABEL`, `GROUP_BUCKETS`, `normalizeMerchant(name: string | null | undefined): string`, `primaryOf(detailed: string | null | undefined): string | null`, `resolveBucket(tx: BucketInput, memory?: Record<string, Bucket>): ResolvedBucket`.

- [ ] **Step 1: Write the failing test**

Create `mobile/__tests__/lib/buckets.test.ts`:

```ts
import {
  normalizeMerchant, primaryOf, resolveBucket, BUCKET_GROUP, GROUP_BUCKETS, BUCKETS,
} from '@/lib/buckets';

describe('normalizeMerchant', () => {
  it('lowercases, strips punctuation, and drops store numbers', () => {
    expect(normalizeMerchant('STARBUCKS #4471')).toBe('starbucks');
    expect(normalizeMerchant('Starbucks')).toBe('starbucks');
    expect(normalizeMerchant("Trader Joe's  ")).toBe('trader joe s');
  });

  it('returns empty string for null or blank', () => {
    expect(normalizeMerchant(null)).toBe('');
    expect(normalizeMerchant(undefined)).toBe('');
    expect(normalizeMerchant('   ')).toBe('');
  });
});

describe('primaryOf', () => {
  it('extracts the primary category from a detailed one', () => {
    expect(primaryOf('FOOD_AND_DRINK_GROCERIES')).toBe('FOOD_AND_DRINK');
    expect(primaryOf('TRANSPORTATION_GAS')).toBe('TRANSPORTATION');
    expect(primaryOf('TRAVEL_FLIGHTS')).toBe('TRAVEL');
  });

  it('returns null for unknown or missing input', () => {
    expect(primaryOf('WHATEVER_ELSE')).toBeNull();
    expect(primaryOf(null)).toBeNull();
  });
});

describe('BUCKET_GROUP', () => {
  it('puts only food/shopping/experiences under wants', () => {
    expect(BUCKET_GROUP.food).toBe('wants');
    expect(BUCKET_GROUP.shopping).toBe('wants');
    expect(BUCKET_GROUP.experiences).toBe('wants');
    expect(BUCKET_GROUP.travel).toBe('travel');
    expect(BUCKET_GROUP.needs).toBe('needs');
    // misc is top-level, NOT under wants
    expect(BUCKET_GROUP.misc).toBe('misc');
  });

  it('GROUP_BUCKETS is the exact inverse of BUCKET_GROUP', () => {
    const flattened = Object.values(GROUP_BUCKETS).flat().sort();
    expect(flattened).toEqual([...BUCKETS].sort());
    for (const [group, buckets] of Object.entries(GROUP_BUCKETS)) {
      for (const b of buckets) expect(BUCKET_GROUP[b]).toBe(group);
    }
  });
});

describe('resolveBucket precedence', () => {
  const base = { merchant_name: 'Starbucks', plaid_category: 'FOOD_AND_DRINK_COFFEE' };

  it('rule 1: a vacation beats everything, including a manual tag', () => {
    expect(resolveBucket({ ...base, vacation_id: 'v1', bucket: 'shopping' }))
      .toEqual({ bucket: 'travel', source: 'vacation' });
  });

  it('rule 2: an existing manual bucket beats merchant memory and Plaid', () => {
    expect(resolveBucket({ ...base, bucket: 'needs' }, { starbucks: 'shopping' }))
      .toEqual({ bucket: 'needs', source: 'manual' });
  });

  it('rule 3: merchant memory beats the Plaid category', () => {
    expect(resolveBucket(base, { starbucks: 'needs' }))
      .toEqual({ bucket: 'needs', source: 'manual' });
  });

  it('rule 4: the detailed Plaid category wins over the primary fallback', () => {
    // GROCERIES is a need even though FOOD_AND_DRINK maps to food
    expect(resolveBucket({ merchant_name: 'Safeway', plaid_category: 'FOOD_AND_DRINK_GROCERIES' }))
      .toEqual({ bucket: 'needs', source: 'auto' });
  });

  it('rule 5: falls back to the primary category for an unknown detailed one', () => {
    expect(resolveBucket({ merchant_name: 'Odd Diner', plaid_category: 'FOOD_AND_DRINK_SOMETHING_NEW' }))
      .toEqual({ bucket: 'food', source: 'auto' });
  });

  it('rule 6: falls back to merchant keywords when there is no Plaid category', () => {
    expect(resolveBucket({ merchant_name: 'WHOLE FOODS MKT #123', plaid_category: null }))
      .toEqual({ bucket: 'needs', source: 'auto' });
    expect(resolveBucket({ merchant_name: 'AMC Theatres', plaid_category: null }))
      .toEqual({ bucket: 'experiences', source: 'auto' });
  });

  it('keyword matching respects word boundaries', () => {
    // "rent" must not match inside "Parent Teacher Store"
    expect(resolveBucket({ merchant_name: 'Parent Teacher Store', plaid_category: null }).bucket)
      .not.toBe('needs');
  });

  it('rule 7: falls through to misc', () => {
    expect(resolveBucket({ merchant_name: 'Zzyzx Unknown Co', plaid_category: null }))
      .toEqual({ bucket: 'misc', source: 'auto' });
  });

  it('always returns a bucket in BUCKETS', () => {
    for (const name of ['', 'x', 'Shell Oil', 'Chipotle', 'Amazon', 'Netflix']) {
      expect(BUCKETS).toContain(resolveBucket({ merchant_name: name }).bucket);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- buckets.test.ts`
Expected: FAIL — `Cannot find module '@/lib/buckets'`

- [ ] **Step 3: Write the implementation**

Create `mobile/lib/buckets.ts`:

```ts
// mobile/lib/buckets.ts
//
// Where a transaction's money goes. Pure and dependency-free: no database, no
// network, no dates. Everything here is a table lookup or string munging, which
// keeps the routing rules cheap to test exhaustively and safe to call on every
// render of a transaction tile.

export type Bucket = 'travel' | 'needs' | 'food' | 'shopping' | 'experiences' | 'misc';
export type BucketGroup = 'travel' | 'needs' | 'wants' | 'misc';

// Which rule in resolveBucket produced a bucket. Drives the chip's lock state
// and lets the Spending tab report how much of a month is still a guess.
export type BucketSource = 'auto' | 'manual' | 'vacation';

export const BUCKETS: Bucket[] = ['travel', 'needs', 'food', 'shopping', 'experiences', 'misc'];

// `misc` is deliberately its own top-level group rather than a member of
// `wants`: unclassified spend must not inflate the wants number and distort
// the needs-vs-wants ratio the whole tracker exists to show.
export const BUCKET_GROUP: Record<Bucket, BucketGroup> = {
  travel: 'travel',
  needs: 'needs',
  food: 'wants',
  shopping: 'wants',
  experiences: 'wants',
  misc: 'misc',
};

export const GROUP_BUCKETS: Record<BucketGroup, Bucket[]> = {
  travel: ['travel'],
  needs: ['needs'],
  wants: ['food', 'shopping', 'experiences'],
  misc: ['misc'],
};

export const BUCKET_LABEL: Record<Bucket, string> = {
  travel: 'Travel',
  needs: 'Needs',
  food: 'Food',
  shopping: 'Shopping',
  experiences: 'Experiences',
  misc: 'Misc',
};

export const GROUP_LABEL: Record<BucketGroup, string> = {
  travel: 'Travel',
  needs: 'Needs',
  wants: 'Wants',
  misc: 'Misc',
};

// Plaid's personal_finance_category.detailed → bucket.
//
// The interesting entries are the ones where the detailed value disagrees with
// its own primary: groceries are a need while the rest of FOOD_AND_DRINK is a
// want, and everyday transportation is a need while TRAVEL_* is a trip.
export const PFC_DETAILED_TO_BUCKET: Record<string, Bucket> = {
  FOOD_AND_DRINK_GROCERIES: 'needs',
  FOOD_AND_DRINK_RESTAURANT: 'food',
  FOOD_AND_DRINK_FAST_FOOD: 'food',
  FOOD_AND_DRINK_COFFEE: 'food',
  FOOD_AND_DRINK_ALCOHOL_AND_BARS: 'food',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'food',
  FOOD_AND_DRINK_VENDING_MACHINES: 'food',
  FOOD_AND_DRINK_OTHER_FOOD_AND_DRINK: 'food',

  TRANSPORTATION_GAS: 'needs',
  TRANSPORTATION_PARKING: 'needs',
  TRANSPORTATION_PUBLIC_TRANSIT: 'needs',
  TRANSPORTATION_TOLLS: 'needs',
  TRANSPORTATION_BIKES_AND_SCOOTERS: 'needs',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'needs',
  TRANSPORTATION_OTHER_TRANSPORTATION: 'needs',

  RENT_AND_UTILITIES_RENT: 'needs',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'needs',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'needs',
  RENT_AND_UTILITIES_TELEPHONE: 'needs',
  RENT_AND_UTILITIES_WATER: 'needs',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE: 'needs',
  RENT_AND_UTILITIES_OTHER_UTILITIES: 'needs',

  LOAN_PAYMENTS_CAR_PAYMENT: 'needs',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'needs',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'needs',
  LOAN_PAYMENTS_STUDENT_LOAN_PAYMENT: 'needs',
  LOAN_PAYMENTS_PERSONAL_LOAN_PAYMENT: 'needs',
  LOAN_PAYMENTS_OTHER_PAYMENT: 'needs',

  BANK_FEES_ATM_FEES: 'needs',
  BANK_FEES_FOREIGN_TRANSACTION_FEES: 'needs',
  BANK_FEES_INSUFFICIENT_FUNDS: 'needs',
  BANK_FEES_INTEREST_CHARGE: 'needs',
  BANK_FEES_OVERDRAFT_FEES: 'needs',
  BANK_FEES_OTHER_BANK_FEES: 'needs',

  GENERAL_SERVICES_INSURANCE: 'needs',
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: 'needs',
  GENERAL_SERVICES_AUTOMOTIVE: 'needs',
  GENERAL_SERVICES_CHILDCARE: 'needs',
  GENERAL_SERVICES_EDUCATION: 'needs',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'needs',
  GENERAL_SERVICES_STORAGE: 'needs',
  GENERAL_SERVICES_OTHER_GENERAL_SERVICES: 'needs',

  MEDICAL_PRIMARY_CARE: 'needs',
  MEDICAL_DENTAL_CARE: 'needs',
  MEDICAL_EYE_CARE: 'needs',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'needs',
  MEDICAL_VETERINARY_SERVICES: 'needs',
  MEDICAL_NURSING_CARE: 'needs',
  MEDICAL_OTHER_MEDICAL: 'needs',

  HOME_IMPROVEMENT_HARDWARE: 'needs',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'needs',
  HOME_IMPROVEMENT_SECURITY: 'needs',
  HOME_IMPROVEMENT_FURNITURE: 'shopping',
  HOME_IMPROVEMENT_OTHER_HOME_IMPROVEMENT: 'needs',

  GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES: 'shopping',
  GENERAL_MERCHANDISE_ELECTRONICS: 'shopping',
  GENERAL_MERCHANDISE_SPORTING_GOODS: 'shopping',
  GENERAL_MERCHANDISE_ONLINE_MARKETPLACES: 'shopping',
  GENERAL_MERCHANDISE_DEPARTMENT_STORES: 'shopping',
  GENERAL_MERCHANDISE_DISCOUNT_STORES: 'shopping',
  GENERAL_MERCHANDISE_SUPERSTORES: 'shopping',
  GENERAL_MERCHANDISE_BOOKSTORES_AND_NEWSSTANDS: 'shopping',
  GENERAL_MERCHANDISE_OFFICE_SUPPLIES: 'shopping',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'shopping',
  GENERAL_MERCHANDISE_TOBACCO_AND_VAPE: 'shopping',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'needs',
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: 'needs',
  GENERAL_MERCHANDISE_OTHER_GENERAL_MERCHANDISE: 'shopping',

  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'needs',
  PERSONAL_CARE_LAUNDRY_AND_DRY_CLEANING: 'needs',
  PERSONAL_CARE_HAIR_AND_BEAUTY: 'shopping',
  PERSONAL_CARE_OTHER_PERSONAL_CARE: 'shopping',

  ENTERTAINMENT_CASINOS_AND_GAMBLING: 'experiences',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'experiences',
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: 'experiences',
  ENTERTAINMENT_TV_AND_MOVIES: 'experiences',
  ENTERTAINMENT_VIDEO_GAMES: 'experiences',
  ENTERTAINMENT_OTHER_ENTERTAINMENT: 'experiences',

  TRAVEL_FLIGHTS: 'travel',
  TRAVEL_LODGING: 'travel',
  TRAVEL_RENTAL_CARS: 'travel',
  TRAVEL_PUBLIC_TRANSIT: 'travel',
  TRAVEL_TAXIS_AND_RIDE_SHARES: 'travel',
  TRAVEL_PARKING: 'travel',
  TRAVEL_GAS: 'travel',
  TRAVEL_OTHER_TRAVEL: 'travel',
};

// Coarse fallback for detailed values Plaid adds after this table was written.
export const PFC_PRIMARY_TO_BUCKET: Record<string, Bucket> = {
  FOOD_AND_DRINK: 'food',
  TRANSPORTATION: 'needs',
  RENT_AND_UTILITIES: 'needs',
  LOAN_PAYMENTS: 'needs',
  BANK_FEES: 'needs',
  MEDICAL: 'needs',
  GENERAL_SERVICES: 'needs',
  HOME_IMPROVEMENT: 'needs',
  GENERAL_MERCHANDISE: 'shopping',
  PERSONAL_CARE: 'shopping',
  ENTERTAINMENT: 'experiences',
  TRAVEL: 'travel',
  GOVERNMENT_AND_NON_PROFIT: 'misc',
};

// Longest-first so a future primary that is a prefix of another still resolves
// to the more specific one.
const PRIMARIES = Object.keys(PFC_PRIMARY_TO_BUCKET).sort((a, b) => b.length - a.length);

/** The primary category a detailed Plaid category belongs to, or null. */
export function primaryOf(detailed: string | null | undefined): string | null {
  if (!detailed) return null;
  return PRIMARIES.find((p) => detailed === p || detailed.startsWith(`${p}_`)) ?? null;
}

// Last-resort routing by merchant name. This exists for two populations that
// have no stored Plaid category: transactions already sitting in the
// Transactions tab when this feature ships, and any institution whose feed
// omits personal_finance_category. Scanned in order, first match wins.
export const MERCHANT_KEYWORDS: [string, Bucket][] = [
  ['whole foods', 'needs'], ['trader joe', 'needs'], ['safeway', 'needs'],
  ['costco', 'needs'], ['kroger', 'needs'], ['aldi', 'needs'], ['publix', 'needs'],
  ['grocery', 'needs'], ['market', 'needs'],
  ['shell', 'needs'], ['chevron', 'needs'], ['exxon', 'needs'], ['mobil', 'needs'],
  ['arco', 'needs'], ['gas', 'needs'],
  ['geico', 'needs'], ['progressive', 'needs'], ['state farm', 'needs'],
  ['insurance', 'needs'], ['comcast', 'needs'], ['xfinity', 'needs'],
  ['verizon', 'needs'], ['t mobile', 'needs'], ['at t', 'needs'],
  ['rent', 'needs'], ['pharmacy', 'needs'], ['cvs', 'needs'], ['walgreens', 'needs'],

  ['starbucks', 'food'], ['chipotle', 'food'], ['mcdonald', 'food'],
  ['doordash', 'food'], ['uber eats', 'food'], ['grubhub', 'food'],
  ['postmates', 'food'], ['restaurant', 'food'], ['pizza', 'food'],
  ['coffee', 'food'], ['cafe', 'food'], ['brewing', 'food'], ['taqueria', 'food'],

  ['amazon', 'shopping'], ['amzn', 'shopping'], ['target', 'shopping'],
  ['walmart', 'shopping'], ['best buy', 'shopping'], ['apple store', 'shopping'],
  ['nike', 'shopping'], ['revzilla', 'shopping'], ['cycle gear', 'shopping'],
  ['etsy', 'shopping'], ['ebay', 'shopping'], ['ikea', 'shopping'],

  ['amc', 'experiences'], ['cinemark', 'experiences'], ['regal', 'experiences'],
  ['steam', 'experiences'], ['playstation', 'experiences'], ['xbox', 'experiences'],
  ['nintendo', 'experiences'], ['ticketmaster', 'experiences'],
  ['stubhub', 'experiences'], ['eventbrite', 'experiences'],
  ['museum', 'experiences'], ['netflix', 'experiences'], ['spotify', 'experiences'],

  ['airlines', 'travel'], ['airbnb', 'travel'], ['marriott', 'travel'],
  ['hilton', 'travel'], ['hyatt', 'travel'], ['expedia', 'travel'],
  ['booking com', 'travel'], ['hotel', 'travel'],
];

// Word-boundary match against the normalized name, so "rent" does not fire on
// "parent" and "gas" does not fire on "gaslight".
function matchesKeyword(normalized: string, keyword: string): boolean {
  if (!normalized) return false;
  return normalized === keyword
    || normalized.startsWith(`${keyword} `)
    || normalized.endsWith(` ${keyword}`)
    || normalized.includes(` ${keyword} `);
}

/**
 * A merchant name reduced to a stable memory key: lowercased, punctuation
 * flattened to spaces, standalone digit groups dropped. "STARBUCKS #4471" and
 * "Starbucks" both become "starbucks", so re-tagging one teaches the app about
 * every branch.
 */
export function normalizeMerchant(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface BucketInput {
  merchant_name: string | null;
  plaid_category?: string | null;
  bucket?: Bucket | null;
  vacation_id?: string | null;
}

export interface ResolvedBucket {
  bucket: Bucket;
  source: BucketSource;
}

/**
 * The bucket a transaction belongs in, and which rule decided it.
 *
 * Precedence, highest first:
 *   1. it belongs to a vacation        → travel (locked)
 *   2. it already carries a bucket     → that value
 *   3. the merchant has been re-tagged → the learned bucket
 *   4. Plaid's detailed category
 *   5. Plaid's primary category
 *   6. a merchant-name keyword
 *   7. misc
 *
 * Rules 1 and 2 are why the commit path needs no special-casing: calling this
 * on an already-tagged or vacation-bound transaction returns it unchanged.
 */
export function resolveBucket(
  tx: BucketInput,
  memory: Record<string, Bucket> = {}
): ResolvedBucket {
  if (tx.vacation_id) return { bucket: 'travel', source: 'vacation' };
  if (tx.bucket) return { bucket: tx.bucket, source: 'manual' };

  const key = normalizeMerchant(tx.merchant_name);
  const remembered = key ? memory[key] : undefined;
  if (remembered) return { bucket: remembered, source: 'manual' };

  const detailed = tx.plaid_category ?? null;
  const byDetailed = detailed ? PFC_DETAILED_TO_BUCKET[detailed] : undefined;
  if (byDetailed) return { bucket: byDetailed, source: 'auto' };

  const primary = primaryOf(detailed);
  const byPrimary = primary ? PFC_PRIMARY_TO_BUCKET[primary] : undefined;
  if (byPrimary) return { bucket: byPrimary, source: 'auto' };

  for (const [keyword, bucket] of MERCHANT_KEYWORDS) {
    if (matchesKeyword(key, keyword)) return { bucket, source: 'auto' };
  }

  return { bucket: 'misc', source: 'auto' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- buckets.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/buckets.ts mobile/__tests__/lib/buckets.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add spending bucket taxonomy and routing rules

Pure module mapping Plaid's personal_finance_category to six spending
buckets, with a learned merchant memory taking precedence over the
category tables and a keyword fallback for transactions that carry no
stored category.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Share math, month attribution, and aggregation (pure)

**Files:**
- Create: `mobile/lib/spend.ts`
- Test: `mobile/__tests__/lib/spend.test.ts`

**Interfaces:**
- Consumes: `Bucket`, `BucketGroup`, `BUCKET_GROUP`, `GROUP_BUCKETS`, `BUCKETS` from Task 1; `yearMonthOf` from `lib/date.ts`.
- Produces: `SpendRow`, `SpendRowWithShare`, `MonthSpend`, `myShareCentsByTransaction(rows: SpendRow[]): Map<string, number>`, `monthKeyOf(row: SpendRow): string`, `availableMonths(rows: SpendRow[]): string[]`, `aggregateMonth(rows: SpendRow[], monthKey: string): MonthSpend`, `formatMonthKey(key: string): string`.

**Background the implementer needs:** `split_decisions.amount_each` is **the owner's owed share of the whole Splitwise expense**, not a per-friend amount (see `lib/splitwise.ts`, `buildExpenseBody`). When several transactions are combined into one expense, that same whole-expense value is written to *every* member row. Summing it naively multiplies the user's share by the number of members. That is the single most important thing this module gets right.

- [ ] **Step 1: Write the failing test**

Create `mobile/__tests__/lib/spend.test.ts`:

```ts
import {
  myShareCentsByTransaction, monthKeyOf, availableMonths, aggregateMonth, formatMonthKey,
  SpendRow,
} from '@/lib/spend';

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    id: 'tx1',
    merchant_name: 'Cafe',
    amount: 20,
    currency: 'USD',
    date: '2026-08-10',
    status: 'skipped',
    bucket: 'food',
    bucket_source: 'auto',
    splitwise_expense_id: null,
    amount_each: null,
    vacation_id: null,
    vacation_start_date: null,
    vacation_started_at: null,
    vacation_created_at: null,
    ...over,
  };
}

describe('myShareCentsByTransaction', () => {
  it('counts the full amount for a skipped transaction', () => {
    const shares = myShareCentsByTransaction([row({ amount: 20, status: 'skipped' })]);
    expect(shares.get('tx1')).toBe(2000);
  });

  it('counts amount_each for a split covering one transaction', () => {
    const shares = myShareCentsByTransaction([
      row({ id: 'a', amount: 60, status: 'split', splitwise_expense_id: 'e1', amount_each: 20 }),
    ]);
    expect(shares.get('a')).toBe(2000);
  });

  it('pro-rates a combined split instead of counting amount_each N times', () => {
    // One $30 expense split three ways: the owner owes $10 of it. Two
    // transactions ($20 and $10) share that one expense.
    const rows = [
      row({ id: 'a', amount: 20, status: 'split', splitwise_expense_id: 'e1', amount_each: 10 }),
      row({ id: 'b', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10 }),
    ];
    const shares = myShareCentsByTransaction(rows);
    expect(shares.get('a')).toBe(667);
    expect(shares.get('b')).toBe(333);
    // The whole point: members sum to amount_each, not 2 x amount_each.
    expect(shares.get('a')! + shares.get('b')!).toBe(1000);
  });

  it('distributes odd cents so members always sum to amount_each exactly', () => {
    const rows = [
      row({ id: 'a', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10.01 }),
      row({ id: 'b', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10.01 }),
      row({ id: 'c', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10.01 }),
    ];
    const shares = myShareCentsByTransaction(rows);
    const total = ['a', 'b', 'c'].reduce((s, id) => s + shares.get(id)!, 0);
    expect(total).toBe(1001);
  });

  it('property: member shares always sum to amount_each, for many shapes', () => {
    for (let n = 2; n <= 6; n++) {
      for (const eachCents of [1, 7, 100, 333, 99999]) {
        const rows = Array.from({ length: n }, (_, i) =>
          row({
            id: `m${i}`,
            amount: (i + 1) * 3.37,
            status: 'split',
            splitwise_expense_id: 'e1',
            amount_each: eachCents / 100,
          })
        );
        const shares = myShareCentsByTransaction(rows);
        const total = rows.reduce((s, r) => s + shares.get(r.id)!, 0);
        expect(total).toBe(eachCents);
        // and no member gets a negative share
        for (const r of rows) expect(shares.get(r.id)!).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps separate expenses independent', () => {
    const rows = [
      row({ id: 'a', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 5 }),
      row({ id: 'b', amount: 10, status: 'split', splitwise_expense_id: 'e2', amount_each: 4 }),
    ];
    const shares = myShareCentsByTransaction(rows);
    expect(shares.get('a')).toBe(500);
    expect(shares.get('b')).toBe(400);
  });
});

describe('monthKeyOf', () => {
  it('uses the transaction date for a non-vacation transaction', () => {
    expect(monthKeyOf(row({ date: '2026-08-10' }))).toBe('2026-08');
  });

  it('uses the vacation start date for a vacation transaction', () => {
    expect(monthKeyOf(row({
      date: '2026-08-10',
      vacation_id: 'v1',
      vacation_start_date: '2026-09-28',
    }))).toBe('2026-09');
  });

  it('puts a trip spanning a month boundary entirely in the start month', () => {
    const dec = row({ id: 'a', date: '2026-12-29', vacation_id: 'v1', vacation_start_date: '2026-12-28' });
    const jan = row({ id: 'b', date: '2027-01-02', vacation_id: 'v1', vacation_start_date: '2026-12-28' });
    expect(monthKeyOf(dec)).toBe('2026-12');
    expect(monthKeyOf(jan)).toBe('2026-12');
  });

  it('falls back to started_at, then created_at, when the trip has no start date', () => {
    expect(monthKeyOf(row({
      date: '2026-08-10', vacation_id: 'v1',
      vacation_start_date: null, vacation_started_at: '2026-07-04T12:00:00Z',
    }))).toBe('2026-07');
    expect(monthKeyOf(row({
      date: '2026-08-10', vacation_id: 'v1',
      vacation_start_date: null, vacation_started_at: null, vacation_created_at: '2026-06-04T12:00:00Z',
    }))).toBe('2026-06');
  });

  it('does not shift a date-only value across a zone boundary', () => {
    // "2026-03-01" parsed as UTC midnight renders as Feb 28 in US Pacific.
    expect(monthKeyOf(row({ date: '2026-03-01' }))).toBe('2026-03');
  });
});

describe('aggregateMonth', () => {
  const rows: SpendRow[] = [
    row({ id: 'a', amount: 100, status: 'skipped', bucket: 'needs', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, status: 'skipped', bucket: 'food', date: '2026-08-05' }),
    row({ id: 'c', amount: 60, status: 'skipped', bucket: 'shopping', date: '2026-08-09' }),
    row({ id: 'd', amount: 25, status: 'skipped', bucket: 'misc', date: '2026-08-11' }),
    row({ id: 'e', amount: 999, status: 'skipped', bucket: 'needs', date: '2026-07-11' }),
  ];

  it('totals only the requested month', () => {
    const m = aggregateMonth(rows, '2026-08');
    expect(m.totalCents).toBe(22500);
    expect(m.rows).toHaveLength(4);
  });

  it('totals by bucket and rolls up to groups', () => {
    const m = aggregateMonth(rows, '2026-08');
    expect(m.byBucket.needs).toBe(10000);
    expect(m.byBucket.food).toBe(4000);
    expect(m.byBucket.shopping).toBe(6000);
    expect(m.byGroup.wants).toBe(10000); // food + shopping
    expect(m.byGroup.misc).toBe(2500);
    expect(m.byGroup.travel).toBe(0);
  });

  it('attaches each row its own share', () => {
    const m = aggregateMonth(rows, '2026-08');
    expect(m.rows.find((r) => r.id === 'a')!.shareCents).toBe(10000);
  });

  it('returns zeroed totals for a month with no data', () => {
    const m = aggregateMonth(rows, '2026-01');
    expect(m.totalCents).toBe(0);
    expect(m.rows).toEqual([]);
    expect(m.byGroup.needs).toBe(0);
  });

  it('reports the dominant currency and footnotes the rest', () => {
    const mixed: SpendRow[] = [
      row({ id: 'a', amount: 100, currency: 'USD', date: '2026-08-02' }),
      row({ id: 'b', amount: 30, currency: 'EUR', date: '2026-08-03' }),
      row({ id: 'c', amount: 10, currency: 'EUR', date: '2026-08-04' }),
    ];
    const m = aggregateMonth(mixed, '2026-08');
    expect(m.currency).toBe('USD');
    expect(m.totalCents).toBe(10000);
    expect(m.otherCurrencies).toEqual([{ currency: 'EUR', cents: 4000 }]);
  });

  it('breaks a currency tie alphabetically so the pie does not flip between reloads', () => {
    const tied: SpendRow[] = [
      row({ id: 'a', amount: 50, currency: 'USD', date: '2026-08-02' }),
      row({ id: 'b', amount: 50, currency: 'EUR', date: '2026-08-03' }),
    ];
    expect(aggregateMonth(tied, '2026-08').currency).toBe('EUR');
  });
});

describe('availableMonths', () => {
  it('lists distinct months, newest first', () => {
    const rows = [
      row({ id: 'a', date: '2026-06-01' }),
      row({ id: 'b', date: '2026-08-01' }),
      row({ id: 'c', date: '2026-08-20' }),
    ];
    expect(availableMonths(rows)).toEqual(['2026-08', '2026-06']);
  });

  it('uses the vacation month, not the transaction month', () => {
    const rows = [row({ id: 'a', date: '2026-08-01', vacation_id: 'v1', vacation_start_date: '2026-05-01' })];
    expect(availableMonths(rows)).toEqual(['2026-05']);
  });
});

describe('formatMonthKey', () => {
  it('renders a human month label', () => {
    expect(formatMonthKey('2026-08')).toBe('August 2026');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- spend.test.ts`
Expected: FAIL — `Cannot find module '@/lib/spend'`

- [ ] **Step 3: Write the implementation**

Create `mobile/lib/spend.ts`:

```ts
// mobile/lib/spend.ts
//
// How much of a transaction was actually the user's, which month it counts
// toward, and the per-month rollup the Spending tab renders. Pure: the caller
// supplies rows, this returns numbers.
//
// Money is integer cents throughout. The stored columns are REAL dollars, so
// every value crossing into this module is rounded once, on the way in, and
// never re-multiplied afterwards.

import { Bucket, BucketGroup, BUCKETS, BUCKET_GROUP, BucketSource } from '@/lib/buckets';
import { yearMonthOf, formatMonthLabel } from '@/lib/date';

/** One committed transaction, joined to its split decision and its vacation. */
export interface SpendRow {
  id: string;
  merchant_name: string;
  amount: number;                     // full transaction amount, dollars
  currency: string;
  date: string;                       // "YYYY-MM-DD"
  status: 'split' | 'skipped';
  bucket: Bucket;
  bucket_source: BucketSource;
  splitwise_expense_id: string | null;
  amount_each: number | null;         // owner's owed share of the WHOLE expense
  vacation_id: string | null;
  vacation_start_date: string | null;
  vacation_started_at: string | null;
  vacation_created_at: string | null;
}

export interface SpendRowWithShare extends SpendRow {
  shareCents: number;
}

export interface MonthSpend {
  monthKey: string;                   // "YYYY-MM"
  currency: string;                   // the month's dominant currency
  totalCents: number;                 // in `currency` only
  byBucket: Record<Bucket, number>;
  byGroup: Record<BucketGroup, number>;
  otherCurrencies: { currency: string; cents: number }[];
  rows: SpendRowWithShare[];          // in `currency` only, newest first
}

/**
 * Each transaction's share of its own cost, in cents, keyed by transaction id.
 *
 * A skipped transaction is entirely the user's. A split transaction's share is
 * `split_decisions.amount_each` — which is the owner's owed share of the whole
 * Splitwise expense (see lib/splitwise.ts, buildExpenseBody). When N
 * transactions were combined into one expense, that same whole-expense figure
 * sits on all N rows, so it is pro-rated by each member's amount rather than
 * counted N times. Largest-remainder distribution keeps the members summing
 * back to amount_each exactly, with no drifting cent.
 */
export function myShareCentsByTransaction(rows: SpendRow[]): Map<string, number> {
  const out = new Map<string, number>();
  const expenses = new Map<string, SpendRow[]>();

  for (const r of rows) {
    if (r.status === 'skipped' || !r.splitwise_expense_id) {
      out.set(r.id, Math.round(r.amount * 100));
      continue;
    }
    const members = expenses.get(r.splitwise_expense_id) ?? [];
    members.push(r);
    expenses.set(r.splitwise_expense_id, members);
  }

  for (const members of expenses.values()) {
    const totalCents = Math.round((members[0].amount_each ?? 0) * 100);

    if (members.length === 1) {
      out.set(members[0].id, totalCents);
      continue;
    }

    const weights = members.map((m) => Math.round(m.amount * 100));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    // A zero-weight group (every member $0) still has to place its cents
    // somewhere; split it evenly rather than dividing by zero.
    const exact = weights.map((w) =>
      weightSum === 0 ? totalCents / members.length : (totalCents * w) / weightSum
    );

    const shares = exact.map(Math.floor);
    const placed = shares.reduce((a, b) => a + b, 0);
    // Always in [0, members.length): each floor loses under one cent.
    const remainder = totalCents - placed;
    const byFraction = exact
      .map((v, i) => ({ i, frac: v - Math.floor(v) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < remainder; k++) shares[byFraction[k].i] += 1;

    members.forEach((m, i) => out.set(m.id, shares[i]));
  }

  return out;
}

/**
 * The month a transaction counts toward, as "YYYY-MM" in device-local time.
 *
 * A vacation's spend all lands in the month the trip started, however the
 * individual charges are dated — so a trip spanning New Year counts entirely
 * in December. Derived rather than stored, so editing a trip's dates moves its
 * whole spend with them.
 */
export function monthKeyOf(row: SpendRow): string {
  const source = row.vacation_id
    ? (row.vacation_start_date ?? row.vacation_started_at ?? row.vacation_created_at ?? row.date)
    : row.date;
  const { year, month } = yearMonthOf(source);
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

/** Every month with committed spend, newest first. */
export function availableMonths(rows: SpendRow[]): string[] {
  return [...new Set(rows.map(monthKeyOf))].sort().reverse();
}

/** "2026-08" → "August 2026". */
export function formatMonthKey(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return formatMonthLabel({ year, month: month - 1 });
}

function zeroBuckets(): Record<Bucket, number> {
  return Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
}

function zeroGroups(): Record<BucketGroup, number> {
  return { travel: 0, needs: 0, wants: 0, misc: 0 };
}

/**
 * One month's spending, rolled up by bucket and by group.
 *
 * There is no FX rate source in the app, so currencies are never added
 * together. The month reports its dominant currency — the one with the largest
 * total, ties broken alphabetically so the chart does not flip between reloads
 * — and lists the others separately.
 */
export function aggregateMonth(rows: SpendRow[], monthKey: string): MonthSpend {
  const inMonth = rows.filter((r) => monthKeyOf(r) === monthKey);
  const shares = myShareCentsByTransaction(inMonth);

  const byCurrency = new Map<string, number>();
  for (const r of inMonth) {
    byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + (shares.get(r.id) ?? 0));
  }

  const ranked = [...byCurrency.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const currency = ranked[0]?.[0] ?? 'USD';

  const primaryRows: SpendRowWithShare[] = inMonth
    .filter((r) => r.currency === currency)
    .map((r) => ({ ...r, shareCents: shares.get(r.id) ?? 0 }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const byBucket = zeroBuckets();
  const byGroup = zeroGroups();
  for (const r of primaryRows) {
    byBucket[r.bucket] += r.shareCents;
    byGroup[BUCKET_GROUP[r.bucket]] += r.shareCents;
  }

  return {
    monthKey,
    currency,
    totalCents: ranked[0]?.[1] ?? 0,
    byBucket,
    byGroup,
    otherCurrencies: ranked.slice(1).map(([c, cents]) => ({ currency: c, cents })),
    rows: primaryRows,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- spend.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/spend.ts mobile/__tests__/lib/spend.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add spending share math and month aggregation

Pure module computing each transaction's own share in integer cents,
pro-rating combined splits so members sum back to the expense's owner
share rather than counting it once per member, attributing vacation
spend to the trip's start month, and rolling a month up by bucket and
group without ever adding two currencies together.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Migration v6, stored Plaid category, and merchant memory

**Files:**
- Modify: `mobile/lib/types.ts`
- Modify: `mobile/lib/db.ts` (`openDatabase`, `upsertTransactions`)
- Modify: `mobile/lib/db.web.ts` (`DB_VERSION`, `openDatabase`, `upsertTransactions`)
- Test: `mobile/__tests__/lib/db.test.ts`, `mobile/__tests__/lib/db.web.test.ts`

**Interfaces:**
- Consumes: `Bucket` from Task 1.
- Produces: `getMerchantBuckets(): Promise<Record<string, Bucket>>`, `setMerchantBucket(merchantKey: string, bucket: Bucket): Promise<void>` — exported from **both** `db.ts` and `db.web.ts`. `Transaction` gains `bucket?: Bucket | null`, `bucket_source?: BucketSource | null`, `plaid_category?: string | null`. `PlaidTransaction` gains `personal_finance_category?: { primary: string; detailed: string; confidence_level?: string } | null`.

**Read first:** the comment block in `db.ts` above the `vacation_id` ALTER. It explains why these ALTERs run ungated. Getting this wrong breaks fresh installs with "duplicate column name".

- [ ] **Step 1: Write the failing tests**

Append to `mobile/__tests__/lib/db.test.ts` (add `getMerchantBuckets`, `setMerchantBucket` to the existing import list at the top of the file):

```ts
test('migration v6 adds bucket columns and the merchant_buckets table', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 5 });
  await initDb();
  const sql = mockDb.execAsync.mock.calls.map(([s]: [string]) => s).join('\n');
  expect(sql).toContain('ADD COLUMN bucket TEXT');
  expect(sql).toContain('ADD COLUMN bucket_source TEXT');
  expect(sql).toContain('ADD COLUMN plaid_category TEXT');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS merchant_buckets');
  expect(sql).toContain('PRAGMA user_version = 6');
});

test('migration v6 columns are added on a fresh install too', async () => {
  // A version-0 database does not get these columns from the base CREATE
  // TABLE, so the ALTERs must not be gated behind version >= 1.
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 0 });
  await initDb();
  const sql = mockDb.execAsync.mock.calls.map(([s]: [string]) => s).join('\n');
  expect(sql).toContain('ADD COLUMN bucket TEXT');
  expect(sql).toContain('ADD COLUMN plaid_category TEXT');
});

test('initDb runs no migration when already at version 6', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 6 });
  await initDb();
  const sql = mockDb.execAsync.mock.calls.map(([s]: [string]) => s).join('\n');
  expect(sql).not.toContain('ADD COLUMN bucket TEXT');
  expect(sql).not.toContain('PRAGMA user_version = 6');
});

test('upsertTransactions stores the detailed Plaid category', async () => {
  await initDb();
  await upsertTransactions([{
    transaction_id: 'ptx9', merchant_name: 'Safeway', name: 'SAFEWAY', amount: 42,
    iso_currency_code: 'USD', date: '2026-08-10', pending: false,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  }]);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT OR IGNORE'),
    expect.arrayContaining(['FOOD_AND_DRINK_GROCERIES'])
  );
});

test('upsertTransactions stores null when Plaid sends no category', async () => {
  await initDb();
  await upsertTransactions([{
    transaction_id: 'ptx10', merchant_name: 'Mystery', name: 'MYSTERY', amount: 5,
    iso_currency_code: 'USD', date: '2026-08-10', pending: false,
  }]);
  const insert = mockDb.runAsync.mock.calls.find(([s]: [string]) => s.includes('INSERT OR IGNORE'));
  expect(insert![1]).toContain(null);
});

test('setMerchantBucket upserts and getMerchantBuckets returns a keyed map', async () => {
  await initDb();
  await setMerchantBucket('starbucks', 'needs');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO merchant_buckets'),
    expect.arrayContaining(['starbucks', 'needs'])
  );

  mockDb.getAllAsync.mockResolvedValueOnce([
    { merchant_key: 'starbucks', bucket: 'needs' },
    { merchant_key: 'amazon', bucket: 'shopping' },
  ]);
  await expect(getMerchantBuckets()).resolves.toEqual({ starbucks: 'needs', amazon: 'shopping' });
});
```

Append to `mobile/__tests__/lib/db.web.test.ts` (add `getMerchantBuckets`, `setMerchantBucket` to its import list):

```ts
test('web: upsertTransactions stores the detailed Plaid category', async () => {
  await upsertTransactions([plaidTx('w1', {
    personal_finance_category: { primary: 'ENTERTAINMENT', detailed: 'ENTERTAINMENT_VIDEO_GAMES' },
  })]);
  const [tx] = await getTransactionsByIds(['w1']);
  expect(tx.plaid_category).toBe('ENTERTAINMENT_VIDEO_GAMES');
});

test('web: upsertTransactions stores null when Plaid sends no category', async () => {
  await upsertTransactions([plaidTx('w2')]);
  const [tx] = await getTransactionsByIds(['w2']);
  expect(tx.plaid_category ?? null).toBeNull();
});

test('web: merchant memory round-trips', async () => {
  await initDb();
  await setMerchantBucket('starbucks', 'needs');
  await setMerchantBucket('amazon', 'shopping');
  await expect(getMerchantBuckets()).resolves.toEqual({ starbucks: 'needs', amazon: 'shopping' });
});

test('web: setMerchantBucket overwrites an existing key', async () => {
  await initDb();
  await setMerchantBucket('starbucks', 'needs');
  await setMerchantBucket('starbucks', 'food');
  await expect(getMerchantBuckets()).resolves.toEqual({ starbucks: 'food' });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- db.test.ts db.web.test.ts`
Expected: FAIL — `getMerchantBuckets is not a function`, and the migration assertions fail.

- [ ] **Step 3: Extend the types**

In `mobile/lib/types.ts`, add the import and extend the two interfaces:

```ts
import type { Bucket, BucketSource } from '@/lib/buckets';
```

Add to `Transaction`:

```ts
  // Spending tracker. `bucket` is NULL until the transaction is committed by a
  // skip or a split — that is what keeps uncommitted transactions, and every
  // transaction that predates this feature, out of the tracker.
  bucket?: Bucket | null;
  bucket_source?: BucketSource | null;
  plaid_category?: string | null;   // personal_finance_category.detailed
```

Add to `PlaidTransaction`:

```ts
  // Plaid's own categorization, forwarded untouched by the Worker. Seeds the
  // spending bucket; absent on some institutions' feeds.
  personal_finance_category?: {
    primary: string;
    detailed: string;
    confidence_level?: string;
  } | null;
```

- [ ] **Step 4: Add migration v6 to `db.ts`**

In `openDatabase`, after the `if (version < 5)` ALTER block and **before** the trailing version stamp, add:

```ts
  if (version < 6) {
    // Same rationale as vacation_id above: these columns are not in the base
    // `version < 1` CREATE TABLE, so these ALTERs must run ungated so a fresh
    // install (version 0) gets them too.
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN bucket TEXT;`);
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN bucket_source TEXT;`);
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN plaid_category TEXT;`);
    await d.execAsync(`
      CREATE TABLE IF NOT EXISTS merchant_buckets (
        merchant_key TEXT PRIMARY KEY,
        bucket       TEXT NOT NULL,
        updated_at   TEXT NOT NULL
      );
    `);
  }
```

Then change **both** trailing guards from 5 to 6:

```ts
  if (version < 6) {
    await d.execAsync(`PRAGMA user_version = 6;`);
  }
```

Update the comment above that guard, which instructs the reader to keep the literal in sync with the highest block.

- [ ] **Step 5: Store the category in `db.ts`'s `upsertTransactions`**

Replace the body of the loop's two statements:

```ts
    const category = tx.personal_finance_category?.detailed ?? null;
    await d.runAsync(
      `INSERT OR IGNORE INTO transactions (id, merchant_name, amount, currency, date, status, pending, created_at, vacation_id, plaid_category)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?, ?)`,
      [tx.transaction_id, name, tx.amount, currency, tx.date, pending, now, activeVacationId, category]
    );
    // UPDATE only if still 'new' (don't overwrite user decisions)
    await d.runAsync(
      `UPDATE transactions SET merchant_name = ?, amount = ?, date = ?, pending = ?, plaid_category = ?
       WHERE id = ? AND status = 'new'`,
      [name, tx.amount, tx.date, pending, category, tx.transaction_id]
    );
```

- [ ] **Step 6: Add merchant memory to `db.ts`**

Add near the other transaction helpers:

```ts
/** Every learned merchant → bucket override, keyed by normalized merchant name. */
export async function getMerchantBuckets(): Promise<Record<string, Bucket>> {
  const rows = await (await dbReady()).getAllAsync<{ merchant_key: string; bucket: Bucket }>(
    `SELECT merchant_key, bucket FROM merchant_buckets`,
    []
  );
  return Object.fromEntries(rows.map((r) => [r.merchant_key, r.bucket]));
}

/** Remember that this merchant belongs in this bucket, for future transactions. */
export async function setMerchantBucket(merchantKey: string, bucket: Bucket): Promise<void> {
  if (!merchantKey) return;
  await (await dbReady()).runAsync(
    `INSERT INTO merchant_buckets (merchant_key, bucket, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(merchant_key) DO UPDATE SET bucket = excluded.bucket, updated_at = excluded.updated_at`,
    [merchantKey, bucket, new Date().toISOString()]
  );
}
```

Add `import { Bucket } from '@/lib/buckets';` at the top of `db.ts`.

- [ ] **Step 7: Mirror everything in `db.web.ts`**

Bump the version and add the store:

```ts
const DB_VERSION = 3;
const MERCHANT_STORE = 'merchant_buckets';
```

In `openDatabase`'s `onupgradeneeded`, alongside the existing store creations:

```ts
      if (!d.objectStoreNames.contains(MERCHANT_STORE)) {
        // Keyed by the normalized merchant name, mirroring the SQLite
        // merchant_buckets PRIMARY KEY.
        d.createObjectStore(MERCHANT_STORE, { keyPath: 'merchant_key' });
      }
```

IndexedDB records are schemaless, so `bucket`, `bucket_source`, and
`plaid_category` need no migration — absent fields simply read as `undefined`.
Only the new store requires the version bump.

In `upsertTransactions`, add the category to the insert and the refresh:

```ts
    const category = p.personal_finance_category?.detailed ?? null;
    if (!existing) {
      store.put({
        id: p.transaction_id,
        merchant_name: name,
        amount: p.amount,
        currency: p.iso_currency_code ?? 'USD',
        date: p.date,
        status: 'new',
        pending: p.pending,
        created_at: now,
        vacation_id: activeVacationId,
        plaid_category: category,
      } satisfies Transaction);
    } else if (existing.status === 'new') {
      store.put({
        ...existing,
        merchant_name: name, amount: p.amount, date: p.date, pending: p.pending,
        plaid_category: category,
      });
    }
```

Add the memory functions:

```ts
export async function getMerchantBuckets(): Promise<Record<string, Bucket>> {
  const tx = (await dbReady()).transaction(MERCHANT_STORE, 'readonly');
  const rows = await req(
    tx.objectStore(MERCHANT_STORE).getAll() as IDBRequest<{ merchant_key: string; bucket: Bucket }[]>
  );
  await done(tx);
  return Object.fromEntries(rows.map((r) => [r.merchant_key, r.bucket]));
}

export async function setMerchantBucket(merchantKey: string, bucket: Bucket): Promise<void> {
  if (!merchantKey) return;
  const tx = (await dbReady()).transaction(MERCHANT_STORE, 'readwrite');
  tx.objectStore(MERCHANT_STORE).put({
    merchant_key: merchantKey,
    bucket,
    updated_at: new Date().toISOString(),
  });
  await done(tx);
}
```

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS, including `db.parity.test.ts` (both new functions exist on both sides).

- [ ] **Step 9: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add mobile/lib/types.ts mobile/lib/db.ts mobile/lib/db.web.ts \
        mobile/__tests__/lib/db.test.ts mobile/__tests__/lib/db.web.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): store Plaid category and learned merchant buckets

Migration v6 adds bucket, bucket_source, and plaid_category to
transactions plus a merchant_buckets table; the web build gets the
matching IndexedDB store at DB_VERSION 3. upsertTransactions now
persists personal_finance_category.detailed, which the Worker was
already forwarding untouched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Materialize buckets on commit, and manual re-tagging

**Files:**
- Modify: `mobile/lib/vacationErrors.ts`
- Modify: `mobile/lib/db.ts` (`updateTransactionStatus`, new helpers)
- Modify: `mobile/lib/db.web.ts` (`updateTransactionStatus`, `persistCombinedSplit`, `revertCombinedSplit`, new helpers)
- Test: `mobile/__tests__/lib/db.test.ts`, `mobile/__tests__/lib/db.web.test.ts`

**Interfaces:**
- Consumes: `resolveBucket`, `normalizeMerchant`, `Bucket` from Task 1; `getMerchantBuckets`, `setMerchantBucket` from Task 3.
- Produces: `setTransactionBucket(id: string, bucket: Bucket): Promise<void>` on **both** `db.ts` and `db.web.ts`; `BucketLockedError` from `lib/vacationErrors.ts`.

**Two implementation hazards, read both before writing code:**

1. **Native:** `persistCombinedSplit` already calls `updateTransactionStatus` inside its `withTransactionAsync`, so putting materialization inside `updateTransactionStatus` covers combined splits automatically. Do **not** also add it to `persistCombinedSplit` — it would run twice.
2. **Web:** `persistCombinedSplit` does **not** call `updateTransactionStatus`; it writes `status` inline. It needs materialization added separately. And an IndexedDB transaction auto-commits as soon as the microtask queue drains with no pending request against it, so `getMerchantBuckets()` — which opens its *own* transaction — must be awaited **before** opening the readwrite transaction, never inside it.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/__tests__/lib/db.web.test.ts` — the web suite uses a real (fake) IndexedDB, so it can assert on actual stored values rather than SQL strings. This is where the behavior gets pinned down:

```ts
test('web: skipping materializes an auto bucket from the Plaid category', async () => {
  await upsertTransactions([plaidTx('b1', {
    merchant_name: 'Safeway',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  })]);
  await updateTransactionStatus('b1', 'skipped');
  const [tx] = await getTransactionsByIds(['b1']);
  expect(tx.bucket).toBe('needs');
  expect(tx.bucket_source).toBe('auto');
});

test('web: an uncommitted transaction has no bucket', async () => {
  await upsertTransactions([plaidTx('b2', { merchant_name: 'Safeway' })]);
  const [tx] = await getTransactionsByIds(['b2']);
  expect(tx.bucket ?? null).toBeNull();
});

test('web: merchant memory beats the Plaid category at commit time', async () => {
  await setMerchantBucket('safeway', 'shopping');
  await upsertTransactions([plaidTx('b3', {
    merchant_name: 'Safeway',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  })]);
  await updateTransactionStatus('b3', 'skipped');
  const [tx] = await getTransactionsByIds(['b3']);
  expect(tx.bucket).toBe('shopping');
});

test('web: a pre-commit manual tag survives the commit', async () => {
  await upsertTransactions([plaidTx('b4', {
    merchant_name: 'Safeway',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  })]);
  await setTransactionBucket('b4', 'experiences');
  await updateTransactionStatus('b4', 'split');
  const [tx] = await getTransactionsByIds(['b4']);
  expect(tx.bucket).toBe('experiences');
  expect(tx.bucket_source).toBe('manual');
});

test('web: a vacation transaction commits to travel regardless of category', async () => {
  const v = await createVacation({ name: 'Trip', start_date: '2026-09-01', end_date: '2026-09-08' });
  await upsertTransactions([plaidTx('b5', {
    merchant_name: 'Best Buy',
    personal_finance_category: { primary: 'GENERAL_MERCHANDISE', detailed: 'GENERAL_MERCHANDISE_ELECTRONICS' },
  })]);
  await assignTransactionsToVacation(v.id, ['b5']);
  await updateTransactionStatus('b5', 'skipped');
  const [tx] = await getTransactionsByIds(['b5']);
  expect(tx.bucket).toBe('travel');
  expect(tx.bucket_source).toBe('vacation');
});

test('web: setTransactionBucket refuses to re-tag a vacation transaction', async () => {
  const v = await createVacation({ name: 'Trip2', start_date: '2026-10-01', end_date: '2026-10-08' });
  await upsertTransactions([plaidTx('b6')]);
  await assignTransactionsToVacation(v.id, ['b6']);
  await expect(setTransactionBucket('b6', 'food')).rejects.toThrow(BucketLockedError);
});

test('web: setTransactionBucket teaches the merchant memory', async () => {
  await upsertTransactions([plaidTx('b7', { merchant_name: 'STARBUCKS #4471' })]);
  await setTransactionBucket('b7', 'needs');
  await expect(getMerchantBuckets()).resolves.toMatchObject({ starbucks: 'needs' });
});

test('web: re-tagging is forward-only and leaves already-bucketed rows alone', async () => {
  await upsertTransactions([
    plaidTx('b8', { merchant_name: 'Chipotle' }),
    plaidTx('b9', { merchant_name: 'Chipotle' }),
  ]);
  await updateTransactionStatus('b8', 'skipped');   // commits as food, via keyword
  await updateTransactionStatus('b9', 'skipped');
  await setTransactionBucket('b9', 'needs');        // re-tag one of them
  const [older] = await getTransactionsByIds(['b8']);
  expect(older.bucket).toBe('food');                // unchanged
});

test('web: combined splits materialize a bucket for every member', async () => {
  await upsertTransactions([
    plaidTx('c1', { merchant_name: 'Chipotle', amount: 20 }),
    plaidTx('c2', { merchant_name: 'AMC Theatres', amount: 30 }),
  ]);
  await persistCombinedSplit([
    { id: 'd1', transaction_id: 'c1', splitwise_expense_id: 'e1', friend_ids: ['f1'], friend_names: ['A'], amount_each: 25, created_at: '2026-08-01T00:00:00Z' },
    { id: 'd2', transaction_id: 'c2', splitwise_expense_id: 'e1', friend_ids: ['f1'], friend_names: ['A'], amount_each: 25, created_at: '2026-08-01T00:00:00Z' },
  ]);
  const rows = await getTransactionsByIds(['c1', 'c2']);
  expect(rows.find((r) => r.id === 'c1')!.bucket).toBe('food');
  expect(rows.find((r) => r.id === 'c2')!.bucket).toBe('experiences');
});

test('web: reverting to new drops an auto bucket but keeps a manual one', async () => {
  await upsertTransactions([
    plaidTx('r1', { merchant_name: 'Chipotle' }),
    plaidTx('r2', { merchant_name: 'Chipotle' }),
  ]);
  await updateTransactionStatus('r1', 'skipped');
  await setTransactionBucket('r2', 'shopping');
  await updateTransactionStatus('r2', 'skipped');

  await updateTransactionStatus('r1', 'new');
  await updateTransactionStatus('r2', 'new');

  const rows = await getTransactionsByIds(['r1', 'r2']);
  expect(rows.find((r) => r.id === 'r1')!.bucket ?? null).toBeNull();
  expect(rows.find((r) => r.id === 'r2')!.bucket).toBe('shopping');
});
```

Add `setTransactionBucket` to the `db.web` import list, and `BucketLockedError` to the `@/lib/vacationErrors` import.

Append to `mobile/__tests__/lib/db.test.ts` (mock-based, so assert on the SQL issued):

```ts
test('updateTransactionStatus materializes a bucket when committing', async () => {
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([]); // merchant_buckets
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Safeway', plaid_category: 'FOOD_AND_DRINK_GROCERIES', bucket: null, vacation_id: null },
  ]);
  await updateTransactionStatus('tx1', 'skipped');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('SET bucket = ?, bucket_source = ?'),
    ['needs', 'auto', 'tx1']
  );
});

test('updateTransactionStatus clears an auto bucket when reverting to new', async () => {
  await initDb();
  await updateTransactionStatus('tx1', 'new');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining("bucket_source = 'auto'"),
    ['tx1']
  );
});

test('setTransactionBucket writes the bucket and teaches the merchant', async () => {
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce({ merchant_name: 'STARBUCKS #4471', vacation_id: null });
  await setTransactionBucket('tx1', 'needs');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining("bucket_source = 'manual'"),
    ['needs', 'tx1']
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO merchant_buckets'),
    expect.arrayContaining(['starbucks', 'needs'])
  );
});

test('setTransactionBucket rejects a vacation transaction', async () => {
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce({ merchant_name: 'Cafe', vacation_id: 'v1' });
  await expect(setTransactionBucket('tx1', 'food')).rejects.toThrow(BucketLockedError);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- db.test.ts db.web.test.ts`
Expected: FAIL — `setTransactionBucket is not a function`, `BucketLockedError` undefined.

- [ ] **Step 3: Add the error type**

Append to `mobile/lib/vacationErrors.ts`:

```ts
/**
 * Thrown when something tries to re-tag a transaction that belongs to a
 * vacation. A trip's spend is Travel by definition; the way out is to remove
 * the transaction from the trip, not to relabel it.
 */
export class BucketLockedError extends Error {
  constructor(message = 'This transaction is part of a vacation, so it counts as Travel.') {
    super(message);
    this.name = 'BucketLockedError';
  }
}
```

- [ ] **Step 4: Implement in `db.ts`**

Add the imports at the top:

```ts
import { Bucket, resolveBucket, normalizeMerchant } from '@/lib/buckets';
import { VacationConflictError, BucketLockedError } from '@/lib/vacationErrors';
```

Add the internal helper:

```ts
// Resolve and write the bucket for rows being committed. Called from
// updateTransactionStatus, which every commit path funnels through — including
// persistCombinedSplit, which calls it per member inside its own transaction.
async function materializeBuckets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const d = await dbReady();
  const memory = await getMerchantBuckets();
  const placeholders = ids.map(() => '?').join(',');
  const rows = await d.getAllAsync<{
    id: string; merchant_name: string; plaid_category: string | null;
    bucket: Bucket | null; vacation_id: string | null;
  }>(
    `SELECT id, merchant_name, plaid_category, bucket, vacation_id
     FROM transactions WHERE id IN (${placeholders})`,
    ids
  );
  for (const r of rows) {
    const { bucket, source } = resolveBucket(r, memory);
    await d.runAsync(
      `UPDATE transactions SET bucket = ?, bucket_source = ? WHERE id = ?`,
      [bucket, source, r.id]
    );
  }
}
```

Replace `updateTransactionStatus`:

```ts
export async function updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  const d = await dbReady();
  await d.runAsync(`UPDATE transactions SET status = ? WHERE id = ?`, [status, id]);
  if (status === 'split' || status === 'skipped') {
    await materializeBuckets([id]);
  } else {
    // Back to 'new': drop an auto guess so it re-resolves against current
    // merchant memory if it is committed again. A manual choice is the user's
    // and survives.
    await d.runAsync(
      `UPDATE transactions SET bucket = NULL, bucket_source = NULL
       WHERE id = ? AND bucket_source = 'auto'`,
      [id]
    );
  }
}
```

Add the manual re-tag:

```ts
/**
 * Move a transaction to a bucket by hand, and remember the merchant for next
 * time. Forward-only: transactions already committed under the old bucket are
 * left alone, so a month the user has already reviewed keeps its numbers.
 */
export async function setTransactionBucket(id: string, bucket: Bucket): Promise<void> {
  const d = await dbReady();
  const row = await d.getFirstAsync<{ merchant_name: string; vacation_id: string | null }>(
    `SELECT merchant_name, vacation_id FROM transactions WHERE id = ?`,
    [id]
  );
  if (!row) return;
  if (row.vacation_id) throw new BucketLockedError();

  await d.runAsync(
    `UPDATE transactions SET bucket = ?, bucket_source = 'manual' WHERE id = ?`,
    [bucket, id]
  );
  await setMerchantBucket(normalizeMerchant(row.merchant_name), bucket);
}
```

- [ ] **Step 5: Implement in `db.web.ts`**

Add the same imports. Add two helpers near the top:

```ts
function withResolvedBucket(row: Transaction, memory: Record<string, Bucket>): Transaction {
  const { bucket, source } = resolveBucket(row, memory);
  return { ...row, bucket, bucket_source: source };
}

// Reverting to 'new' drops an auto guess but keeps a manual choice.
function withClearedAutoBucket(row: Transaction): Transaction {
  return row.bucket_source === 'auto' ? { ...row, bucket: null, bucket_source: null } : row;
}
```

Replace `updateTransactionStatus`. Note the memory read happens **before** the
readwrite transaction opens:

```ts
export async function updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  const committing = status === 'split' || status === 'skipped';
  // Read the memory first: getMerchantBuckets opens its own IDB transaction,
  // and awaiting it inside the readwrite one below would let that transaction
  // auto-commit out from under us.
  const memory = committing ? await getMerchantBuckets() : {};

  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
  if (existing) {
    const next = { ...existing, status };
    store.put(committing ? withResolvedBucket(next, memory) : withClearedAutoBucket(next));
  }
  await done(tx);
}
```

In `persistCombinedSplit` — which writes `status` inline rather than calling
`updateTransactionStatus`, so it needs its own materialization — read the
memory before opening the transaction and wrap the write:

```ts
export async function persistCombinedSplit(decisions: SplitDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  const memory = await getMerchantBuckets();
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const rows = await Promise.all(
    decisions.map((d) => req(txStore.get(d.transaction_id) as IDBRequest<Transaction | undefined>)),
  );
  decisions.forEach((d, i) => {
    tx.objectStore(DECISION_STORE).add(d);
    const existing = rows[i];
    if (existing) txStore.put(withResolvedBucket({ ...existing, status: 'split' }, memory));
  });
  await done(tx);
}
```

In `revertCombinedSplit`, change the write to:

```ts
    if (existing) txStore.put(withClearedAutoBucket({ ...existing, status: 'new' }));
```

Add the manual re-tag:

```ts
export async function setTransactionBucket(id: string, bucket: Bucket): Promise<void> {
  const read = (await dbReady()).transaction(TX_STORE, 'readonly');
  const row = await req(read.objectStore(TX_STORE).get(id) as IDBRequest<Transaction | undefined>);
  await done(read);
  if (!row) return;
  if (row.vacation_id) throw new BucketLockedError();

  const write = (await dbReady()).transaction(TX_STORE, 'readwrite');
  write.objectStore(TX_STORE).put({ ...row, bucket, bucket_source: 'manual' });
  await done(write);

  await setMerchantBucket(normalizeMerchant(row.merchant_name), bucket);
}
```

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS, including `db.parity.test.ts`.

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add mobile/lib/vacationErrors.ts mobile/lib/db.ts mobile/lib/db.web.ts \
        mobile/__tests__/lib/db.test.ts mobile/__tests__/lib/db.web.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): materialize spending buckets on skip and split

A transaction's bucket is written the moment it is committed, so
`bucket IS NULL` means "not yet routed" — which keeps uncommitted and
pre-existing transactions out of the tracker without a backfill.
Manual re-tagging teaches a merchant memory that applies forward only,
and vacation transactions are locked to Travel.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Skip transactions inside a vacation

**Files:**
- Modify: `mobile/components/TransactionRow.tsx`
- Modify: `mobile/app/vacation/[id].tsx`
- Test: `mobile/__tests__/components/TransactionRow.test.tsx`

**Interfaces:**
- Consumes: `updateTransactionStatus` (Task 4 already materializes the bucket inside it).
- Produces: `TransactionRow` prop shape `{ transaction, onSkip, onSplit, onRemove?, onLongPress?, selectMode?, selected?, onToggleSelect? }`. The `variant` prop is **removed**.

**Why this task exists:** today the vacation screen renders `TransactionRow` with `variant="remove"`, so the only actions on a trip expense are Split and Remove-from-vacation. A trip expense the user paid entirely themselves cannot be committed at all — it is either split with someone or ejected from the trip. Nothing would ever route it to Travel.

**The behavior change:** in vacation mode the swipe-right underlay becomes **Remove from vacation** (where the destructive action effectively already lives, since `onSwipeableOpen` currently calls `onSkip`, which the vacation screen wires to `handleRemove`), and the two inline buttons become **Skip** and **Split**, matching the main list.

`updateTransactionStatus(id, 'skipped')` only touches `status`, so `vacation_id` survives, and `getVacationHistory` already selects `status IN ('split','skipped')` — the skipped transaction appears in the trip's history section with **no query change**.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/__tests__/components/TransactionRow.test.tsx`:

```ts
test('without onRemove, there is no remove affordance and swipe skips', () => {
  const onSkip = jest.fn();
  render(<TransactionRow transaction={tx} onSkip={onSkip} onSplit={jest.fn()} />);
  expect(screen.queryByLabelText('Remove Amazon from vacation')).toBeNull();
  fireEvent.press(screen.getByLabelText('Skip Amazon'));
  expect(onSkip).toHaveBeenCalled();
});

test('with onRemove, both skip and split stay available inline', () => {
  const onSkip = jest.fn();
  const onSplit = jest.fn();
  render(
    <TransactionRow transaction={tx} onSkip={onSkip} onSplit={onSplit} onRemove={jest.fn()} />
  );
  fireEvent.press(screen.getByLabelText('Skip Amazon'));
  expect(onSkip).toHaveBeenCalled();
  fireEvent.press(screen.getByLabelText('Split Amazon'));
  expect(onSplit).toHaveBeenCalled();
});

test('with onRemove, the swipe underlay removes rather than skips', () => {
  const onSkip = jest.fn();
  const onRemove = jest.fn();
  render(
    <TransactionRow transaction={tx} onSkip={onSkip} onSplit={jest.fn()} onRemove={onRemove} />
  );
  fireEvent.press(screen.getByLabelText('Remove Amazon from vacation'));
  expect(onRemove).toHaveBeenCalled();
  expect(onSkip).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- TransactionRow.test.tsx`
Expected: FAIL — no element labelled `Remove Amazon from vacation`.

- [ ] **Step 3: Rework `TransactionRow`**

Replace the props interface and the derived labels:

```tsx
interface Props {
  transaction: Transaction;
  onSkip: () => void;
  onSplit: () => void;
  // Supplied only in vacation mode. Its presence moves "remove from vacation"
  // onto the swipe underlay and keeps Skip inline, so a trip expense paid
  // entirely by the user can still be committed (and counted as Travel)
  // instead of only being splittable or ejectable.
  onRemove?: () => void;
  onLongPress?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}

export function TransactionRow({
  transaction, onSkip, onSplit, onRemove, onLongPress,
  selectMode, selected, onToggleSelect,
}: Props) {
  const amount = `$${transaction.amount.toFixed(2)}`;
  const date = formatDayLabel(transaction.date);
  const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
  const avatarBg = merchantColor(transaction.merchant_name ?? '?');
  const skipLabel = `Skip ${transaction.merchant_name}`;
  const removeLabel = `Remove ${transaction.merchant_name} from vacation`;
```

Replace the underlay renderer so it removes when `onRemove` is given and skips otherwise:

```tsx
  const underlayAction = onRemove ?? onSkip;
  const renderUnderlay = () => (
    <Pressable
      style={styles.skipUnderlay}
      onPress={underlayAction}
      accessibilityRole="button"
      accessibilityLabel={onRemove ? removeLabel : skipLabel}
    >
      <Ionicons
        name={onRemove ? 'trash-outline' : 'close-circle-outline'}
        size={22}
        color={Colors.textSecondary}
      />
      <Text style={styles.skipUnderlayText}>{onRemove ? 'Remove' : 'Skip'}</Text>
    </Pressable>
  );
```

In the `ReanimatedSwipeable` props, use `renderLeftActions={renderUnderlay}` and:

```tsx
      onSwipeableOpen={(direction) => {
        // 'left' = the left underlay opened, i.e. the user swiped right
        if (direction === 'left') underlayAction();
      }}
```

The inline skip button is now always a skip:

```tsx
          <Pressable
            style={({ pressed }) => [styles.btn, styles.skipBtn, pressed && styles.skipBtnPressed]}
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel={skipLabel}
          >
            <Ionicons name="close-outline" size={14} color={Colors.textSecondary} />
          </Pressable>
```

Delete the now-unused `removeMode`, `skipIcon`, `skipBtnIcon`, `skipUnderlayLabel` locals and the `variant` prop entirely.

- [ ] **Step 4: Wire the vacation screen**

In `mobile/app/vacation/[id].tsx`, import the db function:

```ts
import {
  getVacationPendingTransactions, getVacationHistory, removeTransactionFromVacation,
  updateTransactionStatus,
} from '@/lib/db';
```

Add the handler next to `handleRemove`:

```tsx
  async function handleSkip(txId: string) {
    try {
      // status only — vacation_id survives, so this stays trip spend and
      // materializes into the Travel bucket at its full amount.
      await updateTransactionStatus(txId, 'skipped');
      refresh();
    } catch {
      toast.show('Could not skip transaction. Please try again.', 'error');
    }
  }
```

Update the `renderItem` for the pending list:

```tsx
          <TransactionRow
            transaction={item}
            onSkip={() => handleSkip(item.id)}
            onRemove={() => handleRemove(item.id)}
            onSplit={() => openCombine([item])}
            onLongPress={() => { setSelectMode(true); setSelectedIds(new Set([item.id])); }}
            selectMode={selectMode}
            selected={selectedIds.has(item.id)}
            onToggleSelect={() => toggleSelect(item.id)}
          />
```

- [ ] **Step 5: Check for other `variant` users**

Run: `grep -rn "variant" mobile/app mobile/components --include=*.tsx`
Expected: no remaining references to `variant="remove"` or the `variant` prop. Fix any that turn up.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add mobile/components/TransactionRow.tsx mobile/app/vacation/\[id\].tsx \
        mobile/__tests__/components/TransactionRow.test.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): allow skipping transactions inside a vacation

Vacation mode offered only Split and Remove, so a trip expense paid
entirely by the user could never be committed. Remove now lives on the
swipe underlay and Skip joins Split inline, matching the main list. The
skipped transaction keeps its vacation_id and appears in the trip's
history with no query change.

Replaces the `variant` prop with an explicit optional `onRemove`.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The spending query and store

**Files:**
- Modify: `mobile/lib/db.ts`, `mobile/lib/db.web.ts`
- Create: `mobile/stores/spendStore.ts`
- Test: `mobile/__tests__/lib/db.web.test.ts`, `mobile/__tests__/stores/spendStore.test.ts`

**Interfaces:**
- Consumes: `SpendRow`, `MonthSpend`, `aggregateMonth`, `availableMonths` from Task 2; `setTransactionBucket` from Task 4.
- Produces: `getSpendingRows(): Promise<SpendRow[]>` on both db modules. Store shape:

```ts
interface SpendState {
  rows: SpendRow[];
  months: string[];          // newest first
  monthKey: string;          // selected month
  drill: BucketGroup | null; // null = top level; 'wants' = drilled in
  isLoading: boolean;
  load: () => Promise<void>;
  selectMonth: (monthKey: string) => void;
  stepMonth: (delta: number) => void;
  setDrill: (group: BucketGroup | null) => void;
  setBucket: (transactionId: string, bucket: Bucket) => Promise<void>;
  current: () => MonthSpend;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `mobile/__tests__/lib/db.web.test.ts`:

```ts
test('web: getSpendingRows returns only committed, bucketed rows', async () => {
  await upsertTransactions([
    plaidTx('s1', { merchant_name: 'Chipotle' }),
    plaidTx('s2', { merchant_name: 'Safeway' }),
    plaidTx('s3', { merchant_name: 'Uncommitted' }),
  ]);
  await updateTransactionStatus('s1', 'skipped');
  await updateTransactionStatus('s2', 'skipped');
  const rows = await getSpendingRows();
  expect(rows.map((r) => r.id).sort()).toEqual(['s1', 's2']);
});

test('web: getSpendingRows joins the split decision and the vacation', async () => {
  const v = await createVacation({ name: 'Trip', start_date: '2026-09-01', end_date: '2026-09-08' });
  await upsertTransactions([plaidTx('s4', { amount: 50 })]);
  await assignTransactionsToVacation(v.id, ['s4']);
  await insertSplitDecision({
    id: 'd4', transaction_id: 's4', splitwise_expense_id: 'e4',
    friend_ids: ['f1'], friend_names: ['A'], amount_each: 25,
    created_at: '2026-08-01T00:00:00Z',
  });
  await updateTransactionStatus('s4', 'split');

  const row = (await getSpendingRows()).find((r) => r.id === 's4')!;
  expect(row.splitwise_expense_id).toBe('e4');
  expect(row.amount_each).toBe(25);
  expect(row.vacation_start_date).toBe('2026-09-01');
  expect(row.bucket).toBe('travel');
});

```

Create `mobile/__tests__/stores/spendStore.test.ts`:

```ts
jest.mock('@/lib/db', () => ({
  getSpendingRows: jest.fn(),
  setTransactionBucket: jest.fn(),
}));

import { getSpendingRows, setTransactionBucket } from '@/lib/db';
import { useSpendStore } from '@/stores/spendStore';
import { SpendRow } from '@/lib/spend';

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    id: 'tx1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-08-10',
    status: 'skipped', bucket: 'food', bucket_source: 'auto',
    splitwise_expense_id: null, amount_each: null, vacation_id: null,
    vacation_start_date: null, vacation_started_at: null, vacation_created_at: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useSpendStore.setState({ rows: [], months: [], monthKey: '', drill: null, isLoading: false });
});

test('load populates rows, months, and selects the newest month', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-06-02' }),
    row({ id: 'b', date: '2026-08-02' }),
  ]);
  await useSpendStore.getState().load();
  const s = useSpendStore.getState();
  expect(s.months).toEqual(['2026-08', '2026-06']);
  expect(s.monthKey).toBe('2026-08');
});

test('load keeps the selected month if it still has data', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-06-02' }),
    row({ id: 'b', date: '2026-08-02' }),
  ]);
  await useSpendStore.getState().load();
  useSpendStore.getState().selectMonth('2026-06');
  await useSpendStore.getState().load();
  expect(useSpendStore.getState().monthKey).toBe('2026-06');
});

test('stepMonth walks the available months and clamps at both ends', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-06-02' }),
    row({ id: 'b', date: '2026-07-02' }),
    row({ id: 'c', date: '2026-08-02' }),
  ]);
  await useSpendStore.getState().load();
  expect(useSpendStore.getState().monthKey).toBe('2026-08');

  useSpendStore.getState().stepMonth(-1);
  expect(useSpendStore.getState().monthKey).toBe('2026-07');
  useSpendStore.getState().stepMonth(-1);
  useSpendStore.getState().stepMonth(-1); // already at the oldest
  expect(useSpendStore.getState().monthKey).toBe('2026-06');

  useSpendStore.getState().stepMonth(1);
  expect(useSpendStore.getState().monthKey).toBe('2026-07');
  useSpendStore.getState().stepMonth(1);
  useSpendStore.getState().stepMonth(1); // already at the newest
  expect(useSpendStore.getState().monthKey).toBe('2026-08');
});

test('current aggregates the selected month', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-08-02', amount: 100, bucket: 'needs' }),
    row({ id: 'b', date: '2026-08-03', amount: 40, bucket: 'food' }),
  ]);
  await useSpendStore.getState().load();
  const m = useSpendStore.getState().current();
  expect(m.totalCents).toBe(14000);
  expect(m.byGroup.needs).toBe(10000);
  expect(m.byGroup.wants).toBe(4000);
});

test('setBucket writes through and reloads', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([row({ id: 'a', date: '2026-08-02' })]);
  await useSpendStore.getState().load();
  await useSpendStore.getState().setBucket('a', 'shopping');
  expect(setTransactionBucket).toHaveBeenCalledWith('a', 'shopping');
  expect(getSpendingRows).toHaveBeenCalledTimes(2);
});

test('setDrill toggles the drill level', () => {
  useSpendStore.getState().setDrill('wants');
  expect(useSpendStore.getState().drill).toBe('wants');
  useSpendStore.getState().setDrill(null);
  expect(useSpendStore.getState().drill).toBeNull();
});

test('load resets the drill level', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([row({ id: 'a', date: '2026-08-02' })]);
  useSpendStore.getState().setDrill('wants');
  await useSpendStore.getState().load();
  expect(useSpendStore.getState().drill).toBeNull();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- spendStore.test.ts db.web.test.ts`
Expected: FAIL — `Cannot find module '@/stores/spendStore'`, `getSpendingRows is not a function`.

- [ ] **Step 3: Add `getSpendingRows` to `db.ts`**

```ts
/**
 * Every committed, bucketed transaction, joined to its split decision and its
 * vacation. `bucket IS NOT NULL` is what excludes both uncommitted
 * transactions and everything that predates the spending tracker.
 *
 * The vacation join supplies the dates monthKeyOf needs, so editing a trip's
 * dates moves its whole spend to the new month without a rewrite.
 */
export async function getSpendingRows(): Promise<SpendRow[]> {
  return (await dbReady()).getAllAsync<SpendRow>(
    `SELECT t.id, t.merchant_name, t.amount, t.currency, t.date, t.status,
            t.bucket, t.bucket_source, t.vacation_id,
            s.splitwise_expense_id, s.amount_each,
            v.start_date  AS vacation_start_date,
            v.started_at  AS vacation_started_at,
            v.created_at  AS vacation_created_at
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     LEFT JOIN vacations v       ON v.id = t.vacation_id
     WHERE t.status IN ('split','skipped') AND t.bucket IS NOT NULL
     ORDER BY t.date DESC`,
    []
  );
}
```

Add `import { SpendRow } from '@/lib/spend';` at the top of `db.ts`.

- [ ] **Step 4: Add `getSpendingRows` to `db.web.ts`**

```ts
export async function getSpendingRows(): Promise<SpendRow[]> {
  const d = await dbReady();
  const tx = d.transaction([TX_STORE, DECISION_STORE, VACATION_STORE], 'readonly');
  const [txs, decisions, vacations] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
    req(tx.objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>),
  ]);
  await done(tx);

  const byTxId = new Map(decisions.map((d2) => [d2.transaction_id, d2]));
  const byVacationId = new Map(vacations.map((v) => [v.id, v]));

  return txs
    .filter((t) => (t.status === 'split' || t.status === 'skipped') && t.bucket)
    .map((t) => {
      const decision = byTxId.get(t.id);
      const vacation = t.vacation_id ? byVacationId.get(t.vacation_id) : undefined;
      return {
        id: t.id,
        merchant_name: t.merchant_name,
        amount: t.amount,
        currency: t.currency,
        date: t.date,
        status: t.status as 'split' | 'skipped',
        bucket: t.bucket!,
        bucket_source: t.bucket_source ?? 'auto',
        splitwise_expense_id: decision?.splitwise_expense_id ?? null,
        amount_each: decision?.amount_each ?? null,
        vacation_id: t.vacation_id ?? null,
        vacation_start_date: vacation?.start_date ?? null,
        vacation_started_at: vacation?.started_at ?? null,
        vacation_created_at: vacation?.created_at ?? null,
      } satisfies SpendRow;
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
```

- [ ] **Step 5: Create the store**

Create `mobile/stores/spendStore.ts`:

```ts
// mobile/stores/spendStore.ts
import { create } from 'zustand';
import { getSpendingRows, setTransactionBucket } from '@/lib/db';
import { Bucket, BucketGroup } from '@/lib/buckets';
import {
  SpendRow, MonthSpend, aggregateMonth, availableMonths,
} from '@/lib/spend';

interface SpendState {
  rows: SpendRow[];
  months: string[];             // newest first
  monthKey: string;
  drill: BucketGroup | null;    // null = top level
  isLoading: boolean;
  load: () => Promise<void>;
  selectMonth: (monthKey: string) => void;
  stepMonth: (delta: number) => void;
  setDrill: (group: BucketGroup | null) => void;
  setBucket: (transactionId: string, bucket: Bucket) => Promise<void>;
  current: () => MonthSpend;
}

export const useSpendStore = create<SpendState>((set, get) => ({
  rows: [],
  months: [],
  monthKey: '',
  drill: null,
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    const rows = await getSpendingRows();
    const months = availableMonths(rows);
    const previous = get().monthKey;
    // Keep the month the user was looking at if it still has data; otherwise
    // fall back to the newest one.
    const monthKey = months.includes(previous) ? previous : (months[0] ?? '');
    // Any reload can change which buckets exist, so return to the top level
    // rather than leaving the user drilled into a group that is now empty.
    set({ rows, months, monthKey, drill: null, isLoading: false });
  },

  selectMonth: (monthKey) => set({ monthKey, drill: null }),

  // delta > 0 moves toward the present. `months` is newest-first, so a step
  // toward the present is a step *down* the array.
  stepMonth: (delta) => {
    const { months, monthKey } = get();
    const i = months.indexOf(monthKey);
    if (i === -1) return;
    const next = Math.min(months.length - 1, Math.max(0, i - delta));
    set({ monthKey: months[next], drill: null });
  },

  setDrill: (group) => set({ drill: group }),

  setBucket: async (transactionId, bucket) => {
    await setTransactionBucket(transactionId, bucket);
    await get().load();
  },

  current: () => aggregateMonth(get().rows, get().monthKey),
}));
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, including `db.parity.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add mobile/lib/db.ts mobile/lib/db.web.ts mobile/stores/spendStore.ts \
        mobile/__tests__/lib/db.web.test.ts mobile/__tests__/stores/spendStore.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add the spending query and month store

getSpendingRows joins committed transactions to their split decision and
their vacation, filtered to bucketed rows only. The store owns month
selection, drill level, and write-through re-tagging.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Bucket colors and the SVG donut

**Files:**
- Modify: `mobile/package.json` (via `npx expo install`)
- Modify: `mobile/lib/theme.ts`
- Create: `mobile/components/SpendingDonut.tsx`
- Test: `mobile/__tests__/components/SpendingDonut.test.tsx`

**Interfaces:**
- Consumes: `Bucket`, `BucketGroup` from Task 1.
- Produces: `BucketColors: Record<Bucket, string>` and `GroupColors: Record<BucketGroup, string>` from `lib/theme.ts`; `computeSlices(values: SliceInput[]): Slice[]` and the default-exported `SpendingDonut` component from `components/SpendingDonut.tsx`.

```ts
interface SliceInput { key: string; label: string; cents: number; color: string; }
interface Slice extends SliceInput { startAngle: number; endAngle: number; path: string; fraction: number; }

interface SpendingDonutProps {
  slices: SliceInput[];
  centerLabel: string;      // e.g. "$1,240.55"
  centerCaption: string;    // e.g. "August 2026" or "Wants"
  onSlicePress?: (key: string) => void;
  size?: number;            // default 220
}
```

- [ ] **Step 1: Install the dependency**

Run: `npx expo install react-native-svg`

`expo install` picks the version matching SDK 52 rather than the newest release. `react-native-svg` renders under `react-native-web`, so the PWA build is unaffected, and it is **already** listed in the jest `transformIgnorePatterns` in `package.json`, so no test config changes.

- [ ] **Step 2: Write the failing test**

Create `mobile/__tests__/components/SpendingDonut.test.tsx`:

```tsx
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import SpendingDonut, { computeSlices } from '@/components/SpendingDonut';

describe('computeSlices', () => {
  it('turns cents into angles covering the full circle', () => {
    const slices = computeSlices([
      { key: 'a', label: 'A', cents: 250, color: '#000' },
      { key: 'b', label: 'B', cents: 250, color: '#111' },
    ]);
    expect(slices[0].startAngle).toBe(0);
    expect(slices[0].endAngle).toBeCloseTo(180);
    expect(slices[1].endAngle).toBeCloseTo(360);
    expect(slices[0].fraction).toBeCloseTo(0.5);
  });

  it('drops zero-value slices so they cannot render a hairline', () => {
    const slices = computeSlices([
      { key: 'a', label: 'A', cents: 100, color: '#000' },
      { key: 'b', label: 'B', cents: 0, color: '#111' },
    ]);
    expect(slices.map((s) => s.key)).toEqual(['a']);
    expect(slices[0].fraction).toBe(1);
  });

  it('returns an empty list when everything is zero', () => {
    expect(computeSlices([{ key: 'a', label: 'A', cents: 0, color: '#000' }])).toEqual([]);
  });

  it('emits a path for every slice', () => {
    const slices = computeSlices([
      { key: 'a', label: 'A', cents: 1, color: '#000' },
      { key: 'b', label: 'B', cents: 2, color: '#111' },
    ]);
    for (const s of slices) expect(s.path).toMatch(/^M /);
  });
});

describe('SpendingDonut', () => {
  const slices = [
    { key: 'needs', label: 'Needs', cents: 6000, color: '#2563EB' },
    { key: 'wants', label: 'Wants', cents: 4000, color: '#F59E0B' },
  ];

  it('renders the center label and caption', () => {
    render(<SpendingDonut slices={slices} centerLabel="$100.00" centerCaption="August 2026" />);
    expect(screen.getByText('$100.00')).toBeTruthy();
    expect(screen.getByText('August 2026')).toBeTruthy();
  });

  it('calls onSlicePress with the slice key', () => {
    const onSlicePress = jest.fn();
    render(
      <SpendingDonut slices={slices} centerLabel="$100.00" centerCaption="August" onSlicePress={onSlicePress} />
    );
    fireEvent.press(screen.getByLabelText('Needs, 60% of spending'));
    expect(onSlicePress).toHaveBeenCalledWith('needs');
  });

  it('renders an empty state when there is no spending', () => {
    render(<SpendingDonut slices={[]} centerLabel="$0.00" centerCaption="August 2026" />);
    expect(screen.getByLabelText('No spending this month')).toBeTruthy();
  });
});
```

- [ ] **Step 3: Add the colors**

Append to `mobile/lib/theme.ts`:

```ts
// Spending buckets. The three `wants` buckets share the amber family so the
// group still reads as one wedge when the donut is drilled in, while Travel,
// Needs, and Misc stay clearly distinct from them and from each other.
export const BucketColors = {
  travel: '#0EA5E9',
  needs: '#2563EB',
  food: '#F59E0B',
  shopping: '#FB923C',
  experiences: '#FCD34D',
  misc: '#94A3B8',
};

export const GroupColors = {
  travel: '#0EA5E9',
  needs: '#2563EB',
  wants: '#F59E0B',
  misc: '#94A3B8',
};
```

- [ ] **Step 4: Write the component**

Create `mobile/components/SpendingDonut.tsx`:

```tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { Colors, Spacing } from '@/lib/theme';

export interface SliceInput {
  key: string;
  label: string;
  cents: number;
  color: string;
}

export interface Slice extends SliceInput {
  startAngle: number;
  endAngle: number;
  fraction: number;
  path: string;
}

const SIZE = 220;
const STROKE = 34;

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  // -90 so angle 0 starts at 12 o'clock rather than 3 o'clock.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutSegment(
  cx: number, cy: number, rOuter: number, rInner: number,
  start: number, end: number
): string {
  const largeArc = end - start > 180 ? 1 : 0;
  const o1 = polar(cx, cy, rOuter, start);
  const o2 = polar(cx, cy, rOuter, end);
  const i2 = polar(cx, cy, rInner, end);
  const i1 = polar(cx, cy, rInner, start);
  return [
    `M ${o1.x} ${o1.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${o2.x} ${o2.y}`,
    `L ${i2.x} ${i2.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 0 ${i1.x} ${i1.y}`,
    'Z',
  ].join(' ');
}

/**
 * Cents → arc geometry. Zero-value slices are dropped rather than drawn, since
 * a zero-width arc renders as a visible hairline seam.
 */
export function computeSlices(inputs: SliceInput[]): Slice[] {
  const present = inputs.filter((s) => s.cents > 0);
  const total = present.reduce((sum, s) => sum + s.cents, 0);
  if (total === 0) return [];

  const cx = SIZE / 2;
  const cy = SIZE / 2;
  const rOuter = SIZE / 2;
  const rInner = rOuter - STROKE;

  let angle = 0;
  return present.map((s) => {
    const fraction = s.cents / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;
    return {
      ...s,
      fraction,
      startAngle,
      endAngle,
      path: donutSegment(cx, cy, rOuter, rInner, startAngle, endAngle),
    };
  });
}

interface Props {
  slices: SliceInput[];
  centerLabel: string;
  centerCaption: string;
  onSlicePress?: (key: string) => void;
  size?: number;
}

export default function SpendingDonut({
  slices, centerLabel, centerCaption, onSlicePress, size = SIZE,
}: Props) {
  const computed = computeSlices(slices);
  const cx = SIZE / 2;
  const rMid = SIZE / 2 - STROKE / 2;

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      <Svg width={size} height={size} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        {computed.length === 0 ? (
          <Circle
            cx={cx} cy={cx} r={rMid}
            stroke={Colors.surfaceMuted} strokeWidth={STROKE} fill="none"
          />
        ) : computed.length === 1 ? (
          // A single slice spans the full circle, where start and end angles
          // coincide and the arc path degenerates. Draw a plain ring instead.
          <Circle
            cx={cx} cy={cx} r={rMid}
            stroke={computed[0].color} strokeWidth={STROKE} fill="none"
          />
        ) : (
          <G>
            {computed.map((s) => (
              <Path key={s.key} d={s.path} fill={s.color} />
            ))}
          </G>
        )}
      </Svg>

      <View style={styles.center} pointerEvents="none">
        <Text style={styles.centerLabel} numberOfLines={1} adjustsFontSizeToFit>
          {centerLabel}
        </Text>
        <Text style={styles.centerCaption} numberOfLines={1}>{centerCaption}</Text>
      </View>

      {/*
        Touch targets live outside the SVG. react-native-svg's press handling
        differs between native and react-native-web, and this app ships as a
        PWA — a row of plain Pressables behaves identically on both, and gives
        screen readers a real, labelled control per slice.
      */}
      <View style={styles.hitRow} accessibilityRole="tablist">
        {computed.length === 0 ? (
          <View accessible accessibilityLabel="No spending this month" />
        ) : (
          computed.map((s) => (
            <Pressable
              key={s.key}
              style={[styles.hit, { backgroundColor: s.color, flex: s.fraction }]}
              onPress={() => onSlicePress?.(s.key)}
              accessibilityRole="button"
              accessibilityLabel={`${s.label}, ${Math.round(s.fraction * 100)}% of spending`}
            />
          ))
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignSelf: 'center', justifyContent: 'center', alignItems: 'center' },
  center: { position: 'absolute', alignItems: 'center', paddingHorizontal: Spacing.lg },
  centerLabel: { fontSize: 26, fontWeight: '700', color: Colors.textPrimary },
  centerCaption: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  hitRow: {
    position: 'absolute',
    bottom: -Spacing.md,
    flexDirection: 'row',
    width: '100%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  // flexBasis 0 with an explicit flex-grow keeps RN-web from sizing these by
  // content; see the min-width:auto note in the global constraints.
  hit: { flexBasis: 0, minWidth: 2 },
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- SpendingDonut.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add mobile/package.json mobile/package-lock.json mobile/lib/theme.ts \
        mobile/components/SpendingDonut.tsx mobile/__tests__/components/SpendingDonut.test.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add the spending donut chart

SVG donut with pure, separately-tested slice geometry. Touch targets sit
outside the SVG so press handling is identical on native and in the PWA,
and each slice gets a labelled control for screen readers.

Adds react-native-svg, already covered by the jest transform config.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: The bucket chip and its picker sheet

**Files:**
- Create: `mobile/components/BucketChip.tsx`
- Create: `mobile/components/BucketPickerSheet.tsx`
- Test: `mobile/__tests__/components/BucketChip.test.tsx`, `mobile/__tests__/components/BucketPickerSheet.test.tsx`

**Interfaces:**
- Consumes: `Bucket`, `BUCKETS`, `BUCKET_LABEL` from Task 1; `BucketColors` from Task 7.
- Produces:

```tsx
interface BucketChipProps {
  bucket: Bucket;
  locked?: boolean;        // vacation-bound: renders a lock glyph
  onPress?: () => void;    // omit for a non-interactive chip
}
interface BucketPickerSheetProps {
  bucket: Bucket | null;   // currently selected; null renders nothing
  merchantName: string;
  locked?: boolean;
  onSelect: (bucket: Bucket) => void;
  onRemoveFromVacation?: () => void;
}
// BucketPickerSheet is forwardRef<BottomSheetModal, Props>, matching
// HistoryActionSheet, and is presented by the parent via ref.
```

**Pattern to follow:** `mobile/components/HistoryActionSheet.tsx` — `forwardRef<BottomSheetModal, Props>`, returns `null` when it has nothing to show, `snapPoints` with `enableDynamicSizing={false}`, `handleIndicatorStyle`/`backgroundStyle` from theme. This sheet is a plain list with no CTA, so `BottomSheetView` is fine; if a CTA is ever added it must move to `footerComponent`.

- [ ] **Step 1: Write the failing tests**

Create `mobile/__tests__/components/BucketChip.test.tsx`:

```tsx
import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { BucketChip } from '@/components/BucketChip';

test('renders the bucket label', () => {
  render(<BucketChip bucket="food" />);
  expect(screen.getByText('Food')).toBeTruthy();
});

test('is pressable when onPress is given', () => {
  const onPress = jest.fn();
  render(<BucketChip bucket="needs" onPress={onPress} />);
  fireEvent.press(screen.getByLabelText('Category: Needs. Tap to change.'));
  expect(onPress).toHaveBeenCalled();
});

test('a locked chip announces why it cannot be changed', () => {
  render(<BucketChip bucket="travel" locked onPress={jest.fn()} />);
  expect(screen.getByLabelText('Category: Travel, set by a vacation.')).toBeTruthy();
});

test('without onPress it renders no button role', () => {
  render(<BucketChip bucket="misc" />);
  expect(screen.queryByLabelText('Category: Misc. Tap to change.')).toBeNull();
  expect(screen.getByText('Misc')).toBeTruthy();
});
```

Create `mobile/__tests__/components/BucketPickerSheet.test.tsx`:

```tsx
jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _ref: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';

test('renders every bucket as a choice', () => {
  render(<BucketPickerSheet bucket="food" merchantName="Chipotle" onSelect={jest.fn()} />);
  for (const label of ['Travel', 'Needs', 'Food', 'Shopping', 'Experiences', 'Misc']) {
    expect(screen.getByLabelText(`Move Chipotle to ${label}`)).toBeTruthy();
  }
});

test('selecting a bucket reports it', () => {
  const onSelect = jest.fn();
  render(<BucketPickerSheet bucket="food" merchantName="Chipotle" onSelect={onSelect} />);
  fireEvent.press(screen.getByLabelText('Move Chipotle to Shopping'));
  expect(onSelect).toHaveBeenCalledWith('shopping');
});

test('renders nothing without a bucket', () => {
  const { toJSON } = render(
    <BucketPickerSheet bucket={null} merchantName="Chipotle" onSelect={jest.fn()} />
  );
  expect(toJSON()).toBeNull();
});

test('a locked sheet explains the vacation instead of listing buckets', () => {
  const onSelect = jest.fn();
  render(
    <BucketPickerSheet
      bucket="travel" merchantName="Hotel" locked
      onSelect={onSelect} onRemoveFromVacation={jest.fn()}
    />
  );
  expect(screen.queryByLabelText('Move Hotel to Food')).toBeNull();
  expect(screen.getByText(/part of a vacation/i)).toBeTruthy();
});

test('a locked sheet offers to remove the transaction from the vacation', () => {
  const onRemoveFromVacation = jest.fn();
  render(
    <BucketPickerSheet
      bucket="travel" merchantName="Hotel" locked
      onSelect={jest.fn()} onRemoveFromVacation={onRemoveFromVacation}
    />
  );
  fireEvent.press(screen.getByLabelText('Remove Hotel from vacation'));
  expect(onRemoveFromVacation).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- BucketChip.test.tsx BucketPickerSheet.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `BucketChip`**

Create `mobile/components/BucketChip.tsx`:

```tsx
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Bucket, BUCKET_LABEL } from '@/lib/buckets';
import { BucketColors, Radius } from '@/lib/theme';

interface Props {
  bucket: Bucket;
  // Vacation-bound: the bucket is Travel by definition and cannot be changed
  // here. Still pressable, so tapping can explain why.
  locked?: boolean;
  onPress?: () => void;
}

export function BucketChip({ bucket, locked, onPress }: Props) {
  const color = BucketColors[bucket];
  const label = BUCKET_LABEL[bucket];

  const body = (
    <View style={[styles.chip, { backgroundColor: `${color}1A` }]}>
      {locked && <Ionicons name="lock-closed" size={9} color={color} style={styles.lock} />}
      <Text style={[styles.text, { color }]} numberOfLines={1}>{label}</Text>
    </View>
  );

  if (!onPress) return body;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={
        locked
          ? `Category: ${label}, set by a vacation.`
          : `Category: ${label}. Tap to change.`
      }
    >
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 1,
    // Never let the chip absorb the row's spare width or be squeezed to
    // nothing — same reason pendingBadge in TransactionRow does this.
    flexShrink: 0,
  },
  lock: { marginRight: 3 },
  text: { fontSize: 10, fontWeight: '600' },
});
```

- [ ] **Step 4: Write `BucketPickerSheet`**

Create `mobile/components/BucketPickerSheet.tsx`:

```tsx
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { Bucket, BUCKETS, BUCKET_LABEL } from '@/lib/buckets';
import { BucketColors, Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  bucket: Bucket | null;
  merchantName: string;
  locked?: boolean;
  onSelect: (bucket: Bucket) => void;
  onRemoveFromVacation?: () => void;
}

export const BucketPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ bucket, merchantName, locked, onSelect, onRemoveFromVacation }, ref) => {
    if (!bucket) return null;

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={[locked ? '32%' : '58%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          <Text style={styles.title} numberOfLines={1}>{merchantName}</Text>

          {locked ? (
            <>
              <Text style={styles.lockedBody}>
                This transaction is part of a vacation, so it counts as Travel.
                Remove it from the vacation to categorize it yourself.
              </Text>
              {onRemoveFromVacation && (
                <Pressable
                  style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                  onPress={onRemoveFromVacation}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${merchantName} from vacation`}
                >
                  <Ionicons name="airplane-outline" size={18} color={Colors.error} />
                  <Text style={[styles.optionText, styles.removeText]}>Remove from vacation</Text>
                </Pressable>
              )}
            </>
          ) : (
            BUCKETS.map((b) => (
              <Pressable
                key={b}
                style={({ pressed }) => [styles.option, pressed && styles.optionPressed]}
                onPress={() => onSelect(b)}
                accessibilityRole="button"
                accessibilityLabel={`Move ${merchantName} to ${BUCKET_LABEL[b]}`}
              >
                <View style={[styles.dot, { backgroundColor: BucketColors[b] }]} />
                <Text style={styles.optionText}>{BUCKET_LABEL[b]}</Text>
                {b === bucket && (
                  <Ionicons name="checkmark" size={18} color={Colors.primary} style={styles.check} />
                )}
              </Pressable>
            ))
          )}
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

BucketPickerSheet.displayName = 'BucketPickerSheet';

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  title: {
    fontSize: 15, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.md,
  },
  lockedBody: {
    fontSize: 13, color: Colors.textSecondary, lineHeight: 19, marginBottom: Spacing.md,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.sm,
  },
  optionPressed: { backgroundColor: Colors.surfaceMuted },
  dot: { width: 10, height: 10, borderRadius: 5, marginRight: Spacing.md },
  optionText: { flex: 1, minWidth: 0, fontSize: 15, color: Colors.textPrimary },
  removeText: { color: Colors.error, marginLeft: Spacing.md },
  check: { marginLeft: Spacing.sm },
});
```

- [ ] **Step 5: Run the tests**

Run: `npm test -- BucketChip.test.tsx BucketPickerSheet.test.tsx`
Expected: PASS.

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add mobile/components/BucketChip.tsx mobile/components/BucketPickerSheet.tsx \
        mobile/__tests__/components/BucketChip.test.tsx \
        mobile/__tests__/components/BucketPickerSheet.test.tsx
git commit -m "$(cat <<'EOF'
feat(mobile): add the bucket chip and picker sheet

One tappable tag, reused on transaction tiles, history rows, and the
spending list. A vacation-bound chip renders locked and its sheet
explains the trip rather than offering categories.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The Spending tab

**Files:**
- Modify: `mobile/lib/spend.ts` (add `formatCents`)
- Modify: `mobile/__tests__/lib/spend.test.ts`
- Create: `mobile/app/(tabs)/spending.tsx`
- Modify: `mobile/app/(tabs)/_layout.tsx`
- Test: `mobile/__tests__/app/spending.test.tsx`

**Interfaces:**
- Consumes: `useSpendStore` (Task 6), `SpendingDonut` + `BucketColors`/`GroupColors` (Task 7), `BucketChip`/`BucketPickerSheet` (Task 8), `GROUP_BUCKETS`/`GROUP_LABEL`/`BUCKET_LABEL` (Task 1), `formatMonthKey` (Task 2).
- Produces: `formatCents(cents: number, currency: string): string` from `lib/spend.ts`; the Spending route.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/__tests__/lib/spend.test.ts`:

```ts
describe('formatCents', () => {
  it('renders USD with a dollar sign and two decimals', () => {
    expect(formatCents(124055, 'USD')).toBe('$1,240.55');
    expect(formatCents(0, 'USD')).toBe('$0.00');
  });

  it('renders other currencies with their own symbol', () => {
    expect(formatCents(34000, 'EUR')).toContain('340.00');
  });
});
```

Add `formatCents` to that file's import list.

Create `mobile/__tests__/app/spending.test.tsx`:

```tsx
jest.mock('@/lib/db', () => ({
  getSpendingRows: jest.fn(),
  setTransactionBucket: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
}));
jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _r: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []) }));

import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { getSpendingRows } from '@/lib/db';
import SpendingScreen from '@/app/(tabs)/spending';
import { SpendRow } from '@/lib/spend';
import { useSpendStore } from '@/stores/spendStore';

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    id: 'tx1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-08-10',
    status: 'skipped', bucket: 'food', bucket_source: 'auto',
    splitwise_expense_id: null, amount_each: null, vacation_id: null,
    vacation_start_date: null, vacation_started_at: null, vacation_created_at: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useSpendStore.setState({ rows: [], months: [], monthKey: '', drill: null, isLoading: false });
});

test('shows the month label and total', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 100, bucket: 'needs', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, bucket: 'food', date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText('August 2026')).toBeTruthy());
  expect(screen.getByText('$140.00')).toBeTruthy();
});

test('lists the four top-level groups with their totals', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 100, bucket: 'needs', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, bucket: 'food', date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByLabelText('Needs, $100.00')).toBeTruthy());
  expect(screen.getByLabelText('Wants, $40.00')).toBeTruthy();
});

test('drilling into Wants shows its three buckets', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 40, bucket: 'food', date: '2026-08-03' }),
    row({ id: 'b', amount: 60, bucket: 'shopping', date: '2026-08-04' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByLabelText('Wants, $100.00')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Wants, $100.00'));
  await waitFor(() => expect(screen.getByLabelText('Food, $40.00')).toBeTruthy());
  expect(screen.getByLabelText('Shopping, $60.00')).toBeTruthy();
  expect(screen.getByLabelText('Back to all categories')).toBeTruthy();
});

test('stepping back a month changes the label', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 10, date: '2026-07-03' }),
    row({ id: 'b', amount: 20, date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText('August 2026')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Previous month'));
  await waitFor(() => expect(screen.getByText('July 2026')).toBeTruthy());
});

test('footnotes a second currency instead of adding it in', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 100, currency: 'USD', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, currency: 'EUR', date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText('$100.00')).toBeTruthy());
  expect(screen.getByText(/EUR/)).toBeTruthy();
});

test('shows an empty state when nothing has been committed yet', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText(/Nothing yet/i)).toBeTruthy());
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- spending.test.tsx`
Expected: FAIL — cannot resolve `@/app/(tabs)/spending`.

- [ ] **Step 3: Add `formatCents` to `lib/spend.ts`**

```ts
/** Cents → a localized money string, e.g. 124055 USD → "$1,240.55". */
export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}
```

- [ ] **Step 4: Write the screen**

Create `mobile/app/(tabs)/spending.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { useSpendStore } from '@/stores/spendStore';
import { aggregateMonth, formatCents, formatMonthKey, SpendRowWithShare } from '@/lib/spend';
import {
  Bucket, BucketGroup, BUCKET_LABEL, GROUP_BUCKETS, GROUP_LABEL,
} from '@/lib/buckets';
import SpendingDonut, { SliceInput } from '@/components/SpendingDonut';
import { BucketChip } from '@/components/BucketChip';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';
import { useToast } from '@/components/ToastProvider';
import { BucketLockedError } from '@/lib/vacationErrors';
import { BucketColors, Colors, GroupColors, Radius, Shadow, Spacing } from '@/lib/theme';

const GROUPS: BucketGroup[] = ['travel', 'needs', 'wants', 'misc'];

export default function SpendingScreen() {
  const topInset = useSafeAreaInsets().top;
  const toast = useToast();
  const { months, monthKey, drill, load, stepMonth, setDrill, setBucket } = useSpendStore();
  // Select the raw rows and aggregate in a memo. Selecting `s.current()`
  // directly would build a new object on every store read, and zustand's
  // reference-equality check would then re-render forever.
  const rows = useSpendStore((s) => s.rows);
  const month = useMemo(() => aggregateMonth(rows, monthKey), [rows, monthKey]);

  const [expanded, setExpanded] = useState<Bucket | null>(null);
  const [editing, setEditing] = useState<SpendRowWithShare | null>(null);
  const [pendingPresent, setPendingPresent] = useState(false);
  const sheetRef = useRef<BottomSheetModal>(null);

  // Recompute whenever the tab regains focus, so a split or skip made on
  // another tab is reflected without a manual refresh.
  useFocusEffect(useCallback(() => { load(); }, [load]));

  // Present from an effect, after the sheet has rendered with the chosen row:
  // the sheet returns null while it has nothing to show, so on the first tap
  // sheetRef.current is still null and a synchronous present() does nothing.
  // Same reason as the Transactions and History screens. This is a plain
  // useEffect, not useFocusEffect — the tap happens while already focused.
  useEffect(() => {
    if (!pendingPresent) return;
    sheetRef.current?.present();
    setPendingPresent(false);
  }, [pendingPresent]);

  const atOldest = months.indexOf(monthKey) === months.length - 1;
  const atNewest = months.indexOf(monthKey) <= 0;

  // Top level shows the four groups; drilled in, the group's own buckets.
  const slices: SliceInput[] = drill
    ? GROUP_BUCKETS[drill].map((b) => ({
        key: b, label: BUCKET_LABEL[b], cents: month.byBucket[b], color: BucketColors[b],
      }))
    : GROUPS.map((g) => ({
        key: g, label: GROUP_LABEL[g], cents: month.byGroup[g], color: GroupColors[g],
      }));

  const centerCents = drill ? month.byGroup[drill] : month.totalCents;
  const centerCaption = drill ? GROUP_LABEL[drill] : formatMonthKey(monthKey);

  function onSlicePress(key: string) {
    // Only a group with more than one bucket is worth drilling into.
    const group = key as BucketGroup;
    if (!drill && GROUP_BUCKETS[group]?.length > 1) setDrill(group);
  }

  function openEditor(r: SpendRowWithShare) {
    setEditing(r);
    setPendingPresent(true);
  }

  async function applyBucket(bucket: Bucket) {
    if (!editing) return;
    try {
      await setBucket(editing.id, bucket);
      sheetRef.current?.dismiss();
      toast.show(`Moved to ${BUCKET_LABEL[bucket]}`, 'success');
    } catch (err) {
      if (err instanceof BucketLockedError) toast.show(err.message, 'error');
      else toast.show('Could not change the category. Please try again.', 'error');
    }
  }

  const listBuckets: Bucket[] = drill ? GROUP_BUCKETS[drill] : [];
  const rowsFor = (b: Bucket) => month.rows.filter((r) => r.bucket === b);

  if (months.length === 0) {
    return (
      <View style={[styles.root, { paddingTop: topInset + Spacing.lg }]}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
        <Text style={styles.title}>Spending</Text>
        <Text style={styles.empty}>
          Nothing yet. Skip or split a transaction and it will show up here.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.root, { paddingTop: topInset + Spacing.lg }]}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />

      <View style={styles.monthRow}>
        <Pressable
          onPress={() => stepMonth(-1)}
          disabled={atOldest}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Previous month"
        >
          <Ionicons
            name="chevron-back"
            size={22}
            color={atOldest ? Colors.textTertiary : Colors.textPrimary}
          />
        </Pressable>
        <Text style={styles.monthLabel}>{formatMonthKey(monthKey)}</Text>
        <Pressable
          onPress={() => stepMonth(1)}
          disabled={atNewest}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Next month"
        >
          <Ionicons
            name="chevron-forward"
            size={22}
            color={atNewest ? Colors.textTertiary : Colors.textPrimary}
          />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <SpendingDonut
          slices={slices}
          centerLabel={formatCents(centerCents, month.currency)}
          centerCaption={centerCaption}
          onSlicePress={onSlicePress}
        />

        {month.otherCurrencies.length > 0 && (
          <Text style={styles.footnote}>
            {month.otherCurrencies
              .map((c) => `+ ${formatCents(c.cents, c.currency)} ${c.currency}`)
              .join('   ')}
          </Text>
        )}

        {drill && (
          <Pressable
            style={styles.backRow}
            onPress={() => { setDrill(null); setExpanded(null); }}
            accessibilityRole="button"
            accessibilityLabel="Back to all categories"
          >
            <Ionicons name="chevron-back" size={16} color={Colors.primary} />
            <Text style={styles.backText}>All categories</Text>
          </Pressable>
        )}

        <View style={styles.list}>
          {drill
            ? listBuckets.map((b) => (
                <View key={b}>
                  <Pressable
                    style={styles.bucketRow}
                    onPress={() => setExpanded(expanded === b ? null : b)}
                    accessibilityRole="button"
                    accessibilityLabel={`${BUCKET_LABEL[b]}, ${formatCents(month.byBucket[b], month.currency)}`}
                  >
                    <View style={[styles.dot, { backgroundColor: BucketColors[b] }]} />
                    <Text style={styles.bucketName} numberOfLines={1}>{BUCKET_LABEL[b]}</Text>
                    <Text style={styles.bucketAmount} numberOfLines={1}>
                      {formatCents(month.byBucket[b], month.currency)}
                    </Text>
                    <Ionicons
                      name={expanded === b ? 'chevron-up' : 'chevron-down'}
                      size={16}
                      color={Colors.textTertiary}
                    />
                  </Pressable>
                  {expanded === b && rowsFor(b).map((r) => (
                    <TransactionLine key={r.id} row={r} currency={month.currency} onEdit={openEditor} />
                  ))}
                </View>
              ))
            : GROUPS.map((g) => (
                <Pressable
                  key={g}
                  style={styles.bucketRow}
                  onPress={() => onSlicePress(g)}
                  accessibilityRole="button"
                  accessibilityLabel={`${GROUP_LABEL[g]}, ${formatCents(month.byGroup[g], month.currency)}`}
                >
                  <View style={[styles.dot, { backgroundColor: GroupColors[g] }]} />
                  <Text style={styles.bucketName} numberOfLines={1}>{GROUP_LABEL[g]}</Text>
                  <Text style={styles.bucketAmount} numberOfLines={1}>
                    {formatCents(month.byGroup[g], month.currency)}
                  </Text>
                  {GROUP_BUCKETS[g].length > 1 && (
                    <Ionicons name="chevron-forward" size={16} color={Colors.textTertiary} />
                  )}
                </Pressable>
              ))}
        </View>
      </ScrollView>

      <BucketPickerSheet
        ref={sheetRef}
        bucket={editing?.bucket ?? null}
        merchantName={editing?.merchant_name ?? ''}
        locked={!!editing?.vacation_id}
        onSelect={applyBucket}
      />
    </View>
  );
}

function TransactionLine({
  row, currency, onEdit,
}: {
  row: SpendRowWithShare;
  currency: string;
  onEdit: (r: SpendRowWithShare) => void;
}) {
  return (
    <View style={styles.txRow}>
      <View style={styles.txInfo}>
        <Text style={styles.txName} numberOfLines={1}>{row.merchant_name}</Text>
        <View style={styles.txMeta}>
          <BucketChip
            bucket={row.bucket}
            locked={!!row.vacation_id}
            onPress={() => onEdit(row)}
          />
        </View>
      </View>
      <Text style={styles.txAmount} numberOfLines={1}>
        {formatCents(row.shareCents, currency)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg, paddingHorizontal: Spacing.lg },
  title: { fontSize: 24, fontWeight: '700', color: Colors.textPrimary },
  empty: {
    fontSize: 14, color: Colors.textSecondary, marginTop: Spacing.lg, lineHeight: 20,
  },
  monthRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.lg,
  },
  monthLabel: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary },
  scroll: { paddingBottom: Spacing.xxl },
  footnote: {
    fontSize: 12, color: Colors.textTertiary, textAlign: 'center', marginTop: Spacing.xl,
  },
  backRow: {
    flexDirection: 'row', alignItems: 'center', marginTop: Spacing.xl, gap: 2,
  },
  backText: { fontSize: 14, fontWeight: '600', color: Colors.primary },
  list: {
    marginTop: Spacing.lg, backgroundColor: Colors.surface,
    borderRadius: Radius.lg, paddingHorizontal: Spacing.lg, ...Shadow.sm,
  },
  bucketRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.lg, gap: Spacing.md,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  // minWidth 0 keeps RN-web from letting the amount crush this column; see the
  // min-width:auto note in the global constraints.
  bucketName: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  bucketAmount: { fontSize: 15, fontWeight: '700', color: Colors.textPrimary, flexShrink: 1 },
  txRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, paddingLeft: Spacing.xl,
    borderTopWidth: 1, borderTopColor: Colors.divider, gap: Spacing.md,
  },
  txInfo: { flex: 1, minWidth: 0 },
  txName: { fontSize: 14, color: Colors.textPrimary },
  txMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  txAmount: { fontSize: 14, fontWeight: '600', color: Colors.textSecondary, flexShrink: 1 },
});
```

- [ ] **Step 5: Register the tab**

In `mobile/app/(tabs)/_layout.tsx`, add between the `history` and `settings` screens:

```tsx
      <Tabs.Screen
        name="spending"
        options={{
          title: 'Spending',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="pie-chart-outline" size={size} color={color} />
          ),
        }}
      />
```

- [ ] **Step 6: Run the tests**

Run: `npm test -- spending.test.tsx spend.test.ts`
Expected: PASS.

- [ ] **Step 7: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add mobile/app/\(tabs\)/spending.tsx mobile/app/\(tabs\)/_layout.tsx mobile/lib/spend.ts \
        mobile/__tests__/app/spending.test.tsx mobile/__tests__/lib/spend.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): add the Spending tab

Month switcher, a donut over the four top-level groups that drills into
Wants, and a bucket list whose rows expand into their transactions with
each transaction's own share. Other currencies are footnoted rather than
summed into the total.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: The chip on the Transactions tile

**Files:**
- Modify: `mobile/components/TransactionRow.tsx`
- Modify: `mobile/stores/transactionStore.ts`
- Modify: `mobile/app/(tabs)/index.tsx`
- Test: `mobile/__tests__/components/TransactionRow.test.tsx`, `mobile/__tests__/stores/transactionStore.test.ts`

**Interfaces:**
- Consumes: `BucketChip`/`BucketPickerSheet` (Task 8), `resolveBucket` (Task 1), `getMerchantBuckets` (Task 3), `setTransactionBucket` (Task 4).
- Produces: `TransactionRow` gains `bucket?: Bucket`, `bucketLocked?: boolean`, `onBucketPress?: () => void`. `transactionStore` gains `merchantBuckets: Record<string, Bucket>` and `setBucket(ids: string[], bucket: Bucket): Promise<void>`.

**This is the "evaluated as soon as it lands" half of the requirement.** The tile computes `resolveBucket(tx, merchantBuckets)` on render — nothing is written to the database until the transaction is skipped or split. A pre-commit re-tag *is* written (`bucket` + `bucket_source='manual'`), but `status` is still `'new'`, so it stays out of the tracker until committed.

- [ ] **Step 1: Write the failing tests**

Append to `mobile/__tests__/components/TransactionRow.test.tsx`:

```ts
test('renders a bucket chip when given a bucket', () => {
  render(<TransactionRow transaction={tx} onSkip={jest.fn()} onSplit={jest.fn()} bucket="food" />);
  expect(screen.getByText('Food')).toBeTruthy();
});

test('renders no chip when no bucket is given', () => {
  render(<TransactionRow transaction={tx} onSkip={jest.fn()} onSplit={jest.fn()} />);
  expect(screen.queryByText('Food')).toBeNull();
});

test('tapping the chip fires onBucketPress', () => {
  const onBucketPress = jest.fn();
  render(
    <TransactionRow
      transaction={tx} onSkip={jest.fn()} onSplit={jest.fn()}
      bucket="needs" onBucketPress={onBucketPress}
    />
  );
  fireEvent.press(screen.getByLabelText('Category: Needs. Tap to change.'));
  expect(onBucketPress).toHaveBeenCalled();
});

test('a locked chip announces the vacation', () => {
  render(
    <TransactionRow
      transaction={tx} onSkip={jest.fn()} onSplit={jest.fn()}
      bucket="travel" bucketLocked onBucketPress={jest.fn()}
    />
  );
  expect(screen.getByLabelText('Category: Travel, set by a vacation.')).toBeTruthy();
});
```

Append to `mobile/__tests__/stores/transactionStore.test.ts` (match the file's existing mock style for `@/lib/db`; add `getMerchantBuckets` and `setTransactionBucket` to whatever it already mocks):

```ts
test('load also fetches the merchant memory', async () => {
  (getNewTransactions as jest.Mock).mockResolvedValue([]);
  (getMerchantBuckets as jest.Mock).mockResolvedValue({ starbucks: 'needs' });
  await useTransactionStore.getState().load();
  expect(useTransactionStore.getState().merchantBuckets).toEqual({ starbucks: 'needs' });
});

test('setBucket writes every id and reloads', async () => {
  (getNewTransactions as jest.Mock).mockResolvedValue([]);
  (getMerchantBuckets as jest.Mock).mockResolvedValue({});
  await useTransactionStore.getState().setBucket(['a', 'b'], 'shopping');
  expect(setTransactionBucket).toHaveBeenCalledWith('a', 'shopping');
  expect(setTransactionBucket).toHaveBeenCalledWith('b', 'shopping');
  expect(getNewTransactions).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- TransactionRow.test.tsx transactionStore.test.ts`
Expected: FAIL — no chip rendered, `merchantBuckets` undefined.

- [ ] **Step 3: Add the chip to `TransactionRow`**

Add to the imports:

```tsx
import { Bucket } from '@/lib/buckets';
import { BucketChip } from '@/components/BucketChip';
```

Add to `Props`:

```tsx
  // The bucket to display. On the Transactions tab this is a live guess and
  // nothing has been written yet; the write happens on skip or split.
  bucket?: Bucket;
  bucketLocked?: boolean;
  onBucketPress?: () => void;
```

Destructure them, and render the chip inside the existing `dateRow`, after the pending badge:

```tsx
          <View style={styles.dateRow}>
            <Text style={styles.date} numberOfLines={1}>{date}</Text>
            {transaction.pending && (
              <View style={styles.pendingBadge}>
                <Text style={styles.pendingText}>Pending</Text>
              </View>
            )}
            {bucket && (
              <BucketChip bucket={bucket} locked={bucketLocked} onPress={onBucketPress} />
            )}
          </View>
```

`dateRow` already has `gap: 6` and `alignItems: 'center'`, and `BucketChip` carries its own `flexShrink: 0`, so the date truncates before the chip does. Do not change `info`'s `minWidth` or `amount`'s `flexShrink` — both are load-bearing for the PWA.

- [ ] **Step 4: Extend `transactionStore`**

Add to the imports:

```ts
import { getMerchantBuckets, setTransactionBucket } from '@/lib/db';
import { Bucket } from '@/lib/buckets';
```

Add to the interface:

```ts
  merchantBuckets: Record<string, Bucket>;
  setBucket: (ids: string[], bucket: Bucket) => Promise<void>;
```

Add to the store body:

```ts
  merchantBuckets: {},

  // ... in load(), replace the body with:
  load: async () => {
    set({ isLoading: true });
    const [rows, merchantBuckets] = await Promise.all([
      getNewTransactions(),
      getMerchantBuckets(),
    ]);
    set({ transactions: rows, merchantBuckets, isLoading: false });
  },

  // Takes a list because a combined split is one row over several
  // transactions, and re-tagging it moves every member.
  setBucket: async (ids, bucket) => {
    for (const id of ids) await setTransactionBucket(id, bucket);
    await get().load();
  },
```

- [ ] **Step 5: Wire the Transactions screen**

In `mobile/app/(tabs)/index.tsx`, add the imports:

```tsx
import { resolveBucket, Bucket, BUCKET_LABEL } from '@/lib/buckets';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';
import { BucketLockedError } from '@/lib/vacationErrors';
```

Pull the new store members into the existing destructure:

```tsx
  const {
    transactions, isLoading, review, load, refresh, skip, loadReview, resolveReview,
    deleteSplit, deleteCombinedSplit, merchantBuckets, setBucket,
  } = useTransactionStore();
```

Add the sheet state alongside the existing sheet plumbing:

```tsx
  const [bucketTx, setBucketTx] = useState<Transaction | null>(null);
  const [pendingBucketPresent, setPendingBucketPresent] = useState(false);
  const bucketSheetRef = useRef<BottomSheetModal>(null);

  // Same deferred-present reason as the friend picker above: the sheet renders
  // null until it has a transaction, so a synchronous present() on the first
  // tap finds a null ref.
  useEffect(() => {
    if (!pendingBucketPresent) return;
    bucketSheetRef.current?.present();
    setPendingBucketPresent(false);
  }, [pendingBucketPresent]);

  function openBucketSheet(tx: Transaction) {
    setBucketTx(tx);
    setPendingBucketPresent(true);
  }

  async function applyBucket(bucket: Bucket) {
    if (!bucketTx) return;
    try {
      await setBucket([bucketTx.id], bucket);
      bucketSheetRef.current?.dismiss();
      toast.show(`Moved to ${BUCKET_LABEL[bucket]}`, 'success');
    } catch (err) {
      if (err instanceof BucketLockedError) toast.show(err.message, 'error');
      else toast.show('Could not change the category. Please try again.', 'error');
    }
  }
```

In the `renderItem` for the transaction list, add the three props:

```tsx
          bucket={resolveBucket(item, merchantBuckets).bucket}
          bucketLocked={!!item.vacation_id}
          onBucketPress={() => openBucketSheet(item)}
```

Render the sheet next to the existing `FriendPickerSheet`:

```tsx
      <BucketPickerSheet
        ref={bucketSheetRef}
        bucket={bucketTx ? resolveBucket(bucketTx, merchantBuckets).bucket : null}
        merchantName={bucketTx?.merchant_name ?? ''}
        locked={!!bucketTx?.vacation_id}
        onSelect={applyBucket}
      />
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add mobile/components/TransactionRow.tsx mobile/stores/transactionStore.ts \
        mobile/app/\(tabs\)/index.tsx \
        mobile/__tests__/components/TransactionRow.test.tsx \
        mobile/__tests__/stores/transactionStore.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): show and edit a transaction's bucket on its tile

The tile computes its bucket live from the Plaid category and the
learned merchant memory, so it is visible the moment a transaction
lands — while nothing is written until the transaction is skipped or
split. Tapping the chip re-tags it early, which survives the commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: The chip on History rows

**Files:**
- Modify: `mobile/lib/types.ts` (`HistoryItem`)
- Modify: `mobile/lib/db.ts`, `mobile/lib/db.web.ts` (`groupHistoryRows` and its web twin)
- Modify: `mobile/app/(tabs)/history.tsx`
- Test: `mobile/__tests__/lib/db.web.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1, 4, 8, 10.
- Produces: `HistoryItem` gains `bucket?: Bucket | null` and `vacation_id?: string | null`.

**This is the "move it after it's already in a bucket" half of the requirement.** A combined split is one History row over N transactions, so re-tagging it moves every member — which is why `transactionStore.setBucket` takes a list.

- [ ] **Step 1: Write the failing test**

Append to `mobile/__tests__/lib/db.web.test.ts`:

```ts
test('web: history rows carry their bucket', async () => {
  await upsertTransactions([plaidTx('h1', { merchant_name: 'Chipotle' })]);
  await updateTransactionStatus('h1', 'skipped');
  const item = (await getHistoryTransactions()).find((i) => i.id === 'h1')!;
  expect(item.bucket).toBe('food');
});

test('web: a combined history row carries the first member bucket and its member ids', async () => {
  await upsertTransactions([
    plaidTx('h2', { merchant_name: 'Chipotle', amount: 20, date: '2026-08-02' }),
    plaidTx('h3', { merchant_name: 'AMC Theatres', amount: 30, date: '2026-08-02' }),
  ]);
  await persistCombinedSplit([
    { id: 'dh2', transaction_id: 'h2', splitwise_expense_id: 'eh', friend_ids: ['f1'], friend_names: ['A'], amount_each: 25, created_at: '2026-08-02T00:00:00Z' },
    { id: 'dh3', transaction_id: 'h3', splitwise_expense_id: 'eh', friend_ids: ['f1'], friend_names: ['A'], amount_each: 25, created_at: '2026-08-02T00:00:00Z' },
  ]);
  const item = (await getHistoryTransactions()).find((i) => i.combined?.expense_id === 'eh')!;
  expect(item.combined!.transaction_ids.sort()).toEqual(['h2', 'h3']);
  expect(item.bucket).toBeTruthy();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- db.web.test.ts`
Expected: FAIL — `item.bucket` is `undefined`.

- [ ] **Step 3: Extend the type**

In `mobile/lib/types.ts`, add to `HistoryItem`:

```ts
  // Spending bucket, for the tag on the row. A combined row carries its first
  // member's bucket; re-tagging the row moves every member.
  bucket?: Bucket | null;
  vacation_id?: string | null;
```

- [ ] **Step 4: Carry the fields through the grouping**

In `db.ts`, `groupHistoryRows` builds `HistoryItem`s from rows that are already
`SELECT t.*`, so `bucket` and `vacation_id` are present on `r`. Add them to
**both** construction sites in that function (the combined-group branch and the
plain branch):

```ts
          bucket: r.bucket ?? null,
          vacation_id: r.vacation_id ?? null,
```

Do the same in `db.web.ts`'s equivalent grouping code.

- [ ] **Step 5: Wire the History screen**

In `mobile/app/(tabs)/history.tsx`, mirror Task 10's sheet plumbing — the same
`bucketTx` state, deferred `present()` effect, and `applyBucket` handler — with
two differences:

```tsx
  // A combined row is several transactions; re-tag all of them.
  const memberIds = (item: HistoryItem) => item.combined?.transaction_ids ?? [item.id];

  async function applyBucket(bucket: Bucket) {
    if (!bucketItem) return;
    try {
      await setBucket(memberIds(bucketItem), bucket);
      bucketSheetRef.current?.dismiss();
      await load();   // whatever this screen's existing reload is called
      toast.show(`Moved to ${BUCKET_LABEL[bucket]}`, 'success');
    } catch (err) {
      if (err instanceof BucketLockedError) toast.show(err.message, 'error');
      else toast.show('Could not change the category. Please try again.', 'error');
    }
  }
```

Render a `BucketChip` on each history row, following whatever layout that row
already uses for its metadata line, with `flexShrink: 0` preserved:

```tsx
  {item.bucket && (
    <BucketChip
      bucket={item.bucket}
      locked={!!item.vacation_id}
      onPress={() => openBucketSheet(item)}
    />
  )}
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: PASS, including `db.parity.test.ts`.

- [ ] **Step 7: Verify the whole flow by hand**

Run: `npm run web`

Walk through:
1. A new transaction shows a bucket chip on its tile.
2. Tapping the chip changes it; the chip updates and the Spending tab still shows nothing for it.
3. Skipping it makes it appear in the Spending tab under the chosen bucket, at its full amount.
4. Splitting a transaction makes it appear at *your share only*.
5. Combining two transactions into one split makes both appear, and their two shares sum to your share of the expense.
6. Inside a vacation, Skip is available and the transaction lands in Travel; its chip is locked.
7. A vacation starting in a different month from its transactions puts them all in the vacation's start month.

- [ ] **Step 8: Commit**

```bash
git add mobile/lib/types.ts mobile/lib/db.ts mobile/lib/db.web.ts \
        mobile/app/\(tabs\)/history.tsx mobile/__tests__/lib/db.web.test.ts
git commit -m "$(cat <<'EOF'
feat(mobile): show and edit a transaction's bucket in History

History rows carry their bucket so a transaction can be moved after it
is already counted. A combined split is one row over several
transactions, so re-tagging it moves every member.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Requirement Traceability

| Spec requirement | Task |
|---|---|
| Six buckets, four groups, misc top-level | 1 |
| Plaid category routing + learned merchant memory | 1, 3, 4 |
| Keyword fallback for pre-existing transactions | 1 |
| Migration v6, stored `plaid_category` | 3 |
| Guess on arrival, route on skip/split | 4, 10 |
| Tracker starts from now (no backfill) | 4, 6 |
| Only my share; combined splits pro-rated | 2, 6 |
| Vacation spend → the trip's start month | 2, 6 |
| Per-currency totals, no FX invention | 2, 9 |
| Vacation lock on the bucket | 1, 4, 8 |
| Re-tag forward only | 4 |
| Edit from the tile before committing | 10 |
| Move a transaction after it is bucketed | 9, 11 |
| Real-time pie, per month, drill-down | 6, 7, 9 |
| Skip inside a vacation | 5 |
| Web/PWA parity | 3, 4, 6, 11 |
