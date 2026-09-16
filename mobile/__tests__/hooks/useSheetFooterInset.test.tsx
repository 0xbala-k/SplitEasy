// mobile/__tests__/hooks/useSheetFooterInset.test.tsx
let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

import { Text, View } from 'react-native';
import { render, fireEvent, screen } from '@testing-library/react-native';
import { useSheetFooterInset } from '@/hooks/useSheetFooterInset';

// Exercise the hook the way a sheet does: measure a footer, pad a scrollable.
function Harness({ gap }: { gap?: number }) {
  const { onFooterLayout, contentPaddingBottom } = useSheetFooterInset(gap);
  return (
    <View>
      <View testID="footer" onLayout={onFooterLayout} />
      <Text testID="padding">{String(contentPaddingBottom)}</Text>
    </View>
  );
}

function layout(height: number) {
  fireEvent(screen.getByTestId('footer'), 'layout', {
    nativeEvent: { layout: { height, width: 320, x: 0, y: 0 } },
  });
}

function padding(): number {
  return Number(screen.getByTestId('padding').props.children);
}

beforeEach(() => {
  mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
});

test('reserves the measured footer height plus a breathing gap', () => {
  render(<Harness gap={16} />);
  layout(84);
  expect(padding()).toBe(100);
});

test('adds the safe-area inset the footer is lifted by', () => {
  // BottomSheetFooter takes bottomInset={insets.bottom} and translates up by
  // it, so that strip covers the scrollable too and must be reserved as well.
  mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
  render(<Harness gap={16} />);
  layout(84);
  expect(padding()).toBe(134);
});

test('tracks a footer that changes height', () => {
  render(<Harness gap={16} />);
  layout(84);
  layout(120);
  expect(padding()).toBe(136);
});

test('reserves a usable fallback before the first measurement', () => {
  mockInsets = { top: 0, bottom: 34, left: 0, right: 0 };
  render(<Harness gap={16} />);
  // No layout pass yet — the first frame must still clear a typical CTA
  // rather than render content under it.
  expect(padding()).toBeGreaterThanOrEqual(84);
});

test('ignores sub-pixel remeasurements so layout cannot oscillate', () => {
  render(<Harness gap={16} />);
  layout(84);
  const before = padding();
  layout(84.4);
  expect(padding()).toBe(before);
});
