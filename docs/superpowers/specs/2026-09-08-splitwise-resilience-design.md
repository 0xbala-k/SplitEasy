# Splitwise Resilience — Design

**Date:** 2026-09-08
**Status:** Approved for planning
**Branch:** `feat/splitwise-resilience`

## Problem

Splitwise has begun gating API access behind a Pro subscription. This was
confirmed empirically on 2026-09-08: `/get_friends` returned **401** on a
free account with an otherwise valid OAuth token, and purchasing Pro restored
it immediately with no re-authentication. **The gate is indistinguishable from
an expired token on the wire** — a fact that shapes Section 2.

SplitEasy depends on that API in four load-bearing ways:

1. **Identity provider.** Sign-in *is* Splitwise OAuth (`authStore.signIn` →
   `exchangeSplitwiseCode`). No API, no login.
2. **Social graph.** Friends and groups come from `/get_friends` and
   `/get_groups`. The app has no local concept of a person.
3. **Ledger of record.** `split_decisions.splitwise_expense_id` plus expense
   create/update/delete/get.
4. **Inbound sync.** The `splitwise_inbox` table and `getExpensesUpdatedAfter`
   polling.

The decision is to **subscribe to Splitwise Pro** and keep the integration. For
a personal install this preserves the property that makes the integration
worth having at all: friends see expenses appear in their own Splitwise without
installing anything. No local rebuild reproduces that.

Subscribing alone, however, leaves the app brittle in ways already observed in
production:

- A dead token **locks the user out of their own local database**. `app/index.tsx:24`
  routes on `isAuthenticated`, which means only "a token string exists," so an
  expired token sends the user to the welcome screen while their transactions,
  splits, and vacation history sit unreachable on disk.
- Failures are **silent**. `friendStore.load()` swallows `SplitwiseAuthError` in
  a bare `catch` (`friendStore.ts:23`), so a 401 presents as "my friends list is
  empty" with no explanation. This defect went undiagnosed for an extended
  period.
- There is **no reconnect path**. The only way to re-run OAuth is `signOut`,
  which also clears the expense watermark and forces a full inbox re-pull.
- Writes are **remote-first with no retry**. A split created while the API is
  unavailable is simply lost.

This design hardens those four areas. It does not migrate off Splitwise.

## Non-Goals

- Replacing Splitwise with an owned backend. Ruled out: friends do not install
  SplitEasy, so an owned ledger would serve an audience of one.
- Public distribution. Splitwise's API terms bar use "in connection with any
  fee-based service"; Pro does not cure that clause. Shipping to strangers would
  require separate licensing from `developers@splitwise.com` and is out of scope.
- Working around the free-tier daily expense cap. The queue in Section 4 happens
  to absorb it, but that is a side effect, not a goal.

## Section 1 — Separate session from token validity

### Current behavior

`authStore` exposes a single `isAuthenticated` boolean, set to `!!token` at
`authStore.ts:36`. `app/index.tsx` routes on it. Token death is therefore
indistinguishable from "never signed in."

### Design

Replace the single flag with two independent concepts:

| Concept | Source of truth | Meaning |
|---|---|---|
| `hasSession` | `splitwise_user_id` in AsyncStorage | This device has been set up. Survives token death. |
| `tokenValid` | Token present AND not observed to be rejected | Sync can run. Never gates routing. |

`app/index.tsx` routes on `hasSession`. A user whose token has expired lands in
the tabs in **degraded mode** with local data fully readable.

Add `authStore.reconnect()`, which re-runs the OAuth flow and overwrites the
access token while explicitly preserving:

- `splitwise_user_id`, `splitwise_display_name`, `splitwise_avatar_url`
- `SPLITWISE_WATERMARK_KEY` (so the inbox does not re-pull from scratch)
- The entire local database

`signOut()` keeps its current clearing behavior and remains the way to switch
accounts.

### Degraded mode

With `hasSession && !tokenValid`, the app is read-write locally and
write-queued remotely:

- Transactions, history, spending, vacations: fully functional.
- Friend and group pickers: served from cache (Section 3).
- New splits: committed locally and queued (Section 4).
- Inbox sync: skipped, no error toast.

### Copy fix

`settings.tsx:19` currently warns that signing out "will remove all local data
from this device." This is false — `signOut` touches only the token and four
AsyncStorage keys. The misleading copy actively deterred the user from the one
recovery action available. Correct it to describe what actually happens.

## Section 2 — One auth-status flag, honestly surfaced

### Current behavior

`splitwiseAuthExpired` lives in `transactionStore` (`:52`) and is set only by
`syncSplitwiseInbox` (`:246`). It describes auth state but is scoped to
transactions, so `friendStore` cannot reach it and discards its own 401.

### Design

Move the flag to `authStore` as `tokenValid`. Every path that can observe a 401
sets it:

- `friendStore.load()` — replacing the bare `catch`
- `transactionStore.syncSplitwiseInbox()` — existing behavior, repointed
- `FriendPickerSheet` submit handlers — `createExpense` / `updateExpense` / `deleteExpense`
- Group fetches in `app/vacation/new.tsx`

