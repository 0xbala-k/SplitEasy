// mobile/__tests__/app/root-layout.test.tsx
jest.mock('expo-router', () => ({
  // A stand-in for whatever route is being rendered, so the test can assert
  // whether children mounted at all.
  Slot: () => {
    const { Text } = require('react-native');
    return <Text>ROUTE CONTENT</Text>;
  },
  SplashScreen: { preventAutoHideAsync: jest.fn(), hideAsync: jest.fn() },
}));
jest.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
// GestureHandlerRootView reaches for the native module on mount, which is not
// installed in the jest-expo environment.
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('@/lib/db', () => ({ initDb: jest.fn() }));
jest.mock('@/stores/authStore', () => ({ useAuthStore: jest.fn() }));
jest.mock('@/stores/plaidStore', () => ({ usePlaidStore: jest.fn() }));

import { render, screen, waitFor, act } from '@testing-library/react-native';
import RootLayout from '@/app/_layout';
import { initDb } from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

const mockInitDb = initDb as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  (useAuthStore as unknown as jest.Mock).mockReturnValue({ hydrate: jest.fn().mockResolvedValue(undefined) });
  (usePlaidStore as unknown as jest.Mock).mockReturnValue({ hydrate: jest.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

test('no route renders until the database has opened', async () => {
  // Held open, standing in for the real async open.
  let resolveInit: () => void = () => {};
  mockInitDb.mockReturnValue(new Promise<void>((res) => { resolveInit = res; }));

  render(<RootLayout />);

  // The regression: routes query the DB from their mount effects, so a route
  // that mounts in this window throws "DB not initialized" and renders empty.
  // That is what a deep link or a browser refresh does.
  expect(screen.queryByText('ROUTE CONTENT')).toBeNull();
  expect(screen.getByLabelText('SplitEasy startup')).toBeTruthy();

  await act(async () => { resolveInit(); });

  expect(screen.getByText('ROUTE CONTENT')).toBeTruthy();
});

test('a database that fails to open still lets the app render', async () => {
  mockInitDb.mockRejectedValue(new Error('quota exceeded'));

  render(<RootLayout />);

  // Gating on "settled" rather than "succeeded" — otherwise a failed open
  // strands the user on the startup screen with no way forward.
  await waitFor(() => expect(screen.getByText('ROUTE CONTENT')).toBeTruthy());
});

test('the database is opened exactly once', async () => {
  mockInitDb.mockResolvedValue(undefined);

  render(<RootLayout />);

  await waitFor(() => expect(screen.getByText('ROUTE CONTENT')).toBeTruthy());
  expect(mockInitDb).toHaveBeenCalledTimes(1);
});
