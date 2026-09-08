// Pure queue algebra for pending Splitwise writes. No I/O — persistence lives
// in lib/db.ts and lib/db.web.ts, execution in the flush runner.
import { PendingOp } from '@/lib/types';

/**
 * Folds an incoming op into the queue, collapsing it against any op already
 * pending for the same transaction.
 *
 * Collapsing is what keeps the remote side consistent. Appending blindly would
 * emit an update against an expense id that does not exist yet, or a delete
 * racing its own create.
 */
export function collapseOps(queue: PendingOp[], incoming: PendingOp): PendingOp[] {
  const idx = queue.findIndex(
    (o) => o.transaction_id !== null && o.transaction_id === incoming.transaction_id
  );
  if (idx === -1) return [...queue, incoming];

  const pending = queue[idx];

  // A create that never left: fold the edit into it, or drop it outright.
  if (pending.op_type === 'create') {
    if (incoming.op_type === 'delete') {
      return [...queue.slice(0, idx), ...queue.slice(idx + 1)];
    }
    return [
      ...queue.slice(0, idx),
      { ...pending, payload: incoming.payload },
      ...queue.slice(idx + 1),
    ];
  }

  // An update already queued: the newer op wins outright.
  if (pending.op_type === 'update') {
    return [...queue.slice(0, idx), { ...incoming, id: pending.id }, ...queue.slice(idx + 1)];
  }

  // A delete is terminal — nothing after it can matter.
  return queue;
}
