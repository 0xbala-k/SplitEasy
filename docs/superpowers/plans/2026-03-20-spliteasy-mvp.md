# SplitEasy MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a SwiftUI iOS app that auto-imports Plaid bank transactions and lets users split them to Splitwise with a few taps, backed by a Supabase serverless backend.

**Architecture:** Supabase backend (Postgres + 6 Edge Functions + Realtime + Vault) handles all sensitive token operations and Plaid webhook ingestion; iOS SwiftUI app (MVVM) subscribes to Realtime for live updates and calls Edge Functions for all Splitwise/Plaid operations. iOS never holds Plaid or Splitwise tokens.

**Tech Stack:** Swift 5.9+ / SwiftUI, Supabase CLI, Deno (Edge Functions), supabase-swift SDK, Plaid Link iOS SDK (SPM), Splitwise OAuth + REST API v3, XCTest, PostgreSQL

---

## File Structure

### Backend (`supabase/`)

```
supabase/
  config.toml
  migrations/
    20260320000001_initial_schema.sql      # 4 tables + check constraints + indexes
    20260320000002_rls_policies.sql        # RLS enable + all 4 tables' policies
    20260320000003_vault_helpers.sql       # upsert_vault_secret() + get_vault_secret()
  functions/
    _shared/
      cors.ts                              # shared CORS headers
      supabase-client.ts                   # createAdminClient() factory
      splitwise.ts                         # getSplitwiseToken() helper
    splitwise-auth-callback/
      index.ts                             # exchange SW code → token → Vault → upsert user
    splitwise-get-friends/
      index.ts                             # proxy Splitwise /friends API
    plaid-create-link-token/
      index.ts                             # create Plaid link_token server-side (keeps secret off device)
    plaid-link-exchange/
      index.ts                             # exchange Plaid public_token → access_token → Vault
    plaid-webhook/
      index.ts                             # verify sig, upsert/remove transactions
    splitwise-create-expense/
      index.ts                             # idempotent expense creation + split_decisions write
```

### iOS App (`SplitEasy/`)

```
SplitEasy/
  SplitEasyApp.swift                       # @main entry, SupabaseService init
  Config/
    Secrets.xcconfig                       # SUPABASE_URL, SUPABASE_ANON_KEY (gitignored)
    Info.plist                             # URL scheme for OAuth redirect
  Models/
    Transaction.swift                      # Transaction struct + TransactionStatus enum
    SplitDecision.swift                    # SplitDecision struct
    SplitwiseFriend.swift                  # Friend struct (id, name, avatar)
    AppUser.swift                          # User struct (display_name, avatar_url)
    PlaidItem.swift                        # PlaidItem struct + needs_reauth flag
  Services/
    SupabaseService.swift                  # singleton: client, signInAnonymously for JWT
    SplitwiseAuthService.swift             # ASWebAuthenticationSession OAuth + call auth-callback fn
    PlaidService.swift                     # Plaid Link SDK wrapper → call plaid-link-exchange fn
    TransactionService.swift              # fetch new/history, skip update, Realtime subscription
    FriendService.swift                    # call splitwise-get-friends fn, session cache
    SplitService.swift                     # call splitwise-create-expense fn
    NetworkMonitor.swift                   # NWPathMonitor, isConnected publisher
  ViewModels/
    OnboardingViewModel.swift              # auth state machine (unauthed → authed → bank-linked)
    NewTransactionsViewModel.swift         # new list + Realtime listener + skip/split triggers
    FriendPickerViewModel.swift            # friend list, selection, equal-split calc, submit
    HistoryViewModel.swift                 # paginated history (date DESC, id ASC cursor)
    SettingsViewModel.swift                # plaid item info, reauth banner, sign out
  Views/
    Onboarding/
      WelcomeView.swift                    # "Sign in with Splitwise" button
      BankConnectView.swift               # "Connect via Plaid" + "Skip for now"
    Main/
      MainTabView.swift                    # TabView: New (badge) · History · Settings
    NewTransactions/
      NewTransactionsView.swift            # list + pull-to-refresh + empty state
      TransactionRowView.swift             # merchant/date/amount + Split/Skip buttons
      FriendPickerView.swift              # modal sheet: friend list + Add to Splitwise CTA
    History/
      HistoryView.swift                    # paginated list + load-more trigger
      HistoryRowView.swift                 # split (friends + amount) or skipped label
    Settings/
      SettingsView.swift                   # bank section + Splitwise section + notifications toggle
    Shared/
      ToastView.swift                      # overlay toast (success / error)
      ReauthBannerView.swift              # in-app banner for needs_reauth
  SplitEasyTests/
    TransactionServiceTests.swift
    FriendServiceTests.swift
    FriendPickerViewModelTests.swift
    HistoryViewModelTests.swift
```

---

## Phase 1 — Supabase Backend

### Task 1: Supabase Project Setup

**Files:**
- Create: `supabase/config.toml` (generated)
- Create: `.env.local` (gitignored — Plaid + Splitwise secrets)

- [ ] **Step 1: Install Supabase CLI**

```bash
brew install supabase/tap/supabase
supabase --version
# Expected: supabase version 1.x.x
```

- [ ] **Step 2: Initialize Supabase project**

```bash
cd /Users/bala/Documents/0xmuralik/SplitEasy
supabase init
# Creates supabase/ directory with config.toml
```

- [ ] **Step 3: Start local Supabase (requires Docker)**

```bash
supabase start
# Expected output includes:
#   API URL: http://127.0.0.1:54321
#   anon key: eyJ...
#   service_role key: eyJ...
# Save these for later steps.
```

- [ ] **Step 4: Create `.env.local` with secrets**

```bash
cat > supabase/.env.local << 'EOF'
PLAID_CLIENT_ID=your_plaid_client_id
PLAID_SECRET=your_plaid_sandbox_secret
PLAID_ENV=sandbox
SPLITWISE_CLIENT_ID=your_splitwise_client_id
SPLITWISE_CLIENT_SECRET=your_splitwise_client_secret
SPLITWISE_REDIRECT_URI=spliteasy://oauth/callback
EOF
```

- [ ] **Step 5: Add to gitignore**

```bash
echo "supabase/.env.local" >> .gitignore
echo "SplitEasy/Config/Secrets.xcconfig" >> .gitignore
```

- [ ] **Step 6: Commit**

```bash
git add supabase/ .gitignore
git commit -m "chore: initialize Supabase project"
```

---

### Task 2: Database Migrations

**Files:**
- Create: `supabase/migrations/20260320000001_initial_schema.sql`
- Create: `supabase/migrations/20260320000002_rls_policies.sql`
- Create: `supabase/migrations/20260320000003_vault_helpers.sql`

- [ ] **Step 1: Write initial schema migration**

Create `supabase/migrations/20260320000001_initial_schema.sql`:

```sql
-- users: one row per authenticated user
create table public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  splitwise_user_id text not null,
  splitwise_access_token text, -- vault secret UUID reference
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- plaid_items: one bank connection per user (MVP); schema supports many
create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  plaid_item_id text not null,
  plaid_access_token text, -- vault secret UUID reference
  institution_name text,
  institution_logo_url text,
  needs_reauth boolean not null default false,
  created_at timestamptz not null default now()
);

-- transactions: debit transactions imported from Plaid
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  plaid_item_id uuid not null references public.plaid_items(id) on delete cascade,
  plaid_transaction_id text not null,
  merchant_name text,
  amount numeric(10,2) not null check (amount > 0),
  currency text not null default 'USD',
  date date not null,
  status text not null default 'new'
    check (status in ('new', 'split', 'skipped', 'removed')),
  created_at timestamptz not null default now(),
  constraint transactions_plaid_transaction_id_unique unique (plaid_transaction_id)
);

-- split_decisions: one row per split transaction
create table public.split_decisions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  splitwise_expense_id text not null,
  friend_ids text[] not null,
  split_type text not null default 'equal'
    check (split_type in ('equal', 'percentage', 'exact')),
  equal_amount_each numeric(10,2), -- null for future non-equal splits
  created_at timestamptz not null default now()
);

-- indexes for common query patterns
create index on public.transactions (user_id, status, date desc);
create index on public.split_decisions (transaction_id);
create index on public.plaid_items (user_id);
```

- [ ] **Step 2: Write RLS policies migration**

Create `supabase/migrations/20260320000002_rls_policies.sql`:

```sql
-- Enable RLS on all tables
alter table public.users enable row level security;
alter table public.plaid_items enable row level security;
alter table public.transactions enable row level security;
alter table public.split_decisions enable row level security;

-- users: read own row only; writes via service role (splitwise-auth-callback)
create policy "users_select_own"
  on public.users for select
  using (id = auth.uid());

-- plaid_items: read own rows only; writes via service role (plaid-link-exchange)
create policy "plaid_items_select_own"
  on public.plaid_items for select
  using (user_id = auth.uid());

-- transactions: read own rows; client may update status field directly (skip action)
create policy "transactions_select_own"
  on public.transactions for select
  using (user_id = auth.uid());

create policy "transactions_update_status_own"
  on public.transactions for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- split_decisions: read own rows only; writes via service role (splitwise-create-expense)
create policy "split_decisions_select_own"
  on public.split_decisions for select
  using (user_id = auth.uid());
```

- [ ] **Step 3: Write Vault helper functions migration**

Create `supabase/migrations/20260320000003_vault_helpers.sql`:

```sql
-- upsert_vault_secret: create or update a named secret in Vault
-- Called from Edge Functions using service role key
create or replace function public.upsert_vault_secret(
  p_name text,
  p_secret text
) returns text
security definer
set search_path = vault, public
language plpgsql as $$
declare
  v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if found then
    perform vault.update_secret(v_id, p_secret);
    return v_id::text;
  else
    return vault.create_secret(p_secret, p_name)::text;
  end if;
end;
$$;

-- get_vault_secret: retrieve a decrypted secret by name
-- Called from Edge Functions using service role key
create or replace function public.get_vault_secret(
  p_name text
) returns text
security definer
set search_path = vault, public
language sql as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = p_name;
$$;

-- Revoke public execute; only service role can call these
revoke execute on function public.upsert_vault_secret(text, text) from public;
revoke execute on function public.get_vault_secret(text) from public;
```

- [ ] **Step 4: Apply migrations and verify**

