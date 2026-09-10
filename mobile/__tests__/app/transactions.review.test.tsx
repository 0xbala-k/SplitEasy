// mobile/__tests__/app/transactions.review.test.tsx
//
// Screen-level wiring tests for the "Needs review" row's action sheet in
// app/(tabs)/index.tsx. Previously a review row jumped straight to a single
// hard-wired outcome (the split editor for amount_changed, a confirm dialog
// for reversed); this now opens ReviewActionSheet so the user chooses
// Accept / Edit / Reject. Same harness shape as transactions.detail.test.tsx
// (which already stubs the mount-effect loaders to avoid racing state this
// file sets directly on the store).
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
  getSplitDecision: jest.fn(),
  getTransactionsByIds: jest.fn(),
}));
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []),
}));
jest.mock('@/lib/dialog', () => ({ showDialog: jest.fn() }));

import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import TransactionsScreen from '@/app/(tabs)/index';
import { useTransactionStore } from '@/stores/transactionStore';
import { useVacationStore } from '@/stores/vacationStore';
import { getSplitDecision } from '@/lib/db';
import { showDialog } from '@/lib/dialog';
import { ReviewItem } from '@/lib/types';
import { ToastProvider } from '@/components/ToastProvider';

function reviewItem(over: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'p1', merchant_name: 'Trader Joe\'s', amount: 47.85, amount_changed_from: 42.1,
    currency: 'USD', date: '2026-07-01', reason: 'amount_changed',
    split: { friend_names: ['Alice'], amount_each: 23.93 },
    splitwise_expense_id: 'e1', expense_id: 'e1',
    transaction_ids: ['p1'], member_transaction_ids: ['p1'],
    ...over,
  };
}

// Confirms whatever dialog is showing by pressing its destructive button —
// mirrors the pattern used for history.tsx's identical "Delete split?" /
// "Remove from SplitEasy?" confirms.
function confirmDialog() {
  const buttons = (showDialog as jest.Mock).mock.calls.at(-1)![2];
  buttons.find((b: { style?: string }) => b.style === 'destructive').onPress();
}

beforeEach(() => {
  jest.clearAllMocks();
  useTransactionStore.setState({
    transactions: [], review: [], splitwiseInbox: [], isLoading: false,
    merchantBuckets: {},
    // The mount effect calls load()/loadReview()/loadInbox()/refresh() itself
    // (to hydrate from the local cache); stub them all so the real actions
    // (which hit the mocked-empty @/lib/db functions) don't race and wipe out
    // the `review` array a test sets directly on the store below.
    load: jest.fn(),
    loadReview: jest.fn(),
    loadInbox: jest.fn(),
    refresh: jest.fn().mockResolvedValue(undefined),
    acceptReview: jest.fn().mockResolvedValue(undefined),
    rejectReview: jest.fn().mockResolvedValue(undefined),
  });
  useVacationStore.setState({ activeVacation: null, vacations: [], load: jest.fn() });
});

test('tapping an amount-changed review row opens the action sheet instead of acting immediately', async () => {
  useTransactionStore.setState({ review: [reviewItem()] });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review amount change for Trader Joe\'s'));

  expect(await screen.findByText('Update Splitwise to $47.85')).toBeTruthy();
  expect(await screen.findByText('Keep $42.10')).toBeTruthy();
});

test('accepting an amount change calls acceptReview and closes the sheet', async () => {
  const acceptReview = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({ review: [reviewItem()], acceptReview });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review amount change for Trader Joe\'s'));
  fireEvent.press(await screen.findByText('Update Splitwise to $47.85'));

  await waitFor(() => expect(acceptReview).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'p1', reason: 'amount_changed' })
  ));
});

test('rejecting an amount change calls rejectReview', async () => {
  const rejectReview = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({ review: [reviewItem()], rejectReview });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review amount change for Trader Joe\'s'));
  fireEvent.press(await screen.findByText('Keep $42.10'));

  await waitFor(() => expect(rejectReview).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'p1', reason: 'amount_changed' })
  ));
});

