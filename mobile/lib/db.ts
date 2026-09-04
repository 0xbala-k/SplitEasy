// mobile/lib/db.ts
import * as SQLite from 'expo-sqlite';
import { Transaction, PlaidTransaction, SplitDecision, TransactionStatus, HistoryItem, ReviewItem, ReviewReason, RekeyResult, SplitwiseInboxItem } from '@/lib/types';
import { Vacation, CreateVacationInput, VacationStatus } from '@/lib/types';
import { generateId } from '@/lib/id';
import { todayLocal } from '@/lib/date';
import { VacationConflictError, BucketLockedError } from '@/lib/vacationErrors';
import { Bucket, BucketSource, resolveBucket, normalizeMerchant } from '@/lib/buckets';
import { SpendRow } from '@/lib/spend';

let _db: SQLite.SQLiteDatabase | null = null;
let _opening: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * The open database, opening it on first use.
 *
 * Callers must not have to sequence themselves behind initDb(). React runs
 * effects child-first, so a route's mount effect queries the database *before*
 * the root layout's effect has had a chance to open it — the module owns its
 * own readiness instead. Concurrent callers share one in-flight open.
 */
async function dbReady(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (!_opening) {
    // Cleared on failure so a later call can retry rather than replaying a
    // rejected promise forever.
    _opening = openDatabase().catch((e) => {
      _opening = null;
      throw e;
    });
  }
  _db = await _opening;
  return _db;
}

/** Opens (and migrates) the database. Idempotent — safe to call repeatedly. */
export async function initDb(): Promise<void> {
  await dbReady();
}

/** Drops the cached handle so the next call reopens. Tests only. */
export function resetDbForTests(): void {
  _db = null;
  _opening = null;
}

// The handle is local until every migration has run, so a concurrent caller
// awaiting dbReady() can never be handed a half-migrated database.
async function openDatabase(): Promise<SQLite.SQLiteDatabase> {
  const d = await SQLite.openDatabaseAsync('spliteasy.db');
  await d.execAsync('PRAGMA journal_mode = WAL;');
  const row = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 1) {
    await d.execAsync(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        merchant_name TEXT,
        amount REAL,
        currency TEXT DEFAULT 'USD',
        date TEXT,
        status TEXT DEFAULT 'new',
        pending INTEGER DEFAULT 0,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS split_decisions (
        id TEXT PRIMARY KEY,
        transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
        splitwise_expense_id TEXT,
        friend_ids TEXT,
        friend_names TEXT,
        amount_each REAL,
        created_at TEXT,
        description TEXT
      );
    `);
  }
  if (version >= 1 && version < 2) {
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN pending INTEGER DEFAULT 0;`);
  }
  if (version >= 1 && version < 3) {
    await d.execAsync(`ALTER TABLE split_decisions ADD COLUMN description TEXT;`);
  }
  if (version < 4) {
    await d.execAsync(`
      CREATE TABLE IF NOT EXISTS vacations (
        id TEXT PRIMARY KEY,
        name TEXT,
        start_date TEXT,
        end_date TEXT,
        status TEXT DEFAULT 'draft',
        splitwise_group_id TEXT,
        splitwise_group_name TEXT,
        splitwise_group_member_ids TEXT,
        created_at TEXT,
        started_at TEXT,
        ended_at TEXT
      );
    `);
    // Unlike `pending`/`description` above, vacation_id is NOT in the base
    // `version < 1` CREATE TABLE for transactions — so, unlike those columns,
    // this ALTER must run ungated (not `version >= 1 && ...`) so a brand-new
    // install (version 0) gets the column too. If a future migration ever
    // adds vacation_id to the base CREATE TABLE, this ALTER must move behind
    // a `version >= 1` guard or it will fail with "duplicate column name" on
    // fresh installs.
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN vacation_id TEXT REFERENCES vacations(id);`);
  }
  if (version < 5) {
    // Same rationale as vacation_id above: review_reason/amount_changed_from
    // are not in the base `version < 1` CREATE TABLE, so these ALTERs must
    // run ungated so a fresh install (version 0) gets the columns too.
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN review_reason TEXT;`);
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN amount_changed_from REAL;`);
  }
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
  if (version < 7) {
    // Same rationale as vacation_id above: these columns are not in the base
    // `version < 1` CREATE TABLE, so these ALTERs must run ungated so a fresh
    // install (version 0) gets them too.
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN source TEXT;`);
    await d.execAsync(`ALTER TABLE transactions ADD COLUMN payer_name TEXT;`);
    await d.execAsync(`
      CREATE TABLE IF NOT EXISTS splitwise_inbox (
        expense_id   TEXT PRIMARY KEY,
        description  TEXT NOT NULL,
        cost         REAL NOT NULL,
        currency     TEXT NOT NULL,
        date         TEXT NOT NULL,
        payer_name   TEXT NOT NULL,
        my_share     REAL NOT NULL,
        participants TEXT NOT NULL,
        group_id     TEXT,
        state        TEXT NOT NULL,
        fetched_at   TEXT NOT NULL
      );
    `);
  }
  // Only stamp when a migration actually ran, to avoid a file-header write on
  // every cold start. Keep the literal in sync with the highest block above:
  // when adding a `version < N` block, bump this to N.
  if (version < 7) {
    await d.execAsync(`PRAGMA user_version = 7;`);
  }
  return d;
}

