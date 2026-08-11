import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler, { type Env } from './index';
import { parseMoneyToCents, normalizeReceipt } from './receipt';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  PLAID_CLIENT_ID: 'test_client_id',
  PLAID_SECRET: 'test_secret',
  PLAID_ENV: 'sandbox',
  WORKER_API_KEY: 'test_api_key',
  SPLITWISE_CLIENT_ID: 'sw_client_id',
  SPLITWISE_CLIENT_SECRET: 'sw_secret',
  GEMINI_API_KEY: 'test_gemini_key',
  // GEMINI_MODEL intentionally left unset by default so tests can verify
  // the 'gemini-2.5-flash' fallback.
  ...overrides,
});

beforeEach(() => { mockFetch.mockReset(); });

describe('Worker auth middleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', { method: 'POST' });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('returns 401 when API key is wrong', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });
});

describe('POST /plaid/link-token', () => {
  it('returns link_token on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-sandbox-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { link_token: string };
    expect(body.link_token).toBe('link-sandbox-abc');
  });

  it('uses correct plaid base URL for sandbox vs production', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-prod-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    await handler.fetch(req, makeEnv({ PLAID_ENV: 'production' }), {} as ExecutionContext);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('production.plaid.com'),
      expect.anything()
    );
  });
});

describe('Route matching', () => {
  it('returns 404 for unknown route', async () => {
    const req = new Request('https://worker.example.com/foo', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Not Found');
  });

  it('returns 404 for non-POST method on valid path', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(404);
  });
});

describe('POST /plaid/exchange', () => {
  it('returns access_token on success', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: 'access-sandbox-xyz', item_id: 'item1' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token: 'public-sandbox-token' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { access_token: string };
    expect(body.access_token).toBe('access-sandbox-xyz');
  });

  it('returns 400 when public_token is missing', async () => {
    const req = new Request('https://worker.example.com/plaid/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('MISSING_PUBLIC_TOKEN');
  });

  it('returns 400 when request body is malformed JSON', async () => {
    const req = new Request('https://worker.example.com/plaid/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INVALID_REQUEST_BODY');
  });

  it('returns error when Plaid rejects the public_token', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'INVALID_PUBLIC_TOKEN' }), { status: 400 })
    );
    const req = new Request('https://worker.example.com/plaid/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ public_token: 'bad-token' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INVALID_PUBLIC_TOKEN');
  });
});

describe('POST /plaid/transactions', () => {
  it('strips credits (amount <= 0) from added', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        added: [
          { transaction_id: 'tx1', amount: 25.00, merchant_name: 'Coffee' },
          { transaction_id: 'tx2', amount: -10.00, merchant_name: 'Refund' },
        ],
        modified: [],
        removed: [],
        next_cursor: 'cursor-abc',
        has_more: false,
      }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'access-sandbox-xyz' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { added: { transaction_id: string }[] };
    expect(body.added).toHaveLength(1);
    expect(body.added[0].transaction_id).toBe('tx1');
  });

  it('strips credits (amount <= 0) from modified', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        added: [],
        modified: [
          { transaction_id: 'tx3', amount: 15.00, merchant_name: 'Lunch' },
          { transaction_id: 'tx4', amount: 0.00, merchant_name: 'Zero' },
        ],
        removed: [],
        next_cursor: 'cursor-xyz',
        has_more: false,
      }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'access-sandbox-xyz' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const body = await res.json() as { modified: { transaction_id: string }[] };
    expect(body.modified).toHaveLength(1);
    expect(body.modified[0].transaction_id).toBe('tx3');
  });

  it('returns 400 with ITEM_LOGIN_REQUIRED error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error_code: 'ITEM_LOGIN_REQUIRED' }), { status: 400 })
    );
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: 'access-sandbox-xyz' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('ITEM_LOGIN_REQUIRED');
  });

  it('returns 400 when request body is malformed JSON', async () => {
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INVALID_REQUEST_BODY');
  });

  it('returns 400 when access_token is missing', async () => {
    const req = new Request('https://worker.example.com/plaid/transactions', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('MISSING_ACCESS_TOKEN');
  });
});

