// mobile/__tests__/app/vacation-detail.splitwise.test.tsx
//
// Finding 3 (final whole-branch review, Minor): HistoryRecapRow renders any
// row carrying a `split` as "Alice Ng · $30.00 each" — the wording for an
// expense the user fronted and is owed for. Vacation auto-assignment
// guarantees imported (source='splitwise') rows land here too, so an expense
// ALICE PAID renders identically to one the user is OWED for, inverting the
// meaning for the reader. Fix mirrors history.tsx's isImported conditional.
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'v1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn() }),
  useFocusEffect: (cb: () => void) => require('react').useEffect(cb, []),
}));
jest.mock('@/stores/vacationStore', () => ({ useVacationStore: jest.fn() }));
// forwardRef so these stand in for real refs the screen attaches (pickerRef,
// addRef, datesRef) without React warning about a ref on a plain function.
jest.mock('@/components/FriendPickerSheet', () => ({
  FriendPickerSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/AddToVacationSheet', () => ({
  AddToVacationSheet: require('react').forwardRef(() => null),
}));
jest.mock('@/components/EditDatesSheet', () => ({
  EditDatesSheet: require('react').forwardRef(() => null),
}));
// Captures the last props it was rendered with, rather than rendering null
// like the sheets above — the group tests assert what the screen *passes*
// (selectedGroupId, groups) and drive selection by invoking the captured
// onSelect directly. Content assertions (list rendering, the "None" row,
// the empty state) belong to GroupPickerSheet's own test file.
let lastGroupPickerProps: {
  groups: unknown; selectedGroupId: unknown; onSelect: (group: unknown) => void;
} | null = null;
// Wired to the ref via useImperativeHandle so the failure-path test can
// assert the sheet was NOT dismissed on a rejected write.
const mockGroupDismiss = jest.fn();
jest.mock('@/components/GroupPickerSheet', () => ({
  GroupPickerSheet: require('react').forwardRef((props: typeof lastGroupPickerProps, ref: unknown) => {
    lastGroupPickerProps = props;
    require('react').useImperativeHandle(ref, () => ({ present: jest.fn(), dismiss: mockGroupDismiss }));
    return null;
  }),
}));
// A single shared spy (rather than a fresh jest.fn() per render) so a test
// can assert on toast calls that happen after the initial render.
const mockToastShow = jest.fn();
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: mockToastShow }) }));
jest.mock('@/lib/db', () => ({
  getVacationPendingTransactions: jest.fn().mockResolvedValue([]),
  getVacationHistory: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
  updateTransactionStatus: jest.fn(),
  getCachedGroups: jest.fn().mockResolvedValue([]),
  replaceCachedGroups: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/lib/splitwise');

import React from 'react';
import { render, fireEvent, screen, waitFor, act } from '@testing-library/react-native';
import VacationDetailScreen from '@/app/vacation/[id]';
import { useVacationStore } from '@/stores/vacationStore';
import { useGroupStore } from '@/stores/groupStore';
import { getVacationHistory } from '@/lib/db';
import { getGroups } from '@/lib/splitwise';
import { HistoryItem, Vacation } from '@/lib/types';

const mockGetVacationHistory = getVacationHistory as jest.Mock;

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Tokyo', start_date: null, end_date: null, status: 'active',
    splitwise_group_id: '42', splitwise_group_name: 'Tokyo Trip', splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null,
    ...over,
  };
}

// The mocked store module is a bare jest.fn(), not a real zustand store, so
// it has no setState of its own — this gives the group tests the same
// `useVacationStore.setState({ ... })` shape the brief's samples use, backed
// by the mutable object the selector mock below reads from.
let vacationState: Record<string, unknown>;
(useVacationStore as unknown as jest.Mock).setState = (patch: Record<string, unknown>) => {
  vacationState = { ...vacationState, ...patch };
};

function renderVacation(over: Partial<Vacation> = {}) {
  vacationState = { ...vacationState, vacations: [vac(over)], activeVacation: vac(over) };
  return render(<VacationDetailScreen />);
}

function historyItem(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 'sw:1', merchant_name: 'Dinner', amount: 60, currency: 'USD', date: '2026-08-20',
    status: 'split', bucket: 'travel', vacation_id: 'v1',
    source: 'splitwise', payer_name: 'Alice Ng',
    split: { friend_names: ['Alice Ng'], amount_each: 30 },
    ...over,
  } as HistoryItem;
}

beforeEach(() => {
  jest.clearAllMocks();
  lastGroupPickerProps = null;
  vacationState = {
    vacations: [vac()], activeVacation: vac(), load: jest.fn(),
    startVacation: jest.fn(), endVacation: jest.fn(), deleteVacation: jest.fn(), updateDates: jest.fn(),
    updateGroup: jest.fn().mockResolvedValue(undefined),
  };
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel(vacationState));
  mockGetVacationHistory.mockResolvedValue([]);
  useGroupStore.setState({ groups: [], isLoading: false, isStale: false });
  (getGroups as jest.Mock).mockResolvedValue([]);
});

