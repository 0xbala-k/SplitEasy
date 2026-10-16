// mobile/__tests__/lib/receiptImage.web.test.ts
//
// The PWA path can't use expo-image-manipulator: its web build exports the
// canvas with a bare `canvas.toBlob(cb)` (PNG) and ignores `format`/`compress`,
// so a photo with a busy background blew past the Worker's 7MB body cap (413).
// These tests stub the DOM image/canvas APIs the web encoder relies on.
import { encodeReceiptImage } from '@/lib/receiptImage.web';

interface FakeCanvas {
  width: number;
  height: number;
  getContext: jest.Mock;
  toDataURL: jest.Mock;
}

let canvas: FakeCanvas;
let drawImage: jest.Mock;
let imageSize = { width: 3024, height: 4032 };
let imageFails = false;

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  set src(_uri: string) {
    setTimeout(() => {
      if (imageFails) {
        this.onerror?.(new Error('decode failed'));
        return;
      }
      this.naturalWidth = imageSize.width;
      this.naturalHeight = imageSize.height;
      this.onload?.();
    }, 0);
  }
}

beforeEach(() => {
  imageSize = { width: 3024, height: 4032 };
  imageFails = false;
  drawImage = jest.fn();
  canvas = {
    width: 0,
    height: 0,
    getContext: jest.fn(() => ({ drawImage })),
    toDataURL: jest.fn(() => 'data:image/jpeg;base64,JPEGDATA'),
  };
  (globalThis as unknown as { Image: unknown }).Image = FakeImage;
  (globalThis as unknown as { document: unknown }).document = {
    createElement: jest.fn(() => canvas),
  };
});

test('downscales to 1600px wide and encodes as JPEG at 0.7 quality', async () => {
  const base64 = await encodeReceiptImage('data:image/jpeg;base64,RAW');

  expect(canvas.width).toBe(1600);
  expect(canvas.height).toBe(Math.round(4032 * (1600 / 3024)));
  expect(drawImage).toHaveBeenCalledWith(expect.any(FakeImage), 0, 0, canvas.width, canvas.height);
  expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.7);
  expect(base64).toBe('JPEGDATA');
});

test('does not upscale an image already narrower than 1600px', async () => {
  imageSize = { width: 800, height: 1200 };
  await encodeReceiptImage('data:image/jpeg;base64,RAW');
  expect(canvas.width).toBe(800);
  expect(canvas.height).toBe(1200);
});

test('rejects when the browser falls back to PNG instead of JPEG', async () => {
  canvas.toDataURL.mockReturnValue('data:image/png;base64,PNGDATA');
  await expect(encodeReceiptImage('data:image/jpeg;base64,RAW')).rejects.toThrow(/JPEG/);
});

test('rejects when the image cannot be decoded', async () => {
  imageFails = true;
  await expect(encodeReceiptImage('data:image/jpeg;base64,RAW')).rejects.toThrow();
});
