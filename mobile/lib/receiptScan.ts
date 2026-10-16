// mobile/lib/receiptScan.ts
//
// Capture pipeline for the Receipt split mode: pick/take a photo, downscale +
// compress it client-side (so the Worker's request body and the Gemini call
// stay small and fast), then send it to the Worker for structured parsing.
//
// The downscale/compress step is platform-split (receiptImage.ts vs
// receiptImage.web.ts): expo-image-manipulator's web build ignores
// format/compress and emits PNG, which pushed busy photos past the Worker's
// body cap. expo-image-picker's web picker returns a `data:` URI as
// `asset.uri`, which the web encoder loads via `new Image()`.
import * as ImagePicker from 'expo-image-picker';
import { encodeReceiptImage } from '@/lib/receiptImage';
import { parseReceipt, WorkerError } from '@/lib/worker';
import { ParsedReceipt } from '@/lib/types';

export type ReceiptScanOutcome =
  | { status: 'cancelled' }
  | { status: 'ok'; receipt: ParsedReceipt }
  | { status: 'failed'; reason: 'parse' | 'network' | 'image' };

export async function scanReceipt(source: 'camera' | 'library'): Promise<ReceiptScanOutcome> {
  // Picker/permission calls can reject with native OS errors (e.g. "Different
  // Image Picker is already presenting", Android activity failures) rather
  // than resolving — wrap them so `scanReceipt` always resolves to a
  // ReceiptScanOutcome and never rejects, matching the manipulator/parseReceipt
  // try/catches below and keeping callers (e.g. FriendPickerSheet's
  // runReceiptScan, which has no `catch`) from being left with an unhandled
  // rejection and no user feedback.
  let result: ImagePicker.ImagePickerResult;
  try {
    if (source === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        return { status: 'failed', reason: 'image' };
      }
    }

    const pickerOptions: ImagePicker.ImagePickerOptions = {
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 1,
      allowsEditing: false,
      base64: false,
    };

    result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync(pickerOptions)
        : await ImagePicker.launchImageLibraryAsync(pickerOptions);
  } catch {
    return { status: 'failed', reason: 'image' };
  }

  if (result.canceled) {
    return { status: 'cancelled' };
  }

  const asset = result.assets[0];

  let base64: string;
  try {
    base64 = await encodeReceiptImage(asset.uri, asset.width);
  } catch {
    return { status: 'failed', reason: 'image' };
  }

  try {
    const receipt = await parseReceipt(base64, 'image/jpeg');
    return { status: 'ok', receipt };
  } catch (err) {
    return { status: 'failed', reason: err instanceof WorkerError ? 'parse' : 'network' };
  }
}
