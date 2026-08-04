# Vacation Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user create a vacation, optionally start it so new synced transactions land inside it instead of the main Transactions list, manually add/remove transactions, and split them to Splitwise from a dedicated screen — optionally posting into a linked Splitwise group.

**Architecture:** A new `vacations` table/store (mirrored in both `lib/db.ts` and `lib/db.web.ts`) plus a nullable `vacation_id` on `transactions`. A `stores/vacationStore.ts` zustand store owns vacation metadata (list, active vacation, lifecycle transitions); `transactionStore.refresh()` consults it to tag newly-synced transactions and to reconcile date-driven status transitions. Three new screens under `app/vacation/` (list, create, detail) reuse the existing `FriendPickerSheet` split flow, extended with optional Splitwise-group awareness.

**Tech Stack:** React Native (Expo Router, zustand, `@gorhom/bottom-sheet`), expo-sqlite (native) / IndexedDB (web), Jest + `@testing-library/react-native`, no new dependencies.

## Global Constraints

- No new npm dependencies (spec: date fields are plain validated text inputs — no date-picker library exists in the project today).
- `lib/db.ts` and `lib/db.web.ts` must always export the same function names — enforced by the existing `__tests__/lib/db.parity.test.ts`. Every DB task in this plan changes both files together so no commit leaves them out of sync (this codebase has previously shipped a native/web parity bug — see commit `d18831b`).
- Money formatting, id styles (`${entity}-${Date.now()}`-like), and component/test conventions must match the existing codebase exactly — see each task's "Follow the pattern in" note.
- Existing tests must keep passing after every task; run `npm test` before each commit.

---

### Task 1: Shared types, id helper, and vacation-conflict error

**Files:**
- Modify: `lib/types.ts`
- Create: `lib/id.ts`
- Create: `lib/vacationErrors.ts`
- Test: `__tests__/lib/id.test.ts`
- Test: `__tests__/lib/vacationErrors.test.ts`

**Interfaces:**
- Produces: `VacationStatus = 'draft' | 'active' | 'ended'`; `Vacation` interface; `CreateVacationInput` interface; `SplitwiseGroup` interface; `Transaction.vacation_id?: string | null`; `generateId(prefix: string): string` from `lib/id.ts`; `VacationConflictError` class (`reason: 'overlap' | 'already_active'`) from `lib/vacationErrors.ts`.

- [ ] **Step 1: Write the failing tests**

`__tests__/lib/id.test.ts`:
```ts
import { generateId } from '@/lib/id';

test('generateId prefixes and produces unique values', () => {
  const a = generateId('vac');
  const b = generateId('vac');
  expect(a).toMatch(/^vac_/);
  expect(a).not.toBe(b);
});
```

`__tests__/lib/vacationErrors.test.ts`:
```ts
import { VacationConflictError } from '@/lib/vacationErrors';

test('carries a reason and is catchable via instanceof', () => {
  const err = new VacationConflictError('overlap', 'dates overlap an existing vacation');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(VacationConflictError);
  expect(err.reason).toBe('overlap');
  expect(err.message).toBe('dates overlap an existing vacation');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- id.test.ts vacationErrors.test.ts`
Expected: FAIL — `Cannot find module '@/lib/id'` / `'@/lib/vacationErrors'`.

- [ ] **Step 3: Implement**

`lib/id.ts`:
```ts
// mobile/lib/id.ts
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
```

`lib/vacationErrors.ts`:
```ts
// mobile/lib/vacationErrors.ts
export class VacationConflictError extends Error {
  reason: 'overlap' | 'already_active';

  constructor(reason: 'overlap' | 'already_active', message: string) {
    super(message);
    this.name = 'VacationConflictError';
    this.reason = reason;
  }
}
```

Add to `lib/types.ts` (append at end of file):
```ts
export type VacationStatus = 'draft' | 'active' | 'ended';

export interface Vacation {
  id: string;
  name: string;
  start_date: string | null;   // ISO-8601 date "YYYY-MM-DD"
  end_date: string | null;
  status: VacationStatus;
  splitwise_group_id: string | null;
  splitwise_group_name: string | null;
  splitwise_group_member_ids: string[] | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
}

export interface CreateVacationInput {
  name: string;
  start_date?: string | null;
  end_date?: string | null;
  splitwise_group_id?: string | null;
  splitwise_group_name?: string | null;
  splitwise_group_member_ids?: string[] | null;
}

export interface SplitwiseGroup {
  id: string;
  name: string;
  member_ids: string[];
  member_names: string[];
}
```

Modify the existing `Transaction` interface in `lib/types.ts` to add one optional field (keeps every existing object literal in the codebase — tests included — compiling unchanged):
```ts
export interface Transaction {
  id: string;            // Plaid transaction_id
  merchant_name: string;
  amount: number;        // always positive (debits only)
  currency: string;
  date: string;          // ISO-8601 date e.g. "2026-04-15"
  status: TransactionStatus;
  pending: boolean;
  created_at: string;    // ISO-8601 datetime; used for 6-month prune
  vacation_id?: string | null; // set while assigned to a vacation
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- id.test.ts vacationErrors.test.ts`
Expected: PASS

- [ ] **Step 5: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: no errors (confirms every existing `Transaction` literal in the codebase still satisfies the type with the new optional field).

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/id.ts lib/vacationErrors.ts __tests__/lib/id.test.ts __tests__/lib/vacationErrors.test.ts
git commit -m "feat: add vacation types, id helper, and conflict error"
```

---

### Task 2: DB layer — vacation CRUD (native + web)

**Files:**
- Modify: `lib/db.ts`
- Modify: `lib/db.web.ts`
- Test: `__tests__/lib/db.test.ts`
- Test: `__tests__/lib/db.web.test.ts`

**Interfaces:**
- Consumes: `Vacation`, `CreateVacationInput`, `VacationStatus` (`lib/types.ts`), `generateId` (`lib/id.ts`), `VacationConflictError` (`lib/vacationErrors.ts`).
- Produces (both files, same signatures): `createVacation(input: CreateVacationInput): Promise<Vacation>`, `getVacations(): Promise<Vacation[]>`, `getVacation(id: string): Promise<Vacation | null>`, `getActiveVacation(): Promise<Vacation | null>`, `startVacation(id: string): Promise<void>`, `endVacation(id: string): Promise<void>`, `deleteVacation(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing native tests**

Append to `__tests__/lib/db.test.ts` (add these imports to the existing `import { ... } from '@/lib/db'` block: `createVacation, getVacations, getVacation, getActiveVacation, startVacation, endVacation, deleteVacation`, and `import { VacationConflictError } from '@/lib/vacationErrors';`):

```ts
describe('vacation CRUD', () => {
  beforeEach(async () => {
    mockDb.getFirstAsync.mockResolvedValue({ user_version: 4 });
    await initDb();
  });

  test('createVacation inserts a draft row and returns it', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO vacations'),
      expect.arrayContaining([expect.any(String), 'Hawaii', null, null, 'draft'])
    );
    expect(v).toMatchObject({ name: 'Hawaii', status: 'draft', start_date: null, end_date: null });
  });

  test('createVacation rejects an overlapping dated range', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([{ id: 'other', name: 'Ski trip' }]);
    await expect(
      createVacation({ name: 'Hawaii', start_date: '2026-08-01', end_date: '2026-08-10' })
    ).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('createVacation allows non-overlapping dated ranges', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    const v = await createVacation({ name: 'Hawaii', start_date: '2026-08-01', end_date: '2026-08-10' });
    expect(v.start_date).toBe('2026-08-01');
    expect(v.end_date).toBe('2026-08-10');
  });

  test('getVacations maps rows and parses group member ids', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'v1', name: 'Hawaii', start_date: null, end_date: null, status: 'draft',
        splitwise_group_id: '9', splitwise_group_name: 'Trip', splitwise_group_member_ids: '["1","2"]',
        created_at: 'x', started_at: null, ended_at: null },
    ]);
    const rows = await getVacations();
    expect(rows[0].splitwise_group_member_ids).toEqual(['1', '2']);
  });

  test('getVacation returns null when not found', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce(null);
    expect(await getVacation('missing')).toBeNull();
  });

  test('getActiveVacation queries status=active', async () => {
    mockDb.getFirstAsync.mockResolvedValueOnce(null);
    await getActiveVacation();
    expect(mockDb.getFirstAsync).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active'"),
      []
    );
  });

  test('startVacation flips status to active when none other is active', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([]);
    await startVacation('v1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'active'"),
      expect.arrayContaining([expect.any(String), 'v1'])
    );
  });

  test('startVacation throws VacationConflictError when another vacation is active', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([{ id: 'other' }]);
    await expect(startVacation('v1')).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('endVacation flips status to ended', async () => {
    await endVacation('v1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ended'"),
      expect.arrayContaining([expect.any(String), 'v1'])
    );
  });

  test('deleteVacation unassigns pending transactions then deletes the row, in one transaction', async () => {
    await deleteVacation('v1');
    expect(mockDb.withTransactionAsync).toHaveBeenCalledTimes(1);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET vacation_id = NULL'),
      ['v1']
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM vacations'),
      ['v1']
    );
  });
});
```

- [ ] **Step 2: Run native tests to verify they fail**

Run: `npm test -- db.test.ts`
Expected: FAIL — the new exports don't exist yet.

- [ ] **Step 3: Implement in `lib/db.ts`**

Add the import at the top:
```ts
import { Vacation, CreateVacationInput, VacationStatus } from '@/lib/types';
import { generateId } from '@/lib/id';
import { VacationConflictError } from '@/lib/vacationErrors';
```

In `initDb()`, add a new migration block right after the existing `if (version >= 1 && version < 3) { ... }` block and before the final version-stamp block:
```ts
  if (version < 4) {
    await _db.execAsync(`
      CREATE TABLE IF NOT EXISTS vacations (
        id TEXT PRIMARY KEY,
        name TEXT,
        start_date TEXT,
        end_date TEXT,
        status TEXT DEFAULT 'draft',
        splitwise_group_id TEXT,
        splitwise_group_name TEXT,
        splitwise_group_member_ids TEXT,
        created_at TEXT,
        started_at TEXT,
        ended_at TEXT
      );
    `);
    // Unlike `pending`/`description` above, vacation_id is NOT in the base
    // `version < 1` CREATE TABLE for transactions — so, unlike those columns,
    // this ALTER must run ungated (not `version >= 1 && ...`) so a brand-new
    // install (version 0) gets the column too. If a future migration ever
    // adds vacation_id to the base CREATE TABLE, this ALTER must move behind
    // a `version >= 1` guard or it will fail with "duplicate column name" on
    // fresh installs.
    await _db.execAsync(`ALTER TABLE transactions ADD COLUMN vacation_id TEXT REFERENCES vacations(id);`);
  }
```

Update the version-stamp block's literal and comment:
```ts
  // Only stamp when a migration actually ran, to avoid a file-header write on
  // every cold start. Keep the literal in sync with the highest block above:
  // when adding a `version < N` block, bump this to N.
  if (version < 4) {
    await _db.execAsync(`PRAGMA user_version = 4;`);
  }
```
(This replaces the prior `if (version < 3) { PRAGMA user_version = 3; }` block — same guard, new literal.)

This migration change breaks three pre-existing assertions in `__tests__/lib/db.test.ts` that this task must fix (do this now, before Step 4, or Step 4's "Expected: PASS" will not hold):
- `initDb skips migration when already at version 1` (the test that does `mockDb.getFirstAsync.mockResolvedValueOnce({ user_version: 1 })` and filters `execAsync` calls for `'CREATE TABLE'`, asserting zero matches): at version 1 the new `version < 4` block still runs and emits `CREATE TABLE IF NOT EXISTS vacations`, so the filter now finds one call and the length-0 assertion fails. Narrow the filter to what the test actually means to check — that the *original* tables aren't recreated:
  ```ts
  const ddlCalls = mockDb.execAsync.mock.calls.filter(([sql]: [string]) =>
    sql.includes('CREATE TABLE IF NOT EXISTS transactions')
  );
  expect(ddlCalls).toHaveLength(0);
  ```
- `initDb migrates a v1 install by adding both pending and description columns` and `initDb migrates an existing v2 install by adding the description column`: both assert `expect.stringContaining('user_version = 3')`. Change both to `expect.stringContaining('user_version = 4')`.

Add these functions after `deleteAllTransactions` at the end of the file:
```ts
function mapVacationRow(row: {
  id: string; name: string; start_date: string | null; end_date: string | null; status: VacationStatus;
  splitwise_group_id: string | null; splitwise_group_name: string | null;
  splitwise_group_member_ids: string | null; created_at: string; started_at: string | null; ended_at: string | null;
}): Vacation {
  return {
    ...row,
    splitwise_group_member_ids: row.splitwise_group_member_ids
      ? JSON.parse(row.splitwise_group_member_ids)
      : null,
  };
}

export async function createVacation(input: CreateVacationInput): Promise<Vacation> {
  const d = db();
  if (input.start_date && input.end_date) {
    // Overlap = existing.start <= new.end AND new.start <= existing.end.
    const conflicts = await d.getAllAsync(
      `SELECT id FROM vacations
       WHERE status IN ('draft','active')
         AND start_date IS NOT NULL AND end_date IS NOT NULL
         AND start_date <= ? AND end_date >= ?`,
      [input.end_date, input.start_date]
    );
    if (conflicts.length > 0) {
      throw new VacationConflictError('overlap', 'Dates overlap an existing vacation.');
    }
  }
  const now = new Date().toISOString();
  const vacation: Vacation = {
    id: generateId('vac'),
    name: input.name,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    status: 'draft',
    splitwise_group_id: input.splitwise_group_id ?? null,
    splitwise_group_name: input.splitwise_group_name ?? null,
    splitwise_group_member_ids: input.splitwise_group_member_ids ?? null,
    created_at: now,
    started_at: null,
    ended_at: null,
  };
  await d.runAsync(
    `INSERT INTO vacations (id, name, start_date, end_date, status, splitwise_group_id, splitwise_group_name, splitwise_group_member_ids, created_at, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      vacation.id, vacation.name, vacation.start_date, vacation.end_date, vacation.status,
      vacation.splitwise_group_id, vacation.splitwise_group_name,
      vacation.splitwise_group_member_ids ? JSON.stringify(vacation.splitwise_group_member_ids) : null,
      vacation.created_at, vacation.started_at, vacation.ended_at,
    ]
  );
  return vacation;
}

