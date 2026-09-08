// mobile/__tests__/app/transactions.detail.test.tsx
//
// Screen-level wiring tests for TransactionDetailSheet's onSubmit/onDelete
// hookup in app/(tabs)/index.tsx (handleDetailSubmit/handleDetailDelete).
// transactions.splitwise.test.tsx already covers the Splitwise-inbox side of
// this same sheet; this file covers the create/edit/delete side for ordinary
// (Plaid or manual) transactions.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { View } = require('react-native');
  return ({ children, renderLeftActions }: { children: React.ReactNode; renderLeftActions?: () => React.ReactNode }) => (
    <View>
      {renderLeftActions?.()}
      {children}
    </View>
  );
});
jest.mock('@/lib/receiptScan', () => ({ scanReceipt: jest.fn() }));
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));
jest.mock('@/lib/db', () => ({
  getNewTransactions: jest.fn().mockResolvedValue([]),
  getMerchantBuckets: jest.fn().mockResolvedValue({}),
  getReviewTransactions: jest.fn().mockResolvedValue([]),
  getSplitwiseInbox: jest.fn().mockResolvedValue([]),
  setTransactionBucket: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
  getVacations: jest.fn().mockResolvedValue([]),
}));
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  const actual = require('@gorhom/bottom-sheet/mock');

  // Same extension as transactions.splitwise.test.tsx: the library's mock
  // drops footerComponent, which is where TransactionDetailSheet's CTA lives.
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
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []),
}));

import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import TransactionsScreen from '@/app/(tabs)/index';
import { useTransactionStore } from '@/stores/transactionStore';
import { useVacationStore } from '@/stores/vacationStore';
import { Transaction } from '@/lib/types';

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 'p1', merchant_name: 'Coffee Shop', amount: 5, currency: 'USD',
    date: '2026-07-01', status: 'new', pending: false, created_at: '2026-07-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useTransactionStore.setState({
    transactions: [], review: [], splitwiseInbox: [], isLoading: false,
    merchantBuckets: {}, splitwiseAuthExpired: false,
    // The mount effect calls load()/loadReview()/loadInbox()/refresh() itself
    // (to hydrate from the local cache); stub them all so the real actions
    // (which hit the mocked-empty @/lib/db functions) don't race and wipe out
    // whatever a test sets directly on the store below.
    load: jest.fn(),
    loadReview: jest.fn(),
    loadInbox: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
    editTransaction: jest.fn().mockResolvedValue(undefined),
    addManualTransaction: jest.fn().mockResolvedValue(undefined),
    excludeTransaction: jest.fn().mockResolvedValue(undefined),
    setBucket: jest.fn().mockResolvedValue(undefined),
    skip: jest.fn().mockResolvedValue(undefined),
  });
  useVacationStore.setState({
    activeVacation: null, vacations: [],
    load: jest.fn(),
  });
});

test('editing only the merchant name saves just that field, and bucket routes through setBucket not editTransaction', async () => {
  const editTransaction = jest.fn().mockResolvedValue(undefined);
  const setBucket = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({ transactions: [tx()], editTransaction, setBucket });

  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByText('Coffee Shop'));

  const merchantInput = await screen.findByLabelText('Merchant');
  fireEvent.changeText(merchantInput, 'My Cafe');
  fireEvent.press(screen.getByText('Save'));

  await waitFor(() => expect(editTransaction).toHaveBeenCalled());
  expect(editTransaction).toHaveBeenCalledWith('p1', { merchant_name: 'My Cafe' });
  // Bucket was never touched by the user, so it must not ride along in the
  // editTransaction patch (bucket isn't lockable) — and since it also didn't
  // change, setBucket shouldn't fire either.
  const patch = editTransaction.mock.calls[0][1];
  expect(patch).not.toHaveProperty('bucket');
  expect(patch).not.toHaveProperty('amount');
  expect(patch).not.toHaveProperty('date');
  expect(setBucket).not.toHaveBeenCalled();
});

test('pressing Add fills out the create form and calls addManualTransaction', async () => {
  const addManualTransaction = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({ addManualTransaction });

  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByLabelText('Add transaction'));

  fireEvent.changeText(await screen.findByLabelText('Merchant'), 'Taco stand');
  fireEvent.changeText(screen.getByLabelText('Amount'), '12.50');
  fireEvent.changeText(screen.getByLabelText('Date'), '2026-07-04');
  fireEvent.press(screen.getByText('Add'));

  await waitFor(() => expect(addManualTransaction).toHaveBeenCalled());
  expect(addManualTransaction).toHaveBeenCalledWith(
    expect.objectContaining({ merchant_name: 'Taco stand', amount: 12.5, date: '2026-07-04' })
  );
});

test('pressing Delete on an open row excludes the transaction, not any other status update', async () => {
  const excludeTransaction = jest.fn().mockResolvedValue(undefined);
  const skip = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({ transactions: [tx()], excludeTransaction, skip });

  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByText('Coffee Shop'));
  fireEvent.press(await screen.findByText('Delete'));

  await waitFor(() => expect(excludeTransaction).toHaveBeenCalledWith('p1'));
  expect(skip).not.toHaveBeenCalled();
});
