// mobile/stores/transactionStore.ts
import { create } from 'zustand';
import { fetchTransactions, WorkerError } from '@/lib/worker';
import { deleteExpense } from '@/lib/splitwise';
import {
  getNewTransactions,
  upsertTransactions,
  updateTransactionStatus,
  deleteSplitDecision,
  persistCombinedSplit,
  revertCombinedSplit,
  rekeyTransaction,
  markTransactionsReversed,
  getReviewTransactions,
  clearReview,
  getMerchantBuckets,
  setTransactionBucket,
} from '@/lib/db';
import { Transaction, SplitDecision, ReviewItem } from '@/lib/types';
import { Bucket } from '@/lib/buckets';
import { usePlaidStore } from '@/stores/plaidStore';
import { useVacationStore } from '@/stores/vacationStore';

interface TransactionState {
  transactions: Transaction[];
  isLoading: boolean;
  review: ReviewItem[];
  merchantBuckets: Record<string, Bucket>;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  skip: (id: string) => Promise<void>;
  markSplit: (id: string) => Promise<void>;
  commitCombinedSplit: (decisions: SplitDecision[]) => Promise<void>;
  deleteSplit: (transactionId: string, splitwiseExpenseId: string) => Promise<void>;
  deleteCombinedSplit: (transactionIds: string[], splitwiseExpenseId: string) => Promise<void>;
  loadReview: () => Promise<void>;
  resolveReview: (transactionIds: string[]) => Promise<void>;
  setBucket: (ids: string[], bucket: Bucket) => Promise<void>;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactions: [],
  isLoading: false,
  review: [],
  merchantBuckets: {},

  load: async () => {
    set({ isLoading: true });
    const [rows, merchantBuckets] = await Promise.all([
      getNewTransactions(),
      getMerchantBuckets(),
    ]);
    set({ transactions: rows, merchantBuckets, isLoading: false });
  },

  refresh: async () => {
    set({ isLoading: true });
    try {
      await useVacationStore.getState().reconcile();
      const activeVacationId = useVacationStore.getState().activeVacation?.id ?? null;
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
            const all = [...res.added, ...res.modified];
            // 1. Rekey pending → posted BEFORE inserting anything, so the posted row
            //    inherits status / vacation_id / split decision instead of arriving new.
            const consumed = new Set<string>();
            for (const tx of all) {
              if (!tx.pending_transaction_id) continue;
              const result = await rekeyTransaction(tx.pending_transaction_id, tx);
              if (result !== 'not_found') consumed.add(tx.pending_transaction_id);
            }
            // 2. Upsert. Rekeyed rows already carry the posted id, so INSERT OR IGNORE
            //    no-ops and the status-gated UPDATE leaves split rows alone.
            await upsertTransactions(all, activeVacationId);
            // 3. Delete removals, minus ids a rekey already consumed and minus ids that
            //    reappear in this page's added/modified — some institutions reuse the
            //    transaction id, and deleting there would drop the row we just kept.
            const addedIds = new Set(all.map((t) => t.transaction_id));
            const toRemove = res.removed
              .map((r) => r.transaction_id)
              .filter((rid) => !consumed.has(rid) && !addedIds.has(rid));
            await markTransactionsReversed(toRemove);
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

  commitCombinedSplit: async (decisions) => {
    // Persist all member rows + statuses atomically, then drop them from the list.
    await persistCombinedSplit(decisions);
    const ids = new Set(decisions.map((d) => d.transaction_id));
    set((s) => ({ transactions: s.transactions.filter((t) => !ids.has(t.id)) }));
  },

  deleteSplit: async (transactionId, splitwiseExpenseId) => {
    // Splitwise first: if it fails we make no local change, so the two stay in sync.
    await deleteExpense(splitwiseExpenseId);
    await deleteSplitDecision(transactionId);
    await updateTransactionStatus(transactionId, 'new');
    await get().load();
  },

  deleteCombinedSplit: async (transactionIds, splitwiseExpenseId) => {
    // Delete the shared Splitwise expense once, then revert every member locally
    // in a single transaction so a failure can't leave the group half-reverted.
    await deleteExpense(splitwiseExpenseId);
    await revertCombinedSplit(transactionIds);
    await get().load();
  },

  loadReview: async () => {
    const items = await getReviewTransactions();
    set({ review: items });
  },

  resolveReview: async (transactionIds) => {
    await clearReview(transactionIds);
    await get().loadReview();
  },

  // Takes a list because a combined split is one row over several
  // transactions, and re-tagging it moves every member.
  setBucket: async (ids, bucket) => {
    try {
      for (const id of ids) await setTransactionBucket(id, bucket);
    } finally {
      // Reload regardless of success or a mid-loop failure, so a partial
      // write (some ids succeeded before one threw) is reflected in the UI
      // instead of silently showing stale data for a row that's now
      // actually mixed.
      await get().load();
    }
  },
}));
