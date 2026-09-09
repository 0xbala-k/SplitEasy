import { render, waitFor } from '@testing-library/react-native';
import Index from '@/app/index';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace }),
  SplashScreen: { hideAsync: jest.fn(), preventAutoHideAsync: jest.fn() },
}));

describe('root routing', () => {
  beforeEach(() => mockReplace.mockClear());

  it('reaches the tabs when the session exists but the token is dead', async () => {
    useAuthStore.setState({ hasSession: true, tokenValid: false, isHydrated: true });
    usePlaidStore.setState({ isLinked: true, isHydrated: true });

    render(<Index />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(tabs)/'));
  });

  it('sends a device with no session to the welcome screen', async () => {
    useAuthStore.setState({ hasSession: false, tokenValid: false, isHydrated: true });
    usePlaidStore.setState({ isLinked: true, isHydrated: true });

    render(<Index />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/(auth)/'));
  });
});
