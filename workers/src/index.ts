export interface Env {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  WORKER_API_KEY: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
}

function plaidBase(env: Env): string {
  switch (env.PLAID_ENV) {
    case 'production': return 'https://production.plaid.com';
    case 'development': return 'https://development.plaid.com';
    default: return 'https://sandbox.plaid.com';
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authenticate(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  return auth === `Bearer ${env.WORKER_API_KEY}`;
}

async function handleLinkToken(env: Env): Promise<Response> {
  const res = await fetch(`${plaidBase(env)}/link/token/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      client_name: 'SplitEasy',
      country_codes: ['US'],
      language: 'en',
      user: { client_user_id: 'spliteasy-user' }, // TODO(phase-2): accept user_id from request body for per-user Plaid identity
      products: ['transactions'],
      // Required for Link on Android; include for mobile tokens (see Plaid link/token/create).
      android_package_name: 'com.spliteasy.app',
    }),
  });
  const data = await res.json() as { link_token?: string; error_code?: string };
  if (!res.ok) return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  return json({ link_token: data.link_token });
}

async function handleExchange(req: Request, env: Env): Promise<Response> {
  const { public_token } = await req.json() as { public_token?: string };
  if (!public_token || typeof public_token !== 'string') {
    return json({ error: 'MISSING_PUBLIC_TOKEN' }, 400);
  }
  const res = await fetch(`${plaidBase(env)}/item/public_token/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      public_token,
    }),
  });
  const data = await res.json() as { access_token?: string; error_code?: string };
  if (!res.ok) return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  return json({ access_token: data.access_token });
}

interface PlaidTransaction {
  transaction_id: string;
  amount: number;
  [key: string]: unknown;
}

async function handleTransactions(req: Request, env: Env): Promise<Response> {
  const { access_token, cursor } = await req.json() as { access_token?: string; cursor?: string };
  if (!access_token || typeof access_token !== 'string') {
    return json({ error: 'MISSING_ACCESS_TOKEN' }, 400);
  }
  const res = await fetch(`${plaidBase(env)}/transactions/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      access_token,
      ...(cursor ? { cursor } : {}),
    }),
  });
  const data = await res.json() as {
    added?: PlaidTransaction[];
    modified?: PlaidTransaction[];
    removed?: { transaction_id: string }[];
    next_cursor?: string;
    has_more?: boolean;
    error_code?: string;
  };
  if (!res.ok) {
    if (data.error_code === 'ITEM_LOGIN_REQUIRED') {
      return json({ error: 'ITEM_LOGIN_REQUIRED' }, 400);
    }
    return json({ error: data.error_code ?? 'PLAID_ERROR' }, res.status);
  }
  const isDebit = (tx: PlaidTransaction) => tx.amount > 0;
  return json({
    added: (data.added ?? []).filter(isDebit),
    modified: (data.modified ?? []).filter(isDebit),
    removed: data.removed ?? [],
    next_cursor: data.next_cursor,
    has_more: data.has_more ?? false,
  });
}

async function handleSplitwiseExchange(req: Request, env: Env): Promise<Response> {
  const { code, redirect_uri } = await req.json() as { code?: string; redirect_uri?: string };
  if (!code || typeof code !== 'string' || !redirect_uri || typeof redirect_uri !== 'string') {
    return json({ error: 'MISSING_REQUIRED_PARAMS' }, 400);
  }
  const tokenRes = await fetch('https://secure.splitwise.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.SPLITWISE_CLIENT_ID,
      client_secret: env.SPLITWISE_CLIENT_SECRET,
      code,
      redirect_uri,
    }),
  });
  const tokenData = await tokenRes.json() as { access_token?: string; error?: string };
  if (!tokenRes.ok || !tokenData.access_token) {
    return json({ error: tokenData.error ?? 'SPLITWISE_AUTH_ERROR' }, 400);
  }
  const userRes = await fetch('https://secure.splitwise.com/api/v3.0/get_current_user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) return json({ error: 'SPLITWISE_PROFILE_ERROR' }, 502);
  const userData = await userRes.json() as {
    user: { id: number; first_name: string; last_name: string; picture?: { medium?: string } }
  };
  const { id, first_name, last_name, picture } = userData.user;
  return json({
    access_token: tokenData.access_token,
    user_id: String(id),           // always returned as string
    display_name: `${first_name} ${last_name}`.trim(),
    avatar_url: picture?.medium ?? null,
  });
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    try {
      if (!authenticate(req, env)) return json({ error: 'Unauthorized' }, 401);
      const path = new URL(req.url).pathname;
      if (req.method === 'POST' && path === '/plaid/link-token') return handleLinkToken(env);
      if (req.method === 'POST' && path === '/plaid/exchange') return handleExchange(req, env);
      if (req.method === 'POST' && path === '/plaid/transactions') return handleTransactions(req, env);
      if (req.method === 'POST' && path === '/splitwise/exchange') return handleSplitwiseExchange(req, env);
      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return json({ error: 'INVALID_REQUEST_BODY' }, 400);
      }
      throw err;
    }
  },
};
