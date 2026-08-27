// history.tsx renders FriendPickerSheet -> lib/receiptScan, which imports
// expo-image-picker / expo-image-manipulator directly. Neither package is
// installed in this environment (same 3 pre-existing tsc errors about missing
// modules that __tests__/app/transactions.splitwise.test.tsx works around).
// Mock the whole @/lib/receiptScan module so those imports are never reached.
jest.mock('@/lib/receiptScan', () => ({ scanReceipt: jest.fn() }));
jest.mock('@/lib/db', () => ({
  getHistoryTransactions: jest.fn().mockResolvedValue([]),
  getSplitDecision: jest.fn(),
  getTransactionsByIds: jest.fn(),
  deleteImportedExpense: jest.fn().mockResolvedValue(undefined),
  setTransactionBucket: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
}));
// Mocked so a test can assert the app NEVER writes to a friend's expense.
jest.mock('@/lib/splitwise', () => ({ deleteExpense: jest.fn() }));
jest.mock('@/lib/dialog', () => ({ showDialog: jest.fn() }));
// history.tsx always mounts FriendPickerSheet (with `transaction` non-null as
// soon as any row is selected, action-sheet rows included), so its body always
// renders — the mock needs its BottomSheetTextInput/BottomSheetFlatList too,
// not just the two components HistoryActionSheet itself uses.
jest.mock('@gorhom/bottom-sheet', () => {
  const { View, TextInput, FlatList } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _r: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    BottomSheetTextInput: TextInput,
    BottomSheetFlatList: FlatList,
  };
});
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []),
}));

import React from 'react';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import HistoryScreen from '@/app/(tabs)/history';
import { getHistoryTransactions, getSplitDecision, deleteImportedExpense } from '@/lib/db';
import { deleteExpense } from '@/lib/splitwise';
import { showDialog } from '@/lib/dialog';
import { HistoryItem } from '@/lib/types';

beforeEach(() => jest.clearAllMocks());

function imported(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 'sw:555', merchant_name: 'Dinner', amount: 60, currency: 'USD',
    date: '2026-08-20', status: 'split', bucket: 'food', vacation_id: null,
    source: 'splitwise', payer_name: 'Alice Ng',
    split: { friend_names: ['Alice Ng'], amount_each: 30 },
    ...over,
  };
}

it('shows who paid and the user\'s share instead of the each-badge', async () => {
  (getHistoryTransactions as jest.Mock).mockResolvedValue([imported()]);
  render(<HistoryScreen />);
  expect(await screen.findByText('Alice Ng paid · your share $30.00')).toBeTruthy();
  expect(screen.queryByText(/each/)).toBeNull();
});

it('offers no edit action for an imported row', async () => {
  (getHistoryTransactions as jest.Mock).mockResolvedValue([imported()]);
  render(<HistoryScreen />);
  fireEvent.press(await screen.findByLabelText('Options for Dinner'));
  expect(screen.queryByLabelText(/Edit split/)).toBeNull();
});

it('removing deletes locally and never touches the Splitwise expense', async () => {
  (getHistoryTransactions as jest.Mock).mockResolvedValue([imported()]);
  // A real decision (distinct splitwise_expense_id from the imported row's
  // own id) so that if the isImported guard in handleDelete were ever
  // deleted, the code would fall into the non-imported branch, resolve a
  // real decision, and genuinely reach deleteSplit -> deleteExpense --
  // making `expect(deleteExpense).not.toHaveBeenCalled()` a real assertion
  // instead of one that passes by accident via the `if (!decision) return`
  // early guard.
  (getSplitDecision as jest.Mock).mockResolvedValue({
    id: 'dec1', transaction_id: 'sw:555', splitwise_expense_id: 'other-expense-999',
    friend_ids: ['200'], friend_names: ['Alice Ng'], amount_each: 30, created_at: '2026-08-20T00:00:00.000Z',
  });
  // Find by style rather than by the "Remove" text: if the isImported guard
  // in handleDelete were ever deleted, this same fixture falls into the
  // non-imported "Delete split?" dialog (button text "Delete", not
  // "Remove") — matching on style keeps the destructive button reachable
  // either way, so the experiment below exercises the real deleteExpense
  // call path instead of failing earlier on a button-text mismatch.
  (showDialog as jest.Mock).mockImplementation((_t, _m, buttons) => {
    buttons.find((b: { style?: string }) => b.style === 'destructive').onPress();
  });
  render(<HistoryScreen />);
  fireEvent.press(await screen.findByLabelText('Options for Dinner'));
  fireEvent.press(await screen.findByLabelText('Remove Dinner from SplitEasy'));
  await waitFor(() => expect(deleteImportedExpense).toHaveBeenCalledWith('555', true));
  expect(deleteExpense).not.toHaveBeenCalled();
});

it('a Plaid split row still offers edit', async () => {
  (getHistoryTransactions as jest.Mock).mockResolvedValue([
    imported({ id: 'tx1', source: 'plaid', payer_name: null }),
  ]);
  render(<HistoryScreen />);
  fireEvent.press(await screen.findByLabelText('Edit or delete split for Dinner'));
  expect(await screen.findByLabelText('Edit split for Dinner')).toBeTruthy();
});
