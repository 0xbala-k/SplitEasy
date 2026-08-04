// mobile/__tests__/components/AddToVacationSheet.test.tsx
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
jest.mock('@/lib/db');
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));

import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AddToVacationSheet } from '@/components/AddToVacationSheet';
import * as db from '@/lib/db';
import { Transaction } from '@/lib/types';

const mockGetNew = db.getNewTransactions as jest.Mock;
const mockAssign = db.assignTransactionsToVacation as jest.Mock;

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
  return { id, merchant_name: `M${id}`, amount: 10, currency: 'USD', date: '2026-08-01', status: 'new', pending: false, created_at: 'x', ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetNew.mockResolvedValue([tx('t1'), tx('t2')]);
  mockAssign.mockResolvedValue(undefined);
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
