jest.mock('expo-secure-store');

import * as SecureStore from 'expo-secure-store';
import { KEYS, getSecure, setSecure, deleteSecure } from '@/lib/secure';

const mockGet = SecureStore.getItemAsync as jest.Mock;
const mockSet = SecureStore.setItemAsync as jest.Mock;
const mockDel = SecureStore.deleteItemAsync as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test('getSecure returns value from SecureStore', async () => {
  mockGet.mockResolvedValue('tok_abc');
  expect(await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN)).toBe('tok_abc');
  expect(mockGet).toHaveBeenCalledWith(KEYS.SPLITWISE_ACCESS_TOKEN);
});

test('getSecure returns null when key absent', async () => {
  mockGet.mockResolvedValue(null);
  expect(await getSecure(KEYS.PLAID_ACCESS_TOKEN)).toBeNull();
});

test('setSecure calls SecureStore.setItemAsync', async () => {
  mockSet.mockResolvedValue(undefined);
  await setSecure(KEYS.PLAID_ACCESS_TOKEN, 'access-token-xyz');
  expect(mockSet).toHaveBeenCalledWith(KEYS.PLAID_ACCESS_TOKEN, 'access-token-xyz');
});

test('deleteSecure calls SecureStore.deleteItemAsync', async () => {
  mockDel.mockResolvedValue(undefined);
  await deleteSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
  expect(mockDel).toHaveBeenCalledWith(KEYS.SPLITWISE_ACCESS_TOKEN);
});
