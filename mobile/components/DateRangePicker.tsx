// mobile/components/DateRangePicker.tsx
//
// A collapsed trigger that expands a RangeCalendar and collapses again once
// the range is complete — mirroring the Splitwise group dropdown that sits
// directly below it on the new-vacation screen.
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RangeCalendar, RangeCalendarFooter } from '@/components/RangeCalendar';
import { formatDayLabel, formatDayLabelWithYear } from '@/lib/date';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

interface Props {
  startDate: string | null;
  endDate: string | null;
  /** Emits a complete range, a start-only partial, or (null, null) when cleared. */
  onChange: (startDate: string | null, endDate: string | null) => void;
}

export function DateRangePicker({ startDate, endDate, onChange }: Props) {
  const [open, setOpen] = useState(false);
  // Bumped on open so the calendar returns to the month holding the range
  // instead of wherever it was last browsed to.
  const [resetToken, setResetToken] = useState(0);

  function toggle() {
    if (!open) setResetToken((t) => t + 1);
    setOpen((v) => !v);
  }

  let triggerLabel = 'Any dates';
  if (startDate && endDate) {
    triggerLabel = `${formatDayLabel(startDate)} – ${formatDayLabelWithYear(endDate)}`;
  } else if (startDate) {
    triggerLabel = `${formatDayLabelWithYear(startDate)} – pick an end date`;
  }

  return (
    <View>
      <Pressable
        style={styles.trigger}
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel="Select dates"
        accessibilityState={{ expanded: open }}
      >
        <Text style={startDate ? styles.triggerText : styles.triggerPlaceholder} numberOfLines={1}>
          {triggerLabel}
        </Text>
        <Ionicons name="calendar-outline" size={18} color={Colors.textSecondary} />
      </Pressable>

      {open && (
        <View style={styles.panel}>
          <RangeCalendar
            startDate={startDate}
            endDate={endDate}
            onChange={onChange}
            onRangeComplete={() => setOpen(false)}
            resetToken={resetToken}
          />
          <RangeCalendarFooter
            startDate={startDate}
            endDate={endDate}
            onClear={() => {
              onChange(null, null);
              setOpen(false);
            }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  trigger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: Colors.surface, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: 12,
  },
  // minWidth: 0 lets the label truncate instead of pushing the icon out of the
  // row on web, where flex items default to min-width:auto.
  triggerText: { flex: 1, minWidth: 0, fontSize: 15, color: Colors.textPrimary },
  triggerPlaceholder: { flex: 1, minWidth: 0, fontSize: 15, color: Colors.textTertiary },
  panel: {
    marginTop: Spacing.sm, borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    backgroundColor: Colors.surface, padding: Spacing.sm, ...Shadow.sm,
  },
});
