jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _ref: unknown) => <View>{children}</View>
    ),
    BottomSheetFlatList: ({
      data, renderItem, ListHeaderComponent, ListEmptyComponent, keyExtractor,
    }: any) => {
      const Header = typeof ListHeaderComponent === 'function' ? ListHeaderComponent : () => ListHeaderComponent;
      const Empty = typeof ListEmptyComponent === 'function' ? ListEmptyComponent : () => ListEmptyComponent;
      return (
        <View>
          <Header />
          {data.length === 0 && <Empty />}
          {data.map((item: any) => (
            <View key={keyExtractor(item)}>{renderItem({ item })}</View>
          ))}
        </View>
      );
    },
  };
});

import React from 'react';
import { render, fireEvent } from '@testing-library/react-native';
import { GroupPickerSheet } from '@/components/GroupPickerSheet';
import { SplitwiseGroup } from '@/lib/types';

const groups: SplitwiseGroup[] = [
  { id: 'g1', name: 'Roommates', member_ids: ['1', '2'], member_names: ['Alice', 'Bob'] },
  { id: 'g2', name: 'Japan 2026', member_ids: ['1', '3'], member_names: ['Alice', 'Cara'] },
];

test('lists every group plus a None row', () => {
  const { getByText } = render(
    <GroupPickerSheet groups={groups} selectedGroupId={null} onSelect={jest.fn()} />
  );
  expect(getByText('Roommates')).toBeTruthy();
  expect(getByText('Japan 2026')).toBeTruthy();
  expect(getByText('None')).toBeTruthy();
});

test('picking a group reports the whole group, not just its id', () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <GroupPickerSheet groups={groups} selectedGroupId={null} onSelect={onSelect} />
  );

  fireEvent.press(getByText('Japan 2026'));

  expect(onSelect).toHaveBeenCalledWith(groups[1]);
});

test('tapping the already-selected row reports that group, never null', () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <GroupPickerSheet groups={groups} selectedGroupId="g1" onSelect={onSelect} />
  );

  fireEvent.press(getByText('Roommates'));

  expect(onSelect).toHaveBeenCalledWith(groups[0]);
  expect(onSelect).not.toHaveBeenCalledWith(null);
});

test('picking None reports null', () => {
  const onSelect = jest.fn();
  const { getByText } = render(
    <GroupPickerSheet groups={groups} selectedGroupId="g1" onSelect={onSelect} />
  );

  fireEvent.press(getByText('None'));

  expect(onSelect).toHaveBeenCalledWith(null);
});

test('marks the current selection as checked', () => {
  const { getByLabelText } = render(
    <GroupPickerSheet groups={groups} selectedGroupId="g1" onSelect={jest.fn()} />
  );
  expect(getByLabelText('Roommates').props.accessibilityState.checked).toBe(true);
  expect(getByLabelText('Japan 2026').props.accessibilityState.checked).toBe(false);
});

test('says that existing expenses are not moved', () => {
  const { getByText } = render(
    <GroupPickerSheet groups={groups} selectedGroupId={null} onSelect={jest.fn()} />
  );
  expect(getByText(/Splits already created stay where they are/)).toBeTruthy();
});

test('renders an empty state when there are no groups', () => {
  const { getByText } = render(
    <GroupPickerSheet groups={[]} selectedGroupId={null} onSelect={jest.fn()} />
  );
  expect(getByText('No Splitwise groups found.')).toBeTruthy();
});
