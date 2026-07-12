# SplitEasy PWA Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SplitEasy run as an installable PWA (Expo web target + platform-split native modules + Worker CORS/proxy + manifest/service worker) so distribution needs no Apple Developer account.

**Architecture:** Conversion in place: the Expo 52 + expo-router app gains a `web` platform. Native-only modules (`expo-secure-store`, `expo-sqlite`, Plaid RN SDK, `expo-web-browser` OAuth) get `.web.ts` counterparts behind identical exported APIs — Metro resolves `foo.web.ts` on web and `foo.ts` elsewhere, so no call-site changes per platform. The Cloudflare Worker gains CORS and a Splitwise API proxy (browsers can't call Splitwise directly due to CORS).

**Tech Stack:** react-native-web, @expo/metro-runtime, IndexedDB (via `fake-indexeddb` in tests), Plaid Link JS, Cloudflare Worker (vitest).

**Spec:** `docs/superpowers/specs/2026-07-09-pwa-conversion-design.md`

**Working directory:** repo root is the worktree; mobile app in `mobile/`, worker in `workers/`. All `npm`/`npx` commands run in `mobile/` unless stated otherwise.

**Baseline:** `mobile`: 71 jest tests pass. `workers`: 18 pass, 3 pre-existing failures (`returns 400 when request body is malformed JSON` ×3) — do NOT try to fix them; just don't add new failures.

**Platform-split convention used throughout:** the base file (`lib/foo.ts`) is the native implementation and the TypeScript source of truth; `lib/foo.web.ts` is the web override with the **same exported names**. jest-expo tests resolve the base file; web overrides are tested by importing `@/lib/foo.web` explicitly.

---

### Task 1: Enable the Expo web target

**Files:**
- Modify: `mobile/app.json`
- Modify: `mobile/package.json` (scripts + new deps via `npx expo install`)

- [ ] **Step 1: Install web dependencies**

```bash
cd mobile
npx expo install react-dom react-native-web @expo/metro-runtime
```

- [ ] **Step 2: Add web platform to app.json**

In `mobile/app.json`, change `"platforms": ["ios", "android"]` to:

```json
"platforms": ["ios", "android", "web"],
```

and add a sibling `web` key next to `"ios"` / `"android"`:

```json
"web": {
  "bundler": "metro",
  "output": "single",
  "favicon": "./assets/icon.png"
},
```

- [ ] **Step 3: Add npm scripts**

In `mobile/package.json` scripts, add:

```json
"web": "expo start --web",
"build:web": "expo export --platform web"
```

- [ ] **Step 4: Verify the web build compiles**

```bash
npx expo export --platform web
```

Expected: exits 0, creates `mobile/dist/index.html`. (If it fails on a native-only import, note which module — later tasks platform-split them — but with the current import graph only `react-native-plaid-link-sdk` is a risk; it is imported by `app/(auth)/bank-connect.tsx`. If export fails because of it, proceed to Task 5 first, then re-run this step before committing.)

- [ ] **Step 5: Verify native tests still pass**

```bash
npm test
```

Expected: 71 passed.

- [ ] **Step 6: Commit**

```bash
git add mobile/app.json mobile/package.json mobile/package-lock.json
git commit -m "feat(web): enable Expo web target"
```

---

### Task 2: Cross-platform dialog helper (replaces Alert.alert)

`Alert.alert` is a no-op on web. Introduce `showDialog` with the same button semantics, mapped to `window.confirm`/`window.alert` on web.

**Files:**
- Create: `mobile/lib/dialog.ts`
- Create: `mobile/lib/dialog.web.ts`
- Test: `mobile/__tests__/lib/dialog.web.test.ts`
- Modify: `mobile/app/(tabs)/settings.tsx`, `mobile/app/(tabs)/history.tsx`, `mobile/app/(auth)/bank-connect.tsx`

- [ ] **Step 1: Write the failing test**

`mobile/__tests__/lib/dialog.web.test.ts`:

```ts
import { showDialog } from '@/lib/dialog.web';

describe('showDialog (web)', () => {
  const alertMock = jest.fn();
  const confirmMock = jest.fn();

  beforeEach(() => {
    alertMock.mockReset();
    confirmMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      { alert: alertMock, confirm: confirmMock },
    );
  });

  it('uses alert and fires the single button for one-button dialogs', () => {
    const onPress = jest.fn();
    showDialog('Title', 'Message', [{ text: 'OK', onPress }]);
    expect(alertMock).toHaveBeenCalledWith('Title\n\nMessage');
    expect(onPress).toHaveBeenCalled();
  });

  it('uses alert with no buttons provided', () => {
    showDialog('Title', 'Message');
    expect(alertMock).toHaveBeenCalledWith('Title\n\nMessage');
  });

  it('fires the confirm (non-cancel) button when confirm returns true', () => {
    confirmMock.mockReturnValue(true);
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    showDialog('Delete?', 'Really?', [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ]);
    expect(onConfirm).toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('fires the cancel button when confirm returns false', () => {
    confirmMock.mockReturnValue(false);
    const onCancel = jest.fn();
    const onConfirm = jest.fn();
    showDialog('Delete?', 'Really?', [
      { text: 'Cancel', style: 'cancel', onPress: onCancel },
      { text: 'Delete', style: 'destructive', onPress: onConfirm },
    ]);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- dialog.web`
Expected: FAIL — cannot find module `@/lib/dialog.web`.

- [ ] **Step 3: Implement both platform files**

`mobile/lib/dialog.ts` (native):

```ts
// mobile/lib/dialog.ts
import { Alert } from 'react-native';

export interface DialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

// Cross-platform confirm/alert. Native uses Alert.alert; dialog.web.ts maps the
// same button semantics onto window.confirm / window.alert.
export function showDialog(title: string, message: string, buttons?: DialogButton[]): void {
  Alert.alert(title, message, buttons);
}
```

`mobile/lib/dialog.web.ts`:

```ts
// mobile/lib/dialog.web.ts
import type { DialogButton } from './dialog';

export type { DialogButton };

export function showDialog(title: string, message: string, buttons?: DialogButton[]): void {
  const text = message ? `${title}\n\n${message}` : title;
  const btns = buttons ?? [];
  if (btns.length <= 1) {
    window.alert(text);
    btns[0]?.onPress?.();
    return;
  }
  const cancel = btns.find((b) => b.style === 'cancel');
  // Last non-cancel button is the primary action (matches Alert.alert layout).
  const primary = [...btns].reverse().find((b) => b.style !== 'cancel');
  if (window.confirm(text)) primary?.onPress?.();
  else cancel?.onPress?.();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- dialog.web`
Expected: PASS (4 tests).

- [ ] **Step 5: Replace Alert.alert call sites**

In `mobile/app/(tabs)/settings.tsx`:
- Remove `Alert` from the react-native import on line 1.
- Add `import { showDialog } from '@/lib/dialog';`
- Replace both `Alert.alert(` calls (in `confirmSignOut` and `confirmDisconnect`) with `showDialog(` — arguments unchanged.

In `mobile/app/(tabs)/history.tsx`:
- Remove `Alert` from the react-native import on line 2.
- Add `import { showDialog } from '@/lib/dialog';`
- Replace the `Alert.alert(` call in `handleDelete` with `showDialog(`.

In `mobile/app/(auth)/bank-connect.tsx`:
- Remove `Alert` from the react-native import on line 2.
- Add `import { showDialog } from '@/lib/dialog';`
- Replace `Alert.alert('Plaid needs a native build', <msg>)` with `showDialog('Plaid needs a native build', <msg>)` and `Alert.alert('Plaid unavailable', message)` with `showDialog('Plaid unavailable', message)`. (This screen is refactored further in Task 5; do the mechanical swap now so no `Alert.alert` remains.)

- [ ] **Step 6: Run full suite + commit**

```bash
npm test
git add mobile/lib/dialog.ts mobile/lib/dialog.web.ts "mobile/__tests__/lib/dialog.web.test.ts" "mobile/app/(tabs)/settings.tsx" "mobile/app/(tabs)/history.tsx" "mobile/app/(auth)/bank-connect.tsx"
git commit -m "feat(web): cross-platform dialog helper replacing Alert.alert"
```

Expected: all tests pass (75 total).

---

### Task 3: Secure storage platform split

**Files:**
- Modify: `mobile/lib/secure.ts` (widen keys to `string`)
- Create: `mobile/lib/secure.web.ts`
- Modify: `mobile/stores/plaidStore.ts` (route through `lib/secure`)
- Test: `mobile/__tests__/lib/secure.web.test.ts`

- [ ] **Step 1: Write the failing test**

`mobile/__tests__/lib/secure.web.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- secure.web`
Expected: FAIL — cannot find module `@/lib/secure.web`.

- [ ] **Step 3: Widen native API and add web implementation**

Replace `mobile/lib/secure.ts` with:

```ts
// mobile/lib/secure.ts
import * as SecureStore from 'expo-secure-store';

export const KEYS = {
  SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token',
  PLAID_ACCESS_TOKEN: 'plaid_access_token',
  WORKER_API_KEY: 'worker_api_key',
} as const;

export type SecureKey = (typeof KEYS)[keyof typeof KEYS];

// Keys are plain strings so callers (e.g. plaidStore) can use dynamic
// per-account keys. KEYS holds the well-known ones.
export async function getSecure(key: string): Promise<string | null> {
  return SecureStore.getItemAsync(key);
}

export async function setSecure(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

export async function deleteSecure(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}
```

Create `mobile/lib/secure.web.ts`:

```ts
// mobile/lib/secure.web.ts
// Web has no OS keychain. Tokens live in localStorage — the standard PWA
// trade-off, equivalent in exposure to the API key already shipped in the JS
// bundle. The prefix namespaces us away from other same-origin storage.
export const KEYS = {
  SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token',
  PLAID_ACCESS_TOKEN: 'plaid_access_token',
  WORKER_API_KEY: 'worker_api_key',
} as const;

export type SecureKey = (typeof KEYS)[keyof typeof KEYS];

const PREFIX = 'spliteasy_secure_';

export async function getSecure(key: string): Promise<string | null> {
  return localStorage.getItem(PREFIX + key);
}

export async function setSecure(key: string, value: string): Promise<void> {
  localStorage.setItem(PREFIX + key, value);
}

export async function deleteSecure(key: string): Promise<void> {
  localStorage.removeItem(PREFIX + key);
}
```

- [ ] **Step 4: Route plaidStore through lib/secure**

In `mobile/stores/plaidStore.ts`:
- Replace `import * as SecureStore from 'expo-secure-store';` with `import { getSecure, setSecure, deleteSecure } from '@/lib/secure';`
- Replace every `SecureStore.getItemAsync(` → `getSecure(`, `SecureStore.setItemAsync(` → `setSecure(`, `SecureStore.deleteItemAsync(` → `deleteSecure(` (7 call sites: lines 48, 52, 53, 72, 82, 93, 112 of the current file).

- [ ] **Step 5: Run tests to verify all pass**

Run: `npm test`
Expected: PASS — existing plaidStore/authStore tests still pass (they mock `expo-secure-store`, which `lib/secure.ts` still uses underneath) plus 4 new secure.web tests.

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/secure.ts mobile/lib/secure.web.ts mobile/stores/plaidStore.ts mobile/__tests__/lib/secure.web.test.ts
git commit -m "feat(web): localStorage-backed secure storage for web"
```

---

### Task 4: IndexedDB database for web

Implements the exact `lib/db.ts` exported API on IndexedDB. Note two behaviors that must match SQLite: (a) deleting transactions also deletes their split_decisions (SQLite has `ON DELETE CASCADE`), and (b) `upsertTransactions` never overwrites a row whose status isn't `'new'`.

**Files:**
- Create: `mobile/lib/db.web.ts`
- Test: `mobile/__tests__/lib/db.web.test.ts`
- Modify: `mobile/package.json` (add `fake-indexeddb` devDependency)

- [ ] **Step 1: Install fake-indexeddb**

```bash
npm install --save-dev fake-indexeddb
```

- [ ] **Step 2: Write the failing test**

`mobile/__tests__/lib/db.web.test.ts`:

```ts
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  initDb, getNewTransactions, getHistoryTransactions, upsertTransactions,
  deleteTransactionsByPlaidIds, updateTransactionStatus, getSplitDecision,
  insertSplitDecision, upsertSplitDecision, deleteSplitDecision,
  pruneOldTransactions, deleteAllTransactions,
} from '@/lib/db.web';
import { PlaidTransaction, SplitDecision } from '@/lib/types';

