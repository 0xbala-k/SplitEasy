// mobile/__tests__/lib/splitwise.test.ts
jest.mock('@/lib/secure', () => ({
  getSecure: jest.fn(),
  KEYS: { SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token' },
}));

import { getSecure } from '@/lib/secure';
import { getFriends, createExpense, SplitwiseAuthError } from '@/lib/splitwise';

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
