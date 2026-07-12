// mobile/lib/dialog.web.ts
import type { DialogButton } from './dialog';

export type { DialogButton };

export function showDialog(title: string, message: string, buttons?: DialogButton[]): void {
  const text = message ? `${title}\n\n${message}` : title;
  const btns = buttons ?? [];
  if (btns.length <= 1) {
    window.alert(text);
    btns[0]?.onPress?.();
    return;
  }
  const cancel = btns.find((b) => b.style === 'cancel');
  // Last non-cancel button is the primary action (matches Alert.alert layout).
  const primary = [...btns].reverse().find((b) => b.style !== 'cancel');
  if (window.confirm(text)) primary?.onPress?.();
  else cancel?.onPress?.();
}
