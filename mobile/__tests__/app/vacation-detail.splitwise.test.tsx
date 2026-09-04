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
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: jest.fn() }) }));
jest.mock('@/lib/db', () => ({
  getVacationPendingTransactions: jest.fn().mockResolvedValue([]),
  getVacationHistory: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
  updateTransactionStatus: jest.fn(),
}));

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react-native';
import VacationDetailScreen from '@/app/vacation/[id]';
import { useVacationStore } from '@/stores/vacationStore';
import { getVacationHistory } from '@/lib/db';
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
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel({
    vacations: [vac()], activeVacation: vac(), load: jest.fn(),
    startVacation: jest.fn(), endVacation: jest.fn(), deleteVacation: jest.fn(), updateDates: jest.fn(),
  }));
  mockGetVacationHistory.mockResolvedValue([]);
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
