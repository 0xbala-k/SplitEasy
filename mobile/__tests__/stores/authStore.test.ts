// mobile/__tests__/stores/authStore.test.ts
jest.mock('expo-secure-store');
jest.mock('@/lib/worker');
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as worker from '@/lib/worker';
import { setSecure, KEYS } from '@/lib/secure';
import { useAuthStore, SPLITWISE_WATERMARK_KEY } from '@/stores/authStore';

const mockSetItem = SecureStore.setItemAsync as jest.Mock;
const mockGetItem = SecureStore.getItemAsync as jest.Mock;
const mockDeleteItem = SecureStore.deleteItemAsync as jest.Mock;
const mockExchange = worker.exchangeSplitwiseCode as jest.Mock;

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  useAuthStore.setState({
    user_id: null,
    display_name: null,
    avatar_url: null,
    hasSession: false,
    tokenValid: false,
    lastReconnectAt: null,
    isHydrated: false,
  });
});

test('signIn stores token, saves metadata, sets hasSession and tokenValid', async () => {
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
  expect(useAuthStore.getState().hasSession).toBe(true);
  expect(useAuthStore.getState().tokenValid).toBe(true);
  expect(useAuthStore.getState().user_id).toBe('42');
});

test('signOut clears token, clears metadata, clears hasSession and tokenValid', async () => {
  useAuthStore.setState({
    hasSession: true,
    tokenValid: true,
    user_id: '42',
    display_name: 'Bala K',
    avatar_url: null,
  });
  await AsyncStorage.setItem('splitwise_user_id', '42');
  mockDeleteItem.mockResolvedValue(undefined);

  await useAuthStore.getState().signOut();

  expect(mockDeleteItem).toHaveBeenCalledWith('splitwise_access_token');
  expect(await AsyncStorage.getItem('splitwise_user_id')).toBeNull();
  expect(useAuthStore.getState().hasSession).toBe(false);
  expect(useAuthStore.getState().tokenValid).toBe(false);
  expect(useAuthStore.getState().user_id).toBeNull();
});

test('hydrate sets hasSession and tokenValid true when token and user exist', async () => {
  mockGetItem.mockResolvedValue('existing-token');
  await AsyncStorage.setItem('splitwise_user_id', '99');
  await AsyncStorage.setItem('splitwise_display_name', 'Jane');

  await useAuthStore.getState().hydrate();

  expect(useAuthStore.getState().hasSession).toBe(true);
  expect(useAuthStore.getState().tokenValid).toBe(true);
  expect(useAuthStore.getState().user_id).toBe('99');
  expect(useAuthStore.getState().display_name).toBe('Jane');
  expect(useAuthStore.getState().isHydrated).toBe(true);
});

test('hydrate sets hasSession and tokenValid false when no token and no user', async () => {
  mockGetItem.mockResolvedValue(null);
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState().hasSession).toBe(false);
  expect(useAuthStore.getState().tokenValid).toBe(false);
  expect(useAuthStore.getState().isHydrated).toBe(true);
});

it('clears the Splitwise watermark on sign-out', async () => {
  await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-08-01T00:00:00.000Z');
  await useAuthStore.getState().signOut();
  expect(await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY)).toBeNull();
});

describe('authStore session vs token validity', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    useAuthStore.setState({
      user_id: null, display_name: null, avatar_url: null,
      hasSession: false, tokenValid: false, lastReconnectAt: null, isHydrated: false,
    });
    jest.clearAllMocks();
  });

  it('hydrates hasSession from user_id even when the token is gone', async () => {
    await AsyncStorage.setItem('splitwise_user_id', 'u1');
    // No token written.
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().hasSession).toBe(true);
    expect(useAuthStore.getState().tokenValid).toBe(false);
  });

  it('hydrates both flags true when a token is present', async () => {
    await AsyncStorage.setItem('splitwise_user_id', 'u1');
    await setSecure(KEYS.SPLITWISE_ACCESS_TOKEN, 'tok');
    mockGetItem.mockResolvedValue('tok');
    await useAuthStore.getState().hydrate();
    expect(useAuthStore.getState().hasSession).toBe(true);
    expect(useAuthStore.getState().tokenValid).toBe(true);
  });

  it('reportAuthFailure clears tokenValid but preserves hasSession', async () => {
    useAuthStore.setState({ hasSession: true, tokenValid: true });
    useAuthStore.getState().reportAuthFailure();
    expect(useAuthStore.getState().tokenValid).toBe(false);
    expect(useAuthStore.getState().hasSession).toBe(true);
  });

  it('reportAuthSuccess restores tokenValid', () => {
    useAuthStore.setState({ hasSession: true, tokenValid: false });
    useAuthStore.getState().reportAuthSuccess();
    expect(useAuthStore.getState().tokenValid).toBe(true);
  });

  it('signIn preserves the watermark when the same user reconnects', async () => {
    await AsyncStorage.setItem('splitwise_user_id', 'u1');
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-09-01T00:00:00.000Z');
    mockExchange.mockResolvedValue({
      access_token: 'tok2', user_id: 'u1', display_name: 'Bala', avatar_url: null,
    });

    await useAuthStore.getState().signIn('code', 'redirect');

    expect(await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY)).toBe('2026-09-01T00:00:00.000Z');
    expect(useAuthStore.getState().tokenValid).toBe(true);
    expect(useAuthStore.getState().lastReconnectAt).not.toBeNull();
  });

  it('signIn writes lastReconnectAt to AsyncStorage so it survives an app restart', async () => {
    mockExchange.mockResolvedValue({
      access_token: 'tok2', user_id: 'u1', display_name: 'Bala', avatar_url: null,
    });

    await useAuthStore.getState().signIn('code', 'redirect');
    const setAt = useAuthStore.getState().lastReconnectAt;
    expect(setAt).not.toBeNull();

    // Simulate an app restart: a fresh in-memory store, then hydrate() from
    // whatever AsyncStorage/SecureStore still have on disk.
    useAuthStore.setState({
      user_id: null, display_name: null, avatar_url: null,
      hasSession: false, tokenValid: false, lastReconnectAt: null, isHydrated: false,
    });
    mockGetItem.mockResolvedValue('tok2');

    await useAuthStore.getState().hydrate();

    expect(useAuthStore.getState().lastReconnectAt).toBe(setAt);
  });

  it('signIn clears the watermark when a different user signs in', async () => {
    await AsyncStorage.setItem('splitwise_user_id', 'u1');
    await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, '2026-09-01T00:00:00.000Z');
    mockExchange.mockResolvedValue({
      access_token: 'tok2', user_id: 'DIFFERENT', display_name: 'Someone', avatar_url: null,
    });

    await useAuthStore.getState().signIn('code', 'redirect');

    expect(await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY)).toBeNull();
  });
});
