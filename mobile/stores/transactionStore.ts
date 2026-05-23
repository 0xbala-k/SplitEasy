// mobile/stores/transactionStore.ts
import { create } from 'zustand';
import { fetchTransactions, WorkerError } from '@/lib/worker';
import {
  getNewTransactions,
  upsertTransactions,
  deleteTransactionsByPlaidIds,
  updateTransactionStatus,
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
        const res = await fetchTransactions(access_token, cursor ?? undefined);
        await upsertTransactions([...res.added, ...res.modified]);
        await deleteTransactionsByPlaidIds(res.removed.map((r) => r.transaction_id));
        await usePlaidStore.getState().saveCursor(id, res.next_cursor);
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
}));
