// mobile/lib/splitwiseTransport.web.ts
import Constants from 'expo-constants';
import { getSecure, KEYS } from '@/lib/secure';
import type { SplitwiseFetchInit } from './splitwiseTransport';

export type { SplitwiseFetchInit };

export async function splitwiseFetch(path: string, init?: SplitwiseFetchInit): Promise<Response> {
  const baseUrl = String(Constants.expoConfig?.extra?.workerBaseUrl ?? '').replace(/\/$/, '');
  const apiKey = String(Constants.expoConfig?.extra?.workerApiKey ?? '');
  if (!baseUrl.trim() || !apiKey.trim()) {
    throw new Error(
      'Missing WORKER_BASE_URL or WORKER_API_KEY. Add them to .env and restart Expo so app.config.js can embed them.'
    );
  }
  const token = await getSecure(KEYS.SPLITWISE_ACCESS_TOKEN);
  return fetch(`${baseUrl}/splitwise/api${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'X-Splitwise-Token': token ?? '',
      ...(init?.contentType ? { 'Content-Type': init.contentType } : {}),
    },
    body: init?.body,
  });
}
