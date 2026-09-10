import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { showDialog } from '@/lib/dialog';
import {
  getSplitDecision, getTransactionsByIds, deleteImportedExpense, restoreTransaction,
} from '@/lib/db';
import { HistoryItem, SplitDecision, Transaction } from '@/lib/types';
import { useTransactionStore } from '@/stores/transactionStore';
import { useToast } from '@/components/ToastProvider';

export type SplitEditorMode = 'default' | 'readOnly' | 'excluded';

export interface SplitEditorOptions {
  /** Reload the host's list after any write. */
  onChange: () => void | Promise<void>;
  /**
   * Which action-sheet variant an item gets. Defaults to 'readOnly' for a
   * row imported from Splitwise and 'default' for everything else; History
   * overrides it to 'excluded' while its Excluded filter is on.
   */
  resolveMode?: (item: HistoryItem) => SplitEditorMode;
}

// Adapt a single-split HistoryItem back to a Transaction for the picker's
// single-edit / split-from-skipped flows. Carries the real currency so re-saving
// preserves the Splitwise currency_code. pending/created_at don't affect the
// expense, so safe defaults are fine.
function asTransaction(item: HistoryItem): Transaction {
  return {
    id: item.id,
    merchant_name: item.merchant_name,
    amount: item.amount,
    currency: item.currency,
    date: item.date,
    status: item.status,
    pending: false,
    created_at: item.date,
  };
}

// A row imported from Splitwise: someone else paid, so it is read-only here.
function isImported(item: HistoryItem): boolean {
  return item.source === 'splitwise';
}

/**
 * The split-editing plumbing shared by the History tab and the vacation
 * detail page: which row is selected, presenting the right sheet once it has
 * rendered, and the edit / delete / restore writes with their error handling.
 *
 * `onChange` is the host's own list reload, because each screen keeps its own
 * list state — the same arrangement useBucketEditor uses.
 */
