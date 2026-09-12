// mobile/lib/shares.ts
//
// Pure math for the "shares" split mode: divide a charge by per-person share
// counts rather than by dollars. $100 across 4 : 1 : 5 → $40 / $10 / $50.
//
// No UI, no networking. Built on receipt.ts's distribute(), which is the same
// largest-remainder apportionment — see lib/splitwise.ts's buildExpenseBody
// for the floor-remainder-to-owner convention both mirror.

import { distribute } from '@/lib/receipt';

export interface ShareSplitInput {
  totalCents: number;
  ownerId: string;
  /** Stable order, from the picker's selected-friend list. */
  friendIds: string[];
  /** Participant id → share count. A missing entry means one share. */
  counts: Record<string, number>;
}

// A count is a whole number of shares. Fractions are floored and negatives
// clamped, so a malformed input can never make a participant's weight pull
// cents away from everyone else.
function weight(counts: Record<string, number>, id: string): number {
  const raw = counts[id];
  if (raw === undefined) return 1;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

/**
 * Cents owed per participant id, owner included.
 *
 * The owner sits at index 0 of the weight vector, so it wins rounding ties and
 * absorbs the leftover cent — the same convention as every other split mode.
 * The result always sums to exactly `totalCents`; when every count is zero it
 * is all zeros, and the caller is expected to block submission.
 */
export function computeShareSplit({
  totalCents,
  ownerId,
  friendIds,
  counts,
}: ShareSplitInput): Record<string, number> {
  const participantIds = [ownerId, ...friendIds];
  const weights = participantIds.map((id) => weight(counts, id));
  const cents = distribute(totalCents, weights);

  const out: Record<string, number> = {};
  participantIds.forEach((id, i) => {
    out[id] = cents[i];
  });
  return out;
}

/**
 * The friends' portions in dollars, owner excluded — the exact shape
 * buildExpenseBody's `friendShares` expects. The owner's share is derived
 * there as amount - sum(friendShares), which equals its distributed cents.
 */
export function toShareFriendAmounts(
  cents: Record<string, number>,
  ownerId: string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(cents)) {
    if (id === ownerId) continue;
    out[id] = value / 100;
  }
  return out;
}
