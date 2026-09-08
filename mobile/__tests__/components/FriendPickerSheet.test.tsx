// mobile/__tests__/components/FriendPickerSheet.test.tsx
jest.mock('@gorhom/bottom-sheet', () => {
  const React = require('react');
  const actual = require('@gorhom/bottom-sheet/mock');

  // The library's own test mock renders `children` only and silently drops
  // `footerComponent`, so the CTA (now rendered via `footerComponent` +
  // `BottomSheetFooter`) would never appear in the tree. Extend the mock's
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
// Keep SplitwiseAuthError real (the component uses `instanceof`); mock the calls.
jest.mock('@/lib/splitwise', () => ({
  ...jest.requireActual('@/lib/splitwise'),
  createExpense: jest.fn(),
  updateExpense: jest.fn(),
  deleteExpense: jest.fn(),
  getExpense: jest.fn(),
}));
jest.mock('@/stores/friendStore', () => ({ useFriendStore: jest.fn() }));
jest.mock('@/stores/authStore', () => ({ useAuthStore: jest.fn() }));
jest.mock('@/stores/transactionStore', () => ({ useTransactionStore: jest.fn() }));
jest.mock('@/components/ToastProvider', () => ({ useToast: () => ({ show: jest.fn() }) }));
jest.mock('@/lib/receiptScan', () => ({ scanReceipt: jest.fn() }));
// The queue's actual flush logic (network calls, retry bookkeeping) is
// covered by splitwiseQueue's own tests (Task 13) — here it's fire-and-forget
// noise from the component's perspective, so stub it out.
jest.mock('@/lib/splitwiseQueue', () => ({ flushQueue: jest.fn() }));

import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import * as db from '@/lib/db';
import * as splitwise from '@/lib/splitwise';
import * as receiptScan from '@/lib/receiptScan';
import { flushQueue } from '@/lib/splitwiseQueue';
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { useTransactionStore } from '@/stores/transactionStore';
import { SplitDecision, Transaction } from '@/lib/types';

const mockGetExpense = splitwise.getExpense as jest.Mock;
const mockUpdateExpense = splitwise.updateExpense as jest.Mock;
const mockUpsert = db.upsertSplitDecision as jest.Mock;
const mockCreateExpense = splitwise.createExpense as jest.Mock;
const mockScanReceipt = receiptScan.scanReceipt as jest.Mock;
const mockEnqueueOp = db.enqueueOp as jest.Mock;
const mockFlushQueue = flushQueue as jest.Mock;
const mockCommitCombined = jest.fn();

// The create path (Task 14) no longer calls createExpense synchronously — it
// enqueues a `create` op whose JSON-serialized payload carries the params
// that used to go straight to the API. Tests that used to assert against
// mockCreateExpense's call args now assert against this instead.
function lastEnqueuedPayload(): Record<string, unknown> {
  const calls = mockEnqueueOp.mock.calls;
  const [op] = calls[calls.length - 1];
  return JSON.parse(op.payload);
}

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
  mockCommitCombined.mockReset().mockResolvedValue(undefined);
  (useTransactionStore as jest.Mock).mockImplementation((sel) =>
    sel({ markSplit: jest.fn(), commitCombinedSplit: mockCommitCombined })
  );
  mockGetExpense.mockResolvedValue({ '1': 10, '2': 10 });
  mockUpdateExpense.mockResolvedValue({ amount_each: 10 });
  mockUpsert.mockResolvedValue(undefined);
  mockCreateExpense.mockResolvedValue({ expense_id: 'expNew', amount_each: 10 });
  (db.getSplitDecision as jest.Mock).mockResolvedValue(null);
  mockEnqueueOp.mockResolvedValue(undefined);
  mockFlushQueue.mockResolvedValue(undefined);
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

  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));
  await waitFor(() => expect(mockUpdateExpense).toHaveBeenCalledTimes(1));

  // Re-query rather than reuse the pre-press node: the CTA is rendered via
  // `footerComponent`, which the (real) library instantiates as a component
  // type, so a `submitting` flip — an intentional dep of the memoized
  // renderer — remounts the footer subtree with a fresh instance.
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));
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