export async function getNewTransactions(): Promise<Transaction[]> {
  const rows = await (await dbReady()).getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' AND vacation_id IS NULL ORDER BY date DESC`,
    []
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}

export async function getTransactionsByIds(ids: string[]): Promise<Transaction[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await (await dbReady()).getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE id IN (${placeholders})`,
    ids
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}

type HistoryRow = Transaction & {
  splitwise_expense_id: string | null;
  description: string | null;
  friend_names: string | null;
  amount_each: number | null;
};

function groupHistoryRows(rows: HistoryRow[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const groups = new Map<string, HistoryItem & { _txIds: string[] }>();

  for (const r of rows) {
    const title = r.description ?? r.merchant_name;
    if (r.status === 'split' && r.splitwise_expense_id) {
      const key = r.splitwise_expense_id;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += r.amount;
        existing._txIds.push(r.id);
      } else {
        const item: HistoryItem & { _txIds: string[] } = {
          id: r.id,
          merchant_name: title,
          amount: r.amount,
          currency: r.currency,
          date: r.date,
          status: 'split',
          split: {
            friend_names: r.friend_names ? JSON.parse(r.friend_names) : [],
            amount_each: r.amount_each ?? 0,
          },
          bucket: r.bucket ?? null,
          vacation_id: r.vacation_id ?? null,
          source: r.source ?? 'plaid',
          payer_name: r.payer_name ?? null,
          _txIds: [r.id],
        };
        groups.set(key, item);
        items.push(item);
      }
    } else {
      items.push({
        id: r.id,
        merchant_name: title,
        amount: r.amount,
        currency: r.currency,
        date: r.date,
        status: r.status,
        ...(r.status === 'split' && r.friend_names
          ? { split: { friend_names: JSON.parse(r.friend_names), amount_each: r.amount_each ?? 0 } }
          : {}),
        bucket: r.bucket ?? null,
        vacation_id: r.vacation_id ?? null,
        source: r.source ?? 'plaid',
        payer_name: r.payer_name ?? null,
      });
    }
  }

  for (const [expenseId, g] of groups.entries()) {
    if (g._txIds.length > 1) {
      g.combined = { expense_id: expenseId, transaction_ids: g._txIds, count: g._txIds.length };
      g.id = expenseId;
    }
    delete (g as { _txIds?: string[] })._txIds;
  }

  return items;
}

export async function getHistoryTransactions(): Promise<HistoryItem[]> {
  const rows = await (await dbReady()).getAllAsync<HistoryRow>(
    `SELECT t.*, s.splitwise_expense_id, s.description, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.status IN ('split','skipped')
     ORDER BY t.date DESC`,
    []
  );
  return groupHistoryRows(rows);
}

type ReviewRow = Transaction & {
  splitwise_expense_id: string | null;
  friend_names: string | null;
  amount_each: number | null;
};

// null + null stays null (nothing to show); otherwise nulls contribute 0, so
// a combined split where only some members changed amount still sums correctly.
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// Groups review-eligible rows by shared Splitwise expense id, exactly as
// groupHistoryRows does for history — one row per expense, amounts summed.
function groupReviewRows(rows: ReviewRow[]): ReviewItem[] {
  const items: ReviewItem[] = [];
  const groups = new Map<string, ReviewItem>();

  for (const r of rows) {
    const key = r.splitwise_expense_id ?? r.id;
    const existing = groups.get(key);
    if (existing) {
      existing.amount += r.amount;
      existing.amount_changed_from = addNullable(existing.amount_changed_from, r.amount_changed_from ?? null);
      existing.transaction_ids.push(r.id);
      // Mixed reasons across members of one expense: 'reversed' wins. A
      // stranded Splitwise expense needs deleting, which outranks (and would
      // otherwise be hidden behind) a mere amount change on a sibling member.
      if (r.review_reason === 'reversed') existing.reason = 'reversed';
    } else {
      const item: ReviewItem = {
        id: r.id,
        merchant_name: r.merchant_name,
        amount: r.amount,
        amount_changed_from: r.amount_changed_from ?? null,
        currency: r.currency,
        date: r.date,
        reason: (r.review_reason as ReviewReason) ?? 'amount_changed',
        split: {
          friend_names: r.friend_names ? JSON.parse(r.friend_names) : [],
          amount_each: r.amount_each ?? 0,
        },
        expense_id: r.splitwise_expense_id ?? r.id,
        transaction_ids: [r.id],
      };
      groups.set(key, item);
      items.push(item);
    }
  }

  for (const g of groups.values()) {
    if (g.transaction_ids.length > 1) g.id = g.expense_id;
  }

  return items;
}

export async function getReviewTransactions(): Promise<ReviewItem[]> {
  const rows = await (await dbReady()).getAllAsync<ReviewRow>(
    `SELECT t.*, s.splitwise_expense_id, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.review_reason IS NOT NULL
     ORDER BY t.date DESC`,
    []
  );
  return groupReviewRows(rows);
}

export async function clearReview(transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const placeholders = transactionIds.map(() => '?').join(',');
  await (await dbReady()).runAsync(
    `UPDATE transactions SET review_reason = NULL, amount_changed_from = NULL WHERE id IN (${placeholders})`,
    transactionIds
  );
}

export async function getVacationPendingTransactions(vacationId: string): Promise<Transaction[]> {
  const rows = await (await dbReady()).getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' AND vacation_id = ? ORDER BY date DESC`,
    [vacationId]
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}

