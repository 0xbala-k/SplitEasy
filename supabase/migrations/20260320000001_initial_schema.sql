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
