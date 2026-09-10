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
jest.mock('@/stores/vacationStore');
jest.mock('@/lib/splitwise');
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import * as db from '@/lib/db';
import * as worker from '@/lib/worker';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { usePlaidStore } from '@/stores/plaidStore';
import { useVacationStore } from '@/stores/vacationStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore, SPLITWISE_WATERMARK_KEY, scaleFriendShares } from '@/stores/transactionStore';
import { WorkerError } from '@/lib/worker';
import * as splitwise from '@/lib/splitwise';
import { SplitwiseAuthError, getExpensesUpdatedAfter, deleteExpense, getExpense, updateExpense } from '@/lib/splitwise';
import { getLocalExpenseState, upsertInboxItem, updateImportedExpense, deleteImportedExpense, acceptSplitwiseExpense, updateTransactionFields, updateInboxItemFields, getNewTransactions, clearReview, deleteTransactionsByPlaidIds, revertReviewedAmount, getSplitDecision } from '@/lib/db';
import { SplitwiseInboxItem, ReviewItem } from '@/lib/types';

const mockGetNew = db.getNewTransactions as jest.Mock;
const mockUpsert = db.upsertTransactions as jest.Mock;
const mockDeleteByIds = db.deleteTransactionsByPlaidIds as jest.Mock;
const mockUpdateStatus = db.updateTransactionStatus as jest.Mock;
const mockRekeyTransaction = db.rekeyTransaction as jest.Mock;
const mockMarkReversed = db.markTransactionsReversed as jest.Mock;
const mockGetReview = db.getReviewTransactions as jest.Mock;
const mockClearReview = db.clearReview as jest.Mock;
const mockGetMerchantBuckets = db.getMerchantBuckets as jest.Mock;
const mockSetTransactionBucket = db.setTransactionBucket as jest.Mock;
const mockFetchTxs = worker.fetchTransactions as jest.Mock;
const mockSecureGet = SecureStore.getItemAsync as jest.Mock;
const mockSetNeedsReauth = jest.fn();
const mockGetTokensAndCursors = jest.fn();
const mockSaveCursor = jest.fn();
const mockDeleteExpense = splitwise.deleteExpense as jest.Mock;
const mockDeleteSplitDecision = db.deleteSplitDecision as jest.Mock;
const mockPersistCombined = db.persistCombinedSplit as jest.Mock;
const mockRevertCombined = db.revertCombinedSplit as jest.Mock;
const mockReconcile = jest.fn();
const mockGetSplitwiseInbox = db.getSplitwiseInbox as jest.Mock;

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
  useTransactionStore.setState({ transactions: [], isLoading: false, splitwiseInbox: [] });
  mockGetSplitwiseInbox.mockResolvedValue([]);
  mockSecureGet.mockResolvedValue('access-token');
  mockGetNew.mockResolvedValue([]);
  mockUpsert.mockResolvedValue(undefined);
  mockDeleteByIds.mockResolvedValue(undefined);
  mockUpdateStatus.mockResolvedValue(undefined);
  mockRekeyTransaction.mockResolvedValue('not_found');
  mockMarkReversed.mockResolvedValue([]);
  mockGetReview.mockResolvedValue([]);
  mockClearReview.mockResolvedValue(undefined);
  mockGetMerchantBuckets.mockResolvedValue({});
  mockSetTransactionBucket.mockResolvedValue(undefined);
  mockGetTokensAndCursors.mockResolvedValue([{ id: 'acct_1', access_token: 'access-token', cursor: 'cur-0' }]);
  mockSaveCursor.mockResolvedValue(undefined);
  mockDeleteExpense.mockResolvedValue(undefined);
  mockDeleteSplitDecision.mockResolvedValue(undefined);
  mockPersistCombined.mockResolvedValue(undefined);
  mockRevertCombined.mockResolvedValue(undefined);
  mockReconcile.mockResolvedValue(undefined);
  (useVacationStore.getState as jest.Mock) = jest.fn().mockReturnValue({
    reconcile: mockReconcile,
    activeVacation: null,
  });
});

test('load fetches new transactions from DB and updates store', async () => {
  mockGetNew.mockResolvedValue([
    { id: 'tx1', merchant_name: 'Starbucks', amount: 5.5, currency: 'USD', date: '2026-04-01', status: 'new', created_at: '2026-04-01T10:00:00Z' },
  ]);
  await useTransactionStore.getState().load();
  expect(useTransactionStore.getState().transactions).toHaveLength(1);
  expect(useTransactionStore.getState().transactions[0].id).toBe('tx1');
});

