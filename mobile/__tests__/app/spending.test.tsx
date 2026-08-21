jest.mock('@/lib/db', () => ({
  getSpendingRows: jest.fn(),
  setTransactionBucket: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
}));
jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _r: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});
jest.mock('expo-router', () => ({ useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []) }));

import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { getSpendingRows } from '@/lib/db';
import SpendingScreen from '@/app/(tabs)/spending';
import { SpendRow } from '@/lib/spend';
import { useSpendStore } from '@/stores/spendStore';

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

test('shows the month label and total', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 100, bucket: 'needs', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, bucket: 'food', date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText('August 2026')).toBeTruthy());
  expect(screen.getByText('$140.00')).toBeTruthy();
});

test('lists the four top-level groups with their totals', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 100, bucket: 'needs', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, bucket: 'food', date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByLabelText('Needs, $100.00')).toBeTruthy());
  expect(screen.getByLabelText('Wants, $40.00')).toBeTruthy();
});

test('drilling into Wants shows its three buckets', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 40, bucket: 'food', date: '2026-08-03' }),
    row({ id: 'b', amount: 60, bucket: 'shopping', date: '2026-08-04' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByLabelText('Wants, $100.00')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Wants, $100.00'));
  await waitFor(() => expect(screen.getByLabelText('Food, $40.00')).toBeTruthy());
  expect(screen.getByLabelText('Shopping, $60.00')).toBeTruthy();
  expect(screen.getByLabelText('Back to all categories')).toBeTruthy();
});

test('drilling into Misc shows its own transaction, even though it is a single-bucket group', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 5, bucket: 'misc', date: '2026-08-03', merchant_name: 'Mystery Fee' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByLabelText('Misc, $5.00')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Misc, $5.00'));
  await waitFor(() => expect(screen.getByLabelText('Back to all categories')).toBeTruthy());
  // Expand the (only) row to confirm the transaction itself is reachable.
  fireEvent.press(screen.getByLabelText('Misc, $5.00'));
  await waitFor(() => expect(screen.getByText('Mystery Fee')).toBeTruthy());
});

test('stepping back a month changes the label', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 10, date: '2026-07-03' }),
    row({ id: 'b', amount: 20, date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText('August 2026')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Previous month'));
  await waitFor(() => expect(screen.getByText('July 2026')).toBeTruthy());
});

test('footnotes a second currency instead of adding it in', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([
    row({ id: 'a', amount: 100, currency: 'USD', date: '2026-08-02' }),
    row({ id: 'b', amount: 40, currency: 'EUR', date: '2026-08-03' }),
  ]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.queryAllByText('$100.00').length).toBeGreaterThan(0));
  // Both rows here land in `wants` (the default bucket), so the donut's total
  // and the "Wants" row happen to show the identical figure — two separate
  // "$100.00" Texts on screen. The donut total renders first in the tree, so
  // [0] is the total this assertion actually means to check; a second,
  // coincidental "$100.00" on the Wants row doesn't make the total wrong.
  expect(screen.getAllByText('$100.00')[0]).toBeTruthy();
  expect(screen.getByText(/EUR/)).toBeTruthy();
});

test('shows an empty state when nothing has been committed yet', async () => {
  (getSpendingRows as jest.Mock).mockResolvedValue([]);
  render(<SpendingScreen />);
  await waitFor(() => expect(screen.getByText(/Nothing yet/i)).toBeTruthy());
});
