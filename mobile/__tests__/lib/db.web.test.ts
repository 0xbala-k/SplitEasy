import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDb, getNewTransactions, getTransactionsByIds, getHistoryTransactions, upsertTransactions,
  deleteTransactionsByPlaidIds, updateTransactionStatus, getSplitDecision,
  insertSplitDecision, upsertSplitDecision, deleteSplitDecision,
  pruneOldTransactions, deleteAllTransactions,
  persistCombinedSplit, revertCombinedSplit,
  createVacation, getVacations, getVacation, getActiveVacation, startVacation, endVacation, deleteVacation,
  getVacationPendingTransactions, getVacationHistory, assignTransactionsToVacation,
  removeTransactionFromVacation, reconcileVacationStatuses, updateVacationDates,
  rekeyTransaction, markTransactionsReversed, getReviewTransactions, clearReview,
} from '@/lib/db.web';
import { PlaidTransaction, SplitDecision } from '@/lib/types';
import { toLocalDateString } from '@/lib/date';
import { VacationConflictError } from '@/lib/vacationErrors';

// Relative calendar dates have to be built in local time, the same way
// reconcileVacationStatuses computes "today". Deriving them from
// `toISOString()` instead makes these tests fail whenever the device's date
// and the UTC date disagree — e.g. any evening in US Pacific, where "yesterday"
// via UTC comes back as today's local date and nothing looks elapsed.
function localDate(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return toLocalDateString(d);
}

function plaidTx(id: string, over: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: id, merchant_name: 'Cafe', name: 'CAFE 123', amount: 20,
    iso_currency_code: 'USD', date: '2026-07-01', pending: false, ...over,
  };
}

function decision(txId: string, over: Partial<SplitDecision> = {}): SplitDecision {
  return {
    id: `dec_${txId}`, transaction_id: txId, splitwise_expense_id: `exp_${txId}`,
    friend_ids: ['1'], friend_names: ['Ana'], amount_each: 10,
    created_at: new Date().toISOString(), ...over,
  };
}

// Seed a row through a second raw IDB connection: fake-indexeddb shares data
// across connections. No explicit version here — always opens at whatever
// version the database is already at, so this stays correct as DB_VERSION
// bumps over time instead of needing to track it.
async function seedRaw(store: string, value: object) {
  const d = await new Promise<IDBDatabase>((res, rej) => {
    const open = indexedDB.open('spliteasy');
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); });
  d.close();
}

