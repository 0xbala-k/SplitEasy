# Local-First Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Supabase backend with a stateless Cloudflare Worker (thin Plaid proxy), local SQLite (GRDB), and iOS Keychain so that zero user financial data is stored on any server.

**Architecture:** Cloudflare Worker handles Plaid API calls (server secret required) and Splitwise OAuth code exchange (client secret required). All transaction data lives in local SQLite (GRDB.swift) with a 6-month prune. Splitwise friends/expenses are called directly from iOS using a Keychain-stored OAuth token. Tokens never persist server-side.

**Tech Stack:** Swift 5.9+ / SwiftUI, GRDB.swift (SQLite), iOS Keychain (Security framework), Cloudflare Workers (TypeScript, Wrangler CLI), Splitwise REST API v3.0, Plaid Link iOS SDK + Transactions Sync API, XCTest, Vitest (Worker tests)

**Spec:** `docs/superpowers/specs/2026-03-22-local-first-plaid-splitwise-design.md`

---

## File Map

### New Files

| File | Responsibility |
|---|---|
| `workers/src/index.ts` | CF Worker: 4 routes (plaid/link-token, plaid/exchange, plaid/transactions, splitwise/exchange) |
| `workers/src/index.test.ts` | Vitest tests for all Worker routes |
| `workers/wrangler.toml` | CF Worker config |
| `workers/package.json` | Worker dev deps (wrangler, vitest, typescript) |
| `workers/tsconfig.json` | TypeScript config |
| `SplitEasy/Services/KeychainService.swift` | Read/write/delete from iOS Keychain |
| `SplitEasy/Services/DatabaseService.swift` | GRDB singleton, migrations, prune |
| `SplitEasy/Services/WorkerService.swift` | URLSession HTTP client for CF Worker; also defines `WorkerServiceProtocol` |
| `SplitEasy/Services/SplitwiseAPIService.swift` | Direct Splitwise REST API (friends, create_expense); also defines `SplitwiseAPIServiceProtocol` |
| `SplitEasy/Utilities/UserDefaultsKeys.swift` | Typed constants for UserDefaults keys |
| `SplitEasyTests/Services/KeychainServiceTests.swift` | Keychain CRUD tests |
| `SplitEasyTests/Services/DatabaseServiceTests.swift` | SQLite migrations, prune, unique-constraint tests |
| `SplitEasyTests/Services/WorkerServiceTests.swift` | Mock URLSession tests for WorkerService |
| `SplitEasyTests/Services/SplitwiseAPIServiceTests.swift` | Mock URLSession tests for SplitwiseAPIService |
| `SplitEasyTests/Services/SplitServiceTests.swift` | Idempotency + retry tests for SplitService |

### Modified Files

| File | Change |
|---|---|
| `SplitEasy/Models/Transaction.swift` | GRDB record with CodingKeys (snake_case column names) |
| `SplitEasy/Models/SplitDecision.swift` | GRDB record with CodingKeys + friend_names + unique constraint |
| `SplitEasy/Models/SplitwiseFriend.swift` | Custom decoder for Splitwise API nested response shape |
| `SplitEasy/Services/TransactionService.swift` | Replace Supabase with GRDB |
| `SplitEasy/Services/PlaidService.swift` | WorkerService + Keychain; pagination loop for has_more; injectable `WorkerServiceProtocol` init |
| `SplitEasy/Services/SplitwiseAuthService.swift` | CF Worker exchange + Keychain storage |
| `SplitEasy/Services/FriendService.swift` | SplitwiseAPIService direct call; injectable `SplitwiseAPIServiceProtocol` init |
| `SplitEasy/Services/SplitService.swift` | SplitwiseAPIService + GRDB with idempotency + retry |
| `SplitEasy/ViewModels/OnboardingViewModel.swift` | Keychain-based auth check, no Supabase |
| `SplitEasy/ViewModels/NewTransactionsViewModel.swift` | SQLite + Plaid sync; remove Realtime; NetworkMonitor offline guard |
| `SplitEasy/ViewModels/HistoryViewModel.swift` | SQLite reads with split_decisions join |
| `SplitEasy/ViewModels/SettingsViewModel.swift` | UserDefaults/Keychain; disconnect + sign-out |
| `SplitEasy/ViewModels/FriendPickerViewModel.swift` | Double instead of Decimal; offline guard |
| `SplitEasy/SplitEasyApp.swift` | Keychain seeding + background prune on launch |
| `SplitEasy/Info.plist` | Replace SUPABASE_* with WORKER_URL, WORKER_API_KEY |
| `SplitEasyTests/Models/TransactionTests.swift` | Update for new GRDB Transaction model |
| `SplitEasyTests/ViewModels/FriendPickerViewModelTests.swift` | Update makeTransaction helper (Double amounts) |
| `SplitEasyTests/Services/TransactionServiceTests.swift` | Real GRDB tests replacing stub |

### Deleted Files

| File | Reason |
|---|---|
| `SplitEasy/Services/SupabaseService.swift` | Supabase removed entirely |
| `SplitEasy/Models/PlaidItem.swift` | Replaced by UserDefaults entries |
| `supabase/` (entire directory) | Edge functions + migrations no longer used |

---

## Phase 1 — Cloudflare Worker

### Task 1: Worker project scaffold

**Files:**
- Create: `workers/package.json`
- Create: `workers/tsconfig.json`
- Create: `workers/wrangler.toml`

- [ ] **Step 1: Create workers directory and package.json**

```bash
mkdir -p workers/src
```

`workers/package.json`:
```json
{
  "name": "spliteasy-worker",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  },
  "devDependencies": {
    "wrangler": "^3.0.0",
    "vitest": "^1.0.0",
    "typescript": "^5.0.0",
    "@cloudflare/workers-types": "^4.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

`workers/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create wrangler.toml**

`workers/wrangler.toml`:
```toml
name = "spliteasy-worker"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# Secrets set via `wrangler secret put`:
# PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV (sandbox|development|production)
# WORKER_API_KEY, SPLITWISE_CLIENT_ID, SPLITWISE_CLIENT_SECRET
```

- [ ] **Step 4: Install dependencies**

```bash
cd workers && npm install
```

Expected: `node_modules` created, no errors.

- [ ] **Step 5: Commit scaffold**

```bash
git add workers/
git commit -m "chore: scaffold Cloudflare Worker project"
```

---

### Task 2: Worker routes + tests

**Files:**
- Create: `workers/src/index.ts`
- Create: `workers/src/index.test.ts`

- [ ] **Step 1: Write failing tests**

`workers/src/index.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

interface Env {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  WORKER_API_KEY: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
}

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  PLAID_CLIENT_ID: 'test_client_id',
  PLAID_SECRET: 'test_secret',
  PLAID_ENV: 'sandbox',
  WORKER_API_KEY: 'test_api_key',
  SPLITWISE_CLIENT_ID: 'sw_client_id',
  SPLITWISE_CLIENT_SECRET: 'sw_secret',
  ...overrides,
});

// Import handler at module level (vitest handles mock hoisting)
import handler from './index';

beforeEach(() => { mockFetch.mockReset(); });

describe('Worker auth middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', { method: 'POST' });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is wrong', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});

describe('POST /plaid/link-token', () => {
  it('returns link_token on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-sandbox-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { link_token: string };
    expect(body.link_token).toBe('link-sandbox-abc');
  });

  it('uses correct plaid base URL for sandbox vs production', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-prod-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    await handler.fetch(req, makeEnv({ PLAID_ENV: 'production' }), {} as ExecutionContext);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('production.plaid.com'),
      expect.anything()
    );
  });
});

describe('POST /plaid/exchange', () => {
  it('returns access_token on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-sandbox-xyz', item_id: 'item1' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token: 'public-sandbox-token' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string };
    expect(body.access_token).toBe('access-sandbox-xyz');
  });
});

describe('POST /plaid/transactions', () => {
  it('strips credits (amount <= 0) from added and modified', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        added: [
          { transaction_id: 'tx1', amount: 25.00, merchant_name: 'Coffee' },
          { transaction_id: 'tx2', amount: -10.00, merchant_name: 'Refund' },
        ],
        modified: [],
        removed: [],
        next_cursor: 'cursor-abc',
        has_more: false,
      }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'access-sandbox-xyz' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { added: { transaction_id: string }[] };
    expect(body.added).toHaveLength(1);
    expect(body.added[0].transaction_id).toBe('tx1');
  });

  it('returns 400 with ITEM_LOGIN_REQUIRED error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED' }), { status: 400 })
    );
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'access-sandbox-xyz' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('ITEM_LOGIN_REQUIRED');
  });
});

describe('POST /splitwise/exchange', () => {
  it('returns access_token and user profile', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sw-token-abc' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          user: { id: 123, first_name: 'Bala', last_name: 'K', picture: { medium: 'https://img.url' } }
        }), { status: 200 })
      );
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-123', redirect_uri: 'spliteasy://oauth' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    // user_id is returned as a string (Worker converts Splitwise int ID to string)
    const body = await res.json() as { access_token: string; user_id: string; display_name: string };
    expect(body.access_token).toBe('sw-token-abc');
    expect(body.user_id).toBe('123');         // string, not number
    expect(body.display_name).toBe('Bala K');
  });
});
```

- [ ] **Step 2: Run tests to confirm FAIL**

```bash
cd workers && npm test
```

Expected: FAIL — `Cannot find module './index'`

- [ ] **Step 3: Implement the Worker**

`workers/src/index.ts`:
```typescript
interface Env {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  WORKER_API_KEY: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
}

function plaidBase(env: Env): string {
  switch (env.PLAID_ENV) {
    case 'production': return 'https://production.plaid.com';
    case 'development': return 'https://development.plaid.com';
    default: return 'https://sandbox.plaid.com';
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticate(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  return auth === `Bearer ${env.WORKER_API_KEY}`;
}

async function handleLinkToken(env: Env): Promise<Response> {
  const res = await fetch(`${plaidBase(env)}/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      client_name: 'SplitEasy',
      country_codes: ['US'],
      language: 'en',
      user: { client_user_id: 'spliteasy-user' },
      products: ['transactions'],
    }),
  });
  const data = await res.json() as { link_token?: string; error_code?: string };
  if (!res.ok) return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  return json({ link_token: data.link_token });
}

async function handleExchange(req: Request, env: Env): Promise<Response> {
  const { public_token } = await req.json() as { public_token: string };
  const res = await fetch(`${plaidBase(env)}/item/public_token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      public_token,
    }),
  });
  const data = await res.json() as { access_token?: string; error_code?: string };
  if (!res.ok) return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  return json({ access_token: data.access_token });
}

interface PlaidTransaction {
  transaction_id: string;
  amount: number;
  [key: string]: unknown;
}

async function handleTransactions(req: Request, env: Env): Promise<Response> {
  const { access_token, cursor } = await req.json() as { access_token: string; cursor?: string };
  const res = await fetch(`${plaidBase(env)}/transactions/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      access_token,
      ...(cursor ? { cursor } : {}),
    }),
  });
  const data = await res.json() as {
    added?: PlaidTransaction[];
    modified?: PlaidTransaction[];
    removed?: { transaction_id: string }[];
    next_cursor?: string;
    has_more?: boolean;
    error_code?: string;
  };
  if (!res.ok) {
    if (data.error_code === 'ITEM_LOGIN_REQUIRED') {
      return json({ error: 'ITEM_LOGIN_REQUIRED' }, 400);
    }
    return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  }
  const isDebit = (tx: PlaidTransaction) => tx.amount > 0;
  return json({
    added: (data.added ?? []).filter(isDebit),
    modified: (data.modified ?? []).filter(isDebit),
    removed: data.removed ?? [],
    next_cursor: data.next_cursor,
    has_more: data.has_more ?? false,
  });
}