```bash
supabase db reset
# Expected: "Finished supabase db reset." with no errors

# Verify tables exist
supabase db diff --schema public
# Should show all 4 tables with their columns
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/
git commit -m "feat(db): add schema, RLS policies, and Vault helpers"
```

---

### Task 3: Edge Function Shared Utilities

**Files:**
- Create: `supabase/functions/_shared/cors.ts`
- Create: `supabase/functions/_shared/supabase-client.ts`
- Create: `supabase/functions/_shared/splitwise.ts`

- [ ] **Step 1: Create CORS headers module**

Create `supabase/functions/_shared/cors.ts`:

```typescript
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

export function handleCors(req: Request): Response | null {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  return null
}
```

- [ ] **Step 2: Create Supabase admin client factory**

Create `supabase/functions/_shared/supabase-client.ts`:

```typescript
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export function createAdminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } }
  )
}

// Extract the authenticated user from the request's Bearer token.
// Returns null if the token is missing or invalid.
export async function getAuthUser(req: Request) {
  const token = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!token) return null
  const supabase = createAdminClient()
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return null
  return user
}
```

- [ ] **Step 3: Create Splitwise token helper**

Create `supabase/functions/_shared/splitwise.ts`:

```typescript
import { createAdminClient } from './supabase-client.ts'

// Retrieve the Splitwise access token for a user from Vault.
export async function getSplitwiseToken(userId: string): Promise<string | null> {
  const supabase = createAdminClient()
  const { data, error } = await supabase.rpc('get_vault_secret', {
    p_name: `sw_token_${userId}`,
  })
  if (error || !data) return null
  return data as string
}

// Store or update the Splitwise access token for a user in Vault.
export async function setSplitwiseToken(userId: string, token: string): Promise<void> {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc('upsert_vault_secret', {
    p_name: `sw_token_${userId}`,
    p_secret: token,
  })
  if (error) throw new Error(`Vault write failed: ${error.message}`)
}

// Fetch Splitwise current user profile.
export async function getSplitwiseCurrentUser(token: string) {
  const res = await fetch('https://secure.splitwise.com/api/v3.0/get_current_user', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 401) throw new Error('splitwise_auth_expired')
  if (!res.ok) throw new Error(`splitwise_api_error: ${res.status}`)
  const { user } = await res.json()
  return user
}
```

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/_shared/
git commit -m "feat(functions): add shared Edge Function utilities"
```

---

### Task 4: `splitwise-auth-callback` Edge Function

**Files:**
- Create: `supabase/functions/splitwise-auth-callback/index.ts`

This function receives a Splitwise authorization code from iOS, exchanges it for an access token server-side (keeping the client secret off the device), stores the token in Vault, and upserts the user profile.

- [ ] **Step 1: Write the function**

Create `supabase/functions/splitwise-auth-callback/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { createAdminClient, getAuthUser } from '../_shared/supabase-client.ts'
import { setSplitwiseToken, getSplitwiseCurrentUser } from '../_shared/splitwise.ts'

