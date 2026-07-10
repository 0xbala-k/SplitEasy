import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDb, getNewTransactions, getHistoryTransactions, upsertTransactions,
  deleteTransactionsByPlaidIds, updateTransactionStatus, getSplitDecision,
  insertSplitDecision, upsertSplitDecision, deleteSplitDecision,
  pruneOldTransactions, deleteAllTransactions,
} from '@/lib/db.web';
import { PlaidTransaction, SplitDecision } from '@/lib/types';

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
// across connections, and version 1 needs no upgrade handler here.
async function seedRaw(store: string, value: object) {
  const d = await new Promise<IDBDatabase>((res, rej) => {
    const open = indexedDB.open('spliteasy', 1);
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
});
