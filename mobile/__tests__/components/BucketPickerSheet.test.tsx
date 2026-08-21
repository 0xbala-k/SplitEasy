jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _ref: unknown) => <View>{children}</View>
    ),
    BottomSheetView: ({ children }: { children: React.ReactNode }) => <View>{children}</View>,
  };
});

import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { BucketPickerSheet } from '@/components/BucketPickerSheet';

test('renders every bucket as a choice', () => {
  render(<BucketPickerSheet bucket="food" merchantName="Chipotle" onSelect={jest.fn()} />);
  for (const label of ['Travel', 'Needs', 'Food', 'Shopping', 'Experiences', 'Misc']) {
    expect(screen.getByLabelText(`Move Chipotle to ${label}`)).toBeTruthy();
  }
});

test('selecting a bucket reports it', () => {
  const onSelect = jest.fn();
  render(<BucketPickerSheet bucket="food" merchantName="Chipotle" onSelect={onSelect} />);
  fireEvent.press(screen.getByLabelText('Move Chipotle to Shopping'));
  expect(onSelect).toHaveBeenCalledWith('shopping');
});

test('renders nothing without a bucket', () => {
  const { toJSON } = render(
    <BucketPickerSheet bucket={null} merchantName="Chipotle" onSelect={jest.fn()} />
  );
  expect(toJSON()).toBeNull();
});

test('a locked sheet explains the vacation instead of listing buckets', () => {
  const onSelect = jest.fn();
  render(
    <BucketPickerSheet
      bucket="travel" merchantName="Hotel" locked
      onSelect={onSelect} onRemoveFromVacation={jest.fn()}
    />
  );
  expect(screen.queryByLabelText('Move Hotel to Food')).toBeNull();
  expect(screen.getByText(/part of a vacation/i)).toBeTruthy();
});

test('a locked sheet offers to remove the transaction from the vacation', () => {
  const onRemoveFromVacation = jest.fn();
  render(
    <BucketPickerSheet
      bucket="travel" merchantName="Hotel" locked
      onSelect={jest.fn()} onRemoveFromVacation={onRemoveFromVacation}
    />
  );
  fireEvent.press(screen.getByLabelText('Remove Hotel from vacation'));
  expect(onRemoveFromVacation).toHaveBeenCalled();
});