async function handleSplitwiseExchange(req: Request, env: Env): Promise<Response> {
  const { code, redirect_uri } = await req.json() as { code: string; redirect_uri: string };
  const tokenRes = await fetch('https://secure.splitwise.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.SPLITWISE_CLIENT_ID,
      client_secret: env.SPLITWISE_CLIENT_SECRET,
      code,
      redirect_uri,
    }),
  });
  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenData.access_token) {
    return json({ error: tokenData.error ?? 'SPLITWISE_AUTH_ERROR' }, 400);
  }
  const userRes = await fetch('https://secure.splitwise.com/api/v3.0/get_current_user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const userData = await userRes.json() as {
    user: { id: number; first_name: string; last_name: string; picture?: { medium?: string } }
  };
  const { id, first_name, last_name, picture } = userData.user;
  return json({
    access_token: tokenData.access_token,
    user_id: String(id),           // always returned as string
    display_name: `${first_name} ${last_name}`.trim(),
    avatar_url: picture?.medium ?? null,
  });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (!authenticate(req, env)) return json({ error: 'Unauthorized' }, 401);
    const path = new URL(req.url).pathname;
    if (req.method === 'POST' && path === '/plaid/link-token') return handleLinkToken(env);
    if (req.method === 'POST' && path === '/plaid/exchange') return handleExchange(req, env);
    if (req.method === 'POST' && path === '/plaid/transactions') return handleTransactions(req, env);
    if (req.method === 'POST' && path === '/splitwise/exchange') return handleSplitwiseExchange(req, env);
    return json({ error: 'Not Found' }, 404);
  },
};
```

- [ ] **Step 4: Run tests to confirm PASS**

```bash
cd workers && npm test
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/src/
git commit -m "feat(worker): implement Plaid proxy and Splitwise exchange routes with tests"
```

---

### Task 3: Deploy Worker and verify

- [ ] **Step 1: Set secrets**

```bash
cd workers
npx wrangler secret put PLAID_CLIENT_ID
npx wrangler secret put PLAID_SECRET
npx wrangler secret put PLAID_ENV          # sandbox
npx wrangler secret put WORKER_API_KEY     # generate: openssl rand -hex 32
npx wrangler secret put SPLITWISE_CLIENT_ID
npx wrangler secret put SPLITWISE_CLIENT_SECRET
```

- [ ] **Step 2: Deploy**

```bash
cd workers && npm run deploy
```

Expected: Worker URL printed e.g. `https://spliteasy-worker.<account>.workers.dev`

- [ ] **Step 3: Smoke test**

```bash
# Should 401
curl -X POST https://spliteasy-worker.<account>.workers.dev/plaid/link-token

# Should return link_token
curl -X POST https://spliteasy-worker.<account>.workers.dev/plaid/link-token \
  -H "Authorization: Bearer <WORKER_API_KEY>"
```

Expected: First call returns `{"error":"Unauthorized"}`. Second returns `{"link_token":"..."}`.

- [ ] **Step 4: Note Worker URL for iOS config (Phase 5)**

---

## Phase 2 — iOS Foundation

### Task 4: Remove Supabase SPM dependency, add GRDB

- [ ] **Step 1: In Xcode, remove supabase-swift**

Project navigator → Project → Package Dependencies → select `supabase-swift` → click `−`.

- [ ] **Step 2: Add GRDB.swift**

`File > Add Package Dependencies` → search `https://github.com/groue/GRDB.swift` → version `>= 6.0.0` → add to **SplitEasy** target (and SplitEasyTests).

- [ ] **Step 3: Build to confirm Supabase import errors (expected)**

`Cmd+B` — expected: compile errors from `import Supabase` in existing files. Do not fix yet.

- [ ] **Step 4: Commit project file**

```bash
git add SplitEasy.xcodeproj/
git commit -m "chore(ios): swap supabase-swift for GRDB.swift in SPM"
```

---

### Task 5: KeychainService

**Files:**
- Create: `SplitEasy/Services/KeychainService.swift`
- Create: `SplitEasyTests/Services/KeychainServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/KeychainServiceTests.swift`:
```swift
import XCTest
@testable import SplitEasy

final class KeychainServiceTests: XCTestCase {
    let service = KeychainService.shared
    let testKey = "com.spliteasy.test.keychain"

    override func tearDown() { service.delete(key: testKey) }

    func test_setAndGet_roundTrip() {
        service.set("hello", for: testKey)
        XCTAssertEqual(service.get(testKey), "hello")
    }

    func test_overwrite_returnsLatestValue() {
        service.set("first", for: testKey)
        service.set("second", for: testKey)
        XCTAssertEqual(service.get(testKey), "second")
    }

    func test_delete_removesValue() {
        service.set("value", for: testKey)
        service.delete(key: testKey)
        XCTAssertNil(service.get(testKey))
    }

    func test_get_returnsNilForMissingKey() {
        XCTAssertNil(service.get("com.spliteasy.test.nonexistent.xyz"))
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — `KeychainService` not found.

- [ ] **Step 3: Implement KeychainService**

`SplitEasy/Services/KeychainService.swift`:
```swift
import Foundation
import Security

final class KeychainService {
    static let shared = KeychainService()
    private init() {}

    func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrAccount: key]
        SecItemDelete(query as CFDictionary)
        let attributes: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlock,
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    func get(_ key: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func delete(key: String) {
        let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrAccount: key]
        SecItemDelete(query as CFDictionary)
    }

    enum Key {
        static let plaidAccessToken = "com.spliteasy.plaid.access_token"
        static let splitwiseAccessToken = "com.spliteasy.splitwise.access_token"
        static let workerAPIKey = "com.spliteasy.worker.api_key"
    }
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Expected: All 4 `KeychainServiceTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/KeychainService.swift SplitEasyTests/Services/KeychainServiceTests.swift
git commit -m "feat(ios): add KeychainService for secure token storage"
```

---

### Task 6: Transaction model as GRDB record

**Files:**
- Modify: `SplitEasy/Models/Transaction.swift`
- Modify: `SplitEasyTests/Models/TransactionTests.swift`

- [ ] **Step 1: Write tests for new Transaction shape**

`SplitEasyTests/Models/TransactionTests.swift`:
```swift
import XCTest
import GRDB
@testable import SplitEasy

final class TransactionTests: XCTestCase {
    var db: DatabaseQueue!

    override func setUp() throws {
        db = try DatabaseQueue()
        try db.write { d in try Transaction.createTable(in: d) }
    }

    func test_statusRawValues() {
        XCTAssertEqual(Transaction.Status.new.rawValue, "new")
        XCTAssertEqual(Transaction.Status.split.rawValue, "split")
        XCTAssertEqual(Transaction.Status.skipped.rawValue, "skipped")
    }

    func test_insertAndFetch_roundTrip() throws {
        let tx = Transaction(id: "plaid-tx-001", merchantName: "Starbucks",
                             amount: 5.75, currency: "USD", date: "2026-03-22",
                             status: .new, createdAt: "2026-03-22T10:00:00Z")
        try db.write { d in try tx.insert(d) }
        let fetched = try db.read { d in try Transaction.fetchAll(d) }
        XCTAssertEqual(fetched.count, 1)
        XCTAssertEqual(fetched[0].id, "plaid-tx-001")
        XCTAssertEqual(fetched[0].merchantName, "Starbucks")
        XCTAssertEqual(fetched[0].amount, 5.75)
        XCTAssertEqual(fetched[0].status, .new)
    }

    func test_upsert_doesNotCreateDuplicate() throws {
        let tx = Transaction(id: "tx1", merchantName: "Shop", amount: 10.0, currency: "USD",
                             date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z")
        try db.write { d in try tx.upsert(d) }
        try db.write { d in try tx.upsert(d) }
        XCTAssertEqual(try db.read { d in try Transaction.fetchCount(d) }, 1)
    }

    func test_columnNames_useSnakeCase() throws {
        // Verify the table was created with snake_case columns (not camelCase)
        let cols = try db.read { d in
            try String.fetchAll(d, sql: "PRAGMA table_info(transactions)")
        }
        // PRAGMA table_info returns rows; check via raw SQL instead
        let result = try db.read { d -> [String] in
            struct Col: Decodable, FetchableRecord { let name: String }
            return try Col.fetchAll(d, sql: "PRAGMA table_info(transactions)").map(\.name)
        }
        XCTAssertTrue(result.contains("merchant_name"))
        XCTAssertTrue(result.contains("created_at"))
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — Transaction has wrong shape, no GRDB conformance.

- [ ] **Step 3: Rewrite Transaction.swift**

`SplitEasy/Models/Transaction.swift`:
```swift
import Foundation
import GRDB

struct Transaction: Identifiable, Equatable, Codable, FetchableRecord, PersistableRecord {
    enum Status: String, Codable {
        case new, split, skipped
    }

    var id: String          // Plaid transaction_id
    var merchantName: String?
    var amount: Double      // Always positive (debits only)
    var currency: String
    var date: String        // "YYYY-MM-DD"
    var status: Status
    var createdAt: String   // ISO-8601

    // CodingKeys map Swift property names to SQLite column names
    enum CodingKeys: String, CodingKey {
        case id
        case merchantName = "merchant_name"
        case amount, currency, date, status
        case createdAt = "created_at"
    }

    // Column references for GRDB filter/order expressions
    enum Columns {
        static let id = Column(CodingKeys.id)
        static let status = Column(CodingKeys.status)
        static let date = Column(CodingKeys.date)
        static let createdAt = Column(CodingKeys.createdAt)
    }

