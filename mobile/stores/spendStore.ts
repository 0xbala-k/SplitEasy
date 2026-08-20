// mobile/stores/spendStore.ts
import { create } from 'zustand';
import { getSpendingRows, setTransactionBucket } from '@/lib/db';
import { Bucket, BucketGroup } from '@/lib/buckets';
import {
  SpendRow, MonthSpend, aggregateMonth, availableMonths,
} from '@/lib/spend';

interface SpendState {
  rows: SpendRow[];
  months: string[];             // newest first
  monthKey: string;
  drill: BucketGroup | null;    // null = top level
  isLoading: boolean;
  load: () => Promise<void>;
  selectMonth: (monthKey: string) => void;
  stepMonth: (delta: number) => void;
  setDrill: (group: BucketGroup | null) => void;
  setBucket: (ids: string[], bucket: Bucket) => Promise<void>;
  current: () => MonthSpend;
}

export const useSpendStore = create<SpendState>((set, get) => ({
  rows: [],
  months: [],
  monthKey: '',
  drill: null,
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    const rows = await getSpendingRows();
    const months = availableMonths(rows);
    const previous = get().monthKey;
    // Keep the month the user was looking at if it still has data; otherwise
    // fall back to the newest one.
    const monthKey = months.includes(previous) ? previous : (months[0] ?? '');
    // Any reload can change which buckets exist, so return to the top level
    // rather than leaving the user drilled into a group that is now empty.
    set({ rows, months, monthKey, drill: null, isLoading: false });
  },

  selectMonth: (monthKey) => set({ monthKey, drill: null }),

  // delta > 0 moves toward the present. `months` is newest-first, so a step
  // toward the present is a step *down* the array.
  stepMonth: (delta) => {
    const { months, monthKey } = get();
    const i = months.indexOf(monthKey);
    if (i === -1) return;
    const next = Math.min(months.length - 1, Math.max(0, i - delta));
    set({ monthKey: months[next], drill: null });
  },

  setDrill: (group) => set({ drill: group }),

  // Takes a list because a combined split is one row over several
  // transactions, and re-tagging it moves every member.
  setBucket: async (ids, bucket) => {
    for (const id of ids) await setTransactionBucket(id, bucket);
    await get().load();
  },

  current: () => aggregateMonth(get().rows, get().monthKey),
}));
