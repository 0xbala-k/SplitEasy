// mobile/lib/secure.web.ts
// Web has no OS keychain. Tokens live in localStorage — the standard PWA
// trade-off, equivalent in exposure to the API key already shipped in the JS
// bundle. The prefix namespaces us away from other same-origin storage.
export const KEYS = {
  SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token',
  PLAID_ACCESS_TOKEN: 'plaid_access_token',
  WORKER_API_KEY: 'worker_api_key',
} as const;

export type SecureKey = (typeof KEYS)[keyof typeof KEYS];

const PREFIX = 'spliteasy_secure_';

export async function getSecure(key: string): Promise<string | null> {
  return localStorage.getItem(PREFIX + key);
}

export async function setSecure(key: string, value: string): Promise<void> {
  localStorage.setItem(PREFIX + key, value);
}

export async function deleteSecure(key: string): Promise<void> {
  localStorage.removeItem(PREFIX + key);
}
