// mobile/hooks/useSheetFooterInset.ts
import { useCallback, useState } from 'react';
import { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spacing } from '@/lib/theme';

/**
 * Height to reserve before the footer has been measured. Every pinned CTA in
 * the app is a single full-width button, so one frame at this height lands
 * close enough that the first paint never hides content.
 */
const ESTIMATED_FOOTER_HEIGHT = 84;

/**
 * Bottom clearance for a sheet whose CTA is pinned via `footerComponent`.
 *
 * The footer floats over the scrollable, so the scrollable has to reserve room
 * for it or its last rows sit under the button — unreachable, with no visual
 * clue that anything is missing. Hardcoding that room is what broke every
 * sheet in the app: the numbers were guesses, and none of them included the
 * safe-area inset that `BottomSheetFooter` is lifted by.
 *
 * Measure instead. Spread `onFooterLayout` onto the view wrapping the button
 * inside `BottomSheetFooter`, and feed `contentPaddingBottom` to the
 * scrollable's `contentContainerStyle` — never its `style`, which pads the
 * viewport rather than reserving scrollable room.
 */
export function useSheetFooterInset(gap: number = Spacing.lg) {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState<number | null>(null);

  const onFooterLayout = useCallback((e: LayoutChangeEvent) => {
    const next = e.nativeEvent.layout.height;
    // Sub-pixel remeasurements would otherwise re-render on every layout pass.
    setHeight((prev) => (prev !== null && Math.abs(prev - next) < 1 ? prev : next));
  }, []);

  return {
    onFooterLayout,
    /** Pass to `BottomSheetFooter`'s `bottomInset` so the footer clears the home indicator. */
    bottomInset: insets.bottom,
    contentPaddingBottom: (height ?? ESTIMATED_FOOTER_HEIGHT) + insets.bottom + gap,
  };
}