test('refresh calls worker, upserts added, marks unmatched removed ids reversed, updates cursor', async () => {
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
    removed: [{ transaction_id: 'tx-old' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockFetchTxs).toHaveBeenCalledWith('access-token', 'cur-0');
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx2' })]), null);
  expect(mockMarkReversed).toHaveBeenCalledWith(['tx-old']);
  expect(mockSaveCursor).toHaveBeenCalledWith('acct_1', 'cur-next');
});

test('refresh rekeys a posted transaction using its pending_transaction_id before upserting', async () => {
  mockRekeyTransaction.mockResolvedValue('changed');
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'new1', pending_transaction_id: 'old1', merchant_name: 'Cafe', name: 'CAFE', amount: 12.5, iso_currency_code: 'USD', date: '2026-04-02' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockRekeyTransaction).toHaveBeenCalledWith('old1', expect.objectContaining({ transaction_id: 'new1' }));
  // The rekey must run before the upsert so the posted row inherits status/vacation_id/decision.
  const rekeyOrder = mockRekeyTransaction.mock.invocationCallOrder[0];
  const upsertOrder = mockUpsert.mock.invocationCallOrder[0];
  expect(rekeyOrder).toBeLessThan(upsertOrder);
});

test('refresh skips rekey for a transaction with no pending_transaction_id', async () => {
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockRekeyTransaction).not.toHaveBeenCalled();
});

test('refresh does not mark a rekey-consumed id as reversed', async () => {
  mockRekeyTransaction.mockResolvedValue('changed');
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'new1', pending_transaction_id: 'old1', merchant_name: 'Cafe', name: 'CAFE', amount: 12.5, iso_currency_code: 'USD', date: '2026-04-02' }],
    removed: [{ transaction_id: 'old1' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockMarkReversed).toHaveBeenCalledWith([]);
});

test('refresh does not mark an id as reversed when it reappears in this page\'s added/modified', async () => {
  // Some institutions reuse transaction ids; deleting here would drop the row we just kept.
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'dup1', merchant_name: 'Cafe', name: 'CAFE', amount: 5, iso_currency_code: 'USD', date: '2026-04-02' }],
    removed: [{ transaction_id: 'dup1' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockMarkReversed).toHaveBeenCalledWith([]);
});

test('refresh does not rekey when rekeyTransaction reports not_found', async () => {
  mockRekeyTransaction.mockResolvedValue('not_found');
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'new1', pending_transaction_id: 'old1', merchant_name: 'Cafe', name: 'CAFE', amount: 12.5, iso_currency_code: 'USD', date: '2026-04-02' }],
    removed: [{ transaction_id: 'old1' }],
  }));
  await useTransactionStore.getState().refresh();
  // 'not_found' means nothing was consumed, so the removed id still gets marked/deleted.
  expect(mockMarkReversed).toHaveBeenCalledWith(['old1']);
});

test('refresh leaves the old row alone when rekeyTransaction reports conflict', async () => {
  // A split row already occupies the posted id, so the rekey was refused. The
  // pending row still holds its own Splitwise expense — marking it reversed
  // would wrongly prompt to delete a live expense, so it must be left as is.
  mockRekeyTransaction.mockResolvedValue('conflict');
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'new1', pending_transaction_id: 'old1', merchant_name: 'Cafe', name: 'CAFE', amount: 12.5, iso_currency_code: 'USD', date: '2026-04-02' }],
    removed: [{ transaction_id: 'old1' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockMarkReversed).toHaveBeenCalledWith([]);
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
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx-a' })]), null);
  expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx-b' })]), null);
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

test('refresh reconciles vacation statuses before syncing', async () => {
  mockFetchTxs.mockResolvedValue(syncPage());
  await useTransactionStore.getState().refresh();
  expect(mockReconcile).toHaveBeenCalledTimes(1);
});

test('refresh threads the active vacation id into upsertTransactions', async () => {
  (useVacationStore.getState as jest.Mock).mockReturnValue({
    reconcile: mockReconcile,
    activeVacation: { id: 'vac1' },
  });
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx2' })]),
    'vac1'
  );
});