export async function getVacationHistory(vacationId: string): Promise<HistoryItem[]> {
  const rows = await (await dbReady()).getAllAsync<HistoryRow>(
    `SELECT t.*, s.splitwise_expense_id, s.description, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.status IN ('split','skipped') AND t.vacation_id = ?
     ORDER BY t.date DESC`,
    [vacationId]
  );
  return groupHistoryRows(rows);
}

export async function assignTransactionsToVacation(vacationId: string, transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const placeholders = transactionIds.map(() => '?').join(',');
  await (await dbReady()).runAsync(
    `UPDATE transactions SET vacation_id = ? WHERE id IN (${placeholders}) AND status = 'new' AND vacation_id IS NULL`,
    [vacationId, ...transactionIds]
  );
}

export async function removeTransactionFromVacation(transactionId: string): Promise<void> {
  await (await dbReady()).runAsync(
    `UPDATE transactions SET vacation_id = NULL WHERE id = ? AND status = 'new'`,
    [transactionId]
  );
}

export async function reconcileVacationStatuses(): Promise<void> {
  // `today` is the device's local calendar date, so a vacation starts and ends
  // at the user's midnight rather than UTC's (see lib/date.ts). `now` is an
  // instant and stays UTC.
  const today = todayLocal();
  const now = new Date().toISOString();
  await (await dbReady()).withTransactionAsync(async () => {
    // 1. A draft whose entire window has already elapsed (past start AND
    //    past end) goes straight to 'ended' — it never needs the single
    //    active slot at all.
    await (await dbReady()).runAsync(
      `UPDATE vacations SET status = 'ended', ended_at = ?
       WHERE status = 'draft' AND start_date IS NOT NULL AND start_date <= ?
         AND end_date IS NOT NULL AND end_date < ?`,
      [now, today, today]
    );
    // 2. End any already-active vacation whose end date has passed —
    //    BEFORE attempting to activate a new draft, so a same-day handoff
    //    between two dated vacations (e.g. A ends 08-10, B starts 08-11)
    //    frees the active slot within this same reconcile call instead of
    //    stranding B in 'draft' for one extra cycle.
    await (await dbReady()).runAsync(
      `UPDATE vacations SET status = 'ended', ended_at = ?
       WHERE status = 'active' AND end_date IS NOT NULL AND end_date < ?`,
      [now, today]
    );
    // 3. Activate at most one remaining due draft (earliest start_date
    //    first). SQLite's UPDATE evaluates its WHERE against the pre-update
    //    snapshot for every candidate row before writing any of them, so a
    //    plain `NOT EXISTS (... status = 'active')` guard alone would let
    //    two simultaneously-due drafts both flip to 'active' in one
    //    statement; the `id = (SELECT ... LIMIT 1)` clause caps that to one
    //    row. Phase 1 already removed any fully-elapsed draft from
    //    consideration here, and phase 2 already ended any expired active
    //    vacation, so this statement's NOT EXISTS check sees an up-to-date
    //    picture within this same transaction.
    await (await dbReady()).runAsync(
      `UPDATE vacations SET status = 'active', started_at = ?
       WHERE status = 'draft' AND start_date IS NOT NULL AND start_date <= ?
         AND NOT EXISTS (SELECT 1 FROM vacations v2 WHERE v2.status = 'active')
         AND id = (
           SELECT id FROM vacations
           WHERE status = 'draft' AND start_date IS NOT NULL AND start_date <= ?
           ORDER BY start_date ASC, id ASC LIMIT 1
         )`,
      [now, today, today]
    );
  });
}

