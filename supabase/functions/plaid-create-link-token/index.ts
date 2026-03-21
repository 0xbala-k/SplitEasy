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
      webhook: Deno.env.get('PLAID_WEBHOOK_URL'),
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
