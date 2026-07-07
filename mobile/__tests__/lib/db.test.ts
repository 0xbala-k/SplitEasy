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
} from '@/lib/db';
import { PlaidTransaction, SplitDecision } from '@/lib/types';

const mockDb = {
  execAsync: jest.fn().mockResolvedValue(undefined),
  getAllAsync: jest.fn().mockResolvedValue([]),
  getFirstAsync: jest.fn().mockResolvedValue(null),
  runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
};

beforeEach(() => {
  jest.clearAllMocks();
  (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
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
    sql.includes('CREATE TABLE')
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

test('deleteAllTransactions deletes all rows', async () => {
  await initDb();
  await deleteAllTransactions();
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM transactions'),
    []
  );
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
    expect.stringContaining('user_version = 3')
  );
});

test('initDb migrates an existing v2 install by adding the description column', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 2 });
  await initDb();
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE split_decisions ADD COLUMN description')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('user_version = 3')
  );
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