describe('POST /splitwise/exchange', () => {
  it('returns access_token and user profile', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sw-token-abc' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          user: { id: 123, first_name: 'Bala', last_name: 'K', picture: { medium: 'https://img.url' } }
        }), { status: 200 })
      );
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-123', redirect_uri: 'spliteasy://oauth' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    // user_id is returned as a string (Worker converts Splitwise int ID to string)
    const body = await res.json() as { access_token: string; user_id: string; display_name: string };
    expect(body.access_token).toBe('sw-token-abc');
    expect(body.user_id).toBe('123');         // string, not number
    expect(body.display_name).toBe('Bala K');
  });

  it('returns 400 when Splitwise token endpoint returns an error', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })
    );
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'bad-code', redirect_uri: 'spliteasy://oauth' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  it('returns 400 when code is missing', async () => {
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ redirect_uri: 'spliteasy://oauth' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('MISSING_REQUIRED_PARAMS');
  });

  it('returns 400 when redirect_uri is missing', async () => {
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-123' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('MISSING_REQUIRED_PARAMS');
  });

  it('returns 400 when request body is malformed JSON', async () => {
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: 'not json',
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INVALID_REQUEST_BODY');
  });

  it('returns 502 when get_current_user fails after successful token exchange', async () => {
    mockFetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'sw-token-abc' }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      );
    const req = new Request('https://worker.example.com/splitwise/exchange', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'auth-code-123', redirect_uri: 'spliteasy://oauth' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('SPLITWISE_PROFILE_ERROR');
  });
});

describe('CORS', () => {
  it('answers preflight without auth', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', { method: 'OPTIONS' });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('X-Splitwise-Token');
  });

  it('adds CORS headers to normal responses', async () => {
    const req = new Request('https://worker.example.com/nope', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(404);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('honors ALLOWED_ORIGIN when set', async () => {
    const req = new Request('https://worker.example.com/plaid/link-token', { method: 'OPTIONS' });
    const res = await handler.fetch(req, makeEnv({ ALLOWED_ORIGIN: 'https://app.example' }), {} as ExecutionContext);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example');
  });
});

describe('Splitwise proxy', () => {
  it('forwards GET requests with the user token', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ friends: [] }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/splitwise/api/get_friends', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key', 'X-Splitwise-Token': 'user-tok' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/get_friends');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer user-tok');
    expect(init.method).toBe('GET');
  });

  it('forwards POST bodies and content type', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ expenses: [{ id: 1 }] }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/splitwise/api/create_expense', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test_api_key',
        'X-Splitwise-Token': 'user-tok',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'cost=1.00',
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/create_expense');
    expect(init.body).toBe('cost=1.00');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('forwards query strings to the upstream URL', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ expenses: [] }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/splitwise/api/get_expenses?group_id=5&limit=20', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key', 'X-Splitwise-Token': 'user-tok' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/get_expenses?group_id=5&limit=20');
  });

  it('passes through non-2xx upstream status', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Invalid API request' }), { status: 401 })
    );
    const req = new Request('https://worker.example.com/splitwise/api/get_friends', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key', 'X-Splitwise-Token': 'expired-tok' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
  });

  it('rejects proxy calls missing the Splitwise token', async () => {
    const req = new Request('https://worker.example.com/splitwise/api/get_friends', {
      method: 'GET',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('link-token platform', () => {
  it('omits android_package_name for web platform', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-web-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'web' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).not.toHaveProperty('android_package_name');
  });

  it('keeps android_package_name for mobile (no platform in body)', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ link_token: 'link-mobile-abc' }), { status: 200 })
    );
    const req = new Request('https://worker.example.com/plaid/link-token', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key' },
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toHaveProperty('android_package_name', 'com.spliteasy.app');
  });
});

function geminiResponse(rawReceipt: unknown, status = 200): Response {
  return new Response(JSON.stringify({
    candidates: [
      { content: { role: 'model', parts: [{ text: JSON.stringify(rawReceipt) }] } },
    ],
  }), { status });
}

