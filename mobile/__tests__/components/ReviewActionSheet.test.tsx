// mobile/__tests__/components/ReviewActionSheet.test.tsx
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));

import { render, fireEvent } from '@testing-library/react-native';
import { ReviewActionSheet } from '@/components/ReviewActionSheet';
import { ReviewItem } from '@/lib/types';

function item(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'p1', merchant_name: 'Trader Joe\'s', amount: 47.85, amount_changed_from: 42.1,
    currency: 'USD', date: '2026-07-01', reason: 'amount_changed',
    split: { friend_names: ['Alice'], amount_each: 23.93 },
    splitwise_expense_id: 'e1', expense_id: 'e1', transaction_ids: ['p1'],
    ...over,
  };
}

test('renders nothing without an item', () => {
  const { toJSON } = render(
    <ReviewActionSheet item={null} onAccept={jest.fn()} onEdit={jest.fn()} onReject={jest.fn()} />
  );
  expect(toJSON()).toBeNull();
});

test('an amount change offers update, edit, and keep-the-old-amount', () => {
  const { getByText } = render(
    <ReviewActionSheet item={item()} onAccept={jest.fn()} onEdit={jest.fn()} onReject={jest.fn()} />
  );
  expect(getByText('Update Splitwise to $47.85')).toBeTruthy();
  expect(getByText('Edit split')).toBeTruthy();
  expect(getByText('Keep $42.10')).toBeTruthy();
});

test('a reversal offers delete, edit, and keep-the-split', () => {
  const { getByText } = render(
    <ReviewActionSheet
      item={item({ reason: 'reversed', amount_changed_from: null })}
      onAccept={jest.fn()} onEdit={jest.fn()} onReject={jest.fn()}
    />
  );
  expect(getByText('Delete expense')).toBeTruthy();
  expect(getByText('Edit split')).toBeTruthy();
  expect(getByText('Keep the split')).toBeTruthy();
});

test('each action fires its own callback', () => {
  const onAccept = jest.fn();
  const onEdit = jest.fn();
  const onReject = jest.fn();
  const { getByText } = render(
    <ReviewActionSheet item={item()} onAccept={onAccept} onEdit={onEdit} onReject={onReject} />
  );

  fireEvent.press(getByText('Update Splitwise to $47.85'));
  fireEvent.press(getByText('Edit split'));
  fireEvent.press(getByText('Keep $42.10'));

  expect(onAccept).toHaveBeenCalledTimes(1);
  expect(onEdit).toHaveBeenCalledTimes(1);
  expect(onReject).toHaveBeenCalledTimes(1);
});

test('shows the amount transition in the header', () => {
  const { getByText } = render(
    <ReviewActionSheet item={item()} onAccept={jest.fn()} onEdit={jest.fn()} onReject={jest.fn()} />
  );
  expect(getByText('$42.10 → $47.85')).toBeTruthy();
});
