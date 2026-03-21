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

  const isValid = await verifyPlaidWebhook(req, bodyText)
  if (!isValid) {
    return new Response('Unauthorized', { status: 401 })
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(bodyText)
  } catch {
    return new Response('Bad Request', { status: 400 })
  }

  const { webhook_type, webhook_code, item_id } = payload as {
    webhook_type: string
    webhook_code: string
    item_id: string
  }

  const supabase = createAdminClient()

  // Handle ITEM_LOGIN_REQUIRED — set needs_reauth flag
  if (webhook_type === 'ITEM' && webhook_code === 'PENDING_EXPIRATION' ||
      webhook_type === 'ITEM' && webhook_code === 'USER_PERMISSION_REVOKED' ||
      webhook_type === 'ITEM' && webhook_code === 'ERROR' &&
        (payload.error as Record<string, unknown>)?.error_code === 'ITEM_LOGIN_REQUIRED') {
    await supabase.from('plaid_items')
      .update({ needs_reauth: true })
      .eq('plaid_item_id', item_id)
    return new Response('ok', { status: 200 })
  }

  // Handle transaction sync events
  if (webhook_type !== 'TRANSACTIONS') {
    return new Response('ok', { status: 200 })
  }

  if (webhook_code === 'SYNC_UPDATES_AVAILABLE' || webhook_code === 'DEFAULT_UPDATE' || webhook_code === 'INITIAL_UPDATE' || webhook_code === 'HISTORICAL_UPDATE') {
    // Find the plaid_item row to get user_id and access token vault name
    const { data: plaidItem } = await supabase
      .from('plaid_items')
      .select('id, user_id, plaid_access_token')
      .eq('plaid_item_id', item_id)
      .single()

    if (!plaidItem) return new Response('ok', { status: 200 })

    // Retrieve actual access token from Vault
    const { data: accessToken } = await supabase.rpc('get_vault_secret', {
      p_name: plaidItem.plaid_access_token,
    })
    if (!accessToken) return new Response('ok', { status: 200 })

    // Sync transactions (handle pagination)
    let cursor: string | undefined
    let hasMore = true
    while (hasMore) {
      const syncData = await fetchNewTransactions(accessToken, cursor)
      const { added, removed, next_cursor, has_more } = syncData

      // Upsert new debits (amount > 0 filter applied in schema check, but Plaid amounts for debits are positive)
      if (added?.length) {
        const debits = (added as Record<string, unknown>[])
          .filter((t) => typeof t.amount === 'number' && (t.amount as number) > 0)
          .map((t) => ({
            user_id: plaidItem.user_id,
            plaid_item_id: plaidItem.id,
            plaid_transaction_id: t.transaction_id as string,
            merchant_name: (t.merchant_name ?? t.name) as string | null,
            amount: t.amount as number,
            currency: (t.iso_currency_code ?? 'USD') as string,
            date: t.date as string,
            status: 'new',
          }))

        if (debits.length > 0) {
          await supabase.from('transactions').upsert(debits, {
            onConflict: 'plaid_transaction_id',
            ignoreDuplicates: true,
          })
        }
      }

      // Mark removed transactions
      if (removed?.length) {
        const removedIds = (removed as Record<string, unknown>[]).map((t) => t.transaction_id as string)
        await supabase.from('transactions')
          .update({ status: 'removed' })
          .in('plaid_transaction_id', removedIds)
          .eq('user_id', plaidItem.user_id)
      }

      cursor = next_cursor
      hasMore = has_more
    }
  }

  if (webhook_code === 'TRANSACTIONS_REMOVED') {
    const removed_transaction_ids = payload.removed_transaction_ids as string[]
    if (removed_transaction_ids?.length) {
      const { data: plaidItem } = await supabase
        .from('plaid_items')
        .select('user_id')
        .eq('plaid_item_id', item_id)
        .single()

      if (plaidItem) {
        await supabase.from('transactions')
          .update({ status: 'removed' })
          .in('plaid_transaction_id', removed_transaction_ids)
          .eq('user_id', plaidItem.user_id)
      }
    }
  }

  return new Response('ok', { status: 200 })
})
