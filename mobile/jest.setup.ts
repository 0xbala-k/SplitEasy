jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// Render icon families as no-op components so component tests don't pull in
// expo-font's native font loader (which throws in the jest-expo environment).
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));

// Screens that pad around the notch/home indicator call useSafeAreaInsets, which
// throws without a provider above it. Tests render screens in isolation, so stub
// the whole module here rather than wrapping every render in a provider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
  SafeAreaView: ({ children }: { children: React.ReactNode }) => children,
}));
