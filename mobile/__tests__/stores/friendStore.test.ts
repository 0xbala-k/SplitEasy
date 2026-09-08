// mobile/__tests__/stores/friendStore.test.ts
jest.mock('@/lib/splitwise');

import * as splitwise from '@/lib/splitwise';
import { useFriendStore } from '@/stores/friendStore';
import { useAuthStore } from '@/stores/authStore';
import { getFriends, SplitwiseAuthError } from '@/lib/splitwise';

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

test('load re-fetches even when friends are already cached, so a fixed token recovers within the session', async () => {
  useFriendStore.setState({
    friends: [{ id: '1', display_name: 'Cached Friend', avatar_url: null }],
  });
  mockGetFriends.mockResolvedValue([{ id: '2', display_name: 'New Friend', avatar_url: null }]);
  await useFriendStore.getState().load();
  expect(mockGetFriends).toHaveBeenCalled();
  expect(useFriendStore.getState().friends).toEqual([{ id: '2', display_name: 'New Friend', avatar_url: null }]);
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

describe('friendStore auth reporting', () => {
  beforeEach(() => {
    useFriendStore.setState({ friends: [], isLoading: false });
    useAuthStore.setState({ hasSession: true, tokenValid: true });
    jest.clearAllMocks();
  });

  it('reports a 401 instead of swallowing it', async () => {
    (getFriends as jest.Mock).mockRejectedValue(new SplitwiseAuthError());

    await useFriendStore.getState().load();

    // The bug this replaces: a bare catch left tokenValid true and the list
    // empty, so the failure was indistinguishable from "no friends".
    expect(useAuthStore.getState().tokenValid).toBe(false);
  });

  it('reports success so the banner clears', async () => {
    useAuthStore.setState({ tokenValid: false });
    (getFriends as jest.Mock).mockResolvedValue([
      { id: '1', display_name: 'A', avatar_url: null },
    ]);

    await useFriendStore.getState().load();

    expect(useAuthStore.getState().tokenValid).toBe(true);
  });

  it('leaves tokenValid alone for a non-auth failure', async () => {
    (getFriends as jest.Mock).mockRejectedValue(new Error('SPLITWISE_ERROR'));

    await useFriendStore.getState().load();

    // A 500 or a network blip is not an auth problem and must not tell the
    // user to reconnect.
    expect(useAuthStore.getState().tokenValid).toBe(true);
  });
});
