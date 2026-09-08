// mobile/stores/friendStore.ts
import { create } from 'zustand';
import { getFriends, SplitwiseAuthError } from '@/lib/splitwise';
import { getCachedFriends, replaceCachedFriends } from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';
import { SplitwiseFriend } from '@/lib/types';

interface FriendState {
  friends: SplitwiseFriend[];
  isLoading: boolean;
  /** Showing cached data because the last refresh failed. */
  isStale: boolean;
  load: () => Promise<void>;
  clear: () => void;
}

export const useFriendStore = create<FriendState>((set) => ({
  friends: [],
  isLoading: false,
  isStale: false,

  // Cache-first: render what we have, then refresh. There is deliberately no
  // "already loaded, skip" guard — that guard prevented recovery within a
  // session, and the cache makes re-entry cheap.
  load: async () => {
    set({ isLoading: true });

    try {
      const cached = await getCachedFriends();
      if (cached.length > 0) set({ friends: cached });
    } catch (e) {
      console.error('Failed to read cached friends', e);
    }

    try {
      const fresh = await getFriends();
      await replaceCachedFriends(fresh);
      set({ friends: fresh, isLoading: false, isStale: false });
      useAuthStore.getState().reportAuthSuccess();
    } catch (err) {
      // Keep whatever the cache gave us. An empty picker is strictly worse than
      // a slightly stale one.
      set({ isLoading: false, isStale: true });
      if (err instanceof SplitwiseAuthError) {
        useAuthStore.getState().reportAuthFailure();
      } else {
        console.error('Failed to refresh Splitwise friends', err);
      }
    }
  },

  clear: () => set({ friends: [], isStale: false }),
}));
