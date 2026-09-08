// mobile/stores/friendStore.ts
import { create } from 'zustand';
import { getFriends, SplitwiseAuthError } from '@/lib/splitwise';
import { SplitwiseFriend } from '@/lib/types';
import { useAuthStore } from '@/stores/authStore';

interface FriendState {
  friends: SplitwiseFriend[];
  isLoading: boolean;
  load: () => Promise<void>;
  clear: () => void;
}

export const useFriendStore = create<FriendState>((set) => ({
  friends: [],
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    try {
      const friends = await getFriends();
      set({ friends, isLoading: false });
      useAuthStore.getState().reportAuthSuccess();
    } catch (err) {
      set({ isLoading: false });
      // Only an auth failure raises the flag. A transient error must not tell
      // the user to reconnect — but it must not be silent either, which is what
      // the previous bare `catch` did.
      if (err instanceof SplitwiseAuthError) {
        useAuthStore.getState().reportAuthFailure();
      } else {
        console.error('Failed to load Splitwise friends', err);
      }
    }
  },

  clear: () => set({ friends: [] }),
}));
