// mobile/__tests__/components/FriendPickerSheet.test.tsx
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
jest.mock('@/lib/db');
// Keep SplitwiseAuthError real (the component uses `instanceof`); mock the calls.
jest.mock('@/lib/splitwise', () => ({
  ...jest.requireActual('@/lib/splitwise'),
  createExpense: jest.fn(),
  updateExpense: jest.fn(),
  getExpense: jest.fn(),
}));
jest.mock('@/stores/friendStore', () => ({ useFriendStore: jest.fn() }));
jest.mock('@/stores/authStore', () => ({ useAuthStore: jest.fn() }));
jest.mock('@/stores/transactionStore', () => ({ useTransactionStore: jest.fn() }));
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: jest.fn() }) }));

import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import * as db from '@/lib/db';
import * as splitwise from '@/lib/splitwise';
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { SplitDecision, Transaction } from '@/lib/types';

const mockGetExpense = splitwise.getExpense as jest.Mock;
const mockUpdateExpense = splitwise.updateExpense as jest.Mock;
const mockUpsert = db.upsertSplitDecision as jest.Mock;
const mockInsert = db.insertSplitDecision as jest.Mock;
const mockCreateExpense = splitwise.createExpense as jest.Mock;

const tx: Transaction = {
  id: 'tx1',
  merchant_name: 'Amazon',
  amount: 20,
  currency: 'USD',
  date: '2026-06-10',
  status: 'split',
  pending: false,
  created_at: '2026-06-10T10:00:00Z',
};

const decision: SplitDecision = {
  id: 'sd1',
  transaction_id: 'tx1',
  splitwise_expense_id: 'exp1',
  friend_ids: ['2'],
  friend_names: ['Sam'],
  amount_each: 10,
  created_at: '2026-06-10T10:00:00Z',
};

function renderEdit(openToken = 1, onSuccess = jest.fn()) {
  return render(
    <FriendPickerSheet
      transaction={tx}
      mode="edit"
      editDecision={decision}
      openToken={openToken}
      onSuccess={onSuccess}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  (useFriendStore as jest.Mock).mockReturnValue({
    friends: [{ id: '2', display_name: 'Sam', avatar_url: null }],
    isLoading: false,
  });
  (useAuthStore as jest.Mock).mockImplementation((sel) => sel({ user_id: '1' }));
  (useTransactionStore as jest.Mock).mockImplementation((sel) => sel({ markSplit: jest.fn() }));
  mockGetExpense.mockResolvedValue({ '1': 10, '2': 10 });
  mockUpdateExpense.mockResolvedValue({ amount_each: 10 });
  mockUpsert.mockResolvedValue(undefined);
  mockCreateExpense.mockResolvedValue({ expense_id: 'expNew', amount_each: 10 });
  (db.getSplitDecision as jest.Mock).mockResolvedValue(null);
  mockInsert.mockResolvedValue(undefined);
});

test('edit mode pre-fills from the existing Splitwise expense', async () => {
  renderEdit();
  await waitFor(() => expect(mockGetExpense).toHaveBeenCalledWith('exp1'));
});

test('saving an edit updates the Splitwise expense and the local decision', async () => {
  const onSuccess = jest.fn();
  renderEdit(1, onSuccess);
  await waitFor(() => expect(mockGetExpense).toHaveBeenCalled());

  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
  expect(mockUpdateExpense).toHaveBeenCalledWith(
    'exp1',
    expect.objectContaining({ amount: 20, friendIds: ['2'], currentUserId: '1' })
  );
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({ transaction_id: 'tx1', splitwise_expense_id: 'exp1', id: 'sd1' })
  );
  expect(onSuccess).toHaveBeenCalledWith(10);
});

test('the CTA is reusable after a successful save (submitting is reset)', async () => {
  renderEdit();
  await waitFor(() => expect(mockGetExpense).toHaveBeenCalled());
  const cta = screen.getByLabelText('Add split to Splitwise');

  fireEvent.press(cta);
  await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));

  fireEvent.press(cta);
  await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(2));
});

