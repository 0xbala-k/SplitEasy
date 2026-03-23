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
  // Validate friend IDs are numeric Splitwise user IDs
  if (!friend_ids.every((id: unknown) => typeof id === 'string' && /^\d+$/.test(id))) {
    return new Response(JSON.stringify({ error: 'invalid_friend_ids' }), {
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

  // Fetch transaction, Splitwise token, and user record in parallel
  const [
    { data: tx, error: txError },
    token,
    { data: dbUser },
  ] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, amount, merchant_name, date, user_id')
      .eq('id', transaction_id)
      .eq('user_id', user.id)
      .single(),
    getSplitwiseToken(user.id),
    supabase
      .from('users')
      .select('splitwise_user_id')
      .eq('id', user.id)
      .single(),
  ])

  if (txError || !tx) {
    return new Response(JSON.stringify({ error: 'transaction_not_found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!token) {
    return new Response(JSON.stringify({ error: 'splitwise_auth_expired' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!dbUser) {
    return new Response(JSON.stringify({ error: 'user_not_found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Build equal-split expense body
  // PostgREST returns numeric columns as strings — convert before arithmetic
  const amount = Number(tx.amount)
  const totalPeople = friend_ids.length + 1 // friends + current user
  const allUsers = [dbUser.splitwise_user_id, ...friend_ids]

  // Use integer cents to avoid rounding errors (e.g. $78.50/4 = $19.625 → $19.63 × 4 = $78.52)
  const totalCents = Math.round(amount * 100)
  const baseShareCents = Math.floor(totalCents / totalPeople)
  const remainderCents = totalCents - baseShareCents * totalPeople
  // Last person absorbs the remainder so shares sum exactly to cost
  const amountEach = baseShareCents / 100

  const expenseBody: Record<string, unknown> = {
    cost: amount.toFixed(2),
    description: tx.merchant_name ?? 'Expense',
    date: tx.date,
  }
  allUsers.forEach((uid, i) => {
    const isLast = i === allUsers.length - 1
    const owedCents = isLast ? baseShareCents + remainderCents : baseShareCents
    expenseBody[`users__${i}__user_id`] = uid
    expenseBody[`users__${i}__paid_share`] = i === 0 ? amount.toFixed(2) : '0.00'
    expenseBody[`users__${i}__owed_share`] = (owedCents / 100).toFixed(2)
  })

  // Create expense in Splitwise
  const swRes = await fetch('https://secure.splitwise.com/api/v3.0/create_expense', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(expenseBody),
    signal: AbortSignal.timeout(10_000),
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

  const swBody = await swRes.json()
  const { expenses, errors } = swBody as { expenses: Record<string, unknown>[]; errors?: Record<string, unknown> }

  if (errors && Object.keys(errors).length > 0) {
    console.error('splitwise create_expense errors:', JSON.stringify(errors))
    return new Response(JSON.stringify({ error: 'splitwise_validation_error', details: errors }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
  if (!expenses?.[0]?.id) {
    console.error('splitwise create_expense unexpected response:', JSON.stringify(swBody))
    return new Response(JSON.stringify({ error: 'splitwise_api_error' }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const expenseId = String(expenses[0].id)

  // Write split_decision and update transaction status in parallel
  const [{ error: decisionError }] = await Promise.all([
    supabase.from('split_decisions').insert({
      transaction_id,
      user_id: user.id,
      splitwise_expense_id: expenseId,
      friend_ids,
      split_type: 'equal',
      equal_amount_each: amountEach,
    }),
    supabase
      .from('transactions')
      .update({ status: 'split' })
      .eq('id', transaction_id),
  ])

  if (decisionError) {
    // DB write failed after Splitwise expense was created — delete it to keep state consistent
    console.error('split_decision insert failed:', decisionError.message)
    try {
      await fetch(`https://secure.splitwise.com/api/v3.0/delete_expense/${expenseId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      })
    } catch (e) {
      console.error('Failed to delete Splitwise expense after DB error:', e)
    }
    return new Response(JSON.stringify({ error: 'db_error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({
    splitwise_expense_id: expenseId,
    amount_each: amountEach,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
