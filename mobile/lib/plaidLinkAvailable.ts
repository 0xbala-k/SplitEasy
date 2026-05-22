import { Platform, TurboModuleRegistry } from 'react-native';

const MODULE = Platform.OS === 'android' ? 'PlaidAndroid' : 'RNLinksdk';

/** False in Expo Go and any JS-only build where Plaid native code was not compiled in. */
export function isPlaidLinkNativeAvailable(): boolean {
  return TurboModuleRegistry.get(MODULE) != null;
}
