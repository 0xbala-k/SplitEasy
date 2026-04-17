// mobile/stores/authStore.ts
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { exchangeSplitwiseCode } from '@/lib/worker';
import { getSecure, setSecure, deleteSecure, KEYS } from '@/lib/secure';

interface AuthState {
  user_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  isAuthenticated: boolean;
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  signIn: (code: string, redirect_uri: string) => Promise<void>;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user_id: null,
  display_name: null,
  avatar_url: null,
  isAuthenticated: false,
  isHydrated: false,

  hydrate: async () => {
    const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
    const user_id = await AsyncStorage.getItem('splitwise_user_id');
    const display_name = await AsyncStorage.getItem('splitwise_display_name');
    const avatar_url = await AsyncStorage.getItem('splitwise_avatar_url');
    set({ isAuthenticated: !!token, user_id, display_name, avatar_url, isHydrated: true });
  },

  signIn: async (code, redirect_uri) => {
    const res = await exchangeSplitwiseCode(code, redirect_uri);
    await setSecure(KEYS.SPLITWISE_ACCESS_TOKEN, res.access_token);
    await AsyncStorage.multiSet([
      ['splitwise_user_id', res.user_id],
      ['splitwise_display_name', res.display_name],
      ['splitwise_avatar_url', res.avatar_url ?? ''],
    ]);
    set({
      isAuthenticated: true,
      user_id: res.user_id,
      display_name: res.display_name,
      avatar_url: res.avatar_url,
    });
  },

  signOut: async () => {
    await deleteSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
    await AsyncStorage.multiRemove([
      'splitwise_user_id',
      'splitwise_display_name',
      'splitwise_avatar_url',
    ]);
    set({ isAuthenticated: false, user_id: null, display_name: null, avatar_url: null });
  },
}));
