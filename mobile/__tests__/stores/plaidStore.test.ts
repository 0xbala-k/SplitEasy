// mobile/__tests__/stores/plaidStore.test.ts
jest.mock('expo-secure-store');
jest.mock('@/lib/worker');
jest.mock('@/lib/db');
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as worker from '@/lib/worker';
import * as db from '@/lib/db';
import { usePlaidStore } from '@/stores/plaidStore';

const mockSetItem = SecureStore.setItemAsync as jest.Mock;
const mockGetItem = SecureStore.getItemAsync as jest.Mock;
const mockDeleteItem = SecureStore.deleteItemAsync as jest.Mock;
const mockExchange = worker.exchangePublicToken as jest.Mock;
const mockDeleteAll = db.deleteAllTransactions as jest.Mock;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  mockGetItem.mockResolvedValue(null);
  usePlaidStore.setState({
    accounts: [],
    needs_reauth: false,
    isLinked: false,
    isHydrated: false,
  });
});

test('hydrate sets isLinked true when stored accounts exist', async () => {
  await AsyncStorage.setItem(
    'plaid_accounts',
    JSON.stringify([{ id: 'acct_1', institution_name: 'Chase' }])
  );
  await usePlaidStore.getState().hydrate();
  expect(usePlaidStore.getState().isLinked).toBe(true);
  expect(usePlaidStore.getState().accounts).toEqual([{ id: 'acct_1', institution_name: 'Chase' }]);
  expect(usePlaidStore.getState().isHydrated).toBe(true);
});

test('hydrate migrates legacy single-account token to accounts format', async () => {
  mockGetItem.mockImplementation((key: string) =>
    Promise.resolve(key === 'plaid_access_token' ? 'access-sandbox-xyz' : null)
  );
  await AsyncStorage.setItem('plaid_institution_name', 'Chase');
  await usePlaidStore.getState().hydrate();

  const { accounts, isLinked, isHydrated } = usePlaidStore.getState();
  expect(isLinked).toBe(true);
  expect(isHydrated).toBe(true);
  expect(accounts).toHaveLength(1);
  expect(accounts[0].institution_name).toBe('Chase');
  expect(mockSetItem).toHaveBeenCalledWith(`plaid_token_${accounts[0].id}`, 'access-sandbox-xyz');
  expect(mockDeleteItem).toHaveBeenCalledWith('plaid_access_token');
  expect(await AsyncStorage.getItem('plaid_accounts')).toBe(JSON.stringify(accounts));
  expect(await AsyncStorage.getItem('plaid_institution_name')).toBeNull();
});

test('linkBank exchanges token, stores it, adds account', async () => {
  mockExchange.mockResolvedValue({ access_token: 'access-sandbox-new' });
  mockSetItem.mockResolvedValue(undefined);

  await usePlaidStore.getState().linkBank('public-sandbox-abc', 'Chase');

  const { accounts, isLinked } = usePlaidStore.getState();
  expect(mockExchange).toHaveBeenCalledWith('public-sandbox-abc');
  expect(accounts).toHaveLength(1);
  expect(accounts[0].institution_name).toBe('Chase');
  expect(mockSetItem).toHaveBeenCalledWith(`plaid_token_${accounts[0].id}`, 'access-sandbox-new');
  expect(await AsyncStorage.getItem('plaid_accounts')).toBe(JSON.stringify(accounts));
  expect(isLinked).toBe(true);
});

test('disconnect clears tokens, storage, all transactions, sets isLinked false', async () => {
  mockDeleteItem.mockResolvedValue(undefined);
  mockDeleteAll.mockResolvedValue(undefined);
  usePlaidStore.setState({
    isLinked: true,
    accounts: [{ id: 'acct_1', institution_name: 'Chase' }],
  });
  await AsyncStorage.setItem('plaid_accounts', JSON.stringify([{ id: 'acct_1', institution_name: 'Chase' }]));

  await usePlaidStore.getState().disconnect();

  expect(mockDeleteItem).toHaveBeenCalledWith('plaid_token_acct_1');
  expect(mockDeleteAll).toHaveBeenCalled();
  expect(await AsyncStorage.getItem('plaid_accounts')).toBeNull();
  expect(usePlaidStore.getState().isLinked).toBe(false);
  expect(usePlaidStore.getState().accounts).toEqual([]);
});

test('disconnect of one account keeps the others linked', async () => {
  mockDeleteItem.mockResolvedValue(undefined);
  mockDeleteAll.mockResolvedValue(undefined);
  usePlaidStore.setState({
    isLinked: true,
    accounts: [
      { id: 'acct_1', institution_name: 'Chase' },
      { id: 'acct_2', institution_name: 'Ally' },
    ],
  });

  await usePlaidStore.getState().disconnect('acct_1');

  expect(mockDeleteItem).toHaveBeenCalledWith('plaid_token_acct_1');
  expect(mockDeleteAll).not.toHaveBeenCalled();
  expect(usePlaidStore.getState().accounts).toEqual([{ id: 'acct_2', institution_name: 'Ally' }]);
  expect(usePlaidStore.getState().isLinked).toBe(true);
});

test('setNeedsReauth saves to AsyncStorage and updates store', async () => {
  await usePlaidStore.getState().setNeedsReauth(true);
  expect(await AsyncStorage.getItem('plaid_needs_reauth')).toBe('true');
  expect(usePlaidStore.getState().needs_reauth).toBe(true);

  await usePlaidStore.getState().setNeedsReauth(false);
  expect(await AsyncStorage.getItem('plaid_needs_reauth')).toBe('false');
  expect(usePlaidStore.getState().needs_reauth).toBe(false);
});
