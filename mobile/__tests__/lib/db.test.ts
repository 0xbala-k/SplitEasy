// mobile/__tests__/lib/db.test.ts
jest.mock('expo-sqlite');

import * as SQLite from 'expo-sqlite';
import {
  initDb,
  getNewTransactions,
  getHistoryTransactions,
  upsertTransactions,
  deleteTransactionsByPlaidIds,
  updateTransactionStatus,
  getSplitDecision,
  insertSplitDecision,
  upsertSplitDecision,
  deleteSplitDecision,
  pruneOldTransactions,
  deleteAllTransactions,
  getTransactionsByIds,
  persistCombinedSplit,
  revertCombinedSplit,
  createVacation,
  getVacations,
  getVacation,
  getActiveVacation,
  startVacation,
  endVacation,
  deleteVacation,
  getVacationPendingTransactions,
  getVacationHistory,
  assignTransactionsToVacation,
  removeTransactionFromVacation,
  reconcileVacationStatuses,
  updateVacationDates,
  resetDbForTests,
  rekeyTransaction,
  markTransactionsReversed,
  getReviewTransactions,
  clearReview,
  getMerchantBuckets,
  setMerchantBucket,
  setTransactionBucket,
  getSplitwiseInbox,
  upsertInboxItem,
  dismissInboxItem,
  getLocalExpenseState,
  acceptSplitwiseExpense,
  updateImportedExpense,
  deleteImportedExpense,
  importedTransactionId,
} from '@/lib/db';
import { PlaidTransaction, SplitDecision, SplitwiseInboxItem } from '@/lib/types';
import { VacationConflictError, BucketLockedError } from '@/lib/vacationErrors';

const mockDb = {
  execAsync: jest.fn().mockResolvedValue(undefined),
  getAllAsync: jest.fn().mockResolvedValue([]),
  getFirstAsync: jest.fn().mockResolvedValue(null),
  runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
  // Run the transaction body immediately so inner runAsync calls are observable.
  withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { await task(); }),
};

beforeEach(() => {
  jest.clearAllMocks();
  (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
  resetDbForTests();
});

test('initDb opens database and runs migrations', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 0 });
  await initDb();
  expect(SQLite.openDatabaseAsync).toHaveBeenCalledWith('spliteasy.db');
  // WAL pragma
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('journal_mode = WAL')
  );
  // migration DDL
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('CREATE TABLE IF NOT EXISTS transactions')
  );
});

test('initDb skips migration when already at version 1', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 1 });
  await initDb();
  const ddlCalls = mockDb.execAsync.mock.calls.filter(([sql]: [string]) =>
    sql.includes('CREATE TABLE IF NOT EXISTS transactions')
  );
  expect(ddlCalls).toHaveLength(0);
});

test('getNewTransactions queries status=new', async () => {
  mockDb.getAllAsync.mockResolvedValue([
    { id: 'tx1', merchant_name: 'Starbucks', amount: 5.5, currency: 'USD', date: '2026-04-01', status: 'new', created_at: '2026-04-01T10:00:00Z' },
  ]);
  await initDb();
  const txs = await getNewTransactions();
  expect(mockDb.getAllAsync).toHaveBeenCalledWith(
    expect.stringContaining("status = 'new'"),
    []
  );
  expect(txs).toHaveLength(1);
  expect(txs[0].id).toBe('tx1');
});

test('upsertTransactions inserts with status=new by default', async () => {
  await initDb();
  const plaidTx: PlaidTransaction = {
    transaction_id: 'ptx1',
    merchant_name: 'Amazon',
    name: 'AMZN',
    amount: 29.99,
    iso_currency_code: 'USD',
    date: '2026-04-10',
  };
  await upsertTransactions([plaidTx]);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT OR IGNORE'),
    expect.arrayContaining(['ptx1', 'Amazon', 29.99])
  );
});

test('upsertTransactions uses name when merchant_name is null', async () => {
  await initDb();
  const plaidTx: PlaidTransaction = {
    transaction_id: 'ptx2',
    merchant_name: null,
    name: 'ACH Transfer',
    amount: 100,
    iso_currency_code: 'USD',
    date: '2026-04-10',
  };
  await upsertTransactions([plaidTx]);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.any(String),
    expect.arrayContaining(['ACH Transfer'])
  );
});

test('updateTransactionStatus updates the status field', async () => {
  await initDb();
  await updateTransactionStatus('tx1', 'skipped');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE transactions SET status'),
    ['skipped', 'tx1']
  );
});

test('getSplitDecision returns null when not found', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 1 });
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce(null);
  const result = await getSplitDecision('tx1');
  expect(result).toBeNull();
});

test('getSplitDecision parses JSON arrays', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 1 });
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce({
    id: 'sd1',
    transaction_id: 'tx1',
    splitwise_expense_id: 'exp1',
    friend_ids: '["123","456"]',
    friend_names: '["Alex","Sam"]',
    amount_each: 10.0,
    created_at: '2026-04-01T10:00:00Z',
  });
  const result = await getSplitDecision('tx1');
  expect(result?.friend_ids).toEqual(['123', '456']);
  expect(result?.friend_names).toEqual(['Alex', 'Sam']);
});

test('pruneOldTransactions runs DELETE with 6-month cutoff', async () => {
  await initDb();
  await pruneOldTransactions();
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining("-6 months"),
    []
  );
});