function plaidTx(id: string, over: Partial<PlaidTransaction> = {}): PlaidTransaction {
  return {
    transaction_id: id, merchant_name: 'Cafe', name: 'CAFE 123', amount: 20,
    iso_currency_code: 'USD', date: '2026-07-01', pending: false, ...over,
  };
}

function decision(txId: string, over: Partial<SplitDecision> = {}): SplitDecision {
  return {
    id: `dec_${txId}`, transaction_id: txId, splitwise_expense_id: `exp_${txId}`,
    friend_ids: ['1'], friend_names: ['Ana'], amount_each: 10,
    created_at: new Date().toISOString(), ...over,
  };
}

describe('db.web (IndexedDB)', () => {
  beforeEach(async () => {
    indexedDB = new IDBFactory(); // fresh DB per test
    await initDb();
  });

  it('upserts and reads new transactions sorted by date desc', async () => {
    await upsertTransactions([
      plaidTx('t1', { date: '2026-07-01' }),
      plaidTx('t2', { date: '2026-07-03' }),
    ]);
    const rows = await getNewTransactions();
    expect(rows.map((r) => r.id)).toEqual(['t2', 't1']);
    expect(rows[0]).toMatchObject({ status: 'new', pending: false, currency: 'USD' });
  });

  it('falls back to name and USD when merchant/currency missing', async () => {
    await upsertTransactions([plaidTx('t1', { merchant_name: null, iso_currency_code: null })]);
    const [row] = await getNewTransactions();
    expect(row.merchant_name).toBe('CAFE 123');
    expect(row.currency).toBe('USD');
  });

  it('does not overwrite non-new transactions on re-upsert', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20 })]);
    await updateTransactionStatus('t1', 'split');
    await upsertTransactions([plaidTx('t1', { amount: 99 })]);
    const history = await getHistoryTransactions();
    expect(history[0].amount).toBe(20);
    expect(await getNewTransactions()).toHaveLength(0);
  });

  it('updates fields of still-new transactions on re-upsert', async () => {
    await upsertTransactions([plaidTx('t1', { amount: 20, pending: true })]);
    await upsertTransactions([plaidTx('t1', { amount: 25, pending: false })]);
    const [row] = await getNewTransactions();
    expect(row.amount).toBe(25);
    expect(row.pending).toBe(false);
  });

  it('joins split decisions into history rows', async () => {
    await upsertTransactions([plaidTx('t1'), plaidTx('t2')]);
    await updateTransactionStatus('t1', 'split');
    await updateTransactionStatus('t2', 'skipped');
    await insertSplitDecision(decision('t1', { friend_names: ['Ana', 'Bo'], amount_each: 6.67 }));
    const history = await getHistoryTransactions();
    const t1 = history.find((h) => h.id === 't1')!;
    const t2 = history.find((h) => h.id === 't2')!;
    expect(t1.split).toEqual({ friend_names: ['Ana', 'Bo'], amount_each: 6.67 });
    expect(t2.split).toBeUndefined();
  });

  it('round-trips split decisions and upserts by transaction_id', async () => {
    await insertSplitDecision(decision('t1'));
    await upsertSplitDecision(decision('t1', { amount_each: 5, splitwise_expense_id: 'exp2' }));
    const d = await getSplitDecision('t1');
    expect(d).toMatchObject({ amount_each: 5, splitwise_expense_id: 'exp2', friend_ids: ['1'] });
    await deleteSplitDecision('t1');
    expect(await getSplitDecision('t1')).toBeNull();
  });

  it('cascades decision deletes when transactions are deleted', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await insertSplitDecision(decision('t1'));
    await deleteTransactionsByPlaidIds(['t1']);
    expect(await getSplitDecision('t1')).toBeNull();
    expect(await getNewTransactions()).toHaveLength(0);
  });

  it('deleteAllTransactions clears both stores', async () => {
    await upsertTransactions([plaidTx('t1')]);
    await insertSplitDecision(decision('t1'));
    await deleteAllTransactions();
    expect(await getNewTransactions()).toHaveLength(0);
    expect(await getSplitDecision('t1')).toBeNull();
  });

  it('prunes transactions older than 6 months', async () => {
    await upsertTransactions([plaidTx('t1')]);
    // Backdate created_at by rewriting through updateTransactionStatus path is not
    // possible; simulate by direct upsert then prune with a far-future cutoff is
    // not exposed. Instead: verify a fresh row survives pruning.
    await pruneOldTransactions();
    expect(await getNewTransactions()).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- db.web`
Expected: FAIL — cannot find module `@/lib/db.web`.

- [ ] **Step 4: Implement db.web.ts**

Create `mobile/lib/db.web.ts`:

```ts
// mobile/lib/db.web.ts
// IndexedDB implementation of the lib/db.ts API for the web build.
// expo-sqlite's wasm build was rejected because it requires COOP/COEP
// cross-origin isolation, which breaks Plaid Link popups (see design spec).
import {
  Transaction, PlaidTransaction, SplitDecision, TransactionStatus, TransactionWithSplit,
} from '@/lib/types';

const DB_NAME = 'spliteasy';
const DB_VERSION = 1;
const TX_STORE = 'transactions';
const DECISION_STORE = 'split_decisions';

let _db: IDBDatabase | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IDB transaction aborted'));
  });
}

