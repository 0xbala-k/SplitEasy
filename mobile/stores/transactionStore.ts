// mobile/stores/transactionStore.ts
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchTransactions, WorkerError } from '@/lib/worker';
import { deleteExpense, getExpensesUpdatedAfter, SplitwiseAuthError } from '@/lib/splitwise';
import { decideInboxAction } from '@/lib/splitwiseInbox';
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
  getSplitwiseInbox,
  upsertInboxItem,
  dismissInboxItem as dbDismissInboxItem,
  getLocalExpenseState,
  acceptSplitwiseExpense,
  updateImportedExpense,
  deleteImportedExpense,
} from '@/lib/db';
import { Transaction, SplitDecision, ReviewItem, SplitwiseInboxItem } from '@/lib/types';
import { Bucket } from '@/lib/buckets';
import { usePlaidStore } from '@/stores/plaidStore';
import { useVacationStore } from '@/stores/vacationStore';
import { useAuthStore, SPLITWISE_WATERMARK_KEY } from '@/stores/authStore';

export { SPLITWISE_WATERMARK_KEY };

interface TransactionState {
  transactions: Transaction[];
  isLoading: boolean;
  review: ReviewItem[];
  merchantBuckets: Record<string, Bucket>;
  splitwiseInbox: SplitwiseInboxItem[];
  // Raised when the poll hits a 401. The Transactions screen reads it, toasts
  // once, and clears it — the store never shows UI itself.
  splitwiseAuthExpired: boolean;
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
  loadInbox: () => Promise<void>;
  syncSplitwiseInbox: () => Promise<void>;
  acceptInboxItem: (item: SplitwiseInboxItem, bucket: Bucket) => Promise<void>;
  dismissInboxItem: (expenseId: string) => Promise<void>;
  clearSplitwiseAuthExpired: () => void;
}

export const useTransactionStore = create<TransactionState>((set, get) => ({
  transactions: [],
  isLoading: false,
  review: [],
  merchantBuckets: {},
  splitwiseInbox: [],
  splitwiseAuthExpired: false,

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
      await get().syncSplitwiseInbox();
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

  loadInbox: async () => {
    set({ splitwiseInbox: await getSplitwiseInbox() });
  },

  /**
   * Pull friend-paid Splitwise expenses since the last watermark.
   *
   * Every failure is swallowed: this runs at the tail of the Plaid refresh,
   * and a Splitwise outage or an expired Splitwise session must not cost the
   * user their Plaid sync. The watermark only advances on a clean pass, so a
   * failed pull is retried in full next time rather than skipping a window.
   */
  syncSplitwiseInbox: async () => {
    const myUserId = useAuthStore.getState().user_id;
    if (!myUserId) return;

    const startedAt = new Date().toISOString();
    const watermark = await AsyncStorage.getItem(SPLITWISE_WATERMARK_KEY);
    // First run: record where we are and import nothing, mirroring the Plaid
    // first-sync behaviour of draining the backlog without storing it.
    if (!watermark) {
      await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, startedAt);
      return;
    }

    try {
      const expenses = await getExpensesUpdatedAfter(watermark);
      for (const expense of expenses) {
        const local = await getLocalExpenseState(String(expense.id));
        const action = decideInboxAction(expense, myUserId, local);
        if (action.kind === 'offer') await upsertInboxItem(action.item);
        else if (action.kind === 'update') await updateImportedExpense(action.item);
        // No tombstone: the expense is gone upstream, so it can never be
        // re-offered and a marker would only accumulate.
        else if (action.kind === 'remove') await deleteImportedExpense(String(expense.id), false);
      }
      await AsyncStorage.setItem(SPLITWISE_WATERMARK_KEY, startedAt);
      await get().loadInbox();
    } catch (err) {
      // The screen owns the toast, so the store only raises a flag. Any other
      // error is intentionally silent: a Splitwise outage should not nag a
      // user who was only pulling to refresh their Plaid transactions.
      if (err instanceof SplitwiseAuthError) set({ splitwiseAuthExpired: true });
    }
  },

  clearSplitwiseAuthExpired: () => set({ splitwiseAuthExpired: false }),

  acceptInboxItem: async (item, bucket) => {
    const active = useVacationStore.getState().activeVacation;
    // A null group must never match a vacation with no group — that would
    // sweep every ordinary expense into the trip.
    const vacationId =
      active && active.splitwise_group_id && item.group_id === active.splitwise_group_id
        ? active.id
        : null;
    await acceptSplitwiseExpense(item, bucket, vacationId);
    set((s) => ({ splitwiseInbox: s.splitwiseInbox.filter((i) => i.expense_id !== item.expense_id) }));
  },

  dismissInboxItem: async (expenseId) => {
    await dbDismissInboxItem(expenseId);
    set((s) => ({ splitwiseInbox: s.splitwiseInbox.filter((i) => i.expense_id !== expenseId) }));
  },
}));
