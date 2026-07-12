// mobile/lib/splitwiseTransport.ts
// Native transport: call the Splitwise API directly. The web override
// (splitwiseTransport.web.ts) tunnels through the Cloudflare Worker because
// Splitwise does not send CORS headers.
import { getSecure, KEYS } from '@/lib/secure';

const BASE = 'https://secure.splitwise.com/api/v3.0';

export interface SplitwiseFetchInit {
  method?: 'GET' | 'POST';
  body?: string;
  contentType?: string;
}

export async function splitwiseFetch(path: string, init?: SplitwiseFetchInit): Promise<Response> {
  const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
  return fetch(`${BASE}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    body: init?.body,
  });
}