describe('db.web (IndexedDB)', () => {
  beforeEach(async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); // fresh DB per test
    await initDb();
  });

  it('upserts and reads new transactions sorted by date desc', async () => {
    await upsertTransactions([
      plaidTx('t1', { date: '2026-07-01' }),
      plaidTx('t2', { date: '2026-07-03' }),
    ]);
    const rows = await getNewTransactions();
    expect(rows.map((r) => r.id)).toEqual(['t2', 't1']);
    expect(rows[0]).toMatchObject({ status: 'new', pending: false, currency: 'USD' });
  });

  it('falls back to name and USD when merchant/currency missing', async () => {
    await upsertTransactions([plaidTx('t1', { merchant_name: null, iso_currency_code: null })]);
    const [row] = await getNewTransactions();
    expect(row.merchant_name).toBe('CAFE 123');
    expect(row.currency).toBe('USD');
  });

  it('does not overwrite non-new transactions on re-upsert', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await upsertTransactions([plaidTx('t1', { amount: 99 })]);
    const history = await getHistoryTransactions();
    expect(history[0].amount).toBe(20);
    expect(await getNewTransactions()).toHaveLength(0);
  });

  it('updates fields of still-new transactions on re-upsert', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20, pending: true })]);
    await upsertTransactions([plaidTx('t1', { amount: 25, pending: false })]);
    const [row] = await getNewTransactions();
    expect(row.amount).toBe(25);
    expect(row.pending).toBe(false);
  });

  it('joins split decisions into history rows', async () => {
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await updateTransactionStatus('t1', 'split');
    await updateTransactionStatus('t2', 'skipped');
    await insertSplitDecision(decision('t1', { friend_names: ['Ana', 'Bo'], amount_each: 6.67 }));
    const history = await getHistoryTransactions();
    const t1 = history.find((h) => h.id === 't1')!;
    const t2 = history.find((h) => h.id === 't2')!;
    expect(t1.split).toEqual({ friend_names: ['Ana', 'Bo'], amount_each: 6.67 });
    expect(t2.split).toBeUndefined();
  });

  it('round-trips split decisions and upserts by transaction_id', async () => {
    await insertSplitDecision(decision('t1'));
    await upsertSplitDecision(decision('t1', { amount_each: 5, splitwise_expense_id: 'exp2' }));
    const d = await getSplitDecision('t1');
    expect(d).toMatchObject({ amount_each: 5, splitwise_expense_id: 'exp2', friend_ids: ['1'] });
    await deleteSplitDecision('t1');
    expect(await getSplitDecision('t1')).toBeNull();
  });

  it('cascades decision deletes when transactions are deleted', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await insertSplitDecision(decision('t1'));
    await deleteTransactionsByPlaidIds(['t1']);
    expect(await getSplitDecision('t1')).toBeNull();
    expect(await getNewTransactions()).toHaveLength(0);
  });

  it('deleteAllTransactions clears both stores', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await insertSplitDecision(decision('t1'));
    await deleteAllTransactions();
    expect(await getNewTransactions()).toHaveLength(0);
    expect(await getSplitDecision('t1')).toBeNull();
  });

  it('prunes transactions older than 6 months', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await pruneOldTransactions();
    expect(await getNewTransactions()).toHaveLength(1);
  });

  it('prune deletes stale transactions and cascades their decisions', async () => {
    const old = new Date(); old.setMonth(old.getMonth() - 7);
    await seedRaw('transactions', { id: 'told', merchant_name: 'Old', amount: 1, currency: 'USD',
      date: '2025-12-01', status: 'split', pending: false, created_at: old.toISOString() });
    await seedRaw('split_decisions', decision('told'));
    await upsertTransactions([plaidTx('t1')]);
    await pruneOldTransactions();
    expect(await getSplitDecision('told')).toBeNull();
    expect((await getHistoryTransactions()).find((h) => h.id === 'told')).toBeUndefined();
    expect(await getNewTransactions()).toHaveLength(1);
  });

  it('persistCombinedSplit writes every decision and marks each transaction split', async () => {
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await persistCombinedSplit([
      decision('t1', { splitwise_expense_id: 'exp', description: 'Trip' }),
      decision('t2', { splitwise_expense_id: 'exp', description: 'Trip' }),
    ]);
    expect(await getNewTransactions()).toHaveLength(0);
    expect(await getSplitDecision('t1')).toMatchObject({ splitwise_expense_id: 'exp' });
    expect(await getSplitDecision('t2')).toMatchObject({ splitwise_expense_id: 'exp' });
  });

  it('persistCombinedSplit rolls the whole group back when one row is a duplicate', async () => {
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await insertSplitDecision(decision('t2'));
    await expect(
      persistCombinedSplit([decision('t1'), decision('t2')])
    ).rejects.toBeTruthy();
    // t1 must be untouched: no decision row, still 'new'.
    expect(await getSplitDecision('t1')).toBeNull();
    expect((await getNewTransactions()).map((t) => t.id)).toContain('t1');
  });

  it('revertCombinedSplit deletes decisions and returns transactions to new', async () => {
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await persistCombinedSplit([decision('t1'), decision('t2')]);
    await revertCombinedSplit(['t1', 't2']);
    expect(await getSplitDecision('t1')).toBeNull();
    expect(await getSplitDecision('t2')).toBeNull();
    expect((await getNewTransactions()).map((t) => t.id).sort()).toEqual(['t1', 't2']);
  });

  it('getTransactionsByIds returns matching rows and skips missing ids', async () => {
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    const rows = await getTransactionsByIds(['t1', 'missing', 't2']);
    expect(rows.map((r) => r.id).sort()).toEqual(['t1', 't2']);
    expect(await getTransactionsByIds([])).toEqual([]);
  });

  it('groups combined splits by expense id with summed amount and member metadata', async () => {
    await upsertTransactions([
      plaidTx('t1', { amount: 10, date: '2026-07-02' }),
      plaidTx('t2', { amount: 15, date: '2026-07-01' }),
    ]);
    await updateTransactionStatus('t1', 'split');
    await updateTransactionStatus('t2', 'split');
    await insertSplitDecision(decision('t1', { splitwise_expense_id: 'exp_shared' }));
    await insertSplitDecision(decision('t2', { splitwise_expense_id: 'exp_shared' }));
    const history = await getHistoryTransactions();
    expect(history).toHaveLength(1);
    const [item] = history;
    expect(item.id).toBe('exp_shared');
    expect(item.amount).toBe(25);
    expect(item.combined).toEqual({
      expense_id: 'exp_shared',
      transaction_ids: ['t1', 't2'],
      count: 2,
    });
  });

  it('uses the decision description as the display title when present', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1', { description: 'Team dinner' }));
    const [item] = await getHistoryTransactions();
    expect(item.merchant_name).toBe('Team dinner');
  });
});

