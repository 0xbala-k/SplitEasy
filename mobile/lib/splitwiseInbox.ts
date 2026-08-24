// mobile/lib/splitwiseInbox.ts
//
// Deciding what to do with one raw Splitwise expense. Pure: the caller
// supplies the expense and what the local database already knows about it,
// this returns an action. No I/O, so the whole decision table is testable
// with plain objects.

import { RawSplitwiseExpense, SplitwiseExpenseUser, SplitwiseInboxItem } from '@/lib/types';
import { toLocalDateString } from '@/lib/date';

export interface LocalExpenseState {
  imported: boolean;    // a transactions row with id `sw:<expense_id>` exists
  dismissed: boolean;   // an inbox row with state='dismissed' exists
}

export type InboxAction =
  | { kind: 'skip' }                              // nothing to do
  | { kind: 'remove' }                            // drop the local import and any inbox row
  | { kind: 'update'; item: SplitwiseInboxItem }  // rewrite the imported row's amounts
  | { kind: 'offer'; item: SplitwiseInboxItem };  // upsert as pending for approval

function num(decimal: string | null | undefined): number {
  const n = parseFloat(decimal ?? '0');
  return Number.isNaN(n) ? 0 : n;
}

function nameOf(u: SplitwiseExpenseUser): string {
  return `${u.user.first_name ?? ''} ${u.user.last_name ?? ''}`.trim();
}

/**
 * The expense's payer, as a display name.
 *
 * Splitwise permits several payers on one expense; the largest is the one
 * worth naming on a one-line row. "Someone" is the honest fallback when the
 * payer isn't in the users array at all — better than rendering an empty
 * string into "  paid · your share $30.00".
 */
function payerNameOf(expense: RawSplitwiseExpense): string {
  const payers = expense.users
    .filter((u) => num(u.paid_share) > 0)
    .sort((a, b) => num(b.paid_share) - num(a.paid_share));
  const name = payers.length > 0 ? nameOf(payers[0]) : '';
  return name || 'Someone';
}

export function toInboxItem(
  expense: RawSplitwiseExpense,
  myUserId: string,
  fetchedAt: string
): SplitwiseInboxItem {
  const mine = expense.users.find((u) => String(u.user.id) === myUserId);
  return {
    expense_id: String(expense.id),
    description: expense.description,
    cost: num(expense.cost),
    currency: expense.currency_code,
    // Splitwise sends an instant; the app stores calendar dates in device-local
    // time (see lib/date.ts), so convert rather than slicing the string.
    date: toLocalDateString(new Date(expense.date)),
    payer_name: payerNameOf(expense),
    my_share: num(mine?.owed_share),
    participants: expense.users
      .filter((u) => String(u.user.id) !== myUserId)
      .map((u) => ({ id: String(u.user.id), name: nameOf(u) })),
    group_id: expense.group_id == null ? null : String(expense.group_id),
    state: 'pending',
    fetched_at: fetchedAt,
  };
}

/**
 * What to do with one expense, given what we already know locally.
 *
 * Branch order matters and is asserted by tests:
 *  - deletion and loss-of-participation outrank everything, including a
 *    dismissal tombstone — the expense is gone, so the tombstone is moot.
 *  - `paid_share > 0` is checked BEFORE `imported`, so an expense the user
 *    later becomes the payer of stops being reconciled rather than being
 *    rewritten with a nonsensical share.
 */
export function decideInboxAction(
  expense: RawSplitwiseExpense,
  myUserId: string,
  local: LocalExpenseState
): InboxAction {
  const mine = expense.users.find((u) => String(u.user.id) === myUserId);

  if (expense.deleted_at) return { kind: 'remove' };
  if (!mine || num(mine.owed_share) <= 0) return { kind: 'remove' };
  if (expense.payment) return { kind: 'skip' };
  if (num(mine.paid_share) > 0) return { kind: 'skip' };

  const item = toInboxItem(expense, myUserId, new Date().toISOString());
  if (local.imported) return { kind: 'update', item };
  if (local.dismissed) return { kind: 'skip' };
  return { kind: 'offer', item };
}
