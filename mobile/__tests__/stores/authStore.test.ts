// mobile/__tests__/stores/authStore.test.ts
jest.mock('expo-secure-store');
jest.mock('@/lib/worker');
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as worker from '@/lib/worker';
import { useAuthStore } from '@/stores/authStore';

const mockSetItem = SecureStore.setItemAsync as jest.Mock;
const mockGetItem = SecureStore.getItemAsync as jest.Mock;
const mockDeleteItem = SecureStore.deleteItemAsync as jest.Mock;
const mockExchange = worker.exchangeSplitwiseCode as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useAuthStore.setState({
    user_id: null,
    display_name: null,
    avatar_url: null,
    isAuthenticated: false,
    isHydrated: false,
  });
});

test('signIn stores token, saves metadata, sets isAuthenticated', async () => {
  mockExchange.mockResolvedValue({
    access_token: 'sw-tok',
    user_id: '42',
    display_name: 'Bala K',
    avatar_url: 'https://img/bala',
  });
  mockSetItem.mockResolvedValue(undefined);

  await useAuthStore.getState().signIn('auth-code', 'spliteasy://oauth/callback');

  expect(mockSetItem).toHaveBeenCalledWith('splitwise_access_token', 'sw-tok');
  expect(await AsyncStorage.getItem('splitwise_user_id')).toBe('42');
  expect(await AsyncStorage.getItem('splitwise_display_name')).toBe('Bala K');
  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(useAuthStore.getState().user_id).toBe('42');
});

test('signOut clears token, clears metadata, sets isAuthenticated false', async () => {
  useAuthStore.setState({ isAuthenticated: true, user_id: '42', display_name: 'Bala K', avatar_url: null });
  await AsyncStorage.setItem('splitwise_user_id', '42');
  mockDeleteItem.mockResolvedValue(undefined);

  await useAuthStore.getState().signOut();

  expect(mockDeleteItem).toHaveBeenCalledWith('splitwise_access_token');
  expect(await AsyncStorage.getItem('splitwise_user_id')).toBeNull();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().user_id).toBeNull();
});

test('hydrate sets isAuthenticated true when token exists', async () => {
  mockGetItem.mockResolvedValue('existing-token');
  await AsyncStorage.setItem('splitwise_user_id', '99');
  await AsyncStorage.setItem('splitwise_display_name', 'Jane');

  await useAuthStore.getState().hydrate();

  expect(useAuthStore.getState().isAuthenticated).toBe(true);
  expect(useAuthStore.getState().user_id).toBe('99');
  expect(useAuthStore.getState().display_name).toBe('Jane');
  expect(useAuthStore.getState().isHydrated).toBe(true);
});

test('hydrate sets isAuthenticated false when no token', async () => {
  mockGetItem.mockResolvedValue(null);
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState().isAuthenticated).toBe(false);
  expect(useAuthStore.getState().isHydrated).toBe(true);
});