describe('rekeyTransaction (IndexedDB)', () => {
  beforeEach(async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    await initDb();
  });

  it('returns not_found and writes nothing when the old id does not exist', async () => {
    const result = await rekeyTransaction('missing', plaidTx('new1'));
    expect(result).toBe('not_found');
    expect(await getTransactionsByIds(['new1'])).toEqual([]);
  });

  it('unchanged amount: preserves status/vacation_id/decision, clears pending, sets no review flag', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20, pending: true })], 'vac1');
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1', { friend_names: ['Ana'] }));

    const result = await rekeyTransaction('t1', plaidTx('new1', { amount: 20, pending: false }));

    expect(result).toBe('unchanged');
    expect(await getSplitDecision('t1')).toBeNull();
    const [row] = await getTransactionsByIds(['new1']);
    expect(row).toMatchObject({ status: 'split', pending: false, vacation_id: 'vac1' });
    expect(row.review_reason ?? null).toBeNull();
    const newDecision = await getSplitDecision('new1');
    expect(newDecision).toMatchObject({ transaction_id: 'new1', friend_names: ['Ana'] });
  });

  it('changed amount on a split row: flags amount_changed with the old amount, decision follows to the new id', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1'));

    const result = await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));

    expect(result).toBe('changed');
    const [row] = await getTransactionsByIds(['new1']);
    expect(row.amount).toBe(25);
    expect(row.review_reason).toBe('amount_changed');
    expect(row.amount_changed_from).toBe(20);
    expect(await getSplitDecision('new1')).toMatchObject({ transaction_id: 'new1' });
  });

  it('changed amount on a new row: no review flag, new amount stored', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);

    const result = await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));

    expect(result).toBe('changed');
    const [row] = await getTransactionsByIds(['new1']);
    expect(row.amount).toBe(25);
    expect(row.review_reason ?? null).toBeNull();
  });

  it('changed amount on a skipped row: no review flag, new amount stored', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'skipped');

    const result = await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));

    expect(result).toBe('changed');
    const [row] = await getTransactionsByIds(['new1']);
    expect(row.review_reason ?? null).toBeNull();
  });

  it('conflict: a split row already occupying the posted id is never clobbered', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1', { splitwise_expense_id: 'expMine' }));
    // A different transaction already holds the posted id AND its own expense.
    await upsertTransactions([plaidTx('new1', { amount: 99 })]);
    await updateTransactionStatus('new1', 'split');
    await insertSplitDecision(decision('new1', { splitwise_expense_id: 'expOther' }));

    const result = await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));

    expect(result).toBe('conflict');
    // Both rows survive untouched — neither Splitwise expense is stranded.
    expect(await getTransactionsByIds(['t1'])).toMatchObject([{ amount: 20, status: 'split' }]);
    expect(await getTransactionsByIds(['new1'])).toMatchObject([{ amount: 99, status: 'split' }]);
    expect(await getSplitDecision('t1')).toMatchObject({ splitwise_expense_id: 'expMine' });
    expect(await getSplitDecision('new1')).toMatchObject({ splitwise_expense_id: 'expOther' });
  });

  it('duplicate: a non-split row occupying the posted id is replaced by the rekeyed row', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1', { splitwise_expense_id: 'expMine', friend_names: ['Ana'] }));
    // The posted transaction was already inserted as a fresh 'new' row.
    await upsertTransactions([plaidTx('new1', { amount: 25 })]);

    const result = await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));

    expect(result).toBe('changed');
    expect(await getTransactionsByIds(['t1'])).toEqual([]);
    const rows = await getTransactionsByIds(['new1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'split', amount: 25, amount_changed_from: 20 });
    expect(await getSplitDecision('new1')).toMatchObject({ splitwise_expense_id: 'expMine', friend_names: ['Ana'] });
    // The duplicate is gone from the Transactions list, not left behind.
    expect(await getNewTransactions()).toEqual([]);
  });
});

