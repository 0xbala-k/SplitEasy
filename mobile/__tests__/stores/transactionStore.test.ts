// mobile/__tests__/stores/transactionStore.test.ts
jest.mock('expo-secure-store');
jest.mock('@/lib/db');
// Explicit factory: keeps WorkerError as the real class so instanceof
// and .code checks in the store work (automock would strip them).
jest.mock('@/lib/worker', () => ({
  WorkerError: jest.requireActual('@/lib/worker').WorkerError,
  getLinkToken: jest.fn(),
  exchangePublicToken: jest.fn(),
  fetchTransactions: jest.fn(),
  exchangeSplitwiseCode: jest.fn(),
}));
jest.mock('@/stores/plaidStore');
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import * as db from '@/lib/db';
import * as worker from '@/lib/worker';
import * as SecureStore from 'expo-secure-store';
import { usePlaidStore } from '@/stores/plaidStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { WorkerError } from '@/lib/worker';

const mockGetNew = db.getNewTransactions as jest.Mock;
const mockUpsert = db.upsertTransactions as jest.Mock;
const mockDeleteByIds = db.deleteTransactionsByPlaidIds as jest.Mock;
const mockUpdateStatus = db.updateTransactionStatus as jest.Mock;
const mockFetchTxs = worker.fetchTransactions as jest.Mock;
const mockSecureGet = SecureStore.getItemAsync as jest.Mock;
const mockSetNeedsReauth = jest.fn();
const mockGetTokensAndCursors = jest.fn();
const mockSaveCursor = jest.fn();

function syncPage(overrides: Partial<{
  added: unknown[];
  modified: unknown[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}> = {}) {
  return { added: [], modified: [], removed: [], next_cursor: 'cur-next', has_more: false, ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks doesn't drain mockResolvedValueOnce queues
  mockFetchTxs.mockReset();
  (usePlaidStore.getState as jest.Mock) = jest.fn().mockReturnValue({
    setNeedsReauth: mockSetNeedsReauth,
    getTokensAndCursors: mockGetTokensAndCursors,
    saveCursor: mockSaveCursor,
  });
  useTransactionStore.setState({ transactions: [], isLoading: false });
  mockSecureGet.mockResolvedValue('access-token');
  mockGetNew.mockResolvedValue([]);
  mockUpsert.mockResolvedValue(undefined);
  mockDeleteByIds.mockResolvedValue(undefined);
  mockUpdateStatus.mockResolvedValue(undefined);
  mockGetTokensAndCursors.mockResolvedValue([{ id: 'acct_1', access_token: 'access-token', cursor: 'cur-0' }]);
  mockSaveCursor.mockResolvedValue(undefined);
});

test('load fetches new transactions from DB and updates store', async () => {
  mockGetNew.mockResolvedValue([
    { id: 'tx1', merchant_name: 'Starbucks', amount: 5.5, currency: 'USD', date: '2026-04-01', status: 'new', created_at: '2026-04-01T10:00:00Z' },
  ]);
  await useTransactionStore.getState().load();
  expect(useTransactionStore.getState().transactions).toHaveLength(1);
  expect(useTransactionStore.getState().transactions[0].id).toBe('tx1');
});

test('refresh calls worker, upserts added, deletes removed, updates cursor', async () => {
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
    removed: [{ transaction_id: 'tx-old' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockFetchTxs).toHaveBeenCalledWith('access-token', 'cur-0');
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx2' })]));
  expect(mockDeleteByIds).toHaveBeenCalledWith(['tx-old']);
  expect(mockSaveCursor).toHaveBeenCalledWith('acct_1', 'cur-next');
});

test('refresh follows has_more pages and saves the final cursor', async () => {
  mockFetchTxs
    .mockResolvedValueOnce(syncPage({
      added: [{ transaction_id: 'tx-a', merchant_name: 'A', name: 'A', amount: 1, iso_currency_code: 'USD', date: '2026-06-10' }],
      next_cursor: 'cur-1',
      has_more: true,
    }))
    .mockResolvedValueOnce(syncPage({
      added: [{ transaction_id: 'tx-b', merchant_name: 'B', name: 'B', amount: 2, iso_currency_code: 'USD', date: '2026-06-11' }],
      next_cursor: 'cur-2',
    }));
  await useTransactionStore.getState().refresh();
  expect(mockFetchTxs).toHaveBeenNthCalledWith(1, 'access-token', 'cur-0');
  expect(mockFetchTxs).toHaveBeenNthCalledWith(2, 'access-token', 'cur-1');
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx-a' })]));
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx-b' })]));
  expect(mockSaveCursor).toHaveBeenLastCalledWith('acct_1', 'cur-2');
});

test('first sync (no cursor) drains the backlog without storing transactions', async () => {
  mockGetTokensAndCursors.mockResolvedValue([{ id: 'acct_1', access_token: 'access-token', cursor: null }]);
  mockFetchTxs
    .mockResolvedValueOnce(syncPage({
      added: [{ transaction_id: 'tx-hist-1', merchant_name: 'Old', name: 'Old', amount: 10, iso_currency_code: 'USD', date: '2026-01-05' }],
      next_cursor: 'cur-1',
      has_more: true,
    }))
    .mockResolvedValueOnce(syncPage({
      added: [{ transaction_id: 'tx-hist-2', merchant_name: 'Older', name: 'Older', amount: 20, iso_currency_code: 'USD', date: '2026-02-10' }],
      next_cursor: 'cur-2',
    }));
  await useTransactionStore.getState().refresh();
  expect(mockFetchTxs).toHaveBeenNthCalledWith(1, 'access-token', undefined);
  expect(mockFetchTxs).toHaveBeenNthCalledWith(2, 'access-token', 'cur-1');
  expect(mockUpsert).not.toHaveBeenCalled();
  expect(mockDeleteByIds).not.toHaveBeenCalled();
  expect(mockSaveCursor).toHaveBeenCalledTimes(1);
  expect(mockSaveCursor).toHaveBeenCalledWith('acct_1', 'cur-2');
});

test('refresh sets needs_reauth on ITEM_LOGIN_REQUIRED', async () => {
  mockFetchTxs.mockRejectedValue(new WorkerError('ITEM_LOGIN_REQUIRED', 400));
  await useTransactionStore.getState().refresh();
  expect(mockSetNeedsReauth).toHaveBeenCalledWith(true);
});

test('skip updates DB status and removes from in-memory list', async () => {
  useTransactionStore.setState({
    transactions: [
      { id: 'tx1', merchant_name: 'Cafe', amount: 4.5, currency: 'USD', date: '2026-04-01', status: 'new', created_at: '2026-04-01T10:00:00Z' },
    ],
  });
  await useTransactionStore.getState().skip('tx1');
  expect(mockUpdateStatus).toHaveBeenCalledWith('tx1', 'skipped');
  expect(useTransactionStore.getState().transactions).toHaveLength(0);
});

test('markSplit updates DB status and removes from in-memory list', async () => {
  useTransactionStore.setState({
    transactions: [
      { id: 'tx1', merchant_name: 'Cafe', amount: 4.5, currency: 'USD', date: '2026-04-01', status: 'new', created_at: '2026-04-01T10:00:00Z' },
    ],
  });
  await useTransactionStore.getState().markSplit('tx1');
  expect(mockUpdateStatus).toHaveBeenCalledWith('tx1', 'split');
  expect(useTransactionStore.getState().transactions).toHaveLength(0);
});