test('deleteAllTransactions deletes only Plaid-origin rows, including legacy NULL-source ones', async () => {
  await initDb();
  await deleteAllTransactions();
  // A bare `source <> 'splitwise'` would match nothing for a NULL-source row
  // (every row written before this branch), since NULL <> 'splitwise' is NULL,
  // not true, in SQL — the explicit `source IS NULL` arm is required.
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining("DELETE FROM transactions WHERE source IS NULL OR source <> 'splitwise'"),
    []
  );
});

test('deleteAllTransactions deletes split_decisions only for the rows it deletes, preserving imported ones', async () => {
  await initDb();
  await deleteAllTransactions();
  const decisionCall = mockDb.runAsync.mock.calls.find(([sql]: [string]) =>
    sql.includes('DELETE FROM split_decisions')
  );
  expect(decisionCall).toBeDefined();
  expect(decisionCall![0]).toEqual(
    expect.stringContaining("source IS NULL OR source <> 'splitwise'")
  );
});

test('deleteAllTransactions deletes split_decisions before transactions, inside one db transaction', async () => {
  await initDb();
  await deleteAllTransactions();
  expect(mockDb.withTransactionAsync).toHaveBeenCalled();
  const calls = mockDb.runAsync.mock.calls;
  const decisionIdx = calls.findIndex(([sql]: [string]) => sql.includes('DELETE FROM split_decisions'));
  const txIdx = calls.findIndex(([sql]: [string]) => sql.trim().startsWith('DELETE FROM transactions'));
  expect(decisionIdx).toBeGreaterThanOrEqual(0);
  expect(txIdx).toBeGreaterThan(decisionIdx);
});

test('upsertSplitDecision upserts on transaction_id conflict', async () => {
  await initDb();
  await upsertSplitDecision({
    id: 'sd1',
    transaction_id: 'tx1',
    splitwise_expense_id: 'exp1',
    friend_ids: ['2'],
    friend_names: ['Sam'],
    amount_each: 10,
    created_at: '2026-06-12T00:00:00Z',
  });
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('ON CONFLICT(transaction_id)'),
    expect.arrayContaining(['sd1', 'tx1', 'exp1', '["2"]', '["Sam"]', 10, '2026-06-12T00:00:00Z'])
  );
});

test('deleteSplitDecision deletes by transaction_id', async () => {
  await initDb();
  await deleteSplitDecision('tx1');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM split_decisions'),
    ['tx1']
  );
});

test('initDb migrates a v1 install by adding both pending and description columns', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 1 });
  await initDb();
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE transactions ADD COLUMN pending')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE split_decisions ADD COLUMN description')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('user_version = 7')
  );
});

test('initDb migrates an existing v2 install by adding the description column', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 2 });
  await initDb();
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE split_decisions ADD COLUMN description')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('user_version = 7')
  );
});

test('initDb migrates an existing v4 install by adding review columns', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 4 });
  await initDb();
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE transactions ADD COLUMN review_reason')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE transactions ADD COLUMN amount_changed_from')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('user_version = 7')
  );
});

test('initDb skips the review-column migration when already at version 5', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 5 });
  await initDb();
  const alterCalls = mockDb.execAsync.mock.calls.filter(([sql]: [string]) =>
    sql.includes('ADD COLUMN review_reason')
  );
  expect(alterCalls).toHaveLength(0);
});

test('insertSplitDecision persists the description', async () => {
  await initDb();
  await insertSplitDecision({
    id: 'sd1',
    transaction_id: 'tx1',
    splitwise_expense_id: 'exp1',
    friend_ids: ['2'],
    friend_names: ['Sam'],
    amount_each: 10,
    created_at: '2026-07-06T00:00:00Z',
    description: 'Team lunch',
  });
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('description'),
    expect.arrayContaining(['sd1', 'tx1', 'exp1', '["2"]', '["Sam"]', 10, '2026-07-06T00:00:00Z', 'Team lunch'])
  );
});

test('getSplitDecision returns the description', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 3 });
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce({
    id: 'sd1',
    transaction_id: 'tx1',
    splitwise_expense_id: 'exp1',
    friend_ids: '["2"]',
    friend_names: '["Sam"]',
    amount_each: 10,
    created_at: '2026-07-06T00:00:00Z',
    description: 'Team lunch',
  });
  const result = await getSplitDecision('tx1');
  expect(result?.description).toBe('Team lunch');
});

test('getTransactionsByIds returns empty for no ids without querying', async () => {
  await initDb();
  mockDb.getAllAsync.mockClear();
  const result = await getTransactionsByIds([]);
  expect(result).toEqual([]);
  expect(mockDb.getAllAsync).not.toHaveBeenCalled();
});

test('getTransactionsByIds queries by id list and maps pending', async () => {
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'A', amount: 5, currency: 'USD', date: '2026-07-01', status: 'split', pending: 1, created_at: '2026-07-01T00:00:00Z' },
  ]);
  const result = await getTransactionsByIds(['tx1', 'tx2']);
  expect(mockDb.getAllAsync).toHaveBeenCalledWith(
    expect.stringContaining('WHERE id IN (?,?)'),
    ['tx1', 'tx2']
  );
  expect(result[0].pending).toBe(true);
});

