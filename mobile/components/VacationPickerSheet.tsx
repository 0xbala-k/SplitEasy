// mobile/components/VacationPickerSheet.tsx
import { forwardRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BottomSheetModal, BottomSheetFlatList } from '@gorhom/bottom-sheet';
import { Ionicons } from '@expo/vector-icons';
import { Vacation } from '@/lib/types';
import { Colors, Radius, Spacing } from '@/lib/theme';

interface Props {
  vacations: Vacation[];
  selectedVacationId: string | null;
  onSelect: (vacationId: string | null) => void;
}

// The same wording the vacation list screen uses, so one trip doesn't read as
// two different states depending on where you look at it.
function statusLabel(status: Vacation['status']): string {
  return status === 'active' ? 'Active' : status === 'draft' ? 'Draft' : 'Ended';
}

/**
 * Pick (or clear) the vacation an incoming Splitwise expense belongs to.
 *
 * Ended trips are listed on purpose: a friend adding the trip dinner days
 * after everyone got home is exactly the case automatic attribution misses.
 * Presentational only — the host owns the write and the dismiss.
 */
export const VacationPickerSheet = forwardRef<BottomSheetModal, Props>(
  ({ vacations, selectedVacationId, onSelect }, ref) => {
    return (
      <BottomSheetModal
        ref={ref}
        snapPoints={['55%']}
        enableDynamicSizing={false}
        enablePanDownToClose
        handleIndicatorStyle={styles.indicator}
        backgroundStyle={styles.sheetBg}
      >
        <BottomSheetFlatList
          data={vacations}
          keyExtractor={(v: Vacation) => v.id}
          contentContainerStyle={styles.content}
          ListHeaderComponent={
            <View>
              <Text style={styles.title}>Vacation</Text>
              {/* The bucket chip goes locked the moment a trip is picked, so
                  say why before the user wonders where their choice went. */}
              <Text style={styles.hint}>
                An expense on a trip counts as Travel and shows up in that trip&apos;s recap.
              </Text>
              <Pressable
                style={[styles.row, !selectedVacationId && styles.rowSelected]}
                onPress={() => onSelect(null)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: !selectedVacationId }}
                accessibilityLabel="None"
              >
                <Text style={styles.name} numberOfLines={1}>None</Text>
                {!selectedVacationId && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
              </Pressable>
            </View>
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Ionicons name="airplane-outline" size={32} color={Colors.textTertiary} />
              <Text style={styles.emptyText}>No vacations yet.</Text>
            </View>
          }
          renderItem={({ item }: { item: Vacation }) => {
            const isSelected = selectedVacationId === item.id;
            return (
              <Pressable
                style={[styles.row, isSelected && styles.rowSelected]}
                onPress={() => onSelect(item.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: isSelected }}
                accessibilityLabel={item.name}
              >
                <View style={styles.rowInfo}>
                  <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                  <Text style={styles.status} numberOfLines={1}>{statusLabel(item.status)}</Text>
                </View>
                {isSelected && <Ionicons name="checkmark-circle" size={18} color={Colors.primary} />}
              </Pressable>
            );
          }}
        />
      </BottomSheetModal>
    );
  }
);

const styles = StyleSheet.create({
  indicator: { backgroundColor: Colors.border, width: 36 },
  sheetBg: { backgroundColor: Colors.surface },
  content: { paddingHorizontal: Spacing.xl, paddingBottom: Spacing.xxl },
  title: { fontSize: 17, fontWeight: '700', color: Colors.textPrimary, marginBottom: Spacing.xs },
  hint: { fontSize: 13, color: Colors.textSecondary, marginBottom: Spacing.md, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    marginBottom: Spacing.xs,
    backgroundColor: Colors.surfaceMuted,
  },
  rowSelected: { backgroundColor: Colors.primaryMuted },
  rowInfo: { flex: 1, minWidth: 0 },
  name: { flex: 1, fontSize: 15, color: Colors.textPrimary, fontWeight: '500' },
  status: { fontSize: 12, color: Colors.textSecondary, marginTop: 2 },
  empty: { alignItems: 'center', marginTop: Spacing.xxl, gap: Spacing.sm },
  emptyText: { fontSize: 14, color: Colors.textSecondary },
});
