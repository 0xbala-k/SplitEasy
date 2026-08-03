// mobile/lib/db.web.ts
// IndexedDB implementation of the lib/db.ts API for the web build.
// expo-sqlite's wasm build was rejected because it requires COOP/COEP
// cross-origin isolation, which breaks Plaid Link popups (see design spec).
import {
  Transaction, PlaidTransaction, SplitDecision, TransactionStatus, HistoryItem,
} from '@/lib/types';

const DB_NAME = 'spliteasy';
const DB_VERSION = 1;
const TX_STORE = 'transactions';
const DECISION_STORE = 'split_decisions';

let _db: IDBDatabase | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // No tx.onerror handler: the bubbled 'error' event fires on the
    // transaction BEFORE tx.error is set, so rejecting there yields null.
    // An unhandled request error always aborts the transaction, and by
    // 'abort' time tx.error holds the real DOMException.
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
}

function db(): IDBDatabase {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export async function initDb(): Promise<void> {
  _db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(TX_STORE)) {
        d.createObjectStore(TX_STORE, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(DECISION_STORE)) {
        // Keyed by transaction_id: mirrors the SQLite UNIQUE(transaction_id)
        // constraint and makes lookups by transaction natural.
        d.createObjectStore(DECISION_STORE, { keyPath: 'transaction_id' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function byDateDesc(a: Transaction, b: Transaction): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

export async function getNewTransactions(): Promise<Transaction[]> {
  const all = await req(db().transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new').sort(byDateDesc);
}

export async function getTransactionsByIds(ids: string[]): Promise<Transaction[]> {
  if (ids.length === 0) return [];
  const store = db().transaction(TX_STORE).objectStore(TX_STORE);
  const rows = await Promise.all(
    ids.map((id) => req(store.get(id) as IDBRequest<Transaction | undefined>)),
  );
  return rows.filter((r): r is Transaction => r !== undefined);
}

export async function getHistoryTransactions(): Promise<HistoryItem[]> {
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const byTxId = new Map(decisions.map((d) => [d.transaction_id, d]));
  const rows = all
    .filter((t) => t.status === 'split' || t.status === 'skipped')
    .sort(byDateDesc);

  const items: HistoryItem[] = [];
  // Track split groups by expense id so multiple member transactions collapse
  // into one item (mirrors lib/db.ts). _txIds is stripped before returning.
  const groups = new Map<string, HistoryItem & { _txIds: string[] }>();

  for (const t of rows) {
    const d = byTxId.get(t.id);
    const title = d?.description ?? t.merchant_name;
    if (t.status === 'split' && d?.splitwise_expense_id) {
      const key = d.splitwise_expense_id;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += t.amount;
        existing._txIds.push(t.id);
      } else {
        const item: HistoryItem & { _txIds: string[] } = {
          id: t.id,
          merchant_name: title,
          amount: t.amount,
          currency: t.currency,
          date: t.date,
          status: 'split',
          split: {
            friend_names: d.friend_names ?? [],
            amount_each: d.amount_each ?? 0,
          },
          _txIds: [t.id],
        };
        groups.set(key, item);
        items.push(item);
      }
    } else {
      items.push({
        id: t.id,
        merchant_name: title,
        amount: t.amount,
        currency: t.currency,
        date: t.date,
        status: t.status,
        // A split row missing its expense id is malformed, but still surface its
        // friends so it doesn't masquerade as a skipped row in the UI.
        ...(t.status === 'split' && d?.friend_names
          ? { split: { friend_names: d.friend_names, amount_each: d.amount_each ?? 0 } }
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
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const now = new Date().toISOString();
  // Invariant: only await IDB requests belonging to this txn inside the loop, so the txn stays active.
  for (const p of txs) {
    const existing = await req(store.get(p.transaction_id) as IDBRequest<Transaction | undefined>);
    const name = p.merchant_name ?? p.name;
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
      } satisfies Transaction);
    } else if (existing.status === 'new') {
      // Mirror the SQL UPDATE: refresh mutable fields, never touch status of
      // already-split/skipped rows.
      store.put({ ...existing, merchant_name: name, amount: p.amount, date: p.date, pending: p.pending });
    }
  }
  await done(tx);
}

export async function deleteTransactionsByPlaidIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  for (const id of ids) {
    tx.objectStore(TX_STORE).delete(id);
    // SQLite cascades split_decisions via ON DELETE CASCADE; mirror that here.
    tx.objectStore(DECISION_STORE).delete(id);
  }
  await done(tx);
}

export async function updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
  if (existing) store.put({ ...existing, status });
  await done(tx);
}

export async function getSplitDecision(transactionId: string): Promise<SplitDecision | null> {
  const row = await req(
    db().transaction(DECISION_STORE).objectStore(DECISION_STORE).get(transactionId) as IDBRequest<SplitDecision | undefined>,
  );
  return row ?? null;
}

export async function insertSplitDecision(decision: SplitDecision): Promise<void> {
  const tx = db().transaction(DECISION_STORE, 'readwrite');
  // add() (not put) rejects on duplicate transaction_id, matching SQLite's
  // plain INSERT which throws on the UNIQUE(transaction_id) constraint.
  tx.objectStore(DECISION_STORE).add(decision);
  await done(tx);
}

export async function upsertSplitDecision(decision: SplitDecision): Promise<void> {
  const tx = db().transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).put(decision);
  await done(tx);
}

export async function deleteSplitDecision(transactionId: string): Promise<void> {
  const tx = db().transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).delete(transactionId);
  await done(tx);
}

// Atomically write every member's decision row and flip its transaction to
// 'split'. One IDB transaction across both stores mirrors the SQLite
// withTransactionAsync version: any failure aborts the whole group.
export async function persistCombinedSplit(decisions: SplitDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  // Read every row up front, then issue all writes: a write that fails aborts
  // the txn, and a later get() on an aborting txn would reject with a less
  // useful error than the abort reason done() surfaces.
  const rows = await Promise.all(
    decisions.map((d) => req(txStore.get(d.transaction_id) as IDBRequest<Transaction | undefined>)),
  );
  decisions.forEach((d, i) => {
    // add() (not put) rejects a duplicate transaction_id, matching the SQLite
    // UNIQUE(transaction_id) constraint.
    tx.objectStore(DECISION_STORE).add(d);
    const existing = rows[i];
    if (existing) txStore.put({ ...existing, status: 'split' });
  });
  await done(tx);
}

// Atomically delete every member's decision row and revert its transaction to
// 'new'. Single transaction so a failure can't leave the group half-reverted.
export async function revertCombinedSplit(transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const rows = await Promise.all(
    transactionIds.map((id) => req(txStore.get(id) as IDBRequest<Transaction | undefined>)),
  );
  transactionIds.forEach((id, i) => {
    tx.objectStore(DECISION_STORE).delete(id);
    const existing = rows[i];
    if (existing) txStore.put({ ...existing, status: 'new' });
  });
  await done(tx);
}

export async function pruneOldTransactions(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  const cutoffIso = cutoff.toISOString();
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const all = await req(store.getAll() as IDBRequest<Transaction[]>);
  for (const t of all) {
    if (t.created_at < cutoffIso) {
      store.delete(t.id);
      tx.objectStore(DECISION_STORE).delete(t.id);
    }
  }
  await done(tx);
}

export async function deleteAllTransactions(): Promise<void> {
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  tx.objectStore(TX_STORE).clear();
  // Parity with SQLite ON DELETE CASCADE.
  tx.objectStore(DECISION_STORE).clear();
  await done(tx);
}
