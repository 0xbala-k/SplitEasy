// mobile/stores/authStore.ts
import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { exchangeSplitwiseCode } from '@/lib/worker';
import { getSecure, setSecure, deleteSecure, KEYS } from '@/lib/secure';

// Where the Splitwise expenses poll left off. Lives in AsyncStorage beside
// splitwise_user_id; signOut clears it so a different account doesn't resume
// from this one's position. Defined here (not in transactionStore, which
// imports this module for user_id) to avoid a circular import.
export const SPLITWISE_WATERMARK_KEY = 'splitwise_expenses_watermark';

interface AuthState {
  user_id: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /**
   * This device has been set up. Derived from splitwise_user_id, NOT from the
   * token — it must survive token death so a user with a dead token still
   * reaches their local data instead of the welcome screen.
   */
  hasSession: boolean;
  /**
   * A token exists and has not been observed to be rejected. Gates sync only.
   * MUST NOT gate routing.
   */
  tokenValid: boolean;
  /** When OAuth last completed. Lets the UI tell a stale token from a Pro lapse. */
  lastReconnectAt: string | null;
  isHydrated: boolean;
  hydrate: () => Promise<void>;
  signIn: (code: string, redirect_uri: string) => Promise<void>;
  signOut: () => Promise<void>;
  reportAuthFailure: () => void;
  reportAuthSuccess: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user_id: null,
  display_name: null,
  avatar_url: null,
  hasSession: false,
  tokenValid: false,
  lastReconnectAt: null,
  isHydrated: false,

  hydrate: async () => {
    const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
    const user_id = await AsyncStorage.getItem('splitwise_user_id');
    const display_name = await AsyncStorage.getItem('splitwise_display_name');
    const avatar_url = await AsyncStorage.getItem('splitwise_avatar_url');
    const lastReconnectAt = await AsyncStorage.getItem('splitwise_last_reconnect_at');
    set({
      hasSession: !!user_id,
      tokenValid: !!token,
      user_id,
      display_name,
      avatar_url,
      lastReconnectAt,
      isHydrated: true,
    });
  },

  signIn: async (code, redirect_uri) => {
    // Read the prior user BEFORE writing, so a reconnect by the same account
    // can be told from a genuine account switch.
    const priorUserId = await AsyncStorage.getItem('splitwise_user_id');
    const res = await exchangeSplitwiseCode(code, redirect_uri);
    await setSecure(KEYS.SPLITWISE_ACCESS_TOKEN, res.access_token);
    const lastReconnectAt = new Date().toISOString();
    await AsyncStorage.multiSet([
      ['splitwise_user_id', res.user_id],
      ['splitwise_display_name', res.display_name],
      ['splitwise_avatar_url', res.avatar_url ?? ''],
      ['splitwise_last_reconnect_at', lastReconnectAt],
    ]);
    // Same account reconnecting: keep the watermark so the inbox resumes where
    // it left off instead of re-pulling every expense. A different account must
    // not inherit this one's position.
    if (priorUserId && priorUserId !== res.user_id) {
      await AsyncStorage.removeItem(SPLITWISE_WATERMARK_KEY);
    }
    set({
      hasSession: true,
      tokenValid: true,
      lastReconnectAt,
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
      'splitwise_last_reconnect_at',
      SPLITWISE_WATERMARK_KEY,
    ]);
    set({
      hasSession: false, tokenValid: false, lastReconnectAt: null,
      user_id: null, display_name: null, avatar_url: null,
    });
  },

  // Splitwise returns a bare 401 for BOTH an expired token and a lapsed Pro
  // subscription, so this records only the observable fact. The UI decides how
  // to describe it (see SplitwiseStatusBanner).
  reportAuthFailure: () => set({ tokenValid: false }),
  reportAuthSuccess: () => {
    if (!get().tokenValid) set({ tokenValid: true });
  },
}));
