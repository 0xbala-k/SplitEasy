// mobile/components/EditDatesSheet.tsx
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetFooter,
  type BottomSheetFooterProps,
} from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RangeCalendar, RangeCalendarFooter } from '@/components/RangeCalendar';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

interface Props {
  startDate: string | null;
  endDate: string | null;
  /** Bumped by the parent to reseed the draft from the saved dates on open. */
  openToken?: number;
  onSave: (startDate: string | null, endDate: string | null) => Promise<void>;
}

export const EditDatesSheet = forwardRef<BottomSheetModal, Props>(
  ({ startDate, endDate, openToken, onSave }, ref) => {
    const insets = useSafeAreaInsets();
    // Edits are staged locally so backing out of the sheet leaves the saved
    // dates untouched.
    const [draftStart, setDraftStart] = useState(startDate);
    const [draftEnd, setDraftEnd] = useState(endDate);
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
      setDraftStart(startDate);
      setDraftEnd(endDate);
      // Reseeding is keyed to opening, not to the props themselves — the
      // parent's save triggers a store reload, and tracking the props here
      // would stomp a fresh edit with the values still in flight.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [openToken]);

    // A half-picked range would persist a start with no end, which the
    // reconciler treats as an open-ended vacation the user never asked for.
    const incomplete = !!draftStart && !draftEnd;
    const unchanged = draftStart === startDate && draftEnd === endDate;
    const disabled = incomplete || unchanged || submitting;

    async function save() {
      if (disabled) return;
      setSubmitting(true);
      try {
        await onSave(draftStart, draftEnd);
      } finally {
        setSubmitting(false);
      }
    }

    // The sheet renders the footer as a component type, so a change to
    // `renderFooter`'s identity remounts the footer subtree. Route the press
    // through a ref so the handler can't go stale on the draft dates while the
    // deps stay narrow.
    const saveRef = useRef(save);
    saveRef.current = save;

    const renderFooter = useCallback(
      // The footer background is opaque so calendar rows scrolling underneath
      // don't show through beside the button.
      (footerProps: BottomSheetFooterProps) => (
        <BottomSheetFooter {...footerProps} bottomInset={insets.bottom} style={styles.footer}>
          <Pressable
            style={({ pressed }) => [
              styles.saveBtn,
              disabled && styles.saveBtnDisabled,
              pressed && !disabled && styles.saveBtnPressed,
            ]}
            onPress={() => saveRef.current()}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel="Save dates"
          >
            {submitting ? (
              <ActivityIndicator color={Colors.textInverse} />
            ) : (
              <Text style={[styles.saveText, disabled && styles.saveTextDisabled]}>Save dates</Text>
            )}
          </Pressable>
        </BottomSheetFooter>
      ),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [disabled, submitting, insets.bottom]
    );

    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['80%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
        footerComponent={renderFooter}
      >
        {/* The scrollable is the direct child: BottomSheetView would override
            its flex with position:absolute and push the footer off-screen. */}
        <BottomSheetScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.title}>Edit dates</Text>
          <Text style={styles.subtitle}>
            The vacation starts and ends automatically on these dates.
          </Text>
          <RangeCalendar
            startDate={draftStart}
            endDate={draftEnd}
            onChange={(start, end) => {
              setDraftStart(start);
              setDraftEnd(end);
            }}
            resetToken={openToken ?? 0}
          />
          <RangeCalendarFooter
            startDate={draftStart}
            endDate={draftEnd}
            onClear={() => {
              setDraftStart(null);
              setDraftEnd(null);
            }}
          />
        </BottomSheetScrollView>
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: Spacing.xl, paddingTop: Spacing.sm, paddingBottom: 100 },
  title: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary },
  subtitle: { fontSize: 12, color: Colors.textTertiary, marginTop: Spacing.xs, marginBottom: Spacing.lg },
  footer: { backgroundColor: Colors.surface },
  saveBtn: {
    backgroundColor: Colors.primary, borderRadius: Radius.lg, paddingVertical: 16,
    justifyContent: 'center', alignItems: 'center',
    marginHorizontal: Spacing.xl, marginTop: Spacing.md, marginBottom: Spacing.md, ...Shadow.sm,
  },
  saveBtnDisabled: { backgroundColor: Colors.surfaceMuted },
  saveBtnPressed: { backgroundColor: Colors.primaryDark },
  saveText: { color: Colors.textInverse, fontSize: 16, fontWeight: '700' },
  saveTextDisabled: { color: Colors.textTertiary },
});
