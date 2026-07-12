jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { workerBaseUrl: 'https://worker.example/', workerApiKey: 'wk-key' } } },
}));
jest.mock('@/lib/secure', () => ({
  getSecure: jest.fn().mockResolvedValue('sw-token'),
  KEYS: { SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token' },
}));

import { splitwiseFetch } from '@/lib/splitwiseTransport.web';

describe('splitwiseTransport (web)', () => {
  const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));

  beforeEach(() => {
    fetchMock.mockClear();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  it('routes through the worker proxy with both auth headers', async () => {
    await splitwiseFetch('/get_friends');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://worker.example/splitwise/api/get_friends');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer wk-key',
      'X-Splitwise-Token': 'sw-token',
    });
    expect(init.method).toBe('GET');
  });

  it('passes through POST method, body, and content type', async () => {
    await splitwiseFetch('/create_expense', {
      method: 'POST',
      contentType: 'application/x-www-form-urlencoded',
      body: 'cost=1.00',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('cost=1.00');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('splitwiseTransport (web) — missing config', () => {
  beforeEach(() => {
    jest.resetModules();
    (globalThis as Record<string, unknown>).fetch = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
  });

  it('throws instead of fetching when worker config is absent', async () => {
    jest.doMock('expo-constants', () => ({
      __esModule: true,
      default: { expoConfig: { extra: {} } },
    }));
    jest.doMock('@/lib/secure', () => ({
      getSecure: jest.fn().mockResolvedValue('sw-token'),
      KEYS: { SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token' },
    }));
    let guarded: typeof splitwiseFetch;
    jest.isolateModules(() => {
      guarded = require('@/lib/splitwiseTransport.web').splitwiseFetch;
    });
    await expect(guarded!('/get_friends')).rejects.toThrow(/Missing WORKER_BASE_URL/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