`transactionStore.splitwiseAuthExpired` and `clearSplitwiseAuthExpired` are
removed; consumers read `authStore`.

### Two causes, one status code

A 401 has **two distinct causes with different remedies**, and Splitwise does not
distinguish them on the wire:

| Cause | Remedy | What `reconnect()` does |
|---|---|---|
| Expired / revoked OAuth token | Re-run OAuth | Fixes it |
| Lapsed Pro subscription | Renew Pro | **Nothing** — OAuth succeeds, next call still 401s |

A banner that unconditionally offers "Reconnect" therefore traps a Pro-lapsed
user in a loop: reconnecting appears to succeed, issues a valid token, and the
next request fails identically. The UI must not assert a cause it cannot observe.

**Disambiguation by elimination.** Track `lastReconnectAt` in `authStore`. If a
401 arrives from a token minted after the most recent successful OAuth, the
token is definitionally fresh and the cause is not token expiry. Escalate the
banner accordingly.

### Surfacing

A **persistent banner**, not a transient toast. A toast that scrolls away leaves
the user guessing — the observed failure mode that motivated this work, which
went undiagnosed for weeks precisely because nothing persisted.

Two states:

1. **First 401 (cause unknown).** "Splitwise isn't responding. Your data is safe
   on this device." Primary action **Reconnect**. Neutral about the cause.
2. **401 on a freshly minted token.** "Reconnecting didn't help — this usually
   means a lapsed Splitwise Pro subscription, which the API now requires."
   Primary action links to Splitwise subscription settings; **Reconnect**
   demoted to secondary.

Both states must say the local data is safe. The absence of that reassurance is
what made sign-out feel dangerous during this incident, when it never was.

The banner clears when any Splitwise request succeeds.

The static "Connected" badge in `settings.tsx:83-85` is hardcoded and does not
reflect real state. It must render from `tokenValid`, and must not read
"Connected" when the API is 401ing.

## Section 3 — Persist the friends and groups cache

### Current behavior

`friendStore` holds friends in memory only, fetches once per app session
(`friendStore.ts:18` returns early when the list is non-empty), and starts empty
on every launch. Any API failure yields an empty picker. `getGroups` in
`app/vacation/new.tsx` has the identical defect.

### Design

Two new stores, cached locally and refreshed opportunistically.

**SQLite** (`lib/db.ts`), migration **v8 → v9**:

```sql
CREATE TABLE IF NOT EXISTS splitwise_friends (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  avatar_url   TEXT,
  cached_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS splitwise_groups (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  member_ids   TEXT NOT NULL,  -- JSON array
  member_names TEXT NOT NULL,  -- JSON array, same order as member_ids
  cached_at    TEXT NOT NULL
);
```

Follow the ungated-`ALTER`/`CREATE TABLE IF NOT EXISTS` convention documented at
`db.ts:101-108`: new tables are not in the base `version < 1` block, so a fresh
install at version 0 must receive them here. Bump the stamp literal at
`db.ts:164` from 8 to 9.

**IndexedDB** (`lib/db.web.ts`): `DB_VERSION` 5 → 6, adding `FRIEND_STORE`
(`keyPath: 'id'`) and `GROUP_STORE` (`keyPath: 'id'`) in the existing
`onupgradeneeded` guard style at `db.web.ts:88-108`.

### Load semantics

`friendStore.load()` becomes cache-first:

1. Read cache, set state, render immediately.
2. Fetch from the API in the background.
3. On success, replace the cache wholesale and update state.
4. On failure, retain the cache and set `tokenValid = false` if the failure was
   a 401.

The per-session early return is removed — the cache makes refetching cheap, and
the current guard prevents recovery within a session.

**Replacement is wholesale, not merged.** A friend removed on Splitwise must
disappear locally; merging would resurrect deleted people. Cached rows are
display data with no foreign keys pointing at them — `split_decisions` stores
`friend_names` denormalized precisely so history survives friend deletion — so a
full replace is safe.

## Section 4 — Local-first writes with a flush queue

### Current behavior

The write path at `FriendPickerSheet.tsx:483-517` is **remote-first**:
`createExpense` → local commit → on local failure, delete the remote expense to
avoid an orphan. If the remote call fails, nothing is persisted and the user's
work is lost.

### Design

Invert to local-first. Commit the split locally, enqueue the remote operation,
flush later.

**Schema change.** `SplitDecision.splitwise_expense_id` is typed `string` and
commented "idempotency key" (`types.ts:98`). A queued split has no expense id
yet, so this becomes `string | null`. Every read path assuming non-null must be
audited; `db.ts:201`, `:290`, and `:313` already apply `?? r.id` fallbacks, which
reduces but does not eliminate the work.

**Queue table** (same migration, v9 / IndexedDB v6):

```sql
CREATE TABLE IF NOT EXISTS pending_splitwise_ops (
  id             TEXT PRIMARY KEY,
  op_type        TEXT NOT NULL,   -- 'create' | 'update' | 'delete'
  transaction_id TEXT,            -- local row this op belongs to
  expense_id     TEXT,            -- null until the create succeeds
  payload        TEXT NOT NULL,   -- JSON ExpenseParams
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     TEXT NOT NULL
);
```