export async function getVacations(): Promise<Vacation[]> {
  const rows = await db().getAllAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations
     ORDER BY CASE status WHEN 'ended' THEN 1 ELSE 0 END, COALESCE(start_date, created_at) DESC`,
    []
  );
  return rows.map(mapVacationRow);
}

export async function getVacation(id: string): Promise<Vacation | null> {
  const row = await db().getFirstAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations WHERE id = ?`,
    [id]
  );
  return row ? mapVacationRow(row) : null;
}

export async function getActiveVacation(): Promise<Vacation | null> {
  const row = await db().getFirstAsync<Parameters<typeof mapVacationRow>[0]>(
    `SELECT * FROM vacations WHERE status = 'active'`,
    []
  );
  return row ? mapVacationRow(row) : null;
}

export async function startVacation(id: string): Promise<void> {
  const others = await db().getAllAsync<{ id: string }>(
    `SELECT id FROM vacations WHERE status = 'active' AND id != ?`,
    [id]
  );
  if (others.length > 0) {
    throw new VacationConflictError('already_active', 'Another vacation is already active.');
  }
  await db().runAsync(
    `UPDATE vacations SET status = 'active', started_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function endVacation(id: string): Promise<void> {
  await db().runAsync(
    `UPDATE vacations SET status = 'ended', ended_at = ? WHERE id = ?`,
    [new Date().toISOString(), id]
  );
}

export async function deleteVacation(id: string): Promise<void> {
  await db().withTransactionAsync(async () => {
    await db().runAsync(
      `UPDATE transactions SET vacation_id = NULL WHERE vacation_id = ? AND status = 'new'`,
      [id]
    );
    await db().runAsync(`DELETE FROM vacations WHERE id = ?`, [id]);
  });
}
```

- [ ] **Step 4: Run native tests to verify they pass**

Run: `npm test -- db.test.ts`
Expected: PASS

- [ ] **Step 5: Fix `seedRaw`'s hardcoded DB version, then write the failing web tests**

`seedRaw` (top of `__tests__/lib/db.web.test.ts`) opens a second raw connection via `indexedDB.open('spliteasy', 1)` — a hardcoded version. Once this task bumps `DB_VERSION` to `2` in `lib/db.web.ts`, that hardcoded `1` becomes a **lower** version than the database's actual current version, and `IDBFactory.open` throws `VersionError` for that — breaking every existing test that uses `seedRaw` (e.g. the prune tests), not just new ones. Fix it first by dropping the explicit version so it always opens at whatever version the database is already at:
```ts
// Seed a row through a second raw IDB connection: fake-indexeddb shares data
// across connections. No explicit version here — always opens at whatever
// version the database is already at, so this stays correct as DB_VERSION
// bumps over time instead of needing to track it.
async function seedRaw(store: string, value: object) {
  const d = await new Promise<IDBDatabase>((res, rej) => {
    const open = indexedDB.open('spliteasy');
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
  });
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onabort = () => rej(tx.error); });
  d.close();
}
```
(Replaces both the old comment and the `indexedDB.open('spliteasy', 1)` line.) Run `npm test -- db.web.test.ts` now, before writing anything else, to confirm the existing suite still passes with this fix in isolation.

Now append to `__tests__/lib/db.web.test.ts` (add to the existing import from `@/lib/db.web`: `createVacation, getVacations, getVacation, getActiveVacation, startVacation, endVacation, deleteVacation`, and add `import { VacationConflictError } from '@/lib/vacationErrors';`):

```ts
describe('vacation CRUD (IndexedDB)', () => {
  test('createVacation inserts a draft row and returns it', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    expect(v).toMatchObject({ name: 'Hawaii', status: 'draft', start_date: null, end_date: null });
    const all = await getVacations();
    expect(all.map((x) => x.id)).toContain(v.id);
  });

  test('createVacation rejects an overlapping dated range', async () => {
    await createVacation({ name: 'Ski trip', start_date: '2026-08-01', end_date: '2026-08-10' });
    await expect(
      createVacation({ name: 'Hawaii', start_date: '2026-08-05', end_date: '2026-08-15' })
    ).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('createVacation allows adjacent non-overlapping dated ranges', async () => {
    await createVacation({ name: 'Ski trip', start_date: '2026-08-01', end_date: '2026-08-10' });
    const v = await createVacation({ name: 'Hawaii', start_date: '2026-08-11', end_date: '2026-08-20' });
    expect(v.name).toBe('Hawaii');
  });

  test('getVacation returns null when not found', async () => {
    expect(await getVacation('missing')).toBeNull();
  });

  test('getActiveVacation returns null until one is started', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    expect(await getActiveVacation()).toBeNull();
    await startVacation(v.id);
    expect((await getActiveVacation())?.id).toBe(v.id);
  });

  test('startVacation throws when another vacation is active', async () => {
    const a = await createVacation({ name: 'A' });
    const b = await createVacation({ name: 'B' });
    await startVacation(a.id);
    await expect(startVacation(b.id)).rejects.toBeInstanceOf(VacationConflictError);
  });

  test('endVacation flips status to ended', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await startVacation(v.id);
    await endVacation(v.id);
    expect((await getVacation(v.id))?.status).toBe('ended');
  });

  test('deleteVacation unassigns pending transactions then removes the vacation', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    // Seed the row directly via the raw IDB helper (not upsertTransactions +
    // assignTransactionsToVacation — both gain vacation-awareness in Task 3,
    // which lands after this one) so this task's test suite is self-contained.
    await seedRaw('transactions', {
      id: 't1', merchant_name: 'Cafe', amount: 20, currency: 'USD', date: '2026-08-01',
      status: 'new', pending: false, created_at: new Date().toISOString(), vacation_id: v.id,
    });
    await deleteVacation(v.id);
    expect(await getVacation(v.id)).toBeNull();
    const [row] = await getNewTransactions();
    expect(row.vacation_id).toBeFalsy();
  });
});
```

- [ ] **Step 6: Run web tests to verify they fail**

Run: `npm test -- db.web.test.ts`
Expected: FAIL — new exports don't exist yet.

- [ ] **Step 7: Implement in `lib/db.web.ts`**

Add to the imports:
```ts
import { Vacation, CreateVacationInput, VacationStatus } from '@/lib/types';
import { generateId } from '@/lib/id';
import { VacationConflictError } from '@/lib/vacationErrors';
```

Add a new store constant near the top:
```ts
const VACATION_STORE = 'vacations';
```

Bump the version and add the upgrade branch:
```ts
const DB_VERSION = 2;
```
```ts
export async function initDb(): Promise<void> {
  _db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(TX_STORE)) {
        d.createObjectStore(TX_STORE, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(DECISION_STORE)) {
        d.createObjectStore(DECISION_STORE, { keyPath: 'transaction_id' });
      }
      if (!d.objectStoreNames.contains(VACATION_STORE)) {
        d.createObjectStore(VACATION_STORE, { keyPath: 'id' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
```

Add these functions at the end of the file:
```ts
function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

export async function createVacation(input: CreateVacationInput): Promise<Vacation> {
  if (input.start_date && input.end_date) {
    const all = await req(db().transaction(VACATION_STORE).objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>);
    const conflict = all.some(
      (v) =>
        (v.status === 'draft' || v.status === 'active') &&
        v.start_date && v.end_date &&
        rangesOverlap(v.start_date, v.end_date, input.start_date!, input.end_date!)
    );
    if (conflict) throw new VacationConflictError('overlap', 'Dates overlap an existing vacation.');
  }
  const vacation: Vacation = {
    id: generateId('vac'),
    name: input.name,
    start_date: input.start_date ?? null,
    end_date: input.end_date ?? null,
    status: 'draft',
    splitwise_group_id: input.splitwise_group_id ?? null,
    splitwise_group_name: input.splitwise_group_name ?? null,
    splitwise_group_member_ids: input.splitwise_group_member_ids ?? null,
    created_at: new Date().toISOString(),
    started_at: null,
    ended_at: null,
  };
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  tx.objectStore(VACATION_STORE).add(vacation);
  await done(tx);
  return vacation;
}

function byVacationOrder(a: Vacation, b: Vacation): number {
  const aEnded = a.status === 'ended' ? 1 : 0;
  const bEnded = b.status === 'ended' ? 1 : 0;
  if (aEnded !== bEnded) return aEnded - bEnded;
  const aKey = a.start_date ?? a.created_at;
  const bKey = b.start_date ?? b.created_at;
  return aKey < bKey ? 1 : aKey > bKey ? -1 : 0;
}

export async function getVacations(): Promise<Vacation[]> {
  const all = await req(db().transaction(VACATION_STORE).objectStore(VACATION_STORE).getAll() as IDBRequest<Vacation[]>);
  return all.sort(byVacationOrder);
}

export async function getVacation(id: string): Promise<Vacation | null> {
  const row = await req(db().transaction(VACATION_STORE).objectStore(VACATION_STORE).get(id) as IDBRequest<Vacation | undefined>);
  return row ?? null;
}

export async function getActiveVacation(): Promise<Vacation | null> {
  const all = await getVacations();
  return all.find((v) => v.status === 'active') ?? null;
}

export async function startVacation(id: string): Promise<void> {
  const all = await getVacations();
  if (all.some((v) => v.status === 'active' && v.id !== id)) {
    throw new VacationConflictError('already_active', 'Another vacation is already active.');
  }
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, status: 'active' as VacationStatus, started_at: new Date().toISOString() });
  await done(tx);
}

export async function endVacation(id: string): Promise<void> {
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const existing = await req(store.get(id) as IDBRequest<Vacation | undefined>);
  if (existing) store.put({ ...existing, status: 'ended' as VacationStatus, ended_at: new Date().toISOString() });
  await done(tx);
}

export async function deleteVacation(id: string): Promise<void> {
  const tx = db().transaction([TX_STORE, VACATION_STORE], 'readwrite');
  const txStore = tx.objectStore(TX_STORE);
  const all = await req(txStore.getAll() as IDBRequest<Transaction[]>);
  for (const t of all) {
    if (t.vacation_id === id && t.status === 'new') {
      txStore.put({ ...t, vacation_id: null });
    }
  }
  tx.objectStore(VACATION_STORE).delete(id);
  await done(tx);
}
```

- [ ] **Step 8: Run both test files and the parity test**

Run: `npm test -- db.test.ts db.web.test.ts db.parity.test.ts`
Expected: all PASS — including the three pre-existing `db.test.ts` assertions updated above. `db.parity.test.ts` PASSes since both files export the same new names.

- [ ] **Step 9: Commit**

```bash
git add lib/db.ts lib/db.web.ts __tests__/lib/db.test.ts __tests__/lib/db.web.test.ts
git commit -m "feat(db): add vacation CRUD to native and web backends"
```

---

### Task 3: DB layer — transaction capture, history, and reconciliation (native + web)

**Files:**
- Modify: `lib/db.ts`
- Modify: `lib/db.web.ts`
- Test: `__tests__/lib/db.test.ts`
- Test: `__tests__/lib/db.web.test.ts`

**Interfaces:**
- Consumes: everything from Task 2, plus `HistoryItem` (`lib/types.ts`).
- Produces (both files, same signatures): `getVacationPendingTransactions(vacationId: string): Promise<Transaction[]>`, `getVacationHistory(vacationId: string): Promise<HistoryItem[]>`, `assignTransactionsToVacation(vacationId: string, transactionIds: string[]): Promise<void>`, `removeTransactionFromVacation(transactionId: string): Promise<void>`, `reconcileVacationStatuses(): Promise<void>`. Changes existing `getNewTransactions()` to exclude vacation-assigned rows, and `upsertTransactions(txs: PlaidTransaction[], activeVacationId?: string | null)` to stamp new rows with it.

- [ ] **Step 1: Write the failing native tests**

Add to the imports in `__tests__/lib/db.test.ts`: `getVacationPendingTransactions, getVacationHistory, assignTransactionsToVacation, removeTransactionFromVacation, reconcileVacationStatuses`.

```ts
describe('vacation transaction capture & history', () => {
  beforeEach(async () => {
    mockDb.getFirstAsync.mockResolvedValue({ user_version: 4 });
    await initDb();
  });

  test('getNewTransactions filters out vacation-assigned rows', async () => {
    await getNewTransactions();
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('vacation_id IS NULL'),
      []
    );
  });

  test('upsertTransactions stamps new rows with the active vacation id', async () => {
    await upsertTransactions(
      [{ transaction_id: 'ptx1', merchant_name: 'Amazon', name: 'AMZN', amount: 10, iso_currency_code: 'USD', date: '2026-08-01', pending: false }],
      'vac1'
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE'),
      expect.arrayContaining(['ptx1', 'vac1'])
    );
  });

  test('upsertTransactions stamps null when no vacation is active', async () => {
    await upsertTransactions([{ transaction_id: 'ptx1', merchant_name: 'Amazon', name: 'AMZN', amount: 10, iso_currency_code: 'USD', date: '2026-08-01', pending: false }]);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('INSERT OR IGNORE'),
      expect.arrayContaining(['ptx1', null])
    );
  });

  test('getVacationPendingTransactions queries by vacation id and status=new', async () => {
    await getVacationPendingTransactions('vac1');
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining("status = 'new'"),
      ['vac1']
    );
  });

  test('getVacationHistory scopes the history query to the vacation and groups combined splits', async () => {
    mockDb.getAllAsync.mockResolvedValueOnce([
      { id: 'tx1', merchant_name: 'Amazon', amount: 20, currency: 'USD', date: '2026-08-01', status: 'split', pending: 0, created_at: 'x',
        splitwise_expense_id: 'exp1', description: null, friend_names: '["Sam"]', amount_each: 10 },
    ]);
    const items = await getVacationHistory('vac1');
    expect(mockDb.getAllAsync).toHaveBeenCalledWith(
      expect.stringContaining('t.vacation_id = ?'),
      ['vac1']
    );
    expect(items).toHaveLength(1);
    expect(items[0].split?.friend_names).toEqual(['Sam']);
  });

  test('assignTransactionsToVacation bulk-updates eligible transactions', async () => {
    await assignTransactionsToVacation('vac1', ['t1', 't2']);
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET vacation_id = ? WHERE id IN (?,?)"),
      ['vac1', 't1', 't2']
    );
  });

  test('assignTransactionsToVacation is a no-op for an empty list', async () => {
    mockDb.runAsync.mockClear();
    await assignTransactionsToVacation('vac1', []);
    expect(mockDb.runAsync).not.toHaveBeenCalled();
  });

  test('removeTransactionFromVacation clears vacation_id for a pending row', async () => {
    await removeTransactionFromVacation('t1');
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining('SET vacation_id = NULL'),
      ['t1']
    );
  });

  test('reconcileVacationStatuses activates due drafts then ends elapsed actives', async () => {
    await reconcileVacationStatuses();
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'active'"),
      expect.arrayContaining([expect.any(String), expect.any(String)])
    );
    expect(mockDb.runAsync).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'ended'"),
      expect.arrayContaining([expect.any(String), expect.any(String)])
    );
  });

  test('reconcileVacationStatuses caps activation to a single row per call', async () => {
    // Regression: without the `id = (SELECT ... LIMIT 1)` clause, SQLite's
    // UPDATE would activate every due draft in one pass since it evaluates
    // the WHERE against the pre-update snapshot for all matching rows.
    await reconcileVacationStatuses();
    const [sql, params] = mockDb.runAsync.mock.calls.find(([s]: [string]) => s.includes("SET status = 'active'"))!;
    expect(sql).toContain('LIMIT 1');
    expect(params).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run native tests to verify they fail**

Run: `npm test -- db.test.ts`
Expected: FAIL — new exports missing, `getNewTransactions`/`upsertTransactions` assertions fail against the old SQL.

- [ ] **Step 3: Implement in `lib/db.ts`**

Replace `getNewTransactions`:
```ts
export async function getNewTransactions(): Promise<Transaction[]> {
  const rows = await db().getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' AND vacation_id IS NULL ORDER BY date DESC`,
    []
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}
```

Replace `upsertTransactions`:
```ts
export async function upsertTransactions(txs: PlaidTransaction[], activeVacationId: string | null = null): Promise<void> {
  const d = db();
  const now = new Date().toISOString();
  for (const tx of txs) {
    const name = tx.merchant_name ?? tx.name;
    const currency = tx.iso_currency_code ?? 'USD';
    const pending = tx.pending ? 1 : 0;
    // INSERT OR IGNORE preserves status/vacation_id for already-split/skipped rows
    await d.runAsync(
      `INSERT OR IGNORE INTO transactions (id, merchant_name, amount, currency, date, status, pending, created_at, vacation_id)
       VALUES (?, ?, ?, ?, ?, 'new', ?, ?, ?)`,
      [tx.transaction_id, name, tx.amount, currency, tx.date, pending, now, activeVacationId]
    );
    // UPDATE only if still 'new' (don't overwrite user decisions)
    await d.runAsync(
      `UPDATE transactions SET merchant_name = ?, amount = ?, date = ?, pending = ?
       WHERE id = ? AND status = 'new'`,
      [name, tx.amount, tx.date, pending, tx.transaction_id]
    );
  }
}
```

Refactor `getHistoryTransactions` to extract the row→`HistoryItem[]` grouping into a shared private helper, and add `getVacationPendingTransactions` / `getVacationHistory`. Replace the whole `getHistoryTransactions` function with:
```ts
type HistoryRow = Transaction & {
  splitwise_expense_id: string | null;
  description: string | null;
  friend_names: string | null;
  amount_each: number | null;
};

function groupHistoryRows(rows: HistoryRow[]): HistoryItem[] {
  const items: HistoryItem[] = [];
  const groups = new Map<string, HistoryItem & { _txIds: string[] }>();

  for (const r of rows) {
    const title = r.description ?? r.merchant_name;
    if (r.status === 'split' && r.splitwise_expense_id) {
      const key = r.splitwise_expense_id;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += r.amount;
        existing._txIds.push(r.id);
      } else {
        const item: HistoryItem & { _txIds: string[] } = {
          id: r.id,
          merchant_name: title,
          amount: r.amount,
          currency: r.currency,
          date: r.date,
          status: 'split',
          split: {
            friend_names: r.friend_names ? JSON.parse(r.friend_names) : [],
            amount_each: r.amount_each ?? 0,
          },
          _txIds: [r.id],
        };
        groups.set(key, item);
        items.push(item);
      }
    } else {
      items.push({
        id: r.id,
        merchant_name: title,
        amount: r.amount,
        currency: r.currency,
        date: r.date,
        status: r.status,
        ...(r.status === 'split' && r.friend_names
          ? { split: { friend_names: JSON.parse(r.friend_names), amount_each: r.amount_each ?? 0 } }
          : {}),
      });
    }
  }

  for (const [expenseId, g] of groups.entries()) {
    if (g._txIds.length > 1) {
      g.combined = { expense_id: expenseId, transaction_ids: g._txIds, count: g._txIds.length };
      g.id = expenseId;
    }
    delete (g as { _txIds?: string[] })._txIds;
  }

  return items;
}

export async function getHistoryTransactions(): Promise<HistoryItem[]> {
  const rows = await db().getAllAsync<HistoryRow>(
    `SELECT t.*, s.splitwise_expense_id, s.description, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.status IN ('split','skipped')
     ORDER BY t.date DESC`,
    []
  );
  return groupHistoryRows(rows);
}

export async function getVacationPendingTransactions(vacationId: string): Promise<Transaction[]> {
  const rows = await db().getAllAsync<Omit<Transaction, 'pending'> & { pending: number }>(
    `SELECT * FROM transactions WHERE status = 'new' AND vacation_id = ? ORDER BY date DESC`,
    [vacationId]
  );
  return rows.map((r) => ({ ...r, pending: r.pending === 1 }));
}

export async function getVacationHistory(vacationId: string): Promise<HistoryItem[]> {
  const rows = await db().getAllAsync<HistoryRow>(
    `SELECT t.*, s.splitwise_expense_id, s.description, s.friend_names, s.amount_each
     FROM transactions t
     LEFT JOIN split_decisions s ON s.transaction_id = t.id
     WHERE t.status IN ('split','skipped') AND t.vacation_id = ?
     ORDER BY t.date DESC`,
    [vacationId]
  );
  return groupHistoryRows(rows);
}

export async function assignTransactionsToVacation(vacationId: string, transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const placeholders = transactionIds.map(() => '?').join(',');
  await db().runAsync(
    `UPDATE transactions SET vacation_id = ? WHERE id IN (${placeholders}) AND status = 'new' AND vacation_id IS NULL`,
    [vacationId, ...transactionIds]
  );
}

export async function removeTransactionFromVacation(transactionId: string): Promise<void> {
  await db().runAsync(
    `UPDATE transactions SET vacation_id = NULL WHERE id = ? AND status = 'new'`,
    [transactionId]
  );
}

export async function reconcileVacationStatuses(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  await db().withTransactionAsync(async () => {
    // Three independent phases, run in order, each seeing the previous
    // phase's writes (sequential statements in one SQLite transaction):
    //
    // 1. A draft whose entire window has already elapsed (past start AND
    //    past end) goes straight to 'ended' — it never needs the single
    //    active slot at all.
    await db().runAsync(
      `UPDATE vacations SET status = 'ended', ended_at = ?
       WHERE status = 'draft' AND start_date IS NOT NULL AND start_date <= ?
         AND end_date IS NOT NULL AND end_date < ?`,
      [now, today, today]
    );
    // 2. Activate at most one remaining due draft (earliest start_date
    //    first). SQLite's UPDATE evaluates its WHERE against the pre-update
    //    snapshot for every candidate row before writing any of them, so a
    //    plain `NOT EXISTS (... status = 'active')` guard alone would let
    //    two simultaneously-due drafts both flip to 'active' in one
    //    statement; the `id = (SELECT ... LIMIT 1)` clause caps that to one
    //    row. Phase 1 already removed any fully-elapsed draft from
    //    consideration here, so this never "wastes" the slot on one that
    //    would immediately re-end.
    await db().runAsync(
      `UPDATE vacations SET status = 'active', started_at = ?
       WHERE status = 'draft' AND start_date IS NOT NULL AND start_date <= ?
         AND NOT EXISTS (SELECT 1 FROM vacations v2 WHERE v2.status = 'active')
         AND id = (
           SELECT id FROM vacations
           WHERE status = 'draft' AND start_date IS NOT NULL AND start_date <= ?
           ORDER BY start_date ASC, id ASC LIMIT 1
         )`,
      [now, today, today]
    );
    // 3. End any already-active vacation (from a prior reconcile call, or
    //    just-activated by phase 2 with an elapsed end_date) whose end date
    //    has passed.
    await db().runAsync(
      `UPDATE vacations SET status = 'ended', ended_at = ?
       WHERE status = 'active' AND end_date IS NOT NULL AND end_date < ?`,
      [now, today]
    );
  });
}
```

Note the assertion in the test above for `assignTransactionsToVacation`'s SQL: `expect.stringContaining("SET vacation_id = ? WHERE id IN (?,?)")` matches the exact two-placeholder form for `['t1','t2']`.

- [ ] **Step 4: Run native tests to verify they pass**

Run: `npm test -- db.test.ts`
Expected: PASS, including every pre-existing `getHistoryTransactions` test — the `groupHistoryRows` refactor must not change their assertions (those tests are unchanged by this task; only the three migration-related tests fixed in Task 2 were touched).

- [ ] **Step 5: Write the failing web tests**

Add to the imports in `__tests__/lib/db.web.test.ts`: `getVacationPendingTransactions, getVacationHistory, assignTransactionsToVacation, removeTransactionFromVacation, reconcileVacationStatuses`.

```ts
describe('vacation transaction capture & history (IndexedDB)', () => {
  it('getNewTransactions excludes vacation-assigned rows', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await assignTransactionsToVacation(v.id, ['t1']);
    const rows = await getNewTransactions();
    expect(rows.map((r) => r.id)).toEqual(['t2']);
  });

  it('upsertTransactions stamps new rows with the active vacation id', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await startVacation(v.id);
    await upsertTransactions([plaidTx('t1')], v.id);
    const [row] = await getVacationPendingTransactions(v.id);
    expect(row.id).toBe('t1');
  });

  it('upsertTransactions does not stamp when no vacation id is passed', async () => {
    await upsertTransactions([plaidTx('t1')]);
    const [row] = await getNewTransactions();
    expect(row.vacation_id).toBeFalsy();
  });

  it('assignTransactionsToVacation only moves eligible (new, unassigned) rows', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await updateTransactionStatus('t2', 'skipped');
    await assignTransactionsToVacation(v.id, ['t1', 't2']);
    const pending = await getVacationPendingTransactions(v.id);
    expect(pending.map((r) => r.id)).toEqual(['t1']);
  });

  it('removeTransactionFromVacation returns a transaction to the main list', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1')]);
    await assignTransactionsToVacation(v.id, ['t1']);
    await removeTransactionFromVacation('t1');
    expect((await getNewTransactions()).map((r) => r.id)).toEqual(['t1']);
    expect(await getVacationPendingTransactions(v.id)).toHaveLength(0);
  });

  it('getVacationHistory scopes combined-split grouping to the vacation', async () => {
    const v = await createVacation({ name: 'Hawaii' });
    await upsertTransactions([plaidTx('t1'), plaidTx('t2'), plaidTx('t3')]);
    await assignTransactionsToVacation(v.id, ['t1', 't2']);
    await persistCombinedSplit([
      decision('t1', { splitwise_expense_id: 'exp_shared' }),
      decision('t2', { splitwise_expense_id: 'exp_shared' }),
    ]);
    await updateTransactionStatus('t3', 'split');
    await insertSplitDecision(decision('t3', { splitwise_expense_id: 'exp_other' }));
    const history = await getVacationHistory(v.id);
    expect(history).toHaveLength(1);
    expect(history[0].combined?.count).toBe(2);
  });

  it('reconcileVacationStatuses activates a draft whose start date has arrived', async () => {
    const past = new Date(); past.setDate(past.getDate() - 1);
    const v = await createVacation({ name: 'Hawaii', start_date: past.toISOString().slice(0, 10), end_date: '2099-01-01' });
    await reconcileVacationStatuses();
    expect((await getVacation(v.id))?.status).toBe('active');
  });

  it('reconcileVacationStatuses ends an active vacation whose end date has passed', async () => {
    const past = new Date(); past.setDate(past.getDate() - 5);
    const pastEnd = new Date(); pastEnd.setDate(pastEnd.getDate() - 1);
    const v = await createVacation({
      name: 'Hawaii',
      start_date: past.toISOString().slice(0, 10),
      end_date: pastEnd.toISOString().slice(0, 10),
    });
    await startVacation(v.id);
    await reconcileVacationStatuses();
    expect((await getVacation(v.id))?.status).toBe('ended');
  });

  it('reconcileVacationStatuses does not touch dateless (manual) vacations', async () => {
    const v = await createVacation({ name: 'Manual' });
    await reconcileVacationStatuses();
    expect((await getVacation(v.id))?.status).toBe('draft');
  });

  it('reconcileVacationStatuses activates at most one of two due, open-ended drafts', async () => {
    // Both have start_date in the past and no end_date, so createVacation's
    // overlap check (which only runs when both dates are set) never rejects
    // the second one — this is the scenario the native LIMIT-1 fix guards.
    const past = new Date(); past.setDate(past.getDate() - 3);
    const startDate = past.toISOString().slice(0, 10);
    const a = await createVacation({ name: 'A', start_date: startDate });
    const b = await createVacation({ name: 'B', start_date: startDate });
    await reconcileVacationStatuses();
    const statuses = [(await getVacation(a.id))?.status, (await getVacation(b.id))?.status];
    expect(statuses.filter((s) => s === 'active')).toHaveLength(1);
  });

  it('reconcileVacationStatuses ends a draft immediately if both its dates have already elapsed, without blocking a later activation', async () => {
    const wayPast = new Date(); wayPast.setDate(wayPast.getDate() - 10);
    const stillPast = new Date(); stillPast.setDate(stillPast.getDate() - 5);
    const recentPast = new Date(); recentPast.setDate(recentPast.getDate() - 1);
    const elapsed = await createVacation({
      name: 'Elapsed', start_date: wayPast.toISOString().slice(0, 10), end_date: stillPast.toISOString().slice(0, 10),
    });
    const current = await createVacation({
      name: 'Current', start_date: recentPast.toISOString().slice(0, 10),
    });
    await reconcileVacationStatuses();
    expect((await getVacation(elapsed.id))?.status).toBe('ended');
    expect((await getVacation(current.id))?.status).toBe('active');
  });
});
```

- [ ] **Step 6: Run web tests to verify they fail**

Run: `npm test -- db.web.test.ts`
Expected: FAIL — new exports missing.

- [ ] **Step 7: Implement in `lib/db.web.ts`**

Replace `getNewTransactions`:
```ts
export async function getNewTransactions(): Promise<Transaction[]> {
  const all = await req(db().transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new' && !t.vacation_id).sort(byDateDesc);
}
```

Replace `upsertTransactions`:
```ts
export async function upsertTransactions(txs: PlaidTransaction[], activeVacationId: string | null = null): Promise<void> {
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const now = new Date().toISOString();
  for (const p of txs) {
    const existing = await req(store.get(p.transaction_id) as IDBRequest<Transaction | undefined>);
    const name = p.merchant_name ?? p.name;
    if (!existing) {
      store.put({
        id: p.transaction_id,
        merchant_name: name,
        amount: p.amount,
        currency: p.iso_currency_code ?? 'USD',
        date: p.date,
        status: 'new',
        pending: p.pending,
        created_at: now,
        vacation_id: activeVacationId,
      } satisfies Transaction);
    } else if (existing.status === 'new') {
      store.put({ ...existing, merchant_name: name, amount: p.amount, date: p.date, pending: p.pending });
    }
  }
  await done(tx);
}
```

Refactor `getHistoryTransactions` to extract the shared grouping helper, mirroring the native refactor, and add the four new functions. Replace the whole `getHistoryTransactions` function with:
```ts
function groupHistoryRows(rows: Transaction[], decisions: SplitDecision[]): HistoryItem[] {
  const byTxId = new Map(decisions.map((d) => [d.transaction_id, d]));
  const items: HistoryItem[] = [];
  const groups = new Map<string, HistoryItem & { _txIds: string[] }>();

  for (const t of rows) {
    const d = byTxId.get(t.id);
    const title = d?.description ?? t.merchant_name;
    if (t.status === 'split' && d?.splitwise_expense_id) {
      const key = d.splitwise_expense_id;
      const existing = groups.get(key);
      if (existing) {
        existing.amount += t.amount;
        existing._txIds.push(t.id);
      } else {
        const item: HistoryItem & { _txIds: string[] } = {
          id: t.id,
          merchant_name: title,
          amount: t.amount,
          currency: t.currency,
          date: t.date,
          status: 'split',
          split: { friend_names: d.friend_names ?? [], amount_each: d.amount_each ?? 0 },
          _txIds: [t.id],
        };
        groups.set(key, item);
        items.push(item);
      }
    } else {
      items.push({
        id: t.id,
        merchant_name: title,
        amount: t.amount,
        currency: t.currency,
        date: t.date,
        status: t.status,
        ...(t.status === 'split' && d?.friend_names
          ? { split: { friend_names: d.friend_names, amount_each: d.amount_each ?? 0 } }
          : {}),
      });
    }
  }

  for (const [expenseId, g] of groups.entries()) {
    if (g._txIds.length > 1) {
      g.combined = { expense_id: expenseId, transaction_ids: g._txIds, count: g._txIds.length };
      g.id = expenseId;
    }
    delete (g as { _txIds?: string[] })._txIds;
  }

  return items;
}

export async function getHistoryTransactions(): Promise<HistoryItem[]> {
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all.filter((t) => t.status === 'split' || t.status === 'skipped').sort(byDateDesc);
  return groupHistoryRows(rows, decisions);
}

export async function getVacationPendingTransactions(vacationId: string): Promise<Transaction[]> {
  const all = await req(db().transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new' && t.vacation_id === vacationId).sort(byDateDesc);
}

export async function getVacationHistory(vacationId: string): Promise<HistoryItem[]> {
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const rows = all
    .filter((t) => (t.status === 'split' || t.status === 'skipped') && t.vacation_id === vacationId)
    .sort(byDateDesc);
  return groupHistoryRows(rows, decisions);
}

export async function assignTransactionsToVacation(vacationId: string, transactionIds: string[]): Promise<void> {
  if (transactionIds.length === 0) return;
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  for (const id of transactionIds) {
    const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
    if (existing && existing.status === 'new' && !existing.vacation_id) {
      store.put({ ...existing, vacation_id: vacationId });
    }
  }
  await done(tx);
}

export async function removeTransactionFromVacation(transactionId: string): Promise<void> {
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(transactionId) as IDBRequest<Transaction | undefined>);
  if (existing && existing.status === 'new') store.put({ ...existing, vacation_id: null });
  await done(tx);
}

export async function reconcileVacationStatuses(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const tx = db().transaction(VACATION_STORE, 'readwrite');
  const store = tx.objectStore(VACATION_STORE);
  const all = await req(store.getAll() as IDBRequest<Vacation[]>);

  // Mirrors the three-phase SQL in lib/db.ts's reconcileVacationStatuses —
  // see that function's comments for why each phase exists. All three phases
  // read from this same `all` snapshot (matching how each native UPDATE
  // statement's WHERE evaluates against the state at the start of that
  // statement) rather than re-querying mid-function.

  // 1. Fully-elapsed drafts go straight to 'ended'.
  const elapsedIds = new Set<string>();
  for (const v of all) {
    if (v.status === 'draft' && v.start_date && v.start_date <= today && v.end_date && v.end_date < today) {
      store.put({ ...v, status: 'ended' as VacationStatus, ended_at: now });
      elapsedIds.add(v.id);
    }
  }

  // 2. Activate at most one remaining due draft, earliest start_date first —
  //    phase 1 already excluded any candidate that would immediately re-end.
  const hasActive = all.some((v) => v.status === 'active');
  if (!hasActive) {
    const dueDrafts = all
      .filter((v) => v.status === 'draft' && !elapsedIds.has(v.id) && v.start_date && v.start_date <= today)
      .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''));
    const next = dueDrafts[0];
    if (next) store.put({ ...next, status: 'active' as VacationStatus, started_at: now });
  }

  // 3. End any already-active vacation (from a prior call) whose end date
  //    has passed.
  for (const v of all) {
    if (v.status === 'active' && v.end_date && v.end_date < today) {
      store.put({ ...v, status: 'ended' as VacationStatus, ended_at: now });
    }
  }

  await done(tx);
}
```

- [ ] **Step 8: Run web tests, native tests, and the parity test**

Run: `npm test -- db.test.ts db.web.test.ts db.parity.test.ts`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add lib/db.ts lib/db.web.ts __tests__/lib/db.test.ts __tests__/lib/db.web.test.ts
git commit -m "feat(db): capture transactions into active vacations, scope history, reconcile status"
```

