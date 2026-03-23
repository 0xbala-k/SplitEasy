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
