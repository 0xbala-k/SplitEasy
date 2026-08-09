// mobile/app/_layout.tsx must render <Slot /> on its very first render:
// expo-router registers the root navigator there, and deferring it makes the
// first router.replace() throw "Attempted to navigate before mounting the Root
// Layout component" — which blanks the whole app, not just one route.
// Tracked on globalThis because a jest.mock factory may not close over
// module-scope variables.
type Probe = { rootRenders: number; slotFirstRender: boolean | null };
const probe = () => (globalThis as unknown as { __probe: Probe }).__probe;
(globalThis as unknown as { __probe: Probe }).__probe = { rootRenders: 0, slotFirstRender: null };

jest.mock('expo-router', () => ({
  Slot: () => {
    const { Text } = require('react-native');
    const p = (globalThis as unknown as { __probe: Probe }).__probe;
    if (p.slotFirstRender === null) p.slotFirstRender = p.rootRenders === 1;
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

import { render, screen, waitFor } from '@testing-library/react-native';
import RootLayout from '@/app/_layout';
import { initDb } from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';

const mockInitDb = initDb as jest.Mock;

// Counting root renders from the outside, so the Slot mock can tell whether it
// was reached on render #1.
function Counted() {
  probe().rootRenders += 1;
  return <RootLayout />;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  probe().rootRenders = 0;
  probe().slotFirstRender = null;
  (useAuthStore as unknown as jest.Mock).mockReturnValue({ hydrate: jest.fn().mockResolvedValue(undefined) });
  (usePlaidStore as unknown as jest.Mock).mockReturnValue({ hydrate: jest.fn().mockResolvedValue(undefined) });
});

afterEach(() => {
  (console.error as jest.Mock).mockRestore();
});

test('Slot renders on the first render, before the database has opened', () => {
  // Held open: the database is still opening while the tree first renders.
  mockInitDb.mockReturnValue(new Promise<void>(() => {}));

  render(<Counted />);

  expect(probe().slotFirstRender).toBe(true);
  expect(screen.getByText('ROUTE CONTENT')).toBeTruthy();
});

test('Slot still renders when the database fails to open', async () => {
  mockInitDb.mockRejectedValue(new Error('quota exceeded'));

  render(<Counted />);

  expect(screen.getByText('ROUTE CONTENT')).toBeTruthy();
  await waitFor(() => expect(console.error).toHaveBeenCalled());
  // Still mounted after the rejection is handled.
  expect(screen.getByText('ROUTE CONTENT')).toBeTruthy();
});

test('the database warm-up runs once', async () => {
  mockInitDb.mockResolvedValue(undefined);

  render(<Counted />);

  await waitFor(() => expect(mockInitDb).toHaveBeenCalledTimes(1));
});