test('getHistoryTransactions returns single split rows keyed by transaction id', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 3 });
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Amazon', amount: 20, currency: 'USD', date: '2026-07-01', status: 'split', pending: 0, created_at: 'x',
      splitwise_expense_id: 'exp1', description: 'Books', friend_names: '["Sam"]', amount_each: 10 },
  ]);
  const items = await getHistoryTransactions();
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe('tx1');
  expect(items[0].merchant_name).toBe('Books');          // description wins
  expect(items[0].currency).toBe('USD');
  expect(items[0].combined).toBeUndefined();
  expect(items[0].split?.friend_names).toEqual(['Sam']);
});

test('getHistoryTransactions surfaces a split row missing its expense id (not as skipped)', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 3 });
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Amazon', amount: 20, currency: 'USD', date: '2026-07-01', status: 'split', pending: 0, created_at: 'x',
      splitwise_expense_id: null, description: 'Books', friend_names: '["Sam"]', amount_each: 10 },
  ]);
  const items = await getHistoryTransactions();
  expect(items).toHaveLength(1);
  expect(items[0].status).toBe('split');
  expect(items[0].split?.friend_names).toEqual(['Sam']);
  expect(items[0].combined).toBeUndefined();
});

test('getHistoryTransactions collapses shared-expense rows into one combined item', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 3 });
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Amazon', amount: 20, currency: 'USD', date: '2026-07-02', status: 'split', pending: 0, created_at: 'x',
      splitwise_expense_id: 'expShared', description: 'Trip', friend_names: '["Sam"]', amount_each: 15 },
    { id: 'tx2', merchant_name: 'Uber', amount: 10, currency: 'USD', date: '2026-07-01', status: 'split', pending: 0, created_at: 'x',
      splitwise_expense_id: 'expShared', description: 'Trip', friend_names: '["Sam"]', amount_each: 15 },
  ]);
  const items = await getHistoryTransactions();
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe('expShared');
  expect(items[0].amount).toBe(30);                        // summed
  expect(items[0].combined).toEqual({ expense_id: 'expShared', transaction_ids: ['tx1', 'tx2'], count: 2 });
});

test('getHistoryTransactions keeps skipped rows individual', async () => {
  mockDb.getFirstAsync.mockResolvedValue({ user_version: 3 });
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx9', merchant_name: 'Netflix', amount: 12, currency: 'USD', date: '2026-07-01', status: 'skipped', pending: 0, created_at: 'x',
      splitwise_expense_id: null, description: null, friend_names: null, amount_each: null },
  ]);
  const items = await getHistoryTransactions();
  expect(items).toHaveLength(1);
  expect(items[0].id).toBe('tx9');
  expect(items[0].status).toBe('skipped');
  expect(items[0].split).toBeUndefined();
});

it('history carries source and payer_name through', async () => {
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'sw:555', merchant_name: 'Dinner', amount: 60, currency: 'USD', date: '2026-08-20',
      status: 'split', pending: 0, created_at: '2026-08-24T00:00:00.000Z',
      source: 'splitwise', payer_name: 'Alice Ng', bucket: 'food', vacation_id: null,
      splitwise_expense_id: '555', description: null, friend_names: '["Alice Ng"]', amount_each: 30 },
  ]);
  const [row] = await getHistoryTransactions();
  expect(row.source).toBe('splitwise');
  expect(row.payer_name).toBe('Alice Ng');
});

it('a Plaid row reports source plaid even when the column is null', async () => {
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-08-20',
      status: 'skipped', pending: 0, created_at: '2026-08-24T00:00:00.000Z',
      source: null, payer_name: null, bucket: 'food', vacation_id: null,
      splitwise_expense_id: null, description: null, friend_names: null, amount_each: null },
  ]);
  const [row] = await getHistoryTransactions();
  expect(row.source).toBe('plaid');
  expect(row.payer_name).toBeNull();
});

test('persistCombinedSplit writes every row and status inside one transaction', async () => {
  await initDb();
  const decisions: SplitDecision[] = [
    { id: 'a', transaction_id: 'txA', splitwise_expense_id: 'exp', friend_ids: ['2'], friend_names: ['Sam'], amount_each: 5, created_at: 'x', description: 'Trip' },
    { id: 'b', transaction_id: 'txB', splitwise_expense_id: 'exp', friend_ids: ['2'], friend_names: ['Sam'], amount_each: 5, created_at: 'x', description: 'Trip' },
  ];
  await persistCombinedSplit(decisions);
  expect(mockDb.withTransactionAsync).toHaveBeenCalledTimes(1);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO split_decisions'),
    expect.arrayContaining(['a', 'txA', 'exp'])
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE transactions SET status'),
    ['split', 'txA']
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE transactions SET status'),
    ['split', 'txB']
  );
});

test('revertCombinedSplit deletes rows and reverts statuses inside one transaction', async () => {
  await initDb();
  await revertCombinedSplit(['txA', 'txB']);
  expect(mockDb.withTransactionAsync).toHaveBeenCalledTimes(1);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM split_decisions'),
    ['txA']
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE transactions SET status'),
    ['new', 'txA']
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('UPDATE transactions SET status'),
    ['new', 'txB']
  );
});

test('deleteTransactionsByPlaidIds also deletes matching split_decisions rows (inert-cascade regression)', async () => {
  // Native SQLite never issues `PRAGMA foreign_keys = ON`, so the
  // `ON DELETE CASCADE` on split_decisions.transaction_id is inert — this
  // must delete split_decisions explicitly, mirroring db.web.ts.
  await initDb();
  await deleteTransactionsByPlaidIds(['tx1', 'tx2']);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM split_decisions WHERE transaction_id IN'),
    ['tx1', 'tx2']
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM transactions WHERE id IN'),
    ['tx1', 'tx2']
  );
});

