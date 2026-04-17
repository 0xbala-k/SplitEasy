import * as SecureStore from 'expo-secure-store';

export const KEYS = {
  SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token',
  PLAID_ACCESS_TOKEN: 'plaid_access_token',
  WORKER_API_KEY: 'worker_api_key',
} as const;

export type SecureKey = (typeof KEYS)[keyof typeof KEYS];

export async function getSecure(key: SecureKey): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function setSecure(key: SecureKey, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecure(key: SecureKey): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
