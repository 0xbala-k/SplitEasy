jest.mock('@/lib/db', () => ({
  getSpendingRows: jest.fn(),
  setTransactionBucket: jest.fn(),
}));

import { getSpendingRows, setTransactionBucket } from '@/lib/db';
import { useSpendStore } from '@/stores/spendStore';
import { SpendRow } from '@/lib/spend';

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    id: 'tx1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-08-10',
    status: 'skipped', bucket: 'food', bucket_source: 'auto',
    splitwise_expense_id: null, amount_each: null, vacation_id: null,
    vacation_start_date: null, vacation_started_at: null, vacation_created_at: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useSpendStore.setState({ rows: [], months: [], monthKey: '', drill: null, isLoading: false });
});

test('load populates rows, months, and selects the newest month', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-06-02' }),
    row({ id: 'b', date: '2026-08-02' }),
  ]);
  await useSpendStore.getState().load();
  const s = useSpendStore.getState();
  expect(s.months).toEqual(['2026-08', '2026-06']);
  expect(s.monthKey).toBe('2026-08');
});

test('load keeps the selected month if it still has data', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-06-02' }),
    row({ id: 'b', date: '2026-08-02' }),
  ]);
  await useSpendStore.getState().load();
  useSpendStore.getState().selectMonth('2026-06');
  await useSpendStore.getState().load();
  expect(useSpendStore.getState().monthKey).toBe('2026-06');
});

test('stepMonth walks the available months and clamps at both ends', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-06-02' }),
    row({ id: 'b', date: '2026-07-02' }),
    row({ id: 'c', date: '2026-08-02' }),
  ]);
  await useSpendStore.getState().load();
  expect(useSpendStore.getState().monthKey).toBe('2026-08');

  useSpendStore.getState().stepMonth(-1);
  expect(useSpendStore.getState().monthKey).toBe('2026-07');
  useSpendStore.getState().stepMonth(-1);
  useSpendStore.getState().stepMonth(-1); // already at the oldest
  expect(useSpendStore.getState().monthKey).toBe('2026-06');

  useSpendStore.getState().stepMonth(1);
  expect(useSpendStore.getState().monthKey).toBe('2026-07');
  useSpendStore.getState().stepMonth(1);
  useSpendStore.getState().stepMonth(1); // already at the newest
  expect(useSpendStore.getState().monthKey).toBe('2026-08');
});

test('current aggregates the selected month', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', date: '2026-08-02', amount: 100, bucket: 'needs' }),
    row({ id: 'b', date: '2026-08-03', amount: 40, bucket: 'food' }),
  ]);
  await useSpendStore.getState().load();
  const m = useSpendStore.getState().current();
  expect(m.totalCents).toBe(14000);
  expect(m.byGroup.needs).toBe(10000);
  expect(m.byGroup.wants).toBe(4000);
});

test('setBucket writes every id through and reloads', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([row({ id: 'a', date: '2026-08-02' })]);
  await useSpendStore.getState().load();
  await useSpendStore.getState().setBucket(['a', 'b'], 'shopping');
  expect(setTransactionBucket).toHaveBeenCalledWith('a', 'shopping');
  expect(setTransactionBucket).toHaveBeenCalledWith('b', 'shopping');
  expect(getSpendingRows).toHaveBeenCalledTimes(2);
});

test('setDrill toggles the drill level', () => {
  useSpendStore.getState().setDrill('wants');
  expect(useSpendStore.getState().drill).toBe('wants');
  useSpendStore.getState().setDrill(null);
  expect(useSpendStore.getState().drill).toBeNull();
});

test('load resets the drill level', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([row({ id: 'a', date: '2026-08-02' })]);
  useSpendStore.getState().setDrill('wants');
  await useSpendStore.getState().load();
  expect(useSpendStore.getState().drill).toBeNull();
});