test('refresh passes null when no vacation is active', async () => {
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockUpsert).toHaveBeenCalledWith(expect.any(Array), null);
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

test('deleteSplit removes the Splitwise expense, clears the decision, reverts to new, reloads', async () => {
  await useTransactionStore.getState().deleteSplit('tx1', 'exp99');
  expect(mockDeleteExpense).toHaveBeenCalledWith('exp99');
  expect(mockDeleteSplitDecision).toHaveBeenCalledWith('tx1');
  expect(mockUpdateStatus).toHaveBeenCalledWith('tx1', 'new');
  expect(mockGetNew).toHaveBeenCalled(); // load() ran
});

test('deleteSplit leaves local state untouched if the Splitwise delete fails', async () => {
  mockDeleteExpense.mockRejectedValue(new Error('SPLITWISE_ERROR'));
  await expect(
    useTransactionStore.getState().deleteSplit('tx1', 'exp99')
  ).rejects.toThrow();
  expect(mockDeleteSplitDecision).not.toHaveBeenCalled();
  expect(mockUpdateStatus).not.toHaveBeenCalled();
});

test('deleteSplit reports an auth failure to authStore and still rejects', async () => {
  useAuthStore.setState({ tokenValid: true });
  mockDeleteExpense.mockRejectedValue(new SplitwiseAuthError());
  await expect(
    useTransactionStore.getState().deleteSplit('tx1', 'exp99')
  ).rejects.toBeInstanceOf(SplitwiseAuthError);
  expect(useAuthStore.getState().tokenValid).toBe(false);
});

test('deleteCombinedSplit deletes the expense once, then reverts members atomically', async () => {
  await useTransactionStore.getState().deleteCombinedSplit(['tx1', 'tx2'], 'expShared');

  expect(mockDeleteExpense).toHaveBeenCalledTimes(1);
  expect(mockDeleteExpense).toHaveBeenCalledWith('expShared');
  expect(mockRevertCombined).toHaveBeenCalledWith(['tx1', 'tx2']);
});

test('deleteCombinedSplit makes no local change when the Splitwise delete fails', async () => {
  mockDeleteExpense.mockRejectedValue(new Error('SPLITWISE_ERROR'));
  await expect(
    useTransactionStore.getState().deleteCombinedSplit(['tx1', 'tx2'], 'expShared')
  ).rejects.toThrow();
  expect(mockRevertCombined).not.toHaveBeenCalled();
});

test('deleteCombinedSplit reports an auth failure to authStore and still rejects', async () => {
  useAuthStore.setState({ tokenValid: true });
  mockDeleteExpense.mockRejectedValue(new SplitwiseAuthError());
  await expect(
    useTransactionStore.getState().deleteCombinedSplit(['tx1', 'tx2'], 'expShared')
  ).rejects.toBeInstanceOf(SplitwiseAuthError);
  expect(useAuthStore.getState().tokenValid).toBe(false);
});

test('commitCombinedSplit persists rows atomically then drops members from the list', async () => {
  useTransactionStore.setState({
    transactions: [
      { id: 'txA', merchant_name: 'A', amount: 5, currency: 'USD', date: 'x', status: 'new', pending: false, created_at: 'x' },
      { id: 'txB', merchant_name: 'B', amount: 5, currency: 'USD', date: 'x', status: 'new', pending: false, created_at: 'x' },
      { id: 'txC', merchant_name: 'C', amount: 5, currency: 'USD', date: 'x', status: 'new', pending: false, created_at: 'x' },
    ],
    isLoading: false,
  });
  const decisions = [
    { id: 'a', transaction_id: 'txA', splitwise_expense_id: 'exp', friend_ids: ['2'], friend_names: ['Sam'], amount_each: 5, created_at: 'x', description: 'Trip' },
    { id: 'b', transaction_id: 'txB', splitwise_expense_id: 'exp', friend_ids: ['2'], friend_names: ['Sam'], amount_each: 5, created_at: 'x', description: 'Trip' },
  ];
  await useTransactionStore.getState().commitCombinedSplit(decisions);
  expect(mockPersistCombined).toHaveBeenCalledWith(decisions);
  expect(useTransactionStore.getState().transactions.map((t) => t.id)).toEqual(['txC']);
});

test('loadReview fetches review items from DB and updates the store', async () => {
  const reviewItem = {
    id: 'tx1', merchant_name: 'Cafe', amount: 12.5, amount_changed_from: 10, currency: 'USD',
    date: '2026-04-01', reason: 'amount_changed' as const, split: { friend_names: ['Sam'], amount_each: 6.25 },
    expense_id: 'exp1', transaction_ids: ['tx1'],
  };
  mockGetReview.mockResolvedValue([reviewItem]);
  await useTransactionStore.getState().loadReview();
  expect(useTransactionStore.getState().review).toEqual([reviewItem]);
});

test('resolveReview clears the review flag then reloads the queue', async () => {
  mockGetReview.mockResolvedValue([]);
  await useTransactionStore.getState().resolveReview(['tx1', 'tx2']);
  expect(mockClearReview).toHaveBeenCalledWith(['tx1', 'tx2']);
  expect(mockGetReview).toHaveBeenCalled();
  expect(useTransactionStore.getState().review).toEqual([]);
});

test('load also fetches the merchant memory', async () => {
  mockGetNew.mockResolvedValue([]);
  mockGetMerchantBuckets.mockResolvedValue({ starbucks: 'needs' });
  await useTransactionStore.getState().load();
  expect(useTransactionStore.getState().merchantBuckets).toEqual({ starbucks: 'needs' });
});

test('setBucket writes every id and reloads', async () => {
  mockGetNew.mockResolvedValue([]);
  mockGetMerchantBuckets.mockResolvedValue({});
  await useTransactionStore.getState().setBucket(['a', 'b'], 'shopping');
  expect(mockSetTransactionBucket).toHaveBeenCalledWith('a', 'shopping');
  expect(mockSetTransactionBucket).toHaveBeenCalledWith('b', 'shopping');
  expect(mockGetNew).toHaveBeenCalled();
});

test('setBucket reloads even when a later id throws', async () => {
  mockGetNew.mockResolvedValue([]);
  mockGetMerchantBuckets.mockResolvedValue({});
  mockSetTransactionBucket
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('locked'));
  await expect(useTransactionStore.getState().setBucket(['a', 'b'], 'shopping')).rejects.toThrow();
  expect(mockGetNew).toHaveBeenCalled();
});