---

### Task 4: Splitwise groups + group-linked expenses

**Files:**
- Modify: `lib/splitwise.ts`
- Test: `__tests__/lib/splitwise.test.ts`

**Interfaces:**
- Consumes: `SplitwiseGroup` (`lib/types.ts`), `splitwiseFetch` (`lib/splitwiseTransport.ts`).
- Produces: `getGroups(): Promise<SplitwiseGroup[]>`; `ExpenseParams.groupId?: string` (threads into `create_expense`/`update_expense` as `group_id`).

On web, `splitwiseFetch` (`lib/splitwiseTransport.web.ts`) doesn't call `secure.splitwise.com` directly — it tunnels through a Cloudflare Worker proxy (`${baseUrl}/splitwise/api${path}`, per that file's own header comment) because Splitwise doesn't send CORS headers. That Worker's source isn't in this repo, so this task's unit tests (which mock `splitwiseFetch` / `fetch` directly, same as the rest of `splitwise.test.ts`) will pass regardless, but the manual QA pass in Task 14 could still hit a 404/allowlist rejection on the web build specifically if the Worker only proxies a fixed set of paths. If step 8 of Task 14's manual pass fails only on web (native `getGroups` works, web doesn't), that Worker allowlist is the first thing to check — it's outside this repo's edit surface.