describe('rekeyTransaction', () => {
  beforeEach(async () => {
    await initDb();
  });

  function posted(over: Partial<PlaidTransaction> = {}): PlaidTransaction {
    return {
      transaction_id: 'new1', merchant_name: 'Cafe', name: 'CAFE', amount: 10,
      iso_currency_code: 'USD', date: '2026-08-01', pending: false, ...over,
    };
  }

  test('returns not_found and writes nothing when the old id does not exist', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce(null);
    const result = await rekeyTransaction('old1', posted());
    expect(result).toBe('not_found');
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });

  test('unchanged amount: rekeys the row, clears pending, sets no review flag', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'split' });
    const result = await rekeyTransaction('old1', posted({ amount: 10 }));
    expect(result).toBe('unchanged');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET id'),
      ['new1', 'Cafe', 10, '2026-08-01', null, null, 'old1']
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE split_decisions SET transaction_id'),
      ['new1', 'old1']
    );
  });

  test('changed amount on a split row: flags amount_changed with the old amount, decision follows to the new id', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'split' });
    const result = await rekeyTransaction('old1', posted({ amount: 12.5 }));
    expect(result).toBe('changed');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET id'),
      ['new1', 'Cafe', 12.5, '2026-08-01', 'amount_changed', 10, 'old1']
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE split_decisions SET transaction_id'),
      ['new1', 'old1']
    );
  });

  test('changed amount on a new row: no review flag, new amount stored', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'new' });
    const result = await rekeyTransaction('old1', posted({ amount: 12.5 }));
    expect(result).toBe('changed');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET id'),
      ['new1', 'Cafe', 12.5, '2026-08-01', null, null, 'old1']
    );
  });

  test('changed amount on a skipped row: no review flag, new amount stored', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'skipped' });
    const result = await rekeyTransaction('old1', posted({ amount: 12.5 }));
    expect(result).toBe('changed');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET id'),
      ['new1', 'Cafe', 12.5, '2026-08-01', null, null, 'old1']
    );
  });

  test('conflict: a split row already occupying the posted id is never clobbered', async () => {
    mockDb.getFirstAsync
      .mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'split' })
      .mockResolvedValueOnce({ id: 'new1', status: 'split' });
    const result = await rekeyTransaction('old1', posted({ amount: 12.5 }));
    expect(result).toBe('conflict');
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });

  test('duplicate: a non-split row occupying the posted id is dropped, then the rekey proceeds', async () => {
    mockDb.getFirstAsync
      .mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'split' })
      .mockResolvedValueOnce({ id: 'new1', status: 'new' });
    const result = await rekeyTransaction('old1', posted({ amount: 12.5 }));
    expect(result).toBe('changed');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM transactions'),
      ['new1']
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE transactions SET id'),
      ['new1', 'Cafe', 12.5, '2026-08-01', 'amount_changed', 10, 'old1']
    );
  });

  test('does not probe for a collision when the posted id is unchanged', async () => {
    mockDb.getFirstAsync.mockClear(); // drop initDb's user_version read from the count
    mockDb.getFirstAsync.mockResolvedValueOnce({ id: 'old1', amount: 10, status: 'split' });
    const result = await rekeyTransaction('old1', posted({ transaction_id: 'old1', amount: 10 }));
    expect(result).toBe('unchanged');
    expect(mockDb.getFirstAsync).toHaveBeenCalledTimes(1);
  });
});

describe('markTransactionsReversed', () => {
  beforeEach(async () => {
    await initDb();
  });

  test('keeps and flags a split row as reversed', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Cafe', amount: 10, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x' },
    ]);
    const kept = await markTransactionsReversed(['tx1']);
    expect(kept).toEqual(['tx1']);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("review_reason = 'reversed'"),
      ['tx1']
    );
  });

  test('deletes a new/skipped row along with its decision', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Cafe', amount: 10, currency: 'USD', date: '2026-08-01', status: 'new', pending: 0, created_at: 'x' },
    ]);
    const kept = await markTransactionsReversed(['tx1']);
    expect(kept).toEqual([]);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM split_decisions'),
      ['tx1']
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM transactions'),
      ['tx1']
    );
  });

  test('is a no-op for an empty list', async () => {
    mockDb.runAsync.mockClear();
    const kept = await markTransactionsReversed([]);
    expect(kept).toEqual([]);
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });
});

