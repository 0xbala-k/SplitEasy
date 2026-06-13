# History Split / Edit / Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** From the History tab, let users split a previously-skipped transaction, edit an existing split, and delete a split (removing the Splitwise expense and returning the transaction to the dashboard).

**Architecture:** Reuse `FriendPickerSheet` for both splitting skipped transactions (create mode) and editing splits (edit mode, pre-filled from Splitwise via a new `getExpense` read). A new `HistoryActionSheet` presents Edit/Delete on split rows. Splitwise gains `updateExpense`/`deleteExpense`/`getExpense`; the DB gains `upsertSplitDecision`/`deleteSplitDecision`; the transaction store gains a `deleteSplit` action that reverts a transaction to `new`. Splitwise writes happen before local writes so the two never diverge.

**Tech Stack:** React Native / Expo 52, expo-router, zustand, expo-sqlite, @gorhom/bottom-sheet, jest-expo. Splitwise REST v3.0.

**Spec:** `docs/superpowers/specs/2026-06-12-history-split-edit-delete-design.md`

---

## File Structure

- `mobile/lib/splitwise.ts` (modify) — extract a shared `buildExpenseBody` helper; add `updateExpense`, `deleteExpense`, `getExpense`.
- `mobile/__tests__/lib/splitwise.test.ts` (modify) — tests for the three new functions.
- `mobile/lib/db.ts` (modify) — add `upsertSplitDecision`, `deleteSplitDecision`.
- `mobile/__tests__/lib/db.test.ts` (modify) — tests for both.
- `mobile/stores/transactionStore.ts` (modify) — add `deleteSplit` action.
- `mobile/__tests__/stores/transactionStore.test.ts` (modify) — tests for `deleteSplit`.
- `mobile/components/FriendPickerSheet.tsx` (modify) — add `mode`/`editDecision` props, edit pre-fill, update branch, CTA label.
- `mobile/components/HistoryActionSheet.tsx` (create) — Edit/Delete bottom-sheet menu.
- `mobile/app/(tabs)/history.tsx` (modify) — make rows pressable; wire up both sheets and handlers.

Tasks 1–3 are pure-logic and fully TDD. Tasks 4–6 are React Native UI/sheet wiring; per the spec they are verified manually with `npx tsc --noEmit` as the automated gate (RN bottom-sheet interactions are not unit-testable in this jest setup).

---

## Task 1: Splitwise — updateExpense, deleteExpense, getExpense

**Files:**
- Modify: `mobile/lib/splitwise.ts`
- Test: `mobile/__tests__/lib/splitwise.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these tests to the end of `mobile/__tests__/lib/splitwise.test.ts`, and update the import on line 8 to include the new functions:

```typescript
import { getFriends, createExpense, updateExpense, deleteExpense, getExpense, SplitwiseAuthError } from '@/lib/splitwise';
```

```typescript
test('updateExpense posts rebuilt body to /update_expense/{id}', async () => {
  mockResponse({ expenses: [{ id: 555 }] });
  const result = await updateExpense('555', {
    amount: 20.0,
    description: 'Lunch',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2'],
  });
  expect(result.amount_each).toBe(10);
  const [url, opts] = mockFetch.mock.calls[0];
  expect(url).toContain('/update_expense/555');
  expect(opts.method).toBe('POST');
  const body = new URLSearchParams(opts.body as string);
  expect(body.get('cost')).toBe('20.00');
  expect(body.get('users__0__owed_share')).toBe('10.00');
  expect(body.get('users__1__user_id')).toBe('2');
  expect(body.get('users__1__owed_share')).toBe('10.00');
});

test('updateExpense honors custom friendShares', async () => {
  mockResponse({ expenses: [{ id: 1 }] });
  const result = await updateExpense('1', {
    amount: 30.0,
    description: 'Dinner',
    currency: 'USD',
    currentUserId: '1',
    friendIds: ['2'],
    friendShares: { '2': 20 },
  });
  expect(result.amount_each).toBe(10);
  const body = new URLSearchParams(mockFetch.mock.calls[0][1].body as string);
  expect(body.get('users__1__owed_share')).toBe('20.00');
  expect(body.get('users__0__owed_share')).toBe('10.00');
});

test('updateExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(
    updateExpense('1', { amount: 10, description: 'x', currency: 'USD', currentUserId: '1', friendIds: ['2'] })
  ).rejects.toThrow(SplitwiseAuthError);
});

