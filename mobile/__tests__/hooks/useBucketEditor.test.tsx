jest.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModal: require('react').forwardRef(
    ({ children }: { children: React.ReactNode }, _r: unknown) => children ?? null
  ),
}));

import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { render, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ToastProvider } from '@/components/ToastProvider';
import { useBucketEditor } from '@/hooks/useBucketEditor';
import { BucketLockedError } from '@/lib/vacationErrors';
import { Bucket } from '@/lib/buckets';

// A minimal host, since the hook owns a ref and an effect and has to run
// inside a real component tree with the toast context above it.
function Host({
  write, onDone,
}: {
  write: (ids: string[], bucket: Bucket) => Promise<void>;
  onDone?: () => void;
}) {
  const { open, sheetProps } = useBucketEditor(write, onDone);
  return (
    <View>
      <Pressable
        accessibilityLabel="open"
        onPress={() => open({ ids: ['a', 'b'], merchantName: 'Chipotle', bucket: 'food', locked: false })}
      />
      <Pressable accessibilityLabel="choose" onPress={() => sheetProps.onSelect('shopping')} />
      <Text testID="bucket">{String(sheetProps.bucket)}</Text>
      <Text testID="merchant">{sheetProps.merchantName}</Text>
      <Text testID="locked">{String(sheetProps.locked)}</Text>
    </View>
  );
}

function renderHost(write: (ids: string[], b: Bucket) => Promise<void>, onDone?: () => void) {
  return render(
    <ToastProvider>
      <Host write={write} onDone={onDone} />
    </ToastProvider>
  );
}

test('starts with no target', () => {
  renderHost(jest.fn().mockResolvedValue(undefined));
  expect(screen.getByTestId('bucket').props.children).toBe('null');
  expect(screen.getByTestId('merchant').props.children).toBe('');
});

test('open populates the sheet props from the target', async () => {
  renderHost(jest.fn().mockResolvedValue(undefined));
  fireEvent.press(screen.getByLabelText('open'));
  await waitFor(() => expect(screen.getByTestId('bucket').props.children).toBe('food'));
  expect(screen.getByTestId('merchant').props.children).toBe('Chipotle');
  expect(screen.getByTestId('locked').props.children).toBe('false');
});

test('selecting writes every id in the target', async () => {
  const write = jest.fn().mockResolvedValue(undefined);
  renderHost(write);
  fireEvent.press(screen.getByLabelText('open'));
  fireEvent.press(screen.getByLabelText('choose'));
  await waitFor(() => expect(write).toHaveBeenCalledWith(['a', 'b'], 'shopping'));
});

test('selecting without a target does nothing', async () => {
  const write = jest.fn().mockResolvedValue(undefined);
  renderHost(write);
  fireEvent.press(screen.getByLabelText('choose'));
  await waitFor(() => expect(write).not.toHaveBeenCalled());
});

test('onDone runs after a successful write', async () => {
  const onDone = jest.fn();
  renderHost(jest.fn().mockResolvedValue(undefined), onDone);
  fireEvent.press(screen.getByLabelText('open'));
  fireEvent.press(screen.getByLabelText('choose'));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

test('a locked write surfaces the lock message and does not call onDone', async () => {
  const onDone = jest.fn();
  const write = jest.fn().mockRejectedValue(new BucketLockedError());
  renderHost(write, onDone);
  fireEvent.press(screen.getByLabelText('open'));
  fireEvent.press(screen.getByLabelText('choose'));
  await waitFor(() => expect(screen.getByText(/part of a vacation/i)).toBeTruthy());
  expect(onDone).not.toHaveBeenCalled();
});

test('any other failure surfaces a generic message', async () => {
  const write = jest.fn().mockRejectedValue(new Error('boom'));
  renderHost(write);
  fireEvent.press(screen.getByLabelText('open'));
  fireEvent.press(screen.getByLabelText('choose'));
  await waitFor(() => expect(screen.getByText(/Could not change the category/i)).toBeTruthy());
});
