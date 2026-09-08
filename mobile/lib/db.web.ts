// mobile/lib/db.web.ts
// IndexedDB implementation of the lib/db.ts API for the web build.
// expo-sqlite's wasm build was rejected because it requires COOP/COEP
// cross-origin isolation, which breaks Plaid Link popups (see design spec).
import {
  Transaction, PlaidTransaction, SplitDecision, TransactionStatus, HistoryItem, ReviewItem, ReviewReason, RekeyResult,
  SplitwiseInboxItem, SplitwiseFriend, SplitwiseGroup,
} from '@/lib/types';
import { Vacation, CreateVacationInput, VacationStatus } from '@/lib/types';
import { generateId } from '@/lib/id';
import { todayLocal } from '@/lib/date';
import { VacationConflictError, BucketLockedError } from '@/lib/vacationErrors';
import { Bucket, BucketSource, resolveBucket, normalizeMerchant } from '@/lib/buckets';
import { SpendRow } from '@/lib/spend';
import { applyLocks, addLocks, parseLocks, serializeLocks } from '@/lib/editLocks';

const DB_NAME = 'spliteasy';
// v6 added the splitwise_friends / splitwise_groups caches and the pending_ops
// queue. IndexedDB records are schemaless, so existing records need no upgrade
// branch — only the new stores are created.
const DB_VERSION = 6;
const TX_STORE = 'transactions';
const DECISION_STORE = 'split_decisions';
const VACATION_STORE = 'vacations';
const MERCHANT_STORE = 'merchant_buckets';
const INBOX_STORE = 'splitwise_inbox';
const FRIEND_STORE = 'splitwise_friends';
const GROUP_STORE = 'splitwise_groups';
const PENDING_OPS_STORE = 'pending_ops';

let _db: IDBDatabase | null = null;
let _opening: Promise<IDBDatabase> | null = null;

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

/**
 * The open database, opening it on first use.
 *
 * Callers must not have to sequence themselves behind initDb(). React runs
 * effects child-first, so a route's mount effect queries the database *before*
 * the root layout's effect has had a chance to open it — the module owns its
 * own readiness instead. Concurrent callers share one in-flight open.
 */
async function dbReady(): Promise<IDBDatabase> {
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
  _db?.close();
  _db = null;
  _opening = null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
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
      if (!d.objectStoreNames.contains(MERCHANT_STORE)) {
        // Keyed by the normalized merchant name, mirroring the SQLite
        // merchant_buckets PRIMARY KEY.
        d.createObjectStore(MERCHANT_STORE, { keyPath: 'merchant_key' });
      }
      if (!d.objectStoreNames.contains(INBOX_STORE)) {
        // Keyed by the Splitwise expense id, mirroring the SQLite
        // splitwise_inbox PRIMARY KEY.
        d.createObjectStore(INBOX_STORE, { keyPath: 'expense_id' });
      }
      if (!d.objectStoreNames.contains(FRIEND_STORE)) {
        d.createObjectStore(FRIEND_STORE, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(GROUP_STORE)) {
        d.createObjectStore(GROUP_STORE, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(PENDING_OPS_STORE)) {
        d.createObjectStore(PENDING_OPS_STORE, { keyPath: 'id' });
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
  const all = await req((await dbReady()).transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new' && !t.vacation_id).sort(byDateDesc);
}

export async function getTransactionsByIds(ids: string[]): Promise<Transaction[]> {
  if (ids.length === 0) return [];
  const store = (await dbReady()).transaction(TX_STORE).objectStore(TX_STORE);
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
          bucket: t.bucket ?? null,
          vacation_id: t.vacation_id ?? null,
          source: t.source ?? 'plaid',
          payer_name: t.payer_name ?? null,
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
        bucket: t.bucket ?? null,
        vacation_id: t.vacation_id ?? null,
        source: t.source ?? 'plaid',
        payer_name: t.payer_name ?? null,
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
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE]);
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
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all.filter((t) => t.review_reason != null).sort(byDateDesc);
  return groupReviewRows(rows, decisions);
}

export async function clearReview(transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  for (const id of transactionIds) {
    const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
    if (existing) store.put({ ...existing, review_reason: null, amount_changed_from: null });
  }
  await done(tx);
}

export async function getVacationPendingTransactions(vacationId: string): Promise<Transaction[]> {
  const all = await req((await dbReady()).transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new' && t.vacation_id === vacationId).sort(byDateDesc);
}

export async function getVacationHistory(vacationId: string): Promise<HistoryItem[]> {
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE]);
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
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
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
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
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
  const tx = (await dbReady()).transaction(VACATION_STORE, 'readwrite');
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
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const now = new Date().toISOString();
  // Invariant: only await IDB requests belonging to this txn inside the loop, so the txn stays active.
  for (const p of txs) {
    const existing = await req(store.get(p.transaction_id) as IDBRequest<Transaction | undefined>);
    const name = p.merchant_name ?? p.name;
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
      // Mirror the SQL UPDATE: refresh mutable fields, never touch status of
      // already-split/skipped rows.
      const writable = applyLocks(
        { merchant_name: name, amount: p.amount, date: p.date },
        existing.edited_fields
      );
      store.put({ ...existing, ...writable, pending: p.pending, plaid_category: category });
    }
  }
  await done(tx);
}

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

export async function deleteTransactionsByPlaidIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
  for (const id of ids) {
    tx.objectStore(TX_STORE).delete(id);
    // SQLite cascades split_decisions via ON DELETE CASCADE; mirror that here.
    tx.objectStore(DECISION_STORE).delete(id);
  }
  await done(tx);
}

function withResolvedBucket(row: Transaction, memory: Record<string, Bucket>): Transaction {
  const { bucket, source } = resolveBucket(row, memory);
  // See lib/db.ts's materializeBuckets for the full rationale: resolveBucket's
  // rule 2 always reports 'manual' for an existing bucket, so re-committing an
  // already-bucketed row without this guard would silently promote a stale
  // 'auto' guess into a protected 'manual' choice.
  const nextSource = row.bucket === bucket && row.bucket_source ? row.bucket_source : source;
  return { ...row, bucket, bucket_source: nextSource };
}

// Reverting to 'new' drops any bucket that wasn't the user's own choice.
// Only 'manual' survives — an 'auto' guess should re-resolve against current
// merchant memory if committed again, and a 'vacation' bucket must not
// outlive the vacation_id that produced it: removeTransactionFromVacation
// nulls vacation_id without touching bucket, so a row that kept a 'vacation'
// bucket here would be stranded in Travel forever.
function withClearedNonManualBucket(row: Transaction): Transaction {
  return row.bucket_source === 'manual' ? row : { ...row, bucket: null, bucket_source: null };
}

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
    store.put(committing ? withResolvedBucket(next, memory) : withClearedNonManualBucket(next));
  }
  await done(tx);
}

/**
 * Apply a user's hand edit and lock the fields it touched.
 *
 * Gated on status='new': a 'split' row has a live Splitwise expense that this
 * would silently desync, and an 'excluded' row is soft-deleted. Both are out of
 * scope by design, and the guard lives here so no caller can forget it.
 */
export async function updateTransactionFields(
  id: string,
  patch: { merchant_name?: string; amount?: number; date?: string }
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
  if (!existing || existing.status !== 'new') return;
  store.put({ ...existing, ...patch, edited_fields: parseLocks(addLocks(existing.edited_fields, keys)) });
  await done(tx);
}

/**
 * Soft-delete a transaction. Mirrors lib/db.ts's excludeTransaction — see that
 * function's comment for why this bypasses updateTransactionStatus and needs
 * no tombstone table.
 */
export async function excludeTransaction(id: string): Promise<void> {
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
  if (existing && existing.status === 'new') store.put({ ...existing, status: 'excluded' });
  await done(tx);
}

export async function restoreTransaction(id: string): Promise<void> {
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
  if (existing && existing.status === 'excluded') store.put({ ...existing, status: 'new' });
  await done(tx);
}

/** Excluded rows, shaped like history rows so the History list can render them. */
export async function getExcludedTransactions(): Promise<HistoryItem[]> {
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all.filter((t) => t.status === 'excluded').sort(byDateDesc);
  return groupHistoryRows(rows, decisions);
}