describe('syncSplitwiseInbox', () => {
  beforeEach(() => {
    AsyncStorage.clear();
    useAuthStore.setState({ user_id: '100', isAuthenticated: true, tokenValid: true });
  });

  function expense(over = {}) {
    return {
      id: 555, description: 'Dinner', cost: '60.00', currency_code: 'USD',
      date: '2026-08-20T18:30:00Z', group_id: null, payment: false,
      deleted_at: null, updated_at: '2026-08-20T18:31:00Z',
      users: [
        { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '60.00', owed_share: '30.00' },
        { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '0.00', owed_share: '30.00' },
      ],
      ...over,
    };
  }

  it('imports nothing on the first run and stamps the watermark', async () => {
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(getExpensesUpdatedAfter).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY)).toBeTruthy();
  });

  it('offers a friend-paid expense on a later run', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockResolvedValue([expense()]);
    (getLocalExpenseState as jest.Mock).mockResolvedValue({ imported: false, dismissed: false });
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(getExpensesUpdatedAfter).toHaveBeenCalledWith('2026-08-01T00:00:00.000Z');
    expect(upsertInboxItem).toHaveBeenCalledWith(expect.objectContaining({ expense_id: '555', my_share: 30 }));
  });

  it('advances the watermark after a successful pass', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockResolvedValue([]);
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY)).not.toBe('2026-08-01T00:00:00.000Z');
  });

  it('leaves the watermark alone when the fetch throws, so nothing is skipped', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockRejectedValue(new SplitwiseAuthError());
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY)).toBe('2026-08-01T00:00:00.000Z');
  });

  it('reports the auth failure to authStore on a 401', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockRejectedValue(new SplitwiseAuthError());
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(useAuthStore.getState().tokenValid).toBe(false);
  });

  it('stays silent for a non-auth failure', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockRejectedValue(new Error('SPLITWISE_ERROR'));
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(useAuthStore.getState().tokenValid).toBe(true);
  });

  it('reports auth success after a clean pass so the banner clears', async () => {
    useAuthStore.setState({ tokenValid: false });
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockResolvedValue([]);
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(useAuthStore.getState().tokenValid).toBe(true);
  });

  it('does nothing when the user is not signed in to Splitwise', async () => {
    useAuthStore.setState({ user_id: null, isAuthenticated: false });
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(getExpensesUpdatedAfter).not.toHaveBeenCalled();
  });

  it('updates an already-imported expense instead of re-offering it', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockResolvedValue([expense({ cost: '80.00' })]);
    (getLocalExpenseState as jest.Mock).mockResolvedValue({ imported: true, dismissed: false });
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(updateImportedExpense).toHaveBeenCalledWith(expect.objectContaining({ cost: 80 }));
    expect(upsertInboxItem).not.toHaveBeenCalled();
  });

  it('removes an upstream-deleted expense without leaving a tombstone', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    (getExpensesUpdatedAfter as jest.Mock).mockResolvedValue([expense({ deleted_at: '2026-08-21T00:00:00Z' })]);
    (getLocalExpenseState as jest.Mock).mockResolvedValue({ imported: true, dismissed: false });
    await useTransactionStore.getState().syncSplitwiseInbox();
    expect(deleteImportedExpense).toHaveBeenCalledWith('555', false);
  });
});

