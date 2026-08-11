// mobile/lib/receiptScan.ts
//
// Capture pipeline for the Receipt split mode: pick/take a photo, downscale +
// compress it client-side (so the Worker's request body and the Gemini call
// stay small and fast), then send it to the Worker for structured parsing.
//
// Single cross-platform implementation — confirmed against the actual
// installed source of expo-image-manipulator's web build that manipulateAsync
// loads the `uri` argument via `new Image(); img.src = uri` (a standard Web
// Platform API that accepts `data:` URIs by spec), and that expo-image-picker's
// web picker returns exactly a `data:` URI as `asset.uri` (via
// `FileReader.readAsDataURL`). See task-4-report.md for the full trace.
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { parseReceipt, WorkerError } from '@/lib/worker';
import { ParsedReceipt } from '@/lib/types';

export type ReceiptScanOutcome =
  | { status: 'cancelled' }
  | { status: 'ok'; receipt: ParsedReceipt }
  | { status: 'failed'; reason: 'parse' | 'network' | 'image' };

const MAX_DIMENSION = 1600;

export async function scanReceipt(source: 'camera' | 'library'): Promise<ReceiptScanOutcome> {
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

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(pickerOptions)
      : await ImagePicker.launchImageLibraryAsync(pickerOptions);

  if (result.canceled) {
    return { status: 'cancelled' };
  }

  const asset = result.assets[0];

  let base64: string | undefined;
  try {
    const actions = asset.width && asset.width < MAX_DIMENSION ? [] : [{ resize: { width: MAX_DIMENSION } }];
    const manipulated = await manipulateAsync(asset.uri, actions, {
      compress: 0.7,
      format: SaveFormat.JPEG,
      base64: true,
    });
    base64 = manipulated.base64;
    if (!base64) throw new Error('manipulateAsync returned no base64 output');
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