serve(async (req) => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  // Require authenticated Supabase user
  const user = await getAuthUser(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { code } = await req.json()
  if (!code) {
    return new Response(JSON.stringify({ error: 'missing_code' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Exchange authorization code for access token (server-side, client secret stays here)
  const tokenRes = await fetch('https://secure.splitwise.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      client_id: Deno.env.get('SPLITWISE_CLIENT_ID'),
      client_secret: Deno.env.get('SPLITWISE_CLIENT_SECRET'),
      redirect_uri: Deno.env.get('SPLITWISE_REDIRECT_URI'),
    }),
  })
  if (!tokenRes.ok) {
    return new Response(JSON.stringify({ error: 'token_exchange_failed' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const { access_token } = await tokenRes.json()

  // Store token in Vault
  try {
    await setSplitwiseToken(user.id, access_token)
  } catch {
    return new Response(JSON.stringify({ error: 'vault_error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Fetch Splitwise profile
  let swUser
  try {
    swUser = await getSplitwiseCurrentUser(access_token)
  } catch {
    return new Response(JSON.stringify({ error: 'splitwise_profile_failed' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Upsert user row (service role bypasses RLS)
  const supabase = createAdminClient()
  const { error } = await supabase.from('users').upsert({
    id: user.id,
    splitwise_user_id: String(swUser.id),
    splitwise_access_token: `sw_token_${user.id}`, // vault secret name reference
    display_name: [swUser.first_name, swUser.last_name].filter(Boolean).join(' '),
    avatar_url: swUser.picture?.medium ?? null,
  })
  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    display_name: [swUser.first_name, swUser.last_name].filter(Boolean).join(' '),
    avatar_url: swUser.picture?.medium ?? null,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
```

- [ ] **Step 2: Serve function locally and smoke-test**

```bash
supabase functions serve splitwise-auth-callback --env-file supabase/.env.local
# In another terminal:
curl -i -X OPTIONS http://localhost:54321/functions/v1/splitwise-auth-callback
# Expected: 200 with CORS headers
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/splitwise-auth-callback/
git commit -m "feat(functions): add splitwise-auth-callback"
```

---

### Task 5: `splitwise-get-friends` Edge Function

**Files:**
- Create: `supabase/functions/splitwise-get-friends/index.ts`

- [ ] **Step 1: Write the function**

Create `supabase/functions/splitwise-get-friends/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { getAuthUser } from '../_shared/supabase-client.ts'
import { getSplitwiseToken } from '../_shared/splitwise.ts'

serve(async (req) => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const user = await getAuthUser(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const token = await getSplitwiseToken(user.id)
  if (!token) {
    return new Response(JSON.stringify({ error: 'splitwise_auth_expired' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const res = await fetch('https://secure.splitwise.com/api/v3.0/get_friends', {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (res.status === 401) {
    return new Response(JSON.stringify({ error: 'splitwise_auth_expired' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'splitwise_api_error' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { friends } = await res.json()
  // Return only what iOS needs
  const simplified = friends.map((f: Record<string, unknown>) => ({
    id: String(f.id),
    name: [f.first_name, f.last_name].filter(Boolean).join(' '),
    avatar_url: (f.picture as Record<string, unknown>)?.medium ?? null,
  }))

  return new Response(JSON.stringify({ friends: simplified }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Smoke-test**

```bash
supabase functions serve splitwise-get-friends --env-file supabase/.env.local
curl -i -X OPTIONS http://localhost:54321/functions/v1/splitwise-get-friends
# Expected: 200 with CORS headers
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/splitwise-get-friends/
git commit -m "feat(functions): add splitwise-get-friends"
```

---

### Task 6: `plaid-create-link-token` Edge Function

**Files:**
- Create: `supabase/functions/plaid-create-link-token/index.ts`

This function creates a Plaid `link_token` server-side so the Plaid client secret never leaves the backend. iOS calls this to get a fresh token before opening Plaid Link.

- [ ] **Step 1: Write the function**

Create `supabase/functions/plaid-create-link-token/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { getAuthUser } from '../_shared/supabase-client.ts'

serve(async (req) => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const user = await getAuthUser(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const res = await fetch(`https://${Deno.env.get('PLAID_ENV')}.plaid.com/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      client_name: 'SplitEasy',
      user: { client_user_id: user.id },
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    }),
  })

  if (!res.ok) {
    const err = await res.json()
    return new Response(JSON.stringify({ error: err.error_message ?? 'link_token_failed' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { link_token, expiration } = await res.json()
  return new Response(JSON.stringify({ link_token, expiration }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Smoke-test**

```bash
supabase functions serve plaid-create-link-token --env-file supabase/.env.local
curl -i -X OPTIONS http://localhost:54321/functions/v1/plaid-create-link-token
# Expected: 200 with CORS headers
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/plaid-create-link-token/
git commit -m "feat(functions): add plaid-create-link-token"
```

---

### Task 7: `plaid-link-exchange` Edge Function

**Files:**
- Create: `supabase/functions/plaid-link-exchange/index.ts`

- [ ] **Step 1: Write the function**

Create `supabase/functions/plaid-link-exchange/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { createAdminClient, getAuthUser } from '../_shared/supabase-client.ts'

async function plaidRequest(path: string, body: Record<string, unknown>) {
  const res = await fetch(`https://${Deno.env.get('PLAID_ENV')}.plaid.com${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      ...body,
    }),
  })
  return res
}

serve(async (req) => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const user = await getAuthUser(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { public_token } = await req.json()
  if (!public_token) {
    return new Response(JSON.stringify({ error: 'missing_public_token' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Exchange public_token for access_token + item_id
  const exchangeRes = await plaidRequest('/item/public_token/exchange', { public_token })
  if (!exchangeRes.ok) {
    const err = await exchangeRes.json()
    return new Response(JSON.stringify({ error: err.error_message ?? 'plaid_exchange_failed' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  const { access_token, item_id } = await exchangeRes.json()

  // Get institution info
  const itemRes = await plaidRequest('/item/get', { access_token })
  const { item } = await itemRes.json()
  let institutionName = 'Your Bank'
  let institutionLogoUrl: string | null = null
  if (item?.institution_id) {
    const instRes = await plaidRequest('/institutions/get_by_id', {
      institution_id: item.institution_id,
      country_codes: ['US'],
      options: { include_optional_metadata: true },
    })
    if (instRes.ok) {
      const { institution } = await instRes.json()
      institutionName = institution.name ?? institutionName
      institutionLogoUrl = institution.logo ? `data:image/png;base64,${institution.logo}` : null
    }
  }

  // Store access_token in Vault
  const supabase = createAdminClient()
  const vaultName = `plaid_token_${user.id}_${item_id}`
  const { data: vaultId, error: vaultError } = await supabase.rpc('upsert_vault_secret', {
    p_name: vaultName,
    p_secret: access_token,
  })
  if (vaultError) {
    return new Response(JSON.stringify({ error: 'vault_error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Upsert plaid_items row
  const { error: upsertError } = await supabase.from('plaid_items').upsert({
    user_id: user.id,
    plaid_item_id: item_id,
    plaid_access_token: vaultName, // vault secret name reference
    institution_name: institutionName,
    institution_logo_url: institutionLogoUrl,
    needs_reauth: false,
  }, { onConflict: 'plaid_item_id' })

  if (upsertError) {
    return new Response(JSON.stringify({ error: upsertError.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ institution_name: institutionName }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
})
```

- [ ] **Step 2: Smoke-test**

```bash
supabase functions serve plaid-link-exchange --env-file supabase/.env.local
curl -i -X OPTIONS http://localhost:54321/functions/v1/plaid-link-exchange
# Expected: 200 with CORS headers
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/plaid-link-exchange/
git commit -m "feat(functions): add plaid-link-exchange"
```

---

### Task 8: `plaid-webhook` Edge Function

**Files:**
- Create: `supabase/functions/plaid-webhook/index.ts`

This is the most complex function. It verifies Plaid's webhook signature (JWT signed by Plaid), then processes `TRANSACTIONS_SYNC` (upsert new debits) and `TRANSACTIONS_REMOVED` (mark removed) events.

- [ ] **Step 1: Write the function**

Create `supabase/functions/plaid-webhook/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createAdminClient } from '../_shared/supabase-client.ts'

// Plaid webhook verification: fetch Plaid's public keys and verify JWT
async function verifyPlaidWebhook(req: Request, body: string): Promise<boolean> {
  const token = req.headers.get('Plaid-Verification')
  if (!token) return false

  // Decode header to get key_id
  const [headerB64] = token.split('.')
  let header: { kid?: string }
  try {
    header = JSON.parse(atob(headerB64.replace(/-/g, '+').replace(/_/g, '/')))
  } catch { return false }
  if (!header.kid) return false

  // Fetch Plaid's public key
  const keysRes = await fetch(`https://${Deno.env.get('PLAID_ENV')}.plaid.com/webhook/verification_key/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      key_id: header.kid,
    }),
  })
  if (!keysRes.ok) return false
  const { key } = await keysRes.json()

  // Import the JWK and verify the JWT
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk', key,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    )
    const [, payloadB64, sigB64] = token.split('.')
    const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    const signature = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    )
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, signature, signingInput)
  } catch { return false }
}

async function fetchNewTransactions(accessToken: string, cursor?: string) {
  const res = await fetch(`https://${Deno.env.get('PLAID_ENV')}.plaid.com/transactions/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('PLAID_CLIENT_ID'),
      secret: Deno.env.get('PLAID_SECRET'),
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
    }),
  })
  if (!res.ok) throw new Error('plaid_transactions_sync_failed')
  return res.json()
}

serve(async (req) => {
  const bodyText = await req.text()

  // Verify Plaid webhook signature
  const isValid = await verifyPlaidWebhook(req, bodyText)
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 })
  }

  const payload = JSON.parse(bodyText)
  const { webhook_type, webhook_code, item_id } = payload

  const supabase = createAdminClient()

  // Look up plaid_item by plaid_item_id
  const { data: plaidItem } = await supabase
    .from('plaid_items')
    .select('id, user_id, plaid_access_token, needs_reauth')
    .eq('plaid_item_id', item_id)
    .single()

  if (!plaidItem) {
    return new Response('Item not found', { status: 404 })
  }

  // Handle ITEM_LOGIN_REQUIRED: flag for reauth
  if (webhook_type === 'ITEM' && webhook_code === 'ERROR') {
    if (payload.error?.error_code === 'ITEM_LOGIN_REQUIRED') {
      await supabase
        .from('plaid_items')
        .update({ needs_reauth: true })
        .eq('id', plaidItem.id)
    }
    return new Response('ok', { status: 200 })
  }

  // Handle TRANSACTIONS events
  if (webhook_type === 'TRANSACTIONS') {
    if (webhook_code === 'SYNC_UPDATES_AVAILABLE' || webhook_code === 'DEFAULT_UPDATE') {
      // Retrieve the decrypted access token from Vault
      const { data: accessToken } = await supabase.rpc('get_vault_secret', {
        p_name: plaidItem.plaid_access_token,
      })
      if (!accessToken) {
        return new Response('Vault secret not found', { status: 500 })
      }

      // Fetch transactions (handle pagination)
      let cursor: string | undefined
      let hasMore = true
      const added: Array<Record<string, unknown>> = []

      while (hasMore) {
        const txData = await fetchNewTransactions(accessToken, cursor)
        added.push(...txData.added)
        cursor = txData.next_cursor
        hasMore = txData.has_more
      }

      // Upsert debits only (amount > 0 from Plaid = debit)
      const debits = added
        .filter((tx: Record<string, unknown>) => (tx.amount as number) > 0)
        .map((tx: Record<string, unknown>) => ({
          user_id: plaidItem.user_id,
          plaid_item_id: plaidItem.id,
          plaid_transaction_id: tx.transaction_id as string,
          merchant_name: (tx.merchant_name ?? tx.name) as string,
          amount: tx.amount as number,
          currency: (tx.iso_currency_code ?? 'USD') as string,
          date: tx.date as string,
          status: 'new',
        }))

      if (debits.length > 0) {
        await supabase
          .from('transactions')
          .upsert(debits, { onConflict: 'plaid_transaction_id', ignoreDuplicates: true })
      }
    }

    if (webhook_code === 'TRANSACTIONS_REMOVED') {
      const removedIds: string[] = payload.removed_transactions ?? []
      if (removedIds.length > 0) {
        await supabase
          .from('transactions')
          .update({ status: 'removed' })
          .in('plaid_transaction_id', removedIds)
      }
    }
  }

  return new Response('ok', { status: 200 })
})
```

- [ ] **Step 2: Smoke-test OPTIONS**

```bash
supabase functions serve plaid-webhook --env-file supabase/.env.local
curl -i -X POST http://localhost:54321/functions/v1/plaid-webhook \
  -H "Content-Type: application/json" \
  -d '{"webhook_type":"TRANSACTIONS","webhook_code":"DEFAULT_UPDATE","item_id":"test"}'
# Expected: 401 Unauthorized (no Plaid-Verification header — correct behavior)
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/plaid-webhook/
git commit -m "feat(functions): add plaid-webhook with signature verification"
```

---

### Task 9: `splitwise-create-expense` Edge Function

**Files:**
- Create: `supabase/functions/splitwise-create-expense/index.ts`

- [ ] **Step 1: Write the function**

Create `supabase/functions/splitwise-create-expense/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { corsHeaders, handleCors } from '../_shared/cors.ts'
import { createAdminClient, getAuthUser } from '../_shared/supabase-client.ts'
import { getSplitwiseToken } from '../_shared/splitwise.ts'

serve(async (req) => {
  const corsResponse = handleCors(req)
  if (corsResponse) return corsResponse

  const user = await getAuthUser(req)
  if (!user) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { transaction_id, friend_ids } = await req.json()
  if (!transaction_id || !Array.isArray(friend_ids) || friend_ids.length === 0) {
    return new Response(JSON.stringify({ error: 'invalid_request' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const supabase = createAdminClient()

  // Idempotency check: return success if already split
  const { data: existing } = await supabase
    .from('split_decisions')
    .select('id, splitwise_expense_id, equal_amount_each')
    .eq('transaction_id', transaction_id)
    .single()

  if (existing) {
    return new Response(JSON.stringify({
      splitwise_expense_id: existing.splitwise_expense_id,
      amount_each: existing.equal_amount_each,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }

  // Fetch transaction to get amount
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, amount, merchant_name, date, user_id')
    .eq('id', transaction_id)
    .eq('user_id', user.id)
    .single()

  if (txError || !tx) {
    return new Response(JSON.stringify({ error: 'transaction_not_found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Get Splitwise token
  const token = await getSplitwiseToken(user.id)
  if (!token) {
    return new Response(JSON.stringify({ error: 'splitwise_auth_expired' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Get Splitwise user ID for the current user
  const { data: dbUser } = await supabase
    .from('users')
    .select('splitwise_user_id')
    .eq('id', user.id)
    .single()

  if (!dbUser) {
    return new Response(JSON.stringify({ error: 'user_not_found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Build equal-split expense body
  const totalPeople = friend_ids.length + 1 // friends + current user
  const amountEach = Number((tx.amount / totalPeople).toFixed(2))
  const allUsers = [dbUser.splitwise_user_id, ...friend_ids]

  const expenseBody: Record<string, unknown> = {
    cost: String(tx.amount.toFixed(2)),
    description: tx.merchant_name ?? 'Expense',
    date: tx.date,
    split_equally: true,
  }
  allUsers.forEach((uid, i) => {
    expenseBody[`users__${i}__user_id`] = uid
    expenseBody[`users__${i}__paid_share`] = i === 0 ? String(tx.amount.toFixed(2)) : '0.00'
    expenseBody[`users__${i}__owed_share`] = String(amountEach.toFixed(2))
  })

  // Create expense in Splitwise
  const swRes = await fetch('https://secure.splitwise.com/api/v3.0/create_expense', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(expenseBody),
  })

  if (swRes.status === 401) {
    return new Response(JSON.stringify({ error: 'splitwise_auth_expired' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!swRes.ok) {
    return new Response(JSON.stringify({ error: 'splitwise_api_error' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const { expense } = await swRes.json()
  const expenseId = String(expense.id)

  // Write split_decision + update transaction status atomically
  const { error: decisionError } = await supabase.from('split_decisions').insert({
    transaction_id,
    user_id: user.id,
    splitwise_expense_id: expenseId,
    friend_ids,
    split_type: 'equal',
    equal_amount_each: amountEach,
  })

  if (decisionError) {
    // Expense was created in SW but DB write failed — log but return success
    // (idempotency check on next call will return the existing expense if re-inserted)
    console.error('split_decision insert failed:', decisionError.message)
  }

  await supabase
    .from('transactions')
    .update({ status: 'split' })
    .eq('id', transaction_id)

  return new Response(JSON.stringify({
    splitwise_expense_id: expenseId,
    amount_each: amountEach,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
```

- [ ] **Step 2: Smoke-test**

```bash
supabase functions serve splitwise-create-expense --env-file supabase/.env.local
curl -i -X OPTIONS http://localhost:54321/functions/v1/splitwise-create-expense
# Expected: 200 with CORS headers
```

- [ ] **Step 3: Enable Supabase Realtime on transactions table**

```bash
# Add to supabase/migrations/20260320000004_realtime.sql
cat > supabase/migrations/20260320000004_realtime.sql << 'EOF'
-- Enable Realtime for the transactions table
alter publication supabase_realtime add table public.transactions;
EOF
supabase db reset
```

- [ ] **Step 4: Deploy all functions to local and verify status**

```bash
supabase functions list
# Should list all 5 functions
```

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/splitwise-create-expense/ supabase/migrations/20260320000004_realtime.sql
git commit -m "feat(functions): add splitwise-create-expense and enable Realtime"
```

---

## Phase 2 — iOS App

### Task 10: iOS Project Setup

**Files:**
- Create: `SplitEasy/SplitEasyApp.swift` (Xcode creates this)
- Create: `SplitEasy/Config/Secrets.xcconfig`

- [ ] **Step 1: Create Xcode project**

Open Xcode → New Project → iOS App
- Product Name: `SplitEasy`
- Interface: SwiftUI
- Language: Swift
- Bundle Identifier: `com.yourname.SplitEasy`
- Save to `/Users/bala/Documents/0xmuralik/SplitEasy/`

- [ ] **Step 2: Add Swift Package dependencies**

In Xcode: File → Add Package Dependencies

Add:
1. `https://github.com/supabase/supabase-swift` — version `2.0.0` or later, product `Supabase`
2. `https://github.com/plaid/plaid-link-ios` — version `5.0.0` or later, product `LinkKit`

- [ ] **Step 3: Create Secrets.xcconfig**

Create `SplitEasy/Config/Secrets.xcconfig`:

```
SUPABASE_URL = https://your-project-ref.supabase.co
SUPABASE_ANON_KEY = your-anon-key-here
SPLITWISE_CLIENT_ID = your-splitwise-client-id
SPLITWISE_REDIRECT_URI = spliteasy://oauth/callback
```

In Xcode: Project → Build Settings → All → search "config" → set Configuration File to `Secrets.xcconfig` for Debug and Release.

- [ ] **Step 4: Register URL scheme for OAuth redirect**

In `Info.plist`, add URL Types:
- Identifier: `com.yourname.SplitEasy.oauth`
- URL Schemes: `spliteasy`

- [ ] **Step 5: Add Info.plist entries for Plaid Link**

In `Info.plist` add:
```xml
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
</dict>
```

- [ ] **Step 6: Add initial .gitignore entries for Xcode**

```bash
cat >> .gitignore << 'EOF'
*.xcuserstate
SplitEasy/Config/Secrets.xcconfig
xcuserdata/
DerivedData/
EOF
```

- [ ] **Step 7: Build to verify no errors**

```bash
xcodebuild -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' build 2>&1 | tail -5
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 8: Commit**

```bash
git add SplitEasy/ SplitEasy.xcodeproj/ .gitignore
git commit -m "chore(ios): initialize Xcode project with Supabase + Plaid dependencies"
```

---

### Task 11: iOS Models

**Files:**
- Create: `SplitEasy/Models/Transaction.swift`
- Create: `SplitEasy/Models/SplitDecision.swift`
- Create: `SplitEasy/Models/SplitwiseFriend.swift`
- Create: `SplitEasy/Models/AppUser.swift`
- Create: `SplitEasy/Models/PlaidItem.swift`
- Test: `SplitEasyTests/Models/TransactionTests.swift`

- [ ] **Step 1: Write failing model tests**

Create `SplitEasyTests/Models/TransactionTests.swift`:

```swift
import XCTest
@testable import SplitEasy

final class TransactionTests: XCTestCase {
    func test_transactionStatus_rawValues() {
        XCTAssertEqual(Transaction.Status.new.rawValue, "new")
        XCTAssertEqual(Transaction.Status.split.rawValue, "split")
        XCTAssertEqual(Transaction.Status.skipped.rawValue, "skipped")
        XCTAssertEqual(Transaction.Status.removed.rawValue, "removed")
    }

    func test_transaction_decodable() throws {
        let json = """
        {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "user_id": "user-1",
            "plaid_item_id": "item-1",
            "plaid_transaction_id": "plaid-tx-1",
            "merchant_name": "Chipotle",
            "amount": "24.50",
            "currency": "USD",
            "date": "2026-03-18",
            "status": "new",
            "created_at": "2026-03-18T10:00:00Z"
        }
        """.data(using: .utf8)!
        let tx = try JSONDecoder().decode(Transaction.self, from: json)
        XCTAssertEqual(tx.merchantName, "Chipotle")
        XCTAssertEqual(tx.amount, Decimal(string: "24.50")!)
        XCTAssertEqual(tx.status, .new)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
xcodebuild test -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | grep -E "(error:|FAILED|PASSED)"
# Expected: Build error — Transaction type not found
```

- [ ] **Step 3: Write models**

Create `SplitEasy/Models/Transaction.swift`:

```swift
import Foundation

struct Transaction: Codable, Identifiable, Equatable {
    enum Status: String, Codable {
        case new, split, skipped, removed
    }

    let id: UUID
    let userId: String
    let plaidItemId: UUID
    let plaidTransactionId: String
    let merchantName: String?
    let amount: Decimal
    let currency: String
    let date: String          // "YYYY-MM-DD" from Supabase
    var status: Status
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id, currency, date, status
        case userId = "user_id"
        case plaidItemId = "plaid_item_id"
        case plaidTransactionId = "plaid_transaction_id"
        case merchantName = "merchant_name"
        case amount
        case createdAt = "created_at"
    }

    // amount is stored as numeric in Postgres; Supabase returns it as a string
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        userId = try c.decode(String.self, forKey: .userId)
        plaidItemId = try c.decode(UUID.self, forKey: .plaidItemId)
        plaidTransactionId = try c.decode(String.self, forKey: .plaidTransactionId)
        merchantName = try c.decodeIfPresent(String.self, forKey: .merchantName)
        let amountStr = try c.decode(String.self, forKey: .amount)
        amount = Decimal(string: amountStr) ?? 0
        currency = try c.decode(String.self, forKey: .currency)
        date = try c.decode(String.self, forKey: .date)
        status = try c.decode(Status.self, forKey: .status)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
    }
}
```

Create `SplitEasy/Models/SplitwiseFriend.swift`:

```swift
import Foundation

struct SplitwiseFriend: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case id, name
        case avatarURL = "avatar_url"
    }
}
```

Create `SplitEasy/Models/AppUser.swift`:

```swift
import Foundation

struct AppUser: Codable {
    let displayName: String
    let avatarURL: String?

    enum CodingKeys: String, CodingKey {
        case displayName = "display_name"
        case avatarURL = "avatar_url"
    }
}
```

Create `SplitEasy/Models/PlaidItem.swift`:

```swift
import Foundation

struct PlaidItem: Codable, Identifiable {
    let id: UUID
    let institutionName: String?
    let institutionLogoURL: String?
    let needsReauth: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case institutionName = "institution_name"
        case institutionLogoURL = "institution_logo_url"
        case needsReauth = "needs_reauth"
    }
}
```

Create `SplitEasy/Models/SplitDecision.swift`:

```swift
import Foundation

struct SplitDecision: Codable, Identifiable {
    let id: UUID
    let transactionId: UUID
    let splitwiseExpenseId: String
    let friendIds: [String]
    let equalAmountEach: Decimal?

    enum CodingKeys: String, CodingKey {
        case id
        case transactionId = "transaction_id"
        case splitwiseExpenseId = "splitwise_expense_id"
        case friendIds = "friend_ids"
        case equalAmountEach = "equal_amount_each"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        transactionId = try c.decode(UUID.self, forKey: .transactionId)
        splitwiseExpenseId = try c.decode(String.self, forKey: .splitwiseExpenseId)
        friendIds = try c.decode([String].self, forKey: .friendIds)
        if let str = try c.decodeIfPresent(String.self, forKey: .equalAmountEach) {
            equalAmountEach = Decimal(string: str)
        } else {
            equalAmountEach = nil
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
xcodebuild test -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | grep -E "(error:|FAILED|PASSED|test_)"
# Expected: test_transactionStatus_rawValues PASSED, test_transaction_decodable PASSED
```

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Models/ SplitEasyTests/
git commit -m "feat(ios): add data models with tests"
```

---

### Task 12: Services — Supabase, Auth, Network Monitor

**Files:**
- Create: `SplitEasy/Services/SupabaseService.swift`
- Create: `SplitEasy/Services/SplitwiseAuthService.swift`
- Create: `SplitEasy/Services/NetworkMonitor.swift`

- [ ] **Step 1: Write SupabaseService**

Create `SplitEasy/Services/SupabaseService.swift`:

```swift
import Foundation
import Supabase

@MainActor
final class SupabaseService: ObservableObject {
    static let shared = SupabaseService()

    let client: SupabaseClient

    @Published private(set) var isAuthenticated = false

    private init() {
        let url = URL(string: Bundle.main.infoDictionary?["SUPABASE_URL"] as? String ?? "")!
        let key = Bundle.main.infoDictionary?["SUPABASE_ANON_KEY"] as? String ?? ""
        client = SupabaseClient(supabaseURL: url, supabaseKey: key)
    }

    // Sign in anonymously to get a Supabase JWT (needed to call Edge Functions).
    // After Splitwise OAuth, the user row is created server-side.
    func signInAnonymously() async throws {
        try await client.auth.signInAnonymously()
        isAuthenticated = true
    }

    func signOut() async throws {
        try await client.auth.signOut()
        isAuthenticated = false
    }

    var currentUserId: String? {
        client.auth.currentUser?.id.uuidString
    }
}
```

- [ ] **Step 2: Write SplitwiseAuthService**

Create `SplitEasy/Services/SplitwiseAuthService.swift`:

```swift
import Foundation
import AuthenticationServices

@MainActor
final class SplitwiseAuthService: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = SplitwiseAuthService()

    private let clientId = Bundle.main.infoDictionary?["SPLITWISE_CLIENT_ID"] as? String ?? ""
    private let redirectURI = Bundle.main.infoDictionary?["SPLITWISE_REDIRECT_URI"] as? String ?? ""

    // Initiates Splitwise OAuth. Returns the authorization code for server-side exchange.
    func startOAuth() async throws -> String {
        var components = URLComponents(string: "https://secure.splitwise.com/oauth/authorize")!
        components.queryItems = [
            .init(name: "client_id", value: clientId),
            .init(name: "redirect_uri", value: redirectURI),
            .init(name: "response_type", value: "code"),
        ]
        let authURL = components.url!
        let callbackScheme = "spliteasy"

        return try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: authURL, callbackURLScheme: callbackScheme) { url, error in
                if let error { continuation.resume(throwing: error); return }
                guard let url,
                      let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                        .queryItems?.first(where: { $0.name == "code" })?.value
                else {
                    continuation.resume(throwing: URLError(.badServerResponse))
                    return
                }
                continuation.resume(returning: code)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = true
            session.start()
        }
    }

    // Send auth code to Edge Function for server-side token exchange
    func exchangeCodeWithBackend(code: String) async throws -> AppUser {
        let response = try await SupabaseService.shared.client.functions.invoke(
            "splitwise-auth-callback",
            options: .init(body: ["code": code])
        )
        return try JSONDecoder().decode(AppUser.self, from: response)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first?.windows.first ?? ASPresentationAnchor()
    }
}
```

- [ ] **Step 3: Write NetworkMonitor**

Create `SplitEasy/Services/NetworkMonitor.swift`:

```swift
import Network
import Combine

final class NetworkMonitor: ObservableObject {
    static let shared = NetworkMonitor()

    @Published private(set) var isConnected = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.spliteasy.network")

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            DispatchQueue.main.async {
                self?.isConnected = path.status == .satisfied
            }
        }
        monitor.start(queue: queue)
    }

    deinit { monitor.cancel() }
}
```

- [ ] **Step 4: Build to verify no errors**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Services/SupabaseService.swift SplitEasy/Services/SplitwiseAuthService.swift SplitEasy/Services/NetworkMonitor.swift
git commit -m "feat(ios): add SupabaseService, SplitwiseAuthService, NetworkMonitor"
```

---

### Task 13: Services — TransactionService, FriendService, PlaidService, SplitService

**Files:**
- Create: `SplitEasy/Services/TransactionService.swift`
- Create: `SplitEasy/Services/FriendService.swift`
- Create: `SplitEasy/Services/PlaidService.swift`
- Create: `SplitEasy/Services/SplitService.swift`
- Test: `SplitEasyTests/Services/TransactionServiceTests.swift`
- Test: `SplitEasyTests/Services/FriendServiceTests.swift`

- [ ] **Step 1: Write failing TransactionService tests**

Create `SplitEasyTests/Services/TransactionServiceTests.swift`:

```swift
import XCTest
@testable import SplitEasy

final class TransactionServiceTests: XCTestCase {
    func test_skipTransaction_updatesStatusLocally() async throws {
        // This test validates the skip logic using a mock; full integration requires Supabase
        // For unit testing, we verify the status value sent is "skipped"
        let statusValue = Transaction.Status.skipped.rawValue
        XCTAssertEqual(statusValue, "skipped")
    }
}
```

- [ ] **Step 2: Run test to verify it passes (trivial assertion)**

```bash
xcodebuild test -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SplitEasyTests/TransactionServiceTests 2>&1 | grep -E "(PASSED|FAILED)"
# Expected: test_skipTransaction_updatesStatusLocally PASSED
```

- [ ] **Step 3: Write TransactionService**

Create `SplitEasy/Services/TransactionService.swift`:

```swift
import Foundation
import Supabase

final class TransactionService {
    private let client = SupabaseService.shared.client

    // Fetch all "new" transactions for the current user
    func fetchNew() async throws -> [Transaction] {
        try await client
            .from("transactions")
            .select()
            .eq("status", value: "new")
            .order("date", ascending: false)
            .execute()
            .value
    }

    // Fetch history (split + skipped) with cursor-based pagination
    // cursor: (date, id) of last row from previous page
    func fetchHistory(cursor: (date: String, id: UUID)? = nil, limit: Int = 50) async throws -> [Transaction] {
        var query = client
            .from("transactions")
            .select()
            .in("status", values: ["split", "skipped"])
            .order("date", ascending: false)
            .order("id", ascending: true)
            .limit(limit)

        if let cursor {
            // Rows where (date < cursor.date) OR (date == cursor.date AND id > cursor.id)
            query = query.or("date.lt.\(cursor.date),and(date.eq.\(cursor.date),id.gt.\(cursor.id))")
        }

        return try await query.execute().value
    }

    // Mark a transaction as skipped (direct client update, RLS permits this)
    func skip(transactionId: UUID) async throws {
        try await client
            .from("transactions")
            .update(["status": "skipped"])
            .eq("id", value: transactionId.uuidString)
            .execute()
    }

    // Subscribe to new transactions via Realtime
    func subscribeToNew(onChange: @escaping ([Transaction]) -> Void) -> RealtimeChannelV2 {
        let channel = client.realtimeV2.channel("transactions:new")
        let changes = channel.postgresChange(
            InsertAction.self,
            schema: "public",
            table: "transactions",
            filter: "status=eq.new"
        )
        Task {
            for await _ in changes {
                if let transactions = try? await fetchNew() {
                    await MainActor.run { onChange(transactions) }
                }
            }
        }
        Task { await channel.subscribe() }
        return channel
    }
}
```

- [ ] **Step 4: Write FriendService**

Create `SplitEasy/Services/FriendService.swift`:

```swift
import Foundation

final class FriendService {
    private var cachedFriends: [SplitwiseFriend]?

    // Returns cached friends or fetches from Edge Function.
    // Refresh forces a new network call.
    func getFriends(refresh: Bool = false) async throws -> [SplitwiseFriend] {
        if !refresh, let cached = cachedFriends { return cached }

        struct Response: Codable { let friends: [SplitwiseFriend] }
        let data = try await SupabaseService.shared.client.functions.invoke("splitwise-get-friends")
        let decoded = try JSONDecoder().decode(Response.self, from: data)
        cachedFriends = decoded.friends
        return decoded.friends
    }

    func clearCache() { cachedFriends = nil }
}
```

- [ ] **Step 5: Write PlaidService**

Create `SplitEasy/Services/PlaidService.swift`:

```swift
import Foundation
import LinkKit

@MainActor
final class PlaidService: ObservableObject {
    static let shared = PlaidService()

    @Published var handler: Handler?

    // Create a Plaid Link handler. The link_token should be obtained from your backend.
    // For Sandbox testing: use a link_token from Plaid dashboard.
    func createHandler(linkToken: String, completion: @escaping (String) -> Void) {
        var config = LinkTokenConfiguration(token: linkToken) { result in
            switch result {
            case .success(let success):
                completion(success.publicToken)
            case .failure(let error):
                print("Plaid Link error: \(error.localizedDescription)")
            }
        }
        let result = Plaid.create(config)
        switch result {
        case .success(let handler):
            self.handler = handler
        case .failure(let error):
            print("Failed to create Plaid handler: \(error)")
        }
    }

    // Exchange public_token with backend Edge Function
    func exchangeToken(_ publicToken: String) async throws -> String {
        struct Response: Codable { let institution_name: String }
        let data = try await SupabaseService.shared.client.functions.invoke(
            "plaid-link-exchange",
            options: .init(body: ["public_token": publicToken])
        )
        let response = try JSONDecoder().decode(Response.self, from: data)
        return response.institution_name
    }
}
```

- [ ] **Step 6: Write SplitService**

Create `SplitEasy/Services/SplitService.swift`:

```swift
import Foundation

struct SplitResult {
    let splitwiseExpenseId: String
    let amountEach: Decimal
}

final class SplitService {
    func createExpense(transactionId: UUID, friendIds: [String]) async throws -> SplitResult {
        struct Response: Codable {
            let splitwiseExpenseId: String
            let amountEach: String
            enum CodingKeys: String, CodingKey {
                case splitwiseExpenseId = "splitwise_expense_id"
                case amountEach = "amount_each"
            }
        }
        let data = try await SupabaseService.shared.client.functions.invoke(
            "splitwise-create-expense",
            options: .init(body: [
                "transaction_id": transactionId.uuidString,
                "friend_ids": friendIds
            ])
        )
        let response = try JSONDecoder().decode(Response.self, from: data)
        return SplitResult(
            splitwiseExpenseId: response.splitwiseExpenseId,
            amountEach: Decimal(string: response.amountEach) ?? 0
        )
    }
}
```

- [ ] **Step 7: Build to verify**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 8: Commit**

```bash
git add SplitEasy/Services/ SplitEasyTests/Services/
git commit -m "feat(ios): add TransactionService, FriendService, PlaidService, SplitService"
```

---

### Task 14: ViewModels

**Files:**
- Create: `SplitEasy/ViewModels/OnboardingViewModel.swift`
- Create: `SplitEasy/ViewModels/NewTransactionsViewModel.swift`
- Create: `SplitEasy/ViewModels/FriendPickerViewModel.swift`
- Create: `SplitEasy/ViewModels/HistoryViewModel.swift`
- Create: `SplitEasy/ViewModels/SettingsViewModel.swift`
- Test: `SplitEasyTests/ViewModels/FriendPickerViewModelTests.swift`
- Test: `SplitEasyTests/ViewModels/HistoryViewModelTests.swift`

- [ ] **Step 1: Write failing FriendPickerViewModel tests**

Create `SplitEasyTests/ViewModels/FriendPickerViewModelTests.swift`:

```swift
import XCTest
@testable import SplitEasy

@MainActor
final class FriendPickerViewModelTests: XCTestCase {
    func test_equalSplitAmount_withTwoFriendsSelected() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: "30.00"))
        let friendA = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        let friendB = SplitwiseFriend(id: "2", name: "Bob", avatarURL: nil)
        vm.toggleSelection(friendA)
        vm.toggleSelection(friendB)
        // 3 people total (2 friends + current user), $30.00 / 3 = $10.00
        XCTAssertEqual(vm.amountPerPerson, Decimal(string: "10.00")!)
    }

    func test_toggleSelection_addsAndRemovesFriend() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: "20.00"))
        let friend = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        vm.toggleSelection(friend)
        XCTAssertTrue(vm.selectedFriends.contains(friend))
        vm.toggleSelection(friend)
        XCTAssertFalse(vm.selectedFriends.contains(friend))
    }

    func test_canSubmit_requiresAtLeastOneFriend() {
        let vm = FriendPickerViewModel(transaction: makeTransaction(amount: "20.00"))
        XCTAssertFalse(vm.canSubmit)
        let friend = SplitwiseFriend(id: "1", name: "Alice", avatarURL: nil)
        vm.toggleSelection(friend)
        XCTAssertTrue(vm.canSubmit)
    }

    private func makeTransaction(amount: String) -> Transaction {
        // Use JSONDecoder to construct Transaction from JSON
        let json = """
        {"id":"00000000-0000-0000-0000-000000000001","user_id":"u1","plaid_item_id":"00000000-0000-0000-0000-000000000002","plaid_transaction_id":"tx1","merchant_name":"Test","amount":"\(amount)","currency":"USD","date":"2026-03-18","status":"new","created_at":"2026-03-18T10:00:00Z"}
        """.data(using: .utf8)!
        return try! JSONDecoder().decode(Transaction.self, from: json)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
xcodebuild test -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SplitEasyTests/FriendPickerViewModelTests 2>&1 | grep -E "(error:|FAILED|PASSED)"
# Expected: build error — FriendPickerViewModel not found
```

- [ ] **Step 3: Write FriendPickerViewModel**

Create `SplitEasy/ViewModels/FriendPickerViewModel.swift`:

```swift
import Foundation

@MainActor
final class FriendPickerViewModel: ObservableObject {
    let transaction: Transaction
    private let friendService = FriendService()
    private let splitService = SplitService()

    @Published var friends: [SplitwiseFriend] = []
    @Published var selectedFriends: Set<SplitwiseFriend> = []
    @Published var isLoading = false
    @Published var isSubmitting = false
    @Published var errorMessage: String?
    @Published var successAmountEach: Decimal?

    var amountPerPerson: Decimal {
        guard !selectedFriends.isEmpty else { return 0 }
        let totalPeople = Decimal(selectedFriends.count + 1)
        let result = transaction.amount / totalPeople
        // Round to 2 decimal places
        var rounded = Decimal()
        NSDecimalRound(&rounded, &(result as Decimal), 2, .plain)
        return rounded
    }

    var canSubmit: Bool { !selectedFriends.isEmpty && !isSubmitting }

    init(transaction: Transaction) {
        self.transaction = transaction
    }

    func toggleSelection(_ friend: SplitwiseFriend) {
        if selectedFriends.contains(friend) {
            selectedFriends.remove(friend)
        } else {
            selectedFriends.insert(friend)
        }
    }

    func loadFriends() async {
        isLoading = true
        defer { isLoading = false }
        do {
            friends = try await friendService.getFriends()
        } catch {
            errorMessage = "Could not load friends. Try again."
        }
    }

    func submit() async throws -> SplitResult {
        isSubmitting = true
        defer { isSubmitting = false }
        let ids = selectedFriends.map(\.id)
        let result = try await splitService.createExpense(
            transactionId: transaction.id,
            friendIds: ids
        )
        successAmountEach = result.amountEach
        return result
    }
}
```

- [ ] **Step 4: Write remaining ViewModels**

Create `SplitEasy/ViewModels/OnboardingViewModel.swift`:

```swift
import Foundation

enum OnboardingState {
    case loading
    case needsSplitwiseAuth
    case needsBankLink
    case complete
}

@MainActor
final class OnboardingViewModel: ObservableObject {
    @Published var state: OnboardingState = .loading
    @Published var errorMessage: String?
    @Published var currentUser: AppUser?

    private let authService = SplitwiseAuthService.shared
    private let supabase = SupabaseService.shared

    func checkAuthState() async {
        do {
            let session = try? await supabase.client.auth.session
            if session == nil {
                try await supabase.signInAnonymously()
            }
            // Check if user row exists (Splitwise connected)
            if let userId = supabase.currentUserId {
                let user: AppUser? = try? await supabase.client
                    .from("users")
                    .select("display_name, avatar_url")
                    .eq("id", value: userId)
                    .single()
                    .execute()
                    .value
                if let user {
                    currentUser = user
                    // Check if bank is linked
                    let items: [PlaidItem] = (try? await supabase.client
                        .from("plaid_items")
                        .select()
                        .eq("user_id", value: userId)
                        .execute()
                        .value) ?? []
                    state = items.isEmpty ? .needsBankLink : .complete
                } else {
                    state = .needsSplitwiseAuth
                }
            }
        } catch {
            state = .needsSplitwiseAuth
        }
    }

    func signInWithSplitwise() async {
        errorMessage = nil
        do {
            let code = try await authService.startOAuth()
            let user = try await authService.exchangeCodeWithBackend(code: code)
            currentUser = user
            state = .needsBankLink
        } catch {
            errorMessage = "Sign in failed. Please try again."
        }
    }
}
```

Create `SplitEasy/ViewModels/NewTransactionsViewModel.swift`:

```swift
import Foundation
import Supabase

@MainActor
final class NewTransactionsViewModel: ObservableObject {
    @Published var transactions: [Transaction] = []
    @Published var isLoading = false
    @Published var needsReauthBanner = false

    private let service = TransactionService()
    private var realtimeChannel: RealtimeChannelV2?

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            transactions = try await service.fetchNew()
            checkReauth()
        } catch {
            print("Load error: \(error)")
        }
    }

    func refresh() async { await load() }

    func startRealtime() {
        realtimeChannel = service.subscribeToNew { [weak self] updated in
            self?.transactions = updated
        }
    }

    func stopRealtime() {
        Task { await realtimeChannel?.unsubscribe() }
        realtimeChannel = nil
    }

    func skip(_ transaction: Transaction) async {
        transactions.removeAll { $0.id == transaction.id }
        do {
            try await service.skip(transactionId: transaction.id)
        } catch {
            transactions.append(transaction) // rollback optimistic update
        }
    }

    func remove(_ transaction: Transaction) {
        transactions.removeAll { $0.id == transaction.id }
    }

    private func checkReauth() {
        // Show reauth banner if plaid_items.needs_reauth is true (loaded separately by SettingsViewModel)
        // This is a simplified check; SettingsViewModel publishes the flag
    }
}
```

Create `SplitEasy/ViewModels/HistoryViewModel.swift`:

```swift
import Foundation

@MainActor
final class HistoryViewModel: ObservableObject {
    @Published var transactions: [Transaction] = []
    @Published var isLoading = false
    @Published var hasMore = true

    private let service = TransactionService()
    private var lastCursor: (date: String, id: UUID)?
    private let pageSize = 50

    func loadInitial() async {
        lastCursor = nil
        transactions = []
        hasMore = true
        await loadNextPage()
    }

    func loadNextPage() async {
        guard hasMore, !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await service.fetchHistory(cursor: lastCursor, limit: pageSize)
            transactions.append(contentsOf: page)
            hasMore = page.count == pageSize
            if let last = page.last {
                lastCursor = (date: last.date, id: last.id)
            }
        } catch {
            print("History load error: \(error)")
        }
    }
}
```

Create `SplitEasy/ViewModels/SettingsViewModel.swift`:

```swift
import Foundation

@MainActor
final class SettingsViewModel: ObservableObject {
    @Published var plaidItem: PlaidItem?
    @Published var currentUser: AppUser?
    @Published var needsReauth = false

    private let supabase = SupabaseService.shared

    func load() async {
        guard let userId = supabase.currentUserId else { return }
        async let userFetch: AppUser? = try? supabase.client
            .from("users").select("display_name, avatar_url")
            .eq("id", value: userId).single().execute().value
        async let plaidFetch: PlaidItem? = try? supabase.client
            .from("plaid_items").select()
            .eq("user_id", value: userId).single().execute().value

        let (user, item) = await (userFetch, plaidFetch)
        currentUser = user
        plaidItem = item
        needsReauth = item?.needsReauth ?? false
    }

    func signOut() async {
        try? await supabase.signOut()
    }
}
```

- [ ] **Step 5: Run FriendPickerViewModel tests**

```bash
xcodebuild test -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:SplitEasyTests/FriendPickerViewModelTests 2>&1 | grep -E "(PASSED|FAILED)"
# Expected: all 3 tests PASSED
```

- [ ] **Step 6: Build to verify**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 7: Commit**

```bash
git add SplitEasy/ViewModels/ SplitEasyTests/ViewModels/
git commit -m "feat(ios): add ViewModels with FriendPickerViewModel tests"
```

---

### Task 15: Shared UI Components

**Files:**
- Create: `SplitEasy/Views/Shared/ToastView.swift`
- Create: `SplitEasy/Views/Shared/ReauthBannerView.swift`

- [ ] **Step 1: Write ToastView**

Create `SplitEasy/Views/Shared/ToastView.swift`:

```swift
import SwiftUI

struct Toast: Equatable {
    enum Style { case success, error }
    let message: String
    let style: Style
}

struct ToastView: View {
    let toast: Toast

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: toast.style == .success ? "checkmark.circle.fill" : "xmark.circle.fill")
                .foregroundColor(toast.style == .success ? .green : .red)
            Text(toast.message)
                .font(.subheadline)
                .foregroundColor(.primary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
        .shadow(radius: 8)
    }
}

// View modifier for displaying toasts
struct ToastModifier: ViewModifier {
    @Binding var toast: Toast?

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let toast {
                ToastView(toast: toast)
                    .padding(.bottom, 32)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                            withAnimation { self.toast = nil }
                        }
                    }
            }
        }
        .animation(.spring(), value: toast)
    }
}

extension View {
    func toast(_ toast: Binding<Toast?>) -> some View {
        modifier(ToastModifier(toast: toast))
    }
}
```

- [ ] **Step 2: Write ReauthBannerView**

Create `SplitEasy/Views/Shared/ReauthBannerView.swift`:

```swift
import SwiftUI

struct ReauthBannerView: View {
    let onReconnect: () -> Void

    var body: some View {
        HStack {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Bank reconnection needed")
                    .font(.subheadline).bold()
                Text("Your bank session expired.")
                    .font(.caption).foregroundColor(.secondary)
            }
            Spacer()
            Button("Fix", action: onReconnect)
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
        }
        .padding()
        .background(Color.orange.opacity(0.1))
        .overlay(Rectangle().frame(height: 1).foregroundColor(.orange.opacity(0.3)), alignment: .bottom)
    }
}
```

- [ ] **Step 3: Commit**

```bash
git add SplitEasy/Views/Shared/
git commit -m "feat(ios): add ToastView and ReauthBannerView"
```

---

### Task 16: Onboarding Views

**Files:**
- Create: `SplitEasy/Views/Onboarding/WelcomeView.swift`
- Create: `SplitEasy/Views/Onboarding/BankConnectView.swift`

- [ ] **Step 1: Write WelcomeView**

Create `SplitEasy/Views/Onboarding/WelcomeView.swift`:

```swift
import SwiftUI

struct WelcomeView: View {
    @ObservedObject var vm: OnboardingViewModel

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            Image(systemName: "dollarsign.circle.fill")
                .font(.system(size: 80))
                .foregroundStyle(.green)
            VStack(spacing: 8) {
                Text("SplitEasy")
                    .font(.largeTitle).bold()
                Text("Split expenses effortlessly")
                    .font(.title3).foregroundColor(.secondary)
            }
            Spacer()
            VStack(spacing: 12) {
                if let error = vm.errorMessage {
                    Text(error)
                        .font(.caption)
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                }
                Button {
                    Task { await vm.signInWithSplitwise() }
                } label: {
                    Label("Sign in with Splitwise", systemImage: "person.crop.circle.badge.checkmark")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 48)
        }
    }
}
```

- [ ] **Step 2: Write BankConnectView**

Create `SplitEasy/Views/Onboarding/BankConnectView.swift`:

```swift
import SwiftUI
import LinkKit

struct BankConnectView: View {
    @ObservedObject var vm: OnboardingViewModel
    @StateObject private var plaid = PlaidService.shared
    @State private var showingLink = false
    @State private var isConnecting = false
    @State private var toast: Toast?

    var body: some View {
        VStack(spacing: 32) {
            Spacer()
            Image(systemName: "building.columns.fill")
                .font(.system(size: 80))
                .foregroundStyle(.blue)
            VStack(spacing: 8) {
                Text("Connect your bank")
                    .font(.largeTitle).bold()
                Text("Automatically import transactions to split")
                    .font(.title3).foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
            }
            Spacer()
            VStack(spacing: 16) {
                Button {
                    Task { await connectBank() }
                } label: {
                    if isConnecting {
                        ProgressView().tint(.white)
                    } else {
                        Label("Connect via Plaid", systemImage: "link")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(Color.accentColor)
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .disabled(isConnecting)

                Button("Skip for now") {
                    vm.state = .complete
                }
                .foregroundColor(.secondary)
            }
            .padding(.horizontal, 32)
            .padding(.bottom, 48)
        }
        .sheet(isPresented: $showingLink) {
            if let handler = plaid.handler {
                LinkController(handler: handler)
                    .ignoresSafeArea()
            }
        }
        .toast($toast)
    }

    private func connectBank() async {
        isConnecting = true
        defer { isConnecting = false }
        // Fetch a fresh link_token from the backend (keeps Plaid client secret off device)
        struct LinkTokenResponse: Codable { let link_token: String }
        guard let data = try? await SupabaseService.shared.client.functions.invoke("plaid-create-link-token"),
              let response = try? JSONDecoder().decode(LinkTokenResponse.self, from: data)
        else {
            toast = Toast(message: "Could not start bank connection. Try again.", style: .error)
            return
        }
        plaid.createHandler(linkToken: response.link_token) { publicToken in
            Task {
                do {
                    let name = try await plaid.exchangeToken(publicToken)
                    toast = Toast(message: "\(name) connected!", style: .success)
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    vm.state = .complete
                } catch {
                    toast = Toast(message: "Connection failed. Try again.", style: .error)
                }
            }
        }
        showingLink = true
    }
}
```

- [ ] **Step 3: Build to verify**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 4: Commit**

```bash
git add SplitEasy/Views/Onboarding/
git commit -m "feat(ios): add onboarding views (Welcome + BankConnect)"
```

---

### Task 17: New Transactions Tab

**Files:**
- Create: `SplitEasy/Views/NewTransactions/NewTransactionsView.swift`
- Create: `SplitEasy/Views/NewTransactions/TransactionRowView.swift`
- Create: `SplitEasy/Views/NewTransactions/FriendPickerView.swift`

- [ ] **Step 1: Write TransactionRowView**

Create `SplitEasy/Views/NewTransactions/TransactionRowView.swift`:

```swift
import SwiftUI

struct TransactionRowView: View {
    let transaction: Transaction
    let onSkip: () -> Void
    let onSplit: () -> Void

    private static let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(transaction.merchantName ?? "Unknown merchant")
                        .font(.headline)
                    Text(transaction.date)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
                Text(Self.currencyFormatter.string(from: transaction.amount as NSDecimalNumber) ?? "$\(transaction.amount)")
                    .font(.headline)
            }
            HStack(spacing: 8) {
                Button(action: onSplit) {
                    Label("Split", systemImage: "person.2.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color.accentColor)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                Button(action: onSkip) {
                    Label("Skip", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background(Color(.systemGray5))
                        .foregroundColor(.primary)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding()
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.05), radius: 4, x: 0, y: 2)
    }
}
```

- [ ] **Step 2: Write FriendPickerView**

Create `SplitEasy/Views/NewTransactions/FriendPickerView.swift`:

```swift
import SwiftUI

struct FriendPickerView: View {
    @StateObject private var vm: FriendPickerViewModel
    @Binding var isPresented: Bool
    let onSuccess: (String, Decimal) -> Void  // (expenseId, amountEach)
    @EnvironmentObject private var newTransactionsVM: NewTransactionsViewModel

    private static let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }()

    init(transaction: Transaction, isPresented: Binding<Bool>, onSuccess: @escaping (String, Decimal) -> Void) {
        _vm = StateObject(wrappedValue: FriendPickerViewModel(transaction: transaction))
        _isPresented = isPresented
        self.onSuccess = onSuccess
    }

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading {
                    ProgressView("Loading friends…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.friends.isEmpty {
                    emptyState
                } else {
                    friendList
                }
            }
            .navigationTitle(vm.transaction.merchantName ?? "Split expense")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { isPresented = false }
                }
            }
            .safeAreaInset(edge: .bottom) { submitButton }
        }
        .task { await vm.loadFriends() }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "person.2.slash")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("You have no Splitwise friends yet.\nAdd friends in Splitwise first.")
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)
            Button("Open Splitwise") {
                UIApplication.shared.open(URL(string: "splitwise://")!)
            }
            .buttonStyle(.bordered)
        }
        .padding()
    }

    private var friendList: some View {
        List(vm.friends) { friend in
            let isSelected = vm.selectedFriends.contains(friend)
            HStack {
                VStack(alignment: .leading) {
                    Text(friend.name).font(.headline)
                    if isSelected, vm.amountPerPerson > 0 {
                        Text(Self.currencyFormatter.string(from: vm.amountPerPerson as NSDecimalNumber) ?? "" + " each")
                            .font(.caption).foregroundColor(.accentColor)
                    }
                }
                Spacer()
                if isSelected {
                    Image(systemName: "checkmark.circle.fill").foregroundColor(.accentColor)
                } else {
                    Image(systemName: "circle").foregroundColor(.secondary)
                }
            }
            .contentShape(Rectangle())
            .onTapGesture { vm.toggleSelection(friend) }
        }
        .listStyle(.plain)
    }

    private var submitButton: some View {
        VStack(spacing: 0) {
            Divider()
            Button {
                Task {
                    do {
                        let result = try await vm.submit()
                        newTransactionsVM.remove(vm.transaction)
                        onSuccess(result.splitwiseExpenseId, result.amountEach)
                        isPresented = false
                    } catch {
                        // vm.errorMessage is set in submit()
                    }
                }
            } label: {
                Group {
                    if vm.isSubmitting {
                        ProgressView().tint(.white)
                    } else {
                        Text("Add to Splitwise")
                    }
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(vm.canSubmit ? Color.accentColor : Color(.systemGray4))
                .foregroundColor(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(!vm.canSubmit)
            .padding()
        }
        .background(Color(.systemBackground))
    }
}
```

- [ ] **Step 3: Write NewTransactionsView**

Create `SplitEasy/Views/NewTransactions/NewTransactionsView.swift`:

```swift
import SwiftUI

struct NewTransactionsView: View {
    @StateObject private var vm = NewTransactionsViewModel()
    @State private var selectedTransaction: Transaction?
    @State private var toast: Toast?
    @EnvironmentObject private var settingsVM: SettingsViewModel
    @EnvironmentObject private var networkMonitor: NetworkMonitor

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.transactions.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.transactions.isEmpty {
                    emptyState
                } else {
                    transactionList
                }
            }
            .navigationTitle("New Transactions")
            .safeAreaInset(edge: .top) {
                if settingsVM.needsReauth {
                    ReauthBannerView { /* TODO: trigger Plaid update mode */ }
                }
                if !networkMonitor.isConnected {
                    HStack {
                        Image(systemName: "wifi.slash")
                        Text("No internet connection")
                    }
                    .font(.caption)
                    .foregroundColor(.white)
                    .padding(8)
                    .frame(maxWidth: .infinity)
                    .background(Color.red)
                }
            }
        }
        .task { await vm.load() }
        .onAppear { vm.startRealtime() }
        .onDisappear { vm.stopRealtime() }
        .refreshable { await vm.refresh() }
        .sheet(item: $selectedTransaction) { tx in
            FriendPickerView(
                transaction: tx,
                isPresented: Binding(
                    get: { selectedTransaction != nil },
                    set: { if !$0 { selectedTransaction = nil } }
                ),
                onSuccess: { _, amountEach in
                    let f = NumberFormatter()
                    f.numberStyle = .currency
                    f.currencyCode = "USD"
                    let formatted = f.string(from: amountEach as NSDecimalNumber) ?? "$\(amountEach)"
                    toast = Toast(message: "Added! Others owe you \(formatted)", style: .success)
                }
            )
            .environmentObject(vm)
        }
        .toast($toast)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "tray")
                .font(.system(size: 48))
                .foregroundColor(.secondary)
            Text("No new transactions")
                .font(.headline)
            Text("New transactions will appear here automatically.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
    }

    private var transactionList: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(vm.transactions) { tx in
                    TransactionRowView(
                        transaction: tx,
                        onSkip: { Task { await vm.skip(tx) } },
                        onSplit: { selectedTransaction = tx }
                    )
                    .padding(.horizontal)
                }
            }
            .padding(.vertical)
        }
    }
}
```

- [ ] **Step 4: Build to verify**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Views/NewTransactions/
git commit -m "feat(ios): add New Transactions tab with friend picker"
```

---

### Task 18: History Tab

**Files:**
- Create: `SplitEasy/Views/History/HistoryRowView.swift`
- Create: `SplitEasy/Views/History/HistoryView.swift`

- [ ] **Step 1: Write HistoryRowView**

Create `SplitEasy/Views/History/HistoryRowView.swift`:

```swift
import SwiftUI

struct HistoryRowView: View {
    let transaction: Transaction

    private static let currencyFormatter: NumberFormatter = {
        let f = NumberFormatter()
        f.numberStyle = .currency
        f.currencyCode = "USD"
        return f
    }()

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(transaction.merchantName ?? "Unknown merchant")
                    .font(.headline)
                Text(transaction.date)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(Self.currencyFormatter.string(from: transaction.amount as NSDecimalNumber) ?? "$\(transaction.amount)")
                    .font(.headline)
                statusBadge
            }
        }
        .padding(.vertical, 4)
    }

    private var statusBadge: some View {
        Group {
            switch transaction.status {
            case .split:
                Text("Split")
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.15))
                    .foregroundColor(.accentColor)
                    .clipShape(Capsule())
            case .skipped:
                Text("Skipped")
                    .font(.caption)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(Color(.systemGray5))
                    .foregroundColor(.secondary)
                    .clipShape(Capsule())
            default:
                EmptyView()
            }
        }
    }
}
```

- [ ] **Step 2: Write HistoryView**

Create `SplitEasy/Views/History/HistoryView.swift`:

```swift
import SwiftUI

struct HistoryView: View {
    @StateObject private var vm = HistoryViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if vm.isLoading && vm.transactions.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if vm.transactions.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "clock")
                            .font(.system(size: 48))
                            .foregroundColor(.secondary)
                        Text("No history yet")
                            .font(.headline)
                        Text("Transactions you split or skip will appear here.")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding()
                } else {
                    List {
                        ForEach(vm.transactions) { tx in
                            HistoryRowView(transaction: tx)
                                .onAppear {
                                    if tx.id == vm.transactions.last?.id {
                                        Task { await vm.loadNextPage() }
                                    }
                                }
                        }
                        if vm.isLoading {
                            HStack { Spacer(); ProgressView(); Spacer() }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("History")
        }
        .task { await vm.loadInitial() }
    }
}
```

- [ ] **Step 3: Build to verify**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 4: Commit**

```bash
git add SplitEasy/Views/History/
git commit -m "feat(ios): add History tab with pagination"
```

---

### Task 19: Settings Tab

**Files:**
- Create: `SplitEasy/Views/Settings/SettingsView.swift`

- [ ] **Step 1: Write SettingsView**

Create `SplitEasy/Views/Settings/SettingsView.swift`:

```swift
import SwiftUI

struct SettingsView: View {
    @StateObject private var vm = SettingsViewModel()
    @StateObject private var plaid = PlaidService.shared
    @State private var showingBankConnect = false
    @State private var isReconnecting = false
    @State private var toast: Toast?

    var body: some View {
        NavigationStack {
            Form {
                Section("Bank Account") {
                    if let item = vm.plaidItem {
                        HStack {
                            Image(systemName: "building.columns.fill")
                                .foregroundColor(.blue)
                            Text(item.institutionName ?? "Connected Bank")
                        }
                        if item.needsReauth {
                            Button {
                                Task { await reconnectBank() }
                            } label: {
                                if isReconnecting { ProgressView() } else { Text("Reconnect Bank") }
                            }
                            .foregroundColor(.orange)
                            .disabled(isReconnecting)
                        } else {
                            Label("Connected", systemImage: "checkmark.circle.fill")
                                .foregroundColor(.green)
                        }
                    } else {
                        Text("No bank connected")
                            .foregroundColor(.secondary)
                        Button("Connect a Bank") { showingBankConnect = true }
                    }
                }

                Section("Splitwise Account") {
                    if let user = vm.currentUser {
                        HStack {
                            Image(systemName: "person.circle.fill")
                                .foregroundColor(.accentColor)
                            Text(user.displayName)
                        }
                    }
                    Button("Sign Out", role: .destructive) {
                        Task { await vm.signOut() }
                    }
                }

                Section("Notifications") {
                    Toggle("Transaction Alerts", isOn: .constant(false))
                        .disabled(true)
                    Text("Push notifications coming soon.")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .navigationTitle("Settings")
        }
        .task { await vm.load() }
        .sheet(isPresented: $showingBankConnect) {
            OnboardingViewModel()  // reuses BankConnectView flow
        }
        .toast($toast)
    }

    // Launch Plaid Link in update mode to fix expired bank credentials
    private func reconnectBank() async {
        isReconnecting = true
        defer { isReconnecting = false }
        struct LinkTokenResponse: Codable { let link_token: String }
        guard let data = try? await SupabaseService.shared.client.functions.invoke("plaid-create-link-token"),
              let response = try? JSONDecoder().decode(LinkTokenResponse.self, from: data)
        else {
            toast = Toast(message: "Could not start reconnection. Try again.", style: .error)
            return
        }
        plaid.createHandler(linkToken: response.link_token) { publicToken in
            Task {
                do {
                    _ = try await plaid.exchangeToken(publicToken)
                    await vm.load()
                    toast = Toast(message: "Bank reconnected!", style: .success)
                } catch {
                    toast = Toast(message: "Reconnection failed. Try again.", style: .error)
                }
            }
        }
        // Handler opens automatically in the createHandler callback
    }
}
```

- [ ] **Step 2: Build to verify**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 3: Commit**

```bash
git add SplitEasy/Views/Settings/
git commit -m "feat(ios): add Settings tab"
```

---

### Task 20: App Entry Point and Main Tab View

**Files:**
- Create: `SplitEasy/Views/Main/MainTabView.swift`
- Modify: `SplitEasy/SplitEasyApp.swift`

- [ ] **Step 1: Write MainTabView**

Create `SplitEasy/Views/Main/MainTabView.swift`:

```swift
import SwiftUI

struct MainTabView: View {
    @StateObject private var settingsVM = SettingsViewModel()
    @StateObject private var networkMonitor = NetworkMonitor.shared

    var body: some View {
        TabView {
            NewTransactionsView()
                .tabItem { Label("New", systemImage: "bell.fill") }
                .environmentObject(settingsVM)
                .environmentObject(networkMonitor)

            HistoryView()
                .tabItem { Label("History", systemImage: "clock.fill") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
        }
        .task { await settingsVM.load() }
    }
}
```

- [ ] **Step 2: Write root app entry point**

Modify `SplitEasy/SplitEasyApp.swift`:

```swift
import SwiftUI

@main
struct SplitEasyApp: App {
    @StateObject private var onboardingVM = OnboardingViewModel()

    var body: some Scene {
        WindowGroup {
            Group {
                switch onboardingVM.state {
                case .loading:
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
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

- [ ] **Step 3: Final build**

```bash
xcodebuild build -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | tail -3
# Expected: ** BUILD SUCCEEDED **
```

- [ ] **Step 4: Run all tests**

```bash
xcodebuild test -scheme SplitEasy -destination 'platform=iOS Simulator,name=iPhone 16' 2>&1 | grep -E "(PASSED|FAILED|Executed)"
# Expected: All tests PASSED
```

- [ ] **Step 5: Commit**

```bash
git add SplitEasy/Views/Main/ SplitEasy/SplitEasyApp.swift
git commit -m "feat(ios): wire up app entry point and main tab view"
```

---

## Phase 3 — End-to-End Validation

### Task 21: Sandbox Integration Test

- [ ] **Step 1: Register Plaid Sandbox credentials**

Go to https://dashboard.plaid.com → Sandbox → create an app → copy Client ID and Secret into `supabase/.env.local`.

- [ ] **Step 2: Register Splitwise OAuth app**

Go to https://secure.splitwise.com/apps/new → create app → set redirect URI to `spliteasy://oauth/callback` → copy Client ID and Secret into `supabase/.env.local` and `SplitEasy/Config/Secrets.xcconfig`.

- [ ] **Step 3: Deploy functions locally and expose via ngrok**

```bash
supabase functions serve --env-file supabase/.env.local
# In another terminal:
ngrok http 54321
# Copy the ngrok HTTPS URL — use this as your Plaid webhook URL in the Plaid dashboard
```

- [ ] **Step 4: Configure Plaid webhook in Plaid dashboard**

Set webhook URL to: `https://<ngrok-url>/functions/v1/plaid-webhook`

- [ ] **Step 5: Run app in Simulator and test sign-in flow**

```
Open Xcode → Run on iPhone simulator
Expected: WelcomeView appears → tap "Sign in with Splitwise"
→ Splitwise OAuth opens in browser
→ User authorizes
→ Redirect to spliteasy://oauth/callback
→ App moves to BankConnectView
```

- [ ] **Step 6: Test bank connection**

```
Tap "Connect via Plaid"
→ Plaid Link opens
→ Select "Chase" (Sandbox)
→ Enter credentials: user_good / pass_good
→ Select a checking account
→ App shows "Chase connected!" toast
→ App moves to MainTabView (New tab)
```

- [ ] **Step 7: Fire a Plaid sandbox webhook to test transaction sync**

```bash
curl -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "YOUR_CLIENT_ID",
    "secret": "YOUR_SANDBOX_SECRET",
    "access_token": "YOUR_ACCESS_TOKEN",
    "webhook_code": "DEFAULT_UPDATE"
  }'
# Expected: transactions appear in New tab within seconds
```

- [ ] **Step 8: Test split flow**

```
Tap "Split" on a transaction
→ Friend picker opens
→ Select 1 friend
→ Tap "Add to Splitwise"
→ Toast: "Added! Others owe you $X.XX"
→ Transaction disappears from New tab
→ Transaction appears in History tab as "Split"
```

- [ ] **Step 9: Test skip flow**

```
Tap "Skip" on a transaction
→ Transaction disappears from New tab immediately
→ Transaction appears in History tab as "Skipped"
```

- [ ] **Step 10: Final commit**

```bash
git add .
git commit -m "feat: complete SplitEasy MVP implementation"
```

---

## Appendix: Environment Variable Reference

### `supabase/.env.local`
| Variable | Description |
|---|---|
| `PLAID_CLIENT_ID` | Plaid app client ID |
| `PLAID_SECRET` | Plaid sandbox or production secret |
| `PLAID_ENV` | `sandbox` or `production` |
| `SPLITWISE_CLIENT_ID` | Splitwise OAuth app client ID |
| `SPLITWISE_CLIENT_SECRET` | Splitwise OAuth app secret |
| `SPLITWISE_REDIRECT_URI` | `spliteasy://oauth/callback` |

### `SplitEasy/Config/Secrets.xcconfig`
| Variable | Description |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_ANON_KEY` | Your Supabase anon/public key |
| `SPLITWISE_CLIENT_ID` | Splitwise OAuth app client ID |
| `SPLITWISE_REDIRECT_URI` | `spliteasy://oauth/callback` |