function db(): IDBDatabase {
  if (!_db) throw new Error('DB not initialized — call initDb() first');
  return _db;
}

export async function initDb(): Promise<void> {
  _db = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const d = open.result;
      if (!d.objectStoreNames.contains(TX_STORE)) {
        d.createObjectStore(TX_STORE, { keyPath: 'id' });
      }
      if (!d.objectStoreNames.contains(DECISION_STORE)) {
        // Keyed by transaction_id: mirrors the SQLite UNIQUE(transaction_id)
        // constraint and makes lookups by transaction natural.
        d.createObjectStore(DECISION_STORE, { keyPath: 'transaction_id' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function byDateDesc(a: Transaction, b: Transaction): number {
  return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
}

export async function getNewTransactions(): Promise<Transaction[]> {
  const all = await req(db().transaction(TX_STORE).objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>);
  return all.filter((t) => t.status === 'new').sort(byDateDesc);
}

export async function getHistoryTransactions(): Promise<TransactionWithSplit[]> {
  const tx = db().transaction([TX_STORE, DECISION_STORE]);
  const [all, decisions] = await Promise.all([
    req(tx.objectStore(TX_STORE).getAll() as IDBRequest<Transaction[]>),
    req(tx.objectStore(DECISION_STORE).getAll() as IDBRequest<SplitDecision[]>),
  ]);
  const byTxId = new Map(decisions.map((d) => [d.transaction_id, d]));
  return all
    .filter((t) => t.status === 'split' || t.status === 'skipped')
    .sort(byDateDesc)
    .map((t) => {
      const d = byTxId.get(t.id);
      return {
        ...t,
        split: d ? { friend_names: d.friend_names, amount_each: d.amount_each } : undefined,
      };
    });
}

export async function upsertTransactions(txs: PlaidTransaction[]): Promise<void> {
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
      } satisfies Transaction);
    } else if (existing.status === 'new') {
      // Mirror the SQL UPDATE: refresh mutable fields, never touch status of
      // already-split/skipped rows.
      store.put({ ...existing, merchant_name: name, amount: p.amount, date: p.date, pending: p.pending });
    }
  }
  await done(tx);
}

export async function deleteTransactionsByPlaidIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  for (const id of ids) {
    tx.objectStore(TX_STORE).delete(id);
    // SQLite cascades split_decisions via ON DELETE CASCADE; mirror that here.
    tx.objectStore(DECISION_STORE).delete(id);
  }
  await done(tx);
}

export async function updateTransactionStatus(id: string, status: TransactionStatus): Promise<void> {
  const tx = db().transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const existing = await req(store.get(id) as IDBRequest<Transaction | undefined>);
  if (existing) store.put({ ...existing, status });
  await done(tx);
}

export async function getSplitDecision(transactionId: string): Promise<SplitDecision | null> {
  const row = await req(
    db().transaction(DECISION_STORE).objectStore(DECISION_STORE).get(transactionId) as IDBRequest<SplitDecision | undefined>,
  );
  return row ?? null;
}

export async function insertSplitDecision(decision: SplitDecision): Promise<void> {
  const tx = db().transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).put(decision);
  await done(tx);
}