    static func createTable(in db: Database) throws {
        try db.create(table: databaseTableName, ifNotExists: true) { t in
            t.column("id", .text).primaryKey()
            t.column("merchant_name", .text)
            t.column("amount", .double).notNull()
            t.column("currency", .text).notNull().defaults(to: "USD")
            t.column("date", .text).notNull()
            t.column("status", .text).notNull().defaults(to: "new")
            t.column("created_at", .text).notNull()
        }
    }
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Expected: All 4 `TransactionTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Models/Transaction.swift SplitEasyTests/Models/TransactionTests.swift
git commit -m "refactor(ios): Transaction is now a GRDB record with CodingKeys for snake_case columns"
```

---

### Task 7: SplitDecision model as GRDB record

**Files:**
- Modify: `SplitEasy/Models/SplitDecision.swift`
- Create: `SplitEasyTests/Models/SplitDecisionTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Models/SplitDecisionTests.swift`:
```swift
import XCTest
import GRDB
@testable import SplitEasy

final class SplitDecisionTests: XCTestCase {
    var db: DatabaseQueue!

    override func setUp() throws {
        db = try DatabaseQueue()
        try db.write { d in
            try Transaction.createTable(in: d)
            try SplitDecision.createTable(in: d)
        }
    }

    func test_insertAndFetch_roundTrip() throws {
        try db.write { d in
            try Transaction(id: "tx1", merchantName: "A", amount: 20, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        let decision = SplitDecision(
            id: "d1", transactionId: "tx1", splitwiseExpenseId: "sw-123",
            friendIds: "[\"1\",\"2\"]", friendNames: "[\"Alice\",\"Bob\"]",
            amountEach: 6.67, createdAt: "2026-03-22T00:00:00Z"
        )
        try db.write { d in try decision.insert(d) }
        let fetched = try db.read { d in try SplitDecision.fetchAll(d) }
        XCTAssertEqual(fetched.count, 1)
        XCTAssertEqual(fetched[0].transactionId, "tx1")
        XCTAssertEqual(fetched[0].splitwiseExpenseId, "sw-123")
        XCTAssertEqual(fetched[0].amountEach, 6.67, accuracy: 0.001)
    }

    func test_friendIdList_decodesJsonArray() throws {
        let d = SplitDecision(id: "d1", transactionId: "tx1", splitwiseExpenseId: "sw",
                              friendIds: "[\"123\",\"456\"]", friendNames: "[\"Alice\",\"Bob\"]",
                              amountEach: 10, createdAt: "2026-03-22T00:00:00Z")
        XCTAssertEqual(d.friendIdList, ["123", "456"])
        XCTAssertEqual(d.friendNameList, ["Alice", "Bob"])
    }

    func test_uniqueConstraint_preventsDoubleSplitSameTransaction() throws {
        try db.write { d in
            try Transaction(id: "tx1", merchantName: "A", amount: 20, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
            try SplitDecision(id: "d1", transactionId: "tx1", splitwiseExpenseId: "sw1",
                              friendIds: "[\"1\"]", friendNames: "[\"Alice\"]",
                              amountEach: 10, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        let duplicate = SplitDecision(id: "d2", transactionId: "tx1",  // same transaction_id
                                      splitwiseExpenseId: "sw2", friendIds: "[\"1\"]",
                                      friendNames: "[\"Alice\"]", amountEach: 10,
                                      createdAt: "2026-03-22T00:00:00Z")
        XCTAssertThrowsError(try db.write { d in try duplicate.insert(d) })
    }

    func test_cascadeDelete_removesDecisionWhenTransactionDeleted() throws {
        try db.write { d in
            try Transaction(id: "tx1", merchantName: "A", amount: 20, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
            try SplitDecision(id: "d1", transactionId: "tx1", splitwiseExpenseId: "sw1",
                              friendIds: "[\"1\"]", friendNames: "[\"Alice\"]",
                              amountEach: 10, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        try db.write { d in try Transaction.deleteAll(d) }
        XCTAssertEqual(try db.read { d in try SplitDecision.fetchCount(d) }, 0)
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — `SplitDecision` has wrong shape, no GRDB conformance.

- [ ] **Step 3: Rewrite SplitDecision.swift**

`SplitEasy/Models/SplitDecision.swift`:
```swift
import Foundation
import GRDB

struct SplitDecision: Identifiable, Codable, FetchableRecord, PersistableRecord {
    var id: String
    var transactionId: String   // UNIQUE — one decision per transaction
    var splitwiseExpenseId: String
    var friendIds: String       // JSON-encoded [String] e.g. ["123","456"]
    var friendNames: String     // JSON-encoded [String] in same order — for offline History display
    var amountEach: Double
    var createdAt: String       // ISO-8601

    enum CodingKeys: String, CodingKey {
        case id
        case transactionId = "transaction_id"
        case splitwiseExpenseId = "splitwise_expense_id"
        case friendIds = "friend_ids"
        case friendNames = "friend_names"
        case amountEach = "amount_each"
        case createdAt = "created_at"
    }

    enum Columns {
        static let id = Column(CodingKeys.id)
        static let transactionId = Column(CodingKeys.transactionId)
        static let splitwiseExpenseId = Column(CodingKeys.splitwiseExpenseId)
    }

    var friendIdList: [String] {
        (try? JSONDecoder().decode([String].self, from: Data(friendIds.utf8))) ?? []
    }
    var friendNameList: [String] {
        (try? JSONDecoder().decode([String].self, from: Data(friendNames.utf8))) ?? []
    }

    static func createTable(in db: Database) throws {
        try db.create(table: databaseTableName, ifNotExists: true) { t in
            t.column("id", .text).primaryKey()
            t.column("transaction_id", .text).notNull().unique()
                .references("transactions", onDelete: .cascade)
            t.column("splitwise_expense_id", .text).notNull()
            t.column("friend_ids", .text).notNull()
            t.column("friend_names", .text).notNull()
            t.column("amount_each", .double).notNull()
            t.column("created_at", .text).notNull()
        }
    }
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Expected: All 4 `SplitDecisionTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Models/SplitDecision.swift SplitEasyTests/Models/SplitDecisionTests.swift
git commit -m "refactor(ios): SplitDecision is now a GRDB record with UNIQUE(transaction_id) + friend_names"
```

---

### Task 8: SplitwiseFriend model — update decoder for Splitwise API shape

**Files:**
- Modify: `SplitEasy/Models/SplitwiseFriend.swift`
- Create: `SplitEasyTests/Models/SplitwiseFriendTests.swift`

The Splitwise `GET /get_friends` response nests friend data:
```json
{ "friends": [{ "id": 123, "first_name": "Alice", "last_name": "K", "picture": { "medium": "https://..." } }] }
```

- [ ] **Step 1: Write the failing test**

`SplitEasyTests/Models/SplitwiseFriendTests.swift`:
```swift
// SplitEasyTests/Models/SplitwiseFriendTests.swift
import XCTest
@testable import SplitEasy

final class SplitwiseFriendTests: XCTestCase {
    func test_decodesNestedSplitwiseAPIShape() throws {
        let json = """
        {
            "id": 123,
            "first_name": "Alice",
            "last_name": "K",
            "picture": { "medium": "https://img.splitwise.com/alice.jpg" }
        }
        """.data(using: .utf8)!
        let friend = try JSONDecoder().decode(SplitwiseFriend.self, from: json)
        XCTAssertEqual(friend.id, "123")
        XCTAssertEqual(friend.name, "Alice K")
        XCTAssertEqual(friend.avatarURL, "https://img.splitwise.com/alice.jpg")
    }

    func test_memberwise_init() {
        let friend = SplitwiseFriend(id: "456", name: "Bob", avatarURL: nil)
        XCTAssertEqual(friend.id, "456")
        XCTAssertNil(friend.avatarURL)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/SplitwiseFriendTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: FAIL — SplitwiseFriend doesn't decode nested shape yet

- [ ] **Step 3: Implement custom Decodable init**

`SplitEasy/Models/SplitwiseFriend.swift`:
```swift
import Foundation

struct SplitwiseFriend: Identifiable, Hashable {
    let id: String          // Splitwise user ID (stored as String)
    let name: String        // "First Last"
    let avatarURL: String?
}

extension SplitwiseFriend: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, first_name, last_name, picture
    }
    private struct Picture: Decodable { let medium: String? }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rawId = try c.decode(Int.self, forKey: .id)
        id = String(rawId)
        let firstName = (try? c.decode(String.self, forKey: .first_name)) ?? ""
        let lastName = (try? c.decode(String.self, forKey: .last_name)) ?? ""
        name = "\(firstName) \(lastName)".trimmingCharacters(in: .whitespaces)
        avatarURL = (try? c.decode(Picture.self, forKey: .picture))?.medium
    }

    // Memberwise init for tests
    init(id: String, name: String, avatarURL: String?) {
        self.id = id
        self.name = name
        self.avatarURL = avatarURL
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/SplitwiseFriendTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Models/SplitwiseFriend.swift SplitEasyTests/Models/SplitwiseFriendTests.swift
git commit -m "fix(ios): SplitwiseFriend decoder matches Splitwise API nested response shape"
```

---

### Task 9: DatabaseService

**Files:**
- Create: `SplitEasy/Services/DatabaseService.swift`
- Create: `SplitEasyTests/Services/DatabaseServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/DatabaseServiceTests.swift`:
```swift
import XCTest
import GRDB
@testable import SplitEasy

final class DatabaseServiceTests: XCTestCase {
    var db: DatabaseQueue!

    override func setUp() throws {
        db = try DatabaseQueue()
        try db.write { db in
            try db.execute(sql: "PRAGMA foreign_keys = ON")
        }
        try DatabaseService.runMigrations(on: db)
    }

    func test_migrations_createBothTables() throws {
        struct Col: Decodable, FetchableRecord { let name: String }
        let tables = try db.read { d -> [String] in
            try String.fetchAll(d, sql: "SELECT name FROM sqlite_master WHERE type='table'")
        }
        XCTAssertTrue(tables.contains("transactions"))
        XCTAssertTrue(tables.contains("split_decisions"))
    }

    func test_prune_deletesTransactionsOlderThan6Months() throws {
        try db.write { d in
            try Transaction(id: "old", merchantName: "Old", amount: 10, currency: "USD",
                            date: "2025-01-01", status: .skipped,
                            createdAt: "2025-01-01T00:00:00Z").insert(d)
            try Transaction(id: "new", merchantName: "New", amount: 10, currency: "USD",
                            date: "2026-03-01", status: .new,
                            createdAt: "2026-03-01T00:00:00Z").insert(d)
        }
        try DatabaseService.prune(db: db)
        let remaining = try db.read { d in try Transaction.fetchAll(d) }
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(remaining[0].id, "new")
    }

    func test_foreignKeys_areEnabled() throws {
        // Inserting split_decision with no parent transaction should fail
        let orphan = SplitDecision(id: "d1", transactionId: "nonexistent",
                                   splitwiseExpenseId: "sw1", friendIds: "[]",
                                   friendNames: "[]", amountEach: 10,
                                   createdAt: "2026-03-22T00:00:00Z")
        XCTAssertThrowsError(try db.write { d in try orphan.insert(d) })
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — `DatabaseService` not found.

- [ ] **Step 3: Implement DatabaseService**

`SplitEasy/Services/DatabaseService.swift`:
```swift
import Foundation
import GRDB

final class DatabaseService {
    static let shared = DatabaseService()

    let queue: DatabaseQueue

    private init() {
        let path = try! FileManager.default
            .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("spliteasy.sqlite")
            .path
        queue = try! DatabaseQueue(path: path)
        // Set iOS Data Protection on the database file (implements NSFileProtectionComplete requirement from spec)
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: path
        )
        try! queue.write { db in try db.execute(sql: "PRAGMA foreign_keys = ON") }
        try! DatabaseService.runMigrations(on: queue)
    }

    static func runMigrations(on db: DatabaseQueue) throws {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1_initial_schema") { d in
            try d.execute(sql: "PRAGMA foreign_keys = ON")
            try Transaction.createTable(in: d)
            try SplitDecision.createTable(in: d)
        }
        try migrator.migrate(db)
    }

    static func prune(db: DatabaseQueue) throws {
        try db.write { d in
            try d.execute(sql: "DELETE FROM transactions WHERE created_at < datetime('now', '-6 months')")
        }
    }

    func pruneInBackground() {
        Task.detached(priority: .background) {
            try? DatabaseService.prune(db: DatabaseService.shared.queue)
        }
    }
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Expected: All 3 `DatabaseServiceTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/DatabaseService.swift SplitEasyTests/Services/DatabaseServiceTests.swift
git commit -m "feat(ios): add DatabaseService with GRDB migrations and 6-month prune"
```

---

### Task 10: UserDefaultsKeys + WorkerService

**Files:**
- Create: `SplitEasy/Utilities/UserDefaultsKeys.swift`
- Create: `SplitEasy/Services/WorkerService.swift`
- Create: `SplitEasyTests/Services/WorkerServiceTests.swift`

- [ ] **Step 1: Create UserDefaultsKeys.swift**

`SplitEasy/Utilities/UserDefaultsKeys.swift`:
```swift
enum UserDefaultsKeys {
    static let splitwiseUserId = "com.spliteasy.sw.user_id"
    static let splitwiseDisplayName = "com.spliteasy.sw.display_name"
    static let splitwiseAvatarURL = "com.spliteasy.sw.avatar_url"
    static let plaidInstitutionName = "com.spliteasy.plaid.institution_name"
    static let plaidInstitutionLogoURL = "com.spliteasy.plaid.institution_logo_url"
    static let plaidNeedsReauth = "com.spliteasy.plaid.needs_reauth"
    static let lastPlaidCursor = "com.spliteasy.plaid.last_cursor"
}
```

- [ ] **Step 2: Write failing WorkerService tests**

`SplitEasyTests/Services/WorkerServiceTests.swift`:
```swift
import XCTest
@testable import SplitEasy

// Reusable URLProtocol mock for all network service tests
final class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) -> (Data, HTTPURLResponse))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        guard let handler = MockURLProtocol.handler else { return }
        let (data, response) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

func makeMockSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [MockURLProtocol.self]
    return URLSession(configuration: config)
}

