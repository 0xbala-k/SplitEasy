// mobile/lib/db.ts
import * as SQLite from 'expo-sqlite';
import { Transaction, TransactionWithSplit, PlaidTransaction, SplitDecision, TransactionStatus } from '@/lib/types';

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
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS split_decisions (
        id TEXT PRIMARY KEY,
        transaction_id TEXT UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
        splitwise_expense_id TEXT,
        friend_ids TEXT,
        friend_names TEXT,
        amount_each REAL,
        created_at TEXT
      );
      PRAGMA user_version = 1;
    `);
  }
}

export async function getNewTransactions(): Promise<Transaction[]> {
  return db().getAllAsync<Transaction>(
    `SELECT * FROM transactions WHERE status = 'new' ORDER BY date DESC`,
    []
  );
}

export async function getHistoryTransactions(): Promise<TransactionWithSplit[]> {
  const rows = await db().getAllAsync<Transaction & {
    friend_names: string | null;
    amount_each: number | null;
  }>(
    `SELECT t.*, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.status IN ('split','skipped')
     ORDER BY t.date DESC`,
    []
  );
  return rows.map((r) => ({
    ...r,
    split: r.friend_names
      ? {
          friend_names: JSON.parse(r.friend_names),
          amount_each: r.amount_each!,
        }
      : undefined,
  }));
}

export async function upsertTransactions(txs: PlaidTransaction[]): Promise<void> {
  const d = db();
  const now = new Date().toISOString();
  for (const tx of txs) {
    const name = tx.merchant_name ?? tx.name;
    const currency = tx.iso_currency_code ?? 'USD';
    // INSERT OR IGNORE preserves status for already-split/skipped rows
    await d.runAsync(
      `INSERT OR IGNORE INTO transactions (id, merchant_name, amount, currency, date, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'new', ?)`,
      [tx.transaction_id, name, tx.amount, currency, tx.date, now]
    );
    // UPDATE only if still 'new' (don't overwrite user decisions)
    await d.runAsync(
      `UPDATE transactions SET merchant_name = ?, amount = ?, date = ?
       WHERE id = ? AND status = 'new'`,
      [name, tx.amount, tx.date, tx.transaction_id]
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
  }>(
    `SELECT * FROM split_decisions WHERE transaction_id = ?`,
    [transactionId]
  );
  if (!row) return null;
  return {
    ...row,
    friend_ids: JSON.parse(row.friend_ids),
    friend_names: JSON.parse(row.friend_names),
  };
}

export async function insertSplitDecision(
  decision: SplitDecision
): Promise<void> {
  await db().runAsync(
    `INSERT INTO split_decisions (id, transaction_id, splitwise_expense_id, friend_ids, friend_names, amount_each, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      decision.id,
      decision.transaction_id,
      decision.splitwise_expense_id,
      JSON.stringify(decision.friend_ids),
      JSON.stringify(decision.friend_names),
      decision.amount_each,
      decision.created_at,
    ]
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
