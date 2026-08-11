// mobile/__tests__/lib/receiptScan.test.ts

jest.mock('expo-image-picker', () => ({
  MediaTypeOptions: { Images: 'Images' },
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
  launchImageLibraryAsync: jest.fn(),
}));

jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
  manipulateAsync: jest.fn(),
}));

jest.mock('@/lib/worker');

import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync } from 'expo-image-manipulator';
import { parseReceipt, WorkerError } from '@/lib/worker';
import { scanReceipt } from '@/lib/receiptScan';
import { ParsedReceipt } from '@/lib/types';

const mockRequestCameraPermissions = ImagePicker.requestCameraPermissionsAsync as jest.Mock;
const mockLaunchCamera = ImagePicker.launchCameraAsync as jest.Mock;
const mockLaunchLibrary = ImagePicker.launchImageLibraryAsync as jest.Mock;
const mockManipulate = manipulateAsync as jest.Mock;
const mockParseReceipt = parseReceipt as jest.Mock;

const SAMPLE_RECEIPT: ParsedReceipt = {
  merchant: 'Diner',
  items: [{ name: 'Eggs', quantity: 1, price_cents: 900 }],
  subtotal_cents: 900,
  tax_cents: 80,
  tip_cents: 0,
  total_cents: 980,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequestCameraPermissions.mockResolvedValue({ granted: true });
});

function mockAsset(overrides: Partial<{ uri: string; width: number; height: number }> = {}) {
  return { uri: 'file:///picked.jpg', width: 2000, height: 3000, ...overrides };
}

test('library pick cancelled returns {status: "cancelled"}', async () => {
  mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: null });
  const outcome = await scanReceipt('library');
  expect(outcome).toEqual({ status: 'cancelled' });
  expect(mockManipulate).not.toHaveBeenCalled();
});

test('camera pick cancelled returns {status: "cancelled"}', async () => {
  mockLaunchCamera.mockResolvedValue({ canceled: true, assets: null });
  const outcome = await scanReceipt('camera');
  expect(outcome).toEqual({ status: 'cancelled' });
});

test('camera permission denied returns {status: "failed", reason: "image"} without launching camera', async () => {
  mockRequestCameraPermissions.mockResolvedValue({ granted: false });
  const outcome = await scanReceipt('camera');
  expect(outcome).toEqual({ status: 'failed', reason: 'image' });
  expect(mockLaunchCamera).not.toHaveBeenCalled();
});

test('library pick does not request camera permission', async () => {
  mockLaunchLibrary.mockResolvedValue({ canceled: true, assets: null });
  await scanReceipt('library');
  expect(mockRequestCameraPermissions).not.toHaveBeenCalled();
});

test('launchCameraAsync rejecting (e.g. native picker-already-presenting error) returns {status: "failed", reason: "image"} instead of rejecting', async () => {
  mockLaunchCamera.mockRejectedValue(new Error('Different Image Picker is already presenting'));
  const outcome = await scanReceipt('camera');
  expect(outcome).toEqual({ status: 'failed', reason: 'image' });
  expect(mockManipulate).not.toHaveBeenCalled();
});

test('requestCameraPermissionsAsync rejecting returns {status: "failed", reason: "image"} instead of rejecting', async () => {
  mockRequestCameraPermissions.mockRejectedValue(new Error('native permission error'));
  const outcome = await scanReceipt('camera');
  expect(outcome).toEqual({ status: 'failed', reason: 'image' });
  expect(mockLaunchCamera).not.toHaveBeenCalled();
});

test('manipulator throwing returns {status: "failed", reason: "image"}', async () => {
  mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [mockAsset()] });
  mockManipulate.mockRejectedValue(new Error('manipulation failed'));
  const outcome = await scanReceipt('library');
  expect(outcome).toEqual({ status: 'failed', reason: 'image' });
  expect(mockParseReceipt).not.toHaveBeenCalled();
});

test('worker throwing WorkerError returns {status: "failed", reason: "parse"}', async () => {
  mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [mockAsset()] });
  mockManipulate.mockResolvedValue({ uri: 'file:///out.jpg', width: 1600, height: 2400, base64: 'b64out' });
  mockParseReceipt.mockRejectedValue(new WorkerError('RECEIPT_PARSE_FAILED', 502));
  const outcome = await scanReceipt('library');
  expect(outcome).toEqual({ status: 'failed', reason: 'parse' });
});

test('worker throwing a non-WorkerError returns {status: "failed", reason: "network"}', async () => {
  mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [mockAsset()] });
  mockManipulate.mockResolvedValue({ uri: 'file:///out.jpg', width: 1600, height: 2400, base64: 'b64out' });
  mockParseReceipt.mockRejectedValue(new TypeError('Network request failed'));
  const outcome = await scanReceipt('library');
  expect(outcome).toEqual({ status: 'failed', reason: 'network' });
});

test('happy path: resizes to 1600 wide, compresses, base64s, and passes manipulator output (not picker raw asset) to parseReceipt', async () => {
  const asset = mockAsset({ uri: 'file:///picked.jpg', width: 2000, height: 3000 });
  mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [asset] });
  mockManipulate.mockResolvedValue({
    uri: 'file:///manipulated.jpg',
    width: 1600,
    height: 2400,
    base64: 'MANIPULATED_BASE64',
  });
  mockParseReceipt.mockResolvedValue(SAMPLE_RECEIPT);

  const outcome = await scanReceipt('library');

  expect(mockManipulate).toHaveBeenCalledWith(
    'file:///picked.jpg',
    [{ resize: { width: 1600 } }],
    { compress: 0.7, format: 'jpeg', base64: true }
  );
  expect(mockParseReceipt).toHaveBeenCalledWith('MANIPULATED_BASE64', 'image/jpeg');
  expect(outcome).toEqual({ status: 'ok', receipt: SAMPLE_RECEIPT });
});

test('skips the resize action when the asset is already narrower than 1600px (does not upscale)', async () => {
  const asset = mockAsset({ uri: 'file:///small.jpg', width: 800, height: 1200 });
  mockLaunchLibrary.mockResolvedValue({ canceled: false, assets: [asset] });
  mockManipulate.mockResolvedValue({
    uri: 'file:///manipulated.jpg',
    width: 800,
    height: 1200,
    base64: 'SMALL_BASE64',
  });
  mockParseReceipt.mockResolvedValue(SAMPLE_RECEIPT);

  await scanReceipt('library');

  expect(mockManipulate).toHaveBeenCalledWith(
    'file:///small.jpg',
    [],
    { compress: 0.7, format: 'jpeg', base64: true }
  );
});

test('camera flow passes options through to launchCameraAsync', async () => {
  mockLaunchCamera.mockResolvedValue({ canceled: false, assets: [mockAsset()] });
  mockManipulate.mockResolvedValue({ uri: 'file:///out.jpg', width: 1600, height: 2400, base64: 'b64out' });
  mockParseReceipt.mockResolvedValue(SAMPLE_RECEIPT);

  await scanReceipt('camera');

  expect(mockLaunchCamera).toHaveBeenCalledWith({
    mediaTypes: 'Images',
    quality: 1,
    allowsEditing: false,
    base64: false,
  });
});
