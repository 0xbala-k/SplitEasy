import { useGroupStore } from '@/stores/groupStore';
import { getGroups, SplitwiseAuthError } from '@/lib/splitwise';
import { getCachedGroups, replaceCachedGroups } from '@/lib/db';
import { useAuthStore } from '@/stores/authStore';

jest.mock('@/lib/splitwise');
jest.mock('@/lib/db');

const group = (id: string, name: string) => ({
  id, name, member_ids: ['1', '2'], member_names: ['Alice', 'Bob'],
});

beforeEach(() => {
  jest.clearAllMocks();
  useGroupStore.setState({ groups: [], isLoading: false, isStale: false });
});

test('renders the cache before the network answers', async () => {
  (getCachedGroups as jest.Mock).mockResolvedValue([group('g1', 'Roommates')]);
  let release: (v: unknown) => void = () => {};
  (getGroups as jest.Mock).mockReturnValue(new Promise((r) => { release = r; }));

  const loading = useGroupStore.getState().load();
  await Promise.resolve();
  await Promise.resolve();
  expect(useGroupStore.getState().groups).toEqual([group('g1', 'Roommates')]);

  release([group('g1', 'Roommates')]);
  await loading;
});

test('a successful refresh replaces the cache and clears isStale', async () => {
  (getCachedGroups as jest.Mock).mockResolvedValue([group('g1', 'Old')]);
  (getGroups as jest.Mock).mockResolvedValue([group('g1', 'New'), group('g2', 'Japan')]);

  await useGroupStore.getState().load();

  expect(replaceCachedGroups).toHaveBeenCalledWith([group('g1', 'New'), group('g2', 'Japan')]);
  expect(useGroupStore.getState().groups).toHaveLength(2);
  expect(useGroupStore.getState().isStale).toBe(false);
  expect(useGroupStore.getState().isLoading).toBe(false);
});

test('a failed refresh keeps the cache and marks the data stale', async () => {
  (getCachedGroups as jest.Mock).mockResolvedValue([group('g1', 'Roommates')]);
  (getGroups as jest.Mock).mockRejectedValue(new Error('offline'));

  await useGroupStore.getState().load();

  expect(useGroupStore.getState().groups).toEqual([group('g1', 'Roommates')]);
  expect(useGroupStore.getState().isStale).toBe(true);
  expect(replaceCachedGroups).not.toHaveBeenCalled();
});

test('a 401 reports the auth failure', async () => {
  (getCachedGroups as jest.Mock).mockResolvedValue([]);
  (getGroups as jest.Mock).mockRejectedValue(new SplitwiseAuthError());
  const report = jest.spyOn(useAuthStore.getState(), 'reportAuthFailure');

  await useGroupStore.getState().load();

  expect(report).toHaveBeenCalled();
});

test('a cache read failure does not prevent the refresh', async () => {
  (getCachedGroups as jest.Mock).mockRejectedValue(new Error('idb gone'));
  (getGroups as jest.Mock).mockResolvedValue([group('g1', 'Roommates')]);

  await useGroupStore.getState().load();

  expect(useGroupStore.getState().groups).toEqual([group('g1', 'Roommates')]);
});

test('clear empties the list', async () => {
  useGroupStore.setState({ groups: [group('g1', 'Roommates')], isStale: true });
  useGroupStore.getState().clear();
  expect(useGroupStore.getState().groups).toEqual([]);
  expect(useGroupStore.getState().isStale).toBe(false);
});