test('combine create sums amounts and commits one decision row per member atomically', async () => {
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

  await waitFor(() => expect(mockCommitCombined).toHaveBeenCalledTimes(1));
  const decisions = mockCommitCombined.mock.calls[0][0];
  expect(decisions).toHaveLength(2);
  expect(decisions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ transaction_id: 'txA', splitwise_expense_id: null, description: 'Starbucks, Uber' }),
      expect.objectContaining({ transaction_id: 'txB', splitwise_expense_id: null, description: 'Starbucks, Uber' }),
    ])
  );
  // The push is queued (anchored on the first member) and kicked off, but the
  // remote call itself is not this component's job — that's flushQueue's.
  expect(mockEnqueueOp).toHaveBeenCalledTimes(1);
  expect(mockEnqueueOp).toHaveBeenCalledWith(
    expect.objectContaining({ op_type: 'create', transaction_id: 'txA', expense_id: null })
  );
  expect(lastEnqueuedPayload()).toEqual(
    expect.objectContaining({ amount: 20, description: 'Starbucks, Uber' })
  );
  expect(mockFlushQueue).toHaveBeenCalledTimes(1);
  expect(mockCreateExpense).not.toHaveBeenCalled();
  expect(onSuccess).toHaveBeenCalledWith(10);
});

test('combine create does not queue a push when the local commit fails', async () => {
  mockCommitCombined.mockRejectedValue(new Error('DB_FAIL'));
  const members: Transaction[] = [
    { ...tx, id: 'txA', merchant_name: 'Starbucks', amount: 5 },
    { ...tx, id: 'txB', merchant_name: 'Uber', amount: 15 },
  ];
  render(
    <FriendPickerSheet transaction={null} combineTransactions={members} openToken={1} onSuccess={jest.fn()} />
  );

  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockCommitCombined).toHaveBeenCalledTimes(1));
  // Nothing is queued or pushed when the local commit itself fails — unlike
  // the old remote-first flow, there is no remote expense to roll back here,
  // since the local commit now runs before anything reaches Splitwise.
  expect(mockEnqueueOp).not.toHaveBeenCalled();
  expect(mockFlushQueue).not.toHaveBeenCalled();
  expect(mockCreateExpense).not.toHaveBeenCalled();
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

  await waitFor(() => expect(mockCommitCombined).toHaveBeenCalledTimes(1));
  expect(mockCommitCombined.mock.calls[0][0]).toEqual([
    expect.objectContaining({ transaction_id: 'tx1', description: 'Groceries' }),
  ]);
  await waitFor(() => expect(mockEnqueueOp).toHaveBeenCalledTimes(1));
  expect(lastEnqueuedPayload()).toEqual(expect.objectContaining({ description: 'Groceries' }));
});

// Local-first create (Task 14): previously the create branch was remote-first
// (create on Splitwise, then commit locally), so an unreachable Splitwise API
// meant the split was never created at all — the catch block just showed a
// toast and discarded the user's work. Now the split commits locally first,
// with a null expense id, and the push to Splitwise is queued and retried
// separately (fire-and-forget), so a Splitwise outage no longer loses data.
test('keeps the split locally and queues the push when Splitwise is down', async () => {
  mockCreateExpense.mockRejectedValue(new splitwise.SplitwiseAuthError());
  const onSuccess = jest.fn();
  render(
    <FriendPickerSheet transaction={{ ...tx, status: 'new' }} openToken={1} onSuccess={onSuccess} />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockEnqueueOp).toHaveBeenCalled());
  // The work must survive: previously the remote failure discarded it entirely.
  expect(mockCommitCombined).toHaveBeenCalled();
  const [[decisions]] = mockCommitCombined.mock.calls;
  expect(decisions[0].splitwise_expense_id).toBeNull();
  expect(onSuccess).toHaveBeenCalled();
});

// Fix round: the create branch used to store a naive equal division
// (effectiveTotal / (friendIds.length + 1)) as amount_each, ignoring
// friendShares entirely — wrong for any non-symmetric custom/receipt split.
// amount_each must instead be the owner's actual owed share (amount minus
// the sum of friend shares), matching buildExpenseBody's math exactly, since
// nothing later reconciles this value against the server's response.
test('local-first create stores the owner\'s actual owed share for an uneven custom split, not a naive equal split', async () => {
  // Splitwise unreachable: forces the local-first/queued path (though the
  // create branch is unconditionally local-first regardless).
  mockCreateExpense.mockRejectedValue(new splitwise.SplitwiseAuthError());
  render(
    <FriendPickerSheet
      transaction={{ ...tx, id: 'txU1', amount: 100, status: 'new' }}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByText('Custom'));

  const amountInput = screen.getByLabelText("Sam's share amount");
  fireEvent.changeText(amountInput, '30.00');
  fireEvent(amountInput, 'blur');

  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockCommitCombined).toHaveBeenCalledTimes(1));
  const [[decisions]] = mockCommitCombined.mock.calls;
  // Owner's true owed share = amount - sum(friendShares) = 100 - 30 = 70.
  // A naive equal division would have wrongly stored 100 / 2 = 50.
  expect(decisions[0].amount_each).toBe(70);
  expect(lastEnqueuedPayload()).toEqual(
    expect.objectContaining({ amount: 100, friendShares: { '2': 30 } })
  );
});