// Mirrors lib/db.ts's rekeyTransaction — see that function's comment for why
// this exists. Deletes the old key and re-puts under the new key in both
// stores, inside one readwrite transaction spanning both so a failure can't
// leave the transaction row and its decision pointing at different ids.
export async function rekeyTransaction(
  oldId: string,
  posted: PlaidTransaction
): Promise<RekeyResult> {
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
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

  const writable = applyLocks(
    { merchant_name: name, amount: posted.amount, date: posted.date },
    existing.edited_fields
  );

  txStore.delete(oldId);
  txStore.put({
    ...existing,
    ...writable,
    id: posted.transaction_id,
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
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
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
    (await dbReady()).transaction(DECISION_STORE).objectStore(DECISION_STORE).get(transactionId) as IDBRequest<SplitDecision | undefined>,
  );
  return row ?? null;
}

export async function insertSplitDecision(decision: SplitDecision): Promise<void> {
  const tx = (await dbReady()).transaction(DECISION_STORE, 'readwrite');
  // add() (not put) rejects on duplicate transaction_id, matching SQLite's
  // plain INSERT which throws on the UNIQUE(transaction_id) constraint.
  tx.objectStore(DECISION_STORE).add(decision);
  await done(tx);
}

export async function upsertSplitDecision(decision: SplitDecision): Promise<void> {
  const tx = (await dbReady()).transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).put(decision);
  await done(tx);
}

export async function deleteSplitDecision(transactionId: string): Promise<void> {
  const tx = (await dbReady()).transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).delete(transactionId);
  await done(tx);
}

// Atomically write every member's decision row and flip its transaction to
// 'split'. One IDB transaction across both stores mirrors the SQLite
// withTransactionAsync version: any failure aborts the whole group.
export async function persistCombinedSplit(decisions: SplitDecision[]): Promise<void> {
  if (decisions.length === 0) return;
  // Read the merchant memory before opening the readwrite transaction below —
  // getMerchantBuckets opens its own IDB transaction, and awaiting it inside
  // this one would let this one auto-commit out from under us.
  const memory = await getMerchantBuckets();
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
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
    if (existing) txStore.put(withResolvedBucket({ ...existing, status: 'split' }, memory));
  });
  await done(tx);
}

// Atomically delete every member's decision row and revert its transaction to
// 'new'. Single transaction so a failure can't leave the group half-reverted.
export async function revertCombinedSplit(transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const rows = await Promise.all(
    transactionIds.map((id) => req(txStore.get(id) as IDBRequest<Transaction | undefined>)),
  );
  transactionIds.forEach((id, i) => {
    tx.objectStore(DECISION_STORE).delete(id);
    const existing = rows[i];
    if (existing) txStore.put(withClearedNonManualBucket({ ...existing, status: 'new' }));
  });
  await done(tx);
}

/**
 * Move a transaction to a bucket by hand, and remember the merchant for next
 * time. Forward-only: transactions already committed under the old bucket are
 * left alone, so a month the user has already reviewed keeps its numbers.
 */
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

export interface ManualTransactionInput {
  merchant_name: string;
  amount: number;
  date: string;          // "YYYY-MM-DD", device-local (see lib/date.ts)
  currency?: string;
  bucket?: Bucket | null;
}

/**
 * Record spending that never passed through a linked account — cash, or a card
 * the app does not know about.
 *
 * The row is deliberately ordinary: status 'new', not pending, no
 * plaid_category. That is what lets the entire existing split flow, the
 * spending tracker and vacation assignment work on it with no special case.
 *
 * bucket is left NULL unless the caller supplies one, matching the rule that a
 * bucket is written when a transaction is committed by a skip or a split.
 */
export async function createManualTransaction(input: ManualTransactionInput): Promise<string> {
  const id = generateId('mn');
  const bucket = input.bucket ?? null;
  const tx = (await dbReady()).transaction(TX_STORE, 'readwrite');
  tx.objectStore(TX_STORE).put({
    id,
    merchant_name: input.merchant_name,
    amount: input.amount,
    currency: input.currency ?? 'USD',
    date: input.date,
    status: 'new',
    pending: false,
    created_at: new Date().toISOString(),
    vacation_id: null,
    bucket,
    bucket_source: bucket ? 'manual' : null,
    plaid_category: null,
    source: 'manual',
    payer_name: null,
    edited_fields: null,
  } satisfies Transaction);
  await done(tx);
  return id;
}