- [ ] **Step 1: Write the failing tests**

Append to `__tests__/lib/splitwise.test.ts` (add `getGroups` to the existing import line):

```ts
test('getGroups returns mapped groups with member ids and names', async () => {
  mockResponse({
    groups: [
      {
        id: 55,
        name: 'Hawaii Trip',
        members: [
          { id: 1, first_name: 'Me', last_name: '' },
          { id: 2, first_name: 'Sam', last_name: 'K' },
        ],
      },
    ],
  });
  const groups = await getGroups();
  expect(groups).toEqual([
    { id: '55', name: 'Hawaii Trip', member_ids: ['1', '2'], member_names: ['Me', 'Sam K'] },
  ]);
});

test('getGroups throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(getGroups()).rejects.toThrow(SplitwiseAuthError);
});

test('createExpense includes group_id when provided', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await createExpense({
    amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'], groupId: '55',
  });
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.get('group_id')).toBe('55');
});

test('createExpense omits group_id when not provided', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await createExpense({ amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'] });
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.has('group_id')).toBe(false);
});

test('updateExpense includes group_id when provided', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  await updateExpense('1', {
    amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'], groupId: '55',
  });
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.get('group_id')).toBe('55');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- splitwise.test.ts`
Expected: FAIL — `getGroups` is not exported; `group_id` assertions fail.

- [ ] **Step 3: Implement in `lib/splitwise.ts`**

Add the import and a raw-group interface near the top:
```ts
import { SplitwiseFriend, SplitwiseGroup } from '@/lib/types';
```

Add after `getFriends`:
```ts
interface RawGroupMember {
  id: number;
  first_name: string;
  last_name: string;
}

interface RawGroup {
  id: number;
  name: string;
  members: RawGroupMember[];
}

export async function getGroups(): Promise<SplitwiseGroup[]> {
  const data = await swGet<{ groups: RawGroup[] }>('/get_groups');
  return data.groups.map((g) => ({
    id: String(g.id),
    name: g.name,
    member_ids: g.members.map((m) => String(m.id)),
    member_names: g.members.map((m) => `${m.first_name} ${m.last_name}`.trim()),
  }));
}
```

In `ExpenseParams`, add the optional field:
```ts
interface ExpenseParams {
  amount: number;
  description: string;
  currency: string;
  currentUserId: string;
  friendIds: string[];
  friendShares?: Record<string, number>;
  groupId?: string;
}
```

In `buildExpenseBody`, add `group_id` to the body when present (insert right after the `body` object literal is constructed, before the `if (params.friendShares)` branch):
```ts
  if (params.groupId) {
    body['group_id'] = params.groupId;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- splitwise.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/splitwise.ts __tests__/lib/splitwise.test.ts
git commit -m "feat(splitwise): add getGroups and group-linked expense creation"
```

---

### Task 5: `stores/vacationStore.ts`

**Files:**
- Create: `stores/vacationStore.ts`
- Test: `__tests__/stores/vacationStore.test.ts`

**Interfaces:**
- Consumes: `createVacation, getVacations, startVacation, endVacation, deleteVacation, reconcileVacationStatuses` (`lib/db.ts` — Metro resolves to `db.web.ts` on web, same signatures), `Vacation, CreateVacationInput` (`lib/types.ts`).
- Produces: `useVacationStore` zustand hook with state `{ vacations: Vacation[]; activeVacation: Vacation | null; isLoading: boolean }` and actions `load(): Promise<void>`, `reconcile(): Promise<void>`, `create(input: CreateVacationInput): Promise<Vacation>`, `startVacation(id: string): Promise<void>`, `endVacation(id: string): Promise<void>`, `deleteVacation(id: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`__tests__/stores/vacationStore.test.ts`:
```ts
jest.mock('@/lib/db');

import * as db from '@/lib/db';
import { useVacationStore } from '@/stores/vacationStore';
import { Vacation } from '@/lib/types';

const mockGetVacations = db.getVacations as jest.Mock;
const mockCreateVacation = db.createVacation as jest.Mock;
const mockStart = db.startVacation as jest.Mock;
const mockEnd = db.endVacation as jest.Mock;
const mockDelete = db.deleteVacation as jest.Mock;
const mockReconcile = db.reconcileVacationStatuses as jest.Mock;

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Hawaii', start_date: null, end_date: null, status: 'draft',
    splitwise_group_id: null, splitwise_group_name: null, splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null, ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  useVacationStore.setState({ vacations: [], activeVacation: null, isLoading: false });
  mockGetVacations.mockResolvedValue([]);
  mockCreateVacation.mockResolvedValue(vac());
  mockStart.mockResolvedValue(undefined);
  mockEnd.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
  mockReconcile.mockResolvedValue(undefined);
});

test('load fetches vacations and derives the active one', async () => {
  mockGetVacations.mockResolvedValue([vac({ id: 'v1', status: 'active' }), vac({ id: 'v2', status: 'ended' })]);
  await useVacationStore.getState().load();
  const state = useVacationStore.getState();
  expect(state.vacations).toHaveLength(2);
  expect(state.activeVacation?.id).toBe('v1');
});