describe('getReviewTransactions', () => {
  beforeEach(async () => {
    await initDb();
  });

  test('returns single review rows with the review reason and amounts', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Cafe', amount: 12.5, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x',
        review_reason: 'amount_changed', amount_changed_from: 10,
        splitwise_expense_id: 'exp1', description: null, friend_names: '["Sam"]', amount_each: 6.25 },
    ]);
    const items = await getReviewTransactions();
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('review_reason IS NOT NULL'),
      []
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'tx1', reason: 'amount_changed', amount: 12.5, amount_changed_from: 10,
      expense_id: 'exp1', transaction_ids: ['tx1'],
    });
    expect(items[0].split.friend_names).toEqual(['Sam']);
  });

  test('groups combined-split members sharing an expense id, summing both amounts', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Cafe', amount: 12, currency: 'USD', date: '2026-08-02', status: 'split', pending: 0, created_at: 'x',
        review_reason: 'amount_changed', amount_changed_from: 10,
        splitwise_expense_id: 'expShared', description: 'Trip', friend_names: '["Sam"]', amount_each: 6 },
      { id: 'tx2', merchant_name: 'Uber', amount: 8, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x',
        review_reason: 'amount_changed', amount_changed_from: 5,
        splitwise_expense_id: 'expShared', description: 'Trip', friend_names: '["Sam"]', amount_each: 6 },
    ]);
    const items = await getReviewTransactions();
    expect(items).toHaveLength(1);
    expect(items[0].amount).toBe(20);
    expect(items[0].amount_changed_from).toBe(15);
    expect(items[0].transaction_ids.slice().sort()).toEqual(['tx1', 'tx2']);
  });

  test('a combined group with any reversed member reads as reversed', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Cafe', amount: 12, currency: 'USD', date: '2026-08-02', status: 'split', pending: 0, created_at: 'x',
        review_reason: 'amount_changed', amount_changed_from: 10,
        splitwise_expense_id: 'expShared', description: 'Trip', friend_names: '["Sam"]', amount_each: 6 },
      { id: 'tx2', merchant_name: 'Uber', amount: 8, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x',
        review_reason: 'reversed', amount_changed_from: null,
        splitwise_expense_id: 'expShared', description: 'Trip', friend_names: '["Sam"]', amount_each: 6 },
    ]);
    const items = await getReviewTransactions();
    expect(items).toHaveLength(1);
    // A stranded Splitwise expense outranks a mere amount change.
    expect(items[0].reason).toBe('reversed');
  });

  test('surfaces a reversed row with a null amount_changed_from', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx9', merchant_name: 'Cafe', amount: 10, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x',
        review_reason: 'reversed', amount_changed_from: null,
        splitwise_expense_id: 'exp9', description: null, friend_names: '["Sam"]', amount_each: 5 },
    ]);
    const [item] = await getReviewTransactions();
    expect(item.reason).toBe('reversed');
    expect(item.amount_changed_from).toBeNull();
  });
});

test('clearReview clears the review flag and old amount', async () => {
  await initDb();
  await clearReview(['tx1', 'tx2']);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('review_reason = NULL'),
    ['tx1', 'tx2']
  );
});

test('clearReview is a no-op for an empty list', async () => {
  await initDb();
  mockDb.runAsync.mockClear();
  await clearReview([]);
  expect(mockDb.runAsync).not.toHaveBeenCalled();
});

describe('vacation CRUD', () => {
  beforeEach(async () => {
    mockDb.getFirstAsync.mockResolvedValue({ user_version: 5 });
    await initDb();
  });

  test('createVacation inserts a draft row and returns it', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO vacations'),
      expect.arrayContaining([expect.any(String), 'Hawaii', null, null, 'draft'])
    );
    expect(v).toMatchObject({ name: 'Hawaii', status: 'draft', start_date: null, end_date: null });
  });

  test('createVacation rejects an overlapping dated range', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([{ id: 'other', name: 'Ski trip' }]);
    await expect(
      createVacation({ name: 'Hawaii', start_date: '2026-08-01', end_date: '2026-08-10' })
    ).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('createVacation allows non-overlapping dated ranges', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    const v = await createVacation({ name: 'Hawaii', start_date: '2026-08-01', end_date: '2026-08-10' });
    expect(v.start_date).toBe('2026-08-01');
    expect(v.end_date).toBe('2026-08-10');
  });

  test('getVacations maps rows and parses group member ids', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'v1', name: 'Hawaii', start_date: null, end_date: null, status: 'draft',
        splitwise_group_id: '9', splitwise_group_name: 'Trip', splitwise_group_member_ids: '["1","2"]',
        created_at: 'x', started_at: null, ended_at: null },
    ]);
    const rows = await getVacations();
    expect(rows[0].splitwise_group_member_ids).toEqual(['1', '2']);
  });

  test('getVacation returns null when not found', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce(null);
    expect(await getVacation('missing')).toBeNull();
  });

  test('getActiveVacation queries status=active', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce(null);
    await getActiveVacation();
    expect(mockDb.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      []
    );
  });

  test('startVacation flips status to active when none other is active', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    await startVacation('v1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'active'"),
      expect.arrayContaining([expect.any(String), 'v1'])
    );
  });

  test('startVacation throws VacationConflictError when another vacation is active', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([{ id: 'other' }]);
    await expect(startVacation('v1')).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('endVacation flips status to ended', async () => {
    await endVacation('v1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ended'"),
      expect.arrayContaining([expect.any(String), 'v1'])
    );
  });

  test('deleteVacation unassigns pending transactions then deletes the row, in one transaction', async () => {
    await deleteVacation('v1');
    expect(mockDb.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET vacation_id = NULL'),
      ['v1']
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM vacations'),
      ['v1']
    );
  });
});

