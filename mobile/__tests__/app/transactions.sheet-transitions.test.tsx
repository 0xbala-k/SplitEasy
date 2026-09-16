// Sheet-to-sheet transitions on the Transactions screen.
//
// The rest of this app's suites mock @gorhom/bottom-sheet so that every sheet
// renders unconditionally, which makes presentation invisible to a test. This
// file mocks it statefully instead — a sheet renders only while it has been
// present()ed — because the bug these tests guard against is precisely about
// which sheet is on screen at each step.
jest.mock('@/lib/receiptScan', () => ({ scanReceipt: jest.fn() }));
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
  const React = require('react');
  const { View } = require('react-native');
  const actual = require('@gorhom/bottom-sheet/mock');

  class BottomSheetModal extends React.Component<any, { presented: boolean }> {
    state = { presented: false };
    present() { this.setState({ presented: true }); }
    dismiss() { this.setState({ presented: false }); }
    snapToIndex() {}
    close() {}
    expand() {}
    collapse() {}
    forceClose() {}
    render() {
      if (!this.state.presented) return null;
      const Footer = this.props.footerComponent;
      return React.createElement(
        View,
        null,
        this.props.children,
        Footer ? React.createElement(Footer, { animatedFooterPosition: { value: 0 } }) : null
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
import { render, fireEvent, screen, waitFor, within } from '@testing-library/react-native';
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
    state: 'pending', fetched_at: '2026-08-24T00:00:00.000Z', ...over,
  };
}

function vacation(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v2', name: 'Banff', start_date: null, end_date: null, status: 'draft',
    splitwise_group_id: null, splitwise_group_name: null, splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null, ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useTransactionStore.setState({
    transactions: [], review: [], splitwiseInbox: [item()], isLoading: false,
    merchantBuckets: {}, loadInbox: jest.fn(),
    acceptInboxItem: jest.fn().mockResolvedValue(undefined),
  });
  useVacationStore.setState({ activeVacation: null, vacations: [vacation()], load: jest.fn() });
});

async function openDetailSheet() {
  render(<ToastProvider><TransactionsScreen /></ToastProvider>);
  fireEvent.press(await screen.findByLabelText('Add Dinner to history'));
  // The detail sheet is presented from an effect, once it has its item.
  await waitFor(() => expect(screen.getByLabelText('Merchant')).toBeTruthy());
}

describe('detail sheet <-> picker transitions', () => {
  it('replaces the detail sheet with the vacation picker rather than stacking them', async () => {
    await openDetailSheet();

    fireEvent.press(screen.getByLabelText('Vacation'));

    // Stacking leaves the detail sheet mounted but animated off-screen, which
    // reads to the user as "I'm back on the transactions tab".
    await waitFor(() => expect(screen.getByLabelText('Banff')).toBeTruthy());
    expect(screen.queryByLabelText('Merchant')).toBeNull();
  });

  it('returns to the detail sheet showing the chosen vacation', async () => {
    await openDetailSheet();
    fireEvent.press(screen.getByLabelText('Vacation'));
    fireEvent.press(await screen.findByLabelText('Banff'));

    await waitFor(() => expect(screen.getByLabelText('Merchant')).toBeTruthy());
    expect(screen.queryByLabelText('None')).toBeNull();
    // Scoped to the row: VacationBanner renders the trip name too.
    expect(within(screen.getByLabelText('Vacation')).getByText('Banff')).toBeTruthy();
  });

  it('shows the bucket as Travel once a trip is chosen, not a locked stale one', async () => {
    await openDetailSheet();
    fireEvent.press(screen.getByLabelText('Vacation'));
    fireEvent.press(await screen.findByLabelText('Banff'));
    await waitFor(() => expect(screen.getByLabelText('Merchant')).toBeTruthy());

    // acceptSplitwiseExpense forces travel/vacation whenever a trip applies, so
    // a chip still reading "Misc" behind a padlock describes a write that will
    // never happen.
    // A locked chip gets no onPress, so BucketChip renders it label-less —
    // assert on the text inside the Bucket row instead.
    expect(within(screen.getByLabelText('Bucket')).getByText('Travel')).toBeTruthy();
  });

  it('keeps edits made before opening the picker', async () => {
    await openDetailSheet();
    fireEvent.changeText(screen.getByLabelText('Merchant'), 'Birthday dinner');

    fireEvent.press(screen.getByLabelText('Vacation'));
    fireEvent.press(await screen.findByLabelText('Banff'));

    // Re-presenting must not bump openToken, or the sheet reseeds from the
    // inbox item and silently throws the typed edit away.
    await waitFor(() => expect(screen.getByLabelText('Merchant').props.value).toBe('Birthday dinner'));
  });

  it('accepts into the trip chosen through the picker', async () => {
    await openDetailSheet();
    fireEvent.press(screen.getByLabelText('Vacation'));
    fireEvent.press(await screen.findByLabelText('Banff'));
    await waitFor(() => expect(screen.getByText('Accept')).toBeTruthy());

    fireEvent.press(screen.getByText('Accept'));
    await waitFor(() => expect(useTransactionStore.getState().acceptInboxItem).toHaveBeenCalledWith(
      expect.objectContaining({ expense_id: '555' }), expect.any(String), 'v2'
    ));
  });

  it('replaces the detail sheet with the bucket picker too', async () => {
    await openDetailSheet();

    fireEvent.press(screen.getByLabelText('Category: Misc. Tap to change.'));

    await waitFor(() => expect(screen.getByLabelText('Move Dinner to Food')).toBeTruthy());
    expect(screen.queryByLabelText('Merchant')).toBeNull();
  });

  it('returns to the detail sheet showing the chosen bucket', async () => {
    await openDetailSheet();
    fireEvent.press(screen.getByLabelText('Category: Misc. Tap to change.'));
    fireEvent.press(await screen.findByLabelText('Move Dinner to Food'));

    await waitFor(() => expect(screen.getByLabelText('Merchant')).toBeTruthy());
    expect(screen.getByLabelText('Category: Food. Tap to change.')).toBeTruthy();
  });
});
