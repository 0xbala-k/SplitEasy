// mobile/stores/groupStore.ts
import { create } from 'zustand';
import { getGroups, SplitwiseAuthError } from '@/lib/splitwise';
import { getCachedGroups, replaceCachedGroups } from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';
import { SplitwiseGroup } from '@/lib/types';

interface GroupState {
  groups: SplitwiseGroup[];
  isLoading: boolean;
  /** Showing cached data because the last refresh failed. */
  isStale: boolean;
  load: () => Promise<void>;
  clear: () => void;
}

export const useGroupStore = create<GroupState>((set) => ({
  groups: [],
  isLoading: false,
  isStale: false,

  // Cache-first: render what we have, then refresh. No "already loaded, skip"
  // guard — the same reasoning as friendStore: that guard prevents recovery
  // within a session, and the cache makes re-entry cheap.
  load: async () => {
    set({ isLoading: true });

    try {
      const cached = await getCachedGroups();
      if (cached.length > 0) set({ groups: cached });
    } catch (e) {
      console.error('Failed to read cached groups', e);
    }

    try {
      const fresh = await getGroups();
      await replaceCachedGroups(fresh);
      set({ groups: fresh, isLoading: false, isStale: false });
      useAuthStore.getState().reportAuthSuccess();
    } catch (err) {
      // Keep whatever the cache gave us. An empty picker is strictly worse
      // than a slightly stale one.
      set({ isLoading: false, isStale: true });
      if (err instanceof SplitwiseAuthError) {
        useAuthStore.getState().reportAuthFailure();
      } else {
        console.error('Failed to refresh Splitwise groups', err);
      }
    }
  },

  clear: () => set({ groups: [], isStale: false }),
}));
