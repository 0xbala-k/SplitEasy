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
