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
