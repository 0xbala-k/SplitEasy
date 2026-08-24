import { decideInboxAction, toInboxItem } from '@/lib/splitwiseInbox';
import { RawSplitwiseExpense } from '@/lib/types';

const ME = '100';

function expense(over: Partial<RawSplitwiseExpense> = {}): RawSplitwiseExpense {
  return {
    id: 555,
    description: 'Dinner at Joe\'s',
    cost: '60.00',
    currency_code: 'USD',
    date: '2026-08-20T18:30:00Z',
    group_id: null,
    payment: false,
    deleted_at: null,
    updated_at: '2026-08-20T18:31:00Z',
    users: [
      { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '60.00', owed_share: '30.00' },
      { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '0.00', owed_share: '30.00' },
    ],
    ...over,
  };
}

const FRESH = { imported: false, dismissed: false };

test('offers a friend-paid expense the user owes a share of', () => {
  const action = decideInboxAction(expense(), ME, FRESH);
  expect(action.kind).toBe('offer');
  expect(action.kind === 'offer' && action.item.my_share).toBe(30);
  expect(action.kind === 'offer' && action.item.cost).toBe(60);
  expect(action.kind === 'offer' && action.item.payer_name).toBe('Alice Ng');
});

test('removes a deleted expense', () => {
  expect(decideInboxAction(expense({ deleted_at: '2026-08-21T00:00:00Z' }), ME, { imported: true, dismissed: false }).kind)
    .toBe('remove');
});

test('removes an expense the user is no longer part of', () => {
  const e = expense({ users: [
    { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '60.00', owed_share: '60.00' },
  ] });
  expect(decideInboxAction(e, ME, { imported: true, dismissed: false }).kind).toBe('remove');
});

test('removes an expense whose owed share dropped to zero', () => {
  const e = expense({ users: [
    { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '60.00', owed_share: '60.00' },
    { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '0.00', owed_share: '0.00' },
  ] });
  expect(decideInboxAction(e, ME, { imported: true, dismissed: false }).kind).toBe('remove');
});

test('skips a settlement payment', () => {
  expect(decideInboxAction(expense({ payment: true }), ME, FRESH).kind).toBe('skip');
});

test('skips an expense the user paid for — this is what excludes SplitEasy\'s own expenses', () => {
  const e = expense({ users: [
    { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '60.00', owed_share: '30.00' },
    { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '0.00', owed_share: '30.00' },
  ] });
  expect(decideInboxAction(e, ME, FRESH).kind).toBe('skip');
});

test('being the payer outranks already being imported', () => {
  const e = expense({ users: [
    { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '60.00', owed_share: '30.00' },
    { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '0.00', owed_share: '30.00' },
  ] });
  expect(decideInboxAction(e, ME, { imported: true, dismissed: false }).kind).toBe('skip');
});

test('updates an already-imported expense', () => {
  const action = decideInboxAction(expense({ cost: '80.00' }), ME, { imported: true, dismissed: false });
  expect(action.kind).toBe('update');
  expect(action.kind === 'update' && action.item.cost).toBe(80);
});

test('never re-offers a dismissed expense', () => {
  expect(decideInboxAction(expense(), ME, { imported: false, dismissed: true }).kind).toBe('skip');
});

test('deletion outranks a dismissal tombstone', () => {
  expect(decideInboxAction(expense({ deleted_at: '2026-08-21T00:00:00Z' }), ME, { imported: false, dismissed: true }).kind)
    .toBe('remove');
});

describe('toInboxItem', () => {
  test('converts the ISO datetime to a local calendar date', () => {
    const item = toInboxItem(expense({ date: '2026-08-20T18:30:00Z' }), ME, '2026-08-24T00:00:00.000Z');
    expect(item.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('stringifies ids and excludes the user from participants', () => {
    const item = toInboxItem(expense(), ME, '2026-08-24T00:00:00.000Z');
    expect(item.expense_id).toBe('555');
    expect(item.participants).toEqual([{ id: '200', name: 'Alice Ng' }]);
  });

  test('carries the group id as a string, or null', () => {
    expect(toInboxItem(expense({ group_id: 42 }), ME, 'x').group_id).toBe('42');
    expect(toInboxItem(expense({ group_id: null }), ME, 'x').group_id).toBeNull();
  });

  test('picks the largest payer when several people paid', () => {
    const e = expense({ users: [
      { user: { id: 200, first_name: 'Alice', last_name: 'Ng' }, paid_share: '20.00', owed_share: '20.00' },
      { user: { id: 300, first_name: 'Cara', last_name: 'Lo' }, paid_share: '40.00', owed_share: '20.00' },
      { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '0.00', owed_share: '20.00' },
    ] });
    expect(toInboxItem(e, ME, 'x').payer_name).toBe('Cara Lo');
  });

  test('falls back to "Someone" when no payer is identifiable', () => {
    const e = expense({ users: [
      { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '0.00', owed_share: '20.00' },
    ] });
    expect(toInboxItem(e, ME, 'x').payer_name).toBe('Someone');
  });

  test('tolerates a participant with no last name', () => {
    const e = expense({ users: [
      { user: { id: 200, first_name: 'Alice', last_name: null }, paid_share: '60.00', owed_share: '30.00' },
      { user: { id: 100, first_name: 'Bala', last_name: 'K' }, paid_share: '0.00', owed_share: '30.00' },
    ] });
    expect(toInboxItem(e, ME, 'x').payer_name).toBe('Alice');
  });
});
