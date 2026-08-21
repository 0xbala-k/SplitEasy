import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { BucketChip } from '@/components/BucketChip';

test('renders the bucket label', () => {
  render(<BucketChip bucket="food" />);
  expect(screen.getByText('Food')).toBeTruthy();
});

test('is pressable when onPress is given', () => {
  const onPress = jest.fn();
  render(<BucketChip bucket="needs" onPress={onPress} />);
  fireEvent.press(screen.getByLabelText('Category: Needs. Tap to change.'));
  expect(onPress).toHaveBeenCalled();
});

test('a locked chip announces why it cannot be changed', () => {
  render(<BucketChip bucket="travel" locked onPress={jest.fn()} />);
  expect(screen.getByLabelText('Category: Travel, set by a vacation.')).toBeTruthy();
});

test('without onPress it renders no button role', () => {
  render(<BucketChip bucket="misc" />);
  expect(screen.queryByLabelText('Category: Misc. Tap to change.')).toBeNull();
  expect(screen.getByText('Misc')).toBeTruthy();
});
