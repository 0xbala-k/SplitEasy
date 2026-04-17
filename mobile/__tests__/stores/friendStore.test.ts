// mobile/__tests__/stores/friendStore.test.ts
jest.mock('@/lib/splitwise');

import * as splitwise from '@/lib/splitwise';
import { useFriendStore } from '@/stores/friendStore';

const mockGetFriends = splitwise.getFriends as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  useFriendStore.setState({ friends: [], isLoading: false });
});

test('load populates friends from Splitwise', async () => {
  mockGetFriends.mockResolvedValue([
    { id: '123', display_name: 'Alex Kim', avatar_url: null },
    { id: '456', display_name: 'Sam Lee', avatar_url: 'https://img/sam' },
  ]);
  await useFriendStore.getState().load();
  expect(useFriendStore.getState().friends).toHaveLength(2);
  expect(useFriendStore.getState().friends[0].id).toBe('123');
  expect(useFriendStore.getState().isLoading).toBe(false);
});

test('load is a no-op when friends already cached', async () => {
  useFriendStore.setState({
    friends: [{ id: '1', display_name: 'Cached Friend', avatar_url: null }],
  });
  await useFriendStore.getState().load();
  expect(mockGetFriends).not.toHaveBeenCalled();
});

test('load sets isLoading during fetch', async () => {
  let resolveLoad!: (v: unknown) => void;
  mockGetFriends.mockReturnValue(new Promise((r) => (resolveLoad = r)));

  const promise = useFriendStore.getState().load();
  expect(useFriendStore.getState().isLoading).toBe(true);
  resolveLoad([]);
  await promise;
  expect(useFriendStore.getState().isLoading).toBe(false);
});

test('clear empties the friends list', () => {
  useFriendStore.setState({ friends: [{ id: '1', display_name: 'Alex', avatar_url: null }] });
  useFriendStore.getState().clear();
  expect(useFriendStore.getState().friends).toHaveLength(0);
});