export async function pruneOldTransactions(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  const cutoffIso = cutoff.toISOString();
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
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

// Called when the user disconnects their last bank. Only Plaid-origin rows are
// cleared. An imported Splitwise row and a manual row each have no other local
// source of truth — the Splitwise watermark has already advanced past the
// former, and the latter was never anywhere but here — so deleting either is
// unrecoverable.
//
// This is an allowlist, not a denylist. A denylist ("everything except
// splitwise") silently destroys every source added later, which is exactly how
// manual rows would have been lost. `== null` (not `=== null`) is deliberate:
// it catches both `null` and the `undefined` that legacy web records carry —
// the IndexedDB equivalent of SQL's `source IS NULL` arm.
export async function deleteAllTransactions(): Promise<void> {
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const all = await req(store.getAll() as IDBRequest<Transaction[]>);
  const doomed = all.filter((t) => t.source == null || t.source === 'plaid');
  for (const t of doomed) {
    store.delete(t.id);
    tx.objectStore(DECISION_STORE).delete(t.id);
  }
  await done(tx);
}

function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export async function createVacation(input: CreateVacationInput): Promise<Vacation> {
  if (input.start_date && input.end_date) {
    const all = await req((await dbReady()).transaction(VACATION_STORE).objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>);
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
  const tx = (await dbReady()).transaction(VACATION_STORE, 'readwrite');
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
  const all = await req((await dbReady()).transaction(VACATION_STORE).objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>);
  return all.sort(byVacationOrder);
}

export async function getVacation(id: string): Promise<Vacation | null> {
  const row = await req((await dbReady()).transaction(VACATION_STORE).objectStore(VACATION_STORE).get(id) as IDBRequest<Vacation | undefined>);
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
  const tx = (await dbReady()).transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, status: 'active' as VacationStatus, started_at: new Date().toISOString() });
  await done(tx);
}

export async function endVacation(id: string): Promise<void> {
  const tx = (await dbReady()).transaction(VACATION_STORE, 'readwrite');
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
  const tx = (await dbReady()).transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, start_date: startDate, end_date: endDate });
  await done(tx);
}

/**
 * Every committed, bucketed transaction, joined to its split decision and its
 * vacation. `bucket` truthy is what excludes both uncommitted transactions
 * and everything that predates the spending tracker — mirrors lib/db.ts's
 * `bucket IS NOT NULL`.
 *
 * The vacation join supplies the dates monthKeyOf needs, so editing a trip's
 * dates moves its whole spend to the new month without a rewrite.
 */
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

