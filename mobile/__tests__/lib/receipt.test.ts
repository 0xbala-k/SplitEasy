// mobile/__tests__/lib/receipt.test.ts
import { computeReceiptShares, toFriendShares, ReceiptComputeInput, ReceiptItem } from '@/lib/receipt';

function item(id: string, priceCents: number, assignees: string[]): ReceiptItem {
  return { id, name: id, priceCents, assignees };
}

function sum(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0);
}

describe('computeReceiptShares', () => {
  test('1. worked example: items $100 total ($80 A / $20 B), tax $10 splits by item subtotal', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B'],
      items: [item('i1', 8000, ['A']), item('i2', 2000, ['B'])],
      taxCents: 1000,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect(r.taxShareCents['A']).toBe(800);
    expect(r.taxShareCents['B']).toBe(200);
  });

  test('2. $10.00 item split 3 ways gives owner the extra cent', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C'],
      items: [item('i1', 1000, ['A', 'B', 'C'])],
      taxCents: 0,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect([r.itemSubtotalCents['A'], r.itemSubtotalCents['B'], r.itemSubtotalCents['C']]).toEqual([334, 333, 333]);
    expect(sum(r.itemSubtotalCents)).toBe(1000);
  });

  test('3. $0.01 tip across 3 participants goes entirely to the owner', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C'],
      items: [],
      taxCents: 0,
      tipCents: 1,
    };
    const r = computeReceiptShares(input);
    expect([r.tipShareCents['A'], r.tipShareCents['B'], r.tipShareCents['C']]).toEqual([1, 0, 0]);
  });

  test('4. items [3333, 3333, 3334] one assignee each, tax 1000 sums exactly', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C'],
      items: [item('i1', 3333, ['A']), item('i2', 3333, ['B']), item('i3', 3334, ['C'])],
      taxCents: 1000,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect(sum(r.taxShareCents)).toBe(1000);
  });

  test('5. all items assigned to one person: that person gets the entire tax', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C'],
      items: [item('i1', 5000, ['B']), item('i2', 3000, ['B'])],
      taxCents: 777,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect(r.taxShareCents['B']).toBe(777);
    expect(r.taxShareCents['A']).toBe(0);
    expect(r.taxShareCents['C']).toBe(0);
  });

  test('6. zero items, non-zero tax splits equally with no NaN / divide-by-zero', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C'],
      items: [],
      taxCents: 100,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect(Object.values(r.taxShareCents).every((v) => Number.isFinite(v))).toBe(true);
    expect(sum(r.taxShareCents)).toBe(100);
    // Equal split of 100 across 3, owner gets the remainder cent.
    expect([r.taxShareCents['A'], r.taxShareCents['B'], r.taxShareCents['C']]).toEqual([34, 33, 33]);
  });

  test('7. empty items array yields all zeros and receiptTotalCents === tax + tip', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B'],
      items: [],
      taxCents: 500,
      tipCents: 200,
    };
    const r = computeReceiptShares(input);
    expect(r.itemsTotalCents).toBe(0);
    expect(r.enteredItemsTotalCents).toBe(0);
    expect(sum(r.itemSubtotalCents)).toBe(0);
    expect(r.receiptTotalCents).toBe(input.taxCents + input.tipCents);
  });

  test('8. an item with assignees: [] is unassigned and contributes 0', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B'],
      items: [item('i1', 500, ['A']), item('i2', 999, [])],
      taxCents: 0,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect(r.unassignedItemIds).toEqual(['i2']);
    expect(r.itemSubtotalCents['A']).toBe(500);
    expect(r.itemSubtotalCents['B']).toBe(0);
    expect(r.itemsTotalCents).toBe(500);
  });

  test('8b. enteredItemsTotalCents sums every item regardless of assignment, unlike itemsTotalCents', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B'],
      items: [item('i1', 500, ['A']), item('i2', 999, []), item('i3', 250, [])],
      taxCents: 0,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    expect(r.unassignedItemIds).toEqual(['i2', 'i3']);
    // Assigned-only, feeds the invariant.
    expect(r.itemsTotalCents).toBe(500);
    // Display-only, includes the unassigned items too.
    expect(r.enteredItemsTotalCents).toBe(500 + 999 + 250);
  });

  test('9. single participant (owner only): owner gets 100%, toFriendShares is empty', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: [],
      items: [item('i1', 1234, ['A'])],
      taxCents: 100,
      tipCents: 50,
    };
    const r = computeReceiptShares(input);
    expect(r.totalPerParticipantCents['A']).toBe(1234 + 100 + 50);
    expect(toFriendShares(r, 'A')).toEqual({});
  });

  test('10. property: totals sum to receiptTotalCents and shares are non-negative (200 seeded cases)', () => {
    // Deterministic mulberry32 PRNG so this is exactly reproducible on every run.
    function mulberry32(seed: number) {
      let s = seed;
      return function rand() {
        s |= 0;
        s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const rand = mulberry32(0xc0ffee);
    const randInt = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));

    for (let trial = 0; trial < 200; trial++) {
      const numItems = randInt(1, 15);
      const numFriends = randInt(0, 7); // 1-8 participants total (owner + friends)
      const friendIds = Array.from({ length: numFriends }, (_, i) => `friend${i}`);
      const participantIds = ['owner', ...friendIds];

      const items: ReceiptItem[] = Array.from({ length: numItems }, (_, i) => {
        const assignees = participantIds.filter(() => rand() < 0.5);
        return item(`item${i}`, randInt(0, 10000), assignees);
      });

      const taxCents = randInt(0, 5000);
      const tipCents = randInt(0, 5000);

      const input: ReceiptComputeInput = { ownerId: 'owner', friendIds, items, taxCents, tipCents };
      const r = computeReceiptShares(input);

      expect(sum(r.totalPerParticipantCents)).toBe(r.receiptTotalCents);
      for (const pid of r.participantIds) {
        expect(r.itemSubtotalCents[pid]).toBeGreaterThanOrEqual(0);
        expect(r.taxShareCents[pid]).toBeGreaterThanOrEqual(0);
        expect(r.tipShareCents[pid]).toBeGreaterThanOrEqual(0);
        expect(r.totalPerParticipantCents[pid]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('11. determinism: identical input yields identical output across two calls', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C', 'D'],
      items: [
        item('i1', 1111, ['A', 'B']),
        item('i2', 2222, ['C']),
        item('i3', 3333, ['A', 'B', 'C', 'D']),
        item('i4', 444, []),
      ],
      taxCents: 321,
      tipCents: 654,
    };
    const r1 = computeReceiptShares(input);
    const r2 = computeReceiptShares(input);
    expect(r1).toEqual(r2);
  });
});

describe('toFriendShares', () => {
  test('excludes the owner and converts cents to dollars', () => {
    const input: ReceiptComputeInput = {
      ownerId: 'A',
      friendIds: ['B', 'C'],
      items: [item('i1', 3000, ['A', 'B', 'C'])],
      taxCents: 0,
      tipCents: 0,
    };
    const r = computeReceiptShares(input);
    const shares = toFriendShares(r, 'A');
    expect(shares).not.toHaveProperty('A');
    expect(shares['B']).toBeCloseTo(10, 5);
    expect(shares['C']).toBeCloseTo(10, 5);
  });
});