describe('a Splitwise failure never fails the Plaid refresh', () => {
  it('keeps Plaid results and the saved cursor', async () => {
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    useAuthStore.setState({ user_id: '100', isAuthenticated: true });
    (getExpensesUpdatedAfter as jest.Mock).mockRejectedValue(new SplitwiseAuthError());
    // Arrange one Plaid page exactly as the existing refresh() tests in this
    // file do, then:
    mockFetchTxs.mockResolvedValue(syncPage({
      added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
    }));
    await useTransactionStore.getState().refresh();
    expect(mockUpsert).toHaveBeenCalled();
    expect(mockSaveCursor).toHaveBeenCalled();
    // getNewTransactions is only reached via get().load(), which runs on the
    // line AFTER syncSplitwiseInbox() inside refresh(). This proves refresh()
    // ran to completion past the failed sync, not just that the Plaid loop
    // (which finishes before syncSplitwiseInbox is even called) succeeded.
    expect(mockGetNew).toHaveBeenCalled();
  });

  it('keeps Plaid results and the saved cursor when AsyncStorage itself throws', async () => {
    // A watermark read/write failure (not a Splitwise API failure) must be
    // just as harmless to the Plaid refresh: the whole body of
    // syncSplitwiseInbox needs to be inside its own try/catch, not just the
    // portion from the network call down.
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
    useAuthStore.setState({ user_id: '100', isAuthenticated: true });
    jest.spyOn(AsyncStorage, 'getItem').mockRejectedValueOnce(new Error('io error'));
    mockFetchTxs.mockResolvedValue(syncPage({
      added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
    }));
    await expect(useTransactionStore.getState().refresh()).resolves.not.toThrow();
    expect(mockUpsert).toHaveBeenCalled();
    expect(mockGetNew).toHaveBeenCalled();
  });
});

describe('accept and dismiss', () => {
  it('accepts into the active vacation when the group matches', async () => {
    (useVacationStore.getState as jest.Mock).mockReturnValue({
      reconcile: mockReconcile,
      activeVacation: { id: 'vac1', name: 'Tokyo', splitwise_group_id: '42' },
    });
    const item = { expense_id: '555', group_id: '42' } as SplitwiseInboxItem;
    await useTransactionStore.getState().acceptInboxItem(item, 'food');
    expect(acceptSplitwiseExpense).toHaveBeenCalledWith(item, 'food', 'vac1');
  });

  it('accepts outside a vacation when the group does not match', async () => {
    (useVacationStore.getState as jest.Mock).mockReturnValue({
      reconcile: mockReconcile,
      activeVacation: { id: 'vac1', name: 'Tokyo', splitwise_group_id: '99' },
    });
    const item = { expense_id: '555', group_id: '42' } as SplitwiseInboxItem;
    await useTransactionStore.getState().acceptInboxItem(item, 'food');
    expect(acceptSplitwiseExpense).toHaveBeenCalledWith(item, 'food', null);
  });

  it('does not match a null group against a vacation with no group', async () => {
    (useVacationStore.getState as jest.Mock).mockReturnValue({
      reconcile: mockReconcile,
      activeVacation: { id: 'vac1', name: 'Tokyo', splitwise_group_id: null },
    });
    const item = { expense_id: '555', group_id: null } as SplitwiseInboxItem;
    await useTransactionStore.getState().acceptInboxItem(item, 'food');
    expect(acceptSplitwiseExpense).toHaveBeenCalledWith(item, 'food', null);
  });
});

describe('editTransaction / editInboxItem', () => {
  test('editTransaction persists the patch then reloads the list', async () => {
    (updateTransactionFields as jest.Mock).mockResolvedValue(undefined);
    (getNewTransactions as jest.Mock).mockResolvedValue([]);
    await useTransactionStore.getState().editTransaction('p1', { amount: 12 });
    expect(updateTransactionFields).toHaveBeenCalledWith('p1', { amount: 12 });
    expect(getNewTransactions).toHaveBeenCalled();
  });

  test('editInboxItem persists the patch then reloads the inbox', async () => {
    (updateInboxItemFields as jest.Mock).mockResolvedValue(undefined);
    mockGetSplitwiseInbox.mockResolvedValue([]);
    await useTransactionStore.getState().editInboxItem('e1', { description: 'Birthday dinner' });
    expect(updateInboxItemFields).toHaveBeenCalledWith('e1', { description: 'Birthday dinner' });
    expect(mockGetSplitwiseInbox).toHaveBeenCalled();
  });
});