// Regression: the CTA lives in the sheet's pinned footer, which the library
// renders as a component type — so `renderFooter` is memoized on a narrow dep
// list to avoid remounting the footer subtree on every keystroke. Editing the
// title AFTER selecting a friend leaves `ctaDisabled` unchanged, so the footer
// is not recreated; the press handler must still see the current title rather
// than the closure captured when the CTA last became enabled.
test('create uses the title edited after the CTA became enabled', async () => {
  render(
    <FriendPickerSheet transaction={{ ...tx, status: 'new' }} openToken={1} onSuccess={jest.fn()} />
  );
  // Order matters: selecting first is what flips `ctaDisabled` and freezes the
  // memoized footer. Reversing these two lines makes this test pass either way.
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.changeText(screen.getByLabelText('Split title'), 'Late edit');
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockEnqueueOp).toHaveBeenCalledTimes(1));
  expect(lastEnqueuedPayload()).toEqual(expect.objectContaining({ description: 'Late edit' }));
});

// Regression: the sheet renders null until it has a transaction, so every hook
// must run before that bail-out. When it didn't, the render that first supplied
// a transaction — i.e. tapping Split — added a hook the previous render lacked
// and React tore the whole tree down (blank white screen on the PWA).
test('going from no transaction to a transaction does not change the hook count', () => {
  const { rerender } = render(
    <FriendPickerSheet transaction={null} openToken={0} onSuccess={jest.fn()} />
  );
  expect(screen.queryByLabelText('Split title')).toBeNull();

  expect(() =>
    rerender(
      <FriendPickerSheet
        transaction={{ ...tx, status: 'new' }}
        openToken={1}
        onSuccess={jest.fn()}
      />
    )
  ).not.toThrow();

  expect(screen.getByLabelText('Split title').props.value).toBe('Amazon');
});

test('passes groupId through to the queued create payload when set', async () => {
  render(
    <FriendPickerSheet
      transaction={{ ...tx, status: 'new' }}
      groupId="55"
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));
  await waitFor(() => expect(mockEnqueueOp).toHaveBeenCalledTimes(1));
  expect(lastEnqueuedPayload()).toEqual(expect.objectContaining({ groupId: '55' }));
});

test('sorts group members ahead of other friends without hiding non-members', async () => {
  // Store order is Sam-then-Zoe and Zoe is the group member, so this only
  // passes once the groupMemberIds sort actually runs — with the fix absent,
  // the assertion below would see ['Sam', 'Zoe'] (the store's own order) and
  // fail, unlike a fixture that already happens to match the sorted output.
  (useFriendStore as jest.Mock).mockReturnValue({
    friends: [
      { id: '2', display_name: 'Sam', avatar_url: null },
      { id: '3', display_name: 'Zoe', avatar_url: null },
    ],
    isLoading: false,
  });
  render(
    <FriendPickerSheet
      transaction={{ ...tx, status: 'new' }}
      groupId="55"
      groupMemberIds={['3']}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  const names = screen.getAllByRole('checkbox').map((el) => el.props.accessibilityLabel);
  expect(names).toEqual(['Zoe', 'Sam']);
});

// --- Receipt split mode ---------------------------------------------------
//
// One $30 item, $3 tax, $6 tip, split between the owner and Sam (the only
// selected friend, id '2' — so "everyone" for the item's assignees is
// exactly [owner, '2']). Worked by hand against lib/receipt.ts's algorithm:
//   - item ($30 = 3000c) split 1/1 between 2 participants -> 1500c/1500c
//     (distribute() gives an exact even split here, no remainder).
//   - tax ($3 = 300c) weighted by item subtotal, which is 1500/1500 (equal
//     weights) -> 150c/150c.
//   - tip ($6 = 600c) split equally across the 2 participants -> 300c/300c.
//   - Sam's total: 1500 + 150 + 300 = 1950c = $19.50.
// Receipt total = 3000 + 300 + 600 = 3900c = $39.00.
const scannedReceipt = {
  merchant: 'Cafe',
  items: [{ name: 'Pizza', quantity: 1, price_cents: 3000 }],
  subtotal_cents: 3000,
  tax_cents: 300,
  tip_cents: 600,
  total_cents: 3900,
};

test('the Receipt segment is hidden until a friend is selected', () => {
  render(<FriendPickerSheet transaction={{ ...tx, status: 'new' }} openToken={1} onSuccess={jest.fn()} />);
  expect(screen.queryByText('Receipt')).toBeNull();

  fireEvent.press(screen.getByLabelText('Sam'));
  expect(screen.getByText('Receipt')).toBeTruthy();
});

test('the Receipt segment never appears for combined splits, even with a friend selected', () => {
  const members: Transaction[] = [
    { ...tx, id: 'txA', merchant_name: 'Starbucks', amount: 5 },
    { ...tx, id: 'txB', merchant_name: 'Uber', amount: 15 },
  ];
  render(
    <FriendPickerSheet transaction={null} combineTransactions={members} openToken={1} onSuccess={jest.fn()} />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  // The segmented control itself is present (Equal/Custom) - Receipt is the
  // one option specifically withheld for combined splits.
  expect(screen.getByText('Equal')).toBeTruthy();
  expect(screen.queryByText('Receipt')).toBeNull();
});

test('tapping Receipt enters the capture stage; Skip advances to assign with no items', async () => {
  render(<FriendPickerSheet transaction={{ ...tx, status: 'new' }} openToken={1} onSuccess={jest.fn()} />);
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByText('Receipt'));

  expect(screen.getByLabelText('Choose photo')).toBeTruthy();
  expect(screen.getByLabelText('Skip, enter items manually')).toBeTruthy();

  fireEvent.press(screen.getByLabelText('Skip, enter items manually'));

  expect(await screen.findByText('No items yet. Tap “Add item” to enter one manually.')).toBeTruthy();
  expect(screen.getByLabelText('Add item')).toBeTruthy();
});

test('a failed scan (parse error) still lands on assign with zero items and does not throw', async () => {
  mockScanReceipt.mockResolvedValue({ status: 'failed', reason: 'parse' });
  render(<FriendPickerSheet transaction={{ ...tx, status: 'new' }} openToken={1} onSuccess={jest.fn()} />);
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByText('Receipt'));

  expect(() => fireEvent.press(screen.getByLabelText('Choose photo'))).not.toThrow();

  expect(await screen.findByText('No items yet. Tap “Add item” to enter one manually.')).toBeTruthy();
  expect(mockScanReceipt).toHaveBeenCalledWith('library');
});

