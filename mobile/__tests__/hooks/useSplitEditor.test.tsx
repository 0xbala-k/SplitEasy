import { renderHook, act, waitFor } from '@testing-library/react-native';
import { useSplitEditor } from '@/hooks/useSplitEditor';
import { getSplitDecision, getTransactionsByIds, deleteImportedExpense, restoreTransaction } from '@/lib/db';
import { showDialog } from '@/lib/dialog';
import { HistoryItem } from '@/lib/types';

jest.mock('@/lib/db');
jest.mock('@/lib/dialog');

function item(over: Partial<HistoryItem> = {}): HistoryItem {
  return {
    id: 'p1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-07-01',
    status: 'split', split: { friend_names: ['Alice'], amount_each: 10 },
    ...over,
  };
}

const decision = {
  id: 'd1', transaction_id: 'p1', splitwise_expense_id: 'e1',
  friend_ids: ['f1'], friend_names: ['Alice'], amount_each: 10,
  created_at: '2026-07-01T00:00:00.000Z', description: 'Cafe',
};

beforeEach(() => jest.clearAllMocks());

test('a skipped row opens the picker in create mode', () => {
  const { result } = renderHook(() => useSplitEditor({ onChange: jest.fn() }));

  act(() => result.current.openFor(item({ status: 'skipped', split: undefined })));

  expect(result.current.pickerProps.mode).toBe('create');
  expect(result.current.pickerProps.editDecision).toBeNull();
  expect(result.current.pickerProps.transaction?.id).toBe('p1');
});

test('a split row opens the action sheet, not the picker', () => {
  const { result } = renderHook(() => useSplitEditor({ onChange: jest.fn() }));

  act(() => result.current.openFor(item()));

  expect(result.current.actionProps.transaction?.id).toBe('p1');
  expect(result.current.actionProps.mode).toBe('default');
});

test('an imported row gets the read-only variant', () => {
  const { result } = renderHook(() => useSplitEditor({ onChange: jest.fn() }));

  act(() => result.current.openFor(item({ source: 'splitwise', payer_name: 'Sam' })));

  expect(result.current.actionProps.mode).toBe('readOnly');
});

test('resolveMode can override the default variant', () => {
  const { result } = renderHook(() =>
    useSplitEditor({ onChange: jest.fn(), resolveMode: () => 'excluded' })
  );

  act(() => result.current.openFor(item()));

  expect(result.current.actionProps.mode).toBe('excluded');
});

test('editing a single split loads its decision and switches to edit mode', async () => {
  (getSplitDecision as jest.Mock).mockResolvedValue(decision);
  const { result } = renderHook(() => useSplitEditor({ onChange: jest.fn() }));

  act(() => result.current.openFor(item()));
  await act(async () => { await result.current.actionProps.onEdit(); });

  await waitFor(() => expect(result.current.pickerProps.mode).toBe('edit'));
  expect(result.current.pickerProps.editDecision).toEqual(decision);
  expect(result.current.pickerProps.combineTransactions).toBeUndefined();
});

test('editing a combined split loads every member and the shared decision', async () => {
  const members = [
    { id: 'p1', merchant_name: 'Cafe', amount: 10, currency: 'USD', date: '2026-07-01', status: 'split', pending: false, created_at: '2026-07-01' },
    { id: 'p2', merchant_name: 'Bar', amount: 10, currency: 'USD', date: '2026-07-01', status: 'split', pending: false, created_at: '2026-07-01' },
  ];
  (getTransactionsByIds as jest.Mock).mockResolvedValue(members);
  (getSplitDecision as jest.Mock).mockResolvedValue(decision);
  const { result } = renderHook(() => useSplitEditor({ onChange: jest.fn() }));

  act(() => result.current.openFor(item({ combined: { expense_id: 'e1', transaction_ids: ['p1', 'p2'], count: 2 } })));
  await act(async () => { await result.current.actionProps.onEdit(); });

  await waitFor(() => expect(result.current.pickerProps.combineTransactions).toHaveLength(2));
  expect(result.current.pickerProps.transaction).toBeNull();
});

test('a missing decision opens nothing', async () => {
  (getSplitDecision as jest.Mock).mockResolvedValue(null);
  const { result } = renderHook(() => useSplitEditor({ onChange: jest.fn() }));

  act(() => result.current.openFor(item()));
  await act(async () => { await result.current.actionProps.onEdit(); });

  expect(result.current.pickerProps.mode).not.toBe('edit');
});

test('deleting an imported row removes it locally and never touches Splitwise', async () => {
  (showDialog as jest.Mock).mockImplementation((_t, _m, buttons) => buttons[1].onPress());
  const onChange = jest.fn();
  const { result } = renderHook(() => useSplitEditor({ onChange }));

  act(() => result.current.openFor(item({ id: 'sw:99', source: 'splitwise' })));
  await act(async () => { await result.current.actionProps.onDelete(); });

  await waitFor(() => expect(deleteImportedExpense).toHaveBeenCalledWith('99', true));
  expect(onChange).toHaveBeenCalled();
});

test('restoring an excluded row reloads the list', async () => {
  (restoreTransaction as jest.Mock).mockResolvedValue(undefined);
  const onChange = jest.fn();
  const { result } = renderHook(() => useSplitEditor({ onChange, resolveMode: () => 'excluded' }));

  act(() => result.current.openFor(item({ status: 'excluded' })));
  await act(async () => { await result.current.actionProps.onRestore(); });

  await waitFor(() => expect(restoreTransaction).toHaveBeenCalledWith('p1'));
  expect(onChange).toHaveBeenCalled();
});

test('an excluded row opens the action sheet even though it is not split', () => {
  const { result } = renderHook(() =>
    useSplitEditor({ onChange: jest.fn(), resolveMode: () => 'excluded' })
  );

  act(() => result.current.openFor(item({ status: 'skipped', split: undefined })));

  // The excluded filter shows skipped rows too; they must NOT fall into the
  // "tap to split" branch while that filter is on.
  expect(result.current.actionProps.transaction?.id).toBe('p1');
  expect(result.current.pickerProps.mode).not.toBe('create');
});
