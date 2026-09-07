// mobile/__tests__/components/TransactionDetailSheet.test.tsx
// The library's own mock renders `children` only and drops `footerComponent`,
// so the pinned submit CTA (Add/Save/Accept) would never appear in the tree.
// Extend it, as FriendPickerSheet/EditDatesSheet/AddToVacationSheet's suites do.
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  const actual = require('@gorhom/bottom-sheet/mock');

  class BottomSheetModal extends actual.BottomSheetModal {
    render() {
      const content = super.render();
      const Footer = this.props.footerComponent;
      if (!Footer) return content;
      return React.createElement(
        React.Fragment,
        null,
        content,
        React.createElement(Footer, { animatedFooterPosition: { value: 0 } })
      );
    }
  }

  return {
    ...actual,
    BottomSheetModal,
  };
});

import { render, fireEvent } from '@testing-library/react-native';
import { TransactionDetailSheet } from '@/components/TransactionDetailSheet';
import { Transaction } from '@/lib/types';

const tx: Transaction = {
  id: 'p1', merchant_name: 'RAW NAME', amount: 20, currency: 'USD',
  date: '2026-07-01', status: 'new', pending: false, created_at: '2026-07-01T00:00:00Z',
};

test('edit mode pre-fills the row values', () => {
  const { getByLabelText } = render(
    <TransactionDetailSheet mode="edit" transaction={tx} bucket="food"
      openToken={1} onSubmit={jest.fn()} onDelete={jest.fn()} />
  );
  expect(getByLabelText('Merchant').props.value).toBe('RAW NAME');
  expect(getByLabelText('Amount').props.value).toBe('20.00');
});

test('edit mode submits only the fields the user changed', () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText } = render(
    <TransactionDetailSheet mode="edit" transaction={tx} bucket="food"
      openToken={1} onSubmit={onSubmit} onDelete={jest.fn()} />
  );
  fireEvent.changeText(getByLabelText('Merchant'), 'My Cafe');
  fireEvent.press(getByText('Save'));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ merchant_name: 'My Cafe', amount: 20, date: '2026-07-01' })
  );
});

test('create mode starts blank and disables submit until valid', () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText } = render(
    <TransactionDetailSheet mode="create" bucket="other"
      openToken={1} onSubmit={onSubmit} />
  );
  expect(getByLabelText('Merchant').props.value).toBe('');
  fireEvent.press(getByText('Add'));
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.changeText(getByLabelText('Merchant'), 'Taco stand');
  fireEvent.changeText(getByLabelText('Amount'), '12.50');
  fireEvent.press(getByText('Add'));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ merchant_name: 'Taco stand', amount: 12.5 })
  );
});

test('create mode rejects a non-positive or unparseable amount', () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText } = render(
    <TransactionDetailSheet mode="create" bucket="other" openToken={1} onSubmit={onSubmit} />
  );
  fireEvent.changeText(getByLabelText('Merchant'), 'Taco stand');
  for (const bad of ['0', '-5', 'abc', '']) {
    fireEvent.changeText(getByLabelText('Amount'), bad);
    fireEvent.press(getByText('Add'));
  }
  expect(onSubmit).not.toHaveBeenCalled();
});

test('inbox mode shows both cost and share fields', () => {
  const { getByLabelText } = render(
    <TransactionDetailSheet mode="inbox" bucket="food" openToken={1} onSubmit={jest.fn()}
      inboxItem={{
        expense_id: 'e1', description: 'Dinner', cost: 60, currency: 'USD',
        date: '2026-07-01', payer_name: 'Sam', my_share: 30,
        participants: [{ id: 'u2', name: 'Sam' }], group_id: null,
        state: 'pending', fetched_at: '2026-07-01T10:00:00Z',
      }} />
  );
  expect(getByLabelText('Amount').props.value).toBe('60.00');
  expect(getByLabelText('Your share').props.value).toBe('30.00');
});

test('a locked bucket renders without a press handler', () => {
  const { getByLabelText } = render(
    <TransactionDetailSheet mode="edit" transaction={tx} bucket="travel" bucketLocked
      openToken={1} onSubmit={jest.fn()} onDelete={jest.fn()} />
  );
  expect(getByLabelText('Bucket').props.accessibilityState.disabled).toBe(true);
});

test('delete is absent in create mode', () => {
  const { queryByText } = render(
    <TransactionDetailSheet mode="create" bucket="other" openToken={1} onSubmit={jest.fn()} />
  );
  expect(queryByText('Delete')).toBeNull();
});