test('deleteExpense posts to /delete_expense/{id}', async () => {
  mockResponse({ success: true });
  await deleteExpense('555');
  const [url, opts] = mockFetch.mock.calls[0];
  expect(url).toContain('/delete_expense/555');
  expect(opts.method).toBe('POST');
});

test('deleteExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(deleteExpense('555')).rejects.toThrow(SplitwiseAuthError);
});

test('getExpense returns owed shares keyed by user id', async () => {
  mockResponse({
    expense: {
      users: [
        { user: { id: 1 }, paid_share: '30.00', owed_share: '10.00' },
        { user: { id: 2 }, paid_share: '0.00', owed_share: '10.00' },
        { user: { id: 3 }, paid_share: '0.00', owed_share: '10.00' },
      ],
    },
  });
  const shares = await getExpense('555');
  expect(shares).toEqual({ '1': 10, '2': 10, '3': 10 });
  const [url] = mockFetch.mock.calls[0];
  expect(url).toContain('/get_expense/555');
});

test('getExpense throws SplitwiseAuthError on 401', async () => {
  mockResponse({}, 401);
  await expect(getExpense('555')).rejects.toThrow(SplitwiseAuthError);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest __tests__/lib/splitwise.test.ts -t "updateExpense|deleteExpense|getExpense"`
Expected: FAIL — `updateExpense`/`deleteExpense`/`getExpense` are not exported.

- [ ] **Step 3: Refactor `createExpense` to share a body builder, then add the three functions**

In `mobile/lib/splitwise.ts`, replace the entire `createExpense` function (lines 56–104) with the helper plus the four functions below. The body-building logic is lifted verbatim from the old `createExpense` so behavior is unchanged.

```typescript
interface ExpenseParams {
  amount: number;
  description: string;
  currency: string;
  currentUserId: string;
  friendIds: string[];
  // When provided, each entry overrides the equal-split share for that friend.
  // owner's owed_share is derived as amount - sum(friendShares).
  friendShares?: Record<string, number>;
}

// Builds the Splitwise indexed user body shared by create_expense and update_expense.
// Returns the body plus the owner's owed share in cents (the "amount each" surfaced to the UI).
function buildExpenseBody(params: ExpenseParams): { body: Record<string, string>; ownerOwedCents: number } {
  let ownerOwedCents: number;

  const body: Record<string, string> = {
    cost: params.amount.toFixed(2),
    description: params.description,
    currency_code: params.currency,
    'users__0__user_id': params.currentUserId,
    'users__0__paid_share': params.amount.toFixed(2),
  };

  if (params.friendShares) {
    let friendTotalCents = 0;
    params.friendIds.forEach((id, i) => {
      const shareCents = Math.round((params.friendShares![id] ?? 0) * 100);
      friendTotalCents += shareCents;
      body[`users__${i + 1}__user_id`] = id;
      body[`users__${i + 1}__paid_share`] = '0.00';
      body[`users__${i + 1}__owed_share`] = (shareCents / 100).toFixed(2);
    });
    ownerOwedCents = Math.round(params.amount * 100) - friendTotalCents;
  } else {
    const n = params.friendIds.length + 1;
    const friendShareCents = Math.floor((params.amount * 100) / n);
    ownerOwedCents = Math.round(params.amount * 100) - friendShareCents * params.friendIds.length;
    params.friendIds.forEach((id, i) => {
      body[`users__${i + 1}__user_id`] = id;
      body[`users__${i + 1}__paid_share`] = '0.00';
      body[`users__${i + 1}__owed_share`] = (friendShareCents / 100).toFixed(2);
    });
  }

  body['users__0__owed_share'] = (ownerOwedCents / 100).toFixed(2);
  return { body, ownerOwedCents };
}

export async function createExpense(params: ExpenseParams): Promise<{ expense_id: string; amount_each: number }> {
  const { body, ownerOwedCents } = buildExpenseBody(params);
  const data = await swPost<{ expenses: [{ id: number }] }>('/create_expense', body);
  return {
    expense_id: String(data.expenses[0].id),
    amount_each: ownerOwedCents / 100,
  };
}

export async function updateExpense(
  expenseId: string,
  params: ExpenseParams
): Promise<{ amount_each: number }> {
  const { body, ownerOwedCents } = buildExpenseBody(params);
  await swPost(`/update_expense/${expenseId}`, body);
  return { amount_each: ownerOwedCents / 100 };
}

export async function deleteExpense(expenseId: string): Promise<void> {
  await swPost(`/delete_expense/${expenseId}`, {});
}

// Returns each participant's owed_share (in dollars) keyed by Splitwise user id.
export async function getExpense(expenseId: string): Promise<Record<string, number>> {
  const data = await swGet<{
    expense: { users: { user: { id: number }; owed_share: string }[] };
  }>(`/get_expense/${expenseId}`);
  const shares: Record<string, number> = {};
  for (const u of data.expense.users) {
    shares[String(u.user.id)] = parseFloat(u.owed_share);
  }
  return shares;
}
```

Note: `swPost` is generic `<T>`; calling it without using the return value (as in `updateExpense`/`deleteExpense`) is fine — TypeScript infers `T = unknown`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest __tests__/lib/splitwise.test.ts`
Expected: PASS — all existing `createExpense`/`getFriends` tests plus the new ones.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/splitwise.ts mobile/__tests__/lib/splitwise.test.ts
git commit -m "feat(splitwise): add updateExpense, deleteExpense, getExpense

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 2: DB — upsertSplitDecision and deleteSplitDecision

**Files:**
- Modify: `mobile/lib/db.ts`
- Test: `mobile/__tests__/lib/db.test.ts`

- [ ] **Step 1: Write the failing tests**

Update the import block in `mobile/__tests__/lib/db.test.ts` (lines 5–16) to include the two new functions, then add the tests below to the end of the file:

```typescript
import {
  initDb,
  getNewTransactions,
  getHistoryTransactions,
  upsertTransactions,
  deleteTransactionsByPlaidIds,
  updateTransactionStatus,
  getSplitDecision,
  insertSplitDecision,
  upsertSplitDecision,
  deleteSplitDecision,
  pruneOldTransactions,
  deleteAllTransactions,
} from '@/lib/db';
```

```typescript
test('upsertSplitDecision upserts on transaction_id conflict', async () => {
  await initDb();
  await upsertSplitDecision({
    id: 'sd1',
    transaction_id: 'tx1',
    splitwise_expense_id: 'exp1',
    friend_ids: ['2'],
    friend_names: ['Sam'],
    amount_each: 10,
    created_at: '2026-06-12T00:00:00Z',
  });
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('ON CONFLICT(transaction_id)'),
    expect.arrayContaining(['sd1', 'tx1', 'exp1', '["2"]', '["Sam"]', 10, '2026-06-12T00:00:00Z'])
  );
});

test('deleteSplitDecision deletes by transaction_id', async () => {
  await initDb();
  await deleteSplitDecision('tx1');
  expect(mockDb.runAsync).toHaveBeenCalledWith(
    expect.stringContaining('DELETE FROM split_decisions'),
    ['tx1']
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest __tests__/lib/db.test.ts -t "upsertSplitDecision|deleteSplitDecision"`
Expected: FAIL — functions are not exported.

- [ ] **Step 3: Implement the two functions**

In `mobile/lib/db.ts`, add these after `insertSplitDecision` (after line 154):

```typescript
export async function upsertSplitDecision(decision: SplitDecision): Promise<void> {
  await db().runAsync(
    `INSERT INTO split_decisions (id, transaction_id, splitwise_expense_id, friend_ids, friend_names, amount_each, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(transaction_id) DO UPDATE SET
       splitwise_expense_id = excluded.splitwise_expense_id,
       friend_ids = excluded.friend_ids,
       friend_names = excluded.friend_names,
       amount_each = excluded.amount_each`,
    [
      decision.id,
      decision.transaction_id,
      decision.splitwise_expense_id,
      JSON.stringify(decision.friend_ids),
      JSON.stringify(decision.friend_names),
      decision.amount_each,
      decision.created_at,
    ]
  );
}

export async function deleteSplitDecision(transactionId: string): Promise<void> {
  await db().runAsync(
    `DELETE FROM split_decisions WHERE transaction_id = ?`,
    [transactionId]
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest __tests__/lib/db.test.ts`
Expected: PASS — all db tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/db.ts mobile/__tests__/lib/db.test.ts
git commit -m "feat(db): add upsertSplitDecision and deleteSplitDecision

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 3: transactionStore — deleteSplit action

**Files:**
- Modify: `mobile/stores/transactionStore.ts`
- Test: `mobile/__tests__/stores/transactionStore.test.ts`

- [ ] **Step 1: Write the failing tests**

In `mobile/__tests__/stores/transactionStore.test.ts`, add a splitwise mock and references, then the tests.

Add after the existing `jest.mock('@/stores/plaidStore');` line (line 13):

```typescript
jest.mock('@/lib/splitwise');
```

Add after the existing import of `WorkerError` (line 23):

```typescript
import * as splitwise from '@/lib/splitwise';
```

Add after `const mockSaveCursor = jest.fn();` (line 33):

```typescript
const mockDeleteExpense = splitwise.deleteExpense as jest.Mock;
const mockDeleteSplitDecision = db.deleteSplitDecision as jest.Mock;
```

Add inside `beforeEach`, after `mockSaveCursor.mockResolvedValue(undefined);` (line 61):

```typescript
  mockDeleteExpense.mockResolvedValue(undefined);
  mockDeleteSplitDecision.mockResolvedValue(undefined);
```

Add these tests at the end of the file:

```typescript
test('deleteSplit removes the Splitwise expense, clears the decision, reverts to new, reloads', async () => {
  await useTransactionStore.getState().deleteSplit('tx1', 'exp99');
  expect(mockDeleteExpense).toHaveBeenCalledWith('exp99');
  expect(mockDeleteSplitDecision).toHaveBeenCalledWith('tx1');
  expect(mockUpdateStatus).toHaveBeenCalledWith('tx1', 'new');
  expect(mockGetNew).toHaveBeenCalled(); // load() ran
});

test('deleteSplit leaves local state untouched if the Splitwise delete fails', async () => {
  mockDeleteExpense.mockRejectedValue(new Error('SPLITWISE_ERROR'));
  await expect(
    useTransactionStore.getState().deleteSplit('tx1', 'exp99')
  ).rejects.toThrow();
  expect(mockDeleteSplitDecision).not.toHaveBeenCalled();
  expect(mockUpdateStatus).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd mobile && npx jest __tests__/stores/transactionStore.test.ts -t deleteSplit`
Expected: FAIL — `deleteSplit` is not a function on the store.

- [ ] **Step 3: Implement `deleteSplit`**

In `mobile/stores/transactionStore.ts`:

Add `deleteSplitDecision` to the db import (lines 4–9):

```typescript
import {
  getNewTransactions,
  upsertTransactions,
  deleteTransactionsByPlaidIds,
  updateTransactionStatus,
  deleteSplitDecision,
} from '@/lib/db';
```

Add a splitwise import after the worker import (after line 3):

```typescript
import { deleteExpense } from '@/lib/splitwise';
```

Add to the `TransactionState` interface (after `markSplit`, line 19):

```typescript
  deleteSplit: (transactionId: string, splitwiseExpenseId: string) => Promise<void>;
```

Add the action implementation after `markSplit` (after line 74):

```typescript
  deleteSplit: async (transactionId, splitwiseExpenseId) => {
    // Splitwise first: if it fails we make no local change, so the two stay in sync.
    await deleteExpense(splitwiseExpenseId);
    await deleteSplitDecision(transactionId);
    await updateTransactionStatus(transactionId, 'new');
    await get().load();
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd mobile && npx jest __tests__/stores/transactionStore.test.ts`
Expected: PASS — all transactionStore tests including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add mobile/stores/transactionStore.ts mobile/__tests__/stores/transactionStore.test.ts
git commit -m "feat(store): add deleteSplit to revert a split transaction to new

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 4: FriendPickerSheet — edit mode

**Files:**
- Modify: `mobile/components/FriendPickerSheet.tsx`

This task has no unit test (RN sheet UI; manually verified). `npx tsc --noEmit` is the automated gate.

- [ ] **Step 1: Add imports**

Update the db import (line 16) and splitwise import (line 17), and add the `SplitDecision` type (line 18):

```typescript
import { getSplitDecision, insertSplitDecision, upsertSplitDecision, updateTransactionStatus } from '@/lib/db';
import { createExpense, updateExpense, getExpense, SplitwiseAuthError } from '@/lib/splitwise';
import { SplitwiseFriend, Transaction, SplitDecision } from '@/lib/types';
```

- [ ] **Step 2: Extend Props**

Replace the `Props` interface (lines 25–28) with:

```typescript
interface Props {
  transaction: Transaction | null;
  mode?: 'create' | 'edit';
  editDecision?: SplitDecision | null;
  onSuccess: (amountEach: number) => void;
}
```

Update the component signature (line 31) to destructure the new props with a default:

```typescript
  ({ transaction, mode = 'create', editDecision, onSuccess }, ref) => {
```

- [ ] **Step 3: Pre-fill selection and amounts in edit mode**

Add this effect inside the component, immediately after the existing `useState` declarations (after line 41, the `const toast = useToast();` line). It re-selects the saved friends and pulls exact per-friend amounts from Splitwise:

```typescript
    useEffect(() => {
      if (mode !== 'edit' || !editDecision) return;
      setSelected(new Set(editDecision.friend_ids));
      (async () => {
        try {
          const shares = await getExpense(editDecision.splitwise_expense_id);
          const amounts: Record<string, number> = {};
          editDecision.friend_ids.forEach((fid) => {
            amounts[fid] = shares[fid] ?? 0;
          });
          setCustomAmounts(amounts);
          const vals = Object.values(amounts);
          const allEqual = vals.every((v) => Math.abs(v - vals[0]) < 0.005);
          setSplitMode(allEqual ? 'equal' : 'custom');
        } catch {
          // Network/auth failure: keep friends selected, default to equal split.
          setSplitMode('equal');
        }
      })();
      // Re-run only when the edited transaction changes.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, editDecision?.transaction_id]);
```

`useEffect` is already imported on line 2 (`import { forwardRef, useEffect, useMemo, useState } from 'react';`).

- [ ] **Step 4: Branch the submit handler on mode**

In `handleAddToSplitwise`, replace the body of the `try` block's create path. Specifically, replace lines 105–140 (from `const existing = await getSplitDecision(...)` through `await markSplit(transaction!.id);` and `onSuccess(amount_each);`) with the version below, which adds an edit branch ahead of the existing create logic:

```typescript
        if (mode === 'edit' && editDecision) {
          const { amount_each } = await updateExpense(editDecision.splitwise_expense_id, {
            amount: transaction!.amount,
            description: transaction!.merchant_name,
            currency: transaction!.currency,
            currentUserId: user_id!,
            friendIds: selectedFriends.map((f) => f.id),
            ...(splitMode === 'custom' && { friendShares: customAmounts }),
          });
          await upsertSplitDecision({
            id: editDecision.id,
            transaction_id: transaction!.id,
            splitwise_expense_id: editDecision.splitwise_expense_id,
            friend_ids: selectedFriends.map((f) => f.id),
            friend_names: selectedFriends.map((f) => f.display_name),
            amount_each,
            created_at: editDecision.created_at,
          });
          onSuccess(amount_each);
          return;
        }

        const existing = await getSplitDecision(transaction!.id);
        if (existing) {
          await updateTransactionStatus(transaction!.id, 'split');
          await markSplit(transaction!.id);
          onSuccess(existing.amount_each);
          return;
        }

        const { expense_id, amount_each } = await createExpense({
          amount: transaction!.amount,
          description: transaction!.merchant_name,
          currency: transaction!.currency,
          currentUserId: user_id!,
          friendIds: selectedFriends.map((f) => f.id),
          ...(splitMode === 'custom' && { friendShares: customAmounts }),
        });

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await insertSplitDecision({
              id: `${transaction!.id}-${Date.now()}`,
              transaction_id: transaction!.id,
              splitwise_expense_id: expense_id,
              friend_ids: selectedFriends.map((f) => f.id),
              friend_names: selectedFriends.map((f) => f.display_name),
              amount_each,
              created_at: new Date().toISOString(),
            });
            break;
          } catch {
            if (attempt === 3) throw new Error('DB_WRITE_FAILED');
          }
        }

        await markSplit(transaction!.id);
        onSuccess(amount_each);
```

- [ ] **Step 5: Update the CTA label**

In the CTA `Pressable` (the `<Text>` on line 330), make the label mode-aware:

```typescript
                <Text style={[styles.addBtnText, ctaDisabled && styles.addBtnTextDisabled]}>
                  {mode === 'edit' ? 'Save changes' : 'Add to Splitwise'}
                </Text>
```

- [ ] **Step 6: Verify types compile**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add mobile/components/FriendPickerSheet.tsx
git commit -m "feat(split): add edit mode to FriendPickerSheet

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 5: HistoryActionSheet component

**Files:**
- Create: `mobile/components/HistoryActionSheet.tsx`

This task has no unit test (RN sheet UI; manually verified). `npx tsc --noEmit` is the automated gate.

- [ ] **Step 1: Create the component**

Create `mobile/components/HistoryActionSheet.tsx`:

```typescript
// mobile/components/HistoryActionSheet.tsx
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetView } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { TransactionWithSplit } from '@/lib/types';
import { Colors, Radius, Spacing, merchantColor } from '@/lib/theme';

interface Props {
  transaction: TransactionWithSplit | null;
  onEdit: () => void;
  onDelete: () => void;
}

export const HistoryActionSheet = forwardRef<BottomSheetModal, Props>(
  ({ transaction, onEdit, onDelete }, ref) => {
    if (!transaction) return null;

    const initial = (transaction.merchant_name ?? '?')[0].toUpperCase();
    const avatarBg = merchantColor(transaction.merchant_name ?? '?');

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['38%']}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetView style={styles.container}>
          <View style={styles.summary}>
            <View style={[styles.avatar, { backgroundColor: avatarBg + '18' }]}>
              <Text style={[styles.avatarText, { color: avatarBg }]}>{initial}</Text>
            </View>
            <View style={styles.info}>
              <Text style={styles.merchant} numberOfLines={1}>{transaction.merchant_name}</Text>
              <Text style={styles.amount}>${transaction.amount.toFixed(2)}</Text>
            </View>
          </View>

          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={onEdit}
            accessibilityRole="button"
            accessibilityLabel={`Edit split for ${transaction.merchant_name}`}
          >
            <Ionicons name="create-outline" size={20} color={Colors.textPrimary} />
            <Text style={styles.actionText}>Edit split</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
            onPress={onDelete}
            accessibilityRole="button"
            accessibilityLabel={`Delete split for ${transaction.merchant_name}`}
          >
            <Ionicons name="trash-outline" size={20} color={Colors.error} />
            <Text style={[styles.actionText, styles.deleteText]}>Delete split</Text>
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

  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: Radius.md,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: Spacing.md,
  },
  avatarText: { fontSize: 17, fontWeight: '700' },
  info: { flex: 1 },
  merchant: { fontSize: 16, fontWeight: '700', color: Colors.textPrimary },
  amount: { fontSize: 14, color: Colors.textSecondary, marginTop: 2 },

  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    backgroundColor: Colors.surfaceMuted,
    marginBottom: Spacing.sm,
  },
  actionPressed: { backgroundColor: Colors.border },
  actionText: { fontSize: 16, fontWeight: '600', color: Colors.textPrimary },
  deleteText: { color: Colors.error },
});
```

- [ ] **Step 2: Verify types compile**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add mobile/components/HistoryActionSheet.tsx
git commit -m "feat(history): add HistoryActionSheet for edit/delete menu

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 6: Wire up the History screen

**Files:**
- Modify: `mobile/app/(tabs)/history.tsx`

This task has no unit test (RN screen wiring; manually verified). `npx tsc --noEmit` is the automated gate.

- [ ] **Step 1: Replace the History screen with the wired-up version**

Replace the top of `mobile/app/(tabs)/history.tsx` from the imports through the end of the `HistoryRow` function (lines 1–87) with the version below. The `styles` block (lines 89–193) is unchanged and stays as-is.

```typescript
import { useCallback, useRef, useState } from 'react';
import { Alert, FlatList, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheetModal } from '@gorhom/bottom-sheet';
import { getHistoryTransactions, getSplitDecision } from '@/lib/db';
import { TransactionWithSplit, SplitDecision, Transaction } from '@/lib/types';
import { useTransactionStore } from '@/stores/transactionStore';
import { FriendPickerSheet } from '@/components/FriendPickerSheet';
import { HistoryActionSheet } from '@/components/HistoryActionSheet';
import { useToast } from '@/components/ToastProvider';
import { Colors, Radius, Shadow, Spacing, merchantColor } from '@/lib/theme';

export default function HistoryScreen() {
  const [rows, setRows] = useState<TransactionWithSplit[]>([]);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [editDecision, setEditDecision] = useState<SplitDecision | null>(null);
  const [pickerMode, setPickerMode] = useState<'create' | 'edit'>('create');
  const pickerRef = useRef<BottomSheetModal>(null);
  const actionRef = useRef<BottomSheetModal>(null);
  const deleteSplit = useTransactionStore((s) => s.deleteSplit);
  const toast = useToast();

  const refreshHistory = useCallback(() => {
    getHistoryTransactions().then(setRows);
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshHistory();
    }, [refreshHistory])
  );

  async function handleRowPress(item: TransactionWithSplit) {
    if (item.status === 'skipped') {
      // Split a previously-skipped transaction (create mode).
      setEditDecision(null);
      setPickerMode('create');
      setSelected(item);
      pickerRef.current?.present();
    } else {
      // Split row: offer edit/delete.
      setSelected(item);
      actionRef.current?.present();
    }
  }

  async function handleEdit() {
    if (!selected) return;
    const decision = await getSplitDecision(selected.id);
    if (!decision) {
      toast.show('Could not load this split. Please try again.', 'error');
      return;
    }
    actionRef.current?.dismiss();
    setEditDecision(decision);
    setPickerMode('edit');
    pickerRef.current?.present();
  }

  function handleDelete() {
    if (!selected) return;
    const tx = selected;
    actionRef.current?.dismiss();
    Alert.alert(
      'Delete split?',
      `This removes the Splitwise expense for ${tx.merchant_name} and moves it back to your transactions.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const decision = await getSplitDecision(tx.id);
            if (!decision) {
              toast.show('Could not load this split. Please try again.', 'error');
              return;
            }
            try {
              await deleteSplit(tx.id, decision.splitwise_expense_id);
              toast.show('Split deleted', 'success');
              refreshHistory();
            } catch {
              toast.show('Failed to delete. Please try again.', 'error');
            }
          },
        },
      ]
    );
  }

  function handlePickerSuccess(amountEach: number) {
    pickerRef.current?.dismiss();
    toast.show(
      pickerMode === 'edit' ? 'Split updated' : `Added! Others owe you $${amountEach.toFixed(2)}`,
      'success'
    );
    refreshHistory();
  }

  return (
    <View style={[styles.root, { paddingTop: Constants.statusBarHeight }]}>
      <StatusBar barStyle="dark-content" backgroundColor={Colors.bg} />
      <View style={styles.header}>
        <Text style={styles.headerTitle}>History</Text>
        {rows.length > 0 && (
          <Text style={styles.headerSub}>{rows.length} transaction{rows.length !== 1 ? 's' : ''}</Text>
        )}
      </View>

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(r) => r.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <HistoryRow item={item} onPress={() => handleRowPress(item)} />}
        />
      )}

      <FriendPickerSheet
        ref={pickerRef}
        transaction={selected}
        mode={pickerMode}
        editDecision={editDecision}
        onSuccess={handlePickerSuccess}
      />
      <HistoryActionSheet
        ref={actionRef}
        transaction={selected as TransactionWithSplit | null}
        onEdit={handleEdit}
        onDelete={handleDelete}
      />
    </View>
  );
}

