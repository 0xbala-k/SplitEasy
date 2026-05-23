// mobile/stores/plaidStore.ts
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { exchangePublicToken } from '@/lib/worker';
import { deleteAllTransactions } from '@/lib/db';

export interface PlaidAccount {
  id: string;
  institution_name: string;
}

const ACCOUNTS_KEY = 'plaid_accounts';
const tokenKey = (id: string) => `plaid_token_${id}`;
const cursorKey = (id: string) => `plaid_cursor_${id}`;

interface PlaidState {
  accounts: PlaidAccount[];
  needs_reauth: boolean;
  isLinked: boolean;
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  linkBank: (public_token: string, institution_name: string) => Promise<void>;
  disconnect: (id?: string) => Promise<void>;
  setNeedsReauth: (value: boolean) => Promise<void>;
  getTokensAndCursors: () => Promise<Array<{ id: string; access_token: string; cursor: string | null }>>;
  saveCursor: (id: string, cursor: string) => Promise<void>;
}

export const usePlaidStore = create<PlaidState>((set, get) => ({
  accounts: [],
  needs_reauth: false,
  isLinked: false,
  isHydrated: false,

  hydrate: async () => {
    const needsReauthRaw = await AsyncStorage.getItem('plaid_needs_reauth');

    // New multi-account format
    const accountsRaw = await AsyncStorage.getItem(ACCOUNTS_KEY);
    if (accountsRaw) {
      const accounts: PlaidAccount[] = JSON.parse(accountsRaw);
      set({ accounts, isLinked: accounts.length > 0, needs_reauth: needsReauthRaw === 'true', isHydrated: true });
      return;
    }

    // Migrate from legacy single-account format
    const oldToken = await SecureStore.getItemAsync('plaid_access_token');
    const oldName = await AsyncStorage.getItem('plaid_institution_name');
    if (oldToken) {
      const id = `acct_${Date.now()}`;
      await SecureStore.setItemAsync(tokenKey(id), oldToken);
      await SecureStore.deleteItemAsync('plaid_access_token');
      const oldCursor = await AsyncStorage.getItem('last_plaid_cursor');
      if (oldCursor) {
        await AsyncStorage.setItem(cursorKey(id), oldCursor);
        await AsyncStorage.removeItem('last_plaid_cursor');
      }
      await AsyncStorage.removeItem('plaid_institution_name');
      const accounts = [{ id, institution_name: oldName ?? 'Connected bank' }];
      await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
      set({ accounts, isLinked: true, needs_reauth: needsReauthRaw === 'true', isHydrated: true });
      return;
    }

    set({ accounts: [], isLinked: false, needs_reauth: needsReauthRaw === 'true', isHydrated: true });
  },

  linkBank: async (public_token, institution_name) => {
    const res = await exchangePublicToken(public_token);
    const id = `acct_${Date.now()}`;
    await SecureStore.setItemAsync(tokenKey(id), res.access_token);
    const accounts = [...get().accounts, { id, institution_name }];
    await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
    set({ accounts, isLinked: true });
  },

  disconnect: async (id?: string) => {
    const { accounts } = get();

    if (id) {
      await SecureStore.deleteItemAsync(tokenKey(id));
      await AsyncStorage.removeItem(cursorKey(id));
      const remaining = accounts.filter((a) => a.id !== id);
      await AsyncStorage.setItem(ACCOUNTS_KEY, JSON.stringify(remaining));
      if (remaining.length === 0) {
        await deleteAllTransactions();
        await AsyncStorage.removeItem('plaid_needs_reauth');
      }
      set({ accounts: remaining, isLinked: remaining.length > 0, needs_reauth: remaining.length > 0 ? get().needs_reauth : false });
    } else {
      for (const acct of accounts) {
        await SecureStore.deleteItemAsync(tokenKey(acct.id));
        await AsyncStorage.removeItem(cursorKey(acct.id));
      }
      await AsyncStorage.multiRemove([ACCOUNTS_KEY, 'plaid_needs_reauth']);
      await deleteAllTransactions();
      set({ accounts: [], isLinked: false, needs_reauth: false });
    }
  },

  setNeedsReauth: async (value) => {
    await AsyncStorage.setItem('plaid_needs_reauth', String(value));
    set({ needs_reauth: value });
  },

  getTokensAndCursors: async () => {
    const { accounts } = get();
    return Promise.all(
      accounts.map(async (acct) => ({
        id: acct.id,
        access_token: (await SecureStore.getItemAsync(tokenKey(acct.id))) ?? '',
        cursor: await AsyncStorage.getItem(cursorKey(acct.id)),
      }))
    );
  },

  saveCursor: async (id, cursor) => {
    await AsyncStorage.setItem(cursorKey(id), cursor);
  },
}));
