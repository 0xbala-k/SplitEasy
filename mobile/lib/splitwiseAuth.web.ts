// mobile/lib/splitwiseAuth.web.ts
import type { SplitwiseSignInResult } from './splitwiseAuth';

export type { SplitwiseSignInResult };

export function getWebRedirectUri(): string {
  return `${window.location.origin}/oauth/callback`;
}

// Full-page redirect: the browser leaves the app and Splitwise sends the user
// back to /oauth/callback?code=..., handled by app/oauth/callback.tsx. Always
// resolves null — the navigation takes over.
export async function signInWithSplitwise(clientId: string): Promise<SplitwiseSignInResult | null> {
  const url =
    'https://secure.splitwise.com/oauth/authorize' +
    `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(getWebRedirectUri())}`;
  window.location.assign(url);
  return null;
}