describe('excludeTransaction / restoreTransaction', () => {
  test('excludeTransaction persists the exclusion and optimistically drops the row', async () => {
    (db.excludeTransaction as jest.Mock).mockResolvedValue(undefined);
    useTransactionStore.setState({
      transactions: [{ id: 'p1' }, { id: 'p2' }] as never,
    });
    await useTransactionStore.getState().excludeTransaction('p1');
    expect(db.excludeTransaction).toHaveBeenCalledWith('p1');
    expect(useTransactionStore.getState().transactions.map((t) => t.id)).toEqual(['p2']);
  });

  test('restoreTransaction persists the restore then reloads the list', async () => {
    (db.restoreTransaction as jest.Mock).mockResolvedValue(undefined);
    mockGetNew.mockResolvedValue([]);
    mockGetMerchantBuckets.mockResolvedValue({});
    await useTransactionStore.getState().restoreTransaction('p1');
    expect(db.restoreTransaction).toHaveBeenCalledWith('p1');
    expect(mockGetNew).toHaveBeenCalled();
  });
});

describe('addManualTransaction', () => {
  test('persists the manual row then reloads the list', async () => {
    (db.createManualTransaction as jest.Mock).mockResolvedValue('mn_1_abc');
    mockGetNew.mockResolvedValue([]);
    mockGetMerchantBuckets.mockResolvedValue({});
    const input = { merchant_name: 'Cash lunch', amount: 9, date: '2026-07-04' };

    await useTransactionStore.getState().addManualTransaction(input);

    expect(db.createManualTransaction).toHaveBeenCalledWith(input);
    expect(mockGetNew).toHaveBeenCalled();
  });
});

