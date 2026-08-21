import {
  myShareCentsByTransaction, monthKeyOf, availableMonths, aggregateMonth, formatMonthKey,
  formatCents, SpendRow,
} from '@/lib/spend';

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    id: 'tx1',
    merchant_name: 'Cafe',
    amount: 20,
    currency: 'USD',
    date: '2026-08-10',
    status: 'skipped',
    bucket: 'food',
    bucket_source: 'auto',
    splitwise_expense_id: null,
    amount_each: null,
    vacation_id: null,
    vacation_start_date: null,
    vacation_started_at: null,
    vacation_created_at: null,
    ...over,
  };
}

describe('myShareCentsByTransaction', () => {
  it('counts the full amount for a skipped transaction', () => {
    const shares = myShareCentsByTransaction([row({ amount: 20, status: 'skipped' })]);
    expect(shares.get('tx1')).toBe(2000);
  });

  it('counts amount_each for a split covering one transaction', () => {
    const shares = myShareCentsByTransaction([
      row({ id: 'a', amount: 60, status: 'split', splitwise_expense_id: 'e1', amount_each: 20 }),
    ]);
    expect(shares.get('a')).toBe(2000);
  });

  it('pro-rates a combined split instead of counting amount_each N times', () => {
    // One $30 expense split three ways: the owner owes $10 of it. Two
    // transactions ($20 and $10) share that one expense.
    const rows = [
      row({ id: 'a', amount: 20, status: 'split', splitwise_expense_id: 'e1', amount_each: 10 }),
      row({ id: 'b', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10 }),
    ];
    const shares = myShareCentsByTransaction(rows);
    expect(shares.get('a')).toBe(667);
    expect(shares.get('b')).toBe(333);
    // The whole point: members sum to amount_each, not 2 x amount_each.
    expect(shares.get('a')! + shares.get('b')!).toBe(1000);
  });

  it('distributes odd cents so members always sum to amount_each exactly', () => {
    const rows = [
      row({ id: 'a', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10.01 }),
      row({ id: 'b', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10.01 }),
      row({ id: 'c', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 10.01 }),
    ];
    const shares = myShareCentsByTransaction(rows);
    const total = ['a', 'b', 'c'].reduce((s, id) => s + shares.get(id)!, 0);
    expect(total).toBe(1001);
  });

  it('property: member shares always sum to amount_each, for many shapes', () => {
    for (let n = 2; n <= 6; n++) {
      for (const eachCents of [1, 7, 100, 333, 99999]) {
        const rows = Array.from({ length: n }, (_, i) =>
          row({
            id: `m${i}`,
            amount: (i + 1) * 3.37,
            status: 'split',
            splitwise_expense_id: 'e1',
            amount_each: eachCents / 100,
          })
        );
        const shares = myShareCentsByTransaction(rows);
        const total = rows.reduce((s, r) => s + shares.get(r.id)!, 0);
        expect(total).toBe(eachCents);
        // and no member gets a negative share
        for (const r of rows) expect(shares.get(r.id)!).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('keeps separate expenses independent', () => {
    const rows = [
      row({ id: 'a', amount: 10, status: 'split', splitwise_expense_id: 'e1', amount_each: 5 }),
      row({ id: 'b', amount: 10, status: 'split', splitwise_expense_id: 'e2', amount_each: 4 }),
    ];
    const shares = myShareCentsByTransaction(rows);
    expect(shares.get('a')).toBe(500);
    expect(shares.get('b')).toBe(400);
  });
});

describe('monthKeyOf', () => {
  it('uses the transaction date for a non-vacation transaction', () => {
    expect(monthKeyOf(row({ date: '2026-08-10' }))).toBe('2026-08');
  });

  it('uses the vacation start date for a vacation transaction', () => {
    expect(monthKeyOf(row({
      date: '2026-08-10',
      vacation_id: 'v1',
      vacation_start_date: '2026-09-28',
    }))).toBe('2026-09');
  });

  it('puts a trip spanning a month boundary entirely in the start month', () => {
    const dec = row({ id: 'a', date: '2026-12-29', vacation_id: 'v1', vacation_start_date: '2026-12-28' });
    const jan = row({ id: 'b', date: '2027-01-02', vacation_id: 'v1', vacation_start_date: '2026-12-28' });
    expect(monthKeyOf(dec)).toBe('2026-12');
    expect(monthKeyOf(jan)).toBe('2026-12');
  });

  it('falls back to started_at, then created_at, when the trip has no start date', () => {
    expect(monthKeyOf(row({
      date: '2026-08-10', vacation_id: 'v1',
      vacation_start_date: null, vacation_started_at: '2026-07-04T12:00:00Z',
    }))).toBe('2026-07');
    expect(monthKeyOf(row({
      date: '2026-08-10', vacation_id: 'v1',
      vacation_start_date: null, vacation_started_at: null, vacation_created_at: '2026-06-04T12:00:00Z',
    }))).toBe('2026-06');
  });

  it('does not shift a date-only value across a zone boundary', () => {
    // "2026-03-01" parsed as UTC midnight renders as Feb 28 in US Pacific.
    expect(monthKeyOf(row({ date: '2026-03-01' }))).toBe('2026-03');
  });
});

describe('aggregateMonth', () => {
  const rows: SpendRow[] = [
    row({ id: 'a', amount: 100, status: 'skipped', bucket: 'needs', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, status: 'skipped', bucket: 'food', date: '2026-08-05' }),
    row({ id: 'c', amount: 60, status: 'skipped', bucket: 'shopping', date: '2026-08-09' }),
    row({ id: 'd', amount: 25, status: 'skipped', bucket: 'misc', date: '2026-08-11' }),
    row({ id: 'e', amount: 999, status: 'skipped', bucket: 'needs', date: '2026-07-11' }),
  ];

  it('totals only the requested month', () => {
    const m = aggregateMonth(rows, '2026-08');
    expect(m.totalCents).toBe(22500);
    expect(m.rows).toHaveLength(4);
  });

  it('totals by bucket and rolls up to groups', () => {
    const m = aggregateMonth(rows, '2026-08');
    expect(m.byBucket.needs).toBe(10000);
    expect(m.byBucket.food).toBe(4000);
    expect(m.byBucket.shopping).toBe(6000);
    expect(m.byGroup.wants).toBe(10000); // food + shopping
    expect(m.byGroup.misc).toBe(2500);
    expect(m.byGroup.travel).toBe(0);
  });

  it('attaches each row its own share', () => {
    const m = aggregateMonth(rows, '2026-08');
    expect(m.rows.find((r) => r.id === 'a')!.shareCents).toBe(10000);
  });

  it('returns zeroed totals for a month with no data', () => {
    const m = aggregateMonth(rows, '2026-01');
    expect(m.totalCents).toBe(0);
    expect(m.rows).toEqual([]);
    expect(m.byGroup.needs).toBe(0);
  });

  it('reports the dominant currency and footnotes the rest', () => {
    const mixed: SpendRow[] = [
      row({ id: 'a', amount: 100, currency: 'USD', date: '2026-08-02' }),
      row({ id: 'b', amount: 30, currency: 'EUR', date: '2026-08-03' }),
      row({ id: 'c', amount: 10, currency: 'EUR', date: '2026-08-04' }),
    ];
    const m = aggregateMonth(mixed, '2026-08');
    expect(m.currency).toBe('USD');
    expect(m.totalCents).toBe(10000);
    expect(m.otherCurrencies).toEqual([{ currency: 'EUR', cents: 4000 }]);
  });

  it('breaks a currency tie alphabetically so the pie does not flip between reloads', () => {
    const tied: SpendRow[] = [
      row({ id: 'a', amount: 50, currency: 'USD', date: '2026-08-02' }),
      row({ id: 'b', amount: 50, currency: 'EUR', date: '2026-08-03' }),
    ];
    expect(aggregateMonth(tied, '2026-08').currency).toBe('EUR');
  });
});

describe('availableMonths', () => {
  it('lists distinct months, newest first', () => {
    const rows = [
      row({ id: 'a', date: '2026-06-01' }),
      row({ id: 'b', date: '2026-08-01' }),
      row({ id: 'c', date: '2026-08-20' }),
    ];
    expect(availableMonths(rows)).toEqual(['2026-08', '2026-06']);
  });

  it('uses the vacation month, not the transaction month', () => {
    const rows = [row({ id: 'a', date: '2026-08-01', vacation_id: 'v1', vacation_start_date: '2026-05-01' })];
    expect(availableMonths(rows)).toEqual(['2026-05']);
  });
});

describe('formatMonthKey', () => {
  it('renders a human month label', () => {
    expect(formatMonthKey('2026-08')).toBe('August 2026');
  });
});

describe('formatCents', () => {
  it('renders USD with a dollar sign and two decimals', () => {
    expect(formatCents(124055, 'USD')).toBe('$1,240.55');
    expect(formatCents(0, 'USD')).toBe('$0.00');
  });

  it('renders other currencies with their own symbol', () => {
    expect(formatCents(34000, 'EUR')).toContain('340.00');
  });
});
