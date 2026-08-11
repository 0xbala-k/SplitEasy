import { callGemini, normalizeReceipt } from './receipt';

export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
  PLAID_ENV: string;
  WORKER_API_KEY: string;
  SPLITWISE_CLIENT_ID: string;
  SPLITWISE_CLIENT_SECRET: string;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  ALLOWED_ORIGIN?: string;
  // `ratelimit` binding (wrangler.toml `[[unsafe.bindings]]`), guarding
  // /receipt/parse. WORKER_API_KEY is embedded in the web bundle and thus
  // extractable, so auth alone doesn't stop an abusive caller from burning
  // Gemini quota — this caps requests per client IP on top of it.
  RECEIPT_LIMITER: RateLimiter;
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

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Splitwise-Token',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(res: Response, env: Env): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}

function authenticate(req: Request, env: Env): boolean {
  const auth = req.headers.get('Authorization') ?? '';
  return auth === `Bearer ${env.WORKER_API_KEY}`;
}

async function handleLinkToken(req: Request, env: Env): Promise<Response> {
  let platform = 'mobile';
  try {
    const body = await req.json() as { platform?: string };
    if (body.platform === 'web') platform = 'web';
  } catch {
    // empty body → default to mobile
  }
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
      // android_package_name is only valid for Android link tokens.
      ...(platform === 'web' ? {} : { android_package_name: 'com.spliteasy.app' }),
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
  pending?: boolean;
  // Set on the posted transaction when it replaces a pending one; points back
  // at the pending transaction_id. Passed through untouched via the index
  // signature below — declared here only for documentation.
  pending_transaction_id?: string | null;
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

const SPLITWISE_API_BASE = 'https://secure.splitwise.com/api/v3.0';

// Browser clients cannot call Splitwise directly (no CORS on their API), so the
// web app tunnels through here. The user's Splitwise token arrives in
// X-Splitwise-Token; Authorization still carries the worker API key.
async function handleSplitwiseProxy(req: Request, apiPath: string): Promise<Response> {
  const token = req.headers.get('X-Splitwise-Token');
  if (!token) return json({ error: 'MISSING_SPLITWISE_TOKEN' }, 400);
  const contentType = req.headers.get('Content-Type');
  const upstream = await fetch(`${SPLITWISE_API_BASE}${apiPath}`, {
    method: req.method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(contentType ? { 'Content-Type': contentType } : {}),
    },
    body: req.method === 'POST' ? await req.text() : undefined,
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SUPPORTED_RECEIPT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
const MAX_IMAGE_BASE64_LENGTH = 7_000_000;

interface GeminiGenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
}

async function handleReceiptParse(req: Request, env: Env): Promise<Response> {
  // Rate-limited ahead of body parsing: WORKER_API_KEY is extractable from
  // the web bundle, so a valid Authorization header alone doesn't prove a
  // legitimate caller. Cap by client IP to keep this from being an open
  // proxy to the Gemini quota.
  const ip = req.headers.get('CF-Connecting-IP') ?? 'anon';
  const { success } = await env.RECEIPT_LIMITER.limit({ key: ip });
  if (!success) {
    return json({ error: 'RATE_LIMITED' }, 429);
  }

  const { image_base64, mime_type } = await req.json() as { image_base64?: string; mime_type?: string };

  if (!image_base64 || typeof image_base64 !== 'string') {
    return json({ error: 'MISSING_IMAGE' }, 400);
  }
  if (image_base64.length > MAX_IMAGE_BASE64_LENGTH) {
    return json({ error: 'IMAGE_TOO_LARGE' }, 413);
  }
  if (!mime_type || !SUPPORTED_RECEIPT_MIME_TYPES.has(mime_type)) {
    return json({ error: 'UNSUPPORTED_MIME_TYPE' }, 400);
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'RECEIPT_PARSE_UNAVAILABLE' }, 503);
  }

  let geminiRes: Response;
  try {
    geminiRes = await callGemini(env, image_base64, mime_type);
  } catch {
    // Network failure or AbortSignal.timeout firing (AbortError).
    return json({ error: 'RECEIPT_PARSE_FAILED' }, 502);
  }
  if (!geminiRes.ok) {
    return json({ error: 'RECEIPT_PARSE_FAILED' }, 502);
  }

  const geminiData = await geminiRes.json() as GeminiGenerateContentResponse;
  const text = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;

  // Kept in its own try/catch, separate from the top-level SyntaxError
  // handler below (which is for the *incoming* request body), so a
  // malformed Gemini response is correctly reported as 502, not 400.
  let raw: unknown;
  try {
    if (typeof text !== 'string') throw new Error('missing candidate text');
    raw = JSON.parse(text);
  } catch {
    return json({ error: 'RECEIPT_PARSE_FAILED' }, 502);
  }

  return json(normalizeReceipt(raw));
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    try {
      if (!authenticate(req, env)) return withCors(json({ error: 'Unauthorized' }, 401), env);
      const url = new URL(req.url);
      const path = url.pathname;
      let res: Response;
      if (req.method === 'POST' && path === '/plaid/link-token') res = await handleLinkToken(req, env);
      else if (req.method === 'POST' && path === '/plaid/exchange') res = await handleExchange(req, env);
      else if (req.method === 'POST' && path === '/plaid/transactions') res = await handleTransactions(req, env);
      else if (req.method === 'POST' && path === '/splitwise/exchange') res = await handleSplitwiseExchange(req, env);
      else if ((req.method === 'GET' || req.method === 'POST') && path.startsWith('/splitwise/api/')) {
        res = await handleSplitwiseProxy(req, path.slice('/splitwise/api'.length) + url.search);
      } else if (req.method === 'POST' && path === '/receipt/parse') res = await handleReceiptParse(req, env);
      else res = json({ error: 'Not Found' }, 404);
      return withCors(res, env);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return withCors(json({ error: 'INVALID_REQUEST_BODY' }, 400), env);
      }
      throw err;
    }
  },
};
