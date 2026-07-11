// mobile/lib/splitwiseAuth.ts
// Native OAuth: in-app browser session returning to the custom URL scheme.
// splitwiseAuth.web.ts replaces this with a full-page redirect; the code lands
// on app/oauth/callback.tsx instead of resolving here.
import * as WebBrowser from 'expo-web-browser';
import * as Linking from 'expo-linking';

const REDIRECT_URI = 'spliteasy://oauth/callback';

function buildAuthUrl(clientId: string, redirectUri: string): string {
  return (
    'https://secure.splitwise.com/oauth/authorize' +
    `?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`
  );
}

export interface SplitwiseSignInResult {
  code: string;
  redirectUri: string;
}

export async function signInWithSplitwise(clientId: string): Promise<SplitwiseSignInResult | null> {
  const result = await WebBrowser.openAuthSessionAsync(buildAuthUrl(clientId, REDIRECT_URI), REDIRECT_URI);
  if (result.type !== 'success') return null;
  const url = Linking.parse(result.url);
  const code = url.queryParams?.code as string | undefined;
  if (!code) return null;
  return { code, redirectUri: REDIRECT_URI };
}
