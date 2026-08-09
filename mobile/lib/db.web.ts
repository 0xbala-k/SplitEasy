// mobile/lib/db.web.ts
// IndexedDB implementation of the lib/db.ts API for the web build.
// expo-sqlite's wasm build was rejected because it requires COOP/COEP
// cross-origin isolation, which breaks Plaid Link popups (see design spec).
import {
  Transaction, PlaidTransaction, SplitDecision, TransactionStatus, HistoryItem, ReviewItem, ReviewReason, RekeyResult,
} from '@/lib/types';
import { Vacation, CreateVacationInput, VacationStatus } from '@/lib/types';
import { generateId } from '@/lib/id';
import { todayLocal } from '@/lib/date';
import { VacationConflictError } from '@/lib/vacationErrors';

const DB_NAME = 'spliteasy';
const DB_VERSION = 2;
const TX_STORE = 'transactions';
const DECISION_STORE = 'split_decisions';
const VACATION_STORE = 'vacations';

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
      if (!d.objectStoreNames.contains(VACATION_STORE)) {
        d.createObjectStore(VACATION_STORE, { keyPath: 'id' });
      }
    };
    // A version bump can't proceed while another tab holds an older-version
    // connection open; without these handlers the promise never settles and
    // initDb() hangs forever on that tab.
    open.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open tab'));
    open.onsuccess = () => {
      // Let a newer tab's upgrade proceed instead of blocking it — this tab
      // just closes its now-stale connection.
      open.result.onversionchange = () => open.result.close();
      resolve(open.result);
    };
    open.onerror = () => reject(open.error);
  });
}

function byDateDesc(a: Transaction, b: Transaction): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