**Processing.** Serial, FIFO, one op at a time. Parallel execution would reorder
operations against the same expense. On a successful `create`, backfill
`splitwise_expense_id` into `split_decisions` before dequeuing.

**Collapsing.** The correctness-critical rule. When enqueuing an op for a
transaction whose `create` is still pending:

| New op | Pending op | Result |
|---|---|---|
| `update` | `create` | Rewrite the queued `create` payload. Do not enqueue. |
| `delete` | `create` | Drop the queued `create`. Enqueue nothing. |
| `update` | `update` | Replace the queued payload. |
| `delete` | `update` | Drop the queued `update`, enqueue `delete`. |

Skipping this produces orphaned or duplicated Splitwise expenses — an update
against an expense id that does not exist yet, or a delete that races its own
create.

**Flush triggers.** App foreground, and immediately after a successful
`reconnect()`. Silent on success.

**Failure handling.** Increment `attempts` and record `last_error`. A 401 sets
`tokenValid = false` and halts the flush — retrying every queued op against a
dead token only burns rate limit. Ops exhausting a retry cap (5) surface in the
Section 2 banner as needing attention. Ops are never silently discarded.

**Idempotency, and its limit.** The existing pre-create check at
`FriendPickerSheet.tsx:475-481` (reject if a `SplitDecision` already exists)
still guards double submission locally, and an op is dequeued only after its
remote call returns success.

Neither guard covers the **lost-response create**: if `create_expense` succeeds
on the server but the response never arrives, the expense id is never
backfilled, the op stays queued, and the retry creates a **duplicate expense in
the friend's Splitwise**. Splitwise's API accepts no client-supplied idempotency
key, so this cannot be solved cleanly at the protocol level.

Mitigation: before retrying a `create` whose `attempts > 0`, call
`getExpensesUpdatedAfter` scoped to the op's `created_at` and look for an
expense matching cost, currency, description, and participant set. On a match,
adopt its id as though the original call had returned and dequeue. This is a
heuristic — two genuinely identical splits created in the same window are
indistinguishable — but it converts a silent duplicate into a rare
false-positive adopt, which is the better failure. The heuristic needs its own
tests and is the single most delicate piece of Section 4.

## Testing

Follows the existing structure and the repo's TDD flow. Baseline is 526 passing.

- **Migration tests.** v8 → v9 in `__tests__/lib/db.test.ts`; IndexedDB v5 → v6
  in `__tests__/lib/db.web.test.ts`. Both must cover fresh-install (version 0)
  and upgrade paths. Existing assertions on `user_version = 8` will need updating
  to 9 — this regression pattern was hit during the transaction-editing work and
  should be expected.
- **Parity.** `__tests__/lib/db.parity.test.ts` must cover the new tables so the
  SQLite and IndexedDB backends stay behaviorally identical.
- **Store tests.** `friendStore` cache-first load, including the 401 path
  retaining the cache and setting `tokenValid = false`.
- **Queue tests.** Every row of the collapsing table above, serial ordering,
  `splitwise_expense_id` backfill, retry-cap exhaustion, and the 401 halt.
- **Routing.** `hasSession && !tokenValid` reaches the tabs rather than
  `/(auth)/`.

## Migration and rollout

Schema changes are additive — new tables plus one column nullability relaxation.
No existing row is rewritten, so there is no destructive step and no backfill.

Sections are independently shippable and ordered by value:

1. **Sections 1 + 2** together — they share the `tokenValid` flag and jointly fix
   the observed lockout and silent-failure defects. Highest value, lowest risk.
2. **Section 3** — cache. Self-contained behind one migration.
3. **Section 4** — queue. Largest and riskiest; depends on 1 and 2 for the flag
   and the reconnect trigger.

## Open risks

- **Section 4 inverts a working write path.** The current remote-first ordering
  with rollback is correct as written; replacing it trades a simple failure mode
  (work is lost) for a complex one (work is queued and must reconcile). The
  collapsing rules are where this can go wrong, and they carry the heaviest test
  burden in this design.
- **Nullable `splitwise_expense_id` weakens an invariant.** It is documented as
  an idempotency key; permitting null means every consumer must handle a split
  that exists locally but not remotely.
- **Lost-response creates can duplicate.** Splitwise offers no idempotency key,
  so the mitigation above is a content-matching heuristic rather than a
  guarantee. This risk does not exist in today's remote-first path and is
  introduced by this design.
- **Pro subscription is a live dependency.** This design makes lapsing
  *survivable*, not *irrelevant*. With Splitwise disconnected, friends stop
  seeing expenses entirely; the local ledger keeps the user's own records intact
  but is not a substitute for the shared ledger. Renewal lapse is now a
  first-class failure mode, not an edge case — Section 2 state 2 exists solely
  to name it when it happens.
- **The Pro gate may widen.** Splitwise's terms reserve the right to change API
  conditions "at any time for any reason with or without notice." Today's gate
  is a Pro requirement; nothing prevents a future tightening that Pro does not
  satisfy. Sections 1–3 keep the app usable in that scenario; Section 4 keeps
  work from being lost in it. Neither restores the shared ledger.
