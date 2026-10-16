// mobile/lib/receiptImage.web.ts
//
// PWA counterpart of receiptImage.ts. expo-image-manipulator's web build
// (13.0.6) can't be used here: it exports its canvas with a bare
// `canvas.toBlob(cb)` — i.e. PNG — and saveAsync ignores `format` and
// `compress`. A receipt photo with a busy background (e.g. a concrete floor)
// came out as a >5MB PNG and the Worker rejected it with 413 IMAGE_TOO_LARGE.
// Drawing to our own canvas and asking for JPEG explicitly fixes that.
import { JPEG_QUALITY, MAX_DIMENSION } from '@/lib/receiptImageConfig';

function loadImage(uri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Unable to decode receipt image'));
    img.src = uri;
  });
}

// `width` is accepted for signature parity with the native module; the
// decoded image's natural size is authoritative here.
export async function encodeReceiptImage(uri: string, _width?: number): Promise<string> {
  const img = await loadImage(uri);
  const scale = Math.min(1, MAX_DIMENSION / img.naturalWidth);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // toDataURL silently falls back to PNG for unsupported types — the exact
  // failure this module exists to avoid — so verify what we got.
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  const prefix = 'data:image/jpeg;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('Browser could not encode JPEG');
  return dataUrl.slice(prefix.length);
}