describe('vacation transaction capture & history', () => {
  beforeEach(async () => {
    mockDb.getFirstAsync.mockResolvedValue({ user_version: 5 });
    await initDb();
  });

  test('getNewTransactions filters out vacation-assigned rows', async () => {
    await getNewTransactions();
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('vacation_id IS NULL'),
      []
    );
  });

  test('upsertTransactions stamps new rows with the active vacation id', async () => {
    await upsertTransactions(
      [{ transaction_id: 'ptx1', merchant_name: 'Amazon', name: 'AMZN', amount: 10, iso_currency_code: 'USD', date: '2026-08-01', pending: false }],
      'vac1'
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE'),
      expect.arrayContaining(['ptx1', 'vac1'])
    );
  });

  test('upsertTransactions stamps null when no vacation is active', async () => {
    await upsertTransactions([{ transaction_id: 'ptx1', merchant_name: 'Amazon', name: 'AMZN', amount: 10, iso_currency_code: 'USD', date: '2026-08-01', pending: false }]);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE'),
      expect.arrayContaining(['ptx1', null])
    );
  });

  test('getVacationPendingTransactions queries by vacation id and status=new', async () => {
    await getVacationPendingTransactions('vac1');
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("status = 'new'"),
      ['vac1']
    );
  });

  test('getVacationHistory scopes the history query to the vacation and groups combined splits', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Amazon', amount: 20, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x',
        splitwise_expense_id: 'exp1', description: null, friend_names: '["Sam"]', amount_each: 10 },
    ]);
    const items = await getVacationHistory('vac1');
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('t.vacation_id = ?'),
      ['vac1']
    );
    expect(items).toHaveLength(1);
    expect(items[0].split?.friend_names).toEqual(['Sam']);
  });

  test('assignTransactionsToVacation bulk-updates eligible transactions', async () => {
    await assignTransactionsToVacation('vac1', ['t1', 't2']);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET vacation_id = ? WHERE id IN (?,?)"),
      ['vac1', 't1', 't2']
    );
  });

  test('assignTransactionsToVacation is a no-op for an empty list', async () => {
    mockDb.runAsync.mockClear();
    await assignTransactionsToVacation('vac1', []);
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });

  test('updateVacationDates excludes the vacation itself from the overlap check', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    await updateVacationDates('vac1', '2030-01-01', '2030-01-10');
    const [sql, params] = mockDb.getAllAsync.mock.calls.find(([s]: [string]) =>
      s.includes('start_date <= ?')
    )!;
    // Without `id != ?` a vacation always conflicts with its own saved range,
    // making every date edit impossible.
    expect(sql).toContain('id != ?');
    expect(params).toEqual(['vac1', '2030-01-10', '2030-01-01']);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET start_date = ?, end_date = ?'),
      ['2030-01-01', '2030-01-10', 'vac1']
    );
  });

  test('updateVacationDates skips the overlap query when clearing dates', async () => {
    await updateVacationDates('vac1', null, null);
    expect(mockDb.getAllAsync).not.toHaveBeenCalled();
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET start_date = ?, end_date = ?'),
      [null, null, 'vac1']
    );
  });

  test('removeTransactionFromVacation clears vacation_id for a pending row', async () => {
    await removeTransactionFromVacation('t1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET vacation_id = NULL'),
      ['t1']
    );
  });

  test('reconcileVacationStatuses activates due drafts then ends elapsed actives', async () => {
    await reconcileVacationStatuses();
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'active'"),
      expect.arrayContaining([expect.any(String), expect.any(String)])
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ended'"),
      expect.arrayContaining([expect.any(String), expect.any(String)])
    );
  });

  test('reconcileVacationStatuses caps activation to a single row per call', async () => {
    // Regression: without the `id = (SELECT ... LIMIT 1)` clause, SQLite's
    // UPDATE would activate every due draft in one pass since it evaluates
    // the WHERE against the pre-update snapshot for all matching rows.
    await reconcileVacationStatuses();
    const [sql, params] = mockDb.runAsync.mock.calls.find(([s]: [string]) => s.includes("SET status = 'active'"))!;
    expect(sql).toContain('LIMIT 1');
    expect(params).toHaveLength(3);
  });

  test('reconcileVacationStatuses ends an elapsed active vacation before attempting to activate a new draft', async () => {
    await reconcileVacationStatuses();
    const calls = mockDb.runAsync.mock.calls;
    const endActiveIdx = calls.findIndex(([s]: [string]) => s.includes("WHERE status = 'active' AND end_date"));
    const activateIdx = calls.findIndex(([s]: [string]) => s.includes("SET status = 'active'"));
    expect(endActiveIdx).toBeGreaterThanOrEqual(0);
    expect(activateIdx).toBeGreaterThan(endActiveIdx);
  });
});

test('migration v6 adds bucket columns and the merchant_buckets table', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 5 });
  await initDb();
  const sql = mockDb.execAsync.mock.calls.map(([s]: [string]) => s).join('\n');
  expect(sql).toContain('ADD COLUMN bucket TEXT');
  expect(sql).toContain('ADD COLUMN bucket_source TEXT');
  expect(sql).toContain('ADD COLUMN plaid_category TEXT');
  expect(sql).toContain('CREATE TABLE IF NOT EXISTS merchant_buckets');
  expect(sql).toContain('PRAGMA user_version = 7');
});

test('migration v6 columns are added on a fresh install too', async () => {
  // A version-0 database does not get these columns from the base CREATE
  // TABLE, so the ALTERs must not be gated behind version >= 1.
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 0 });
  await initDb();
  const sql = mockDb.execAsync.mock.calls.map(([s]: [string]) => s).join('\n');
  expect(sql).toContain('ADD COLUMN bucket TEXT');
  expect(sql).toContain('ADD COLUMN plaid_category TEXT');
});