export async function upsertTransactions(txs: PlaidTransaction[], activeVacationId: string | null = null): Promise<void> {
  const d = await dbReady();
  const now = new Date().toISOString();
  for (const tx of txs) {
    const name = tx.merchant_name ?? tx.name;
    const currency = tx.iso_currency_code ?? 'USD';
    const pending = tx.pending ? 1 : 0;
    const category = tx.personal_finance_category?.detailed ?? null;
    // INSERT OR IGNORE preserves status/vacation_id for already-split/skipped rows
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
  }
}

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

export async function deleteTransactionsByPlaidIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  // Native never enables `PRAGMA foreign_keys`, so the ON DELETE CASCADE on
  // split_decisions.transaction_id is inert — delete explicitly, mirroring
  // db.web.ts's explicit DECISION_STORE delete.
  await (await dbReady()).runAsync(
    `DELETE FROM split_decisions WHERE transaction_id IN (${placeholders})`,
    ids
  );
  await (await dbReady()).runAsync(
    `DELETE FROM transactions WHERE id IN (${placeholders})`,
    ids
  );
}

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
    bucket: Bucket | null; bucket_source: BucketSource | null; vacation_id: string | null;
  }>(
    `SELECT id, merchant_name, plaid_category, bucket, bucket_source, vacation_id
     FROM transactions WHERE id IN (${placeholders})`,
    ids
  );
  for (const r of rows) {
    const { bucket, source } = resolveBucket(r, memory);
    // resolveBucket's rule 2 always reports 'manual' for a row that already
    // carries a bucket, since it can't distinguish an earlier auto-guess from
    // a real user choice. When the bucket itself hasn't changed, keep the
    // existing source instead of silently promoting 'auto' to 'manual' —
    // otherwise re-committing an already-bucketed row (e.g. splitting a
    // transaction that was already skipped) would make the revert-to-'new'
    // path treat a stale guess as a deliberate choice and stop clearing it.
    const nextSource = r.bucket === bucket && r.bucket_source ? r.bucket_source : source;
    await d.runAsync(
      `UPDATE transactions SET bucket = ?, bucket_source = ? WHERE id = ?`,
      [bucket, nextSource, r.id]
    );
  }
}

export async function updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  const d = await dbReady();
  await d.runAsync(`UPDATE transactions SET status = ? WHERE id = ?`, [status, id]);
  if (status === 'split' || status === 'skipped') {
    await materializeBuckets([id]);
  } else {
    // Back to 'new': drop any bucket that wasn't the user's own choice, so
    // it re-resolves against current merchant memory (or the current
    // vacation_id) if it is committed again. Only 'manual' survives — an
    // 'auto' guess should re-resolve, and a 'vacation' bucket must not
    // outlive the vacation_id that produced it (removeTransactionFromVacation
    // nulls vacation_id without touching bucket, so a row that keeps a
    // 'vacation' bucket here would be stranded in Travel forever). Written
    // as `!= 'manual'` rather than `= 'auto' OR = 'vacation'` so any future
    // BucketSource still clears by default; NULL <> 'manual' is NULL (not
    // true) in SQL, so the explicit `bucket_source IS NULL` arm is required
    // or a row with no source yet would be skipped.
    await d.runAsync(
      `UPDATE transactions SET bucket = NULL, bucket_source = NULL
       WHERE id = ? AND (bucket_source IS NULL OR bucket_source != 'manual')`,
      [id]
    );
  }
}

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

