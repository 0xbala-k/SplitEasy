import { getSecure, setSecure, deleteSecure, KEYS } from '@/lib/secure.web';

describe('secure storage (web)', () => {
  const store = new Map<string, string>();

  beforeEach(() => {
    store.clear();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  it('round-trips a value', async () => {
    await setSecure(KEYS.SPLITWISE_ACCESS_TOKEN, 'tok123');
    expect(await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN)).toBe('tok123');
  });

  it('returns null for missing keys', async () => {
    expect(await getSecure('nope')).toBeNull();
  });

  it('deletes values', async () => {
    await setSecure('k', 'v');
    await deleteSecure('k');
    expect(await getSecure('k')).toBeNull();
  });

  it('namespaces storage keys to avoid collisions', async () => {
    await setSecure('k', 'v');
    expect(store.has('k')).toBe(false); // must be prefixed
  });
});
