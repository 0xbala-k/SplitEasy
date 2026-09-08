import { render, screen } from '@testing-library/react-native';
import { SplitwiseStatusBanner } from '@/components/SplitwiseStatusBanner';
import { useAuthStore } from '@/stores/authStore';

describe('SplitwiseStatusBanner', () => {
  it('renders nothing while the token is valid', () => {
    useAuthStore.setState({ tokenValid: true, lastReconnectAt: null });
    render(<SplitwiseStatusBanner />);
    expect(screen.queryByTestId('splitwise-status-banner')).toBeNull();
  });

  it('offers reconnect on a first failure and reassures about local data', () => {
    useAuthStore.setState({ tokenValid: false, lastReconnectAt: null });
    render(<SplitwiseStatusBanner />);
    expect(screen.getByTestId('splitwise-status-banner')).toBeTruthy();
    expect(screen.getByText(/safe on this device/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /reconnect/i })).toBeTruthy();
  });

  it('names the Pro subscription when a fresh token still fails', () => {
    // Failure observed AFTER the most recent OAuth: the token cannot be stale,
    // so reconnecting again would loop.
    useAuthStore.setState({
      tokenValid: false,
      lastReconnectAt: new Date(Date.now() - 1000).toISOString(),
    });
    render(<SplitwiseStatusBanner />);
    expect(screen.getByText(/Pro subscription/i)).toBeTruthy();
    expect(screen.getByText(/safe on this device/i)).toBeTruthy();
  });
});