test('a failed accept whose split has not reached Splitwise yet shows a dedicated toast', async () => {
  jest.useFakeTimers();
  try {
    const acceptReview = jest.fn().mockRejectedValue(new Error('SPLIT_NOT_PUSHED'));
    useTransactionStore.setState({ review: [reviewItem()], acceptReview });
    render(<ToastProvider><TransactionsScreen /></ToastProvider>);

    fireEvent.press(await screen.findByLabelText('Review amount change for Trader Joe\'s'));
    fireEvent.press(await screen.findByText('Update Splitwise to $47.85'));

    expect(await screen.findByText(
      "That split hasn't reached Splitwise yet. Try again in a moment."
    )).toBeTruthy();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

test('tapping a reversed review row opens the action sheet with delete/keep options', async () => {
  useTransactionStore.setState({
    review: [reviewItem({ reason: 'reversed', amount_changed_from: null })],
  });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review reversed charge for Trader Joe\'s'));

  expect(await screen.findByText('Delete expense')).toBeTruthy();
  expect(await screen.findByText('Keep the split')).toBeTruthy();
});

test('tapping Delete expense on a reversed row confirms before deleting, and does not call acceptReview until confirmed', async () => {
  const acceptReview = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({
    review: [reviewItem({ reason: 'reversed', amount_changed_from: null })],
    acceptReview,
  });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review reversed charge for Trader Joe\'s'));
  fireEvent.press(await screen.findByText('Delete expense'));

  expect(showDialog).toHaveBeenCalledWith(
    'Charge reversed',
    expect.stringContaining('never posted'),
    expect.any(Array)
  );
  expect(acceptReview).not.toHaveBeenCalled();
});

test('confirming the reversed-charge dialog calls acceptReview', async () => {
  const acceptReview = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({
    review: [reviewItem({ reason: 'reversed', amount_changed_from: null })],
    acceptReview,
  });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review reversed charge for Trader Joe\'s'));
  fireEvent.press(await screen.findByText('Delete expense'));
  confirmDialog();

  await waitFor(() => expect(acceptReview).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'p1', reason: 'reversed' })
  ));
});

test('rejecting a reversed review calls rejectReview', async () => {
  const rejectReview = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({
    review: [reviewItem({ reason: 'reversed', amount_changed_from: null })],
    rejectReview,
  });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review reversed charge for Trader Joe\'s'));
  fireEvent.press(await screen.findByText('Keep the split'));

  await waitFor(() => expect(rejectReview).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'p1', reason: 'reversed' })
  ));
});

test('choosing Edit split dismisses the sheet and opens the split editor', async () => {
  (getSplitDecision as jest.Mock).mockResolvedValue({
    id: 'dec1', transaction_id: 'p1', splitwise_expense_id: 'e1',
    friend_ids: ['200'], friend_names: ['Alice'], amount_each: 23.93,
    created_at: '2026-07-01T00:00:00.000Z',
  });
  useTransactionStore.setState({ review: [reviewItem()] });
  render(<TransactionsScreen />);

  fireEvent.press(await screen.findByLabelText('Review amount change for Trader Joe\'s'));
  fireEvent.press(await screen.findByText('Edit split'));

  await waitFor(() => expect(getSplitDecision).toHaveBeenCalledWith('p1'));
});

test('choosing Edit split on a not-yet-pushed split shows a toast instead of opening the editor', async () => {
  jest.useFakeTimers();
  try {
    useTransactionStore.setState({
      review: [reviewItem({ splitwise_expense_id: null, expense_id: 'p1' })],
    });
    render(<ToastProvider><TransactionsScreen /></ToastProvider>);

    fireEvent.press(await screen.findByLabelText('Review amount change for Trader Joe\'s'));
    fireEvent.press(await screen.findByText('Edit split'));

    expect(await screen.findByText(
      "That split hasn't reached Splitwise yet. Try again in a moment."
    )).toBeTruthy();
    expect(getSplitDecision).not.toHaveBeenCalled();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