// Rekey a pending transaction's row to the id Plaid assigns once it posts.
// Plaid's transaction_id is NOT stable across the pending → posted
// transition: the posted transaction arrives with a brand-new id and only
// `pending_transaction_id` links it back to the old one. Without this, the
// posted transaction would insert as a fresh 'new' row and the pending row
// (holding the split decision) would get deleted by the sync's `removed`
// list — orphaning the Splitwise expense.
//
// One transaction: load the old row, rewrite its primary key and mutable
// fields in place, and carry the split_decisions row along to the new id.
// status/vacation_id are preserved by construction (never included in the
// UPDATE). review_reason/amount_changed_from are only set when the amount
// actually changed on a row that was already 'split' — a 'new' or 'skipped'
// row has no Splitwise expense to reconcile, so it just takes the new amount.
export async function rekeyTransaction(
  oldId: string,
  posted: PlaidTransaction
): Promise<RekeyResult> {
  const d = await dbReady();
  let result: RekeyResult = 'not_found';
  await d.withTransactionAsync(async () => {
    const row = await d.getFirstAsync<{ id: string; amount: number; status: TransactionStatus }>(
      `SELECT id, amount, status FROM transactions WHERE id = ?`,
      [oldId]
    );
    if (!row) {
      result = 'not_found';
      return;
    }
    // A row can already occupy the posted id when Plaid inserts the posted
    // transaction in one sync page and only reports its pending_transaction_id
    // in a later one. Rewriting the primary key onto an occupied id would
    // violate PRIMARY KEY and abort the whole sync, so resolve it here.
    if (posted.transaction_id !== oldId) {
      const occupant = await d.getFirstAsync<{ id: string; status: TransactionStatus }>(
        `SELECT id, status FROM transactions WHERE id = ?`,
        [posted.transaction_id]
      );
      if (occupant) {
        // An occupant that is itself 'split' has its own Splitwise expense.
        // Clobbering it would strand that expense, so leave both rows alone
        // and let the caller keep the old row rather than destroy data.
        if (occupant.status === 'split') {
          result = 'conflict';
          return;
        }
        // Otherwise it's the duplicate 'new'/'skipped' row this rekey is meant
        // to supersede — no expense attached, safe to drop.
        await deleteTransactionsByPlaidIds([posted.transaction_id]);
      }
    }
    const name = posted.merchant_name ?? posted.name;
    const changed = Math.round(row.amount * 100) !== Math.round(posted.amount * 100);
    const reviewReason: ReviewReason | null = changed && row.status === 'split' ? 'amount_changed' : null;
    const amountChangedFrom = reviewReason ? row.amount : null;

    await d.runAsync(
      `UPDATE transactions SET id = ?, merchant_name = ?, amount = ?, date = ?, pending = 0,
       review_reason = ?, amount_changed_from = ? WHERE id = ?`,
      [posted.transaction_id, name, posted.amount, posted.date, reviewReason, amountChangedFrom, oldId]
    );
    await d.runAsync(
      `UPDATE split_decisions SET transaction_id = ? WHERE transaction_id = ?`,
      [posted.transaction_id, oldId]
    );
    result = changed ? 'changed' : 'unchanged';
  });
  return result;
}

// A pending split transaction Plaid reports as `removed` without a matching
// `added`/`modified` posting is a reversal: the charge never posted. A
// 'split' row is kept and flagged so the queue can offer to delete the now-
// stranded Splitwise expense; a 'new'/'skipped' row has no expense to
// reconcile, so it's deleted today (mirrors the old unconditional delete).
// Returns the ids that were kept, for logging/testing.
export async function markTransactionsReversed(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const d = await dbReady();
  const rows = await getTransactionsByIds(ids);
  const keepIds = rows.filter((r) => r.status === 'split').map((r) => r.id);
  const keepSet = new Set(keepIds);
  const deleteIds = ids.filter((id) => !keepSet.has(id));
  await d.withTransactionAsync(async () => {
    if (keepIds.length > 0) {
      const placeholders = keepIds.map(() => '?').join(',');
      await d.runAsync(
        `UPDATE transactions SET review_reason = 'reversed' WHERE id IN (${placeholders})`,
        keepIds
      );
    }
    if (deleteIds.length > 0) {
      await deleteTransactionsByPlaidIds(deleteIds);
    }
  });
  return keepIds;
}

export async function getSplitDecision(transactionId: string): Promise<SplitDecision | null> {
  const row = await (await dbReady()).getFirstAsync<{
    id: string;
    transaction_id: string;
    splitwise_expense_id: string;
    friend_ids: string;
    friend_names: string;
    amount_each: number;
    created_at: string;
    description: string | null;
  }>(
    `SELECT * FROM split_decisions WHERE transaction_id = ?`,
    [transactionId]
  );
  if (!row) return null;
  return {
    ...row,
    friend_ids: JSON.parse(row.friend_ids),
    friend_names: JSON.parse(row.friend_names),
    description: row.description ?? undefined,
  };
}

