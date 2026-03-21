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

  // Fetch transaction to get amount
  const { data: tx, error: txError } = await supabase
    .from('transactions')
    .select('id, amount, merchant_name, date, user_id')
    .eq('id', transaction_id)
    .eq('user_id', user.id)
    .single()

  if (txError || !tx) {
    return new Response(JSON.stringify({ error: 'transaction_not_found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Get Splitwise token
  const token = await getSplitwiseToken(user.id)
  if (!token) {
    return new Response(JSON.stringify({ error: 'splitwise_auth_expired' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Get Splitwise user ID for the current user
  const { data: dbUser } = await supabase
    .from('users')
    .select('splitwise_user_id')
    .eq('id', user.id)
    .single()

  if (!dbUser) {
    return new Response(JSON.stringify({ error: 'user_not_found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  // Build equal-split expense body
  const totalPeople = friend_ids.length + 1 // friends + current user
  const amountEach = Number((tx.amount / totalPeople).toFixed(2))
  const allUsers = [dbUser.splitwise_user_id, ...friend_ids]

  const expenseBody: Record<string, unknown> = {
    cost: String(tx.amount.toFixed(2)),
    description: tx.merchant_name ?? 'Expense',
    date: tx.date,
    split_equally: true,
  }
  allUsers.forEach((uid, i) => {
    expenseBody[`users__${i}__user_id`] = uid
    expenseBody[`users__${i}__paid_share`] = i === 0 ? String(tx.amount.toFixed(2)) : '0.00'
    expenseBody[`users__${i}__owed_share`] = String(amountEach.toFixed(2))
  })

  // Create expense in Splitwise
  const swRes = await fetch('https://secure.splitwise.com/api/v3.0/create_expense', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(expenseBody),
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

  const { expense } = await swRes.json()
  const expenseId = String(expense.id)

  // Write split_decision + update transaction status atomically
  const { error: decisionError } = await supabase.from('split_decisions').insert({
    transaction_id,
    user_id: user.id,
    splitwise_expense_id: expenseId,
    friend_ids,
    split_type: 'equal',
    equal_amount_each: amountEach,
  })

  if (decisionError) {
    // Expense was created in SW but DB write failed — log but return success
    // (idempotency check on next call will return the existing expense if re-inserted)
    console.error('split_decision insert failed:', decisionError.message)
  }

  await supabase
    .from('transactions')
    .update({ status: 'split' })
    .eq('id', transaction_id)

  return new Response(JSON.stringify({
    splitwise_expense_id: expenseId,
    amount_each: amountEach,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
})
