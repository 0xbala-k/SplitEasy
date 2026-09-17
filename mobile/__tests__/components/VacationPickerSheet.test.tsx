jest.mock('@gorhom/bottom-sheet', () => {
  const { View } = require('react-native');
  return {
    BottomSheetModal: require('react').forwardRef(
      ({ children }: { children: React.ReactNode }, _ref: unknown) => <View>{children}</View>
    ),
    BottomSheetFlatList: ({
      data, renderItem, ListHeaderComponent, ListEmptyComponent, keyExtractor, contentContainerStyle,
    }: any) => {
      const Header = typeof ListHeaderComponent === 'function' ? ListHeaderComponent : () => ListHeaderComponent;
      const Empty = typeof ListEmptyComponent === 'function' ? ListEmptyComponent : () => ListEmptyComponent;
      return (
        <View testID="content" style={contentContainerStyle}>
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
jest.mock('@expo/vector-icons', () => new Proxy({}, { get: () => () => null }));
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';
import { VacationPickerSheet } from '@/components/VacationPickerSheet';
import { Vacation } from '@/lib/types';
import { Spacing } from '@/lib/theme';

function vac(over: Partial<Vacation>): Vacation {
  return {
    id: 'v1', name: 'Tokyo', start_date: '2026-09-01', end_date: '2026-09-10',
    status: 'active', splitwise_group_id: null, splitwise_group_name: null,
    splitwise_group_member_ids: null, created_at: 'x', started_at: null, ended_at: null,
    ...over,
  } as Vacation;
}

const vacations: Vacation[] = [
  vac({ id: 'v1', name: 'Tokyo', status: 'active' }),
  vac({ id: 'v2', name: 'Banff', status: 'draft' }),
  vac({ id: 'v3', name: 'Iceland', status: 'ended' }),
];

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
});

test('lists every vacation, ended ones included, plus a None row', () => {
  const { getByText } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId={null} onSelect={jest.fn()} />
  );
  expect(getByText('Tokyo')).toBeTruthy();
  expect(getByText('Banff')).toBeTruthy();
  // A trip that has already ended is exactly the case this picker exists for:
  // a friend adds the trip dinner a week after everyone got home.
  expect(getByText('Iceland')).toBeTruthy();
  expect(getByText('None')).toBeTruthy();
});

test('labels each vacation with its status', () => {
  const { getByText } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId={null} onSelect={jest.fn()} />
  );
  expect(getByText('Active')).toBeTruthy();
  // Same wording the vacation list screen already uses for each status.
  expect(getByText('Draft')).toBeTruthy();
  expect(getByText('Ended')).toBeTruthy();
});

test('picking a vacation reports its id', () => {
  const onSelect = jest.fn();
  const { getByLabelText } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId={null} onSelect={onSelect} />
  );
  fireEvent.press(getByLabelText('Banff'));
  expect(onSelect).toHaveBeenCalledWith('v2');
});

test('picking None reports null', () => {
  const onSelect = jest.fn();
  const { getByLabelText } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId="v1" onSelect={onSelect} />
  );
  fireEvent.press(getByLabelText('None'));
  expect(onSelect).toHaveBeenCalledWith(null);
});

test('marks the current selection as checked', () => {
  const { getByLabelText } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId="v3" onSelect={jest.fn()} />
  );
  expect(getByLabelText('Iceland').props.accessibilityState.checked).toBe(true);
  expect(getByLabelText('Tokyo').props.accessibilityState.checked).toBe(false);
  expect(getByLabelText('None').props.accessibilityState.checked).toBe(false);
});

test('reserves bottom padding for the home indicator on top of the base spacing', () => {
  mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
  const { getByTestId } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId={null} onSelect={jest.fn()} />
  );
  const { paddingBottom } = StyleSheet.flatten(getByTestId('content').props.style);
  // Old hardcoded Spacing.xxl alone omitted the safe-area inset entirely.
  expect(paddingBottom).toBe(Spacing.xxl + 34);
});

test('tells the user a vacation forces the bucket to Travel', () => {
  const { getByText } = render(
    <VacationPickerSheet vacations={vacations} selectedVacationId={null} onSelect={jest.fn()} />
  );
  expect(getByText(/counts as Travel/i)).toBeTruthy();
});
