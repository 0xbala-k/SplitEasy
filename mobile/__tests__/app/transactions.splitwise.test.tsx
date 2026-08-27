// index.tsx pulls in FriendPickerSheet -> lib/receiptScan, which imports
// expo-image-picker / expo-image-manipulator directly. Neither package is
// installed in this environment (see the 3 pre-existing tsc errors about
// missing modules), so mocking them by name still fails to resolve. Mock the
// whole @/lib/receiptScan module instead, same as
// __tests__/components/FriendPickerSheet.test.tsx does, so those imports are
// never reached.
jest.mock('@/lib/receiptScan', () => ({ scanReceipt: jest.fn() }));
// index.tsx also renders VacationBanner (-> vacationStore.load() -> getVacations)
// and calls NetInfo.addEventListener in its mount effect; neither is mocked by
// any existing test since nothing has rendered this screen before. Stub both
// so mount doesn't throw or hit a real native module.
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => () => {}) },
}));
jest.mock('@/lib/db', () => ({
  getNewTransactions: jest.fn().mockResolvedValue([]),
  getMerchantBuckets: jest.fn().mockResolvedValue({}),
  getReviewTransactions: jest.fn().mockResolvedValue([]),
  getSplitwiseInbox: jest.fn(),
  setTransactionBucket: jest.fn(),
  removeTransactionFromVacation: jest.fn(),
  getVacations: jest.fn().mockResolvedValue([]),
}));
jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _r: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
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
import { SplitwiseInboxItem, Vacation } from '@/lib/types';
import { ToastProvider } from '@/components/ToastProvider';

function item(over: Partial<SplitwiseInboxItem> = {}): SplitwiseInboxItem {
  return {
    expense_id: '555', description: 'Dinner', cost: 60, currency: 'USD',
    date: '2026-08-20', payer_name: 'Alice Ng', my_share: 30,
    participants: [{ id: '200', name: 'Alice Ng' }], group_id: null,
    state: 'pending', fetched_at: '2026-08-24T00:00:00.000Z',
    ...over,
  };
}

function vacation(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'vac1', name: 'Tokyo', start_date: null, end_date: null, status: 'active',
    splitwise_group_id: null, splitwise_group_name: null, splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useTransactionStore.setState({
    transactions: [], review: [], splitwiseInbox: [], isLoading: false,
    merchantBuckets: {}, splitwiseAuthExpired: false,
    // The mount effect calls loadInbox() itself (to hydrate from the local
    // cache, same as load()/loadReview()); stub it here so that hitting the
    // real store action doesn't race the splitwiseInbox this file sets
    // directly and overwrite it with whatever the unconfigured
    // getSplitwiseInbox mock resolves to.
    loadInbox: jest.fn(),
  });
  useVacationStore.setState({
    activeVacation: null, vacations: [],
    // VacationBanner's mount effect (via the expo-router useFocusEffect mock
    // above, which runs on mount) calls the real load() action, which would
    // otherwise overwrite activeVacation with whatever the unconfigured
    // getVacations() mock resolves to, racing whatever a test sets below.
    load: jest.fn(),
  });
});

it('renders a heading and a row for each pending expense', async () => {
  useTransactionStore.setState({ splitwiseInbox: [item()] });
  render(<TransactionsScreen />);
  await waitFor(() => expect(screen.getByText('From Splitwise · 1')).toBeTruthy());
  expect(screen.getByText('Dinner')).toBeTruthy();
  expect(screen.getByText('Alice Ng paid · your share $30.00')).toBeTruthy();
});

it('renders nothing when the inbox is empty', async () => {
  render(<TransactionsScreen />);
  await waitFor(() => expect(screen.queryByText(/From Splitwise/)).toBeNull());
});

it('tapping a row opens the bucket picker rather than accepting immediately', async () => {
  const accept = jest.fn();
  useTransactionStore.setState({ splitwiseInbox: [item()], acceptInboxItem: accept });
  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByLabelText('Add Dinner to history'));
  expect(accept).not.toHaveBeenCalled();
  expect(await screen.findByLabelText('Move Dinner to Food')).toBeTruthy();
});

