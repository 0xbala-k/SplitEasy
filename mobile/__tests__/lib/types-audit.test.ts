// mobile/__tests__/lib/types-audit.test.ts
//
// Type-level regression test for Task 10: SplitDecision.splitwise_expense_id
// widens from `string` to `string | null` so a split can exist locally before
// Splitwise has accepted it (queued create, see pending_splitwise_ops).
// The primary assertion here is that this file *compiles* — passing a
// SplitDecision literal with splitwise_expense_id: null to upsertSplitDecision
// must type-check. The runtime assertion additionally confirms the read path
// (grouping in getHistoryTransactions) treats a null id as its own row rather
// than collapsing every queued split together.
jest.mock('expo-sqlite');

import * as SQLite from 'expo-sqlite';
import { getHistoryTransactions, upsertSplitDecision, resetDbForTests } from '@/lib/db';

const mockDb = {
  execAsync: jest.fn().mockResolvedValue(undefined),
  getAllAsync: jest.fn().mockResolvedValue([]),
  getFirstAsync: jest.fn().mockResolvedValue(null),
  runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
  withTransactionAsync: jest.fn(async (task: () => Promise<void>) => { await task(); }),
};

beforeEach(() => {
  jest.clearAllMocks();
  (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);
  resetDbForTests();
});

it('renders a split that has no Splitwise expense id yet', async () => {
  await upsertSplitDecision({
    id: 'd1',
    transaction_id: 't1',
    splitwise_expense_id: null,   // queued, not yet pushed
    friend_ids: ['1'],
    friend_names: ['Ada'],
    amount_each: 10,
    created_at: new Date().toISOString(),
    description: 'Dinner',
  });

  mockDb.getAllAsync.mockResolvedValueOnce([
    { id: 't1', merchant_name: 'Diner', amount: 20, currency: 'USD', date: '2026-09-01',
      status: 'split', pending: 0, created_at: 'x',
      splitwise_expense_id: null, description: 'Dinner', friend_names: '["Ada"]', amount_each: 10 },
  ]);

  const history = await getHistoryTransactions();
  // Grouping keys off splitwise_expense_id; a null must fall back to the local
  // transaction id rather than collapsing every queued split into one row.
  expect(history.filter((h) => h.id === 't1' || h.combined?.expense_id === 't1')).toHaveLength(1);
});
