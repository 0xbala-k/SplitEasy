// mobile/__tests__/lib/splitwise.test.ts
jest.mock('@/lib/secure', () => ({
  getSecure: jest.fn(),
  KEYS: { SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token' },
}));

import { getSecure } from '@/lib/secure';
import {
  getFriends,
  getGroups,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpense,
  getExpensesUpdatedAfter,
  SplitwiseAuthError,
} from '@/lib/splitwise';

global.fetch = jest.fn();
const mockFetch = fetch as jest.Mock;
const mockGetSecure = getSecure as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecure.mockResolvedValue('sw-token');
});

function mockResponse(body: unknown, status = 200) {
  mockFetch.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

test('getFriends returns mapped friends', async () => {
  mockResponse({
    friends: [
      { id: 123, first_name: 'Alex', last_name: 'Kim', picture: { medium: 'https://img/alex' } },
      { id: 456, first_name: 'Sam', last_name: '', picture: null },
    ],
  });
  const friends = await getFriends();
  expect(friends).toHaveLength(2);
  expect(friends[0]).toEqual({ id: '123', display_name: 'Alex Kim', avatar_url: 'https://img/alex' });
  expect(friends[1]).toEqual({ id: '456', display_name: 'Sam', avatar_url: null });
});

test('getFriends throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(getFriends()).rejects.toThrow(SplitwiseAuthError);
});

test('createExpense builds correct indexed body for 2 people', async () => {
  mockResponse({ expenses: [{ id: 9999 }] });
  const result = await createExpense({
    amount: 30.0,
    description: 'Dinner',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2'],
  });
  expect(result.expense_id).toBe('9999');
  expect(result.amount_each).toBe(15);
  const body = new URLSearchParams(
    mockFetch.mock.calls[0][1].body as string
  );
  expect(body.get('cost')).toBe('30.00');
  expect(body.get('users__0__user_id')).toBe('1');
  expect(body.get('users__0__paid_share')).toBe('30.00');
  expect(body.get('users__0__owed_share')).toBe('15.00');
  expect(body.get('users__1__user_id')).toBe('2');
  expect(body.get('users__1__paid_share')).toBe('0.00');
  expect(body.get('users__1__owed_share')).toBe('15.00');
});

test('createExpense handles 3-way split', async () => {
  mockResponse({ expenses: [{ id: 1000 }] });
  const result = await createExpense({
    amount: 30.0,
    description: 'Groceries',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2', '3'],
  });
  expect(result.amount_each).toBeCloseTo(10.0);
});

test('createExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(
    createExpense({ amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'] })
  ).rejects.toThrow(SplitwiseAuthError);
});

test('getFriends sends Authorization header with token', async () => {
  mockResponse({ friends: [] });
  await getFriends();
  expect(mockFetch).toHaveBeenCalledWith(
    expect.stringContaining('/get_friends'),
    expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sw-token' }) })
  );
});

test('updateExpense posts rebuilt body to /update_expense/{id}', async () => {
  mockResponse({ expenses: [{ id: 555 }] });
  const result = await updateExpense('555', {
    amount: 20.0,
    description: 'Lunch',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2'],
  });
  expect(result.amount_each).toBe(10);
  const [url, opts] = mockFetch.mock.calls[0];
  expect(url).toContain('/update_expense/555');
  expect(opts.method).toBe('POST');
  const body = new URLSearchParams(opts.body as string);
  expect(body.get('cost')).toBe('20.00');
  expect(body.get('users__0__owed_share')).toBe('10.00');
  expect(body.get('users__1__user_id')).toBe('2');
  expect(body.get('users__1__owed_share')).toBe('10.00');
});

test('updateExpense honors custom friendShares', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  const result = await updateExpense('1', {
    amount: 30.0,
    description: 'Dinner',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2'],
    friendShares: { '2': 20 },
  });
  expect(result.amount_each).toBe(10);
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.get('users__1__owed_share')).toBe('20.00');
  expect(body.get('users__0__owed_share')).toBe('10.00');
});

test('updateExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(
    updateExpense('1', { amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'] })
  ).rejects.toThrow(SplitwiseAuthError);
});

test('deleteExpense posts to /delete_expense/{id}', async () => {
  mockResponse({ success: true });
  await deleteExpense('555');
  const [url, opts] = mockFetch.mock.calls[0];
  expect(url).toContain('/delete_expense/555');
  expect(opts.method).toBe('POST');
});

test('deleteExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(deleteExpense('555')).rejects.toThrow(SplitwiseAuthError);
});