test('initDb runs no migration when already at version 6', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 6 });
  await initDb();
  const sql = mockDb.execAsync.mock.calls.map(([s]: [string]) => s).join('\n');
  expect(sql).not.toContain('ADD COLUMN bucket TEXT');
  expect(sql).not.toContain('PRAGMA user_version = 6');
});

test('upsertTransactions stores the detailed Plaid category', async () => {
  await initDb();
  await upsertTransactions([{
    transaction_id: 'ptx9', merchant_name: 'Safeway', name: 'SAFEWAY', amount: 42,
    iso_currency_code: 'USD', date: '2026-08-10', pending: false,
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' },
  }]);
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT OR IGNORE'),
    expect.arrayContaining(['FOOD_AND_DRINK_GROCERIES'])
  );
});

test('upsertTransactions stores null when Plaid sends no category', async () => {
  await initDb();
  await upsertTransactions([{
    transaction_id: 'ptx10', merchant_name: 'Mystery', name: 'MYSTERY', amount: 5,
    iso_currency_code: 'USD', date: '2026-08-10', pending: false,
  }]);
  const insert = mockDb.runAsync.mock.calls.find(([s]: [string]) => s.includes('INSERT OR IGNORE'));
  expect(insert![1]).toContain(null);
});

test('setMerchantBucket upserts and getMerchantBuckets returns a keyed map', async () => {
  await initDb();
  await setMerchantBucket('starbucks', 'needs');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO merchant_buckets'),
    expect.arrayContaining(['starbucks', 'needs'])
  );

  mockDb.getAllAsync.mockResolvedValueOnce([
    { merchant_key: 'starbucks', bucket: 'needs' },
    { merchant_key: 'amazon', bucket: 'shopping' },
  ]);
  await expect(getMerchantBuckets()).resolves.toEqual({ starbucks: 'needs', amazon: 'shopping' });
});

test('updateTransactionStatus materializes a bucket when committing', async () => {
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([]); // merchant_buckets
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Safeway', plaid_category: 'FOOD_AND_DRINK_GROCERIES', bucket: null, vacation_id: null },
  ]);
  await updateTransactionStatus('tx1', 'skipped');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('SET bucket = ?, bucket_source = ?'),
    ['needs', 'auto', 'tx1']
  );
});

test('updateTransactionStatus clears a non-manual bucket when reverting to new', async () => {
  await initDb();
  await updateTransactionStatus('tx1', 'new');
  // The predicate must clear anything that is not 'manual' — including
  // 'vacation' — not just 'auto', or a transaction removed from a vacation
  // after being committed would be stranded in Travel forever (bucket stays
  // 'travel' while status is 'new', violating the "NULL bucket means
  // uncommitted" invariant). Assert the shared clause directly rather than
  // pinning to 'auto' only, and guard against a regression that narrows it
  // back to 'auto' alone.
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining("bucket_source IS NULL OR bucket_source != 'manual'"),
    ['tx1']
  );
  const revertCalls = mockDb.runAsync.mock.calls.filter(([sql]: [string]) => sql.includes('bucket = NULL'));
  expect(revertCalls.some(([sql]: [string]) => sql.includes("= 'auto'"))).toBe(false);
});

test('updateTransactionStatus preserves an auto bucket_source when re-committing an already-bucketed row', async () => {
  await initDb();
  mockDb.getAllAsync.mockResolvedValueOnce([]); // merchant_buckets
  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 'tx1', merchant_name: 'Safeway', plaid_category: 'FOOD_AND_DRINK_GROCERIES', bucket: 'needs', bucket_source: 'auto', vacation_id: null },
  ]);
  await updateTransactionStatus('tx1', 'split');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('SET bucket = ?, bucket_source = ?'),
    ['needs', 'auto', 'tx1']
  );
});

test('setTransactionBucket writes the bucket and teaches the merchant', async () => {
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce({ merchant_name: 'STARBUCKS #4471', vacation_id: null });
  await setTransactionBucket('tx1', 'needs');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining("bucket_source = 'manual'"),
    ['needs', 'tx1']
  );
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('INSERT INTO merchant_buckets'),
    expect.arrayContaining(['starbucks', 'needs'])
  );
});

test('setTransactionBucket rejects a vacation transaction', async () => {
  await initDb();
  mockDb.getFirstAsync.mockResolvedValueOnce({ merchant_name: 'Cafe', vacation_id: 'v1' });
  await expect(setTransactionBucket('tx1', 'food')).rejects.toThrow(BucketLockedError);
});