describe('acceptReview', () => {
  function reviewItem(over: Partial<ReviewItem> = {}): ReviewItem {
    return {
      id: 'p1',
      merchant_name: 'Cafe',
      amount: 47.85,
      amount_changed_from: 42.1,
      currency: 'USD',
      date: '2026-07-01',
      reason: 'amount_changed',
      split: { friend_names: ['Alice', 'Bob'], amount_each: 14.03 },
      splitwise_expense_id: 'e1',
      expense_id: 'e1',
      transaction_ids: ['p1'],
      member_transaction_ids: ['p1'],
      ...over,
    };
  }

  beforeEach(() => {
    (getSplitDecision as jest.Mock).mockResolvedValue({
      id: 'd1',
      transaction_id: 'p1',
      splitwise_expense_id: 'e1',
      friend_ids: ['f1', 'f2'],
      friend_names: ['Alice', 'Bob'],
      amount_each: 14.03,
      created_at: '2026-07-01T00:00:00Z',
      description: 'Cafe',
    });
  });

  test('scales each friend share by new/old and pushes the new total', async () => {
    // Owner 'me' owed 20.10, Alice 12.00, Bob 10.00 of the old 42.10 total.
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 20.1, f1: 12, f2: 10 }, groupId: null });
    (updateExpense as jest.Mock).mockResolvedValue({ amount_each: 22.85 });
    useAuthStore.setState({ user_id: 'me' });

    await useTransactionStore.getState().acceptReview(reviewItem());

    // 47.85 / 42.10 = 1.13657...  →  12.00 → 13.64, 10.00 → 11.37
    expect(updateExpense).toHaveBeenCalledWith('e1', expect.objectContaining({
      amount: 47.85,
      friendShares: { f1: 13.64, f2: 11.37 },
    }));
    expect(clearReview).toHaveBeenCalledWith(['p1']);
  });

  test('an equal split stays equal at the new total, and the owner absorbs the remainder', async () => {
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 14.04, f1: 14.03, f2: 14.03 }, groupId: null });
    (updateExpense as jest.Mock).mockResolvedValue({ amount_each: 15.95 });
    useAuthStore.setState({ user_id: 'me' });

    // Old total 42.10 split equally three ways (14.03/14.03/14.04) scales by
    // 47.85 / 42.10 = 1.13657...: each friend's 14.03 → 15.95.
    await useTransactionStore.getState().acceptReview(reviewItem());

    const shares = (updateExpense as jest.Mock).mock.calls[0][1].friendShares;
    expect(shares).toEqual({ f1: 15.95, f2: 15.95 });
    expect(47.85 - (shares.f1 + shares.f2)).toBeCloseTo(15.95, 2); // owner's implied share
  });

  test('a custom (unequal) split keeps its proportions at the new total', async () => {
    // Old total 42.10: f1 owed 30, f2 owed 12.10 — a 5:2-ish custom split.
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 0, f1: 30, f2: 12.1 }, groupId: null });
    (updateExpense as jest.Mock).mockResolvedValue({ amount_each: 0 });
    useAuthStore.setState({ user_id: 'me' });

    await useTransactionStore.getState().acceptReview(reviewItem());

    const shares = (updateExpense as jest.Mock).mock.calls[0][1].friendShares;
    // 47.85 / 42.10 = 1.13657...  →  30 → 34.10, 12.10 → 13.75
    expect(shares).toEqual({ f1: 34.1, f2: 13.75 });
  });

  test('falls back to an equal split when the share read fails', async () => {
    (getExpense as jest.Mock).mockRejectedValue(new Error('offline'));
    (updateExpense as jest.Mock).mockResolvedValue({ amount_each: 15.95 });
    useAuthStore.setState({ user_id: 'me' });

    await useTransactionStore.getState().acceptReview(reviewItem());

    expect(updateExpense).toHaveBeenCalledWith('e1', expect.objectContaining({
      amount: 47.85,
      friendShares: undefined,
      groupId: undefined,
    }));
  });

  test('passes the expense group id through to updateExpense', async () => {
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 20.1, f1: 12, f2: 10 }, groupId: '999' });
    (updateExpense as jest.Mock).mockResolvedValue({ amount_each: 22.85 });
    useAuthStore.setState({ user_id: 'me' });

    await useTransactionStore.getState().acceptReview(reviewItem());

    expect(updateExpense).toHaveBeenCalledWith('e1', expect.objectContaining({ groupId: '999' }));
  });

  test('refuses to push when the split has not reached Splitwise yet', async () => {
    await expect(
      useTransactionStore.getState().acceptReview(reviewItem({ splitwise_expense_id: null, expense_id: 'p1' }))
    ).rejects.toThrow('SPLIT_NOT_PUSHED');

    expect(updateExpense).not.toHaveBeenCalled();
    expect(clearReview).not.toHaveBeenCalled();
  });

  test('throws instead of rewriting the expense owner-only when the decision is missing', async () => {
    (getSplitDecision as jest.Mock).mockResolvedValue(null);

    await expect(
      useTransactionStore.getState().acceptReview(reviewItem())
    ).rejects.toThrow();

    expect(updateExpense).not.toHaveBeenCalled();
    expect(clearReview).not.toHaveBeenCalled();
  });

  test('does not clear the review when updateExpense throws', async () => {
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 20.1, f1: 12, f2: 10 }, groupId: null });
    (updateExpense as jest.Mock).mockRejectedValue(new Error('SPLITWISE_ERROR'));
    useAuthStore.setState({ user_id: 'me' });

    await expect(useTransactionStore.getState().acceptReview(reviewItem())).rejects.toThrow();

    expect(clearReview).not.toHaveBeenCalled();
  });

  test('an auth failure on the accept path reports to authStore', async () => {
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 20.1, f1: 12, f2: 10 }, groupId: null });
    (updateExpense as jest.Mock).mockRejectedValue(new SplitwiseAuthError());
    useAuthStore.setState({ user_id: 'me', tokenValid: true });

    await expect(useTransactionStore.getState().acceptReview(reviewItem())).rejects.toBeInstanceOf(SplitwiseAuthError);

    expect(useAuthStore.getState().tokenValid).toBe(false);
  });

  test('a reversed item deletes the expense, the rows, and the review', async () => {
    const item = reviewItem({ reason: 'reversed', amount_changed_from: null });

    await useTransactionStore.getState().acceptReview(item);

    expect(deleteExpense).toHaveBeenCalledWith('e1');
    expect(deleteTransactionsByPlaidIds).toHaveBeenCalledWith(['p1']);
    expect(updateExpense).not.toHaveBeenCalled();
  });

  test('a reversed item refuses to delete when the split has not pushed yet', async () => {
    await expect(
      useTransactionStore.getState().acceptReview(
        reviewItem({ reason: 'reversed', splitwise_expense_id: null, expense_id: 'p1' })
      )
    ).rejects.toThrow('SPLIT_NOT_PUSHED');

    expect(deleteExpense).not.toHaveBeenCalled();
  });

  test('a combined split with an unchanged sibling pushes the true total to updateExpense', async () => {
    // tx1 posted at 12 (changed from 10), tx2 never changed and stayed 20 —
    // the true total is 32, not the flagged-only 12 (Critical 1).
    const item = reviewItem({
      amount: 32, amount_changed_from: 30,
      transaction_ids: ['tx1'], member_transaction_ids: ['tx1', 'tx2'],
    });
    (getExpense as jest.Mock).mockResolvedValue({ shares: { me: 10, f1: 10, f2: 10 }, groupId: null });
    (updateExpense as jest.Mock).mockResolvedValue({ amount_each: 10 });
    useAuthStore.setState({ user_id: 'me' });

    await useTransactionStore.getState().acceptReview(item);

    expect(updateExpense).toHaveBeenCalledWith('e1', expect.objectContaining({ amount: 32 }));
    expect(clearReview).toHaveBeenCalledWith(['tx1']);
  });

  test('accepting a reversed combined row reverts every member but deletes only the flagged rows', async () => {
    const item = reviewItem({
      reason: 'reversed', amount_changed_from: null,
      transaction_ids: ['tx1'], member_transaction_ids: ['tx1', 'tx2'],
    });

    await useTransactionStore.getState().acceptReview(item);

    expect(deleteExpense).toHaveBeenCalledWith('e1');
    // deleteCombinedSplit reverts every member (tx1 and tx2) to 'new'...
    expect(mockRevertCombined).toHaveBeenCalledWith(['tx1', 'tx2']);
    // ...but only the flagged row is actually deleted; tx2 stays as 'new'.
    expect(deleteTransactionsByPlaidIds).toHaveBeenCalledWith(['tx1']);
  });
});

