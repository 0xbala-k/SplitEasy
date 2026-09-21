// mobile/__tests__/app/vacation-detail.row-actions.test.tsx
//
// The vacation detail page's "To split" rows: tapping one opens an action
// sheet offering "Move to Transactions" (eject back to the main Transactions
// tab) and "Skip". vacation-detail.editing.test.tsx covers the *already
// split* recap rows below that list; these tests stay in their own file and
// borrow that file's mocking strategy — @gorhom/bottom-sheet itself is
// mocked so BottomSheetModal renders its children unconditionally, making
// the real sheet's action labels assertable regardless of presented state.
// Same stand-in every suite that renders TransactionRow uses: the real
// ReanimatedSwipeable reads a shared value during render and warns.
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const { View } = require('react-native');
  return ({ children, renderLeftActions }: { children: React.ReactNode; renderLeftActions?: () => React.ReactNode }) => (
    <View>
      {renderLeftActions?.()}
      {children}
    </View>
  );
});
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'v1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []),
}));
jest.mock('@/stores/vacationStore', () => ({ useVacationStore: jest.fn() }));
// Every sheet except the one under test renders null: the bottom-sheet mock
// below is unconditional, so leaving them real would put their content on
// screen at all times and collide with these queries.
jest.mock('@/components/AddToVacationSheet', () => ({
  AddToVacationSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/EditDatesSheet', () => ({
  EditDatesSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/GroupPickerSheet', () => ({
  GroupPickerSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/FriendPickerSheet', () => ({
  FriendPickerSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/HistoryActionSheet', () => ({
  HistoryActionSheet: require('react').forwardRef(() => null),
}));
const mockToastShow = jest.fn();
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: mockToastShow }) }));
jest.mock('@/lib/dialog', () => ({ showDialog: jest.fn() }));
jest.mock('@/lib/splitwise');
jest.mock('@/lib/db', () => ({
  getVacationPendingTransactions: jest.fn().mockResolvedValue([]),
  getVacationHistory: jest.fn().mockResolvedValue([]),
  removeTransactionFromVacation: jest.fn().mockResolvedValue(undefined),
  updateTransactionStatus: jest.fn().mockResolvedValue(undefined),
  getCachedGroups: jest.fn().mockResolvedValue([]),
  replaceCachedGroups: jest.fn().mockResolvedValue(undefined),
  getSplitDecision: jest.fn(),
  getTransactionsByIds: jest.fn(),
  deleteImportedExpense: jest.fn().mockResolvedValue(undefined),
  restoreTransaction: jest.fn().mockResolvedValue(undefined),
  deleteSplitDecision: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@gorhom/bottom-sheet', () => {
  const { View, TextInput, FlatList } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _r: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    BottomSheetFooter: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    BottomSheetTextInput: TextInput,
    BottomSheetFlatList: FlatList,
  };
});

import React from 'react';
import { render, fireEvent, waitFor, within } from '@testing-library/react-native';
import VacationDetailScreen from '@/app/vacation/[id]';
import { useVacationStore } from '@/stores/vacationStore';
import { useGroupStore } from '@/stores/groupStore';
import {
  getVacationPendingTransactions, removeTransactionFromVacation, updateTransactionStatus,
} from '@/lib/db';
import { getGroups } from '@/lib/splitwise';
import { Transaction, Vacation } from '@/lib/types';

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Tokyo', start_date: null, end_date: null, status: 'active',
    splitwise_group_id: '42', splitwise_group_name: 'Tokyo Trip', splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null,
    ...over,
  };
}

function tx(over: Partial<Transaction> = {}): Transaction {
  return {
    id: 't1', merchant_name: 'Shinkansen', amount: 132.5, currency: 'USD',
    date: '2026-06-10', status: 'new', pending: false,
    created_at: '2026-06-10T00:00:00.000Z', vacation_id: 'v1',
    ...over,
  };
}

let vacationState: Record<string, unknown>;
(useVacationStore as unknown as jest.Mock).setState = (patch: Record<string, unknown>) => {
  vacationState = { ...vacationState, ...patch };
};

function renderVacation() {
  return render(<VacationDetailScreen />);
}

beforeEach(() => {
  jest.clearAllMocks();
  vacationState = {
    vacations: [vac()], activeVacation: vac(), load: jest.fn(),
    startVacation: jest.fn(), endVacation: jest.fn(), deleteVacation: jest.fn(),
    updateDates: jest.fn(), updateGroup: jest.fn().mockResolvedValue(undefined),
  };
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel(vacationState));
  (getVacationPendingTransactions as jest.Mock).mockResolvedValue([tx()]);
  useGroupStore.setState({ groups: [], isLoading: false, isStale: false });
  (getGroups as jest.Mock).mockResolvedValue([]);
});

// Every query below reaches the sheet's actions through its testID. The row
// itself carries an inline skip button labelled "Skip {merchant}" — identical
// to the sheet's — so a bare label query would match row chrome and pass
// whether or not the sheet ever opened.
async function openSheetFor(merchant: string, screen: ReturnType<typeof renderVacation>) {
  fireEvent.press(await screen.findByText(merchant));
  return within(await screen.findByTestId('vacation-tx-action-sheet'));
}

test('no action sheet is on screen until a row is tapped', async () => {
  const screen = renderVacation();
  await screen.findByText('Shinkansen');

  expect(screen.queryByTestId('vacation-tx-action-sheet')).toBeNull();
});

test('tapping a to-split row opens the action sheet', async () => {
  const screen = renderVacation();

  const sheet = await openSheetFor('Shinkansen', screen);

  expect(sheet.getByText('Move to Transactions')).toBeTruthy();
  expect(sheet.getByText('Skip')).toBeTruthy();
});

test('Move to Transactions ejects that transaction from the vacation', async () => {
  const screen = renderVacation();
  const sheet = await openSheetFor('Shinkansen', screen);

  fireEvent.press(sheet.getByText('Move to Transactions'));

  await waitFor(() => expect(removeTransactionFromVacation).toHaveBeenCalledWith('t1'));
});

test('the to-split list reloads after a transaction is moved out', async () => {
  const screen = renderVacation();
  const sheet = await openSheetFor('Shinkansen', screen);

  fireEvent.press(sheet.getByText('Move to Transactions'));

  await waitFor(() => expect(getVacationPendingTransactions).toHaveBeenCalledTimes(2));
});

test('Skip from the action sheet commits the transaction as skipped', async () => {
  const screen = renderVacation();
  const sheet = await openSheetFor('Shinkansen', screen);

  fireEvent.press(sheet.getByText('Skip'));

  await waitFor(() => expect(updateTransactionStatus).toHaveBeenCalledWith('t1', 'skipped'));
  expect(removeTransactionFromVacation).not.toHaveBeenCalled();
});

test('a failed move surfaces an error toast', async () => {
  (removeTransactionFromVacation as jest.Mock).mockRejectedValue(new Error('offline'));
  const screen = renderVacation();
  const sheet = await openSheetFor('Shinkansen', screen);

  fireEvent.press(sheet.getByText('Move to Transactions'));

  await waitFor(() =>
    expect(mockToastShow).toHaveBeenCalledWith(
      'Could not remove transaction. Please try again.', 'error'
    )
  );
});

test('tapping a row in select mode toggles selection instead of opening the sheet', async () => {
  const screen = renderVacation();
  fireEvent(await screen.findByText('Shinkansen'), 'longPress');

  fireEvent.press(screen.getByLabelText('Select Shinkansen'));

  expect(screen.queryByTestId('vacation-tx-action-sheet')).toBeNull();
});
