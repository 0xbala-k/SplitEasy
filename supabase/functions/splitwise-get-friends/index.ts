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