function EmptyState() {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIcon}>
        <Ionicons name="time-outline" size={40} color={Colors.textTertiary} />
      </View>
      <Text style={styles.emptyTitle}>No history yet</Text>
      <Text style={styles.emptySubtitle}>
        Split or skip transactions to see them here.
      </Text>
    </View>
  );
}

function HistoryRow({ item, onPress }: { item: TransactionWithSplit; onPress: () => void }) {
  const date = new Date(item.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const isSplit = item.status === 'split' && item.split;
  const initial = (item.merchant_name ?? '?')[0].toUpperCase();
  const avatarColor = merchantColor(item.merchant_name ?? '?');

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        item.status === 'skipped'
          ? `Split ${item.merchant_name}`
          : `Edit or delete split for ${item.merchant_name}`
      }
    >
      <View style={[styles.avatar, { backgroundColor: avatarColor + '20' }]}>
        <Text style={[styles.avatarText, { color: avatarColor }]}>{initial}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.merchant} numberOfLines={1}>{item.merchant_name}</Text>
        <Text style={styles.date}>{date}</Text>
        {isSplit ? (
          <View style={styles.splitBadge}>
            <Ionicons name="people-outline" size={11} color={Colors.success} style={{ marginRight: 3 }} />
            <Text style={styles.splitText}>
              {item.split!.friend_names.join(', ')} · ${item.split!.amount_each.toFixed(2)} each
            </Text>
          </View>
        ) : (
          <View style={styles.skippedBadge}>
            <Text style={styles.skippedText}>Skipped · tap to split</Text>
          </View>
        )}
      </View>
      <Text style={styles.amount}>${item.amount.toFixed(2)}</Text>
    </Pressable>
  );
}
```

- [ ] **Step 2: Add the `cardPressed` style**

In the `styles` block, add a `cardPressed` entry immediately after the `card` style (after its closing `},`):

```typescript
  cardPressed: { backgroundColor: Colors.surfaceMuted },
