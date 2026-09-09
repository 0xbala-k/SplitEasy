// mobile/__tests__/lib/db.parity.test.ts
// Metro resolves `@/lib/db` to db.web.ts on web, so any function db.ts exports
// but db.web.ts doesn't is `undefined` at runtime in the PWA — it throws only
// when the feature is used, after side effects (e.g. a created Splitwise
// expense) have already happened. Fail at test time instead.
jest.mock('expo-sqlite');

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import * as SQLite from 'expo-sqlite';
import * as native from '@/lib/db';
import * as web from '@/lib/db.web';

test('db.web implements every function db.ts exports', () => {
  const missing = Object.keys(native).filter(
    (name) => typeof (web as Record<string, unknown>)[name] !== 'function'
  );
  expect(missing).toEqual([]);
});

/**
 * A minimal, table-agnostic in-memory stand-in for expo-sqlite.
 *
 * db.test.ts's mockDb has no state — every test manually feeds it canned
 * return values. That works for call-argument assertions but can't support a
 * genuine round trip through db.ts's real SQL, which is what parity tests
 * need: the SAME test body run against both backends, including the sqlite
 * one, must actually read back what it wrote. This fake supports exactly the
 * no-WHERE INSERT/DELETE/SELECT shapes the cache functions below issue — it
 * is not a general SQL engine.
 */
function createFakeSqliteDb() {
  const tables = new Map<string, Record<string, unknown>[]>();
  const rowsFor = (name: string): Record<string, unknown>[] => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };

  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    withTransactionAsync: jest.fn(async (task: () => Promise<void>) => {
      await task();
    }),
    runAsync: jest.fn(async (sql: string, params: unknown[] = []) => {
      const delById = sql.match(/^DELETE FROM (\w+) WHERE id = \?$/);
      if (delById) {
        const rows = rowsFor(delById[1]);
        const idx = rows.findIndex((r) => r.id === params[0]);
        if (idx !== -1) rows.splice(idx, 1);
        return { lastInsertRowId: 0, changes: idx === -1 ? 0 : 1 };
      }
      const del = sql.match(/^DELETE FROM (\w+)/);
      if (del) {
        rowsFor(del[1]).length = 0;
        return { lastInsertRowId: 0, changes: 0 };
      }
      const upd = sql.match(
        /^UPDATE (\w+) SET attempts = attempts \+ 1, last_error = \? WHERE id = \?$/
      );
      if (upd) {
        const row = rowsFor(upd[1]).find((r) => r.id === params[1]);
        if (row) {
          row.attempts = (Number(row.attempts) || 0) + 1;
          row.last_error = params[0];
        }
        return { lastInsertRowId: 0, changes: row ? 1 : 0 };
      }
      const ins = sql.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)/);
      if (ins) {
        const [, table, colsRaw] = ins;
        const cols = colsRaw.split(',').map((c) => c.trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        rowsFor(table).push(row);
        return { lastInsertRowId: 1, changes: 1 };
      }
      return { lastInsertRowId: 0, changes: 0 };
    }),
    getAllAsync: jest.fn(async (sql: string) => {
      const sel = sql.match(/^SELECT (\*|[\w, ]+) FROM (\w+)/);
      if (!sel) return [];
      const [, colsRaw, table] = sel;
      const rows =
        colsRaw.trim() === '*'
          ? rowsFor(table).map((r) => ({ ...r }))
          : rowsFor(table).map((r) =>
              Object.fromEntries(colsRaw.split(',').map((c) => c.trim()).map((c) => [c, r[c]]))
            );
      const orderBy = sql.match(/ORDER BY (\w+)/)?.[1];
      if (orderBy) {
        rows.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
          String(a[orderBy]).localeCompare(String(b[orderBy]))
        );
      }
      return rows;
    }),
  };
}

describe.each([
  ['sqlite', () => native as Record<string, any>],
  ['indexeddb', () => web as Record<string, any>],
])('%s Splitwise cache', (backendName, load) => {
  beforeEach(() => {
    if (backendName === 'sqlite') {
      (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(createFakeSqliteDb());
      native.resetDbForTests();
    } else {
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      web.resetDbForTests();
    }
  });

  it('round-trips friends', async () => {
    const db = load();
    await db.replaceCachedFriends([
      { id: '1', display_name: 'Ada Lovelace', avatar_url: 'https://x/a.png' },
      { id: '2', display_name: 'Grace Hopper', avatar_url: null },
    ]);
    const out = await db.getCachedFriends();
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: '1', display_name: 'Ada Lovelace' });
    expect(out[1].avatar_url).toBeNull();
  });

  it('replaces wholesale so a removed friend disappears', async () => {
    const db = load();
    await db.replaceCachedFriends([
      { id: '1', display_name: 'Ada', avatar_url: null },
      { id: '2', display_name: 'Grace', avatar_url: null },
    ]);
    await db.replaceCachedFriends([{ id: '1', display_name: 'Ada', avatar_url: null }]);

    const out = await db.getCachedFriends();
    // Merging would resurrect a friend deleted upstream. split_decisions stores
    // friend_names denormalized, so history survives the removal.
    expect(out.map((f: any) => f.id)).toEqual(['1']);
  });

  it('round-trips groups with their member arrays', async () => {
    const db = load();
    await db.replaceCachedGroups([
      { id: 'g1', name: 'Trip', member_ids: ['1', '2'], member_names: ['Ada', 'Grace'] },
    ]);
    const out = await db.getCachedGroups();
    expect(out[0].member_ids).toEqual(['1', '2']);
    expect(out[0].member_names).toEqual(['Ada', 'Grace']);
  });
});

describe.each([
  ['sqlite', () => native as Record<string, any>],
  ['indexeddb', () => web as Record<string, any>],
])('%s pending op queue', (backendName, load) => {
  beforeEach(() => {
    if (backendName === 'sqlite') {
      (SQLite.openDatabaseAsync as jest.Mock).mockResolvedValue(createFakeSqliteDb());
      native.resetDbForTests();
    } else {
      (globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
      web.resetDbForTests();
    }
  });

  const op = (over: any) => ({
    id: 'op1', op_type: 'create', transaction_id: 't1', expense_id: null,
    payload: '{}', attempts: 0, last_error: null,
    created_at: '2026-09-08T00:00:00.000Z', ...over,
  });

  it('returns ops in FIFO order', async () => {
    const db = load();
    await db.enqueueOp(op({ id: 'b', transaction_id: 'y', created_at: '2026-09-08T00:00:02.000Z' }));
    await db.enqueueOp(op({ id: 'a', transaction_id: 'x', created_at: '2026-09-08T00:00:01.000Z' }));

    const out = await db.getPendingOps();
    expect(out.map((o: any) => o.id)).toEqual(['a', 'b']);
  });

  it('collapses on enqueue rather than appending', async () => {
    const db = load();
    await db.enqueueOp(op({ id: 'a', op_type: 'create' }));
    await db.enqueueOp(op({ id: 'b', op_type: 'delete' }));

    // create + delete for the same transaction annihilate.
    expect(await db.getPendingOps()).toHaveLength(0);
  });

  it('increments attempts and records the error', async () => {
    const db = load();
    await db.enqueueOp(op({ id: 'a' }));
    await db.recordOpFailure('a', 'HTTP 500');

    const [stored] = await db.getPendingOps();
    expect(stored.attempts).toBe(1);
    expect(stored.last_error).toBe('HTTP 500');
  });

  it('dequeues by id', async () => {
    const db = load();
    await db.enqueueOp(op({ id: 'a' }));
    await db.dequeueOp('a');
    expect(await db.getPendingOps()).toHaveLength(0);
  });
});
