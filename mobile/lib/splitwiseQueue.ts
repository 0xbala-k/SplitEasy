// Pure queue algebra for pending Splitwise writes. No I/O — persistence lives
// in lib/db.ts and lib/db.web.ts, execution in the flush runner.
import { PendingOp } from '@/lib/types';
import {
  createExpense, updateExpense, deleteExpense, getExpensesUpdatedAfter, SplitwiseAuthError,
} from '@/lib/splitwise';
import { getPendingOps, dequeueOp, recordOpFailure, backfillExpenseId } from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';

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

export const MAX_ATTEMPTS = 5;

let flushing = false;

/**
 * Looks for an expense that a previous attempt may have created before its
 * response was lost.
 *
 * Splitwise has no idempotency key, so this matches on content. Two genuinely
 * identical splits in the same window are indistinguishable — a rare
 * false-positive adopt is preferable to a duplicate in a friend's Splitwise.
 */
export async function findMatchingExpense(op: PendingOp): Promise<string | null> {
  const params = JSON.parse(op.payload);
  try {
    const candidates = await getExpensesUpdatedAfter(op.created_at);
    const match = candidates.find(
      (e: any) =>
        e.description === params.description &&
        Math.round(parseFloat(e.cost) * 100) === Math.round(params.amount * 100) &&
        e.currency_code === params.currency
    );
    return match ? String(match.id) : null;
  } catch {
    // Cannot confirm either way; the caller treats this as "no match" and the
    // attempt counter still bounds the retries.
    return null;
  }
}

/**
 * Pushes queued writes to Splitwise. Serial and FIFO — parallel execution would
 * reorder operations against the same expense. Safe to call concurrently; a
 * second call while one is in flight returns immediately.
 */
export async function flushQueue(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    for (const op of await getPendingOps()) {
      if (op.attempts >= MAX_ATTEMPTS) continue;

      try {
        if (op.op_type === 'create') {
          // A retry may be chasing a create that already landed.
          const adopted = op.attempts > 0 ? await findMatchingExpense(op) : null;
          if (adopted) {
            if (op.transaction_id) await backfillExpenseId(op.transaction_id, adopted);
          } else {
            const { expense_id } = await createExpense(JSON.parse(op.payload));
            if (op.transaction_id) await backfillExpenseId(op.transaction_id, expense_id);
          }
        } else if (op.op_type === 'update') {
          await updateExpense(op.expense_id!, JSON.parse(op.payload));
        } else {
          await deleteExpense(op.expense_id!);
        }
        await dequeueOp(op.id);
        useAuthStore.getState().reportAuthSuccess();
      } catch (err) {
        if (err instanceof SplitwiseAuthError) {
          // Every remaining op would fail identically. Stop, and let the banner
          // ask for a reconnect.
          useAuthStore.getState().reportAuthFailure();
          return;
        }
        await recordOpFailure(op.id, err instanceof Error ? err.message : String(err));
      }
    }
  } finally {
    flushing = false;
  }
}
