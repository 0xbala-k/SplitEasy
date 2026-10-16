// mobile/lib/receiptImage.ts
//
// Downscale + JPEG-compress a picked receipt photo and return its base64.
// Native only — expo-image-manipulator ignores format/compress on web, so the
// PWA uses receiptImage.web.ts instead (see the note there).
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { JPEG_QUALITY, MAX_DIMENSION } from '@/lib/receiptImageConfig';

export async function encodeReceiptImage(uri: string, width?: number): Promise<string> {
  const actions = width && width < MAX_DIMENSION ? [] : [{ resize: { width: MAX_DIMENSION } }];
  const manipulated = await manipulateAsync(uri, actions, {
    compress: JPEG_QUALITY,
    format: SaveFormat.JPEG,
    base64: true,
  });
  if (!manipulated.base64) throw new Error('manipulateAsync returned no base64 output');
  return manipulated.base64;
}