describe('POST /receipt/parse', () => {
  const validBody = () => JSON.stringify({ image_base64: 'ZmFrZS1pbWFnZS1kYXRh', mime_type: 'image/jpeg' });

  it('returns 401 without auth', async () => {
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 MISSING_IMAGE when image_base64 is absent', async () => {
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mime_type: 'image/jpeg' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('MISSING_IMAGE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 413 IMAGE_TOO_LARGE when image_base64 exceeds 7,000,000 chars', async () => {
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: 'a'.repeat(7_000_001), mime_type: 'image/jpeg' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(413);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('IMAGE_TOO_LARGE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 400 UNSUPPORTED_MIME_TYPE for an unsupported mime type', async () => {
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64: 'ZmFrZQ==', mime_type: 'image/gif' }),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('UNSUPPORTED_MIME_TYPE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns 503 RECEIPT_PARSE_UNAVAILABLE when GEMINI_API_KEY is unset', async () => {
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const res = await handler.fetch(req, makeEnv({ GEMINI_API_KEY: '' }), {} as ExecutionContext);
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('RECEIPT_PARSE_UNAVAILABLE');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('happy path: calls Gemini with the right model/headers/config and returns normalized shape', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse({
      merchant: 'Trader Joes',
      currency: 'USD',
      items: [
        { name: 'Bananas', quantity: 2, price: '3.50' },
        { name: 'Milk', quantity: 1, price: '4.25' },
      ],
      subtotal: '7.75',
      tax: '0.65',
      tip: null,
      total: '8.40',
    }));
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(200);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('gemini-2.5-flash');
    expect(url).toContain('generativelanguage.googleapis.com');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test_gemini_key');
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.generationConfig.responseMimeType).toBe('application/json');
    expect(sentBody.contents[0].parts[0].inline_data.data).toBe('ZmFrZS1pbWFnZS1kYXRh');

    const body = await res.json() as {
      merchant: string | null;
      items: { name: string; quantity: number; price_cents: number }[];
      subtotal_cents: number | null;
      tax_cents: number;
      tip_cents: number;
      total_cents: number | null;
    };
    expect(body.merchant).toBe('Trader Joes');
    expect(body.items).toEqual([
      { name: 'Bananas', quantity: 2, price_cents: 350 },
      { name: 'Milk', quantity: 1, price_cents: 425 },
    ]);
    expect(body.subtotal_cents).toBe(775);
    expect(body.tax_cents).toBe(65);
    expect(body.tip_cents).toBe(0);
    expect(body.total_cents).toBe(840);
  });

  it('honors GEMINI_MODEL override in the outbound URL', async () => {
    mockFetch.mockResolvedValueOnce(geminiResponse({ items: [] }));
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: validBody(),
    });
    await handler.fetch(req, makeEnv({ GEMINI_MODEL: 'gemini-custom-model' }), {} as ExecutionContext);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('gemini-custom-model');
  });

  it('returns 502 RECEIPT_PARSE_FAILED when Gemini responds non-2xx', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: 'bad request' }), { status: 400 }));
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('RECEIPT_PARSE_FAILED');
  });

  it('returns 502 RECEIPT_PARSE_FAILED when Gemini candidate text is not valid JSON (not conflated with INVALID_REQUEST_BODY)', async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'not valid json {' }] } }],
    }), { status: 200 }));
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('RECEIPT_PARSE_FAILED');
  });

  it('returns 502 RECEIPT_PARSE_FAILED when fetch rejects with an AbortError', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    mockFetch.mockRejectedValueOnce(abortError);
    const req = new Request('https://worker.example.com/receipt/parse', {
      method: 'POST',
      headers: { Authorization: 'Bearer test_api_key', 'Content-Type': 'application/json' },
      body: validBody(),
    });
    const res = await handler.fetch(req, makeEnv(), {} as ExecutionContext);
    expect(res.status).toBe(502);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('RECEIPT_PARSE_FAILED');
  });
});

describe('parseMoneyToCents', () => {
  it('parses a plain dollar string', () => {
    expect(parseMoneyToCents('$12.99')).toBe(1299);
  });

  it('parses a comma-thousands string', () => {
    expect(parseMoneyToCents('1,234.50')).toBe(123450);
  });

  it('returns null for unparseable input', () => {
    expect(parseMoneyToCents('abc')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(parseMoneyToCents(null)).toBeNull();
  });
});

describe('normalizeReceipt', () => {
  it('derives tax from total - subtotal - tip when tax is absent, clamped >= 0', () => {
    const result = normalizeReceipt({
      items: [{ name: 'Widget', quantity: 1, price: '10.00' }],
      subtotal: '10.00',
      tax: null,
      tip: '2.00',
      total: '12.50',
    });
    // total - subtotal - tip = 12.50 - 10.00 - 2.00 = 0.50 -> 50 cents
    expect(result.tax_cents).toBe(50);
  });

  it('clamps derived tax to >= 0 when total undershoots subtotal + tip', () => {
    const result = normalizeReceipt({
      items: [{ name: 'Widget', quantity: 1, price: '10.00' }],
      subtotal: '10.00',
      tax: null,
      tip: '5.00',
      total: '11.00',
    });
    expect(result.tax_cents).toBe(0);
  });

  it('drops items with a blank name', () => {
    const result = normalizeReceipt({
      items: [
        { name: '', quantity: 1, price: '5.00' },
        { name: 'Valid Item', quantity: 1, price: '5.00' },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Valid Item');
  });

  it('drops items with an unparseable price', () => {
    const result = normalizeReceipt({
      items: [
        { name: 'Bad Price', quantity: 1, price: 'n/a' },
        { name: 'Valid Item', quantity: 1, price: '5.00' },
      ],
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Valid Item');
  });

  it('caps items at 200', () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ name: `Item ${i}`, quantity: 1, price: '1.00' }));
    const result = normalizeReceipt({ items });
    expect(result.items).toHaveLength(200);
  });

  it('never throws on malformed raw input', () => {
    expect(() => normalizeReceipt({})).not.toThrow();
    expect(() => normalizeReceipt({ items: null })).not.toThrow();
    expect(() => normalizeReceipt(null)).not.toThrow();
  });

  it('defaults tip_cents to 0 when tip is absent/unparseable', () => {
    const result = normalizeReceipt({ items: [], tip: null });
    expect(result.tip_cents).toBe(0);
  });
});