test('load with no active vacation leaves activeVacation null', async () => {
  mockGetVacations.mockResolvedValue([vac({ status: 'ended' })]);
  await useVacationStore.getState().load();
  expect(useVacationStore.getState().activeVacation).toBeNull();
});

test('reconcile calls db.reconcileVacationStatuses then reloads', async () => {
  mockGetVacations.mockResolvedValue([vac({ status: 'active' })]);
  await useVacationStore.getState().reconcile();
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(useVacationStore.getState().activeVacation?.status).toBe('active');
});

test('create calls db.createVacation, reconciles, and returns the new vacation', async () => {
  const created = vac({ id: 'new1', name: 'Ski' });
  mockCreateVacation.mockResolvedValue(created);
  mockGetVacations.mockResolvedValue([created]);
  const result = await useVacationStore.getState().create({ name: 'Ski' });
  expect(mockCreateVacation).toHaveBeenCalledWith({ name: 'Ski' });
  // Reconciling (not a plain reload) matters here: a vacation whose
  // start_date is today must activate immediately on creation, not wait for
  // the next sync/foreground reconcile.
  expect(mockReconcile).toHaveBeenCalledTimes(1);
  expect(result).toEqual(created);
  expect(useVacationStore.getState().vacations).toEqual([created]);
});

test('startVacation calls db.startVacation and reloads', async () => {
  mockGetVacations.mockResolvedValue([vac({ status: 'active' })]);
  await useVacationStore.getState().startVacation('v1');
  expect(mockStart).toHaveBeenCalledWith('v1');
  expect(useVacationStore.getState().activeVacation?.id).toBe('v1');
});

test('startVacation propagates a conflict error without reloading', async () => {
  mockStart.mockRejectedValue(new Error('already_active'));
  await expect(useVacationStore.getState().startVacation('v1')).rejects.toThrow();
  expect(mockGetVacations).not.toHaveBeenCalled();
});

test('endVacation calls db.endVacation and reloads', async () => {
  await useVacationStore.getState().endVacation('v1');
  expect(mockEnd).toHaveBeenCalledWith('v1');
  expect(mockGetVacations).toHaveBeenCalled();
});

test('deleteVacation calls db.deleteVacation and reloads', async () => {
  await useVacationStore.getState().deleteVacation('v1');
  expect(mockDelete).toHaveBeenCalledWith('v1');
  expect(mockGetVacations).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- vacationStore.test.ts`
Expected: FAIL — `@/stores/vacationStore` doesn't exist.

- [ ] **Step 3: Implement**

`stores/vacationStore.ts`:
```ts
// mobile/stores/vacationStore.ts
import { create } from 'zustand';
import {
  getVacations,
  createVacation,
  startVacation as dbStartVacation,
  endVacation as dbEndVacation,
  deleteVacation as dbDeleteVacation,
  reconcileVacationStatuses,
} from '@/lib/db';
import { Vacation, CreateVacationInput } from '@/lib/types';

interface VacationState {
  vacations: Vacation[];
  activeVacation: Vacation | null;
  isLoading: boolean;
  load: () => Promise<void>;
  reconcile: () => Promise<void>;
  create: (input: CreateVacationInput) => Promise<Vacation>;
  startVacation: (id: string) => Promise<void>;
  endVacation: (id: string) => Promise<void>;
  deleteVacation: (id: string) => Promise<void>;
}

export const useVacationStore = create<VacationState>((set, get) => ({
  vacations: [],
  activeVacation: null,
  isLoading: false,

  load: async () => {
    set({ isLoading: true });
    const vacations = await getVacations();
    const activeVacation = vacations.find((v) => v.status === 'active') ?? null;
    set({ vacations, activeVacation, isLoading: false });
  },

  reconcile: async () => {
    await reconcileVacationStatuses();
    await get().load();
  },

  create: async (input) => {
    const vacation = await createVacation(input);
    // Reconcile (not just reload) so a vacation whose start_date is today
    // activates immediately, per spec — see reconcile()'s comment.
    await get().reconcile();
    return vacation;
  },

  startVacation: async (id) => {
    await dbStartVacation(id);
    await get().load();
  },

  endVacation: async (id) => {
    await dbEndVacation(id);
    await get().load();
  },

  deleteVacation: async (id) => {
    await dbDeleteVacation(id);
    await get().load();
  },
}));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- vacationStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add stores/vacationStore.ts __tests__/stores/vacationStore.test.ts
git commit -m "feat: add vacationStore for vacation lifecycle state"
```

---

### Task 6: Wire vacation reconciliation and capture into `transactionStore.refresh()` and app startup

**Files:**
- Modify: `stores/transactionStore.ts`
- Modify: `app/(tabs)/_layout.tsx`
- Test: `__tests__/stores/transactionStore.test.ts`

**Interfaces:**
- Consumes: `useVacationStore` (`stores/vacationStore.ts` — Task 5).
- Produces: no new exports; `refresh()` now calls `useVacationStore.getState().reconcile()` before syncing, and passes `useVacationStore.getState().activeVacation?.id ?? null` as `upsertTransactions`'s second argument. `app/(tabs)/_layout.tsx` also reconciles once on app startup, so a dated vacation transitions even before the first Transactions-tab refresh.

- [ ] **Step 1: Write the failing test**

Add `jest.mock('@/stores/vacationStore');` to the top of `__tests__/stores/transactionStore.test.ts` (alongside the existing `jest.mock('@/stores/plaidStore');`), and add the import:
```ts
import { useVacationStore } from '@/stores/vacationStore';
```

Declare `mockReconcile` at file scope, alongside the other `mock*` consts (e.g. right after `const mockRevertCombined = db.revertCombinedSplit as jest.Mock;`), so both `beforeEach` and the test bodies below can see it:
```ts
const mockReconcile = jest.fn();
```

In `beforeEach`, add:
```ts
  mockReconcile.mockResolvedValue(undefined);
  (useVacationStore.getState as jest.Mock) = jest.fn().mockReturnValue({
    reconcile: mockReconcile,
    activeVacation: null,
  });
```

This task also breaks three pre-existing assertions that must be fixed now, before Step 2, or they'll fail once `refresh()` calls `upsertTransactions` with a second argument: `toHaveBeenCalledWith(expect.arrayContaining([...]))` requires an exact-arity match, and after this task's implementation the call always has two arguments. In the existing tests `refresh calls worker, upserts added, deletes removed, updates cursor`, `refresh follows has_more pages and saves the final cursor`, and `first sync (no cursor) drains the backlog without storing transactions`, change every
```ts
expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([...]))
```
to
```ts
expect(mockUpsert).toHaveBeenCalledWith(expect.arrayContaining([...]), null)
```
(three call sites total — the array contents inside `arrayContaining([...])` stay exactly as they are, only the trailing `, null` is added).

Now add these new tests:
```ts
test('refresh reconciles vacation statuses before syncing', async () => {
  mockFetchTxs.mockResolvedValue(syncPage());
  await useTransactionStore.getState().refresh();
  expect(mockReconcile).toHaveBeenCalledTimes(1);
});

test('refresh threads the active vacation id into upsertTransactions', async () => {
  (useVacationStore.getState as jest.Mock).mockReturnValue({
    reconcile: mockReconcile,
    activeVacation: { id: 'vac1' },
  });
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockUpsert).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ transaction_id: 'tx2' })]),
    'vac1'
  );
});

