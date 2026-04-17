// mobile/stores/transactionStore.ts
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { KEYS } from '@/lib/secure';
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
      const accessToken = await SecureStore.getItemAsync(KEYS.PLAID_ACCESS_TOKEN);
      const cursor = await AsyncStorage.getItem('last_plaid_cursor');
      const res = await fetchTransactions(accessToken!, cursor ?? undefined);
      await upsertTransactions([...res.added, ...res.modified]);
      await deleteTransactionsByPlaidIds(res.removed.map((r) => r.transaction_id));
      await AsyncStorage.setItem('last_plaid_cursor', res.next_cursor);
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
