// mobile/__tests__/app/vacation-detail.editing.test.tsx
//
// Split-editor coverage for the vacation detail page's "Already split" recap
// rows. Modelled on history.splitwise.test.tsx: mocks @gorhom/bottom-sheet
// itself (BottomSheetModal renders its children in a plain View, regardless
// of "presented" state) rather than stubbing out the sheet components, so the
// real FriendPickerSheet and HistoryActionSheet render and their button text
// is assertable. vacation-detail.splitwise.test.tsx takes the opposite
// approach — it stubs each sheet component as a null renderer — and stays
// that way; these tests live in their own file instead of that one.
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'v1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []),
}));
jest.mock('@/stores/vacationStore', () => ({ useVacationStore: jest.fn() }));
// Unrelated to split editing — stubbed out the same way
// vacation-detail.splitwise.test.tsx does, so only the split editor's own
// sheets (FriendPickerSheet, HistoryActionSheet) render for real below.
jest.mock('@/components/AddToVacationSheet', () => ({
  AddToVacationSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/EditDatesSheet', () => ({
  EditDatesSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/GroupPickerSheet', () => ({
  GroupPickerSheet: require('react').forwardRef(() => null),
}));
const mockToastShow = jest.fn();
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: mockToastShow }) }));
// FriendPickerSheet's receipt-capture path imports expo-image-picker /
// expo-image-manipulator directly, neither of which is installed in this
// environment — same workaround history.splitwise.test.tsx uses.
jest.mock('@/lib/receiptScan', () => ({ scanReceipt: jest.fn() }));
jest.mock('@/lib/dialog', () => ({ showDialog: jest.fn() }));
jest.mock('@/lib/splitwise');
jest.mock('@/lib/db', () => ({
  getVacationPendingTransactions: jest.fn().mockResolvedValue([]),
  getVacationHistory: jest.fn().mockResolvedValue([]),
  removeTransactionFromVacation: jest.fn(),
  updateTransactionStatus: jest.fn().mockResolvedValue(undefined),
  getCachedGroups: jest.fn().mockResolvedValue([]),
  replaceCachedGroups: jest.fn().mockResolvedValue(undefined),
  getSplitDecision: jest.fn(),
  getTransactionsByIds: jest.fn(),
  deleteImportedExpense: jest.fn().mockResolvedValue(undefined),
  restoreTransaction: jest.fn().mockResolvedValue(undefined),
  deleteSplitDecision: jest.fn().mockResolvedValue(undefined),
  getNewTransactions: jest.fn().mockResolvedValue([]),
  getMerchantBuckets: jest.fn().mockResolvedValue({}),
  upsertSplitDecision: jest.fn().mockResolvedValue(undefined),
  enqueueOp: jest.fn().mockResolvedValue(undefined),
}));
// history.tsx's own @gorhom/bottom-sheet mock, reused and extended: the
// mocked BottomSheetModal always renders its children in a View — never
// gated on "presented" — so the real FriendPickerSheet / HistoryActionSheet
// content is assertable regardless of sheet-open state. FriendPickerSheet's
// submit CTA ("Add to Splitwise" / "Save changes") lives in its
// footerComponent, which the real BottomSheetModal invokes internally, so
// this mock invokes it too (history.tsx's tests never assert on that footer,
// hence the extra piece here).
jest.mock('@gorhom/bottom-sheet', () => {
  const { View, TextInput, FlatList } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      (
        { children, footerComponent: Footer }: {
          children: React.ReactNode;
          footerComponent?: (props: Record<string, never>) => React.ReactNode;
        },
        _r: unknown
      ) => (
        <View>
          {children}
          {typeof Footer === 'function' ? Footer({}) : null}
        </View>
      )
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    BottomSheetFooter: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
    BottomSheetTextInput: TextInput,
    BottomSheetFlatList: FlatList,
  };
});

import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
import VacationDetailScreen from '@/app/vacation/[id]';
import { useVacationStore } from '@/stores/vacationStore';
import { useGroupStore } from '@/stores/groupStore';
import { getVacationHistory, getSplitDecision } from '@/lib/db';
import { showDialog } from '@/lib/dialog';
import { getGroups } from '@/lib/splitwise';
import { Vacation } from '@/lib/types';

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Tokyo', start_date: null, end_date: null, status: 'active',
    splitwise_group_id: '42', splitwise_group_name: 'Tokyo Trip', splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null,
    ...over,
  };
}