```

- [ ] **Step 3: Verify types compile**

Run: `cd mobile && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full test suite**

Run: `cd mobile && npm test`
Expected: PASS — all suites green (no UI tests were added, but nothing should have regressed).

- [ ] **Step 5: Manual verification**

Start the app (`cd mobile && npx expo start`) and confirm on a device/simulator with a linked sandbox account:

1. **Split a skipped row:** History → tap a "Skipped" row → friend picker opens → pick friends → "Add to Splitwise" → row moves to the split state with the friends/amount badge.
2. **Edit a split (equal):** tap a split row → "Edit split" → picker opens with the same friends pre-selected in Equal mode → change friends → "Save changes" → badge updates; the Splitwise expense reflects the change.
3. **Edit a split (custom):** edit a custom-split row → exact per-friend amounts are pre-filled in Custom mode.
4. **Delete a split:** tap a split row → "Delete split" → confirm → toast "Split deleted"; row leaves History; switch to the Transactions tab → it is back as a new transaction; the Splitwise expense is gone.

- [ ] **Step 6: Commit**

```bash
git add "mobile/app/(tabs)/history.tsx"
git commit -m "feat(history): tap to split skipped, edit or delete splits

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Task 7: Final verification and PR

- [ ] **Step 1: Full gate**

Run: `cd mobile && npm test && npx tsc --noEmit`
Expected: all tests pass; no type errors.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/history-split-edit-delete
gh pr create --title "History: split skipped, edit and delete splits" --body "$(cat <<'EOF'
## Summary
- Tap a skipped transaction in History to split it
- Tap a split transaction to edit (participants/amounts) or delete it
- Deleting a split removes the Splitwise expense and returns the transaction to the dashboard as new

Edit pre-fills exact per-friend shares from Splitwise (new `getExpense`). Splitwise writes run before local writes so the two never diverge.

Spec: `docs/superpowers/specs/2026-06-12-history-split-edit-delete-design.md`
Plan: `docs/superpowers/plans/2026-06-12-history-split-edit-delete.md`

## Manual verification
- [ ] Split a skipped row → moves to split
- [ ] Edit an equal split → friends pre-selected, change saved to Splitwise
- [ ] Edit a custom split → exact amounts pre-filled
- [ ] Delete a split → Splitwise expense removed, transaction returns to dashboard

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- Split a skipped transaction → Task 4 (create mode reuse) + Task 6 (tap skipped row). ✓
- Edit a split → Task 1 (`updateExpense`/`getExpense`), Task 2 (`upsertSplitDecision`), Task 4 (edit mode), Task 6 (action sheet → edit). ✓
- Delete a split → Task 1 (`deleteExpense`), Task 2 (`deleteSplitDecision`), Task 3 (`deleteSplit` store action), Task 5/6 (action sheet → delete → confirm). ✓
- Edit pre-fill from Splitwise (Approach A) → Task 1 `getExpense`, Task 4 pre-fill effect. ✓
- Tap-to-open interaction → Task 6. ✓
- Delete returns to dashboard as new → Task 3 (status `new` + store reload), Task 6 confirm copy. ✓
- Splitwise-before-local ordering → Task 3 (delete), Task 4 (edit). ✓
- 401 → `SplitwiseAuthError` → toast → no local change → Task 1 (errors propagate), Task 6 (toasts). ✓
- Testing: logic-layer TDD (Tasks 1–3), UI manual verification (Tasks 4–6) → matches spec. ✓

**Placeholder scan:** none — every code step shows complete code.

**Type consistency:** `deleteSplit(transactionId, splitwiseExpenseId)` consistent across Task 3 def/test and Task 6 call. `FriendPickerSheet` props `mode`/`editDecision` consistent across Task 4 and Task 6. `getExpense` returns `Record<string, number>` used identically in Task 1 and Task 4. `upsertSplitDecision(decision: SplitDecision)` consistent across Tasks 2/4. ✓
