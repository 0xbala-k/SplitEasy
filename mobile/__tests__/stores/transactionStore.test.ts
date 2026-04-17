// mobile/__tests__/stores/transactionStore.test.ts
jest.mock('expo-secure-store');
jest.mock('@/lib/db');
jest.mock('@/lib/worker');
jest.mock('@/stores/plaidStore');
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import AsyncStorage from '@react-native-async-storage/async-storage';
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

beforeEach(() => {
  jest.clearAllMocks();
  (usePlaidStore.getState as jest.Mock) = jest.fn().mockReturnValue({ setNeedsReauth: mockSetNeedsReauth });
  useTransactionStore.setState({ transactions: [], isLoading: false });
  mockSecureGet.mockResolvedValue('access-token');
  mockGetNew.mockResolvedValue([]);
  mockUpsert.mockResolvedValue(undefined);
  mockDeleteByIds.mockResolvedValue(undefined);
  mockUpdateStatus.mockResolvedValue(undefined);
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
  mockFetchTxs.mockResolvedValue({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
    modified: [],
    removed: [{ transaction_id: 'tx-old' }],
    next_cursor: 'cur-next',
    has_more: false,
  });
  await useTransactionStore.getState().refresh();
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx2' })]));
  expect(mockDeleteByIds).toHaveBeenCalledWith(['tx-old']);
  expect(await AsyncStorage.getItem('last_plaid_cursor')).toBe('cur-next');
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
