// mobile/stores/transactionStore.ts
import { create } from 'zustand';
import { fetchTransactions, WorkerError } from '@/lib/worker';
import { deleteExpense } from '@/lib/splitwise';
import {
  getNewTransactions,
  upsertTransactions,
  deleteTransactionsByPlaidIds,
  updateTransactionStatus,
  deleteSplitDecision,
} from '@/lib/db';
import { Transaction } from '@/lib/types';
import { usePlaidStore } from '@/stores/plaidStore';

interface TransactionState {
  transactions: Transaction[];
  isLoading: boolean;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  skip: (id: string) => Promise<void>;
  markSplit: (id: string) => Promise<void>;
  deleteSplit: (transactionId: string, splitwiseExpenseId: string) => Promise<void>;
  deleteCombinedSplit: (transactionIds: string[], splitwiseExpenseId: string) => Promise<void>;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactions: [],
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    const rows = await getNewTransactions();
    set({ transactions: rows, isLoading: false });
  },

  refresh: async () => {
    set({ isLoading: true });
    try {
      const tokensAndCursors = await usePlaidStore.getState().getTokensAndCursors();
      for (const { id, access_token, cursor } of tokensAndCursors) {
        if (!access_token) continue;
        // First sync (no cursor): drain Plaid's historical backlog without
        // storing it, so only transactions made after connecting appear.
        const isFirstSync = cursor == null;
        let pageCursor = cursor ?? undefined;
        let hasMore = true;
        while (hasMore) {
          const res = await fetchTransactions(access_token, pageCursor);
          if (!isFirstSync) {
            await upsertTransactions([...res.added, ...res.modified]);
            await deleteTransactionsByPlaidIds(res.removed.map((r) => r.transaction_id));
            await usePlaidStore.getState().saveCursor(id, res.next_cursor);
          }
          pageCursor = res.next_cursor;
          hasMore = res.has_more;
        }
        if (isFirstSync && pageCursor) {
          await usePlaidStore.getState().saveCursor(id, pageCursor);
        }
      }
      await get().load();
    } catch (err) {
      if (err instanceof WorkerError && err.code === 'ITEM_LOGIN_REQUIRED') {
        usePlaidStore.getState().setNeedsReauth(true);
      }
      set({ isLoading: false });
    }
  },

  skip: async (id) => {
    await updateTransactionStatus(id, 'skipped');
    set((s) => ({ transactions: s.transactions.filter((t) => t.id !== id) }));
  },

  markSplit: async (id) => {
    await updateTransactionStatus(id, 'split');
    set((s) => ({ transactions: s.transactions.filter((t) => t.id !== id) }));
  },

  deleteSplit: async (transactionId, splitwiseExpenseId) => {
    // Splitwise first: if it fails we make no local change, so the two stay in sync.
    await deleteExpense(splitwiseExpenseId);
    await deleteSplitDecision(transactionId);
    await updateTransactionStatus(transactionId, 'new');
    await get().load();
  },

  deleteCombinedSplit: async (transactionIds, splitwiseExpenseId) => {
    // Delete the shared Splitwise expense once, then revert every member locally.
    // Members are independent, so run their reversions concurrently.
    await deleteExpense(splitwiseExpenseId);
    await Promise.all(
      transactionIds.map(async (id) => {
        await deleteSplitDecision(id);
        await updateTransactionStatus(id, 'new');
      })
    );
    await get().load();
  },
}));