export async function deleteVacation(id: string): Promise<void> {
  const tx = (await dbReady()).transaction([TX_STORE, VACATION_STORE], 'readwrite');
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

/** The synthetic transactions id for an imported Splitwise expense. */
export function importedTransactionId(expenseId: string): string {
  return `sw:${expenseId}`;
}

export async function getSplitwiseInbox(): Promise<SplitwiseInboxItem[]> {
  const all = await req(
    (await dbReady()).transaction(INBOX_STORE).objectStore(INBOX_STORE)
      .getAll() as IDBRequest<SplitwiseInboxItem[]>
  );
  return all
    .filter((i) => i.state === 'pending')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/**
 * Record (or refresh) an offered expense.
 *
 * A pre-existing row's `state` is carried forward rather than overwritten:
 * a dismissed expense that the payer later edits comes back through the poll,
 * and resurrecting it as pending would re-offer something the user said no to.
 * Locked fields are dropped from the refresh the same way, via applyLocks.
 */
export async function upsertInboxItem(item: SplitwiseInboxItem): Promise<void> {
  const tx = (await dbReady()).transaction(INBOX_STORE, 'readwrite');
  const store = tx.objectStore(INBOX_STORE);
  const existing = await req(
    store.get(item.expense_id) as IDBRequest<SplitwiseInboxItem | undefined>
  );
  if (!existing) {
    store.put(item);
    await done(tx);
    return;
  }
  const writable = applyLocks(
    {
      description: item.description, cost: item.cost, currency: item.currency,
      date: item.date, payer_name: item.payer_name, my_share: item.my_share,
    },
    existing.edited_fields
  );
  store.put({
    ...existing,
    ...writable,
    participants: item.participants,
    group_id: item.group_id,
    fetched_at: item.fetched_at,
  });
  await done(tx);
}

export async function updateInboxItemFields(
  expenseId: string,
  patch: { description?: string; cost?: number; date?: string; my_share?: number }
): Promise<void> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const tx = (await dbReady()).transaction(INBOX_STORE, 'readwrite');
  const store = tx.objectStore(INBOX_STORE);
  const existing = await req(store.get(expenseId) as IDBRequest<SplitwiseInboxItem | undefined>);
  if (!existing) return;
  store.put({ ...existing, ...patch, edited_fields: parseLocks(addLocks(existing.edited_fields, keys)) });
  await done(tx);
}

export async function dismissInboxItem(expenseId: string): Promise<void> {
  const tx = (await dbReady()).transaction(INBOX_STORE, 'readwrite');
  const store = tx.objectStore(INBOX_STORE);
  const existing = await req(store.get(expenseId) as IDBRequest<SplitwiseInboxItem | undefined>);
  if (existing) store.put({ ...existing, state: 'dismissed' });
  await done(tx);
}

export async function getLocalExpenseState(
  expenseId: string
): Promise<{ imported: boolean; dismissed: boolean }> {
  const tx = (await dbReady()).transaction([TX_STORE, INBOX_STORE]);
  const [row, inbox] = await Promise.all([
    req(tx.objectStore(TX_STORE).get(importedTransactionId(expenseId)) as IDBRequest<Transaction | undefined>),
    req(tx.objectStore(INBOX_STORE).get(expenseId) as IDBRequest<SplitwiseInboxItem | undefined>),
  ]);
  return { imported: row !== undefined, dismissed: inbox?.state === 'dismissed' };
}

/**
 * Inbox field name → the name the lock carries after acceptance.
 *
 * Three map to real transactions columns. 'my_share' maps to itself because it
 * has no column of its own — it becomes split_decisions.amount_each, which
 * updateImportedExpense guards separately. Keeping it in the list is what makes
 * an edited share survive acceptance; applyLocks ignores it harmlessly when
 * filtering a write that does not carry that key. Mirrors lib/db.ts.
 */
const INBOX_TO_TX_FIELD: Record<string, string> = {
  description: 'merchant_name',
  cost: 'amount',
  date: 'date',
  my_share: 'my_share',
};

function txLocksFromInbox(raw: string | string[] | null | undefined): string[] | null {
  const mapped = parseLocks(raw)
    .map((f) => INBOX_TO_TX_FIELD[f])
    .filter((f): f is string => !!f);
  const serialized = serializeLocks(mapped);
  return serialized ? parseLocks(serialized) : null;
}

/**
 * Materialize an approved expense as a transaction plus its split decision.
 * `amount` is the WHOLE cost, `amount_each` the user's own share — the same
 * contract Plaid-sourced splits use. Mirrors lib/db.ts.
 */
export async function acceptSplitwiseExpense(
  item: SplitwiseInboxItem,
  bucket: Bucket,
  vacationId: string | null
): Promise<void> {
  const id = importedTransactionId(item.expense_id);
  const now = new Date().toISOString();
  const finalBucket: Bucket = vacationId ? 'travel' : bucket;
  const finalSource: BucketSource = vacationId ? 'vacation' : 'manual';

  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE, INBOX_STORE], 'readwrite');
  const inboxRecord = await req(
    tx.objectStore(INBOX_STORE).get(item.expense_id) as IDBRequest<SplitwiseInboxItem | undefined>
  );
  const txLocks = txLocksFromInbox(inboxRecord?.edited_fields);
  tx.objectStore(TX_STORE).put({
    id,
    merchant_name: item.description,
    amount: item.cost,
    currency: item.currency,
    date: item.date,
    status: 'split',
    pending: false,
    created_at: now,
    vacation_id: vacationId,
    review_reason: null,
    amount_changed_from: null,
    bucket: finalBucket,
    bucket_source: finalSource,
    plaid_category: null,
    source: 'splitwise',
    payer_name: item.payer_name,
    edited_fields: txLocks,
  } satisfies Transaction);
  tx.objectStore(DECISION_STORE).put({
    id: generateId('sd'),
    transaction_id: id,
    splitwise_expense_id: item.expense_id,
    friend_ids: item.participants.map((p) => p.id),
    friend_names: item.participants.map((p) => p.name),
    amount_each: item.my_share,
    created_at: now,
  } satisfies SplitDecision);
  tx.objectStore(INBOX_STORE).delete(item.expense_id);
  await done(tx);
}