it('choosing a bucket accepts the expense with that bucket', async () => {
  const accept = jest.fn().mockResolvedValue(undefined);
  useTransactionStore.setState({ splitwiseInbox: [item()], acceptInboxItem: accept });
  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByLabelText('Add Dinner to history'));
  fireEvent.press(await screen.findByLabelText('Move Dinner to Food'));
  await waitFor(() => expect(accept).toHaveBeenCalledWith(
    expect.objectContaining({ expense_id: '555' }), 'food'
  ));
});

it('toasts once when the Splitwise session has expired', async () => {
  // ToastProvider's show() schedules a 2800ms hide timeout, plus RN's Animated
  // drives its show/hide transitions off recursive frame timers, and none of
  // it is cancelled on unmount. Left on real timers, those fire after Jest
  // tears the environment down and crash the process even though every test
  // passed. Fake timers (cleared below) keep them from ever escaping the test.
  jest.useFakeTimers();
  try {
    const clear = jest.fn();
    useTransactionStore.setState({ splitwiseAuthExpired: true, clearSplitwiseAuthExpired: clear });
    // useToast() no-ops silently without a provider (ToastContext's default is
    // { show: () => {} }), so this test needs a real ToastProvider or the
    // assertion below would pass against text that never renders.
    render(<ToastProvider><TransactionsScreen /></ToastProvider>);
    await waitFor(() => expect(screen.getByText('Splitwise session expired. Please sign in again.')).toBeTruthy());
    expect(clear).toHaveBeenCalled();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

it('dismissing removes it without accepting', async () => {
  const dismiss = jest.fn().mockResolvedValue(undefined);
  const accept = jest.fn();
  useTransactionStore.setState({ splitwiseInbox: [item()], dismissInboxItem: dismiss, acceptInboxItem: accept });
  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByLabelText('Dismiss Dinner'));
  await waitFor(() => expect(dismiss).toHaveBeenCalledWith('555'));
  expect(accept).not.toHaveBeenCalled();
});

it('a group-matched expense accepts straight to the vacation, skipping the picker', async () => {
  // Same real-ToastProvider timer leak as the "toasts once" test above —
  // fake timers keep ToastProvider's scheduled hide from escaping past teardown.
  jest.useFakeTimers();
  try {
    const accept = jest.fn().mockResolvedValue(undefined);
    useVacationStore.setState({ activeVacation: vacation({ splitwise_group_id: '42' }) });
    useTransactionStore.setState({ splitwiseInbox: [item({ group_id: '42' })], acceptInboxItem: accept });
    render(<ToastProvider><TransactionsScreen /></ToastProvider>);
    fireEvent.press(await screen.findByLabelText('Add Dinner to history'));
    expect(screen.queryByLabelText('Move Dinner to Food')).toBeNull();
    await waitFor(() => expect(accept).toHaveBeenCalledWith(
      expect.objectContaining({ expense_id: '555', group_id: '42' }), 'travel'
    ));
    expect(await screen.findByText('Added to Tokyo')).toBeTruthy();
  } finally {
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});

it('a non-matching expense still opens the picker even with an active vacation', async () => {
  const accept = jest.fn();
  useVacationStore.setState({ activeVacation: vacation({ splitwise_group_id: '99' }) });
  useTransactionStore.setState({ splitwiseInbox: [item({ group_id: '42' })], acceptInboxItem: accept });
  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByLabelText('Add Dinner to history'));
  expect(await screen.findByLabelText('Move Dinner to Food')).toBeTruthy();
  expect(accept).not.toHaveBeenCalled();
});

it('a null group_id must not match a vacation whose group is also null', async () => {
  const accept = jest.fn();
  useVacationStore.setState({ activeVacation: vacation({ splitwise_group_id: null }) });
  useTransactionStore.setState({ splitwiseInbox: [item({ group_id: null })], acceptInboxItem: accept });
  render(<TransactionsScreen />);
  fireEvent.press(await screen.findByLabelText('Add Dinner to history'));
  expect(await screen.findByLabelText('Move Dinner to Food')).toBeTruthy();
  expect(accept).not.toHaveBeenCalled();
});
