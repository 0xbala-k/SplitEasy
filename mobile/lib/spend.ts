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
