// mobile/lib/db.ts
import * as SQLite from 'expo-sqlite';
import { Transaction, PlaidTransaction, SplitDecision, TransactionStatus, HistoryItem } from '@/lib/types';

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
  // Only stamp when a migration actually ran, to avoid a file-header write on
  // every cold start. Keep the literal in sync with the highest block above:
  // when adding a `version < N` block, bump this to N.
  if (version < 3) {
    await _db.execAsync(`PRAGMA user_version = 3;`);
  }
}

export async function getNewTransactions(): Promise<Transaction[]> {
  const rows = await db().getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' ORDER BY date DESC`,
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

export async function getHistoryTransactions(): Promise<HistoryItem[]> {
  const rows = await db().getAllAsync<Transaction & {
    splitwise_expense_id: string | null;
    description: string | null;
    friend_names: string | null;
    amount_each: number | null;
  }>(
    `SELECT t.*, s.splitwise_expense_id, s.description, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.status IN ('split','skipped')
     ORDER BY t.date DESC`,
    []
  );

  const items: HistoryItem[] = [];
  // Track split groups by expense id so multiple member transactions collapse
  // into one item. _txIds is stripped before returning.
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
        // A split row missing its expense id is malformed, but still surface its
        // friends so it doesn't masquerade as a skipped row in the UI.
        ...(r.status === 'split' && r.friend_names
          ? { split: { friend_names: JSON.parse(r.friend_names), amount_each: r.amount_each ?? 0 } }
          : {}),
      });
    }
  }

  // Finalize: combined groups (>1 member) expose expense/member metadata and use
  // the expense id as the row key; single-member groups stay keyed by tx id.
  for (const [expenseId, g] of groups.entries()) {
    if (g._txIds.length > 1) {
      g.combined = { expense_id: expenseId, transaction_ids: g._txIds, count: g._txIds.length };
      g.id = expenseId;
    }
    delete (g as { _txIds?: string[] })._txIds;
  }

  return items;
}

export async function upsertTransactions(txs: PlaidTransaction[]): Promise<void> {
  const d = db();
  const now = new Date().toISOString();
  for (const tx of txs) {
    const name = tx.merchant_name ?? tx.name;
    const currency = tx.iso_currency_code ?? 'USD';
    const pending = tx.pending ? 1 : 0;
    // INSERT OR IGNORE preserves status for already-split/skipped rows
    await d.runAsync(
      `INSERT OR IGNORE INTO transactions (id, merchant_name, amount, currency, date, status, pending, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?)`,
      [tx.transaction_id, name, tx.amount, currency, tx.date, pending, now]
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

export async function pruneOldTransactions(): Promise<void> {
  await db().runAsync(
    `DELETE FROM transactions WHERE created_at < datetime('now', '-6 months')`,
    []
  );
}

export async function deleteAllTransactions(): Promise<void> {
  await db().runAsync(`DELETE FROM transactions`, []);
}