export function useSplitEditor({ onChange, resolveMode }: SplitEditorOptions) {
  const [selected, setSelected] = useState<HistoryItem | null>(null);
  const [editDecision, setEditDecision] = useState<SplitDecision | null>(null);
  const [combineTxs, setCombineTxs] = useState<Transaction[] | null>(null);
  const [pickerMode, setPickerMode] = useState<'create' | 'edit'>('create');
  const [pending, setPending] = useState<null | 'picker' | 'action'>(null);
  const [pickerToken, setPickerToken] = useState(0);
  const pickerRef = useRef<BottomSheetModal>(null);
  const actionRef = useRef<BottomSheetModal>(null);
  const deleteSplit = useTransactionStore((s) => s.deleteSplit);
  const deleteCombinedSplit = useTransactionStore((s) => s.deleteCombinedSplit);
  const toast = useToast();

  // Present sheets from an effect (after the modal has mounted), not
  // synchronously in the tap handler — on the first tap the modal ref is
  // still null otherwise.
  useEffect(() => {
    if (pending === 'picker') {
      pickerRef.current?.present();
      setPending(null);
    } else if (pending === 'action') {
      actionRef.current?.present();
      setPending(null);
    }
  }, [pending]);

  const mode: SplitEditorMode = selected
    ? resolveMode?.(selected) ?? (isImported(selected) ? 'readOnly' : 'default')
    : 'default';

  const openFor = useCallback((item: HistoryItem) => {
    const itemMode = resolveMode?.(item) ?? (isImported(item) ? 'readOnly' : 'default');
    if (itemMode !== 'default' || item.status !== 'skipped') {
      // Split, imported, or excluded: offer the action sheet.
      setSelected(item);
      if (itemMode !== 'default') {
        // readOnly/excluded rows never offer Edit, so the picker stays
        // unopened here — but reset away from the leftover 'create' default
        // so pickerProps.mode doesn't misreport "about to create a split"
        // for a row the picker was never going to touch.
        setPickerMode('edit');
      }
      setPending('action');
      return;
    }
    // Split a previously-skipped transaction (create mode).
    setEditDecision(null);
    setCombineTxs(null);
    setPickerMode('create');
    setSelected(item);
    setPickerToken((t) => t + 1);
    setPending('picker');
  }, [resolveMode]);

  const handleEdit = useCallback(async () => {
    if (!selected) return;
    if (selected.combined) {
      // Combined split: load all member transactions + the shared decision
      // (any member's row carries the shared expense id, friends, description).
      const [members, decision] = await Promise.all([
        getTransactionsByIds(selected.combined.transaction_ids),
        getSplitDecision(selected.combined.transaction_ids[0]),
      ]);
      if (!decision || members.length === 0) {
        toast.show('Could not load this split. Please try again.', 'error');
        return;
      }
      actionRef.current?.dismiss();
      setCombineTxs(members);
      setEditDecision(decision);
      setPickerMode('edit');
      setPickerToken((t) => t + 1);
      setPending('picker');
      return;
    }
    const decision = await getSplitDecision(selected.id);
    if (!decision) {
      toast.show('Could not load this split. Please try again.', 'error');
      return;
    }
    actionRef.current?.dismiss();
    setCombineTxs(null);
    setEditDecision(decision);
    setPickerMode('edit');
    setPickerToken((t) => t + 1);
    setPending('picker');
  }, [selected, toast]);

  const handleDelete = useCallback(async () => {
    if (!selected) return;
    const item = selected;
    actionRef.current?.dismiss();

    if (isImported(item)) {
      showDialog(
        'Remove from SplitEasy?',
        'This removes it from SplitEasy and stops it counting toward your spending. The Splitwise expense is not affected.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Remove',
            style: 'destructive',
            onPress: async () => {
              try {
                // Tombstone so the next poll doesn't re-offer what the user
                // just removed. Deliberately no deleteExpense() call.
                await deleteImportedExpense(item.id.replace(/^sw:/, ''), true);
                toast.show('Removed', 'success');
                await onChange();
              } catch {
                toast.show('Failed to remove. Please try again.', 'error');
              }
            },
          },
        ]
      );
      return;
    }

    const label = item.combined ? `${item.combined.count} transactions` : item.merchant_name;
    showDialog(
      'Delete split?',
      `This removes the Splitwise expense for ${label} and moves ${item.combined ? 'them' : 'it'} back to your transactions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              if (item.combined) {
                await deleteCombinedSplit(item.combined.transaction_ids, item.combined.expense_id);
              } else {
                const decision = await getSplitDecision(item.id);
                if (!decision) {
                  toast.show('Could not load this split. Please try again.', 'error');
                  return;
                }
                // Non-null: the write path is still remote-first, so every persisted
                // SplitDecision has a real expense id until the edit path becomes
                // local-first too, at which point this needs a real guard.
                await deleteSplit(item.id, decision.splitwise_expense_id!);
              }
              toast.show('Split deleted', 'success');
              await onChange();
            } catch {
              toast.show('Failed to delete. Please try again.', 'error');
            }
          },
        },
      ]
    );
  }, [selected, deleteSplit, deleteCombinedSplit, onChange, toast]);

  const handleRestore = useCallback(async () => {
    if (!selected) return;
    const item = selected;
    actionRef.current?.dismiss();
    try {
      await restoreTransaction(item.id);
      toast.show('Restored', 'success');
      await onChange();
    } catch {
      toast.show('Failed to restore. Please try again.', 'error');
    }
  }, [selected, onChange, toast]);

  const handlePickerSuccess = useCallback(async () => {
    pickerRef.current?.dismiss();
    toast.show(pickerMode === 'edit' ? 'Split updated' : 'Split added', 'success');
    await onChange();
  }, [pickerMode, onChange, toast]);

  const pickerProps = useMemo(
    () => ({
      transaction:
        combineTxs || (selected && isImported(selected))
          ? null
          : selected
          ? asTransaction(selected)
          : null,
      combineTransactions: combineTxs ?? undefined,
      mode: pickerMode,
      editDecision,
      openToken: pickerToken,
      onSuccess: handlePickerSuccess,
    }),
    [combineTxs, selected, pickerMode, editDecision, pickerToken, handlePickerSuccess]
  );

  const actionProps = useMemo(
    () => ({
      transaction: selected,
      mode,
      onEdit: handleEdit,
      onDelete: handleDelete,
      onRestore: handleRestore,
    }),
    [selected, mode, handleEdit, handleDelete, handleRestore]
  );

  return { pickerRef, actionRef, openFor, pickerProps, actionProps };
}