describe('markTransactionsReversed (IndexedDB)', () => {
  beforeEach(async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    await initDb();
  });

  it('keeps and flags a split row as reversed', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1'));

    const kept = await markTransactionsReversed(['t1']);

    expect(kept).toEqual(['t1']);
    const [row] = await getTransactionsByIds(['t1']);
    expect(row.review_reason).toBe('reversed');
    expect(row.status).toBe('split');
    expect(await getSplitDecision('t1')).not.toBeNull();
  });

  it('deletes a new/skipped row along with its decision', async () => {
    await upsertTransactions([plaidTx('t1')]);

    const kept = await markTransactionsReversed(['t1']);

    expect(kept).toEqual([]);
    expect(await getTransactionsByIds(['t1'])).toEqual([]);
    expect(await getSplitDecision('t1')).toBeNull();
  });

  it('is a no-op for an empty list', async () => {
    const kept = await markTransactionsReversed([]);
    expect(kept).toEqual([]);
  });
});

describe('getReviewTransactions / clearReview (IndexedDB)', () => {
  beforeEach(async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
    await initDb();
  });

  it('returns a single review row with the review reason and amounts', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1', { splitwise_expense_id: 'exp1', friend_names: ['Ana'] }));
    await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));

    const items = await getReviewTransactions();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'new1', reason: 'amount_changed', amount: 25, amount_changed_from: 20,
      expense_id: 'exp1', transaction_ids: ['new1'],
    });
    expect(items[0].split.friend_names).toEqual(['Ana']);
  });

  it('groups combined-split members sharing an expense id, summing both amounts', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 12 }), plaidTx('t2', { amount: 8 })]);
    await persistCombinedSplit([
      decision('t1', { splitwise_expense_id: 'expShared' }),
      decision('t2', { splitwise_expense_id: 'expShared' }),
    ]);
    await rekeyTransaction('t1', plaidTx('new1', { amount: 15 }));
    await rekeyTransaction('t2', plaidTx('new2', { amount: 10 }));

    const items = await getReviewTransactions();

    expect(items).toHaveLength(1);
    expect(items[0].amount).toBe(25);
    expect(items[0].amount_changed_from).toBe(20);
    expect(items[0].transaction_ids.slice().sort()).toEqual(['new1', 'new2']);
  });

  it('a combined group with any reversed member reads as reversed', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 12 }), plaidTx('t2', { amount: 8 })]);
    await persistCombinedSplit([
      decision('t1', { splitwise_expense_id: 'expShared' }),
      decision('t2', { splitwise_expense_id: 'expShared' }),
    ]);
    await rekeyTransaction('t1', plaidTx('new1', { amount: 15 })); // amount_changed
    await markTransactionsReversed(['t2']);                        // reversed

    const items = await getReviewTransactions();

    expect(items).toHaveLength(1);
    // A stranded Splitwise expense outranks a mere amount change.
    expect(items[0].reason).toBe('reversed');
  });

  it('surfaces a reversed row with a null amount_changed_from', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1', { splitwise_expense_id: 'exp9' }));
    await markTransactionsReversed(['t1']);

    const [item] = await getReviewTransactions();
    expect(item.reason).toBe('reversed');
    expect(item.amount_changed_from).toBeNull();
  });

  it('clearReview clears the review flag and the transaction drops out of the queue', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await insertSplitDecision(decision('t1'));
    await rekeyTransaction('t1', plaidTx('new1', { amount: 25 }));
    expect(await getReviewTransactions()).toHaveLength(1);

    await clearReview(['new1']);

    expect(await getReviewTransactions()).toHaveLength(0);
    const [row] = await getTransactionsByIds(['new1']);
    expect(row.review_reason ?? null).toBeNull();
    expect(row.amount_changed_from ?? null).toBeNull();
  });
});

