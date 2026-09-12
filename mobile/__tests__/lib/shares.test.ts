import { computeShareSplit, toShareFriendAmounts } from '@/lib/shares';

const owner = 'me';

test('4 : 1 : 5 of $100 is $40 / $10 / $50', () => {
  const cents = computeShareSplit({
    totalCents: 10000,
    ownerId: owner,
    friendIds: ['b', 'c'],
    counts: { me: 4, b: 1, c: 5 },
  });

  expect(cents).toEqual({ me: 4000, b: 1000, c: 5000 });
});

test('all-equal counts match an equal split', () => {
  const cents = computeShareSplit({
    totalCents: 9000,
    ownerId: owner,
    friendIds: ['b', 'c'],
    counts: { me: 1, b: 1, c: 1 },
  });

  expect(cents).toEqual({ me: 3000, b: 3000, c: 3000 });
});

test('a missing count defaults to 1', () => {
  const cents = computeShareSplit({
    totalCents: 9000,
    ownerId: owner,
    friendIds: ['b', 'c'],
    counts: {},
  });

  expect(cents).toEqual({ me: 3000, b: 3000, c: 3000 });
});

test('the parts always sum to exactly the total', () => {
  // Awkward totals where the exact division does not land on whole cents.
  for (const totalCents of [10000, 10001, 3333, 1, 7, 99999, 12345]) {
    const cents = computeShareSplit({
      totalCents,
      ownerId: owner,
      friendIds: ['b', 'c'],
      counts: { me: 1, b: 2, c: 3 },
    });
    const sum = Object.values(cents).reduce((a, b) => a + b, 0);
    expect(sum).toBe(totalCents);
  }
});

test('the owner wins a rounding tie', () => {
  // $0.01 across three equal shares: one cent to hand out, owner is index 0.
  const cents = computeShareSplit({
    totalCents: 1,
    ownerId: owner,
    friendIds: ['b', 'c'],
    counts: { me: 1, b: 1, c: 1 },
  });

  expect(cents[owner]).toBe(1);
  expect(cents.b).toBe(0);
  expect(cents.c).toBe(0);
});

test('a zero count owes nothing', () => {
  const cents = computeShareSplit({
    totalCents: 10000,
    ownerId: owner,
    friendIds: ['b', 'c'],
    counts: { me: 1, b: 0, c: 1 },
  });

  expect(cents.b).toBe(0);
  expect(cents[owner] + cents.c).toBe(10000);
});

test('all-zero counts yield all zeros rather than throwing', () => {
  const cents = computeShareSplit({
    totalCents: 10000,
    ownerId: owner,
    friendIds: ['b'],
    counts: { me: 0, b: 0 },
  });

  expect(cents).toEqual({ me: 0, b: 0 });
});

test('a negative count is treated as zero', () => {
  const cents = computeShareSplit({
    totalCents: 10000,
    ownerId: owner,
    friendIds: ['b'],
    counts: { me: 1, b: -3 },
  });

  expect(cents.b).toBe(0);
  expect(cents[owner]).toBe(10000);
});

test('a non-integer count is floored', () => {
  const cents = computeShareSplit({
    totalCents: 10000,
    ownerId: owner,
    friendIds: ['b'],
    counts: { me: 1, b: 2.9 },
  });

  expect(cents).toEqual({ me: 3333, b: 6667 });
});

test('an owner-only split gives the owner everything', () => {
  const cents = computeShareSplit({
    totalCents: 5000, ownerId: owner, friendIds: [], counts: { me: 1 },
  });

  expect(cents).toEqual({ me: 5000 });
});

test('toShareFriendAmounts drops the owner and converts to dollars', () => {
  const dollars = toShareFriendAmounts({ me: 4000, b: 1000, c: 5000 }, owner);

  expect(dollars).toEqual({ b: 10, c: 50 });
});
