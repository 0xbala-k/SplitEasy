// mobile/lib/splitwise.ts
import { SplitwiseFriend } from '@/lib/types';
import { getSecure, KEYS } from '@/lib/secure';

const BASE = 'https://secure.splitwise.com/api/v3.0';

export class SplitwiseAuthError extends Error {
  constructor() {
    super('SPLITWISE_AUTH_EXPIRED');
    this.name = 'SplitwiseAuthError';
  }
}

async function authHeader(): Promise<{ Authorization: string }> {
  const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
  return { Authorization: `Bearer ${token}` };
}

async function swGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: await authHeader() });
  if (res.status === 401) throw new SplitwiseAuthError();
  if (!res.ok) throw new Error('SPLITWISE_ERROR');
  return res.json() as Promise<T>;
}

async function swPost<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      ...(await authHeader()),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(body).toString(),
  });
  if (res.status === 401) throw new SplitwiseAuthError();
  if (!res.ok) throw new Error('SPLITWISE_ERROR');
  return res.json() as Promise<T>;
}

interface RawFriend {
  id: number;
  first_name: string;
  last_name: string;
  picture: { medium?: string } | null;
}

export async function getFriends(): Promise<SplitwiseFriend[]> {
  const data = await swGet<{ friends: RawFriend[] }>('/get_friends');
  return data.friends.map((f) => ({
    id: String(f.id),
    display_name: `${f.first_name} ${f.last_name}`.trim(),
    avatar_url: f.picture?.medium ?? null,
  }));
}

export async function createExpense(params: {
  amount: number;
  description: string;
  currency: string;
  currentUserId: string;
  friendIds: string[];
  includeMe: boolean;
}): Promise<{ expense_id: string; amount_each: number }> {
  const { amount, description, currency, currentUserId, friendIds, includeMe } = params;

  // n is the total number of people sharing the cost
  const n = friendIds.length + (includeMe ? 1 : 0);
  const friendShareCents = Math.floor((amount * 100) / n);
  const friendShare = (friendShareCents / 100).toFixed(2);

  // When includeMe=false, owner paid but owes nothing — friends cover the full amount
  const ownerOwedCents = includeMe
    ? Math.round(amount * 100) - friendShareCents * friendIds.length
    : 0;
  const ownerShare = (ownerOwedCents / 100).toFixed(2);

  const body: Record<string, string> = {
    cost: amount.toFixed(2),
    description,
    currency_code: currency,
    'users__0__user_id': currentUserId,
    'users__0__paid_share': amount.toFixed(2),
    'users__0__owed_share': ownerShare,
  };
  friendIds.forEach((id, i) => {
    body[`users__${i + 1}__user_id`] = id;
    body[`users__${i + 1}__paid_share`] = '0.00';
    body[`users__${i + 1}__owed_share`] = friendShare;
  });

  const data = await swPost<{ expenses: [{ id: number }] }>('/create_expense', body);
  return {
    expense_id: String(data.expenses[0].id),
    amount_each: friendShareCents / 100,
  };
}
