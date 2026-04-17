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

beforeEach(() => {
  jest.clearAllMocks();
  usePlaidStore.setState({
    institution_name: null,
    needs_reauth: false,
    isLinked: false,
    isHydrated: false,
  });
});

test('hydrate sets isLinked true when token exists', async () => {
  mockGetItem.mockResolvedValue('access-sandbox-xyz');
  await AsyncStorage.setItem('plaid_institution_name', 'Chase');
  await usePlaidStore.getState().hydrate();
  expect(usePlaidStore.getState().isLinked).toBe(true);
  expect(usePlaidStore.getState().institution_name).toBe('Chase');
  expect(usePlaidStore.getState().isHydrated).toBe(true);
});

test('linkBank exchanges token, stores it, saves institution name', async () => {
  mockExchange.mockResolvedValue({ access_token: 'access-sandbox-new' });
  mockSetItem.mockResolvedValue(undefined);

  await usePlaidStore.getState().linkBank('public-sandbox-abc', 'Chase');

  expect(mockExchange).toHaveBeenCalledWith('public-sandbox-abc');
  expect(mockSetItem).toHaveBeenCalledWith('plaid_access_token', 'access-sandbox-new');
  expect(await AsyncStorage.getItem('plaid_institution_name')).toBe('Chase');
  expect(await AsyncStorage.getItem('last_plaid_cursor')).toBeNull();
  expect(usePlaidStore.getState().isLinked).toBe(true);
  expect(usePlaidStore.getState().institution_name).toBe('Chase');
});

test('disconnect clears token, AsyncStorage, all transactions, sets isLinked false', async () => {
  mockDeleteItem.mockResolvedValue(undefined);
  mockDeleteAll.mockResolvedValue(undefined);
  usePlaidStore.setState({ isLinked: true, institution_name: 'Chase' });
  await AsyncStorage.setItem('plaid_institution_name', 'Chase');

  await usePlaidStore.getState().disconnect();

  expect(mockDeleteItem).toHaveBeenCalledWith('plaid_access_token');
  expect(mockDeleteAll).toHaveBeenCalled();
  expect(await AsyncStorage.getItem('plaid_institution_name')).toBeNull();
  expect(usePlaidStore.getState().isLinked).toBe(false);
  expect(usePlaidStore.getState().institution_name).toBeNull();
});

test('setNeedsReauth saves to AsyncStorage and updates store', async () => {
  await usePlaidStore.getState().setNeedsReauth(true);
  expect(await AsyncStorage.getItem('plaid_needs_reauth')).toBe('true');
  expect(usePlaidStore.getState().needs_reauth).toBe(true);

  await usePlaidStore.getState().setNeedsReauth(false);
  expect(await AsyncStorage.getItem('plaid_needs_reauth')).toBe('false');
  expect(usePlaidStore.getState().needs_reauth).toBe(false);
});
