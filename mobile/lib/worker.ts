// mobile/lib/worker.ts
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { ParsedReceipt, PlaidTransactionsResponse, SplitwiseAuthResponse } from '@/lib/types';

function getConfig() {
  return {
    baseUrl: Constants.expoConfig?.extra?.workerBaseUrl ?? '',
    apiKey: Constants.expoConfig?.extra?.workerApiKey ?? '',
  };
}

export class WorkerError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
    this.name = 'WorkerError';
  }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { baseUrl, apiKey } = getConfig();
  if (!baseUrl.trim() || !apiKey.trim()) {
    throw new Error(
      'Missing WORKER_BASE_URL or WORKER_API_KEY. Add them to .env and restart Expo so app.config.js can embed them.'
    );
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as { error?: string } & T;
  if (!res.ok) {
    throw new WorkerError((data as { error?: string }).error ?? 'WORKER_ERROR', res.status);
  }
  return data;
}

export async function getLinkToken(): Promise<{ link_token: string }> {
  return post('/plaid/link-token', { platform: Platform.OS === 'web' ? 'web' : 'mobile' });
}

export async function exchangePublicToken(
  public_token: string
): Promise<{ access_token: string }> {
  return post('/plaid/exchange', { public_token });
}

export async function fetchTransactions(
  access_token: string,
  cursor?: string
): Promise<PlaidTransactionsResponse> {
  const body: Record<string, unknown> = { access_token };
  if (cursor !== undefined) body.cursor = cursor;
  return post('/plaid/transactions', body);
}

export async function exchangeSplitwiseCode(
  code: string,
  redirect_uri: string
): Promise<SplitwiseAuthResponse> {
  return post('/splitwise/exchange', { code, redirect_uri });
}

export async function parseReceipt(
  image_base64: string,
  mime_type = 'image/jpeg'
): Promise<ParsedReceipt> {
  return post('/receipt/parse', { image_base64, mime_type });
}