it('renders an imported (friend-paid) expense as payer-paid, not friend-owed', async () => {
  mockGetVacationHistory.mockResolvedValue([historyItem()]);
  render(<VacationDetailScreen />);
  await waitFor(() => expect(screen.getByText('Dinner')).toBeTruthy());
  expect(screen.getByText('Alice Ng paid · your share $30.00')).toBeTruthy();
  expect(screen.queryByText('Alice Ng · $30.00 each')).toBeNull();
});

it('still renders a fronted (non-imported) split as friend-owed', async () => {
  mockGetVacationHistory.mockResolvedValue([historyItem({
    id: 't1', source: 'plaid', payer_name: null,
  })]);
  render(<VacationDetailScreen />);
  await waitFor(() => expect(screen.getByText('Dinner')).toBeTruthy());
  expect(screen.getByText('Alice Ng · $30.00 each')).toBeTruthy();
  expect(screen.queryByText(/paid · your share/)).toBeNull();
});

test('an unlinked trip offers to add a group', async () => {
  const { findByText } = renderVacation({ splitwise_group_id: null, splitwise_group_name: null });
  expect(await findByText('Add Splitwise group')).toBeTruthy();
});

test('tapping the chip presents the picker with the current groups and selection', async () => {
  const groupList = [{ id: 'g1', name: 'Roommates', member_ids: ['1', '2'], member_names: ['Alice', 'Bob'] }];
  // Seed the store directly and stub the network refresh with the same list —
  // the screen's own load-on-mount effect would otherwise race the seeded
  // value with an empty resolved fetch.
  useGroupStore.setState({ groups: groupList });
  (getGroups as jest.Mock).mockResolvedValue(groupList);
  const { findByLabelText } = renderVacation({ splitwise_group_id: null, splitwise_group_name: null });

  fireEvent.press(await findByLabelText('Add Splitwise group'));

  await waitFor(() => expect(lastGroupPickerProps?.groups).toEqual(groupList));
  expect(lastGroupPickerProps?.selectedGroupId).toBeNull();
});

test('picking a group persists it', async () => {
  const group = { id: 'g1', name: 'Roommates', member_ids: ['1', '2'], member_names: ['Alice', 'Bob'] };
  useGroupStore.setState({ groups: [group] });
  const updateGroup = jest.fn().mockResolvedValue(undefined);
  (useVacationStore as unknown as { setState: (patch: Record<string, unknown>) => void }).setState({ updateGroup });
  const { findByLabelText } = renderVacation({ splitwise_group_id: null, splitwise_group_name: null });

  fireEvent.press(await findByLabelText('Add Splitwise group'));
  await waitFor(() => expect(lastGroupPickerProps).not.toBeNull());
  await act(async () => {
    lastGroupPickerProps!.onSelect(group);
  });

  await waitFor(() => expect(updateGroup).toHaveBeenCalledWith('v1', group));
});

test('a rejected group update shows an error toast and leaves the sheet open', async () => {
  const group = { id: 'g1', name: 'Roommates', member_ids: ['1', '2'], member_names: ['Alice', 'Bob'] };
  useGroupStore.setState({ groups: [group] });
  const updateGroup = jest.fn().mockRejectedValue(new Error('network'));
  (useVacationStore as unknown as { setState: (patch: Record<string, unknown>) => void }).setState({ updateGroup });
  const { findByLabelText } = renderVacation({ splitwise_group_id: null, splitwise_group_name: null });

  fireEvent.press(await findByLabelText('Add Splitwise group'));
  await waitFor(() => expect(lastGroupPickerProps).not.toBeNull());
  await act(async () => {
    lastGroupPickerProps!.onSelect(group);
  });

  await waitFor(() =>
    expect(mockToastShow).toHaveBeenCalledWith('Could not update the group. Please try again.', 'error')
  );
  expect(mockGroupDismiss).not.toHaveBeenCalled();
});

test('a linked trip shows the group name and can change it', async () => {
  const { findByLabelText } = renderVacation({
    splitwise_group_id: 'g1', splitwise_group_name: 'Roommates',
  });
  expect(await findByLabelText('Change Splitwise group')).toBeTruthy();
});

test('an ended trip shows its group but cannot change it', async () => {
  const { findByText, queryByLabelText } = renderVacation({
    status: 'ended', splitwise_group_id: 'g1', splitwise_group_name: 'Roommates',
  });
  expect(await findByText('Roommates')).toBeTruthy();
  expect(queryByLabelText('Change Splitwise group')).toBeNull();
});