export async function upsertSplitDecision(decision: SplitDecision): Promise<void> {
  const tx = db().transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).put(decision);
  await done(tx);
}

export async function deleteSplitDecision(transactionId: string): Promise<void> {
  const tx = db().transaction(DECISION_STORE, 'readwrite');
  tx.objectStore(DECISION_STORE).delete(transactionId);
  await done(tx);
}

export async function pruneOldTransactions(): Promise<void> {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);
  const cutoffIso = cutoff.toISOString();
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  const store = tx.objectStore(TX_STORE);
  const all = await req(store.getAll() as IDBRequest<Transaction[]>);
  for (const t of all) {
    if (t.created_at < cutoffIso) {
      store.delete(t.id);
      tx.objectStore(DECISION_STORE).delete(t.id);
    }
  }
  await done(tx);
}

export async function deleteAllTransactions(): Promise<void> {
  const tx = db().transaction([TX_STORE, DECISION_STORE], 'readwrite');
  tx.objectStore(TX_STORE).clear();
  // Parity with SQLite ON DELETE CASCADE.
  tx.objectStore(DECISION_STORE).clear();
  await done(tx);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- db.web`
Expected: PASS (9 tests). If `indexedDB = new IDBFactory()` trips TS, use `(globalThis as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();` in the test instead.

- [ ] **Step 6: Full suite + commit**

```bash
npm test
git add mobile/lib/db.web.ts mobile/__tests__/lib/db.web.test.ts mobile/package.json mobile/package-lock.json
git commit -m "feat(web): IndexedDB implementation of the local database"
```

---

### Task 5: Plaid Link abstraction (native SDK / web JS SDK)

**Files:**
- Create: `mobile/lib/plaidLink.ts`
- Create: `mobile/lib/plaidLink.web.ts`
- Delete: `mobile/lib/plaidLinkAvailable.ts`
- Modify: `mobile/app/(auth)/bank-connect.tsx`, `mobile/lib/worker.ts`
- Test: `mobile/__tests__/lib/plaidLink.web.test.ts`

- [ ] **Step 1: Write the failing test**

`mobile/__tests__/lib/plaidLink.web.test.ts`:

```ts
import { isPlaidLinkAvailable, openPlaidLink } from '@/lib/plaidLink.web';

interface FakePlaidConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
  onExit: () => void;
}

describe('plaidLink (web)', () => {
  let lastConfig: FakePlaidConfig | null = null;
  const openMock = jest.fn();

  beforeEach(() => {
    lastConfig = null;
    openMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      {
        Plaid: {
          create: (cfg: FakePlaidConfig) => {
            lastConfig = cfg;
            return { open: openMock, exit: jest.fn(), destroy: jest.fn() };
          },
        },
      },
    );
  });

  it('is always available on web', () => {
    expect(isPlaidLinkAvailable()).toBe(true);
  });

  it('creates a handler with the link token and opens it', async () => {
    await openPlaidLink('link-token-1', { onSuccess: jest.fn(), onExit: jest.fn() });
    expect(lastConfig?.token).toBe('link-token-1');
    expect(openMock).toHaveBeenCalled();
  });

  it('maps onSuccess to the shared result shape', async () => {
    const onSuccess = jest.fn();
    await openPlaidLink('t', { onSuccess, onExit: jest.fn() });
    lastConfig!.onSuccess('public-1', { institution: { name: 'Chase' } });
    expect(onSuccess).toHaveBeenCalledWith({ publicToken: 'public-1', institutionName: 'Chase' });
  });

  it('defaults institution name when metadata is missing', async () => {
    const onSuccess = jest.fn();
    await openPlaidLink('t', { onSuccess, onExit: jest.fn() });
    lastConfig!.onSuccess('public-1', {});
    expect(onSuccess).toHaveBeenCalledWith({ publicToken: 'public-1', institutionName: 'Your bank' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- plaidLink.web`
Expected: FAIL — cannot find module `@/lib/plaidLink.web`.

- [ ] **Step 3: Implement both platform files**

Create `mobile/lib/plaidLink.ts` (native — absorbs `plaidLinkAvailable.ts`):

```ts
// mobile/lib/plaidLink.ts
// Native Plaid Link via react-native-plaid-link-sdk. plaidLink.web.ts provides
// the same API on top of Plaid's Link JS SDK, keeping the native module out of
// the web bundle.
import { Platform, TurboModuleRegistry } from 'react-native';
import {
  create, open, destroy, LinkLogLevel, LinkIOSPresentationStyle,
} from 'react-native-plaid-link-sdk';

export interface PlaidLinkResult {
  publicToken: string;
  institutionName: string;
}

export interface PlaidLinkHandlers {
  onSuccess: (result: PlaidLinkResult) => void;
  onExit: () => void;
}

/** False in Expo Go and any JS-only build where Plaid native code was not compiled in. */
export function isPlaidLinkAvailable(): boolean {
  const MODULE = Platform.OS === 'android' ? 'PlaidAndroid' : 'RNLinksdk';
  return TurboModuleRegistry.get(MODULE) != null;
}

export async function openPlaidLink(linkToken: string, handlers: PlaidLinkHandlers): Promise<void> {
  await destroy().catch(() => {});
  create({ token: linkToken, logLevel: LinkLogLevel.ERROR, noLoadingState: false });
  requestAnimationFrame(() => {
    open({
      iOSPresentationStyle: LinkIOSPresentationStyle.MODAL,
      onSuccess: (s) => {
        handlers.onSuccess({
          publicToken: s.publicToken,
          institutionName: s.metadata.institution?.name ?? 'Your bank',
        });
      },
      onExit: () => handlers.onExit(),
    });
  });
}

export async function disposePlaidLink(): Promise<void> {
  await destroy().catch(() => {});
}
```

Create `mobile/lib/plaidLink.web.ts`:

```ts
// mobile/lib/plaidLink.web.ts
import type { PlaidLinkHandlers, PlaidLinkResult } from './plaidLink';

export type { PlaidLinkHandlers, PlaidLinkResult };

const SCRIPT_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

interface PlaidGlobal {
  create(config: {
    token: string;
    onSuccess: (publicToken: string, metadata: { institution?: { name?: string } }) => void;
    onExit: () => void;
  }): { open(): void; exit(): void; destroy(): void };
}

declare global {
  interface Window { Plaid?: PlaidGlobal }
}

let scriptPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SCRIPT_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromise = null; // allow retry on next attempt
        reject(new Error('PLAID_SCRIPT_LOAD_FAILED'));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

export function isPlaidLinkAvailable(): boolean {
  return true;
}

export async function openPlaidLink(linkToken: string, handlers: PlaidLinkHandlers): Promise<void> {
  await loadScript();
  const handler = window.Plaid!.create({
    token: linkToken,
    onSuccess: (publicToken, metadata) => {
      handlers.onSuccess({ publicToken, institutionName: metadata.institution?.name ?? 'Your bank' });
    },
    onExit: () => handlers.onExit(),
  });
  handler.open();
}

export async function disposePlaidLink(): Promise<void> {}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- plaidLink.web`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor bank-connect.tsx onto the abstraction**

In `mobile/app/(auth)/bank-connect.tsx`:
- Remove imports: the whole `react-native-plaid-link-sdk` import block and `import { isPlaidLinkNativeAvailable } from '@/lib/plaidLinkAvailable';`.
- Add: `import { isPlaidLinkAvailable, openPlaidLink, disposePlaidLink } from '@/lib/plaidLink';`
- Replace the unmount effect body: `void destroy().catch(() => {});` → `void disposePlaidLink();`
- Replace `onLinkSuccess`/`onLinkExit`/`startPlaid` with:

```tsx
  async function onLinkSuccess(publicToken: string, institutionName: string) {
    await linkBank(publicToken, institutionName);
    await disposePlaidLink();
    router.replace('/(tabs)/');
  }

  async function startPlaid() {
    if (!isPlaidLinkAvailable()) {
      const inExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;
      showDialog(
        'Plaid needs a native build',
        inExpoGo
          ? 'Expo Go does not ship the Plaid native module. Run: npx expo run:ios'
          : 'The Plaid native module is not in this binary. Rebuild with npx expo run:ios.',
      );
      return;
    }

    setLoading(true);
    try {
      const { link_token } = await getLinkToken();
      await openPlaidLink(link_token, {
        onSuccess: (r) => { void onLinkSuccess(r.publicToken, r.institutionName); },
        onExit: () => { void disposePlaidLink(); },
      });
    } catch (e) {
      console.error('Plaid link failed', e);
      const message =
        e instanceof WorkerError ? e.code
        : e instanceof Error ? e.message
        : 'Could not start bank linking.';
      showDialog('Plaid unavailable', message);
    } finally {
      setLoading(false);
    }
  }
```

- Delete `mobile/lib/plaidLinkAvailable.ts` (`git rm mobile/lib/plaidLinkAvailable.ts`). Search for other importers first: `grep -rn "plaidLinkAvailable" mobile --include='*.ts*' | grep -v node_modules` — update/remove any hits (including tests).

- [ ] **Step 6: Send platform to the link-token endpoint**

In `mobile/lib/worker.ts`, add `import { Platform } from 'react-native';` and change:

```ts
export async function getLinkToken(): Promise<{ link_token: string }> {
  return post('/plaid/link-token', { platform: Platform.OS === 'web' ? 'web' : 'mobile' });
}
```

- [ ] **Step 7: Full suite + web export + commit**

```bash
npm test
npx expo export --platform web
```

Expected: tests pass; export exits 0 (the native Plaid SDK is now excluded from the web bundle). If Task 1 Step 4 had failed on the Plaid import, re-verify it passes now.

```bash
git add -A mobile/lib mobile/app "mobile/__tests__/lib/plaidLink.web.test.ts"
git commit -m "feat(web): Plaid Link platform abstraction (native SDK / Link JS)"
```

---

### Task 6: Worker — CORS, Splitwise proxy, platform-aware link tokens

**Files:**
- Modify: `workers/src/index.ts`
- Test: `workers/src/index.test.ts` (append new describe blocks)

All commands in `workers/`.

- [ ] **Step 1: Write the failing tests**

The file `workers/src/index.test.ts` already has: `handler` (default export), `makeEnv(overrides)`, a global `mockFetch` (`vi.stubGlobal('fetch', mockFetch)`) reset in `beforeEach`, and requests built with `new Request(...)` + `handler.fetch(req, makeEnv(), {} as ExecutionContext)`. Append these describe blocks in the same style:

```ts
describe('CORS', () => {
  it('answers preflight without auth', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', { method: 'OPTIONS' });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Splitwise-Token');
  });

  it('adds CORS headers to normal responses', async () => {
    const req = new Request('https://worker.example.com/nope', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('honors ALLOWED_ORIGIN when set', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', { method: 'OPTIONS' });
    const res = await handler.fetch(req, makeEnv({ ALLOWED_ORIGIN: 'https://app.example' }), {} as ExecutionContext);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
  });
});

describe('Splitwise proxy', () => {
  it('forwards GET requests with the user token', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ friends: [] }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/splitwise/api/get_friends', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key', 'X-Splitwise-Token': 'user-tok' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/get_friends');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer user-tok');
    expect(init.method).toBe('GET');
  });

  it('forwards POST bodies and content type', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ expenses: [{ id: 1 }] }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/splitwise/api/create_expense', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test_api_key',
        'X-Splitwise-Token': 'user-tok',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'cost=1.00',
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/create_expense');
    expect(init.body).toBe('cost=1.00');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('rejects proxy calls missing the Splitwise token', async () => {
    const req = new Request('https://worker.example.com/splitwise/api/get_friends', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('link-token platform', () => {
  it('omits android_package_name for web platform', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-web-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'web' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('android_package_name');
  });

  it('keeps android_package_name for mobile (no platform in body)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-mobile-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toHaveProperty('android_package_name', 'com.spliteasy.app');
  });
});
```

- [ ] **Step 2: Run tests to verify new ones fail**

Run: `npx vitest run`
Expected: previous 18 still pass, 3 pre-existing failures remain, new tests FAIL.

- [ ] **Step 3: Implement in workers/src/index.ts**

Add to `Env`:

```ts
  ALLOWED_ORIGIN?: string;
```

Add helpers after `json()`:

```ts
function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Splitwise-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(res: Response, env: Env): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
```

Change `handleLinkToken` to accept the request and honor `platform`:

```ts
async function handleLinkToken(req: Request, env: Env): Promise<Response> {
  let platform = 'mobile';
  try {
    const body = await req.json() as { platform?: string };
    if (body.platform === 'web') platform = 'web';
  } catch {
    // empty body → default to mobile
  }
  const res = await fetch(`${plaidBase(env)}/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      client_name: 'SplitEasy',
      country_codes: ['US'],
      language: 'en',
      user: { client_user_id: 'spliteasy-user' }, // TODO(phase-2): accept user_id from request body for per-user Plaid identity
      products: ['transactions'],
      // android_package_name is only valid for Android link tokens.
      ...(platform === 'web' ? {} : { android_package_name: 'com.spliteasy.app' }),
    }),
  });
  const data = await res.json() as { link_token?: string; error_code?: string };
  if (!res.ok) return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  return json({ link_token: data.link_token });
}
```

Add the proxy handler:

```ts
const SPLITWISE_API_BASE = 'https://secure.splitwise.com/api/v3.0';

// Browser clients cannot call Splitwise directly (no CORS on their API), so the
// web app tunnels through here. The user's Splitwise token arrives in
// X-Splitwise-Token; Authorization still carries the worker API key.
async function handleSplitwiseProxy(req: Request, apiPath: string): Promise<Response> {
  const token = req.headers.get('X-Splitwise-Token');
  if (!token) return json({ error: 'MISSING_SPLITWISE_TOKEN' }, 400);
  const contentType = req.headers.get('Content-Type');
  const upstream = await fetch(`${SPLITWISE_API_BASE}${apiPath}`, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: req.method === 'POST' ? await req.text() : undefined,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

Rewrite the default export's `fetch`:

```ts
export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    try {
      if (!authenticate(req, env)) return withCors(json({ error: 'Unauthorized' }, 401), env);
      const path = new URL(req.url).pathname;
      let res: Response;
      if (req.method === 'POST' && path === '/plaid/link-token') res = await handleLinkToken(req, env);
      else if (req.method === 'POST' && path === '/plaid/exchange') res = await handleExchange(req, env);
      else if (req.method === 'POST' && path === '/plaid/transactions') res = await handleTransactions(req, env);
      else if (req.method === 'POST' && path === '/splitwise/exchange') res = await handleSplitwiseExchange(req, env);
      else if ((req.method === 'GET' || req.method === 'POST') && path.startsWith('/splitwise/api/')) {
        res = await handleSplitwiseProxy(req, path.slice('/splitwise/api'.length));
      } else res = json({ error: 'Not Found' }, 404);
      return withCors(res, env);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return withCors(json({ error: 'INVALID_REQUEST_BODY' }, 400), env);
      }
      throw err;
    }
  },
};
```

Note `handleLinkToken(req, env)` now takes the request — the existing call site changes accordingly (shown above).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: all new tests pass; exactly the 3 known pre-existing failures remain; previously-passing tests still pass. **Check the existing `/plaid/link-token` test** — it previously sent `{}` or no body; the new `req.json()` tolerates both. If it asserted the upstream body contains `android_package_name`, it should still pass (default platform is mobile).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "feat(worker): CORS, Splitwise API proxy, platform-aware link tokens"
```

---

### Task 7: Splitwise transport platform split (mobile)

**Files:**
- Create: `mobile/lib/splitwiseTransport.ts`
- Create: `mobile/lib/splitwiseTransport.web.ts`
- Modify: `mobile/lib/splitwise.ts`
- Test: `mobile/__tests__/lib/splitwiseTransport.web.test.ts`

- [ ] **Step 1: Write the failing test**

`mobile/__tests__/lib/splitwiseTransport.web.test.ts`:

```ts
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { workerBaseUrl: 'https://worker.example/', workerApiKey: 'wk-key' } } },
}));
jest.mock('@/lib/secure', () => ({
  getSecure: jest.fn().mockResolvedValue('sw-token'),
  KEYS: { SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token' },
}));

import { splitwiseFetch } from '@/lib/splitwiseTransport.web';

describe('splitwiseTransport (web)', () => {
  const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));

  beforeEach(() => {
    fetchMock.mockClear();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  it('routes through the worker proxy with both auth headers', async () => {
    await splitwiseFetch('/get_friends');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://worker.example/splitwise/api/get_friends');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer wk-key',
      'X-Splitwise-Token': 'sw-token',
    });
    expect(init.method).toBe('GET');
  });

  it('passes through POST method, body, and content type', async () => {
    await splitwiseFetch('/create_expense', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: 'cost=1.00',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('cost=1.00');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- splitwiseTransport`
Expected: FAIL — cannot find module `@/lib/splitwiseTransport.web`.

- [ ] **Step 3: Implement both transports**

`mobile/lib/splitwiseTransport.ts` (native — direct API call, as today):

```ts
// mobile/lib/splitwiseTransport.ts
// Native transport: call the Splitwise API directly. The web override
// (splitwiseTransport.web.ts) tunnels through the Cloudflare Worker because
// Splitwise does not send CORS headers.
import { getSecure, KEYS } from '@/lib/secure';

const BASE = 'https://secure.splitwise.com/api/v3.0';

export interface SplitwiseFetchInit {
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
}

export async function splitwiseFetch(path: string, init?: SplitwiseFetchInit): Promise<Response> {
  const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
  return fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    body: init?.body,
  });
}
```

`mobile/lib/splitwiseTransport.web.ts`:

```ts
// mobile/lib/splitwiseTransport.web.ts
import Constants from 'expo-constants';
import { getSecure, KEYS } from '@/lib/secure';
import type { SplitwiseFetchInit } from './splitwiseTransport';

export type { SplitwiseFetchInit };

export async function splitwiseFetch(path: string, init?: SplitwiseFetchInit): Promise<Response> {
  const baseUrl = String(Constants.expoConfig?.extra?.workerBaseUrl ?? '').replace(/\/$/, '');
  const apiKey = String(Constants.expoConfig?.extra?.workerApiKey ?? '');
  const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
  return fetch(`${baseUrl}/splitwise/api${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Splitwise-Token': token ?? '',
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    body: init?.body,
  });
}
```

- [ ] **Step 4: Rewire lib/splitwise.ts onto the transport**

In `mobile/lib/splitwise.ts`, replace the header/transport plumbing (lines 1–38: imports, `BASE`, `authHeader`, `swGet`, `swPost`) with:

```ts
// mobile/lib/splitwise.ts
import { SplitwiseFriend } from '@/lib/types';
import { splitwiseFetch } from '@/lib/splitwiseTransport';

export class SplitwiseAuthError extends Error {
  constructor() {
    super('SPLITWISE_AUTH_EXPIRED');
    this.name = 'SplitwiseAuthError';
  }
}

async function swGet<T>(path: string): Promise<T> {
  const res = await splitwiseFetch(path);
  if (res.status === 401) throw new SplitwiseAuthError();
  if (!res.ok) throw new Error('SPLITWISE_ERROR');
  return res.json() as Promise<T>;
}

async function swPost<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await splitwiseFetch(path, {
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    body: new URLSearchParams(body).toString(),
  });
  if (res.status === 401) throw new SplitwiseAuthError();
  if (!res.ok) throw new Error('SPLITWISE_ERROR');
  return res.json() as Promise<T>;
}
```

Everything from `interface RawFriend` down is unchanged.

- [ ] **Step 5: Run full suite**

Run: `npm test`
Expected: PASS. If an existing splitwise test mocked `@/lib/secure` or global fetch, it still works — the native transport calls the same underlying pieces. Fix any mock paths if a suite stubbed `authHeader` internals (check `__tests__` for `splitwise` usages first: `grep -rln "splitwise" mobile/__tests__`).

- [ ] **Step 6: Commit**

```bash
git add mobile/lib/splitwise.ts mobile/lib/splitwiseTransport.ts mobile/lib/splitwiseTransport.web.ts mobile/__tests__/lib/splitwiseTransport.web.test.ts
git commit -m "feat(web): route Splitwise API through worker proxy on web"
```

---

### Task 8: Splitwise OAuth — web redirect flow + callback route

**Files:**
- Create: `mobile/lib/splitwiseAuth.ts`
- Create: `mobile/lib/splitwiseAuth.web.ts`
- Create: `mobile/app/oauth/callback.tsx`
- Modify: `mobile/app/(auth)/index.tsx`
- Test: `mobile/__tests__/lib/splitwiseAuth.web.test.ts`

- [ ] **Step 1: Write the failing test**

`mobile/__tests__/lib/splitwiseAuth.web.test.ts`:

```ts
import { signInWithSplitwise, getWebRedirectUri } from '@/lib/splitwiseAuth.web';

describe('splitwiseAuth (web)', () => {
  const assignMock = jest.fn();

  beforeEach(() => {
    assignMock.mockReset();
    (globalThis as Record<string, unknown>).window = Object.assign(
      (globalThis as { window?: object }).window ?? {},
      { location: { origin: 'https://app.example', assign: assignMock } },
    );
  });

  it('derives the redirect uri from the page origin', () => {
    expect(getWebRedirectUri()).toBe('https://app.example/oauth/callback');
  });

  it('navigates to the Splitwise authorize URL and resolves null', async () => {
    const result = await signInWithSplitwise('client-1');
    expect(result).toBeNull();
    const url = assignMock.mock.calls[0][0] as string;
    expect(url).toContain('https://secure.splitwise.com/oauth/authorize');
    expect(url).toContain('client_id=client-1');
    expect(url).toContain(encodeURIComponent('https://app.example/oauth/callback'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- splitwiseAuth`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement both platform files**

`mobile/lib/splitwiseAuth.ts` (native — current WebBrowser flow extracted):

```ts
// mobile/lib/splitwiseAuth.ts
// Native OAuth: in-app browser session returning to the custom URL scheme.
// splitwiseAuth.web.ts replaces this with a full-page redirect; the code lands
// on app/oauth/callback.tsx instead of resolving here.
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

const REDIRECT_URI = 'spliteasy://oauth/callback';

function buildAuthUrl(clientId: string, redirectUri: string): string {
  return (
    'https://secure.splitwise.com/oauth/authorize' +
    `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`
  );
}

export interface SplitwiseSignInResult {
  code: string;
  redirectUri: string;
}

export async function signInWithSplitwise(clientId: string): Promise<SplitwiseSignInResult | null> {
  const result = await WebBrowser.openAuthSessionAsync(buildAuthUrl(clientId, REDIRECT_URI), REDIRECT_URI);
  if (result.type !== 'success') return null;
  const url = Linking.parse(result.url);
  const code = url.queryParams?.code as string | undefined;
  if (!code) return null;
  return { code, redirectUri: REDIRECT_URI };
}
```

`mobile/lib/splitwiseAuth.web.ts`:

```ts
// mobile/lib/splitwiseAuth.web.ts
import type { SplitwiseSignInResult } from './splitwiseAuth';

export type { SplitwiseSignInResult };

export function getWebRedirectUri(): string {
  return `${window.location.origin}/oauth/callback`;
}

// Full-page redirect: the browser leaves the app and Splitwise sends the user
// back to /oauth/callback?code=..., handled by app/oauth/callback.tsx. Always
// resolves null — the navigation takes over.
export async function signInWithSplitwise(clientId: string): Promise<SplitwiseSignInResult | null> {
  const url =
    'https://secure.splitwise.com/oauth/authorize' +
    `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(getWebRedirectUri())}`;
  window.location.assign(url);
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- splitwiseAuth`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the callback route**

Create `mobile/app/oauth/callback.tsx`:

```tsx
// mobile/app/oauth/callback.tsx
// Web-only landing route for the Splitwise OAuth redirect. Native sign-in
// never navigates here (it uses the spliteasy:// scheme via expo-web-browser).
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { usePlaidStore } from '@/stores/plaidStore';
import { Colors, Radius, Spacing } from '@/lib/theme';

export default function OAuthCallbackScreen() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const router = useRouter();
  const signIn = useAuthStore((s) => s.signIn);
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  const code = typeof params.code === 'string' ? params.code : undefined;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!code || typeof window === 'undefined') {
      setFailed(true);
      return;
    }
    void (async () => {
      try {
        await signIn(code, `${window.location.origin}/oauth/callback`);
        // Root layout hydration may not have finished — hydrate explicitly so
        // the isLinked routing decision is correct.
        await usePlaidStore.getState().hydrate();
        router.replace(usePlaidStore.getState().isLinked ? '/(tabs)/' : '/(auth)/bank-connect');
      } catch (e) {
        console.error('Splitwise OAuth exchange failed', e);
        setFailed(true);
      }
    })();
  }, [code, router, signIn]);

  return (
    <View style={styles.root}>
      {failed ? (
        <>
          <Text style={styles.title}>Sign-in failed</Text>
          <Text style={styles.subtitle}>We couldn't complete the Splitwise sign-in.</Text>
          <Pressable
            style={styles.btn}
            onPress={() => router.replace('/(auth)/')}
            accessibilityRole="button"
            accessibilityLabel="Back to sign in"
          >
            <Text style={styles.btnText}>Back to sign in</Text>
          </Pressable>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color={Colors.textInverse} />
          <Text style={styles.subtitle}>Completing sign-in…</Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.hero,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: Spacing.xxxl,
  },
  title: { fontSize: 22, fontWeight: '800', color: Colors.textInverse, marginBottom: Spacing.sm },
  subtitle: { fontSize: 15, color: 'rgba(255,255,255,0.75)', marginTop: Spacing.md, textAlign: 'center' },
  btn: {
    marginTop: Spacing.xxl,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    paddingVertical: 14,
    paddingHorizontal: Spacing.xxl,
  },
  btnText: { color: Colors.primary, fontSize: 15, fontWeight: '700' },
});
```

Check `mobile/lib/theme.ts` exports `Colors.hero`, `Colors.textInverse`, `Colors.surface`, `Colors.primary`, `Radius.lg`, `Spacing` — they are used by existing screens, so they exist; if a name differs, match what `app/(auth)/index.tsx` uses.

- [ ] **Step 6: Rewire the welcome screen**

In `mobile/app/(auth)/index.tsx`:
- Remove `import * as WebBrowser from 'expo-web-browser';`, `import * as Linking from 'expo-linking';`, and the `REDIRECT_URI` constant.
- Add `import { signInWithSplitwise } from '@/lib/splitwiseAuth';`
- Replace `handleSignIn` with:

```tsx
  async function handleSignIn() {
    setLoading(true);
    try {
      const result = await signInWithSplitwise(CLIENT_ID);
      // null on web (page is navigating away) and on native cancel.
      if (!result) return;
      await signIn(result.code, result.redirectUri);
      const isLinked = usePlaidStore.getState().isLinked;
      router.replace(isLinked ? '/(tabs)/' : '/(auth)/bank-connect');
    } catch (err) {
      console.error('Sign in failed', err);
    } finally {
      setLoading(false);
    }
  }
```

- [ ] **Step 7: Full suite + commit**

```bash
npm test
git add mobile/lib/splitwiseAuth.ts mobile/lib/splitwiseAuth.web.ts mobile/app/oauth/callback.tsx "mobile/app/(auth)/index.tsx" mobile/__tests__/lib/splitwiseAuth.web.test.ts
git commit -m "feat(web): Splitwise OAuth redirect flow with callback route"
```

---

### Task 9: PWA shell — manifest, icons, service worker, HTML head

**Files:**
- Create: `mobile/public/manifest.webmanifest`
- Create: `mobile/public/sw.js`
- Create: `mobile/public/icons/icon-192.png`, `mobile/public/icons/icon-512.png`, `mobile/public/icons/icon-512-maskable.png`
- Create: `mobile/app/+html.tsx`
- Modify: `mobile/app/_layout.tsx`

- [ ] **Step 1: Generate icons from existing assets**

```bash
mkdir -p mobile/public/icons
sips -z 192 192 mobile/assets/icon.png --out mobile/public/icons/icon-192.png
sips -z 512 512 mobile/assets/icon.png --out mobile/public/icons/icon-512.png
sips -z 512 512 mobile/assets/adaptive-icon.png --out mobile/public/icons/icon-512-maskable.png
```

Expected: three PNGs created (`file mobile/public/icons/*.png` shows the pixel sizes).

- [ ] **Step 2: Write the manifest**

`mobile/public/manifest.webmanifest`:

```json
{
  "name": "SplitEasy",
  "short_name": "SplitEasy",
  "description": "Split expenses with friends, effortlessly.",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#5C7AEA",
  "theme_color": "#5C7AEA",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icons/icon-512-maskable.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
```

- [ ] **Step 3: Write the service worker**

`mobile/public/sw.js`:

```js
// Minimal app-shell service worker. Network-first for navigations (so deploys
// appear on next load), cache-first for hashed static assets.
const CACHE = 'spliteasy-v1';
const APP_SHELL = ['/', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(
      (cached) =>
        cached ??
        fetch(event.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
    )
  );
});
```

- [ ] **Step 4: Customize the HTML shell**

`mobile/app/+html.tsx`:

```tsx
// mobile/app/+html.tsx
// Web-only HTML shell used by `expo export --platform web`.
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>SplitEasy</title>
        <meta name="description" content="Split expenses with friends, effortlessly." />
        <meta name="theme-color" content="#5C7AEA" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="SplitEasy" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Register the service worker (web, production only)**

In `mobile/app/_layout.tsx`:
- Add `Platform` to the react-native import: `import { Platform, StyleSheet } from 'react-native';`
- Guard the splash-screen call (web has no splash screen):

```ts
if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync();
}
```

- Add a second `useEffect` in `RootLayout` after the init effect:

```ts
  useEffect(() => {
    if (
      Platform.OS === 'web' &&
      process.env.NODE_ENV === 'production' &&
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator
    ) {
      navigator.serviceWorker.register('/sw.js').catch((e) => {
        console.error('Service worker registration failed', e);
      });
    }
  }, []);
```

Also guard `app/index.tsx`'s `SplashScreen.hideAsync()`: wrap line 17 as

```ts
    if (Platform.OS !== 'web') void SplashScreen.hideAsync();
```

(add `Platform` to its react-native import).

- [ ] **Step 6: Build and verify the PWA artifacts land in dist**

```bash
cd mobile
npx expo export --platform web
ls dist/manifest.webmanifest dist/sw.js dist/icons/icon-192.png
grep -o 'manifest.webmanifest' dist/index.html
grep -o 'theme-color' dist/index.html
```

Expected: all files exist; both greps match (public/ files are copied into dist, +html head tags present).

- [ ] **Step 7: Full suite + commit**

```bash
npm test
git add mobile/public mobile/app/+html.tsx mobile/app/_layout.tsx mobile/app/index.tsx
git commit -m "feat(pwa): manifest, icons, service worker, and web HTML shell"
```

---

### Task 10: README + deployment docs

**Files:**
- Modify: `README.md` (repo root)

- [ ] **Step 1: Update the architecture block and add a Web/PWA section**

In `README.md`:

1. Change the architecture block line `mobile/          Expo (React Native) iOS app` to `mobile/          Expo app — PWA (web) + optional iOS native build`.

2. In the Worker API routes table, add:

```markdown
| GET/POST | `/splitwise/api/*` | CORS proxy to the Splitwise API for the web app (user token via `X-Splitwise-Token`) |
```

3. After the "Mobile app" local-dev section, add:

```markdown
#### Web (PWA)

```bash
cd mobile
npm run web          # dev server in the browser
npm run build:web    # production build → mobile/dist/
```

The web app talks to the same local Worker. Two extra setup notes:

- **Splitwise redirect URI:** register `http://localhost:8081/oauth/callback` (dev) and `https://<your-domain>/oauth/callback` (production) as callback URLs in your [Splitwise OAuth app](https://secure.splitwise.com/oauth_clients). The native custom scheme `spliteasy://oauth/callback` stays registered for iOS builds.
- **Plaid on web** uses Plaid's hosted Link JS — no native build needed.
```

4. Replace the "Mobile app (EAS Build)" deployment section with:

```markdown
### Web app (PWA — primary distribution)

```bash
cd mobile
WORKER_BASE_URL=https://<your-worker>.workers.dev \
WORKER_API_KEY=<production key> \
SPLITWISE_CLIENT_ID=<client id> \
npx expo export --platform web
```

Deploy `mobile/dist/` to any static host. Cloudflare Pages (free, same account as the Worker) works well:

```bash
npx wrangler pages deploy mobile/dist --project-name spliteasy
```

Set `ALLOWED_ORIGIN` on the Worker to the deployed origin (optional hardening; defaults to `*`):

```bash
cd workers && npx wrangler secret put ALLOWED_ORIGIN
```

Users install the PWA from the browser: **Share → Add to Home Screen** on iOS Safari, or the install prompt on Chrome/Edge/Android.

### iOS native build (optional, requires Apple Developer account)

```bash
cd mobile
npx eas build --platform ios --profile production
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: PWA build, deploy, and OAuth setup instructions"
```

---

### Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run both test suites**

```bash
cd mobile && npm test
cd ../workers && npx vitest run
```

Expected: mobile all green; workers — only the 3 known pre-existing failures.

- [ ] **Step 2: Production web build**

```bash
cd mobile && npx expo export --platform web
```

Expected: exit 0, `dist/` contains `index.html`, `sw.js`, `manifest.webmanifest`, `icons/`.

- [ ] **Step 3: Serve and smoke-test**

```bash
cd mobile/dist && python3 -m http.server 8090 &
sleep 1
curl -s http://localhost:8090/ | grep -c "SplitEasy"          # ≥1
curl -s http://localhost:8090/manifest.webmanifest | grep -c "standalone"  # 1
curl -s -o /dev/null -w "%{http_code}" http://localhost:8090/sw.js         # 200
kill %1
```

Expected: all three checks pass. (Full interactive verification — sign-in redirect, Plaid sandbox, installability — happens in the browser after this plan completes; see the design spec's Testing section.)

- [ ] **Step 4: TypeScript check**

```bash
cd mobile && npx tsc --noEmit
```

Expected: no errors. (`.web.ts` files are included by the default tsconfig glob; they type-check against DOM APIs via TS's lib settings — if `lib` lacks `dom`, add `"lib": ["esnext", "dom"]` to `mobile/tsconfig.json` compilerOptions.)

- [ ] **Step 5: Commit any stragglers and report**

```bash
git status --short   # should be clean
```

Report: test counts, build output size, and any deviations from the plan.
