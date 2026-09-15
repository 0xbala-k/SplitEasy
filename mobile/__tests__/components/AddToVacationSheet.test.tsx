// mobile/__tests__/components/AddToVacationSheet.test.tsx
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  const actual = require('@gorhom/bottom-sheet/mock');

  // The library's own test mock renders `children` only and silently drops
  // `footerComponent`, so the confirm CTA (now rendered via `footerComponent`
  // + `BottomSheetFooter`) would never appear in the tree. Extend the mock's
  // BottomSheetModal to also render the footer, and stub BottomSheetFooter
  // as a passthrough.
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
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/lib/db');
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));

import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AddToVacationSheet } from '@/components/AddToVacationSheet';
import { useTransactionStore } from '@/stores/transactionStore';
import * as db from '@/lib/db';
import { SplitwiseInboxItem, Transaction } from '@/lib/types';

const mockGetNew = db.getNewTransactions as jest.Mock;
const mockAssign = db.assignTransactionsToVacation as jest.Mock;
const mockGetInbox = db.getSplitwiseInbox as jest.Mock;
const mockAccept = db.acceptSplitwiseExpense as jest.Mock;

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
  return { id, merchant_name: `M${id}`, amount: 10, currency: 'USD', date: '2026-08-01', status: 'new', pending: false, created_at: 'x', ...over };
}

function inbox(id: string, over: Partial<SplitwiseInboxItem> = {}): SplitwiseInboxItem {
  return {
    expense_id: id, description: `E${id}`, cost: 240, currency: 'USD', date: '2026-08-01',
    payer_name: 'Alice', my_share: 60, participants: [{ id: '9', name: 'Alice' }],
    group_id: null, state: 'pending', fetched_at: 'x', ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useTransactionStore.setState({ splitwiseInbox: [] });
  mockGetNew.mockResolvedValue([tx('t1'), tx('t2')]);
  mockAssign.mockResolvedValue(undefined);
  mockGetInbox.mockResolvedValue([]);
  mockAccept.mockResolvedValue(undefined);
});

test('lists unassigned transactions on open and re-fetches when openToken changes', async () => {
  const { rerender } = render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('Mt1')).toBeTruthy());
  mockGetNew.mockResolvedValue([tx('t3')]);
  rerender(<AddToVacationSheet vacationId="v1" openToken={2} onDone={jest.fn()} />);
  await waitFor(() => expect(mockGetNew).toHaveBeenCalledTimes(2));
});

test('selecting rows and confirming assigns them and calls onDone', async () => {
  const onDone = jest.fn();
  render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={onDone} />);
  await waitFor(() => expect(screen.getByLabelText('Select Mt1')).toBeTruthy());

  fireEvent.press(screen.getByLabelText('Select Mt1'));
  fireEvent.press(screen.getByLabelText('Add to vacation'));

  await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('v1', ['t1']));
  expect(onDone).toHaveBeenCalled();
});

test('confirm button is disabled with nothing selected', async () => {
  render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Select Mt1')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Add to vacation'));
  expect(mockAssign).not.toHaveBeenCalled();
});

describe('Splitwise expenses', () => {
  it('lists pending Splitwise expenses alongside the unassigned transactions', async () => {
    mockGetInbox.mockResolvedValue([inbox('555')]);
    render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);

    await waitFor(() => expect(screen.getByText('E555')).toBeTruthy());
    expect(screen.getByText('Alice paid · your share $60.00')).toBeTruthy();
    // The Plaid rows keep their own section rather than being replaced.
    expect(screen.getByText('Mt1')).toBeTruthy();
  });

  it('imports a selected Splitwise expense into the vacation as travel spend', async () => {
    const item = inbox('555');
    mockGetInbox.mockResolvedValue([item]);
    const onDone = jest.fn();
    render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={onDone} />);
    await waitFor(() => expect(screen.getByLabelText('Select E555')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Select E555'));
    fireEvent.press(screen.getByLabelText('Add to vacation'));

    await waitFor(() => expect(mockAccept).toHaveBeenCalledWith(item, 'travel', 'v1'));
    // Nothing Plaid-side was selected, so no assignment should be attempted.
    expect(mockAssign).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it('assigns Plaid rows and imports Splitwise rows in one confirm', async () => {
    const item = inbox('555');
    mockGetInbox.mockResolvedValue([item]);
    render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Select E555')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Select Mt1'));
    fireEvent.press(screen.getByLabelText('Select E555'));
    fireEvent.press(screen.getByLabelText('Add to vacation'));

    await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('v1', ['t1']));
    expect(mockAccept).toHaveBeenCalledWith(item, 'travel', 'v1');
  });

  it('drops the imported expense from the Transactions tab inbox', async () => {
    // The tab loads its inbox slice once on mount, so an accept made from here
    // has to prune that slice or the card lingers until the tab remounts.
    const item = inbox('555');
    mockGetInbox.mockResolvedValue([item]);
    useTransactionStore.setState({ splitwiseInbox: [item] });
    render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);
    await waitFor(() => expect(screen.getByLabelText('Select E555')).toBeTruthy());

    fireEvent.press(screen.getByLabelText('Select E555'));
    fireEvent.press(screen.getByLabelText('Add to vacation'));

    await waitFor(() => expect(useTransactionStore.getState().splitwiseInbox).toEqual([]));
  });
});
