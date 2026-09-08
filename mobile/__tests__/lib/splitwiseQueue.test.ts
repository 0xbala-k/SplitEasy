import { collapseOps, flushQueue, MAX_ATTEMPTS } from '@/lib/splitwiseQueue';
import { PendingOp } from '@/lib/types';
import * as splitwise from '@/lib/splitwise';
import * as db from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';

jest.mock('@/lib/splitwise');
jest.mock('@/lib/db');

const op = (over: Partial<PendingOp>): PendingOp => ({
  id: 'op1', op_type: 'create', transaction_id: 't1', expense_id: null,
  payload: '{"cost":"10.00"}', attempts: 0, last_error: null,
  created_at: '2026-09-08T00:00:00.000Z', ...over,
});

describe('collapseOps', () => {
  it('rewrites a pending create rather than queueing an update', () => {
    const queue = [op({ id: 'a', op_type: 'create' })];
    const out = collapseOps(queue, op({ id: 'b', op_type: 'update', payload: '{"cost":"20.00"}' }));

    // Updating an expense id that does not exist yet would 404.
    expect(out).toHaveLength(1);
    expect(out[0].op_type).toBe('create');
    expect(out[0].payload).toBe('{"cost":"20.00"}');
  });

  it('drops a pending create entirely when the split is deleted', () => {
    const queue = [op({ id: 'a', op_type: 'create' })];
    const out = collapseOps(queue, op({ id: 'b', op_type: 'delete' }));

    // Never created remotely, so there is nothing to delete.
    expect(out).toHaveLength(0);
  });

  it('replaces a pending update with the newer payload', () => {
    const queue = [op({ id: 'a', op_type: 'update', expense_id: 'e1' })];
    const out = collapseOps(queue, op({ id: 'b', op_type: 'update', expense_id: 'e1', payload: '{"cost":"30.00"}' }));

    expect(out).toHaveLength(1);
    expect(out[0].payload).toBe('{"cost":"30.00"}');
  });

  it('supersedes a pending update with a delete', () => {
    const queue = [op({ id: 'a', op_type: 'update', expense_id: 'e1' })];
    const out = collapseOps(queue, op({ id: 'b', op_type: 'delete', expense_id: 'e1' }));

    expect(out).toHaveLength(1);
    expect(out[0].op_type).toBe('delete');
  });

  it('leaves ops for other transactions untouched', () => {
    const queue = [op({ id: 'a', op_type: 'create', transaction_id: 'OTHER' })];
    const out = collapseOps(queue, op({ id: 'b', op_type: 'update', transaction_id: 't1' }));

    expect(out).toHaveLength(2);
  });

  it('preserves FIFO order when appending', () => {
    const queue = [op({ id: 'a', transaction_id: 'x' }), op({ id: 'b', transaction_id: 'y' })];
    const out = collapseOps(queue, op({ id: 'c', transaction_id: 'z' }));

    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('flushQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ tokenValid: true });
  });

  it('processes ops serially in FIFO order', async () => {
    const order: string[] = [];
    (db.getPendingOps as jest.Mock).mockResolvedValue([
      op({ id: 'a', transaction_id: 'x' }), op({ id: 'b', transaction_id: 'y' }),
    ]);
    (splitwise.createExpense as jest.Mock).mockImplementation(async () => {
      order.push('call');
      return { expense_id: 'e', amount_each: 5 };
    });

    await flushQueue();

    // Parallel execution would reorder writes against the same expense.
    expect(order).toHaveLength(2);
    expect(db.dequeueOp).toHaveBeenNthCalledWith(1, 'a');
    expect(db.dequeueOp).toHaveBeenNthCalledWith(2, 'b');
  });

  it('halts on a 401 rather than burning the queue against a dead token', async () => {
    (db.getPendingOps as jest.Mock).mockResolvedValue([
      op({ id: 'a', transaction_id: 'x' }), op({ id: 'b', transaction_id: 'y' }),
    ]);
    (splitwise.createExpense as jest.Mock).mockRejectedValue(new splitwise.SplitwiseAuthError());

    await flushQueue();

    expect(splitwise.createExpense).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().tokenValid).toBe(false);
  });

  it('adopts an existing expense instead of duplicating it on retry', async () => {
    (db.getPendingOps as jest.Mock).mockResolvedValue([
      op({ id: 'a', op_type: 'create', attempts: 1,
           payload: JSON.stringify({ amount: 20, description: 'Dinner', currency: 'USD', friendIds: ['1'] }) }),
    ]);
    (splitwise.getExpensesUpdatedAfter as jest.Mock).mockResolvedValue([
      { id: 55, cost: '20.00', description: 'Dinner', currency_code: 'USD',
        users: [{ user: { id: 1 } }] },
    ]);

    await flushQueue();

    // The previous attempt DID land; creating again would duplicate it in the
    // friend's Splitwise.
    expect(splitwise.createExpense).not.toHaveBeenCalled();
    expect(db.dequeueOp).toHaveBeenCalledWith('a');
  });

  it('stops retrying an op that exhausts MAX_ATTEMPTS', async () => {
    (db.getPendingOps as jest.Mock).mockResolvedValue([
      op({ id: 'a', attempts: MAX_ATTEMPTS }),
    ]);

    await flushQueue();

    // Left in place, never silently discarded — the banner surfaces it.
    expect(splitwise.createExpense).not.toHaveBeenCalled();
    expect(db.dequeueOp).not.toHaveBeenCalled();
  });

  it('records the error and continues on a non-auth failure', async () => {
    (db.getPendingOps as jest.Mock).mockResolvedValue([
      op({ id: 'a', transaction_id: 'x' }), op({ id: 'b', transaction_id: 'y' }),
    ]);
    (splitwise.createExpense as jest.Mock)
      .mockRejectedValueOnce(new Error('HTTP 500'))
      .mockResolvedValueOnce({ expense_id: 'e2', amount_each: 5 });

    await flushQueue();

    expect(db.recordOpFailure).toHaveBeenCalledWith('a', expect.stringContaining('500'));
    expect(db.dequeueOp).toHaveBeenCalledWith('b');
  });
});