describe('vacation CRUD (IndexedDB)', () => {
  beforeEach(async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); // fresh DB per test
    await initDb();
  });

  test('createVacation inserts a draft row and returns it', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    expect(v).toMatchObject({ name: 'Hawaii', status: 'draft', start_date: null, end_date: null });
    const all = await getVacations();
    expect(all.map((x) => x.id)).toContain(v.id);
  });

  test('createVacation rejects an overlapping dated range', async () => {
    await createVacation({ name: 'Ski trip', start_date: '2026-08-01', end_date: '2026-08-10' });
    await expect(
      createVacation({ name: 'Hawaii', start_date: '2026-08-05', end_date: '2026-08-15' })
    ).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('createVacation allows adjacent non-overlapping dated ranges', async () => {
    await createVacation({ name: 'Ski trip', start_date: '2026-08-01', end_date: '2026-08-10' });
    const v = await createVacation({ name: 'Hawaii', start_date: '2026-08-11', end_date: '2026-08-20' });
    expect(v.name).toBe('Hawaii');
  });

  test('getVacation returns null when not found', async () => {
    expect(await getVacation('missing')).toBeNull();
  });

  test('getActiveVacation returns null until one is started', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    expect(await getActiveVacation()).toBeNull();
    await startVacation(v.id);
    expect((await getActiveVacation())?.id).toBe(v.id);
  });

  test('startVacation throws when another vacation is active', async () => {
    const a = await createVacation({ name: 'A' });
    const b = await createVacation({ name: 'B' });
    await startVacation(a.id);
    await expect(startVacation(b.id)).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('endVacation flips status to ended', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await startVacation(v.id);
    await endVacation(v.id);
    expect((await getVacation(v.id))?.status).toBe('ended');
  });

  test('deleteVacation unassigns pending transactions then removes the vacation', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    // Seed the row directly via the raw IDB helper (not upsertTransactions +
    // assignTransactionsToVacation — both gain vacation-awareness in Task 3,
    // which lands after this one) so this task's test suite is self-contained.
    await seedRaw('transactions', {
      id: 't1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-08-01',
      status: 'new', pending: false, created_at: new Date().toISOString(), vacation_id: v.id,
    });
    await deleteVacation(v.id);
    expect(await getVacation(v.id)).toBeNull();
    const [row] = await getNewTransactions();
    expect(row.vacation_id).toBeFalsy();
  });
});

