import { collapseOps } from '@/lib/splitwiseQueue';
import { PendingOp } from '@/lib/types';

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