describe('rejectReview', () => {
  test('an amount_changed item reverts the local amount', async () => {
    await useTransactionStore.getState().rejectReview({
      id: 'p1', merchant_name: 'Cafe', amount: 47.85, amount_changed_from: 42.1,
      currency: 'USD', date: '2026-07-01', reason: 'amount_changed',
      split: { friend_names: ['Alice'], amount_each: 23.93 },
      splitwise_expense_id: 'e1', expense_id: 'e1', transaction_ids: ['p1'],
    });

    expect(revertReviewedAmount).toHaveBeenCalledWith(['p1']);
    expect(clearReview).not.toHaveBeenCalled();  // revertReviewedAmount clears it itself
  });

  test('a reversed item keeps the split and only clears the review', async () => {
    await useTransactionStore.getState().rejectReview({
      id: 'p1', merchant_name: 'Cafe', amount: 20, amount_changed_from: null,
      currency: 'USD', date: '2026-07-01', reason: 'reversed',
      split: { friend_names: ['Alice'], amount_each: 10 },
      splitwise_expense_id: 'e1', expense_id: 'e1', transaction_ids: ['p1'],
    });

    expect(clearReview).toHaveBeenCalledWith(['p1']);
    expect(revertReviewedAmount).not.toHaveBeenCalled();
    expect(deleteExpense).not.toHaveBeenCalled();
  });
});

describe('scaleFriendShares', () => {
  test('an equal split stays equal at the new total', () => {
    const result = scaleFriendShares({ f1: 14.03, f2: 14.03 }, ['f1', 'f2'], 42.1, 47.85);
    // 47.85 / 42.10 = 1.13657...  →  14.03 → 15.95
    expect(result).toEqual({ f1: 15.95, f2: 15.95 });
  });

  test('a custom split keeps its proportions', () => {
    const result = scaleFriendShares({ f1: 30, f2: 12.1 }, ['f1', 'f2'], 42.1, 47.85);
    expect(result).toEqual({ f1: 34.1, f2: 13.75 });
  });

  test('returns undefined for an old amount of zero (no meaningful ratio)', () => {
    expect(scaleFriendShares({ f1: 10 }, ['f1'], 0, 20)).toBeUndefined();
  });

  test('returns undefined for an empty friend list', () => {
    expect(scaleFriendShares({}, [], 10, 20)).toBeUndefined();
  });

  test('a friend missing from the shares map scales from zero', () => {
    const result = scaleFriendShares({}, ['f1'], 10, 20);
    expect(result).toEqual({ f1: 0 });
  });
});