test('re-presenting (openToken change) re-runs the pre-fill', async () => {
  const { rerender } = renderEdit(1);
  await waitFor(() => expect(mockGetExpense).toHaveBeenCalledTimes(1));

  rerender(
    <FriendPickerSheet
      transaction={tx}
      mode="edit"
      editDecision={decision}
      openToken={2}
      onSuccess={jest.fn()}
    />
  );
  await waitFor(() => expect(mockGetExpense).toHaveBeenCalledTimes(2));
});

test('edit mode pre-fills the title from the decision description', async () => {
  render(
    <FriendPickerSheet
      transaction={tx}
      mode="edit"
      editDecision={{ ...decision, description: 'Weekend trip' }}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  await waitFor(() => expect(screen.getByDisplayValue('Weekend trip')).toBeTruthy());
});

test('combine create sums amounts, writes one row per member, and marks each split', async () => {
  const markSplit = jest.fn();
  (useTransactionStore as jest.Mock).mockImplementation((sel) => sel({ markSplit }));
  const members: Transaction[] = [
    { ...tx, id: 'txA', merchant_name: 'Starbucks', amount: 5 },
    { ...tx, id: 'txB', merchant_name: 'Uber', amount: 15 },
  ];
  const onSuccess = jest.fn();
  render(
    <FriendPickerSheet
      transaction={null}
      combineTransactions={members}
      openToken={1}
      onSuccess={onSuccess}
    />
  );

  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockCreateExpense).toHaveBeenCalledTimes(1));
  expect(mockCreateExpense).toHaveBeenCalledWith(
    expect.objectContaining({ amount: 20, description: 'Starbucks, Uber' })
  );
  await waitFor(() => expect(mockInsert).toHaveBeenCalledTimes(2));
  expect(mockInsert).toHaveBeenCalledWith(
    expect.objectContaining({ transaction_id: 'txA', splitwise_expense_id: 'expNew', description: 'Starbucks, Uber' })
  );
  expect(mockInsert).toHaveBeenCalledWith(
    expect.objectContaining({ transaction_id: 'txB', splitwise_expense_id: 'expNew' })
  );
  expect(markSplit).toHaveBeenCalledWith('txA');
  expect(markSplit).toHaveBeenCalledWith('txB');
  expect(onSuccess).toHaveBeenCalledWith(10);
});

test('combine edit upserts one row per member, reusing the decision id for its own row', async () => {
  const members: Transaction[] = [
    { ...tx, id: 'txA', merchant_name: 'Starbucks', amount: 5 },
    { ...tx, id: 'txB', merchant_name: 'Uber', amount: 15 },
  ];
  const onSuccess = jest.fn();
  render(
    <FriendPickerSheet
      transaction={null}
      combineTransactions={members}
      mode="edit"
      editDecision={{ ...decision, transaction_id: 'txA' }}
      openToken={1}
      onSuccess={onSuccess}
    />
  );

  await waitFor(() => expect(mockGetExpense).toHaveBeenCalled());
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));
  expect(mockUpdateExpense).toHaveBeenCalledWith('exp1', expect.objectContaining({ amount: 20 }));
  await waitFor(() => expect(mockUpsert).toHaveBeenCalledTimes(2));
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'sd1', transaction_id: 'txA', splitwise_expense_id: 'exp1' })
  );
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.objectContaining({ transaction_id: 'txB', splitwise_expense_id: 'exp1' })
  );
  expect(onSuccess).toHaveBeenCalledWith(10);
});

test('single create passes the edited title as the description', async () => {
  render(
    <FriendPickerSheet transaction={{ ...tx, status: 'new' }} openToken={1} onSuccess={jest.fn()} />
  );
  fireEvent.changeText(screen.getByLabelText('Split title'), 'Groceries');
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockCreateExpense).toHaveBeenCalledTimes(1));
  expect(mockCreateExpense).toHaveBeenCalledWith(
    expect.objectContaining({ description: 'Groceries' })
  );
  await waitFor(() =>
    expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({ description: 'Groceries', transaction_id: 'tx1' }))
  );
});