describe('vacation transaction capture & history (IndexedDB)', () => {
  beforeEach(async () => {
    (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory(); // fresh DB per test
    await initDb();
  });

  it('getNewTransactions excludes vacation-assigned rows', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await assignTransactionsToVacation(v.id, ['t1']);
    const rows = await getNewTransactions();
    expect(rows.map((r) => r.id)).toEqual(['t2']);
  });

  it('upsertTransactions stamps new rows with the active vacation id', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await startVacation(v.id);
    await upsertTransactions([plaidTx('t1')], v.id);
    const [row] = await getVacationPendingTransactions(v.id);
    expect(row.id).toBe('t1');
  });

  it('upsertTransactions does not stamp when no vacation id is passed', async () => {
    await upsertTransactions([plaidTx('t1')]);
    const [row] = await getNewTransactions();
    expect(row.vacation_id).toBeFalsy();
  });

  it('assignTransactionsToVacation only moves eligible (new, unassigned) rows', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await updateTransactionStatus('t2', 'skipped');
    await assignTransactionsToVacation(v.id, ['t1', 't2']);
    const pending = await getVacationPendingTransactions(v.id);
    expect(pending.map((r) => r.id)).toEqual(['t1']);
  });

  it('removeTransactionFromVacation returns a transaction to the main list', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1')]);
    await assignTransactionsToVacation(v.id, ['t1']);
    await removeTransactionFromVacation('t1');
    expect((await getNewTransactions()).map((r) => r.id)).toEqual(['t1']);
    expect(await getVacationPendingTransactions(v.id)).toHaveLength(0);
  });

  it('getVacationHistory scopes combined-split grouping to the vacation', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1'), plaidTx('t2'), plaidTx('t3')]);
    await assignTransactionsToVacation(v.id, ['t1', 't2']);
    await persistCombinedSplit([
      decision('t1', { splitwise_expense_id: 'exp_shared' }),
      decision('t2', { splitwise_expense_id: 'exp_shared' }),
    ]);
    await updateTransactionStatus('t3', 'split');
    await insertSplitDecision(decision('t3', { splitwise_expense_id: 'exp_other' }));
    const history = await getVacationHistory(v.id);
    expect(history).toHaveLength(1);
    expect(history[0].combined?.count).toBe(2);
  });

  it('updateVacationDates rewrites the dates of an existing vacation', async () => {
    const v = await createVacation({ name: 'Hawaii', start_date: '2030-01-01', end_date: '2030-01-10' });
    await updateVacationDates(v.id, '2030-02-01', '2030-02-14');
    const updated = await getVacation(v.id);
    expect([updated?.start_date, updated?.end_date]).toEqual(['2030-02-01', '2030-02-14']);
  });

  it('updateVacationDates clears both dates, turning the vacation manual', async () => {
    const v = await createVacation({ name: 'Hawaii', start_date: '2030-01-01', end_date: '2030-01-10' });
    await updateVacationDates(v.id, null, null);
    const updated = await getVacation(v.id);
    expect([updated?.start_date, updated?.end_date]).toEqual([null, null]);
  });

  it('updateVacationDates rejects a range overlapping another vacation', async () => {
    await createVacation({ name: 'A', start_date: '2030-01-01', end_date: '2030-01-10' });
    const b = await createVacation({ name: 'B', start_date: '2030-02-01', end_date: '2030-02-10' });
    await expect(updateVacationDates(b.id, '2030-01-05', '2030-01-15')).rejects.toBeInstanceOf(
      VacationConflictError
    );
    // The rejected write must not have landed.
    expect((await getVacation(b.id))?.start_date).toBe('2030-02-01');
  });

  it('updateVacationDates does not treat a vacation as overlapping itself', async () => {
    const v = await createVacation({ name: 'Hawaii', start_date: '2030-01-01', end_date: '2030-01-10' });
    // Same range re-saved, and a range that still covers its own old one: both
    // only "overlap" this vacation, which the self-exclusion has to ignore.
    await expect(updateVacationDates(v.id, '2030-01-01', '2030-01-10')).resolves.toBeUndefined();
    await expect(updateVacationDates(v.id, '2030-01-05', '2030-01-20')).resolves.toBeUndefined();
    expect((await getVacation(v.id))?.end_date).toBe('2030-01-20');
  });

  it('updateVacationDates ignores overlap with an ended vacation', async () => {
    const a = await createVacation({ name: 'A', start_date: '2030-01-01', end_date: '2030-01-10' });
    await endVacation(a.id);
    const b = await createVacation({ name: 'B', start_date: '2030-02-01', end_date: '2030-02-10' });
    // Only draft and active vacations claim a date range, matching createVacation.
    await expect(updateVacationDates(b.id, '2030-01-05', '2030-01-15')).resolves.toBeUndefined();
  });

  it('reconcileVacationStatuses activates a draft whose start date has arrived', async () => {
    const v = await createVacation({ name: 'Hawaii', start_date: localDate(-1), end_date: '2099-01-01' });
    await reconcileVacationStatuses();
    expect((await getVacation(v.id))?.status).toBe('active');
  });

  it('reconcileVacationStatuses ends an active vacation whose end date has passed', async () => {
    const v = await createVacation({
      name: 'Hawaii',
      start_date: localDate(-5),
      end_date: localDate(-1),
    });
    await startVacation(v.id);
    await reconcileVacationStatuses();
    expect((await getVacation(v.id))?.status).toBe('ended');
  });

  it('reconcileVacationStatuses does not touch dateless (manual) vacations', async () => {
    const v = await createVacation({ name: 'Manual' });
    await reconcileVacationStatuses();
    expect((await getVacation(v.id))?.status).toBe('draft');
  });

  it('reconcileVacationStatuses activates at most one of two due, open-ended drafts', async () => {
    // Both have start_date in the past and no end_date, so createVacation's
    // overlap check (which only runs when both dates are set) never rejects
    // the second one — this is the scenario the native LIMIT-1 fix guards.
    const startDate = localDate(-3);
    const a = await createVacation({ name: 'A', start_date: startDate });
    const b = await createVacation({ name: 'B', start_date: startDate });
    await reconcileVacationStatuses();
    const statuses = [(await getVacation(a.id))?.status, (await getVacation(b.id))?.status];
    expect(statuses.filter((s) => s === 'active')).toHaveLength(1);
  });

  it('reconcileVacationStatuses ends a draft immediately if both its dates have already elapsed, without blocking a later activation', async () => {
    const elapsed = await createVacation({
      name: 'Elapsed', start_date: localDate(-10), end_date: localDate(-5),
    });
    const current = await createVacation({
      name: 'Current', start_date: localDate(-1),
    });
    await reconcileVacationStatuses();
    expect((await getVacation(elapsed.id))?.status).toBe('ended');
    expect((await getVacation(current.id))?.status).toBe('active');
  });

  it('reconcileVacationStatuses activates a new draft the same day an active vacation elapses', async () => {
    const a = await createVacation({
      name: 'A', start_date: localDate(-10), end_date: localDate(-1),
    });
    await startVacation(a.id);
    const b = await createVacation({ name: 'B', start_date: localDate(0), end_date: null });
    await reconcileVacationStatuses();
    expect((await getVacation(a.id))?.status).toBe('ended');
    expect((await getVacation(b.id))?.status).toBe('active');
  });
});
