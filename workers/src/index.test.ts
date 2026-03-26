import { describe, it, expect, vi, beforeEach } from 'vitest';
import handler, { type Env } from './index';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  PLAID_CLIENT_ID: 'test_client_id',
  PLAID_SECRET: 'test_secret',
  PLAID_ENV: 'sandbox',
  WORKER_API_KEY: 'test_api_key',
  SPLITWISE_CLIENT_ID: 'sw_client_id',
  SPLITWISE_CLIENT_SECRET: 'sw_secret',
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
