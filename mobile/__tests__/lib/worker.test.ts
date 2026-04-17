// mobile/__tests__/lib/worker.test.ts

// Mock expo-constants BEFORE importing worker module
jest.mock('expo-constants', () => {
  return {
    __esModule: true,
    default: {
      expoConfig: {
        extra: {
          workerBaseUrl: 'https://worker.test',
          workerApiKey: 'test-api-key',
        },
      },
    },
  };
});

import { getLinkToken, exchangePublicToken, fetchTransactions, exchangeSplitwiseCode, WorkerError } from '@/lib/worker';

global.fetch = jest.fn();
const mockFetch = fetch as jest.Mock;

beforeEach(() => jest.clearAllMocks());

function mockResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

test('getLinkToken returns link_token', async () => {
  mockResponse({ link_token: 'link-sandbox-abc' });
  const result = await getLinkToken();
  expect(result.link_token).toBe('link-sandbox-abc');
  expect(mockFetch).toHaveBeenCalledWith(
    'https://worker.test/plaid/link-token',
    expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-api-key' }),
    })
  );
});

test('exchangePublicToken returns access_token', async () => {
  mockResponse({ access_token: 'access-sandbox-xyz' });
  const result = await exchangePublicToken('public-sandbox-abc');
  expect(result.access_token).toBe('access-sandbox-xyz');
  expect(mockFetch).toHaveBeenCalledWith(
    'https://worker.test/plaid/exchange',
    expect.objectContaining({ body: JSON.stringify({ public_token: 'public-sandbox-abc' }) })
  );
});

test('fetchTransactions passes access_token and cursor', async () => {
  mockResponse({ added: [], modified: [], removed: [], next_cursor: 'cur2', has_more: false });
  await fetchTransactions('access-token', 'cur1');
  expect(mockFetch).toHaveBeenCalledWith(
    'https://worker.test/plaid/transactions',
    expect.objectContaining({
      body: JSON.stringify({ access_token: 'access-token', cursor: 'cur1' }),
    })
  );
});

test('fetchTransactions omits cursor when undefined', async () => {
  mockResponse({ added: [], modified: [], removed: [], next_cursor: 'cur1', has_more: false });
  await fetchTransactions('access-token');
  const body = JSON.parse(mockFetch.mock.calls[0][1].body);
  expect(body).not.toHaveProperty('cursor');
});

test('fetchTransactions throws WorkerError with ITEM_LOGIN_REQUIRED', async () => {
  mockResponse({ error: 'ITEM_LOGIN_REQUIRED' }, 400);
  await expect(fetchTransactions('access-token')).rejects.toThrow(WorkerError);
  await expect(fetchTransactions('access-token')).rejects.toMatchObject({ code: 'ITEM_LOGIN_REQUIRED' });
});

test('exchangeSplitwiseCode returns auth response', async () => {
  mockResponse({ access_token: 'sw-token', user_id: '42', display_name: 'Bala K', avatar_url: null });
  const result = await exchangeSplitwiseCode('code123', 'spliteasy://oauth/callback');
  expect(result.access_token).toBe('sw-token');
  expect(result.user_id).toBe('42');
});

test('throws WorkerError on non-ok response', async () => {
  mockResponse({ error: 'PLAID_ERROR' }, 500);
  await expect(getLinkToken()).rejects.toThrow(WorkerError);
});
