// mobile/lib/receipt.ts
//
// Pure math for splitting a scanned/entered receipt (items + tax + tip) across
// an owner and a set of friends. No UI, no networking — see FriendPickerSheet
// for the future consumer and lib/splitwise.ts's buildExpenseBody for the
// pre-existing floor-remainder-to-owner convention this mirrors.

export const OWNER_FALLBACK_ID = '__me__';

export interface ReceiptItem {
  id: string; // local id, e.g. from a generateId() helper already used elsewhere in the codebase
  name: string;
  priceCents: number; // line total (quantity already multiplied in)
  quantity?: number; // display only
  assignees: string[]; // participant ids; [] = unassigned
}

export interface ReceiptComputeInput {
  ownerId: string;
  friendIds: string[]; // stable order, from the existing `selected` set
  items: ReceiptItem[];
  taxCents: number;
  tipCents: number;
}

export interface ReceiptComputeResult {
  participantIds: string[]; // [ownerId, ...friendIds]
  itemSubtotalCents: Record<string, number>;
  taxShareCents: Record<string, number>;
  tipShareCents: Record<string, number>;
  totalPerParticipantCents: Record<string, number>;
  itemsTotalCents: number;
  // Display-only sum of every item's priceCents, assigned or not. Unlike
  // `itemsTotalCents` (assigned-only, feeds the `Σ totalPerParticipantCents
  // === receiptTotalCents` invariant), this exists purely so the UI can show
  // the true entered/scanned total before assignment is complete — see
  // FriendPickerSheet's `ReceiptSummary itemsTotalCents` prop.
  enteredItemsTotalCents: number;
  receiptTotalCents: number; // items + tax + tip
  unassignedItemIds: string[];
}

/**
 * Largest-remainder apportionment of `totalCents` across `weights`.
 *
 * - Each index gets `floor(totalCents * weight_i / weightSum)` cents.
 * - The leftover cents (always an integer < weights.length) are handed out
 *   one at a time to the indices with the largest fractional remainder,
 *   ties broken by ascending index — so the owner (conventionally index 0)
 *   wins ties.
 * - If every weight is 0, returns an all-zero array; callers decide the
 *   fallback (see the tax fallback in computeReceiptShares).
 * - Works for negative totalCents without throwing; the result always sums
 *   to exactly `totalCents`.
 */
function distribute(totalCents: number, weights: number[]): number[] {
  const n = weights.length;
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    return new Array(n).fill(0);
  }

  const exact = weights.map((w) => (totalCents * w) / weightSum);
  const base = exact.map((e) => Math.floor(e));
  const baseSum = base.reduce((a, b) => a + b, 0);
  const rem = totalCents - baseSum;

  const order = base
    .map((b, i) => ({ i, frac: exact[i] - b }))
    .sort((a, b) => {
      if (b.frac !== a.frac) return b.frac - a.frac;
      return a.i - b.i;
    });

  const result = base.slice();
  for (let k = 0; k < rem; k++) {
    result[order[k].i] += 1;
  }
  return result;
}

export function computeReceiptShares(input: ReceiptComputeInput): ReceiptComputeResult {
  const { ownerId, friendIds, items, taxCents, tipCents } = input;
  const participantIds = [ownerId, ...friendIds];

  const itemSubtotalCents: Record<string, number> = {};
  for (const id of participantIds) {
    itemSubtotalCents[id] = 0;
  }

  const unassignedItemIds: string[] = [];
  let itemsTotalCents = 0;
  let enteredItemsTotalCents = 0;

  for (const item of items) {
    enteredItemsTotalCents += item.priceCents;
    if (!item.assignees || item.assignees.length === 0) {
      unassignedItemIds.push(item.id);
      continue;
    }
    const weights = participantIds.map((pid) => (item.assignees.includes(pid) ? 1 : 0));
    const shares = distribute(item.priceCents, weights);
    participantIds.forEach((pid, i) => {
      itemSubtotalCents[pid] += shares[i];
    });
    itemsTotalCents += item.priceCents;
  }

  let taxWeights = participantIds.map((pid) => itemSubtotalCents[pid] ?? 0);
  const taxWeightSum = taxWeights.reduce((a, b) => a + b, 0);
  if (taxWeightSum === 0) {
    taxWeights = participantIds.map(() => 1);
  }
  const taxShares = distribute(taxCents, taxWeights);
  const taxShareCents: Record<string, number> = {};
  participantIds.forEach((pid, i) => {
    taxShareCents[pid] = taxShares[i];
  });

  const tipShares = distribute(
    tipCents,
    participantIds.map(() => 1)
  );
  const tipShareCents: Record<string, number> = {};
  participantIds.forEach((pid, i) => {
    tipShareCents[pid] = tipShares[i];
  });

  const totalPerParticipantCents: Record<string, number> = {};
  participantIds.forEach((pid) => {
    totalPerParticipantCents[pid] = itemSubtotalCents[pid] + taxShareCents[pid] + tipShareCents[pid];
  });

  const receiptTotalCents = itemsTotalCents + taxCents + tipCents;

  return {
    participantIds,
    itemSubtotalCents,
    taxShareCents,
    tipShareCents,
    totalPerParticipantCents,
    itemsTotalCents,
    enteredItemsTotalCents,
    receiptTotalCents,
    unassignedItemIds,
  };
}

export function toFriendShares(r: ReceiptComputeResult, ownerId: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const id of r.participantIds) {
    if (id === ownerId) continue;
    result[id] = (r.totalPerParticipantCents[id] ?? 0) / 100;
  }
  return result;
}
