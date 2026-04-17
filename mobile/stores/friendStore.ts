// mobile/stores/friendStore.ts
import { create } from 'zustand';
import { getFriends } from '@/lib/splitwise';
import { SplitwiseFriend } from '@/lib/types';

interface FriendState {
  friends: SplitwiseFriend[];
  isLoading: boolean;
  load: () => Promise<void>;
  clear: () => void;
}

export const useFriendStore = create<FriendState>((set, get) => ({
  friends: [],
  isLoading: false,

  load: async () => {
    if (get().friends.length > 0) return;
    set({ isLoading: true });
    try {
      const friends = await getFriends();
      set({ friends, isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  clear: () => set({ friends: [] }),
}));
