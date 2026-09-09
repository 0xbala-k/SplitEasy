// settings.tsx also renders usePlaidStore's account list, which (via
// disconnect -> deleteAllTransactions) pulls in @/lib/db -> expo-sqlite.
// Mock the whole module so importing plaidStore never reaches expo-sqlite.
jest.mock('@/lib/db', () => ({
  deleteAllTransactions: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

import { render, screen } from '@testing-library/react-native';
import SettingsScreen from '@/app/(tabs)/settings';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

beforeEach(() => {
  usePlaidStore.setState({
    accounts: [],
    needs_reauth: false,
    isLinked: false,
    isHydrated: false,
  });
});

describe('settings Splitwise status', () => {
  it('does not claim Connected while the API is failing', () => {
    useAuthStore.setState({ tokenValid: false, display_name: 'Bala', hasSession: true });
    render(<SettingsScreen />);
    expect(screen.queryByText('Connected')).toBeNull();
    expect(screen.getByText(/needs attention/i)).toBeTruthy();
  });

  it('shows Connected when the token works', () => {
    useAuthStore.setState({ tokenValid: true, display_name: 'Bala', hasSession: true });
    render(<SettingsScreen />);
    expect(screen.getByText('Connected')).toBeTruthy();
  });
});
