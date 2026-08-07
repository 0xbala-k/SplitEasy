// mobile/components/DateRangePicker.tsx
//
// An inline start→end calendar. Deliberately built from plain RN views rather
// than a native date picker: SplitEasy ships as a PWA as well as iOS/Android,
// and @react-native-community/datetimepicker has no web build. Plain views
// render identically on all three and pick up the app's theme tokens directly.
//
// It mirrors the Splitwise group dropdown on the same screen — a collapsed
// trigger that expands a panel and collapses again once the choice is complete.
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  addMonths,
  formatDayLabel,
  formatDayLabelWithYear,
  formatMonthLabel,
  monthGrid,
  todayLocal,
  yearMonthOf,
  type YearMonth,
} from '@/lib/date';
import { Colors, Radius, Shadow, Spacing } from '@/lib/theme';

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface Props {
  startDate: string | null;
  endDate: string | null;
  /** Emits a complete range, a start-only partial, or (null, null) when cleared. */
  onChange: (startDate: string | null, endDate: string | null) => void;
}

export function DateRangePicker({ startDate, endDate, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState<YearMonth>(() => yearMonthOf(startDate));

  // Reopening should land on the month the range already sits in rather than
  // wherever the user last browsed to.
  useEffect(() => {
    if (open) setVisibleMonth(yearMonthOf(startDate));
    // Only on open — tracking startDate here would yank the view back a month
    // mid-selection, right after the first tap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleDayPress(date: string) {
    // A complete range, or a tap before the pending start, begins a new range.
    // Anything else closes the pending one.
    if (!startDate || endDate || date < startDate) {
      onChange(date, null);
      return;
    }
    onChange(startDate, date);
    setOpen(false);
  }

  function handleClear() {
    onChange(null, null);
    setOpen(false);
  }

  const today = todayLocal();
  const weeks = monthGrid(visibleMonth);

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
        onPress={() => setOpen((v) => !v)}
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
          <View style={styles.monthBar}>
            <Pressable
              onPress={() => setVisibleMonth((m) => addMonths(m, -1))}
              style={styles.monthNav}
              accessibilityRole="button"
              accessibilityLabel="Previous month"
            >
              <Ionicons name="chevron-back" size={18} color={Colors.textPrimary} />
            </Pressable>
            <Text style={styles.monthLabel}>{formatMonthLabel(visibleMonth)}</Text>
            <Pressable
              onPress={() => setVisibleMonth((m) => addMonths(m, 1))}
              style={styles.monthNav}
              accessibilityRole="button"
              accessibilityLabel="Next month"
            >
              <Ionicons name="chevron-forward" size={18} color={Colors.textPrimary} />
            </Pressable>
          </View>

          <View style={styles.weekdayRow}>
            {WEEKDAYS.map((d, i) => (
              // Weekday initials repeat (S/T twice), so the index is the key.
              <Text key={i} style={styles.weekday}>
                {d}
              </Text>
            ))}
          </View>

          {weeks.map((week, wi) => (
            <View key={wi} style={styles.week}>
              {week.map((date, di) => {
                // Leading/trailing padding still has to occupy its column, so
                // it uses the flex cell rather than the day circle.
                if (!date) return <View key={di} style={styles.dayCell} />;

                const isStart = date === startDate;
                const isEnd = date === endDate;
                const inRange =
                  !!startDate && !!endDate && date > startDate && date < endDate;
                const isEdge = isStart || isEnd;

                // The connecting band is a separate layer behind the day
                // circle, spanning the full cell so it meets its neighbours
                // edge to edge across the week. At the two ends it starts at
                // the circle's centre rather than the cell edge — filling the
                // whole end cell would read as half a day more range than was
                // actually picked. A single-day trip gets no band at all.
                const hasRange = !!startDate && !!endDate && startDate !== endDate;
                let bandStyle = null;
                if (inRange) bandStyle = styles.bandFull;
                else if (hasRange && isStart) bandStyle = styles.bandFromCenter;
                else if (hasRange && isEnd) bandStyle = styles.bandToCenter;

                return (
                  <View key={di} style={styles.dayCell}>
                    {bandStyle && <View style={[styles.band, bandStyle]} />}
                    <Pressable
                      style={[styles.day, isEdge && styles.dayEdge]}
                      onPress={() => handleDayPress(date)}
                      accessibilityRole="button"
                      accessibilityLabel={formatDayLabelWithYear(date)}
                      accessibilityState={{ selected: isEdge || inRange }}
                    >
                      <Text
                        style={[
                          styles.dayText,
                          date === today && !isEdge && styles.dayTextToday,
                          isEdge && styles.dayTextEdge,
                        ]}
                      >
                        {Number(date.slice(8, 10))}
                      </Text>
                    </Pressable>
                  </View>
                );
              })}
            </View>
          ))}

          <View style={styles.panelFooter}>
            <Text style={styles.hint} numberOfLines={1}>
              {startDate && !endDate ? 'Now pick the end date' : 'Tap a start and end date'}
            </Text>
            <Pressable
              onPress={handleClear}
              disabled={!startDate && !endDate}
              accessibilityRole="button"
              accessibilityLabel="Clear dates"
            >
              <Text style={[styles.clear, !startDate && !endDate && styles.clearDisabled]}>Clear</Text>
            </Pressable>
          </View>
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
  monthBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  monthNav: { padding: Spacing.sm, borderRadius: Radius.sm },
  monthLabel: { flex: 1, minWidth: 0, textAlign: 'center', fontSize: 15, fontWeight: '700', color: Colors.textPrimary },
  weekdayRow: { flexDirection: 'row', marginBottom: Spacing.xs },
  weekday: { flex: 1, textAlign: 'center', fontSize: 11, fontWeight: '600', color: Colors.textTertiary },
  week: { flexDirection: 'row' },
  // minWidth: 0 lets the seven columns share the row evenly on web instead of
  // each refusing to shrink below its content width.
  dayCell: { flex: 1, minWidth: 0, alignItems: 'center' },
  band: { position: 'absolute', top: 0, bottom: 0, backgroundColor: Colors.primaryMuted },
  bandFull: { left: 0, right: 0 },
  bandFromCenter: { left: '50%', right: 0 },
  bandToCenter: { left: 0, right: '50%' },
  // Sized as a share of the column rather than a fixed 38px, which would
  // overflow seven-across on a 320px-wide screen. aspectRatio keeps the
  // selected-day background a circle at any width.
  day: {
    width: '100%', maxWidth: 40, aspectRatio: 1, borderRadius: Radius.full,
    justifyContent: 'center', alignItems: 'center',
  },
  dayEdge: { backgroundColor: Colors.primary },
  dayText: { fontSize: 14, color: Colors.textPrimary },
  dayTextToday: { color: Colors.primary, fontWeight: '700' },
  dayTextEdge: { color: Colors.textInverse, fontWeight: '700' },
  panelFooter: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: Spacing.sm, paddingHorizontal: Spacing.sm, paddingTop: Spacing.sm,
    borderTopWidth: 1, borderTopColor: Colors.divider,
  },
  hint: { flex: 1, minWidth: 0, fontSize: 12, color: Colors.textTertiary },
  clear: { fontSize: 14, fontWeight: '600', color: Colors.primary, paddingLeft: Spacing.md },
  clearDisabled: { color: Colors.textTertiary },
});
