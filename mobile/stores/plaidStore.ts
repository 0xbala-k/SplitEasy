// mobile/stores/plaidStore.ts
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { exchangePublicToken } from '@/lib/worker';
import { getSecure, setSecure, deleteSecure, KEYS } from '@/lib/secure';
import { deleteAllTransactions } from '@/lib/db';

interface PlaidState {
  institution_name: string | null;
  needs_reauth: boolean;
  isLinked: boolean;
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  linkBank: (public_token: string, institution_name: string) => Promise<void>;
  disconnect: () => Promise<void>;
  setNeedsReauth: (value: boolean) => Promise<void>;
}

export const usePlaidStore = create<PlaidState>((set) => ({
  institution_name: null,
  needs_reauth: false,
  isLinked: false,
  isHydrated: false,

  hydrate: async () => {
    const token = await getSecure(KEYS.PLAID_ACCESS_TOKEN);
    const institution_name = await AsyncStorage.getItem('plaid_institution_name');
    const needsReauthRaw = await AsyncStorage.getItem('plaid_needs_reauth');
    set({
      isLinked: !!token,
      institution_name,
      needs_reauth: needsReauthRaw === 'true',
      isHydrated: true,
    });
  },

  linkBank: async (public_token, institution_name) => {
    const res = await exchangePublicToken(public_token);
    await setSecure(KEYS.PLAID_ACCESS_TOKEN, res.access_token);
    await AsyncStorage.multiSet([['plaid_institution_name', institution_name]]);
    await AsyncStorage.removeItem('last_plaid_cursor');
    set({ isLinked: true, institution_name });
  },

  disconnect: async () => {
    await deleteSecure(KEYS.PLAID_ACCESS_TOKEN);
    await deleteAllTransactions();
    await AsyncStorage.multiRemove([
      'plaid_institution_name',
      'plaid_needs_reauth',
      'last_plaid_cursor',
    ]);
    set({ isLinked: false, institution_name: null, needs_reauth: false });
  },

  setNeedsReauth: async (value) => {
    await AsyncStorage.setItem('plaid_needs_reauth', String(value));
    set({ needs_reauth: value });
  },
}));