test('an item with no assignees disables the CTA', async () => {
  mockScanReceipt.mockResolvedValue({ status: 'ok', receipt: scannedReceipt });
  render(
    <FriendPickerSheet
      transaction={{ ...tx, id: 'txR5', amount: 39, status: 'new' }}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByText('Receipt'));
  fireEvent.press(screen.getByLabelText('Choose photo'));

  // The scanned item lands unassigned - confirm it rendered before asserting.
  await screen.findByLabelText('Assign to everyone');
  // Pressable translates `disabled` into `accessibilityState.disabled` on the
  // rendered host node rather than forwarding the raw `disabled` prop.
  expect(screen.getByLabelText('Add split to Splitwise').props.accessibilityState.disabled).toBe(true);
});

test('queues the create with the reconciled receipt shares when the receipt total matches the charge', async () => {
  mockScanReceipt.mockResolvedValue({ status: 'ok', receipt: scannedReceipt });
  render(
    <FriendPickerSheet
      transaction={{ ...tx, id: 'txR4', amount: 39, status: 'new' }}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByText('Receipt'));
  fireEvent.press(screen.getByLabelText('Choose photo'));

  await screen.findByLabelText('Assign to everyone');
  fireEvent.press(screen.getByLabelText('Assign to everyone'));

  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockEnqueueOp).toHaveBeenCalledTimes(1));
  expect(lastEnqueuedPayload()).toEqual(
    expect.objectContaining({ amount: 39, friendShares: { '2': 19.5 } })
  );
});

test('reconciliation auto-enables and charges the receipt total when it exceeds the transaction amount', async () => {
  mockScanReceipt.mockResolvedValue({ status: 'ok', receipt: scannedReceipt });
  // Transaction ($20) is charged less than the receipt totals to ($39), so the
  // itemized total exceeds the bank charge and the auto-toggle should fire.
  render(
    <FriendPickerSheet
      transaction={{ ...tx, id: 'txR6', amount: 20, status: 'new' }}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByText('Receipt'));
  fireEvent.press(screen.getByLabelText('Choose photo'));

  // The reconciliation total only counts *assigned* items (see
  // computeReceiptShares in lib/receipt.ts, which skips unassigned items
  // before accumulating itemsTotalCents) - so the item must be assigned
  // before the itemized total can exceed the charged amount and trip the
  // auto-toggle.
  await screen.findByLabelText('Assign to everyone');
  fireEvent.press(screen.getByLabelText('Assign to everyone'));

  await waitFor(() =>
    expect(
      screen.getByLabelText('Charge the receipt total instead of the bank amount').props.accessibilityState
        .checked
    ).toBe(true)
  );

  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));

  await waitFor(() => expect(mockEnqueueOp).toHaveBeenCalledTimes(1));
  expect(lastEnqueuedPayload()).toEqual(expect.objectContaining({ amount: 39 }));
});
