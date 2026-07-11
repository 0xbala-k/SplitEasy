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
