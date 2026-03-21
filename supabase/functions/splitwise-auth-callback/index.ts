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
