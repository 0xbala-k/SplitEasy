// mobile/lib/db.ts
import * as SQLite from 'expo-sqlite';
import { Transaction, PlaidTransaction, SplitDecision, TransactionStatus, HistoryItem, ReviewItem, ReviewReason, RekeyResult } from '@/lib/types';
import { Vacation, CreateVacationInput, VacationStatus } from '@/lib/types';
import { generateId } from '@/lib/id';
import { VacationConflictError } from '@/lib/vacationErrors';

let _db: SQLite.SQLiteDatabase | null = null;

function db(): SQLite.SQLiteDatabase {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export async function initDb(): Promise<void> {
  _db = await SQLite.openDatabaseAsync('spliteasy.db');
  await _db.execAsync('PRAGMA journal_mode = WAL;');
  const row = await _db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const version = row?.user_version ?? 0;
  if (version < 1) {
    await _db.execAsync(`
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
    await _db.execAsync(`ALTER TABLE transactions ADD COLUMN pending INTEGER DEFAULT 0;`);
  }
  if (version >= 1 && version < 3) {
    await _db.execAsync(`ALTER TABLE split_decisions ADD COLUMN description TEXT;`);
  }
  if (version < 4) {
    await _db.execAsync(`
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
    await _db.execAsync(`ALTER TABLE transactions ADD COLUMN vacation_id TEXT REFERENCES vacations(id);`);
  }
  if (version < 5) {
    // Same rationale as vacation_id above: review_reason/amount_changed_from
    // are not in the base `version < 1` CREATE TABLE, so these ALTERs must
    // run ungated so a fresh install (version 0) gets the columns too.
    await _db.execAsync(`ALTER TABLE transactions ADD COLUMN review_reason TEXT;`);
    await _db.execAsync(`ALTER TABLE transactions ADD COLUMN amount_changed_from REAL;`);
  }
  // Only stamp when a migration actually ran, to avoid a file-header write on
  // every cold start. Keep the literal in sync with the highest block above:
  // when adding a `version < N` block, bump this to N.
  if (version < 5) {
    await _db.execAsync(`PRAGMA user_version = 5;`);
  }
}

export async function getNewTransactions(): Promise<Transaction[]> {
  const rows = await db().getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' AND vacation_id IS NULL ORDER BY date DESC`,
    []
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}

export async function getTransactionsByIds(ids: string[]): Promise<Transaction[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db().getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
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
  const rows = await db().getAllAsync<HistoryRow>(
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
  const rows = await db().getAllAsync<ReviewRow>(
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
  await db().runAsync(
    `UPDATE transactions SET review_reason = NULL, amount_changed_from = NULL WHERE id IN (${placeholders})`,
    transactionIds
  );
}

export async function getVacationPendingTransactions(vacationId: string): Promise<Transaction[]> {
  const rows = await db().getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' AND vacation_id = ? ORDER BY date DESC`,
    [vacationId]
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}

export async function getVacationHistory(vacationId: string): Promise<HistoryItem[]> {
  const rows = await db().getAllAsync<HistoryRow>(
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
  await db().runAsync(
    `UPDATE transactions SET vacation_id = ? WHERE id IN (${placeholders}) AND status = 'new' AND vacation_id IS NULL`,
    [vacationId, ...transactionIds]
  );
}

export async function removeTransactionFromVacation(transactionId: string): Promise<void> {
  await db().runAsync(
    `UPDATE transactions SET vacation_id = NULL WHERE id = ? AND status = 'new'`,
    [transactionId]
  );
}

export async function reconcileVacationStatuses(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await db().withTransactionAsync(async () => {
    // 1. A draft whose entire window has already elapsed (past start AND
    //    past end) goes straight to 'ended' — it never needs the single
    //    active slot at all.
    await db().runAsync(
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
    await db().runAsync(
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
    await db().runAsync(
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
  const d = db();
  const now = new Date().toISOString();
  for (const tx of txs) {
    const name = tx.merchant_name ?? tx.name;
    const currency = tx.iso_currency_code ?? 'USD';
    const pending = tx.pending ? 1 : 0;
    // INSERT OR IGNORE preserves status/vacation_id for already-split/skipped rows
    await d.runAsync(
      `INSERT OR IGNORE INTO transactions (id, merchant_name, amount, currency, date, status, pending, created_at, vacation_id)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      [tx.transaction_id, name, tx.amount, currency, tx.date, pending, now, activeVacationId]
    );
    // UPDATE only if still 'new' (don't overwrite user decisions)
    await d.runAsync(
      `UPDATE transactions SET merchant_name = ?, amount = ?, date = ?, pending = ?
       WHERE id = ? AND status = 'new'`,
      [name, tx.amount, tx.date, pending, tx.transaction_id]
    );
  }
}

export async function deleteTransactionsByPlaidIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  // Native never enables `PRAGMA foreign_keys`, so the ON DELETE CASCADE on
  // split_decisions.transaction_id is inert — delete explicitly, mirroring
  // db.web.ts's explicit DECISION_STORE delete.
  await db().runAsync(
    `DELETE FROM split_decisions WHERE transaction_id IN (${placeholders})`,
    ids
  );
  await db().runAsync(
    `DELETE FROM transactions WHERE id IN (${placeholders})`,
    ids
  );
}

export async function updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  await db().runAsync(
    `UPDATE transactions SET status = ? WHERE id = ?`,
    [status, id]
  );
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
  const d = db();
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
  const d = db();
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
  const row = await db().getFirstAsync<{
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
  await db().runAsync(
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
  await db().runAsync(
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
  await db().runAsync(
    `DELETE FROM split_decisions WHERE transaction_id = ?`,
    [transactionId]
  );
}

// Atomically persist every member's decision row and flip its transaction to
// 'split'. Wrapped in a single SQLite transaction so a mid-batch failure rolls
// back the whole combined split locally (no half-written members).
export async function persistCombinedSplit(decisions: SplitDecision[]): Promise<void> {
  await db().withTransactionAsync(async () => {
    for (const d of decisions) {
      await insertSplitDecision(d);
      await updateTransactionStatus(d.transaction_id, 'split');
    }
  });
}

// Atomically delete every member's decision row and revert its transaction to
// 'new'. Single transaction so a failure can't leave the group half-reverted.
export async function revertCombinedSplit(transactionIds: string[]): Promise<void> {
  await db().withTransactionAsync(async () => {
    for (const id of transactionIds) {
      await deleteSplitDecision(id);
      await updateTransactionStatus(id, 'new');
    }
  });
}

export async function pruneOldTransactions(): Promise<void> {
  await db().runAsync(
    `DELETE FROM transactions WHERE created_at < datetime('now', '-6 months')`,
    []
  );
}

export async function deleteAllTransactions(): Promise<void> {
  await db().runAsync(`DELETE FROM transactions`, []);
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
  const d = db();
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
  const rows = await db().getAllAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations
     ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END, COALESCE(start_date, created_at) DESC`,
    []
  );
  return rows.map(mapVacationRow);
}

export async function getVacation(id: string): Promise<Vacation | null> {
  const row = await db().getFirstAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations WHERE id = ?`,
    [id]
  );
  return row ? mapVacationRow(row) : null;
}

export async function getActiveVacation(): Promise<Vacation | null> {
  const row = await db().getFirstAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations WHERE status = 'active'`,
    []
  );
  return row ? mapVacationRow(row) : null;
}

export async function startVacation(id: string): Promise<void> {
  const others = await db().getAllAsync<{ id: string }>(
    `SELECT id FROM vacations WHERE status = 'active' AND id != ?`,
    [id]
  );
  if (others.length > 0) {
    throw new VacationConflictError('already_active', 'Another vacation is already active.');
  }
  await db().runAsync(
    `UPDATE vacations SET status = 'active', started_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function endVacation(id: string): Promise<void> {
  await db().runAsync(
    `UPDATE vacations SET status = 'ended', ended_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function deleteVacation(id: string): Promise<void> {
  await db().withTransactionAsync(async () => {
    await db().runAsync(
      `UPDATE transactions SET vacation_id = NULL WHERE vacation_id = ? AND status = 'new'`,
      [id]
    );
    await db().runAsync(`DELETE FROM vacations WHERE id = ?`, [id]);
  });
}