// The mocked store module is a bare jest.fn(), not a real zustand store, so it
// has no setState of its own — this gives renderVacation() the same shape the
// real store's selectors expect, backed by the mutable object below.
let vacationState: Record<string, unknown>;
(useVacationStore as unknown as jest.Mock).setState = (patch: Record<string, unknown>) => {
  vacationState = { ...vacationState, ...patch };
};

function renderVacation(over: Partial<Vacation> = {}) {
  vacationState = { ...vacationState, vacations: [vac(over)], activeVacation: vac(over) };
  return render(<VacationDetailScreen />);
}

beforeEach(() => {
  jest.clearAllMocks();
  vacationState = {
    vacations: [vac()], activeVacation: vac(), load: jest.fn(),
    startVacation: jest.fn(), endVacation: jest.fn(), deleteVacation: jest.fn(), updateDates: jest.fn(),
    updateGroup: jest.fn().mockResolvedValue(undefined),
  };
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel(vacationState));
  (getVacationHistory as jest.Mock).mockResolvedValue([]);
  useGroupStore.setState({ groups: [], isLoading: false, isStale: false });
  (getGroups as jest.Mock).mockResolvedValue([]);
});

test('a split recap row opens the action sheet', async () => {
  (getVacationHistory as jest.Mock).mockResolvedValue([{
    id: 'p1', merchant_name: 'Sushi', amount: 60, currency: 'USD', date: '2026-07-01',
    status: 'split', split: { friend_names: ['Alice'], amount_each: 30 },
  }]);
  const { findByLabelText, findByText } = renderVacation();

  fireEvent.press(await findByLabelText('Edit or delete split for Sushi'));

  expect(await findByText('Edit split')).toBeTruthy();
  expect(await findByText('Delete split')).toBeTruthy();
});

test('a skipped recap row opens the split picker', async () => {
  (getVacationHistory as jest.Mock).mockResolvedValue([{
    id: 'p1', merchant_name: 'Taxi', amount: 20, currency: 'USD', date: '2026-07-01',
    status: 'skipped',
  }]);
  const { findByLabelText, findByText } = renderVacation();

  fireEvent.press(await findByLabelText('Split Taxi'));

  expect(await findByText('Add to Splitwise')).toBeTruthy();
});

test('an imported recap row is read-only', async () => {
  (getVacationHistory as jest.Mock).mockResolvedValue([{
    id: 'sw:99', merchant_name: 'Hotel', amount: 200, currency: 'USD', date: '2026-07-01',
    status: 'split', source: 'splitwise', payer_name: 'Sam',
    split: { friend_names: [], amount_each: 100 },
  }]);
  const { findByLabelText, findByText, queryByText } = renderVacation();

  fireEvent.press(await findByLabelText('Edit or delete split for Hotel'));

  expect(await findByText('Remove from SplitEasy')).toBeTruthy();
  expect(queryByText('Edit split')).toBeNull();
});

test('the vacation lists reload after a split is deleted', async () => {
  (getVacationHistory as jest.Mock).mockResolvedValue([{
    id: 'p1', merchant_name: 'Sushi', amount: 60, currency: 'USD', date: '2026-07-01',
    status: 'split', split: { friend_names: ['Alice'], amount_each: 30 },
  }]);
  (getSplitDecision as jest.Mock).mockResolvedValue({
    id: 'd1', transaction_id: 'p1', splitwise_expense_id: 'e1',
    friend_ids: ['f1'], friend_names: ['Alice'], amount_each: 30,
    created_at: '2026-07-01T00:00:00.000Z',
  });
  (showDialog as jest.Mock).mockImplementation((_t, _m, buttons) => buttons[1].onPress());
  const { findByLabelText, findByText } = renderVacation();

  fireEvent.press(await findByLabelText('Edit or delete split for Sushi'));
  fireEvent.press(await findByText('Delete split'));

  await waitFor(() => expect(getVacationHistory).toHaveBeenCalledTimes(2));
});