export async function getNewTransactions(): Promise<Transaction[]> {
  const all = await req(db().transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new' && !t.vacation_id).sort(byDateDesc);
}

export async function getTransactionsByIds(ids: string[]): Promise<Transaction[]> {
  if (ids.length === 0) return [];
  const store = db().transaction(TX_STORE).objectStore(TX_STORE);
  const rows = await Promise.all(
    ids.map((id) => req(store.get(id) as IDBRequest<Transaction | undefined>)),
  );
  return rows.filter((r): r is Transaction => r !== undefined);
}

function groupHistoryRows(rows: Transaction[], decisions: SplitDecision[]): HistoryItem[] {
  const byTxId = new Map(decisions.map((d) => [d.transaction_id, d]));
  const items: HistoryItem[] = [];
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
          split: { friend_names: d.friend_names ?? [], amount_each: d.amount_each ?? 0 },
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
        ...(t.status === 'split' && d?.friend_names
          ? { split: { friend_names: d.friend_names, amount_each: d.amount_each ?? 0 } }
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
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all.filter((t) => t.status === 'split' || t.status === 'skipped').sort(byDateDesc);
  return groupHistoryRows(rows, decisions);
}

// null + null stays null (nothing to show); otherwise nulls contribute 0, so
// a combined split where only some members changed amount still sums correctly.
function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

// Groups review-eligible rows by shared Splitwise expense id, exactly as
// groupHistoryRows does for history — one row per expense, amounts summed.
function groupReviewRows(rows: Transaction[], decisions: SplitDecision[]): ReviewItem[] {
  const byTxId = new Map(decisions.map((d) => [d.transaction_id, d]));
  const items: ReviewItem[] = [];
  const groups = new Map<string, ReviewItem>();

  for (const t of rows) {
    const d = byTxId.get(t.id);
    const key = d?.splitwise_expense_id ?? t.id;
    const existing = groups.get(key);
    if (existing) {
      existing.amount += t.amount;
      existing.amount_changed_from = addNullable(existing.amount_changed_from, t.amount_changed_from ?? null);
      existing.transaction_ids.push(t.id);
      // Mixed reasons across members of one expense: 'reversed' wins, matching
      // lib/db.ts's groupReviewRows.
      if (t.review_reason === 'reversed') existing.reason = 'reversed';
    } else {
      const item: ReviewItem = {
        id: t.id,
        merchant_name: t.merchant_name,
        amount: t.amount,
        amount_changed_from: t.amount_changed_from ?? null,
        currency: t.currency,
        date: t.date,
        reason: (t.review_reason as ReviewReason) ?? 'amount_changed',
        split: { friend_names: d?.friend_names ?? [], amount_each: d?.amount_each ?? 0 },
        expense_id: d?.splitwise_expense_id ?? t.id,
        transaction_ids: [t.id],
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
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all.filter((t) => t.review_reason != null).sort(byDateDesc);
  return groupReviewRows(rows, decisions);
}

export async function clearReview(transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  for (const id of transactionIds) {
    const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
    if (existing) store.put({ ...existing, review_reason: null, amount_changed_from: null });
  }
  await done(tx);
}

export async function getVacationPendingTransactions(vacationId: string): Promise<Transaction[]> {
  const all = await req(db().transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new' && t.vacation_id === vacationId).sort(byDateDesc);
}

export async function getVacationHistory(vacationId: string): Promise<HistoryItem[]> {
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all
    .filter((t) => (t.status === 'split' || t.status === 'skipped') && t.vacation_id === vacationId)
    .sort(byDateDesc);
  return groupHistoryRows(rows, decisions);
}

export async function assignTransactionsToVacation(vacationId: string, transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  for (const id of transactionIds) {
    const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
    if (existing && existing.status === 'new' && !existing.vacation_id) {
      store.put({ ...existing, vacation_id: vacationId });
    }
  }
  await done(tx);
}

export async function removeTransactionFromVacation(transactionId: string): Promise<void> {
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(transactionId) as IDBRequest<Transaction | undefined>);
  if (existing && existing.status === 'new') store.put({ ...existing, vacation_id: null });
  await done(tx);
}

export async function reconcileVacationStatuses(): Promise<void> {
  // `today` is the device's local calendar date, so a vacation starts and ends
  // at the user's midnight rather than UTC's (see lib/date.ts). `now` is an
  // instant and stays UTC.
  const today = todayLocal();
  const now = new Date().toISOString();
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const all = await req(store.getAll() as IDBRequest<Vacation[]>);

  // Mirrors the three-phase SQL in lib/db.ts's reconcileVacationStatuses —
  // see that function's comments for why each phase exists and why phase 2
  // (end already-active elapsed vacations) must run before phase 3
  // (activate a new draft). All phases read from this same `all` snapshot
  // (matching how each native UPDATE statement's WHERE evaluates against
  // the state at the start of that statement) rather than re-querying
  // mid-function, so ids affected by an earlier phase are tracked
  // explicitly (elapsedIds, endedIds) instead of re-reading the store.

  // 1. Fully-elapsed drafts go straight to 'ended'.
  const elapsedIds = new Set<string>();
  for (const v of all) {
    if (v.status === 'draft' && v.start_date && v.start_date <= today && v.end_date && v.end_date < today) {
      store.put({ ...v, status: 'ended' as VacationStatus, ended_at: now });
      elapsedIds.add(v.id);
    }
  }

  // 2. End any already-active vacation whose end date has passed — before
  //    attempting to activate a new draft, so a same-day handoff between
  //    two dated vacations frees the active slot within this same call.
  const endedIds = new Set<string>();
  for (const v of all) {
    if (v.status === 'active' && v.end_date && v.end_date < today) {
      store.put({ ...v, status: 'ended' as VacationStatus, ended_at: now });
      endedIds.add(v.id);
    }
  }

  // 3. Activate at most one remaining due draft, earliest start_date first —
  //    phase 1 already excluded any candidate that would immediately
  //    re-end, and phase 2 already freed the slot from any vacation that
  //    was active only because it hadn't been reconciled since it elapsed.
  const hasActive = all.some((v) => v.status === 'active' && !endedIds.has(v.id));
  if (!hasActive) {
    const dueDrafts = all
      .filter((v) => v.status === 'draft' && !elapsedIds.has(v.id) && v.start_date && v.start_date <= today)
      .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''));
    const next = dueDrafts[0];
    if (next) store.put({ ...next, status: 'active' as VacationStatus, started_at: now });
  }

  await done(tx);
}

export async function upsertTransactions(txs: PlaidTransaction[], activeVacationId: string | null = null): Promise<void> {
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
        vacation_id: activeVacationId,
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

// Mirrors lib/db.ts's rekeyTransaction — see that function's comment for why
// this exists. Deletes the old key and re-puts under the new key in both
// stores, inside one readwrite transaction spanning both so a failure can't
// leave the transaction row and its decision pointing at different ids.
export async function rekeyTransaction(
  oldId: string,
  posted: PlaidTransaction
): Promise<RekeyResult> {
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const decStore = tx.objectStore(DECISION_STORE);
  // Invariant: only await IDB requests belonging to this txn, so it stays active.
  const existing = await req(txStore.get(oldId) as IDBRequest<Transaction | undefined>);
  if (!existing) {
    await done(tx);
    return 'not_found';
  }
  // Same collision case the native implementation guards — see lib/db.ts. A
  // put() here would silently overwrite rather than throw, which is worse:
  // it would strand the occupant's Splitwise expense with no error.
  if (posted.transaction_id !== oldId) {
    const occupant = await req(
      txStore.get(posted.transaction_id) as IDBRequest<Transaction | undefined>,
    );
    if (occupant && occupant.status === 'split') {
      await done(tx);
      return 'conflict';
    }
    // A non-split occupant is the duplicate this rekey supersedes; the put()
    // below overwrites it, and its (nonexistent) decision needs no cleanup.
  }
  const decisionRow = await req(decStore.get(oldId) as IDBRequest<SplitDecision | undefined>);

  const name = posted.merchant_name ?? posted.name;
  const changed = Math.round(existing.amount * 100) !== Math.round(posted.amount * 100);
  const reviewReason: ReviewReason | null = changed && existing.status === 'split' ? 'amount_changed' : null;
  const amountChangedFrom = reviewReason ? existing.amount : null;

  txStore.delete(oldId);
  txStore.put({
    ...existing,
    id: posted.transaction_id,
    merchant_name: name,
    amount: posted.amount,
    date: posted.date,
    pending: false,
    review_reason: reviewReason,
    amount_changed_from: amountChangedFrom,
  } satisfies Transaction);

  if (decisionRow) {
    decStore.delete(oldId);
    decStore.put({ ...decisionRow, transaction_id: posted.transaction_id });
  }

  await done(tx);
  return changed ? 'changed' : 'unchanged';
}

// Mirrors lib/db.ts's markTransactionsReversed.
export async function markTransactionsReversed(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const decStore = tx.objectStore(DECISION_STORE);
  const kept: string[] = [];
  // Invariant: only await IDB requests belonging to this txn inside the loop.
  for (const id of ids) {
    const existing = await req(txStore.get(id) as IDBRequest<Transaction | undefined>);
    if (existing && existing.status === 'split') {
      txStore.put({ ...existing, review_reason: 'reversed' as ReviewReason });
      kept.push(id);
    } else {
      txStore.delete(id);
      decStore.delete(id);
    }
  }
  await done(tx);
  return kept;
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

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export async function createVacation(input: CreateVacationInput): Promise<Vacation> {
  if (input.start_date && input.end_date) {
    const all = await req(db().transaction(VACATION_STORE).objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>);
    const conflict = all.some(
      (v) =>
        (v.status === 'draft' || v.status === 'active') &&
        v.start_date && v.end_date &&
        rangesOverlap(v.start_date, v.end_date, input.start_date!, input.end_date!)
    );
    if (conflict) throw new VacationConflictError('overlap', 'Dates overlap an existing vacation.');
  }
  const vacation: Vacation = {
    id: generateId('vac'),
    name: input.name,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    status: 'draft',
    splitwise_group_id: input.splitwise_group_id ?? null,
    splitwise_group_name: input.splitwise_group_name ?? null,
    splitwise_group_member_ids: input.splitwise_group_member_ids ?? null,
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
  };
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  tx.objectStore(VACATION_STORE).add(vacation);
  await done(tx);
  return vacation;
}

function byVacationOrder(a: Vacation, b: Vacation): number {
  const aEnded = a.status === 'ended' ? 1 : 0;
  const bEnded = b.status === 'ended' ? 1 : 0;
  if (aEnded !== bEnded) return aEnded - bEnded;
  const aKey = a.start_date ?? a.created_at;
  const bKey = b.start_date ?? b.created_at;
  return aKey < bKey ? 1 : aKey > bKey ? -1 : 0;
}

export async function getVacations(): Promise<Vacation[]> {
  const all = await req(db().transaction(VACATION_STORE).objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>);
  return all.sort(byVacationOrder);
}

export async function getVacation(id: string): Promise<Vacation | null> {
  const row = await req(db().transaction(VACATION_STORE).objectStore(VACATION_STORE).get(id) as IDBRequest<Vacation | undefined>);
  return row ?? null;
}

export async function getActiveVacation(): Promise<Vacation | null> {
  const all = await getVacations();
  return all.find((v) => v.status === 'active') ?? null;
}

export async function startVacation(id: string): Promise<void> {
  const all = await getVacations();
  if (all.some((v) => v.status === 'active' && v.id !== id)) {
    throw new VacationConflictError('already_active', 'Another vacation is already active.');
  }
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, status: 'active' as VacationStatus, started_at: new Date().toISOString() });
  await done(tx);
}

export async function endVacation(id: string): Promise<void> {
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, status: 'ended' as VacationStatus, ended_at: new Date().toISOString() });
  await done(tx);
}

export async function updateVacationDates(
  id: string,
  startDate: string | null,
  endDate: string | null
): Promise<void> {
  if (startDate && endDate) {
    // The same overlap rule createVacation applies, minus this vacation
    // itself — every trip overlaps its own dates.
    const all = await getVacations();
    const conflict = all.some(
      (v) =>
        v.id !== id &&
        (v.status === 'draft' || v.status === 'active') &&
        v.start_date && v.end_date &&
        rangesOverlap(v.start_date, v.end_date, startDate, endDate)
    );
    if (conflict) throw new VacationConflictError('overlap', 'Dates overlap an existing vacation.');
  }
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, start_date: startDate, end_date: endDate });
  await done(tx);
}

export async function deleteVacation(id: string): Promise<void> {
  const tx = db().transaction([TX_STORE, VACATION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const all = await req(txStore.getAll() as IDBRequest<Transaction[]>);
  for (const t of all) {
    if (t.vacation_id === id && t.status === 'new') {
      txStore.put({ ...t, vacation_id: null });
    }
  }
  tx.objectStore(VACATION_STORE).delete(id);
  await done(tx);
}