describe('splitwise inbox', () => {
  function item(over: Partial<SplitwiseInboxItem> = {}): SplitwiseInboxItem {
    return {
      expense_id: '555', description: 'Dinner', cost: 60, currency: 'USD',
      date: '2026-08-20', payer_name: 'Alice Ng', my_share: 30,
      participants: [{ id: '200', name: 'Alice Ng' }], group_id: null,
      state: 'pending', fetched_at: '2026-08-24T00:00:00.000Z',
      ...over,
    };
  }

  it('creates the inbox table and the new transaction columns on migration', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 6 });
    await initDb();
    const sql = mockDb.execAsync.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(sql).toContain('ALTER TABLE transactions ADD COLUMN source TEXT');
    expect(sql).toContain('ALTER TABLE transactions ADD COLUMN payer_name TEXT');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS splitwise_inbox');
    expect(sql).toContain('PRAGMA user_version = 7');
  });

  it('adds the new columns on a brand-new install too', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 0 });
    await initDb();
    const sql = mockDb.execAsync.mock.calls.map((c: string[]) => c[0]).join('\n');
    expect(sql).toContain('ALTER TABLE transactions ADD COLUMN source TEXT');
    expect(sql).toContain('ALTER TABLE transactions ADD COLUMN payer_name TEXT');
  });

  it('returns only pending inbox rows, parsing participants', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { expense_id: '555', description: 'Dinner', cost: 60, currency: 'USD', date: '2026-08-20',
        payer_name: 'Alice Ng', my_share: 30, participants: '[{"id":"200","name":"Alice Ng"}]',
        group_id: null, state: 'pending', fetched_at: '2026-08-24T00:00:00.000Z' },
    ]);
    const rows = await getSplitwiseInbox();
    const sql = mockDb.getAllAsync.mock.calls[0][0];
    expect(sql).toContain("state = 'pending'");
    expect(rows[0].participants).toEqual([{ id: '200', name: 'Alice Ng' }]);
  });

  it('upsert does not resurrect a dismissed row', async () => {
    await upsertInboxItem(item());
    const sql = mockDb.runAsync.mock.calls[0][0];
    expect(sql).toContain('ON CONFLICT(expense_id) DO UPDATE');
    // state is deliberately absent from the DO UPDATE SET list.
    expect(sql.split('DO UPDATE')[1]).not.toContain('state =');
  });

  it('accept writes the transaction and the split decision', async () => {
    await acceptSplitwiseExpense(item(), 'food', null);
    const calls = mockDb.runAsync.mock.calls;
    const txInsert = calls.find((c: [string, unknown[]]) => c[0].includes('INTO transactions'));
    expect(txInsert[1]).toEqual(expect.arrayContaining([
      'sw:555', 'Dinner', 60, 'USD', '2026-08-20', 'splitwise', 'Alice Ng', 'food', 'manual',
    ]));
    const decInsert = calls.find((c: [string, unknown[]]) => c[0].includes('INTO split_decisions'));
    // amount_each is the user's OWN share, not the full cost.
    expect(decInsert[1]).toEqual(expect.arrayContaining(['sw:555', '555', 30]));
    expect(decInsert[1]).toEqual(expect.arrayContaining([JSON.stringify(['Alice Ng'])]));
  });

  it('accept into a vacation locks the bucket to travel', async () => {
    await acceptSplitwiseExpense(item({ group_id: '42' }), 'food', 'vac1');
    const txInsert = mockDb.runAsync.mock.calls.find((c: [string, unknown[]]) =>
      c[0].includes('INTO transactions'));
    expect(txInsert[1]).toEqual(expect.arrayContaining(['travel', 'vacation', 'vac1']));
  });

  it('accept clears the inbox row', async () => {
    await acceptSplitwiseExpense(item(), 'food', null);
    const del = mockDb.runAsync.mock.calls.find((c: [string, unknown[]]) =>
      c[0].includes('DELETE FROM splitwise_inbox'));
    expect(del[1]).toEqual(['555']);
  });

  it('update rewrites amounts without touching bucket or vacation', async () => {
    await updateImportedExpense(item({ cost: 80, my_share: 40 }));
    const txUpdate = mockDb.runAsync.mock.calls.find((c: [string, unknown[]]) =>
      c[0].includes('UPDATE transactions'));
    expect(txUpdate[0]).not.toContain('bucket');
    expect(txUpdate[0]).not.toContain('vacation_id');
    expect(txUpdate[1]).toEqual(expect.arrayContaining([80, 'sw:555']));
    const decUpdate = mockDb.runAsync.mock.calls.find((c: [string, unknown[]]) =>
      c[0].includes('UPDATE split_decisions'));
    expect(decUpdate[1]).toEqual(expect.arrayContaining([40, 'sw:555']));
  });

  it('delete removes both rows and writes a tombstone when asked', async () => {
    await deleteImportedExpense('555', true);
    const sqls = mockDb.runAsync.mock.calls.map((c: [string, unknown[]]) => c[0]).join('\n');
    expect(sqls).toContain('DELETE FROM split_decisions');
    expect(sqls).toContain('DELETE FROM transactions');
    expect(sqls).toContain('INTO splitwise_inbox');
    expect(sqls).toContain("'dismissed'");
  });

  it('delete without a tombstone leaves no inbox row behind', async () => {
    await deleteImportedExpense('555', false);
    const sqls = mockDb.runAsync.mock.calls.map((c: [string, unknown[]]) => c[0]).join('\n');
    expect(sqls).toContain('DELETE FROM splitwise_inbox');
    expect(sqls).not.toContain("'dismissed'");
  });

  it('reports local state for an expense', async () => {
    // resetDbForTests() runs in this file's beforeEach, so the FIRST
    // getFirstAsync call inside any test is openDatabase()'s own
    // `PRAGMA user_version` read. Consume it with initDb() before priming
    // the fixture chain below, or it swallows the first fixture.
    await initDb();
    mockDb.getFirstAsync
      .mockResolvedValueOnce({ n: 1 })            // transactions row exists
      .mockResolvedValueOnce({ state: 'dismissed' });
    const state = await getLocalExpenseState('555');
    expect(state).toEqual({ imported: true, dismissed: true });
  });
});
