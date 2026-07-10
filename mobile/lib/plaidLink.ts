// mobile/lib/plaidLink.ts
// Native Plaid Link via react-native-plaid-link-sdk. plaidLink.web.ts provides
// the same API on top of Plaid's Link JS SDK, keeping the native module out of
// the web bundle.
import { Platform, TurboModuleRegistry } from 'react-native';
import {
  create, open, destroy, LinkLogLevel, LinkIOSPresentationStyle,
} from 'react-native-plaid-link-sdk';

export interface PlaidLinkResult {
  publicToken: string;
  institutionName: string;
}

export interface PlaidLinkHandlers {
  onSuccess: (result: PlaidLinkResult) => void;
  onExit: () => void;
}

/** False in Expo Go and any JS-only build where Plaid native code was not compiled in. */
export function isPlaidLinkAvailable(): boolean {
  const MODULE = Platform.OS === 'android' ? 'PlaidAndroid' : 'RNLinksdk';
  return TurboModuleRegistry.get(MODULE) != null;
}

export async function openPlaidLink(linkToken: string, handlers: PlaidLinkHandlers): Promise<void> {
  await destroy().catch(() => {});
  create({ token: linkToken, logLevel: LinkLogLevel.ERROR, noLoadingState: false });
  requestAnimationFrame(() => {
    open({
      iOSPresentationStyle: LinkIOSPresentationStyle.MODAL,
      onSuccess: (s) => {
        handlers.onSuccess({
          publicToken: s.publicToken,
          institutionName: s.metadata.institution?.name ?? 'Your bank',
        });
      },
      onExit: () => handlers.onExit(),
    });
  });
}

export async function disposePlaidLink(): Promise<void> {
  await destroy().catch(() => {});
}
