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
    BottomSheetFooter: ({ children }: { children: React.ReactNode }) => children,
  };
});
// Mutable so the footer-clearance tests below can simulate a device with a
// home indicator; every other test in this file relies on the zero default.
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

import { StyleSheet } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { TransactionDetailSheet } from '@/components/TransactionDetailSheet';
import { Transaction } from '@/lib/types';
import { Spacing } from '@/lib/theme';

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
});

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

test('an invalid date disables submit even with a valid merchant and amount', () => {
  const onSubmit = jest.fn();
  const { getByLabelText, getByText } = render(
    <TransactionDetailSheet mode="create" bucket="other" openToken={1} onSubmit={onSubmit} />
  );
  fireEvent.changeText(getByLabelText('Merchant'), 'Taco stand');
  fireEvent.changeText(getByLabelText('Amount'), '12.50');

  for (const bad of ['2026-13-45', 'not-a-date']) {
    fireEvent.changeText(getByLabelText('Date'), bad);
    fireEvent.press(getByText('Add'));
  }
  expect(onSubmit).not.toHaveBeenCalled();

  fireEvent.changeText(getByLabelText('Date'), '2026-07-01');
  fireEvent.press(getByText('Add'));
  expect(onSubmit).toHaveBeenCalled();
});

test('edit mode allows a negative amount (refund/credit) without any edits', () => {
  const negativeTx: Transaction = { ...tx, amount: -25 };
  const onSubmit = jest.fn();
  const { getByText } = render(
    <TransactionDetailSheet mode="edit" transaction={negativeTx} bucket="food"
      openToken={1} onSubmit={onSubmit} onDelete={jest.fn()} />
  );
  fireEvent.press(getByText('Save'));
  expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ merchant_name: 'RAW NAME', amount: -25, date: '2026-07-01' })
  );
});

describe('inbox mode vacation row', () => {
  const item = {
    expense_id: 'e1', description: 'Dinner', cost: 60, currency: 'USD',
    date: '2026-07-01', payer_name: 'Sam', my_share: 30,
    participants: [{ id: 'u2', name: 'Sam' }], group_id: null,
    state: 'pending' as const, fetched_at: '2026-07-01T10:00:00Z',
  };

  test('shows the chosen vacation and reports it back on accept', () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = render(
      <TransactionDetailSheet mode="inbox" bucket="travel" openToken={1} onSubmit={onSubmit}
        inboxItem={item} vacationId="v2" vacationName="Banff" />
    );
    expect(getByLabelText('Vacation')).toBeTruthy();
    expect(getByText('Banff')).toBeTruthy();

    fireEvent.press(getByText('Accept'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ vacation_id: 'v2' }));
  });

  test('reports a null vacation when none is chosen', () => {
    const onSubmit = jest.fn();
    const { getByLabelText, getByText } = render(
      <TransactionDetailSheet mode="inbox" bucket="food" openToken={1} onSubmit={onSubmit}
        inboxItem={item} vacationId={null} vacationName={null} />
    );
    expect(getByLabelText('Vacation')).toBeTruthy();
    expect(getByText('None')).toBeTruthy();

    fireEvent.press(getByText('Accept'));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ vacation_id: null }));
  });

  test('tapping the row asks the host to open the picker', () => {
    const onVacationPress = jest.fn();
    const { getByLabelText } = render(
      <TransactionDetailSheet mode="inbox" bucket="food" openToken={1} onSubmit={jest.fn()}
        inboxItem={item} vacationId={null} vacationName={null} onVacationPress={onVacationPress} />
    );
    fireEvent.press(getByLabelText('Vacation'));
    expect(onVacationPress).toHaveBeenCalled();
  });

  test('a Plaid row being edited gets no vacation row', () => {
    // Moving an already-committed transaction between trips is a different
    // feature with different rules; this row is accept-time only.
    const { queryByLabelText } = render(
      <TransactionDetailSheet mode="edit" transaction={tx} bucket="food"
        openToken={1} onSubmit={jest.fn()} onDelete={jest.fn()} />
    );
    expect(queryByLabelText('Vacation')).toBeNull();
  });
});

describe('footer clearance', () => {
  // Regression: the scrollable used to reserve a hardcoded, too-small gap
  // (and none of the safe-area inset) below its content, so the last rows —
  // the Bucket/Vacation rows in inbox mode, Delete in edit mode — sat under
  // the pinned footer, invisible and untappable. The reserved room must track
  // the footer's real measured height plus the safe-area inset it's lifted by.
  test('reserves the measured footer height plus the safe-area inset in the scrollable padding', () => {
    mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
    const { getByTestId } = render(
      <TransactionDetailSheet mode="edit" transaction={tx} bucket="food"
        openToken={1} onSubmit={jest.fn()} onDelete={jest.fn()} />
    );
    fireEvent(getByTestId('detail-footer'), 'layout', {
      nativeEvent: { layout: { height: 100, width: 320, x: 0, y: 0 } },
    });
    const scrollStyle = StyleSheet.flatten(getByTestId('detail-scroll').props.contentContainerStyle);
    expect(scrollStyle.paddingBottom).toBe(100 + 34 + Spacing.lg);
  });

  test('a taller footer measurement grows the reserved padding to match', () => {
    const { getByTestId } = render(
      <TransactionDetailSheet mode="inbox" bucket="food" openToken={1} onSubmit={jest.fn()}
        inboxItem={{
          expense_id: 'e1', description: 'Dinner', cost: 60, currency: 'USD',
          date: '2026-07-01', payer_name: 'Sam', my_share: 30,
          participants: [{ id: 'u2', name: 'Sam' }], group_id: null,
          state: 'pending', fetched_at: '2026-07-01T10:00:00Z',
        }} />
    );
    fireEvent(getByTestId('detail-footer'), 'layout', {
      nativeEvent: { layout: { height: 60, width: 320, x: 0, y: 0 } },
    });
    const before = StyleSheet.flatten(getByTestId('detail-scroll').props.contentContainerStyle).paddingBottom;

    fireEvent(getByTestId('detail-footer'), 'layout', {
      nativeEvent: { layout: { height: 120, width: 320, x: 0, y: 0 } },
    });
    const after = StyleSheet.flatten(getByTestId('detail-scroll').props.contentContainerStyle).paddingBottom;

    expect(after).toBe(before + 60);
  });
});
