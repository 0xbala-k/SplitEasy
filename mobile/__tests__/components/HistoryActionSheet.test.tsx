// mobile/__tests__/components/HistoryActionSheet.test.tsx
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));

import { render, fireEvent, screen } from '@testing-library/react-native';
import { HistoryActionSheet } from '@/components/HistoryActionSheet';
import { TransactionWithSplit } from '@/lib/types';

const tx: TransactionWithSplit = {
  id: 'tx1',
  merchant_name: 'Amazon',
  amount: 29.99,
  currency: 'USD',
  date: '2026-06-10',
  status: 'split',
  pending: false,
  created_at: '2026-06-10T10:00:00Z',
  split: { friend_names: ['Sam'], amount_each: 15 },
};

test('renders nothing when transaction is null', () => {
  const { toJSON } = render(
    <HistoryActionSheet transaction={null} onEdit={jest.fn()} onDelete={jest.fn()} />
  );
  expect(toJSON()).toBeNull();
});

test('shows merchant name and amount', () => {
  render(<HistoryActionSheet transaction={tx} onEdit={jest.fn()} onDelete={jest.fn()} />);
  expect(screen.getByText('Amazon')).toBeTruthy();
  expect(screen.getByText('$29.99')).toBeTruthy();
});

test('fires onEdit when Edit split is pressed', () => {
  const onEdit = jest.fn();
  render(<HistoryActionSheet transaction={tx} onEdit={onEdit} onDelete={jest.fn()} />);
  fireEvent.press(screen.getByLabelText('Edit split for Amazon'));
  expect(onEdit).toHaveBeenCalledTimes(1);
});

test('fires onDelete when Delete split is pressed', () => {
  const onDelete = jest.fn();
  render(<HistoryActionSheet transaction={tx} onEdit={jest.fn()} onDelete={onDelete} />);
  fireEvent.press(screen.getByLabelText('Delete split for Amazon'));
  expect(onDelete).toHaveBeenCalledTimes(1);
});