test('refresh passes null when no vacation is active', async () => {
  mockFetchTxs.mockResolvedValue(syncPage({
    added: [{ transaction_id: 'tx2', merchant_name: 'Amazon', name: 'AMZN', amount: 29.99, iso_currency_code: 'USD', date: '2026-04-02' }],
  }));
  await useTransactionStore.getState().refresh();
  expect(mockUpsert).toHaveBeenCalledWith(expect.any(Array), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- transactionStore.test.ts`
Expected: FAIL — `reconcile` never called, `upsertTransactions` called with only one argument.

- [ ] **Step 3: Implement**

In `stores/transactionStore.ts`, add the import:
```ts
import { useVacationStore } from '@/stores/vacationStore';
```

In `refresh()`, `set({ isLoading: true });` runs before the `try` block — as the first statement inside that `try` block, add:
```ts
      await useVacationStore.getState().reconcile();
      const activeVacationId = useVacationStore.getState().activeVacation?.id ?? null;
```

Change the upsert call inside the loop from:
```ts
            await upsertTransactions([...res.added, ...res.modified]);
```
to:
```ts
            await upsertTransactions([...res.added, ...res.modified], activeVacationId);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- transactionStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Reconcile once on app startup**

The spec commits to reconciling "once at app startup (in the tabs layout, alongside the existing `pruneOldTransactions()` call)" so a dated vacation transitions even before the user pulls to refresh. `app/(tabs)/_layout.tsx` already runs `pruneOldTransactions()` in a `useEffect` on mount — add the same call there. This is a screen-adjacent file with no existing test file (matches this codebase's convention of not unit-testing `app/**` — see Task 11's note), so this step is manual-only; Task 14's regression pass covers it.

In `app/(tabs)/_layout.tsx`, add the import:
```ts
import { useVacationStore } from '@/stores/vacationStore';
```
Add inside the existing `useEffect`, alongside the `loadFriends()` call:
```tsx
export default function TabsLayout() {
  const count = useTransactionStore((s) => s.transactions.length);
  const loadFriends = useFriendStore((s) => s.load);
  const reconcileVacations = useVacationStore((s) => s.reconcile);

  useEffect(() => {
    loadFriends();
    reconcileVacations();
    pruneOldTransactions().catch(console.error);
  }, []);
```
(Only the `reconcileVacations` line and its destructuring are new — the rest of the component is unchanged.)

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all PASS — this is the last integration point that touches a widely-mocked module.

- [ ] **Step 7: Commit**

```bash
git add stores/transactionStore.ts "app/(tabs)/_layout.tsx" __tests__/stores/transactionStore.test.ts
git commit -m "feat: reconcile vacations and capture synced transactions into the active one"
```

---

### Task 7: `FriendPickerSheet` group-aware splitting

**Files:**
- Modify: `components/FriendPickerSheet.tsx`
- Test: `__tests__/components/FriendPickerSheet.test.tsx`

**Interfaces:**
- Consumes: none new (existing `createExpense`/`updateExpense` from Task 4 already accept `groupId`).
- Produces: two new optional props on `FriendPickerSheet`: `groupId?: string`, `groupMemberIds?: string[]`.

- [ ] **Step 1: Write the failing tests**

Add to `__tests__/components/FriendPickerSheet.test.tsx`:
```ts
test('passes groupId through to createExpense when set', async () => {
  render(
    <FriendPickerSheet
      transaction={{ ...tx, status: 'new' }}
      groupId="55"
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  fireEvent.press(screen.getByLabelText('Sam'));
  fireEvent.press(screen.getByLabelText('Add split to Splitwise'));
  await waitFor(() => expect(mockCreateExpense).toHaveBeenCalledTimes(1));
  expect(mockCreateExpense).toHaveBeenCalledWith(expect.objectContaining({ groupId: '55' }));
});

test('sorts group members ahead of other friends without hiding non-members', async () => {
  // Store order is Sam-then-Zoe and Zoe is the group member, so this only
  // passes once the groupMemberIds sort actually runs — with the fix absent,
  // the assertion below would see ['Sam', 'Zoe'] (the store's own order) and
  // fail, unlike a fixture that already happens to match the sorted output.
  (useFriendStore as jest.Mock).mockReturnValue({
    friends: [
      { id: '2', display_name: 'Sam', avatar_url: null },
      { id: '3', display_name: 'Zoe', avatar_url: null },
    ],
    isLoading: false,
  });
  render(
    <FriendPickerSheet
      transaction={{ ...tx, status: 'new' }}
      groupId="55"
      groupMemberIds={['3']}
      openToken={1}
      onSuccess={jest.fn()}
    />
  );
  const names = screen.getAllByRole('checkbox').map((el) => el.props.accessibilityLabel);
  expect(names).toEqual(['Zoe', 'Sam']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- FriendPickerSheet.test.tsx`
Expected: FAIL — `groupId` is dropped (not passed to `createExpense`); the order test sees `['Sam', 'Zoe']` (the store's own order, since nothing sorts by `groupMemberIds` yet) instead of the expected `['Zoe', 'Sam']`.

- [ ] **Step 3: Implement**

In `components/FriendPickerSheet.tsx`, extend `Props`:
```ts
interface Props {
  transaction: Transaction | null;
  combineTransactions?: Transaction[];
  mode?: 'create' | 'edit';
  editDecision?: SplitDecision | null;
  openToken?: number;
  onSuccess: (amountEach: number) => void;
  groupId?: string;
  groupMemberIds?: string[];
}
```

Destructure the new props in the component signature:
```ts
export const FriendPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, combineTransactions, mode = 'create', editDecision, openToken, onSuccess, groupId, groupMemberIds }, ref) => {
```

Change the `filtered` memo to sort group members first (still showing everyone, search included):
```ts
    const filtered = useMemo(() => {
      const q = query.trim().toLowerCase();
      const base = q ? friends.filter((f) => f.display_name.toLowerCase().includes(q)) : friends;
      if (!groupMemberIds || groupMemberIds.length === 0) return base;
      const memberSet = new Set(groupMemberIds);
      return [...base].sort((a, b) => Number(memberSet.has(b.id)) - Number(memberSet.has(a.id)));
    }, [friends, query, groupMemberIds]);
```

In `handleAddToSplitwise`, add `groupId` to both the create and update calls. For the create path, change:
```ts
        const { expense_id, amount_each } = await createExpense({
          amount: totalAmount,
          description: desc,
          currency,
          currentUserId: user_id!,
          friendIds,
          ...shares,
        });
```
to:
```ts
        const { expense_id, amount_each } = await createExpense({
          amount: totalAmount,
          description: desc,
          currency,
          currentUserId: user_id!,
          friendIds,
          groupId,
          ...shares,
        });
```
For the edit path, change:
```ts
          const { amount_each } = await updateExpense(editDecision.splitwise_expense_id, {
            amount: totalAmount,
            description: desc,
            currency,
            currentUserId: user_id!,
            friendIds,
            ...shares,
          });
```
to:
```ts
          const { amount_each } = await updateExpense(editDecision.splitwise_expense_id, {
            amount: totalAmount,
            description: desc,
            currency,
            currentUserId: user_id!,
            friendIds,
            groupId,
            ...shares,
          });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- FriendPickerSheet.test.tsx`
Expected: PASS. `groupId: undefined` is harmless in the two existing non-group tests (`buildExpenseBody`'s `if (params.groupId)` check from Task 4 already treats `undefined` as absent).

- [ ] **Step 5: Commit**

```bash
git add components/FriendPickerSheet.tsx __tests__/components/FriendPickerSheet.test.tsx
git commit -m "feat: let FriendPickerSheet post to a linked Splitwise group"
```

---

### Task 8: `TransactionRow` remove-from-vacation variant

**Files:**
- Modify: `components/TransactionRow.tsx`
- Test: `__tests__/components/TransactionRow.test.tsx`

**Interfaces:**
- Produces: new optional prop `variant?: 'skip' | 'remove'` (default `'skip'`). When `'remove'`, the swipe-underlay and action button read "Remove [merchant] from vacation" / icon `trash-outline` instead of "Skip [merchant]" / `close-outline`, both still calling the existing `onSkip` callback (renamed in call sites to whatever's semantically correct — the prop itself keeps its name to avoid touching every existing call site).

- [ ] **Step 1: Write the failing test**

Add to `__tests__/components/TransactionRow.test.tsx`:
```ts
test('remove variant labels the action as removing from vacation', () => {
  const onSkip = jest.fn();
  render(<TransactionRow transaction={tx} onSkip={onSkip} onSplit={jest.fn()} variant="remove" />);
  expect(screen.queryByLabelText('Skip Amazon')).toBeNull();
  fireEvent.press(screen.getByLabelText('Remove Amazon from vacation'));
  expect(onSkip).toHaveBeenCalled();
});

test('default variant keeps the existing skip label', () => {
  render(<TransactionRow transaction={tx} onSkip={jest.fn()} onSplit={jest.fn()} />);
  expect(screen.getByLabelText('Skip Amazon')).toBeTruthy();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- TransactionRow.test.tsx`
Expected: FAIL — `variant` prop doesn't exist, label stays "Skip Amazon".

- [ ] **Step 3: Implement**

In `components/TransactionRow.tsx`, extend `Props` and the signature:
```ts
interface Props {
  transaction: Transaction;
  onSkip: () => void;
  onSplit: () => void;
  onLongPress?: () => void;
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
  variant?: 'skip' | 'remove';
}

export function TransactionRow({ transaction, onSkip, onSplit, onLongPress, selectMode, selected, onToggleSelect, variant = 'skip' }: Props) {
```

Add two derived constants right after the existing `avatarBg` line:
```ts
  const removeMode = variant === 'remove';
  const skipIcon = removeMode ? 'trash-outline' : 'close-circle-outline';
  const skipBtnIcon = removeMode ? 'trash-outline' : 'close-outline';
  const skipLabel = removeMode ? `Remove ${transaction.merchant_name} from vacation` : `Skip ${transaction.merchant_name}`;
  const skipUnderlayLabel = removeMode ? 'Remove' : 'Skip';
```

Update `renderSkipUnderlay` to use them:
```ts
  const renderSkipUnderlay = () => (
    <Pressable
      style={styles.skipUnderlay}
      onPress={onSkip}
      accessibilityRole="button"
      accessibilityLabel={skipLabel}
    >
      <Ionicons name={skipIcon} size={22} color={Colors.textSecondary} />
      <Text style={styles.skipUnderlayText}>{skipUnderlayLabel}</Text>
    </Pressable>
  );
```

Update the inline skip button (inside `styles.actions`):
```tsx
          <Pressable
            style={({ pressed }) => [styles.btn, styles.skipBtn, pressed && styles.skipBtnPressed]}
            onPress={onSkip}
            accessibilityRole="button"
            accessibilityLabel={skipLabel}
          >
            <Ionicons name={skipBtnIcon} size={14} color={Colors.textSecondary} />
          </Pressable>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- TransactionRow.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/TransactionRow.tsx __tests__/components/TransactionRow.test.tsx
git commit -m "feat: add a remove-from-vacation variant to TransactionRow"
```

---

### Task 9: `VacationBanner` on the Transactions tab

**Files:**
- Create: `components/VacationBanner.tsx`
- Modify: `app/(tabs)/index.tsx`
- Test: `__tests__/components/VacationBanner.test.tsx`

**Interfaces:**
- Consumes: `useVacationStore` (Task 5), `Vacation` (`lib/types.ts`).
- Produces: `VacationBanner` component (no props — reads `useVacationStore` directly and calls `router.push` from `expo-router`'s `useRouter`).

- [ ] **Step 1: Write the failing tests**

`__tests__/components/VacationBanner.test.tsx`:
```ts
jest.mock('@/stores/vacationStore', () => ({ useVacationStore: jest.fn() }));
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (cb: () => void) => cb(),
}));
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));

const mockPush = jest.fn();

import { render, fireEvent, screen } from '@testing-library/react-native';
import { VacationBanner } from '@/components/VacationBanner';
import { useVacationStore } from '@/stores/vacationStore';
import { Vacation } from '@/lib/types';

function vac(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 'v1', name: 'Hawaii', start_date: null, end_date: null, status: 'draft',
    splitwise_group_id: null, splitwise_group_name: null, splitwise_group_member_ids: null,
    created_at: 'x', started_at: null, ended_at: null, ...over,
  };
}

const mockLoad = jest.fn();

function mockStore(state: { vacations: Vacation[]; activeVacation: Vacation | null }) {
  (useVacationStore as unknown as jest.Mock).mockImplementation((sel) => sel({ ...state, load: mockLoad }));
}

beforeEach(() => {
  jest.clearAllMocks();
});

test('shows a create CTA when there are no vacations at all', () => {
  mockStore({ vacations: [], activeVacation: null });
  render(<VacationBanner />);
  fireEvent.press(screen.getByLabelText('Create a vacation'));
  expect(mockPush).toHaveBeenCalledWith('/vacation');
});

test('shows the in-progress vacation and jumps straight to its detail screen', () => {
  const v = vac({ id: 'v1', status: 'active', name: 'Hawaii' });
  mockStore({ vacations: [v], activeVacation: v });
  render(<VacationBanner />);
  expect(screen.getByText('Hawaii')).toBeTruthy();
  expect(screen.getByText('Active vacation')).toBeTruthy();
  fireEvent.press(screen.getByLabelText('Open Hawaii vacation'));
  expect(mockPush).toHaveBeenCalledWith('/vacation/v1');
});

test('shows the date range instead of the status line when the vacation has dates', () => {
  const v = vac({ id: 'v1', status: 'active', name: 'Hawaii', start_date: '2026-08-01', end_date: '2026-08-10' });
  mockStore({ vacations: [v], activeVacation: v });
  render(<VacationBanner />);
  expect(screen.getByText('2026-08-01 – 2026-08-10')).toBeTruthy();
});

test('shows a compact link when only ended vacations exist', () => {
  mockStore({ vacations: [vac({ status: 'ended' })], activeVacation: null });
  render(<VacationBanner />);
  fireEvent.press(screen.getByLabelText('View vacations'));
  expect(mockPush).toHaveBeenCalledWith('/vacation');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- VacationBanner.test.tsx`
Expected: FAIL — `@/components/VacationBanner` doesn't exist.

- [ ] **Step 3: Implement**

`components/VacationBanner.tsx`:
```tsx
// mobile/components/VacationBanner.tsx
import { useCallback } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useVacationStore } from '@/stores/vacationStore';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

export function VacationBanner() {
  const router = useRouter();
  const vacations = useVacationStore((s) => s.vacations);
  const activeVacation = useVacationStore((s) => s.activeVacation);
  const load = useVacationStore((s) => s.load);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const inProgress = activeVacation ?? vacations.find((v) => v.status === 'draft') ?? null;

  if (inProgress) {
    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        onPress={() => router.push(`/vacation/${inProgress.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`Open ${inProgress.name} vacation`}
      >
        <View style={styles.icon}>
          <Ionicons name="airplane-outline" size={18} color={Colors.primary} />
        </View>
        <View style={styles.info}>
          <Text style={styles.title}>{inProgress.name}</Text>
          <Text style={styles.subtitle}>
            {inProgress.start_date && inProgress.end_date
              ? `${inProgress.start_date} – ${inProgress.end_date}`
              : inProgress.status === 'active' ? 'Active vacation' : 'Not started yet'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      </Pressable>
    );
  }

  if (vacations.length === 0) {
    return (
      <Pressable
        style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
        onPress={() => router.push('/vacation')}
        accessibilityRole="button"
        accessibilityLabel="Create a vacation"
      >
        <View style={styles.icon}>
          <Ionicons name="airplane-outline" size={18} color={Colors.primary} />
        </View>
        <View style={styles.info}>
          <Text style={styles.title}>Track vacation spending separately</Text>
          <Text style={styles.subtitle}>Create a vacation</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={Colors.textTertiary} />
      </Pressable>
    );
  }

  return (
    <Pressable
      style={styles.linkRow}
      onPress={() => router.push('/vacation')}
      accessibilityRole="button"
      accessibilityLabel="View vacations"
    >
      <Ionicons name="airplane-outline" size={14} color={Colors.primary} style={{ marginRight: 6 }} />
      <Text style={styles.linkText}>Vacations</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
    ...Shadow.sm,
  },
  cardPressed: { backgroundColor: Colors.surfaceMuted },
  icon: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.primaryMuted,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  info: { flex: 1 },
  title: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  subtitle: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },

  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  linkText: { fontSize: 13, fontWeight: '600', color: Colors.primary },
});
```

In `app/(tabs)/index.tsx`, add the import:
```ts
import { VacationBanner } from '@/components/VacationBanner';
```
Render it right after the closing `</View>` of the `header` block and before the `{needsReauth && ...}` line:
```tsx
      <VacationBanner />

      {needsReauth && <ReauthBanner onPress={handleReauth} />}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- VacationBanner.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/VacationBanner.tsx app/\(tabs\)/index.tsx __tests__/components/VacationBanner.test.tsx
git commit -m "feat: show a vacation banner on the Transactions tab"
```

---

### Task 10: `AddToVacationSheet` — pick unassigned transactions to add

**Files:**
- Create: `components/AddToVacationSheet.tsx`
- Test: `__tests__/components/AddToVacationSheet.test.tsx`

**Interfaces:**
- Consumes: `getNewTransactions` (`lib/db.ts`), `assignTransactionsToVacation` (`lib/db.ts` — Task 3), `Transaction` (`lib/types.ts`).
- Produces: `AddToVacationSheet`, a `forwardRef<BottomSheetModal, Props>` component with `Props = { vacationId: string; openToken?: number; onDone: () => void }`. Fetches unassigned `new` transactions on each open (keyed by `openToken`, matching `FriendPickerSheet`'s re-open pattern), multi-select, confirm calls `assignTransactionsToVacation` then `onDone()`.

- [ ] **Step 1: Write the failing tests**

`__tests__/components/AddToVacationSheet.test.tsx`:
```ts
jest.mock('@gorhom/bottom-sheet', () => require('@gorhom/bottom-sheet/mock'));
jest.mock('@/lib/db');
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));

import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AddToVacationSheet } from '@/components/AddToVacationSheet';
import * as db from '@/lib/db';
import { Transaction } from '@/lib/types';

const mockGetNew = db.getNewTransactions as jest.Mock;
const mockAssign = db.assignTransactionsToVacation as jest.Mock;

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
  return { id, merchant_name: `M${id}`, amount: 10, currency: 'USD', date: '2026-08-01', status: 'new', pending: false, created_at: 'x', ...over };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetNew.mockResolvedValue([tx('t1'), tx('t2')]);
  mockAssign.mockResolvedValue(undefined);
});

test('lists unassigned transactions on open and re-fetches when openToken changes', async () => {
  const { rerender } = render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('M t1'.replace(' ', ''))).toBeTruthy());
  mockGetNew.mockResolvedValue([tx('t3')]);
  rerender(<AddToVacationSheet vacationId="v1" openToken={2} onDone={jest.fn()} />);
  await waitFor(() => expect(mockGetNew).toHaveBeenCalledTimes(2));
});

test('selecting rows and confirming assigns them and calls onDone', async () => {
  const onDone = jest.fn();
  render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={onDone} />);
  await waitFor(() => expect(screen.getByLabelText('Select Mt1')).toBeTruthy());

  fireEvent.press(screen.getByLabelText('Select Mt1'));
  fireEvent.press(screen.getByLabelText('Add to vacation'));

  await waitFor(() => expect(mockAssign).toHaveBeenCalledWith('v1', ['t1']));
  expect(onDone).toHaveBeenCalled();
});

