// mobile/lib/dialog.ts
import { Alert } from 'react-native';

export interface DialogButton {
  text: string;
  style?: 'default' | 'cancel' | 'destructive';
  onPress?: () => void;
}

// Cross-platform confirm/alert. Native uses Alert.alert; dialog.web.ts maps the
// same button semantics onto window.confirm / window.alert.
export function showDialog(title: string, message: string, buttons?: DialogButton[]): void {
  Alert.alert(title, message, buttons);
}
