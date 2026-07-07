// mobile/__tests__/components/TransactionRow.test.tsx
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { View } = require('react-native');
  return ({ children }: { children: React.ReactNode }) => <View>{children}</View>;
});

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { TransactionRow } from '@/components/TransactionRow';
import { Transaction } from '@/lib/types';

const tx: Transaction = {
  id: 'tx1',
  merchant_name: 'Amazon',
  amount: 20,
  currency: 'USD',
  date: '2026-07-01',
  status: 'new',
  pending: false,
  created_at: '2026-07-01T00:00:00Z',
};

test('long-press fires onLongPress in normal mode', () => {
  const onLongPress = jest.fn();
  render(<TransactionRow transaction={tx} onSkip={jest.fn()} onSplit={jest.fn()} onLongPress={onLongPress} />);
  fireEvent(screen.getByLabelText('Split Amazon'), 'longPress');
  expect(onLongPress).toHaveBeenCalled();
});

test('in select mode with selected=true, the checkbox reflects a checked state', () => {
  render(
    <TransactionRow
      transaction={tx}
      onSkip={jest.fn()}
      onSplit={jest.fn()}
      selectMode
      selected
      onToggleSelect={jest.fn()}
    />
  );
  const row = screen.getByLabelText('Select Amazon');
  expect(row.props.accessibilityState).toEqual({ checked: true });
});

test('in select mode, tapping the row toggles selection and hides split/skip actions', () => {
  const onToggleSelect = jest.fn();
  render(
    <TransactionRow
      transaction={tx}
      onSkip={jest.fn()}
      onSplit={jest.fn()}
      selectMode
      selected={false}
      onToggleSelect={onToggleSelect}
    />
  );
  expect(screen.queryByLabelText('Split Amazon')).toBeNull();
  fireEvent.press(screen.getByLabelText('Select Amazon'));
  expect(onToggleSelect).toHaveBeenCalled();
});