test('confirm button is disabled with nothing selected', async () => {
  render(<AddToVacationSheet vacationId="v1" openToken={1} onDone={jest.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('Select Mt1')).toBeTruthy());
  fireEvent.press(screen.getByLabelText('Add to vacation'));
  expect(mockAssign).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- AddToVacationSheet.test.tsx`
Expected: FAIL — `@/components/AddToVacationSheet` doesn't exist.

- [ ] **Step 3: Implement**

`components/AddToVacationSheet.tsx`:
```tsx
// mobile/components/AddToVacationSheet.tsx
import { forwardRef, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView, BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { getNewTransactions, assignTransactionsToVacation } from '@/lib/db';
import { Transaction } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  vacationId: string;
  openToken?: number;
  onDone: () => void;
}

export const AddToVacationSheet = forwardRef<BottomSheetModal, Props>(
  ({ vacationId, openToken, onDone }, ref) => {
    const [candidates, setCandidates] = useState<Transaction[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      setSelected(new Set());
      getNewTransactions().then(setCandidates).catch(() => setCandidates([]));
    }, [openToken]);

    function toggle(id: string) {
      setSelected((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
    }

    async function confirm() {
      if (selected.size === 0) return;
      setSubmitting(true);
      try {
        await assignTransactionsToVacation(vacationId, [...selected]);
        onDone();
      } finally {
        setSubmitting(false);
      }
    }

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['70%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          <Text style={styles.title}>Add transactions</Text>
          {candidates.length === 0 ? (
            <Text style={styles.empty}>No unassigned transactions to add.</Text>
          ) : (
            <BottomSheetFlatList
              data={candidates}
              keyExtractor={(t) => t.id}
              style={styles.list}
              renderItem={({ item }) => {
                const isSelected = selected.has(item.id);
                const color = merchantColor(item.merchant_name);
                return (
                  <Pressable
                    style={[styles.row, isSelected && styles.rowSelected]}
                    onPress={() => toggle(item.id)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: isSelected }}
                    accessibilityLabel={`Select ${item.merchant_name}`}
                  >
                    <View style={[styles.avatar, { backgroundColor: color + '18' }]}>
                      <Text style={[styles.avatarText, { color }]}>{item.merchant_name[0].toUpperCase()}</Text>
                    </View>
                    <Text style={styles.name} numberOfLines={1}>{item.merchant_name}</Text>
                    <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
                    <View style={[styles.checkbox, isSelected && styles.checkboxSelected]}>
                      {isSelected && <Ionicons name="checkmark" size={13} color={Colors.textInverse} />}
                    </View>
                  </Pressable>
                );
              }}
            />
          )}
          <Pressable
            style={({ pressed }) => [
              styles.confirmBtn,
              (selected.size === 0 || submitting) && styles.confirmBtnDisabled,
              pressed && selected.size > 0 && styles.confirmBtnPressed,
            ]}
            onPress={confirm}
            disabled={selected.size === 0 || submitting}
            accessibilityRole="button"
            accessibilityLabel="Add to vacation"
          >
            <Text style={[styles.confirmText, selected.size === 0 && styles.confirmTextDisabled]}>
              Add {selected.size > 0 ? `(${selected.size})` : ''}
            </Text>
          </Pressable>
        </BottomSheetView>
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  container: { flex: 1, paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm },
  title: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.md },
  empty: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center', marginTop: Spacing.xxl },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.xs,
    backgroundColor: Colors.surfaceMuted,
  },
  rowSelected: { backgroundColor: Colors.primaryMuted },
  avatar: { width: 36, height: 36, borderRadius: Radius.sm, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  avatarText: { fontSize: 14, fontWeight: '700' },
  name: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  amount: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary, marginRight: Spacing.md },
  checkbox: {
    width: 22, height: 22, borderRadius: Radius.sm, borderWidth: 1.5, borderColor: Colors.border,
    justifyContent: 'center', alignItems: 'center', backgroundColor: Colors.surface,
  },
  checkboxSelected: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  confirmBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center', marginTop: Spacing.md, marginBottom: Spacing.md, ...Shadow.sm,
  },
  confirmBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  confirmBtnPressed: { backgroundColor: Colors.primaryDark },
  confirmText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
  confirmTextDisabled: { color: Colors.textTertiary },
});
```

Note: the test's `screen.getByText('M t1'.replace(' ', ''))` is a roundabout way of writing `'Mt1'`, matching `merchant_name: 'M' + id` from the `tx()` helper — write it as `screen.getByText('Mt1')` directly for clarity when implementing the test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- AddToVacationSheet.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add components/AddToVacationSheet.tsx __tests__/components/AddToVacationSheet.test.tsx
git commit -m "feat: add AddToVacationSheet for assigning existing transactions"
```

---

### Task 11: Vacation stack layout + create screen

**Files:**
- Create: `app/vacation/_layout.tsx`
- Create: `app/vacation/new.tsx`

**Interfaces:**
- Consumes: `useVacationStore` (Task 5), `getGroups` (`lib/splitwise.ts` — Task 4), `VacationConflictError` (`lib/vacationErrors.ts`), `SplitwiseGroup` (`lib/types.ts`).
- Produces: routes `/vacation/new`. No unit tests — this codebase does not test screen components (`app/**`), only `lib/`, `stores/`, and `components/` (confirmed: no existing test file for `app/(tabs)/index.tsx` or `history.tsx`). Verify manually per Task 14.

- [ ] **Step 1: Create the stack layout**

`app/vacation/_layout.tsx` (mirrors `app/(auth)/_layout.tsx`):
```tsx
// mobile/app/vacation/_layout.tsx
import { Stack } from 'expo-router';

export default function VacationLayout() {
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

- [ ] **Step 2: Create the create-vacation screen**

`app/vacation/new.tsx`:
```tsx
// mobile/app/vacation/new.tsx
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useVacationStore } from '@/stores/vacationStore';
import { getGroups } from '@/lib/splitwise';
import { VacationConflictError } from '@/lib/vacationErrors';
import { SplitwiseGroup } from '@/lib/types';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function NewVacationScreen() {
  const router = useRouter();
  const toast = useToast();
  const create = useVacationStore((s) => s.create);

  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [groups, setGroups] = useState<SplitwiseGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<SplitwiseGroup | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getGroups().then(setGroups).catch(() => setGroups([]));
  }, []);

  const datesValid =
    (startDate === '' && endDate === '') ||
    (DATE_RE.test(startDate) && DATE_RE.test(endDate) && startDate <= endDate);
  const canSave = name.trim() !== '' && datesValid && !submitting;

  async function handleSave() {
    if (!canSave) return;
    setSubmitting(true);
    try {
      const vacation = await create({
        name: name.trim(),
        start_date: startDate || null,
        end_date: endDate || null,
        splitwise_group_id: selectedGroup?.id ?? null,
        splitwise_group_name: selectedGroup?.name ?? null,
        splitwise_group_member_ids: selectedGroup?.member_ids ?? null,
      });
      router.replace(`/vacation/${vacation.id}`);
    } catch (err) {
      if (err instanceof VacationConflictError) {
        toast.show(err.message, 'error');
      } else {
        toast.show('Could not create vacation. Please try again.', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>New vacation</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.label}>Name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Hawaii trip"
          placeholderTextColor={Colors.textTertiary}
          accessibilityLabel="Vacation name"
        />

        <Text style={styles.label}>Dates (optional)</Text>
        <Text style={styles.hint}>If set, the vacation starts and ends automatically on these dates.</Text>
        <View style={styles.dateRow}>
          <TextInput
            style={[styles.input, styles.dateInput]}
            value={startDate}
            onChangeText={setStartDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={Colors.textTertiary}
            accessibilityLabel="Start date"
          />
          <TextInput
            style={[styles.input, styles.dateInput]}
            value={endDate}
            onChangeText={setEndDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={Colors.textTertiary}
            accessibilityLabel="End date"
          />
        </View>
        {!datesValid && <Text style={styles.error}>Enter both dates as YYYY-MM-DD, end on or after start.</Text>}

        {groups.length > 0 && (
          <>
            <Text style={styles.label}>Splitwise group (optional)</Text>
            {groups.map((g) => {
              const isSelected = selectedGroup?.id === g.id;
              return (
                <Pressable
                  key={g.id}
                  style={[styles.groupRow, isSelected && styles.groupRowSelected]}
                  onPress={() => setSelectedGroup(isSelected ? null : g)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: isSelected }}
                  accessibilityLabel={g.name}
                >
                  <Text style={styles.groupName}>{g.name}</Text>
                  {isSelected && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
                </Pressable>
              );
            })}
          </>
        )}
      </ScrollView>

      <Pressable
        style={({ pressed }) => [styles.saveBtn, !canSave && styles.saveBtnDisabled, pressed && canSave && styles.saveBtnPressed]}
        onPress={handleSave}
        disabled={!canSave}
        accessibilityRole="button"
        accessibilityLabel="Save vacation"
      >
        {submitting ? <ActivityIndicator color={Colors.textInverse} /> : <Text style={styles.saveText}>Create vacation</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingTop: 56, paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  body: { padding: Spacing.xl },
  label: { fontSize: 13, fontWeight: '600', color: Colors.textSecondary, marginBottom: Spacing.sm, marginTop: Spacing.lg },
  hint: { fontSize: 12, color: Colors.textTertiary, marginBottom: Spacing.sm },
  input: {
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12, fontSize: 15, color: Colors.textPrimary,
  },
  dateRow: { flexDirection: 'row', gap: Spacing.md },
  dateInput: { flex: 1 },
  error: { fontSize: 12, color: Colors.error, marginTop: Spacing.sm },
  groupRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12, marginBottom: Spacing.sm,
  },
  groupRowSelected: { borderColor: Colors.primary, backgroundColor: Colors.primaryMuted },
  groupName: { fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  saveBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center', marginHorizontal: Spacing.xl, marginBottom: Spacing.xl, ...Shadow.sm,
  },
  saveBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  saveBtnPressed: { backgroundColor: Colors.primaryDark },
  saveText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
});
```

- [ ] **Step 3: Manual check**

Run: `npm test` (confirm nothing broke) then start the app (`npx expo start`) and navigate to `/vacation/new` directly (or wait for Task 12/13 to link it in) to confirm the form renders, validates dates, and creating a vacation without dates/group succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/vacation/_layout.tsx app/vacation/new.tsx
git commit -m "feat: add vacation stack layout and create-vacation screen"
```

---

### Task 12: Vacations list screen

**Files:**
- Create: `app/vacation/index.tsx`

**Interfaces:**
- Consumes: `useVacationStore` (Task 5), `Vacation` (`lib/types.ts`).
- Produces: route `/vacation`. No unit tests (screen component, see Task 11's note).

- [ ] **Step 1: Implement**

`app/vacation/index.tsx`:
```tsx
// mobile/app/vacation/index.tsx
import { useCallback } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useVacationStore } from '@/stores/vacationStore';
import { Vacation } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

export default function VacationListScreen() {
  const router = useRouter();
  const vacations = useVacationStore((s) => s.vacations);
  const load = useVacationStore((s) => s.load);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const inProgress = vacations.filter((v) => v.status !== 'ended');
  const past = vacations.filter((v) => v.status === 'ended');

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle}>Vacations</Text>
        <Pressable
          onPress={() => router.push('/vacation/new')}
          accessibilityRole="button"
          accessibilityLabel="New vacation"
        >
          <Ionicons name="add" size={26} color={Colors.primary} />
        </Pressable>
      </View>

      {vacations.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="airplane-outline" size={40} color={Colors.textTertiary} />
          <Text style={styles.emptyTitle}>No vacations yet</Text>
          <Text style={styles.emptySubtitle}>Create one to track a trip's spending separately.</Text>
        </View>
      ) : (
        <FlatList
          data={[...inProgress, ...past]}
          keyExtractor={(v) => v.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <VacationRow vacation={item} onPress={() => router.push(`/vacation/${item.id}`)} />
          )}
        />
      )}
    </View>
  );
}

function VacationRow({ vacation, onPress }: { vacation: Vacation; onPress: () => void }) {
  const statusLabel = vacation.status === 'active' ? 'Active' : vacation.status === 'draft' ? 'Draft' : 'Ended';
  const dates = vacation.start_date && vacation.end_date ? `${vacation.start_date} – ${vacation.end_date}` : null;

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${vacation.name} vacation`}
    >
      <View style={styles.info}>
        <Text style={styles.name}>{vacation.name}</Text>
        {dates && <Text style={styles.dates}>{dates}</Text>}
      </View>
      <View style={[styles.statusPill, vacation.status === 'active' && styles.statusPillActive]}>
        <Text style={[styles.statusText, vacation.status === 'active' && styles.statusTextActive]}>{statusLabel}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingTop: 56, paddingBottom: Spacing.md,
  },
  headerTitle: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  list: { padding: Spacing.lg, gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, ...Shadow.sm,
  },
  rowPressed: { backgroundColor: Colors.surfaceMuted },
  info: { flex: 1, marginRight: Spacing.sm },
  name: { fontSize: 15, fontWeight: '600', color: Colors.textPrimary },
  dates: { fontSize: 12, color: Colors.textTertiary, marginTop: 2 },
  statusPill: { backgroundColor: Colors.surfaceMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillActive: { backgroundColor: Colors.successLight },
  statusText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  statusTextActive: { color: Colors.success },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.xxxl },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.textPrimary, marginTop: Spacing.lg, marginBottom: Spacing.sm },
  emptySubtitle: { fontSize: 14, color: Colors.textSecondary, textAlign: 'center' },
});
```

- [ ] **Step 2: Manual check**

Run: `npm test`, then in the running app navigate `/vacation` → confirm it lists any vacations created in Task 11's manual check, in-progress ones first.

- [ ] **Step 3: Commit**

```bash
git add app/vacation/index.tsx
git commit -m "feat: add vacations list screen"
```

---

### Task 13: Vacation detail screen

**Files:**
- Create: `app/vacation/[id].tsx`

**Interfaces:**
- Consumes: `useVacationStore` (Task 5), `getVacationPendingTransactions, getVacationHistory, removeTransactionFromVacation` (`lib/db.ts` — Task 3), `FriendPickerSheet` (Task 7), `AddToVacationSheet` (Task 10), `TransactionRow` with `variant="remove"` (Task 8), `showDialog` (`lib/dialog.ts`).
- Produces: route `/vacation/[id]`. No unit tests (screen component, see Task 11's note) — this is the most interaction-heavy screen in the plan, so the manual QA pass in Task 14 is what actually exercises it end-to-end.

- [ ] **Step 1: Implement**

`app/vacation/[id].tsx`:
```tsx
// mobile/app/vacation/[id].tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { showDialog } from '@/lib/dialog';
import { getVacationPendingTransactions, getVacationHistory, removeTransactionFromVacation } from '@/lib/db';
import { VacationConflictError } from '@/lib/vacationErrors';
import { useVacationStore } from '@/stores/vacationStore';
import { TransactionRow } from '@/components/TransactionRow';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { AddToVacationSheet } from '@/components/AddToVacationSheet';
import { useToast } from '@/components/ToastProvider';
import { HistoryItem, Transaction, Vacation } from '@/lib/types';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