test('getExpense returns owed shares keyed by user id', async () => {
  mockResponse({
    expense: {
      users: [
        { user: { id: 1 }, paid_share: '30.00', owed_share: '10.00' },
        { user: { id: 2 }, paid_share: '0.00', owed_share: '10.00' },
        { user: { id: 3 }, paid_share: '0.00', owed_share: '10.00' },
      ],
    },
  });
  const shares = await getExpense('555');
  expect(shares).toEqual({ '1': 10, '2': 10, '3': 10 });
  const [url] = mockFetch.mock.calls[0];
  expect(url).toContain('/get_expense/555');
});

test('getExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(getExpense('555')).rejects.toThrow(SplitwiseAuthError);
});

test('getExpense coerces a malformed owed_share to 0', async () => {
  mockResponse({ expense: { users: [{ user: { id: 2 }, owed_share: '' }] } });
  const shares = await getExpense('5');
  expect(shares).toEqual({ '2': 0 });
});

test('updateExpense URL-encodes the expense id', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await updateExpense('a/b 1', {
    amount: 10,
    description: 'x',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2'],
  });
  const [url] = mockFetch.mock.calls[0];
  expect(url).toContain('/update_expense/a%2Fb%201');
});

test('deleteExpense URL-encodes the expense id', async () => {
  mockResponse({ success: true });
  await deleteExpense('a/b');
  const [url] = mockFetch.mock.calls[0];
  expect(url).toContain('/delete_expense/a%2Fb');
});

test('getExpense URL-encodes the expense id', async () => {
  mockResponse({ expense: { users: [] } });
  await getExpense('a/b');
  const [url] = mockFetch.mock.calls[0];
  expect(url).toContain('/get_expense/a%2Fb');
});

test('getGroups returns mapped groups with member ids and names', async () => {
  mockResponse({
    groups: [
      {
        id: 55,
        name: 'Hawaii Trip',
        members: [
          { id: 1, first_name: 'Me', last_name: '' },
          { id: 2, first_name: 'Sam', last_name: 'K' },
        ],
      },
    ],
  });
  const groups = await getGroups();
  expect(groups).toEqual([
    { id: '55', name: 'Hawaii Trip', member_ids: ['1', '2'], member_names: ['Me', 'Sam K'] },
  ]);
});

test('getGroups throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(getGroups()).rejects.toThrow(SplitwiseAuthError);
});

test('createExpense includes group_id when provided', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await createExpense({
    amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'], groupId: '55',
  });
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.get('group_id')).toBe('55');
});

test('createExpense omits group_id when not provided', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await createExpense({ amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'] });
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.has('group_id')).toBe(false);
});

test('updateExpense includes group_id when provided', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await updateExpense('1', {
    amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'], groupId: '55',
  });
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.get('group_id')).toBe('55');
});

// The Splitwise API base URL the real splitwiseTransport prefixes onto every path
// (mobile/lib/splitwiseTransport.ts). Assertions below check the full fetch() URL,
// matching this file's existing convention of mocking global.fetch rather than
// mocking @/lib/splitwiseTransport directly.
const SPLITWISE_API_BASE = 'https://secure.splitwise.com/api/v3.0';

describe('getExpensesUpdatedAfter', () => {
  // Queues one response per call, in order — for pagination tests where each
  // page must return a different body. mockResponse (above) only sets a single
  // default value for every call, which can't express "page 1 full, page 2 short".
  function mockResponseSequence(bodies: unknown[]) {
    bodies.forEach((body) => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      });
    });
  }

  it('requests the updated_after window and maps the page through', async () => {
    mockResponse({ expenses: [{ id: 7, description: 'Dinner' }] });
    const out = await getExpensesUpdatedAfter('2026-08-20T00:00:00.000Z');
    expect(mockFetch).toHaveBeenCalledWith(
      `${SPLITWISE_API_BASE}/get_expenses?updated_after=2026-08-20T00%3A00%3A00.000Z&limit=100&offset=0`,
      expect.objectContaining({ method: 'GET' })
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(7);
  });

  it('paginates until a short page comes back', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    mockResponseSequence([{ expenses: full }, { expenses: [{ id: 100 }] }]);
    const out = await getExpensesUpdatedAfter('2026-08-20T00:00:00.000Z');
    expect(out).toHaveLength(101);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      `${SPLITWISE_API_BASE}/get_expenses?updated_after=2026-08-20T00%3A00%3A00.000Z&limit=100&offset=100`,
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('stops paginating at the safety cap', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    mockResponse({ expenses: full });
    const out = await getExpensesUpdatedAfter('2026-08-20T00:00:00.000Z');
    expect(out).toHaveLength(1000);
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  it('raises SplitwiseAuthError on 401', async () => {
    mockResponse({}, 401);
    await expect(getExpensesUpdatedAfter('2026-08-20T00:00:00.000Z')).rejects.toBeInstanceOf(
      SplitwiseAuthError
    );
  });
});