export async function insertSplitDecision(
  decision: SplitDecision
): Promise<void> {
  await (await dbReady()).runAsync(
    `INSERT INTO split_decisions (id, transaction_id, splitwise_expense_id, friend_ids, friend_names, amount_each, created_at, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.id,
      decision.transaction_id,
      decision.splitwise_expense_id,
      JSON.stringify(decision.friend_ids),
      JSON.stringify(decision.friend_names),
      decision.amount_each,
      decision.created_at,
      decision.description ?? null,
    ]
  );
}

export async function upsertSplitDecision(decision: SplitDecision): Promise<void> {
  await (await dbReady()).runAsync(
    `INSERT INTO split_decisions (id, transaction_id, splitwise_expense_id, friend_ids, friend_names, amount_each, created_at, description)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       splitwise_expense_id = excluded.splitwise_expense_id,
       friend_ids = excluded.friend_ids,
       friend_names = excluded.friend_names,
       amount_each = excluded.amount_each,
       description = excluded.description`,
    [
      decision.id,
      decision.transaction_id,
      decision.splitwise_expense_id,
      JSON.stringify(decision.friend_ids),
      JSON.stringify(decision.friend_names),
      decision.amount_each,
      decision.created_at,
      decision.description ?? null,
    ]
  );
}

export async function deleteSplitDecision(transactionId: string): Promise<void> {
  await (await dbReady()).runAsync(
    `DELETE FROM split_decisions WHERE transaction_id = ?`,
    [transactionId]
  );
}

// Atomically persist every member's decision row and flip its transaction to
// 'split'. Wrapped in a single SQLite transaction so a mid-batch failure rolls
// back the whole combined split locally (no half-written members).
export async function persistCombinedSplit(decisions: SplitDecision[]): Promise<void> {
  await (await dbReady()).withTransactionAsync(async () => {
    for (const d of decisions) {
      await insertSplitDecision(d);
      await updateTransactionStatus(d.transaction_id, 'split');
    }
  });
}

// Atomically delete every member's decision row and revert its transaction to
// 'new'. Single transaction so a failure can't leave the group half-reverted.
export async function revertCombinedSplit(transactionIds: string[]): Promise<void> {
  await (await dbReady()).withTransactionAsync(async () => {
    for (const id of transactionIds) {
      await deleteSplitDecision(id);
      await updateTransactionStatus(id, 'new');
    }
  });
}

export async function pruneOldTransactions(): Promise<void> {
  await (await dbReady()).runAsync(
    `DELETE FROM transactions WHERE created_at < datetime('now', '-6 months')`,
    []
  );
}

// Called when the user disconnects their last bank — every remaining row was
// Plaid data before this branch shipped, but an imported Splitwise row has no
// other local source of truth: the watermark has already advanced past it, so
// deleting it here is unrecoverable. Only Plaid-origin rows are cleared:
// `source IS NULL` (every row written before this branch) or `source <>
// 'splitwise'`. The `IS NULL` arm is required — a bare `source <> 'splitwise'`
// would silently match nothing for those legacy rows, since NULL <> 'splitwise'
// evaluates to NULL, not true, in SQL. Same trap already documented on
// updateTransactionStatus's bucket_source clear.
export async function deleteAllTransactions(): Promise<void> {
  const d = await dbReady();
  const predicate = `source IS NULL OR source <> 'splitwise'`;
  await d.withTransactionAsync(async () => {
    // Decisions deleted first, via a subquery over the still-intact
    // transactions table — deleting transactions first would leave nothing
    // for this subquery to match.
    await d.runAsync(
      `DELETE FROM split_decisions WHERE transaction_id IN (SELECT id FROM transactions WHERE ${predicate})`,
      []
    );
    await d.runAsync(`DELETE FROM transactions WHERE ${predicate}`, []);
  });
}

function mapVacationRow(row: {
  id: string; name: string; start_date: string | null; end_date: string | null; status: VacationStatus;
  splitwise_group_id: string | null; splitwise_group_name: string | null;
  splitwise_group_member_ids: string | null; created_at: string; started_at: string | null; ended_at: string | null;
}): Vacation {
  return {
    ...row,
    splitwise_group_member_ids: row.splitwise_group_member_ids
      ? JSON.parse(row.splitwise_group_member_ids)
      : null,
  };
}

export async function createVacation(input: CreateVacationInput): Promise<Vacation> {
  const d = await dbReady();
  if (input.start_date && input.end_date) {
    // Overlap = existing.start <= new.end AND new.start <= existing.end.
    const conflicts = await d.getAllAsync(
      `SELECT id FROM vacations
       WHERE status IN ('draft','active')
         AND start_date IS NOT NULL AND end_date IS NOT NULL
         AND start_date <= ? AND end_date >= ?`,
      [input.end_date, input.start_date]
    );
    if (conflicts.length > 0) {
      throw new VacationConflictError('overlap', 'Dates overlap an existing vacation.');
    }
  }
  const now = new Date().toISOString();
  const vacation: Vacation = {
    id: generateId('vac'),
    name: input.name,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    status: 'draft',
    splitwise_group_id: input.splitwise_group_id ?? null,
    splitwise_group_name: input.splitwise_group_name ?? null,
    splitwise_group_member_ids: input.splitwise_group_member_ids ?? null,
    created_at: now,
    started_at: null,
    ended_at: null,
  };
  await d.runAsync(
    `INSERT INTO vacations (id, name, start_date, end_date, status, splitwise_group_id, splitwise_group_name, splitwise_group_member_ids, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vacation.id, vacation.name, vacation.start_date, vacation.end_date, vacation.status,
      vacation.splitwise_group_id, vacation.splitwise_group_name,
      vacation.splitwise_group_member_ids ? JSON.stringify(vacation.splitwise_group_member_ids) : null,
      vacation.created_at, vacation.started_at, vacation.ended_at,
    ]
  );
  return vacation;
}

export async function getVacations(): Promise<Vacation[]> {
  const rows = await (await dbReady()).getAllAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations
     ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END, COALESCE(start_date, created_at) DESC`,
    []
  );
  return rows.map(mapVacationRow);
}

export async function getVacation(id: string): Promise<Vacation | null> {
  const row = await (await dbReady()).getFirstAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations WHERE id = ?`,
    [id]
  );
  return row ? mapVacationRow(row) : null;
}

export async function getActiveVacation(): Promise<Vacation | null> {
  const row = await (await dbReady()).getFirstAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations WHERE status = 'active'`,
    []
  );
  return row ? mapVacationRow(row) : null;
}

export async function startVacation(id: string): Promise<void> {
  const others = await (await dbReady()).getAllAsync<{ id: string }>(
    `SELECT id FROM vacations WHERE status = 'active' AND id != ?`,
    [id]
  );
  if (others.length > 0) {
    throw new VacationConflictError('already_active', 'Another vacation is already active.');
  }
  await (await dbReady()).runAsync(
    `UPDATE vacations SET status = 'active', started_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function endVacation(id: string): Promise<void> {
  await (await dbReady()).runAsync(
    `UPDATE vacations SET status = 'ended', ended_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function updateVacationDates(
  id: string,
  startDate: string | null,
  endDate: string | null
): Promise<void> {
  const d = await dbReady();
  if (startDate && endDate) {
    // The same overlap rule createVacation applies, minus this vacation
    // itself — every trip overlaps its own dates.
    const conflicts = await d.getAllAsync(
      `SELECT id FROM vacations
       WHERE status IN ('draft','active')
         AND id != ?
         AND start_date IS NOT NULL AND end_date IS NOT NULL
         AND start_date <= ? AND end_date >= ?`,
      [id, endDate, startDate]
    );
    if (conflicts.length > 0) {
      throw new VacationConflictError('overlap', 'Dates overlap an existing vacation.');
    }
  }
  await d.runAsync(
    `UPDATE vacations SET start_date = ?, end_date = ? WHERE id = ?`,
    [startDate, endDate, id]
  );
}

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

export async function deleteVacation(id: string): Promise<void> {
  await (await dbReady()).withTransactionAsync(async () => {
    await (await dbReady()).runAsync(
      `UPDATE transactions SET vacation_id = NULL WHERE vacation_id = ? AND status = 'new'`,
      [id]
    );
    await (await dbReady()).runAsync(`DELETE FROM vacations WHERE id = ?`, [id]);
  });
}

/** The synthetic transactions id for an imported Splitwise expense. */
export function importedTransactionId(expenseId: string): string {
  return `sw:${expenseId}`;
}

type InboxRow = Omit<SplitwiseInboxItem, 'participants'> & { participants: string };

function mapInboxRow(r: InboxRow): SplitwiseInboxItem {
  return { ...r, participants: JSON.parse(r.participants) };
}

export async function getSplitwiseInbox(): Promise<SplitwiseInboxItem[]> {
  const rows = await (await dbReady()).getAllAsync<InboxRow>(
    `SELECT * FROM splitwise_inbox WHERE state = 'pending' ORDER BY date DESC`,
    []
  );
  return rows.map(mapInboxRow);
}

/**
 * Record (or refresh) an offered expense.
 *
 * `state` is deliberately absent from the DO UPDATE SET list: a dismissed
 * expense that the payer later edits comes back through the poll, and
 * resurrecting it as pending would re-offer something the user already said
 * no to.
 */
export async function upsertInboxItem(item: SplitwiseInboxItem): Promise<void> {
  await (await dbReady()).runAsync(
    `INSERT INTO splitwise_inbox
       (expense_id, description, cost, currency, date, payer_name, my_share, participants, group_id, state, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(expense_id) DO UPDATE SET
       description = excluded.description,
       cost = excluded.cost,
       currency = excluded.currency,
       date = excluded.date,
       payer_name = excluded.payer_name,
       my_share = excluded.my_share,
       participants = excluded.participants,
       group_id = excluded.group_id,
       fetched_at = excluded.fetched_at`,
    [
      item.expense_id, item.description, item.cost, item.currency, item.date,
      item.payer_name, item.my_share, JSON.stringify(item.participants),
      item.group_id, item.state, item.fetched_at,
    ]
  );
}

export async function dismissInboxItem(expenseId: string): Promise<void> {
  await (await dbReady()).runAsync(
    `UPDATE splitwise_inbox SET state = 'dismissed' WHERE expense_id = ?`,
    [expenseId]
  );
}

export async function getLocalExpenseState(
  expenseId: string
): Promise<{ imported: boolean; dismissed: boolean }> {
  const d = await dbReady();
  const tx = await d.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM transactions WHERE id = ?`,
    [importedTransactionId(expenseId)]
  );
  const inbox = await d.getFirstAsync<{ state: string }>(
    `SELECT state FROM splitwise_inbox WHERE expense_id = ?`,
    [expenseId]
  );
  return { imported: (tx?.n ?? 0) > 0, dismissed: inbox?.state === 'dismissed' };
}

/**
 * Materialize an approved expense as a transaction plus its split decision.
 *
 * `amount` is the WHOLE expense cost and `amount_each` is the user's own owed
 * share — the same contract Plaid-sourced splits use, which is what lets
 * spend.ts count the user's share without knowing this row is special.
 *
 * Bucket is written directly rather than via updateTransactionStatus(), whose
 * materializeBuckets() would re-resolve and overwrite the user's explicit pick.
 */
export async function acceptSplitwiseExpense(
  item: SplitwiseInboxItem,
  bucket: Bucket,
  vacationId: string | null
): Promise<void> {
  const d = await dbReady();
  const id = importedTransactionId(item.expense_id);
  const now = new Date().toISOString();
  // A vacation's spend is Travel by definition, and the bucket chip renders
  // locked for it — so the caller's pick is ignored when a vacation applies.
  const finalBucket: Bucket = vacationId ? 'travel' : bucket;
  const finalSource: BucketSource = vacationId ? 'vacation' : 'manual';

  await d.withTransactionAsync(async () => {
    await d.runAsync(
      `INSERT OR REPLACE INTO transactions
         (id, merchant_name, amount, currency, date, status, pending, created_at,
          vacation_id, bucket, bucket_source, plaid_category, source, payer_name)
       VALUES (?, ?, ?, ?, ?, 'split', 0, ?, ?, ?, ?, NULL, ?, ?)`,
      [id, item.description, item.cost, item.currency, item.date, now,
       vacationId, finalBucket, finalSource, 'splitwise', item.payer_name]
    );
    await d.runAsync(
      `INSERT OR REPLACE INTO split_decisions
         (id, transaction_id, splitwise_expense_id, friend_ids, friend_names, amount_each, created_at, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      [generateId('sd'), id, item.expense_id,
       JSON.stringify(item.participants.map((p) => p.id)),
       JSON.stringify(item.participants.map((p) => p.name)),
       item.my_share, now]
    );
    await d.runAsync(`DELETE FROM splitwise_inbox WHERE expense_id = ?`, [item.expense_id]);
  });
}

/**
 * Apply an upstream edit to an already-imported expense.
 *
 * Only the payer's facts are rewritten. bucket, bucket_source, and vacation_id
 * are the user's and are left strictly alone.
 */
export async function updateImportedExpense(item: SplitwiseInboxItem): Promise<void> {
  const d = await dbReady();
  const id = importedTransactionId(item.expense_id);
  await d.withTransactionAsync(async () => {
    await d.runAsync(
      `UPDATE transactions
         SET merchant_name = ?, amount = ?, currency = ?, date = ?, payer_name = ?
       WHERE id = ?`,
      [item.description, item.cost, item.currency, item.date, item.payer_name, id]
    );
    await d.runAsync(
      `UPDATE split_decisions
         SET amount_each = ?, friend_ids = ?, friend_names = ?
       WHERE transaction_id = ?`,
      [item.my_share,
       JSON.stringify(item.participants.map((p) => p.id)),
       JSON.stringify(item.participants.map((p) => p.name)),
       id]
    );
  });
}

/**
 * Drop an imported expense locally. NEVER calls Splitwise — the expense
 * belongs to whoever paid for it.
 *
 * `tombstone` distinguishes the user removing a row by hand (leave a
 * 'dismissed' marker so the next poll doesn't re-offer it) from the expense
 * having been deleted upstream (no marker needed; it can never come back).
 */
export async function deleteImportedExpense(expenseId: string, tombstone: boolean): Promise<void> {
  const d = await dbReady();
  const id = importedTransactionId(expenseId);
  await d.withTransactionAsync(async () => {
    await d.runAsync(`DELETE FROM split_decisions WHERE transaction_id = ?`, [id]);
    await d.runAsync(`DELETE FROM transactions WHERE id = ?`, [id]);
    await d.runAsync(`DELETE FROM splitwise_inbox WHERE expense_id = ?`, [expenseId]);
    if (tombstone) {
      await d.runAsync(
        `INSERT INTO splitwise_inbox
           (expense_id, description, cost, currency, date, payer_name, my_share, participants, group_id, state, fetched_at)
         VALUES (?, '', 0, '', '', '', 0, '[]', NULL, 'dismissed', ?)`,
        [expenseId, new Date().toISOString()]
      );
    }
  });
}
