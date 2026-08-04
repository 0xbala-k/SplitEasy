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
} from '@/lib/db';
import { PlaidTransaction, SplitDecision } from '@/lib/types';
import { VacationConflictError } from '@/lib/vacationErrors';

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
    expect.stringContaining('user_version = 4')
  );
});

test('initDb migrates an existing v2 install by adding the description column', async () => {
  mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 2 });
  await initDb();
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('ALTER TABLE split_decisions ADD COLUMN description')
  );
  expect(mockDb.execAsync).toHaveBeenCalledWith(
    expect.stringContaining('user_version = 4')
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

describe('vacation CRUD', () => {
  beforeEach(async () => {
    mockDb.getFirstAsync.mockResolvedValue({ user_version: 4 });
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
    mockDb.getFirstAsync.mockResolvedValue({ user_version: 4 });
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
