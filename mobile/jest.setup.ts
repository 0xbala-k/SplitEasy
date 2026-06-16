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
