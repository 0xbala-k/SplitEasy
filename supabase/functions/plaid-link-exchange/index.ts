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