/**
 * Apply an upstream edit, gated on the row's locked fields. bucket,
 * bucket_source, and vacation_id are the user's and are left strictly alone.
 */
export async function updateImportedExpense(item: SplitwiseInboxItem): Promise<void> {
  const id = importedTransactionId(item.expense_id);
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const decStore = tx.objectStore(DECISION_STORE);
  const row = await req(txStore.get(id) as IDBRequest<Transaction | undefined>);
  const locks = parseLocks(row?.edited_fields);
  if (row) {
    const writable = applyLocks(
      {
        merchant_name: item.description, amount: item.cost,
        currency: item.currency, date: item.date,
      },
      row.edited_fields
    );
    // payer_name is the payer's own fact and is never user-editable.
    txStore.put({ ...row, ...writable, payer_name: item.payer_name });
  }
  const dec = await req(decStore.get(id) as IDBRequest<SplitDecision | undefined>);
  if (dec) {
    // amount_each carries the user's share. It is locked under the inbox-side
    // name 'my_share', which has no transactions column of its own.
    decStore.put({
      ...dec,
      ...(locks.includes('my_share') ? {} : { amount_each: item.my_share }),
      friend_ids: item.participants.map((p) => p.id),
      friend_names: item.participants.map((p) => p.name),
    });
  }
  await done(tx);
}

/**
 * Drop an imported expense locally. NEVER calls Splitwise. `tombstone`
 * distinguishes a hand removal (leave a 'dismissed' marker) from an upstream
 * deletion (no marker needed). Mirrors lib/db.ts.
 */
export async function deleteImportedExpense(expenseId: string, tombstone: boolean): Promise<void> {
  const id = importedTransactionId(expenseId);
  const tx = (await dbReady()).transaction([TX_STORE, DECISION_STORE, INBOX_STORE], 'readwrite');
  tx.objectStore(TX_STORE).delete(id);
  tx.objectStore(DECISION_STORE).delete(id);
  const inbox = tx.objectStore(INBOX_STORE);
  inbox.delete(expenseId);
  if (tombstone) {
    inbox.put({
      expense_id: expenseId,
      description: '', cost: 0, currency: '', date: '',
      payer_name: '', my_share: 0, participants: [], group_id: null,
      state: 'dismissed', fetched_at: new Date().toISOString(),
    } satisfies SplitwiseInboxItem);
  }
  await done(tx);
}

export async function getCachedFriends(): Promise<SplitwiseFriend[]> {
  const all = await req(
    (await dbReady()).transaction(FRIEND_STORE).objectStore(FRIEND_STORE)
      .getAll() as IDBRequest<(SplitwiseFriend & { cached_at: string })[]>
  );
  return all
    .map(({ id, display_name, avatar_url }) => ({ id, display_name, avatar_url: avatar_url ?? null }))
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
}

// Wholesale replace, not merge: a friend removed on Splitwise must disappear
// locally. Safe because nothing holds a foreign key to this table — split
// history denormalizes friend_names for exactly this reason.
export async function replaceCachedFriends(friends: SplitwiseFriend[]): Promise<void> {
  const tx = (await dbReady()).transaction(FRIEND_STORE, 'readwrite');
  const store = tx.objectStore(FRIEND_STORE);
  const cached_at = new Date().toISOString();
  store.clear();
  for (const f of friends) store.put({ ...f, avatar_url: f.avatar_url ?? null, cached_at });
  await done(tx);
}

export async function getCachedGroups(): Promise<SplitwiseGroup[]> {
  const all = await req(
    (await dbReady()).transaction(GROUP_STORE).objectStore(GROUP_STORE)
      .getAll() as IDBRequest<(SplitwiseGroup & { cached_at: string })[]>
  );
  return all
    .map(({ id, name, member_ids, member_names }) => ({ id, name, member_ids, member_names }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Wholesale replace, same rationale as replaceCachedFriends above.
export async function replaceCachedGroups(groups: SplitwiseGroup[]): Promise<void> {
  const tx = (await dbReady()).transaction(GROUP_STORE, 'readwrite');
  const store = tx.objectStore(GROUP_STORE);
  const cached_at = new Date().toISOString();
  store.clear();
  for (const g of groups) store.put({ ...g, cached_at });
  await done(tx);
}
