jest.mock('@/lib/secure', () => ({
  getSecure: jest.fn().mockResolvedValue('sw-token'),
  KEYS: { SPLITWISE_ACCESS_TOKEN: 'splitwise_access_token' },
}));

import { splitwiseFetch } from '@/lib/splitwiseTransport';

describe('splitwiseTransport (native)', () => {
  const fetchMock = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));

  beforeEach(() => {
    fetchMock.mockClear();
    (globalThis as Record<string, unknown>).fetch = fetchMock;
  });

  it('calls the Splitwise API directly with the user token', async () => {
    await splitwiseFetch('/get_friends');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://secure.splitwise.com/api/v3.0/get_friends');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer sw-token' });
    expect(init.method).toBe('GET');
  });

  it('passes through POST body and content type', async () => {
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