final class WorkerServiceTests: XCTestCase {
    var service: WorkerService!

    override func setUp() {
        KeychainService.shared.set("test_api_key", for: KeychainService.Key.workerAPIKey)
        service = WorkerService(baseURL: "https://test.worker.dev", session: makeMockSession())
    }

    func test_post_includesAuthHeader() async throws {
        struct Resp: Decodable { let link_token: String }
        MockURLProtocol.handler = { req in
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer test_api_key")
            let data = Data(#"{"link_token":"link-abc"}"#.utf8)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (data, resp)
        }
        struct EmptyBody: Encodable {}
        let result: Resp = try await service.post(path: "/plaid/link-token", body: EmptyBody())
        XCTAssertEqual(result.link_token, "link-abc")
    }

    func test_post_throwsPlaidItemLoginRequired_on400() async throws {
        MockURLProtocol.handler = { req in
            let data = Data(#"{"error":"ITEM_LOGIN_REQUIRED"}"#.utf8)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 400, httpVersion: nil, headerFields: nil)!
            return (data, resp)
        }
        struct Body: Encodable {}
        struct Resp: Decodable {}
        do {
            let _: Resp = try await service.post(path: "/plaid/transactions", body: Body())
            XCTFail("Expected WorkerError.plaidItemLoginRequired")
        } catch WorkerError.plaidItemLoginRequired {
            // expected
        }
    }

    func test_post_throwsHttpError_onOther4xx() async throws {
        MockURLProtocol.handler = { req in
            let data = Data(#"{"error":"PLAID_ERROR"}"#.utf8)
            let resp = HTTPURLResponse(url: req.url!, statusCode: 422, httpVersion: nil, headerFields: nil)!
            return (data, resp)
        }
        struct Body: Encodable {}
        struct Resp: Decodable {}
        do {
            let _: Resp = try await service.post(path: "/plaid/exchange", body: Body())
            XCTFail("Expected WorkerError.httpError")
        } catch WorkerError.httpError(let code, _) {
            XCTAssertEqual(code, 422)
        }
    }
}
```

- [ ] **Step 3: Run to confirm FAIL**

Expected: FAIL — `WorkerService` not found.

- [ ] **Step 4: Implement WorkerService**

`SplitEasy/Services/WorkerService.swift`:
```swift
import Foundation

enum WorkerError: Error {
    case plaidItemLoginRequired
    case httpError(Int, String)
    case noWorkerURL
    case noPlaidAccessToken
}

protocol WorkerServiceProtocol {
    func post<Body: Encodable, Response: Decodable>(path: String, body: Body) async throws -> Response
}

final class WorkerService: WorkerServiceProtocol {
    static let shared = WorkerService(
        baseURL: Bundle.main.infoDictionary?["WORKER_URL"] as? String ?? "",
        session: .shared
    )

    private let baseURL: String
    private let session: URLSession
    private let keychain = KeychainService.shared

    init(baseURL: String, session: URLSession) {
        self.baseURL = baseURL
        self.session = session
    }

    func post<Body: Encodable, Response: Decodable>(path: String, body: Body) async throws -> Response {
        guard !baseURL.isEmpty, let url = URL(string: baseURL + path) else {
            throw WorkerError.noWorkerURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let apiKey = keychain.get(KeychainService.Key.workerAPIKey) ?? ""
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.httpBody = try JSONEncoder().encode(body)

        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0

        if status == 400,
           let errBody = try? JSONDecoder().decode([String: String].self, from: data),
           errBody["error"] == "ITEM_LOGIN_REQUIRED" {
            throw WorkerError.plaidItemLoginRequired
        }
        guard (200..<300).contains(status) else {
            throw WorkerError.httpError(status, String(data: data, encoding: .utf8) ?? "Unknown")
        }
        return try JSONDecoder().decode(Response.self, from: data)
    }
}
```

- [ ] **Step 5: Run tests to confirm PASS**

Expected: All 3 `WorkerServiceTests` PASS.

- [ ] **Step 6: Commit**

```bash
git add SplitEasy/Utilities/UserDefaultsKeys.swift \
        SplitEasy/Services/WorkerService.swift \
        SplitEasyTests/Services/WorkerServiceTests.swift
git commit -m "feat(ios): add WorkerService (CF Worker HTTP client) and UserDefaultsKeys"
```

---

## Phase 3 — iOS Services

### Task 11: SplitwiseAPIService + tests

**Files:**
- Create: `SplitEasy/Services/SplitwiseAPIService.swift`
- Create: `SplitEasyTests/Services/SplitwiseAPIServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/SplitwiseAPIServiceTests.swift`:
```swift
import XCTest
@testable import SplitEasy

// Test helper — URLProtocol-based mock for SplitwiseAPIServiceTests
final class SplitwiseMockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Data, HTTPURLResponse))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = SplitwiseMockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (data, response) = try handler(request)
            client?.urlProtocol(self, didReceiveResponse: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoadData: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

private func makeSplitwiseMockSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [SplitwiseMockURLProtocol.self]
    return URLSession(configuration: config)
}

final class SplitwiseAPIServiceTests: XCTestCase {
    var service: SplitwiseAPIService!

    override func setUp() {
        KeychainService.shared.set("test_sw_token", for: KeychainService.Key.splitwiseAccessToken)
        service = SplitwiseAPIService(session: makeSplitwiseMockSession())
    }

    func test_getFriends_decodesSplittwiseNestedResponse() async throws {
        SplitwiseMockURLProtocol.handler = { req in
            XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer test_sw_token")
            let json = """
            {"friends":[{"id":123,"first_name":"Alice","last_name":"K","picture":{"medium":"https://img"}}]}
            """
            let resp = HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data(json.utf8), resp)
        }
        let friends = try await service.getFriends()
        XCTAssertEqual(friends.count, 1)
        XCTAssertEqual(friends[0].id, "123")
        XCTAssertEqual(friends[0].name, "Alice K")
        XCTAssertEqual(friends[0].avatarURL, "https://img")
    }

    func test_createExpense_encodesFormBodyCorrectly() async throws {
        var capturedRequest: URLRequest?
        SplitwiseMockURLProtocol.handler = { req in
            capturedRequest = req
            let json = """
            {"expenses":[{"id":999,"description":"Coffee","cost":"30.00"}]}
            """.data(using: .utf8)!
            return (json, HTTPURLResponse(url: req.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        KeychainService.shared.set("sw-token", for: KeychainService.Key.splitwiseAccessToken)
        let service = SplitwiseAPIService(session: makeSplitwiseMockSession())
        let expenseId = try await service.createExpense(
            description: "Coffee",
            totalAmount: 30.0,
            currency: "USD",
            currentUserId: "1",
            friends: [(id: "2", name: "Bob"), (id: "3", name: "Carol")]
        )
        XCTAssertEqual(expenseId, "999")
        let body = String(data: capturedRequest!.httpBody!, encoding: .utf8)!
        XCTAssertTrue(body.contains("users__0__user_id=1"))
        XCTAssertTrue(body.contains("users__1__user_id=2"))
    }

    func test_getFriends_throws401_whenTokenExpired() async throws {
        SplitwiseMockURLProtocol.handler = { req in
            let resp = HTTPURLResponse(url: req.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!
            return (Data(), resp)
        }
        do {
            _ = try await service.getFriends()
            XCTFail("Expected SplitwiseError.unauthorized")
        } catch SplitwiseError.unauthorized {
            // expected
        }
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — `SplitwiseAPIService` not found.

- [ ] **Step 3: Implement SplitwiseAPIService**

`SplitEasy/Services/SplitwiseAPIService.swift`:
```swift
import Foundation

enum SplitwiseError: Error {
    case unauthorized
    case httpError(Int)
    case noToken
}

protocol SplitwiseAPIServiceProtocol {
    func getFriends() async throws -> [SplitwiseFriend]
    func createExpense(description: String, totalAmount: Double, currency: String, currentUserId: String, friends: [(id: String, name: String)]) async throws -> String
}

final class SplitwiseAPIService: SplitwiseAPIServiceProtocol {
    static let shared = SplitwiseAPIService()

    private let base = "https://secure.splitwise.com/api/v3.0"
    private let keychain = KeychainService.shared
    private let session: URLSession

    init(session: URLSession = .shared) {
        self.session = session
    }

    private func makeRequest(_ path: String, method: String = "GET", body: Data? = nil,
                              contentType: String = "application/json") throws -> URLRequest {
        guard let token = keychain.get(KeychainService.Key.splitwiseAccessToken) else {
            throw SplitwiseError.noToken
        }
        var req = URLRequest(url: URL(string: base + path)!)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(contentType, forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        return req
    }

    private func perform<T: Decodable>(_ req: URLRequest) async throws -> T {
        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw SplitwiseError.unauthorized }
        guard (200..<300).contains(status) else { throw SplitwiseError.httpError(status) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    func getFriends() async throws -> [SplitwiseFriend] {
        struct Response: Decodable { let friends: [SplitwiseFriend] }
        let response: Response = try await perform(try makeRequest("/get_friends"))
        return response.friends
    }

    /// Creates an equal-split expense. Returns the Splitwise expense ID.
    func createExpense(
        description: String,
        totalAmount: Double,
        currency: String,
        currentUserId: String,
        friends: [(id: String, name: String)]
    ) async throws -> String {
        let totalPeople = Double(friends.count + 1)
        let shareEach = String(format: "%.2f", (totalAmount / totalPeople * 100).rounded() / 100)
        let totalStr = String(format: "%.2f", totalAmount)

        // Splitwise create_expense uses form-encoded body with users__N__ convention
        var params: [String: String] = [
            "cost": totalStr,
            "description": description,
            "currency_code": currency,
            "split_equally": "false",
            "users__0__user_id": currentUserId,
            "users__0__paid_share": totalStr,
            "users__0__owed_share": shareEach,
        ]
        for (i, friend) in friends.enumerated() {
            let idx = i + 1
            params["users__\(idx)__user_id"] = friend.id
            params["users__\(idx)__paid_share"] = "0.00"
            params["users__\(idx)__owed_share"] = shareEach
        }
        let bodyStr = params.map { key, value in
            let encodedValue = value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? value
            return "\(key)=\(encodedValue)"
        }.joined(separator: "&")
        var req = try makeRequest("/create_expense", method: "POST",
                                   body: bodyStr.data(using: .utf8),
                                   contentType: "application/x-www-form-urlencoded")

        struct Response: Decodable {
            let expenses: [Expense]
            struct Expense: Decodable { let id: Int }
        }
        let response: Response = try await perform(req)
        guard let expense = response.expenses.first else { throw SplitwiseError.httpError(422) }
        return String(expense.id)
    }
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Expected: Both `SplitwiseAPIServiceTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/SplitwiseAPIService.swift \
        SplitEasyTests/Services/SplitwiseAPIServiceTests.swift
git commit -m "feat(ios): add SplitwiseAPIService with getFriends + createExpense and tests"
```

---

### Task 12: Rewrite PlaidService

**Files:**
- Modify: `SplitEasy/Services/PlaidService.swift`
- Create: `SplitEasyTests/Services/PlaidServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/PlaidServiceTests.swift`:
```swift
// SplitEasyTests/Services/PlaidServiceTests.swift
import XCTest
@testable import SplitEasy

final class WorkerServiceStub: WorkerServiceProtocol {
    private let handler: (String) throws -> Data
    init(_ handler: @escaping (String) throws -> Data) {
        self.handler = handler
    }
    func post<Body: Encodable, Response: Decodable>(path: String, body: Body) async throws -> Response {
        let data = try handler(path)
        return try JSONDecoder().decode(Response.self, from: data)
    }
}

@MainActor
final class PlaidServiceTests: XCTestCase {
    override func setUp() async throws {
        try await super.setUp()
        KeychainService.shared.set("test-plaid-token", for: KeychainService.Key.plaidAccessToken)
    }

    override func tearDown() async throws {
        KeychainService.shared.delete(key: KeychainService.Key.plaidAccessToken)
        try await super.tearDown()
    }

    func test_fetchTransactions_paginatesUntilHasMoreFalse() async throws {
        var callCount = 0
        let service = PlaidService(worker: WorkerServiceStub { _ in
            callCount += 1
            if callCount == 1 {
                return """
                {"added":[{"transaction_id":"tx1","merchant_name":"Store","amount":10.0,"iso_currency_code":"USD","date":"2026-03-01"}],
                 "modified":[],"removed":[],"next_cursor":"cursor2","has_more":true}
                """.data(using: .utf8)!
            } else {
                return """
                {"added":[{"transaction_id":"tx2","merchant_name":"Store","amount":20.0,"iso_currency_code":"USD","date":"2026-03-02"}],
                 "modified":[],"removed":[],"next_cursor":"cursor3","has_more":false}
                """.data(using: .utf8)!
            }
        })
        let result = try await service.fetchTransactions()
        XCTAssertEqual(callCount, 2)
        XCTAssertEqual(result.added.map(\.transactionId).sorted(), ["tx1", "tx2"])
    }

    func test_fetchTransactions_throwsOnItemLoginRequired() async throws {
        let service = PlaidService(worker: WorkerServiceStub { _ in
            throw WorkerError.plaidItemLoginRequired
        })
        do {
            _ = try await service.fetchTransactions()
            XCTFail("Expected throw")
        } catch WorkerError.plaidItemLoginRequired { }
        catch { XCTFail("Wrong error: \(error)") }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/PlaidServiceTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: FAIL — PlaidService not yet rewritten

- [ ] **Step 3: Implement PlaidService**

`SplitEasy/Services/PlaidService.swift`:
```swift
import Foundation
import LinkKit

// Mirrors Plaid transaction object fields we use.
// iso_currency_code is the correct Plaid field name for currency.
struct PlaidTransaction: Decodable {
    let transactionId: String
    let merchantName: String?
    let amount: Double
    let isoCurrencyCode: String?  // May be nil for unofficial currencies
    let date: String

    enum CodingKeys: String, CodingKey {
        case transactionId = "transaction_id"
        case merchantName = "merchant_name"
        case amount
        case isoCurrencyCode = "iso_currency_code"
        case date
    }

    var currency: String { isoCurrencyCode ?? "USD" }
}

struct PlaidSyncResult {
    let added: [PlaidTransaction]
    let modified: [PlaidTransaction]
    let removedIds: [String]
}

@MainActor
final class PlaidService: ObservableObject {
    static let shared = PlaidService()

    @Published var handler: Handler?

    private let worker: WorkerServiceProtocol
    private let keychain = KeychainService.shared

    init(worker: WorkerServiceProtocol = WorkerService.shared) {
        self.worker = worker
    }

    // onSuccess receives: publicToken, institutionName (from Link SDK metadata), institutionId
    func createHandler(linkToken: String,
                       onSuccess: @escaping (String, String?, String?) -> Void) {
        var config = LinkTokenConfiguration(token: linkToken) { success in
            let name = success.metadata.institution?.name
            let instId = success.metadata.institution?.id
            onSuccess(success.publicToken, name, instId)
        }
        config.onExit = { exit in
            if let e = exit.error {
                print("Plaid Link error: \(e.displayMessage ?? e.errorCode.description)")
            }
        }
        switch Plaid.create(config) {
        case .success(let h): self.handler = h
        case .failure(let e): print("Failed to create Plaid handler: \(e)")
        }
    }

    func fetchLinkToken() async throws -> String {
        struct Resp: Decodable { let link_token: String }
        struct Empty: Encodable {}
        let r: Resp = try await worker.post(path: "/plaid/link-token", body: Empty())
        return r.link_token
    }

    func exchangeToken(_ publicToken: String) async throws {
        struct Body: Encodable { let public_token: String }
        struct Resp: Decodable { let access_token: String }
        let r: Resp = try await worker.post(path: "/plaid/exchange",
                                             body: Body(public_token: publicToken))
        keychain.set(r.access_token, for: KeychainService.Key.plaidAccessToken)
        UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.lastPlaidCursor)
    }

    /// Fetches all pending transaction pages from Plaid (handles has_more pagination).
    func fetchTransactions() async throws -> PlaidSyncResult {
        guard let accessToken = keychain.get(KeychainService.Key.plaidAccessToken) else {
            throw WorkerError.noPlaidAccessToken
        }
        struct Body: Encodable { let access_token: String; let cursor: String? }
        struct Resp: Decodable {
            let added: [PlaidTransaction]
            let modified: [PlaidTransaction]
            let removed: [RemovedTx]
            let next_cursor: String?
            let has_more: Bool
            struct RemovedTx: Decodable { let transaction_id: String }
        }

        var allAdded: [PlaidTransaction] = []
        var allModified: [PlaidTransaction] = []
        var allRemovedIds: [String] = []
        var cursor = UserDefaults.standard.string(forKey: UserDefaultsKeys.lastPlaidCursor)

        repeat {
            let response: Resp = try await worker.post(
                path: "/plaid/transactions",
                body: Body(access_token: accessToken, cursor: cursor)
            )
            allAdded.append(contentsOf: response.added)
            allModified.append(contentsOf: response.modified)
            allRemovedIds.append(contentsOf: response.removed.map(\.transaction_id))
            cursor = response.next_cursor
            if let next = cursor {
                UserDefaults.standard.set(next, forKey: UserDefaultsKeys.lastPlaidCursor)
            }
            if !response.has_more { break }
        } while true

        return PlaidSyncResult(added: allAdded, modified: allModified, removedIds: allRemovedIds)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/PlaidServiceTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/PlaidService.swift SplitEasyTests/Services/PlaidServiceTests.swift
git commit -m "refactor(ios): PlaidService uses WorkerService + Keychain; handles has_more pagination"
```

---

### Task 13: Rewrite SplitwiseAuthService

**Files:**
- Modify: `SplitEasy/Services/SplitwiseAuthService.swift`
- Create: `SplitEasyTests/Services/SplitwiseAuthServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/SplitwiseAuthServiceTests.swift`:
```swift
// SplitEasyTests/Services/SplitwiseAuthServiceTests.swift
import XCTest
@testable import SplitEasy

@MainActor
final class SplitwiseAuthServiceTests: XCTestCase {
    var keychain: KeychainService!

    override func setUp() {
        super.setUp()
        keychain = KeychainService.shared
        keychain.delete(key: KeychainService.Key.splitwiseAccessToken)
        UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.splitwiseUserId)
        UserDefaults.standard.removeObject(forKey: UserDefaultsKeys.splitwiseDisplayName)
    }

    func test_isAuthenticated_falseWhenNoToken() {
        let service = SplitwiseAuthService(keychain: keychain)
        XCTAssertFalse(service.isAuthenticated)
    }

    func test_isAuthenticated_trueAfterTokenSet() {
        keychain.set("tok", for: KeychainService.Key.splitwiseAccessToken)
        let service = SplitwiseAuthService(keychain: keychain)
        XCTAssertTrue(service.isAuthenticated)
    }

    func test_signOut_clearsTokenAndUserDefaults() {
        keychain.set("tok", for: KeychainService.Key.splitwiseAccessToken)
        UserDefaults.standard.set("bala", forKey: UserDefaultsKeys.splitwiseDisplayName)
        let service = SplitwiseAuthService(keychain: keychain)
        service.signOut()
        XCTAssertFalse(service.isAuthenticated)
        XCTAssertNil(UserDefaults.standard.string(forKey: UserDefaultsKeys.splitwiseDisplayName))
    }

    func test_buildOAuthURL_containsRequiredParams() throws {
        let service = SplitwiseAuthService(keychain: keychain)
        let url = try XCTUnwrap(service.buildOAuthURL())
        let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let params = components?.queryItems?.reduce(into: [String: String]()) { $0[$1.name] = $1.value } ?? [:]
        XCTAssertNotNil(params["client_id"])
        XCTAssertNotNil(params["redirect_uri"])
        XCTAssertEqual(params["response_type"], "code")
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/SplitwiseAuthServiceTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: FAIL

- [ ] **Step 3: Rewrite SplitwiseAuthService**

`SplitEasy/Services/SplitwiseAuthService.swift`:
```swift
import Foundation

struct AppUser {
    let userId: String
    let displayName: String
    let avatarURL: String?
}

@MainActor
final class SplitwiseAuthService: ObservableObject {
    static let shared = SplitwiseAuthService()

    private let clientId = Bundle.main.infoDictionary?["SPLITWISE_CLIENT_ID"] as? String ?? ""
    private let redirectURI = Bundle.main.infoDictionary?["SPLITWISE_REDIRECT_URI"] as? String ?? ""
    private let keychain: KeychainService
    private let worker: WorkerServiceProtocol

    init(keychain: KeychainService = .shared, worker: WorkerServiceProtocol = WorkerService.shared) {
        self.keychain = keychain
        self.worker = worker
    }

    func buildOAuthURL() -> URL {
        var components = URLComponents(string: "https://secure.splitwise.com/oauth/authorize")!
        components.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
        ]
        return components.url!
    }

    /// Exchanges OAuth code via CF Worker (keeps client_secret off device).
    func exchangeCode(_ code: String) async throws -> AppUser {
        struct Body: Encodable { let code: String; let redirect_uri: String }
        struct Response: Decodable {
            let access_token: String
            let user_id: String
            let display_name: String
            let avatar_url: String?
        }
        let response: Response = try await worker.post(
            path: "/splitwise/exchange",
            body: Body(code: code, redirect_uri: redirectURI)
        )
        keychain.set(response.access_token, for: KeychainService.Key.splitwiseAccessToken)
        let defaults = UserDefaults.standard
        defaults.set(response.user_id, forKey: UserDefaultsKeys.splitwiseUserId)
        defaults.set(response.display_name, forKey: UserDefaultsKeys.splitwiseDisplayName)
        defaults.set(response.avatar_url, forKey: UserDefaultsKeys.splitwiseAvatarURL)
        return AppUser(displayName: response.display_name, avatarURL: response.avatar_url)
    }

    var isAuthenticated: Bool {
        keychain.get(KeychainService.Key.splitwiseAccessToken) != nil
    }

    func signOut() {
        keychain.delete(key: KeychainService.Key.splitwiseAccessToken)
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: UserDefaultsKeys.splitwiseUserId)
        defaults.removeObject(forKey: UserDefaultsKeys.splitwiseDisplayName)
        defaults.removeObject(forKey: UserDefaultsKeys.splitwiseAvatarURL)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/SplitwiseAuthServiceTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/SplitwiseAuthService.swift SplitEasyTests/Services/SplitwiseAuthServiceTests.swift
git commit -m "refactor(ios): SplitwiseAuthService exchanges code via CF Worker; stores token in Keychain"
```

---

### Task 14: Rewrite FriendService

**Files:**
- Modify: `SplitEasy/Services/FriendService.swift`
- Create: `SplitEasyTests/Services/FriendServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/FriendServiceTests.swift`:
```swift
// SplitEasyTests/Services/FriendServiceTests.swift
import XCTest
@testable import SplitEasy

final class SplitwiseAPIServiceStub: SplitwiseAPIServiceProtocol {
    private let getFriendsHandler: () throws -> [SplitwiseFriend]
    init(_ handler: @escaping () throws -> [SplitwiseFriend]) {
        self.getFriendsHandler = handler
    }
    func getFriends() async throws -> [SplitwiseFriend] { try getFriendsHandler() }
    func createExpense(description: String, totalAmount: Double, currency: String, currentUserId: String, friends: [(id: String, name: String)]) async throws -> String { "stub-expense-id" }
}

@MainActor
final class FriendServiceTests: XCTestCase {
    func test_getFriends_returnsCachedResultOnSecondCall() async throws {
        var callCount = 0
        let api = SplitwiseAPIServiceStub {
            callCount += 1
            return [SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)]
        }
        let service = FriendService(api: api)
        _ = try await service.getFriends()
        _ = try await service.getFriends()
        XCTAssertEqual(callCount, 1)
    }

    func test_clearCache_forcesRefetch() async throws {
        var callCount = 0
        let api = SplitwiseAPIServiceStub {
            callCount += 1
            return []
        }
        let service = FriendService(api: api)
        _ = try await service.getFriends()
        service.clearCache()
        _ = try await service.getFriends()
        XCTAssertEqual(callCount, 2)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/FriendServiceTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: FAIL

- [ ] **Step 3: Rewrite FriendService**

`SplitEasy/Services/FriendService.swift`:
```swift
import Foundation

@MainActor
final class FriendService {
    static let shared = FriendService()
    private var cachedFriends: [SplitwiseFriend]?
    private let api: SplitwiseAPIServiceProtocol

    init(api: SplitwiseAPIServiceProtocol = SplitwiseAPIService.shared) {
        self.api = api
    }

    func getFriends(refresh: Bool = false) async throws -> [SplitwiseFriend] {
        if !refresh, let cached = cachedFriends { return cached }
        let friends = try await api.getFriends()
        cachedFriends = friends
        return friends
    }

    func clearCache() { cachedFriends = nil }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `xcodebuild test -scheme SplitEasy -only-testing:SplitEasyTests/FriendServiceTests -destination 'platform=iOS Simulator,name=iPhone 16'`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/FriendService.swift SplitEasyTests/Services/FriendServiceTests.swift
git commit -m "refactor(ios): FriendService calls Splitwise directly via SplitwiseAPIService"
```

---

### Task 15: Rewrite SplitService + tests

**Files:**
- Modify: `SplitEasy/Services/SplitService.swift`
- Create: `SplitEasyTests/Services/SplitServiceTests.swift`

- [ ] **Step 1: Write failing tests**

`SplitEasyTests/Services/SplitServiceTests.swift`:
```swift
import XCTest
import GRDB
@testable import SplitEasy

final class SplitServiceTests: XCTestCase {
    var db: DatabaseQueue!
    var service: SplitService!

    override func setUp() throws {
        db = try DatabaseQueue()
        try DatabaseService.runMigrations(on: db)
        service = SplitService(db: db)
        KeychainService.shared.set("test_sw_token", for: KeychainService.Key.splitwiseAccessToken)
        UserDefaults.standard.set("999", forKey: UserDefaultsKeys.splitwiseUserId)
    }

    func test_idempotency_returnsCachedResultIfAlreadySplit() async throws {
        // Pre-populate a split decision (simulates app-kill-after-Splitwise-success scenario)
        try db.write { d in
            try Transaction(id: "tx1", merchantName: "A", amount: 20, currency: "USD",
                            date: "2026-03-22", status: .split, createdAt: "2026-03-22T00:00:00Z").insert(d)
            try SplitDecision(id: "d1", transactionId: "tx1", splitwiseExpenseId: "sw-existing",
                              friendIds: "[\"1\"]", friendNames: "[\"Alice\"]",
                              amountEach: 10, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        // Should return existing result without calling Splitwise API
        let tx = Transaction(id: "tx1", merchantName: "A", amount: 20, currency: "USD",
                             date: "2026-03-22", status: .split, createdAt: "2026-03-22T00:00:00Z")
        let friends = [SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)]
        let result = try await service.createExpense(transaction: tx, friends: friends,
                                                      splitwiseAPICall: { _, _, _, _, _ in
            XCTFail("Should not call Splitwise API when decision already exists")
            return "should-not-reach"
        })
        XCTAssertEqual(result.splitwiseExpenseId, "sw-existing")
    }

    func test_successfulSplit_writesDecisionAndUpdatesStatus() async throws {
        try db.write { d in
            try Transaction(id: "tx1", merchantName: "A", amount: 30, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        let tx = Transaction(id: "tx1", merchantName: "A", amount: 30, currency: "USD",
                             date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z")
        let friends = [SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil),
                       SplitwiseFriend(id: "2", name: "Bob", avatarURL: nil)]
        let result = try await service.createExpense(transaction: tx, friends: friends,
                                                      splitwiseAPICall: { _, _, _, _, _ in "sw-new-123" })
        XCTAssertEqual(result.splitwiseExpenseId, "sw-new-123")
        XCTAssertEqual(result.amountEach, 10.0, accuracy: 0.001)  // $30 / 3 people
        // Verify transaction status updated
        let updated = try db.read { d in try Transaction.fetchOne(d, key: "tx1") }
        XCTAssertEqual(updated?.status, .split)
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — `SplitService` has wrong interface.

- [ ] **Step 3: Implement SplitService**

`SplitEasy/Services/SplitService.swift`:
```swift
import Foundation
import GRDB

struct SplitResult {
    let splitwiseExpenseId: String
    let amountEach: Double
}

final class SplitService {
    typealias SplitwiseAPICall = (String, Double, String, String, [(id: String, name: String)]) async throws -> String

    private let api = SplitwiseAPIService.shared
    private let db: DatabaseQueue

    init(db: DatabaseQueue = DatabaseService.shared.queue) {
        self.db = db
    }

    func createExpense(
        transaction: Transaction,
        friends: [SplitwiseFriend],
        splitwiseAPICall: SplitwiseAPICall? = nil
    ) async throws -> SplitResult {
        // Idempotency: return cached result if already split
        if let existing = try db.read({ d in
            try SplitDecision
                .filter(SplitDecision.Columns.transactionId == transaction.id)
                .fetchOne(d)
        }) {
            try db.write { d in
                try Transaction
                    .filter(Transaction.Columns.id == transaction.id)
                    .updateAll(d, Transaction.Columns.status.set(to: Transaction.Status.split.rawValue))
            }
            return SplitResult(splitwiseExpenseId: existing.splitwiseExpenseId,
                               amountEach: existing.amountEach)
        }

        let currentUserId = UserDefaults.standard.string(forKey: UserDefaultsKeys.splitwiseUserId) ?? ""
        let friendPairs = friends.map { (id: $0.id, name: $0.name) }
        let callAPI = splitwiseAPICall ?? { desc, amount, currency, userId, fs in
            try await self.api.createExpense(description: desc, totalAmount: amount,
                                              currency: currency, currentUserId: userId, friends: fs)
        }
        let expenseId = try await callAPI(
            transaction.merchantName ?? "Shared expense",
            transaction.amount,
            transaction.currency,
            currentUserId,
            friendPairs
        )

        let totalPeople = Double(friends.count + 1)
        let amountEach = (transaction.amount / totalPeople * 100).rounded() / 100
        let now = ISO8601DateFormatter().string(from: Date())

        let friendIdsJSON = (try? String(data: JSONEncoder().encode(friends.map(\.id)), encoding: .utf8)) ?? "[]"
        let friendNamesJSON = (try? String(data: JSONEncoder().encode(friends.map(\.name)), encoding: .utf8)) ?? "[]"

        let decision = SplitDecision(
            id: UUID().uuidString,
            transactionId: transaction.id,
            splitwiseExpenseId: expenseId,
            friendIds: friendIdsJSON,
            friendNames: friendNamesJSON,
            amountEach: amountEach,
            createdAt: now
        )

        // Retry loop for SQLite write (up to 3 attempts)
        var lastError: Error?
        for _ in 0..<3 {
            do {
                try db.write { d in
                    try decision.insert(d)
                    try Transaction
                        .filter(Transaction.Columns.id == transaction.id)
                        .updateAll(d, Transaction.Columns.status.set(to: Transaction.Status.split.rawValue))
                }
                return SplitResult(splitwiseExpenseId: expenseId, amountEach: amountEach)
            } catch { lastError = error }
        }
        throw lastError!
    }
}
```

- [ ] **Step 4: Run tests to confirm PASS**

Expected: Both `SplitServiceTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/SplitService.swift SplitEasyTests/Services/SplitServiceTests.swift
git commit -m "refactor(ios): SplitService uses SplitwiseAPIService + GRDB with idempotency, retry, and tests"
```

---

### Task 16: Rewrite TransactionService + tests

**Files:**
- Modify: `SplitEasy/Services/TransactionService.swift`
- Modify: `SplitEasyTests/Services/TransactionServiceTests.swift`

- [ ] **Step 1: Update tests**

`SplitEasyTests/Services/TransactionServiceTests.swift`:
```swift
import XCTest
import GRDB
@testable import SplitEasy

final class TransactionServiceTests: XCTestCase {
    var db: DatabaseQueue!
    var service: TransactionService!

    override func setUp() throws {
        db = try DatabaseQueue()
        try DatabaseService.runMigrations(on: db)
        service = TransactionService(db: db)
    }

    func test_fetchNew_returnsOnlyNewTransactions() async throws {
        try db.write { d in
            try Transaction(id: "t1", merchantName: "A", amount: 10, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
            try Transaction(id: "t2", merchantName: "B", amount: 20, currency: "USD",
                            date: "2026-03-22", status: .split, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        let results = try await service.fetchNew()
        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results[0].id, "t1")
    }

    func test_skip_updatesStatusToSkipped() async throws {
        try db.write { d in
            try Transaction(id: "t1", merchantName: "A", amount: 10, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        try await service.skip(id: "t1")
        let tx = try db.read { d in try Transaction.fetchOne(d, key: "t1") }
        XCTAssertEqual(tx?.status, .skipped)
    }

    func test_upsertFromPlaid_doesNotDowngradeStatus() async throws {
        try db.write { d in
            try Transaction(id: "t1", merchantName: "A", amount: 10, currency: "USD",
                            date: "2026-03-22", status: .split, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        let incoming = PlaidTransaction(transactionId: "t1", merchantName: "A",
                                        amount: 10, isoCurrencyCode: "USD", date: "2026-03-22")
        try await service.upsertFromPlaid([incoming])
        let tx = try db.read { d in try Transaction.fetchOne(d, key: "t1") }
        XCTAssertEqual(tx?.status, .split)  // not downgraded to .new
    }

    func test_deleteIds_removesTransactions() async throws {
        try db.write { d in
            try Transaction(id: "t1", merchantName: "A", amount: 10, currency: "USD",
                            date: "2026-03-22", status: .new, createdAt: "2026-03-22T00:00:00Z").insert(d)
        }
        try await service.deleteIds(["t1"])
        XCTAssertEqual(try db.read { d in try Transaction.fetchCount(d) }, 0)
    }
}
```

- [ ] **Step 2: Run to confirm FAIL**

Expected: FAIL — `TransactionService` has wrong interface.

- [ ] **Step 3: Rewrite TransactionService**

`SplitEasy/Services/TransactionService.swift`:
```swift
import Foundation
import GRDB

final class TransactionService {
    private let db: DatabaseQueue

    init(db: DatabaseQueue = DatabaseService.shared.queue) {
        self.db = db
    }

    func fetchNew() async throws -> [Transaction] {
        try db.read { d in
            try Transaction
                .filter(Transaction.Columns.status == Transaction.Status.new.rawValue)
                .order(Transaction.Columns.date.desc)
                .fetchAll(d)
        }
    }

    func fetchHistory() async throws -> [Transaction] {
        try db.read { d in
            try Transaction
                .filter([Transaction.Status.split.rawValue, Transaction.Status.skipped.rawValue]
                    .contains(Transaction.Columns.status))
                .order(Transaction.Columns.date.desc)
                .fetchAll(d)
        }
    }

    func skip(id: String) async throws {
        try db.write { d in
            try Transaction
                .filter(Transaction.Columns.id == id)
                .updateAll(d, Transaction.Columns.status.set(to: Transaction.Status.skipped.rawValue))
        }
    }

    func upsertFromPlaid(_ plaidTransactions: [PlaidTransaction]) async throws {
        let now = ISO8601DateFormatter().string(from: Date())
        try db.write { d in
            for p in plaidTransactions {
                let existing = try Transaction.fetchOne(d, key: p.transactionId)
                // Never downgrade split/skipped rows back to new
                if existing?.status == .split || existing?.status == .skipped { continue }
                let tx = Transaction(
                    id: p.transactionId,
                    merchantName: p.merchantName,
                    amount: p.amount,
                    currency: p.currency,
                    date: p.date,
                    status: .new,
                    createdAt: existing?.createdAt ?? now
                )
                try tx.upsert(d)
            }
        }
    }

    func deleteIds(_ ids: [String]) async throws {
        guard !ids.isEmpty else { return }
        try db.write { d in
            try Transaction.filter(ids.contains(Transaction.Columns.id)).deleteAll(d)
        }
    }
}
```

- [ ] **Step 4: Run all tests to confirm PASS**

Expected: All 4 `TransactionServiceTests` PASS.

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/TransactionService.swift SplitEasyTests/Services/TransactionServiceTests.swift
git commit -m "refactor(ios): TransactionService reads/writes GRDB SQLite; upsert preserves split/skipped status"
```

---

## Phase 4 — ViewModels & App

### Task 17: Rewrite OnboardingViewModel

**Files:**
- Modify: `SplitEasy/ViewModels/OnboardingViewModel.swift`

- [ ] **Step 1: Rewrite OnboardingViewModel**

`SplitEasy/ViewModels/OnboardingViewModel.swift`:
```swift
import Foundation

enum OnboardingState { case loading, needsSplitwiseAuth, needsBankLink, complete }

@MainActor
final class OnboardingViewModel: ObservableObject {
    @Published var state: OnboardingState = .loading
    @Published var errorMessage: String?
    @Published var oauthURL: URL?

    private let authService = SplitwiseAuthService.shared
    private let keychain = KeychainService.shared
    private var codeContinuation: CheckedContinuation<String, Error>?

    func checkAuthState() async {
        let hasSwToken = keychain.get(KeychainService.Key.splitwiseAccessToken) != nil
        let hasPlaidToken = keychain.get(KeychainService.Key.plaidAccessToken) != nil
        if !hasSwToken { state = .needsSplitwiseAuth }
        else if !hasPlaidToken { state = .needsBankLink }
        else { state = .complete }
    }

    func signInWithSplitwise() async {
        errorMessage = nil
        do {
            let code: String = try await withCheckedThrowingContinuation { cont in
                codeContinuation = cont
                oauthURL = authService.buildOAuthURL()
            }
            oauthURL = nil
            _ = try await authService.exchangeCode(code)
            state = .needsBankLink
        } catch {
            errorMessage = "Sign in failed: \(error.localizedDescription)"
        }
    }

    func handleOAuthCode(_ code: String) {
        codeContinuation?.resume(returning: code)
        codeContinuation = nil
    }

    func handleOAuthCancel() {
        codeContinuation?.resume(throwing: URLError(.cancelled))
        codeContinuation = nil
        oauthURL = nil
    }

    func completeBankLink() { state = .complete }
}
```

- [ ] **Step 2: Commit**

```bash
git add SplitEasy/ViewModels/OnboardingViewModel.swift
git commit -m "refactor(ios): OnboardingViewModel checks Keychain, no Supabase auth"
```

---

### Task 18: Rewrite NewTransactionsViewModel + wire NetworkMonitor

**Files:**
- Modify: `SplitEasy/ViewModels/NewTransactionsViewModel.swift`

- [ ] **Step 1: Rewrite NewTransactionsViewModel**

`SplitEasy/ViewModels/NewTransactionsViewModel.swift`:
```swift
import Foundation

@MainActor
final class NewTransactionsViewModel: ObservableObject {
    @Published var transactions: [Transaction] = []
    @Published var isLoading = false
    @Published var needsReauthBanner = false
    @Published var isOffline = false
    @Published var needsSplitwiseReauth = false

    private let transactionService = TransactionService()
    private let plaidService = PlaidService.shared
    private let networkMonitor = NetworkMonitor.shared

    func load() async {
        isLoading = true
        defer { isLoading = false }
        isOffline = !networkMonitor.isConnected
        // Show local data immediately
        if let local = try? await transactionService.fetchNew() {
            transactions = local
        }
        // Then sync from Plaid if online
        if networkMonitor.isConnected {
            await syncFromPlaid()
        }
    }

    func refresh() async { await load() }

    private func syncFromPlaid() async {
        do {
            let result = try await plaidService.fetchTransactions()
            try await transactionService.upsertFromPlaid(result.added + result.modified)
            try await transactionService.deleteIds(result.removedIds)
            transactions = (try? await transactionService.fetchNew()) ?? transactions
            UserDefaults.standard.set(false, forKey: UserDefaultsKeys.plaidNeedsReauth)
            needsReauthBanner = false
        } catch WorkerError.plaidItemLoginRequired {
            UserDefaults.standard.set(true, forKey: UserDefaultsKeys.plaidNeedsReauth)
            needsReauthBanner = true
        } catch SplitwiseError.unauthorized {
            // Clear stale token, signal re-auth needed
            KeychainService.shared.delete(key: KeychainService.Key.splitwiseAccessToken)
            needsSplitwiseReauth = true
        } catch {
            print("Plaid sync error: \(error)")
        }
    }

    func skip(_ transaction: Transaction) async {
        transactions.removeAll { $0.id == transaction.id }
        do {
            try await transactionService.skip(id: transaction.id)
        } catch {
            transactions.append(transaction)  // rollback optimistic update
        }
    }

    func remove(_ transaction: Transaction) {
        transactions.removeAll { $0.id == transaction.id }
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add SplitEasy/ViewModels/NewTransactionsViewModel.swift
git commit -m "refactor(ios): NewTransactionsViewModel uses SQLite + Plaid sync; removes Realtime; wires NetworkMonitor"
```

---

### Task 19: Rewrite SettingsViewModel + HistoryViewModel; update FriendPickerViewModel

**Files:**
- Modify: `SplitEasy/ViewModels/SettingsViewModel.swift`
- Modify: `SplitEasy/ViewModels/HistoryViewModel.swift`
- Modify: `SplitEasy/ViewModels/FriendPickerViewModel.swift`
- Modify: `SplitEasyTests/ViewModels/FriendPickerViewModelTests.swift`

- [ ] **Step 1: Rewrite SettingsViewModel**

`SplitEasy/ViewModels/SettingsViewModel.swift`:
```swift
import Foundation

@MainActor
final class SettingsViewModel: ObservableObject {
    @Published var institutionName: String?
    @Published var displayName: String?
    @Published var needsReauth: Bool = false

    private let keychain = KeychainService.shared
    private let authService = SplitwiseAuthService.shared

    func load() {
        institutionName = UserDefaults.standard.string(forKey: UserDefaultsKeys.plaidInstitutionName)
        displayName = UserDefaults.standard.string(forKey: UserDefaultsKeys.splitwiseDisplayName)
        needsReauth = UserDefaults.standard.bool(forKey: UserDefaultsKeys.plaidNeedsReauth)
    }

    func signOut() {
        authService.signOut()
        disconnectBank()
    }

    func disconnectBank() {
        keychain.delete(key: KeychainService.Key.plaidAccessToken)
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: UserDefaultsKeys.plaidInstitutionName)
        defaults.removeObject(forKey: UserDefaultsKeys.plaidInstitutionLogoURL)
        defaults.removeObject(forKey: UserDefaultsKeys.plaidNeedsReauth)
        defaults.removeObject(forKey: UserDefaultsKeys.lastPlaidCursor)
        Task {
            try? DatabaseService.shared.queue.write { db in try Transaction.deleteAll(db) }
        }
        institutionName = nil
        needsReauth = false
    }
}
```

- [ ] **Step 2: Rewrite HistoryViewModel**

`SplitEasy/ViewModels/HistoryViewModel.swift`:
```swift
import Foundation
import GRDB

@MainActor
final class HistoryViewModel: ObservableObject {
    @Published var transactions: [Transaction] = []
    @Published var decisions: [String: SplitDecision] = [:]  // keyed by transaction_id
    @Published var isLoading = false

    private let service = TransactionService()

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let history = try await service.fetchHistory()
            transactions = history
            let db = DatabaseService.shared.queue
            let ids = history.map(\.id)
            let allDecisions = try db.read { d in
                try SplitDecision
                    .filter(ids.contains(SplitDecision.Columns.transactionId))
                    .fetchAll(d)
            }
            decisions = Dictionary(uniqueKeysWithValues: allDecisions.map { ($0.transactionId, $0) })
        } catch {
            print("History load error: \(error)")
        }
    }
}
```

- [ ] **Step 3: Update FriendPickerViewModel — use Double, add offline guard**

In `SplitEasy/ViewModels/FriendPickerViewModel.swift`, update:

```swift
// Change amountPerPerson to return Double (aligns with Transaction.amount: Double)
var amountPerPerson: Double {
    guard !selectedFriends.isEmpty else { return 0 }
    let totalPeople = Double(selectedFriends.count + 1)
    return (transaction.amount / totalPeople * 100).rounded() / 100
}

// Change successAmountEach to Double?
@Published var successAmountEach: Double?
@Published var needsSplitwiseReauth = false

// Update submit() to use new SplitService signature
func submit() async throws -> SplitResult {
    isSubmitting = true
    defer { isSubmitting = false }
    do {
        let result = try await splitService.createExpense(
            transaction: transaction,
            friends: Array(selectedFriends)
        )
        successAmountEach = result.amountEach
        return result
    } catch SplitwiseError.unauthorized {
        // Clear stale token, signal re-auth needed
        KeychainService.shared.delete(key: KeychainService.Key.splitwiseAccessToken)
        self.errorMessage = "Splitwise session expired. Please sign in again."
        self.needsSplitwiseReauth = true
        throw SplitwiseError.unauthorized
    }
}

// In loadFriends(), also handle 401:
func loadFriends() async {
    do {
        friends = try await friendService.getFriends()
    } catch SplitwiseError.unauthorized {
        // Clear stale token, signal re-auth needed
        KeychainService.shared.delete(key: KeychainService.Key.splitwiseAccessToken)
        self.errorMessage = "Splitwise session expired. Please sign in again."
        self.needsSplitwiseReauth = true
    } catch {
        self.errorMessage = error.localizedDescription
    }
}
```

- [ ] **Step 4: Update FriendPickerViewModelTests**

`SplitEasyTests/ViewModels/FriendPickerViewModelTests.swift`:
```swift
import XCTest
@testable import SplitEasy

@MainActor
final class FriendPickerViewModelTests: XCTestCase {
    func test_equalSplitAmount_withTwoFriendsSelected() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: 30.0))
        vm.toggleSelection(SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil))
        vm.toggleSelection(SplitwiseFriend(id: "2", name: "Bob", avatarURL: nil))
        // 3 people: $30 / 3 = $10
        XCTAssertEqual(vm.amountPerPerson, 10.0, accuracy: 0.001)
    }

    func test_toggleSelection_addsAndRemovesFriend() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: 20.0))
        let friend = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        vm.toggleSelection(friend)
        XCTAssertTrue(vm.selectedFriends.contains(friend))
        vm.toggleSelection(friend)
        XCTAssertFalse(vm.selectedFriends.contains(friend))
    }

    func test_canSubmit_requiresAtLeastOneFriend() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: 20.0))
        XCTAssertFalse(vm.canSubmit)
        vm.toggleSelection(SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil))
        XCTAssertTrue(vm.canSubmit)
    }

    private func makeTransaction(amount: Double) -> Transaction {
        Transaction(id: "tx-test-001", merchantName: "Test Merchant",
                    amount: amount, currency: "USD", date: "2026-03-22",
                    status: .new, createdAt: "2026-03-22T10:00:00Z")
    }
}
```

- [ ] **Step 5: Run all iOS tests to confirm PASS**

`Cmd+U` — expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add SplitEasy/ViewModels/SettingsViewModel.swift \
        SplitEasy/ViewModels/HistoryViewModel.swift \
        SplitEasy/ViewModels/FriendPickerViewModel.swift \
        SplitEasyTests/ViewModels/FriendPickerViewModelTests.swift
git commit -m "refactor(ios): SettingsViewModel + HistoryViewModel use SQLite/Keychain; FriendPickerViewModel uses Double"
```

---

### Task 20: Update SplitEasyApp + BankConnectView

**Files:**
- Modify: `SplitEasy/SplitEasyApp.swift`
- Modify: `SplitEasy/Views/Onboarding/BankConnectView.swift`

- [ ] **Step 1: Update SplitEasyApp.swift**

`SplitEasy/SplitEasyApp.swift`:
```swift
import SwiftUI

@main
struct SplitEasyApp: App {
    @StateObject private var onboardingVM = OnboardingViewModel()

    init() {
        // Seed Worker API key from build config into Keychain on first run
        if let key = Bundle.main.infoDictionary?["WORKER_API_KEY"] as? String, !key.isEmpty {
            KeychainService.shared.set(key, for: KeychainService.Key.workerAPIKey)
        }
        // Prune old transactions in background on every launch
        DatabaseService.shared.pruneInBackground()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                switch onboardingVM.state {
                case .loading:
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                case .needsSplitwiseAuth:
                    WelcomeView(vm: onboardingVM)
                case .needsBankLink:
                    BankConnectView(vm: onboardingVM)
                case .complete:
                    MainTabView()
                }
            }
            .task { await onboardingVM.checkAuthState() }
        }
    }
}
```

- [ ] **Step 2: Update BankConnectView — use new PlaidService API**

Replace the `connectBank()` function in `BankConnectView.swift`:

```swift
private func connectBank() async {
    isConnecting = true
    defer { isConnecting = false }
    do {
        let linkToken = try await PlaidService.shared.fetchLinkToken()
        await MainActor.run {
            PlaidService.shared.createHandler(linkToken: linkToken) { publicToken, institutionName, _ in
                Task { @MainActor in
                    do {
                        try await PlaidService.shared.exchangeToken(publicToken)
                        if let name = institutionName {
                            UserDefaults.standard.set(name, forKey: UserDefaultsKeys.plaidInstitutionName)
                        }
                        vm.completeBankLink()
                    } catch {
                        toast = Toast(message: "Bank connection failed. Try again.", isError: true)
                    }
                }
            }
            showingLink = true
        }
    } catch {
        toast = Toast(message: "Could not start bank connection. Try again.", isError: true)
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add SplitEasy/SplitEasyApp.swift SplitEasy/Views/Onboarding/BankConnectView.swift
git commit -m "feat(ios): seed Keychain from build config; add background prune on launch"
```

---

## Phase 5 — Cleanup & Config

### Task 21: Update Info.plist + build settings

**Files:**
- Modify: `SplitEasy/Info.plist`
- Modify: Xcode build settings

- [ ] **Step 1: Update Info.plist — replace Supabase keys**

In `SplitEasy/Info.plist`, replace:
```xml
<key>SUPABASE_URL</key>
<string>$(SUPABASE_URL)</string>
<key>SUPABASE_ANON_KEY</key>
<string>$(SUPABASE_ANON_KEY)</string>
```

With:
```xml
<key>WORKER_URL</key>
<string>$(WORKER_URL)</string>
<key>WORKER_API_KEY</key>
<string>$(WORKER_API_KEY)</string>
```

- [ ] **Step 2: Add build settings in Xcode**

Select project → SplitEasy target → Build Settings → User-Defined:
- Remove: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
- Add: `WORKER_URL` = `https://spliteasy-worker.<account>.workers.dev`
- Add: `WORKER_API_KEY` = `<generated key>`

`SPLITWISE_CLIENT_ID` and `SPLITWISE_REDIRECT_URI` remain unchanged.

- [ ] **Step 3: Commit**

```bash
git add SplitEasy/Info.plist SplitEasy.xcodeproj/
git commit -m "chore(ios): replace Supabase build config with Worker URL + API key"
```

---

### Task 22: Delete Supabase files; fix all remaining compile errors

**Files:**
- Delete: `SplitEasy/Services/SupabaseService.swift`
- Delete: `SplitEasy/Models/PlaidItem.swift`
- Delete: `supabase/` directory

- [ ] **Step 1: Delete files**

```bash
rm SplitEasy/Services/SupabaseService.swift
rm SplitEasy/Models/PlaidItem.swift
rm -rf supabase/
```

Remove each from Xcode project navigator (select → Delete → Move to Trash).

- [ ] **Step 2: Build (Cmd+B) and fix remaining errors**

Expected compile errors and fixes:
- `import Supabase` — remove from any remaining files
- `RealtimeChannelV2` references — remove (Realtime is gone)
- `PlaidItem` in `SettingsView` — replace with `vm.institutionName: String?`
- Any `SupabaseService.shared` calls — should all be gone after ViewModels are updated

Update `SettingsView.swift` bank section to use `vm.institutionName` directly:
```swift
Section("Bank Account") {
    if let name = vm.institutionName {
        HStack {
            Image(systemName: "building.columns.fill").foregroundColor(.blue)
            Text(name)
        }
        if vm.needsReauth {
            Button("Reconnect Bank") { Task { await reconnectBank() } }
                .foregroundColor(.orange)
        } else {
            Label("Connected", systemImage: "checkmark.circle.fill").foregroundColor(.green)
        }
        Button("Disconnect Bank", role: .destructive) { vm.disconnectBank() }
    } else {
        Text("No bank connected").foregroundColor(.secondary)
    }
}
```

- [ ] **Step 3: Run full test suite (Cmd+U)**

Expected: All tests PASS. Zero failures.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore(ios): delete SupabaseService, PlaidItem, supabase dir; fix all remaining compile errors"
```

---

### Task 23: Final integration smoke test + compliance checklist

- [ ] **Step 1: Clean build**

`Cmd+Shift+K` then `Cmd+B`. Expected: zero errors, zero warnings from deleted Supabase code.

- [ ] **Step 2: Full test suite**

`Cmd+U`. Expected: all tests PASS.

- [ ] **Step 3: Manual smoke test on simulator**

1. Fresh install → Welcome screen (no tokens in Keychain)
2. Sign in with Splitwise → OAuth flow opens → after auth, Bank Connect screen
3. Connect Plaid Sandbox bank → tokens stored in Keychain
4. Main tab → pull-to-refresh → transactions appear from Plaid
5. Split a transaction → friend picker → "Add to Splitwise" → toast confirmation
6. History tab → split transaction shows friend names (no API call, from SQLite)
7. Settings → institution name shows; Sign Out clears all local data; app returns to Welcome

- [ ] **Step 4: Compliance checklist**

- [ ] CF Worker request body logging disabled (Cloudflare dashboard → Workers → Logs → confirm no body capture)
- [ ] Plaid access_token never printed to Xcode console (search logs for token value)
- [ ] `NSAllowsArbitraryLoads` in Info.plist set to `false` for production build (currently `true`)
- [ ] Privacy policy updated: disclose ephemeral Plaid processing, local SQLite, 6-month retention
- [ ] Plaid production access application submitted
- [ ] Splitwise API commercial use confirmed
- [ ] `WORKER_API_KEY` and `PLAID_SECRET` not in source control (check `.gitignore`)

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete local-first migration — zero server-side financial data storage"
```
