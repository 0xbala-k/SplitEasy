// mobile/__tests__/components/VacationTransactionActionSheet.test.tsx
//
// Structural twin of HistoryActionSheet.test.tsx — same sheet shape, same
// null-transaction guard. This sheet acts on *unsplit* trip transactions,
// where HistoryActionSheet acts on already-split recap rows.
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));

import { render, fireEvent, screen } from '@testing-library/react-native';
import { VacationTransactionActionSheet } from '@/components/VacationTransactionActionSheet';
import { Transaction } from '@/lib/types';

const tx: Transaction = {
  id: 'tx1',
  merchant_name: 'Shinkansen',
  amount: 132.5,
  currency: 'USD',
  date: '2026-06-10',
  status: 'new',
  pending: false,
  created_at: '2026-06-10T00:00:00.000Z',
  vacation_id: 'v1',
};

test('renders nothing when transaction is null', () => {
  const { toJSON } = render(
    <VacationTransactionActionSheet transaction={null} onMoveOut={jest.fn()} onSkip={jest.fn()} />
  );
  expect(toJSON()).toBeNull();
});

test('shows merchant name and amount', () => {
  render(<VacationTransactionActionSheet transaction={tx} onMoveOut={jest.fn()} onSkip={jest.fn()} />);
  expect(screen.getByText('Shinkansen')).toBeTruthy();
  expect(screen.getByText('$132.50')).toBeTruthy();
});

test('fires onMoveOut when Move to Transactions is pressed', () => {
  const onMoveOut = jest.fn();
  render(<VacationTransactionActionSheet transaction={tx} onMoveOut={onMoveOut} onSkip={jest.fn()} />);
  fireEvent.press(screen.getByLabelText('Move Shinkansen to Transactions'));
  expect(onMoveOut).toHaveBeenCalledTimes(1);
});

test('fires onSkip when Skip is pressed', () => {
  const onSkip = jest.fn();
  render(<VacationTransactionActionSheet transaction={tx} onMoveOut={jest.fn()} onSkip={onSkip} />);
  fireEvent.press(screen.getByLabelText('Skip Shinkansen'));
  expect(onSkip).toHaveBeenCalledTimes(1);
});

test('offers both actions', () => {
  render(<VacationTransactionActionSheet transaction={tx} onMoveOut={jest.fn()} onSkip={jest.fn()} />);
  expect(screen.getByText('Move to Transactions')).toBeTruthy();
  expect(screen.getByText('Skip')).toBeTruthy();
});

// Hosts query this sheet's actions through the testID rather than by label:
// the transaction row behind it carries an inline skip button with the
// identical "Skip {merchant}" label. See vacation-detail.row-actions.test.tsx.
test('exposes a testID hosts can scope queries to', () => {
  render(<VacationTransactionActionSheet transaction={tx} onMoveOut={jest.fn()} onSkip={jest.fn()} />);
  expect(screen.getByTestId('vacation-tx-action-sheet')).toBeTruthy();
});
