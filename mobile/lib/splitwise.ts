// mobile/lib/splitwise.ts
import { SplitwiseFriend } from '@/lib/types';
import { splitwiseFetch } from '@/lib/splitwiseTransport';

export class SplitwiseAuthError extends Error {
  constructor() {
    super('SPLITWISE_AUTH_EXPIRED');
    this.name = 'SplitwiseAuthError';
  }
}

async function swGet<T>(path: string): Promise<T> {
  const res = await splitwiseFetch(path);
  if (res.status === 401) throw new SplitwiseAuthError();
  if (!res.ok) throw new Error('SPLITWISE_ERROR');
  return res.json() as Promise<T>;
}

async function swPost<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await splitwiseFetch(path, {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
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

interface ExpenseParams {
  amount: number;
  description: string;
  currency: string;
  currentUserId: string;
  friendIds: string[];
  // When provided, each entry overrides the equal-split share for that friend.
  // owner's owed_share is derived as amount - sum(friendShares).
  friendShares?: Record<string, number>;
}

// Builds the Splitwise indexed user body shared by create_expense and update_expense.
// Returns the body plus the owner's owed share in cents (the "amount each" surfaced to the UI).
function buildExpenseBody(params: ExpenseParams): { body: Record<string, string>; ownerOwedCents: number } {
  let ownerOwedCents: number;

  const body: Record<string, string> = {
    cost: params.amount.toFixed(2),
    description: params.description,
    currency_code: params.currency,
    'users__0__user_id': params.currentUserId,
    'users__0__paid_share': params.amount.toFixed(2),
  };

  if (params.friendShares) {
    let friendTotalCents = 0;
    params.friendIds.forEach((id, i) => {
      const shareCents = Math.round((params.friendShares![id] ?? 0) * 100);
      friendTotalCents += shareCents;
      body[`users__${i + 1}__user_id`] = id;
      body[`users__${i + 1}__paid_share`] = '0.00';
      body[`users__${i + 1}__owed_share`] = (shareCents / 100).toFixed(2);
    });
    ownerOwedCents = Math.round(params.amount * 100) - friendTotalCents;
  } else {
    const n = params.friendIds.length + 1;
    const friendShareCents = Math.floor((params.amount * 100) / n);
    ownerOwedCents = Math.round(params.amount * 100) - friendShareCents * params.friendIds.length;
    params.friendIds.forEach((id, i) => {
      body[`users__${i + 1}__user_id`] = id;
      body[`users__${i + 1}__paid_share`] = '0.00';
      body[`users__${i + 1}__owed_share`] = (friendShareCents / 100).toFixed(2);
    });
  }

  body['users__0__owed_share'] = (ownerOwedCents / 100).toFixed(2);
  return { body, ownerOwedCents };
}

export async function createExpense(params: ExpenseParams): Promise<{ expense_id: string; amount_each: number }> {
  const { body, ownerOwedCents } = buildExpenseBody(params);
  const data = await swPost<{ expenses: [{ id: number }] }>('/create_expense', body);
  return {
    expense_id: String(data.expenses[0].id),
    amount_each: ownerOwedCents / 100,
  };
}

export async function updateExpense(
  expenseId: string,
  params: ExpenseParams
): Promise<{ amount_each: number }> {
  const { body, ownerOwedCents } = buildExpenseBody(params);
  await swPost(`/update_expense/${encodeURIComponent(expenseId)}`, body);
  return { amount_each: ownerOwedCents / 100 };
}

export async function deleteExpense(expenseId: string): Promise<void> {
  await swPost(`/delete_expense/${encodeURIComponent(expenseId)}`, {});
}

// Returns each participant's owed_share (in dollars) keyed by Splitwise user id.
export async function getExpense(expenseId: string): Promise<Record<string, number>> {
  const data = await swGet<{
    expense: { users: { user: { id: number }; owed_share: string }[] };
  }>(`/get_expense/${encodeURIComponent(expenseId)}`);
  const shares: Record<string, number> = {};
  for (const u of data.expense.users) {
    const owed = parseFloat(u.owed_share);
    shares[String(u.user.id)] = Number.isNaN(owed) ? 0 : owed;
  }
  return shares;
}