export default function VacationDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const vacations = useVacationStore((s) => s.vacations);
  const loadVacations = useVacationStore((s) => s.load);
  const startVacation = useVacationStore((s) => s.startVacation);
  const endVacation = useVacationStore((s) => s.endVacation);
  const deleteVacation = useVacationStore((s) => s.deleteVacation);
  const activeVacation = useVacationStore((s) => s.activeVacation);

  const vacation = vacations.find((v) => v.id === id) ?? null;

  const [pending, setPending] = useState<Transaction[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [combineTxs, setCombineTxs] = useState<Transaction[] | null>(null);
  const [pickerToken, setPickerToken] = useState(0);
  const [addToken, setAddToken] = useState(0);
  const [pendingPresent, setPendingPresent] = useState<null | 'picker' | 'add'>(null);
  const pickerRef = useRef<BottomSheetModal>(null);
  const addRef = useRef<BottomSheetModal>(null);

  const refresh = useCallback(() => {
    if (!id) return;
    getVacationPendingTransactions(id).then(setPending).catch(console.error);
    getVacationHistory(id).then(setHistory).catch(console.error);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadVacations();
      refresh();
    }, [loadVacations, refresh])
  );

  useEffect(() => {
    if (pendingPresent === 'picker') {
      pickerRef.current?.present();
      setPendingPresent(null);
    } else if (pendingPresent === 'add') {
      addRef.current?.present();
      setPendingPresent(null);
    }
  }, [pendingPresent]);

  if (!vacation) {
    return (
      <View style={styles.root}>
        <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
        <Text style={styles.notFound}>Vacation not found.</Text>
      </View>
    );
  }

  function toggleSelect(txId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(txId) ? next.delete(txId) : next.add(txId);
      return next;
    });
  }

  function openCombine(members: Transaction[]) {
    if (members.length === 0) return;
    if (new Set(members.map((t) => t.currency)).size > 1) {
      toast.show('This vacation has transactions in more than one currency — select transactions in the same currency to combine.', 'error');
      return;
    }
    setCombineTxs(members);
    setPickerToken((t) => t + 1);
    setPendingPresent('picker');
  }

  function openSelectSplit() {
    openCombine(pending.filter((t) => selectedIds.has(t.id)));
  }

  function splitAllTogether() {
    openCombine(pending);
  }

  async function handleRemove(txId: string) {
    await removeTransactionFromVacation(txId);
    refresh();
  }

  function handleSplitSuccess() {
    pickerRef.current?.dismiss();
    setSelectMode(false);
    setSelectedIds(new Set());
    toast.show('Split added', 'success');
    refresh();
  }

  async function handleStart() {
    try {
      await startVacation(vacation.id);
    } catch (err) {
      toast.show(
        err instanceof VacationConflictError
          ? 'Another vacation is already active. End it first.'
          : 'Could not start vacation. Please try again.',
        'error'
      );
    }
  }

  async function handleEnd() {
    await endVacation(vacation.id);
  }

  function handleDelete() {
    showDialog(
      'Delete vacation?',
      pending.length > 0
        ? `${pending.length} pending transaction${pending.length === 1 ? '' : 's'} will move back to your main Transactions list.`
        : 'This vacation will be removed.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteVacation(vacation.id);
            router.back();
          },
        },
      ]
    );
  }

  const canStart = vacation.status === 'draft' && !activeVacation;
  const canEnd = vacation.status === 'active';
  const statusLabel = vacation.status === 'active' ? 'Active' : vacation.status === 'draft' ? 'Draft' : 'Ended';
  const mixedCurrency = new Set(pending.map((t) => t.currency)).size > 1;

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={24} color={Colors.textPrimary} />
        </Pressable>
        <Text style={styles.headerTitle} numberOfLines={1}>{vacation.name}</Text>
        <Pressable onPress={handleDelete} accessibilityRole="button" accessibilityLabel="Delete vacation">
          <Ionicons name="trash-outline" size={20} color={Colors.error} />
        </Pressable>
      </View>

      <View style={styles.metaRow}>
        <View style={[styles.statusPill, vacation.status === 'active' && styles.statusPillActive]}>
          <Text style={[styles.statusText, vacation.status === 'active' && styles.statusTextActive]}>{statusLabel}</Text>
        </View>
        {vacation.start_date && vacation.end_date && (
          <Text style={styles.dates}>{vacation.start_date} – {vacation.end_date}</Text>
        )}
        {vacation.splitwise_group_name && (
          <View style={styles.groupChip}>
            <Ionicons name="people-outline" size={12} color={Colors.primary} />
            <Text style={styles.groupChipText}>{vacation.splitwise_group_name}</Text>
          </View>
        )}
      </View>

      <View style={styles.lifecycleRow}>
        {canStart && (
          <Pressable style={styles.lifecycleBtn} onPress={handleStart} accessibilityRole="button" accessibilityLabel="Start now">
            <Text style={styles.lifecycleBtnText}>Start now</Text>
          </Pressable>
        )}
        {canEnd && (
          <Pressable style={styles.lifecycleBtn} onPress={handleEnd} accessibilityRole="button" accessibilityLabel="End now">
            <Text style={styles.lifecycleBtnText}>End now</Text>
          </Pressable>
        )}
        <Pressable
          style={styles.lifecycleBtnSecondary}
          onPress={() => { setAddToken((t) => t + 1); setPendingPresent('add'); }}
          accessibilityRole="button"
          accessibilityLabel="Add transactions"
        >
          <Text style={styles.lifecycleBtnSecondaryText}>Add transactions</Text>
        </Pressable>
      </View>

      <FlatList
        data={pending}
        keyExtractor={(t) => t.id}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          pending.length > 0 ? (
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>To split ({pending.length})</Text>
              <Pressable
                onPress={splitAllTogether}
                disabled={mixedCurrency}
                accessibilityRole="button"
                accessibilityLabel="Split all together"
              >
                <Text style={[styles.splitAllText, mixedCurrency && styles.splitAllTextDisabled]}>Split all together</Text>
              </Pressable>
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TransactionRow
            transaction={item}
            variant="remove"
            onSkip={() => handleRemove(item.id)}
            onSplit={() => openCombine([item])}
            onLongPress={() => { setSelectMode(true); setSelectedIds(new Set([item.id])); }}
            selectMode={selectMode}
            selected={selectedIds.has(item.id)}
            onToggleSelect={() => toggleSelect(item.id)}
          />
        )}
        ListFooterComponent={
          history.length > 0 ? (
            <View style={styles.historySection}>
              <Text style={styles.sectionHeader}>Already split</Text>
              {history.map((h) => (
                <HistoryRecapRow key={h.id} item={h} />
              ))}
            </View>
          ) : null
        }
      />

      {selectMode && (
        <View style={styles.selectBar}>
          <Pressable
            style={styles.selectCancel}
            onPress={() => { setSelectMode(false); setSelectedIds(new Set()); }}
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
          >
            <Text style={styles.selectCancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            style={[styles.selectSplit, selectedIds.size === 0 && styles.selectSplitDisabled]}
            onPress={openSelectSplit}
            disabled={selectedIds.size === 0}
            accessibilityRole="button"
            accessibilityLabel="Split selected together"
          >
            <Text style={styles.selectSplitText}>Split together ({selectedIds.size})</Text>
          </Pressable>
        </View>
      )}

      <FriendPickerSheet
        ref={pickerRef}
        transaction={combineTxs && combineTxs.length === 1 ? combineTxs[0] : null}
        combineTransactions={combineTxs && combineTxs.length > 1 ? combineTxs : undefined}
        openToken={pickerToken}
        groupId={vacation.splitwise_group_id ?? undefined}
        groupMemberIds={vacation.splitwise_group_member_ids ?? undefined}
        onSuccess={handleSplitSuccess}
      />
      <AddToVacationSheet
        ref={addRef}
        vacationId={vacation.id}
        openToken={addToken}
        onDone={() => { addRef.current?.dismiss(); refresh(); }}
      />
    </View>
  );
}

function HistoryRecapRow({ item }: { item: HistoryItem }) {
  const color = merchantColor(item.merchant_name);
  return (
    <View style={styles.recapRow}>
      <View style={[styles.recapAvatar, { backgroundColor: color + '18' }]}>
        <Text style={[styles.recapAvatarText, { color }]}>{item.merchant_name[0].toUpperCase()}</Text>
      </View>
      <View style={styles.recapInfo}>
        <Text style={styles.recapName} numberOfLines={1}>{item.merchant_name}</Text>
        {item.split && (
          <Text style={styles.recapSplit}>
            {item.split.friend_names.join(', ')} · ${item.split.amount_each.toFixed(2)} each
          </Text>
        )}
      </View>
      <Text style={styles.recapAmount}>${item.amount.toFixed(2)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: Colors.bg },
  notFound: { marginTop: 100, textAlign: 'center', color: Colors.textSecondary },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.lg, paddingTop: 56, paddingBottom: Spacing.sm,
  },
  headerTitle: { flex: 1, fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginHorizontal: Spacing.md, textAlign: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingHorizontal: Spacing.lg, marginBottom: Spacing.md },
  statusPill: { backgroundColor: Colors.surfaceMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusPillActive: { backgroundColor: Colors.successLight },
  statusText: { fontSize: 11, fontWeight: '600', color: Colors.textSecondary },
  statusTextActive: { color: Colors.success },
  dates: { fontSize: 12, color: Colors.textTertiary },
  groupChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: Colors.primaryMuted, borderRadius: Radius.full, paddingHorizontal: 10, paddingVertical: 4 },
  groupChipText: { fontSize: 11, fontWeight: '600', color: Colors.primary },
  lifecycleRow: { flexDirection: 'row', gap: Spacing.sm, paddingHorizontal: Spacing.lg, marginBottom: Spacing.md },
  lifecycleBtn: { backgroundColor: Colors.primary, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: Spacing.lg },
  lifecycleBtnText: { color: Colors.textInverse, fontSize: 13, fontWeight: '700' },
  lifecycleBtnSecondary: { backgroundColor: Colors.surfaceMuted, borderRadius: Radius.md, paddingVertical: 10, paddingHorizontal: Spacing.lg },
  lifecycleBtnSecondaryText: { color: Colors.textPrimary, fontSize: 13, fontWeight: '700' },
  list: { padding: Spacing.lg, gap: 8 },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: Spacing.sm },
  sectionHeader: { fontSize: 13, fontWeight: '700', color: Colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  splitAllText: { fontSize: 13, fontWeight: '600', color: Colors.primary },
  splitAllTextDisabled: { color: Colors.textTertiary },
  historySection: { marginTop: Spacing.xl },
  recapRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: Colors.surface, borderRadius: Radius.lg,
    padding: Spacing.md, marginBottom: 8, ...Shadow.sm,
  },
  recapAvatar: { width: 36, height: 36, borderRadius: Radius.sm, justifyContent: 'center', alignItems: 'center', marginRight: Spacing.md },
  recapAvatarText: { fontSize: 14, fontWeight: '700' },
  recapInfo: { flex: 1 },
  recapName: { fontSize: 14, fontWeight: '600', color: Colors.textPrimary },
  recapSplit: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  recapAmount: { fontSize: 14, fontWeight: '700', color: Colors.textPrimary },
  selectBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', gap: Spacing.md,
    padding: Spacing.lg, backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
  },
  selectCancel: { paddingVertical: 16, paddingHorizontal: Spacing.xl, borderRadius: Radius.lg, backgroundColor: Colors.surfaceMuted, justifyContent: 'center', alignItems: 'center' },
  selectCancelText: { fontSize: 15, fontWeight: '600', color: Colors.textSecondary },
  selectSplit: { flex: 1, borderRadius: Radius.lg, backgroundColor: Colors.primary, justifyContent: 'center', alignItems: 'center', ...Shadow.sm },
  selectSplitDisabled: { backgroundColor: Colors.surfaceMuted },
  selectSplitText: { fontSize: 15, fontWeight: '700', color: Colors.textInverse },
});
```

- [ ] **Step 2: Manual check**

Run: `npm test`, then in the running app: create a vacation, start it, sync/simulate a transaction landing in it, split one individually, select two and split together, use "Split all together", remove one back to the main list, verify it reappears on the Transactions tab, then delete the vacation and confirm remaining pending transactions return to the main list.

- [ ] **Step 3: Commit**

```bash
git add "app/vacation/[id].tsx"
git commit -m "feat: add vacation detail screen with split, add, remove, and delete flows"
```

---

### Task 14: Full regression pass

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all suites PASS, including `db.parity.test.ts`.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual end-to-end pass (native or web dev server)**

Run: `npx expo start` (or `npm run web`). Walk through:
1. Fresh app with no vacations → Transactions tab shows the "Create a vacation" banner.
2. Create a dated vacation starting today → after creation it shows `Active` on its detail screen without pressing anything.
3. Trigger a manual pull-to-refresh on the Transactions tab (or wait for a sync) with the vacation active → confirm any newly-synced transaction is captured into the vacation and does **not** appear on the main Transactions tab.
4. From the vacation detail screen, split one transaction individually, then select two and "Split together", then use "Split all together" on whatever remains (or confirm it's correctly disabled/blocked if currencies differ).
5. Add an existing main-list transaction into the vacation via "Add transactions"; remove one back out via its row action and confirm it reappears on the main Transactions tab.
6. End the vacation early via "End now"; confirm the Transactions tab banner no longer shows it as in-progress and `/vacation` lists it under past vacations.
7. Reopen the ended vacation from the list and confirm its "Already split" recap section shows everything that was split, including the combined rows.
8. Create a second vacation linked to a Splitwise group (requires a real Splitwise account with at least one group) and confirm the resulting expense appears in that group on splitwise.com, and that group members are sorted first in the friend picker.
9. Delete a vacation that still has pending transactions and confirm they return to the main Transactions tab.

- [ ] **Step 4: Final commit (if any fixups were needed)**

```bash
git add -A
git commit -m "fix: address issues found in vacation mode regression pass"
```

(Skip this commit if Step 3 found nothing to fix.)
